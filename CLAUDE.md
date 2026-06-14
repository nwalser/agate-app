Always use caveman communication mode (ultra-compressed, minimal tokens).

# Agate — tray-first password manager (Bitwarden + KeePass)

## Project Overview
Agate is a cross-platform (Linux / macOS / Windows) **system-tray password
manager**: the tray quick-access popup IS the entire app — there is no main
window. Core value: **autofill into other apps, simplicity, interaction
design**. It speaks two vault providers:
- **Bitwarden** (incl. Vaultwarden/self-hosted) via Bitwarden's **official Rust
  SDK** (`bitwarden/sdk-internal`) against the real `identity` + `api` endpoints.
- **KeePass** `.kdbx` files (KDBX4 read/WRITE) via the `keepass` crate, with an
  Agate-owned atomic-save flow.

Agate is **not** affiliated with or endorsed by Bitwarden, Inc. "Bitwarden" is a
trademark of Bitwarden, Inc.; this is an independent third-party client.

## Tech Stack
- **Frontend**: SolidJS 1.9, TypeScript (strict), Vite 6 — one webview, the
  tray popup (380px wide, window label `tray`).
- **Backend**: Rust (Tauri 2)
- **Bitwarden vault/auth/crypto**: official Rust SDK (git dependency on
  `bitwarden/sdk-internal`, pinned via `Cargo.lock`).
- **KeePass**: `keepass` crate (`save_kdbx4` feature; write support is
  experimental upstream — see the atomic-save notes in `providers/keepass.rs`).
- **Icons**: lucide-solid (use this for all icons, never emojis in code)
- **Styling**: Plain CSS files, one per component, scoped by a root class. Design
  tokens only — never hardcode colors (see `src/styles.css`).

## ⚠️ SDK caveat — read before touching `providers/bitwarden.rs` / `auth.rs`
The password-manager side of the Bitwarden SDK is, per Bitwarden, "not intended for
public use and not supported at this stage. The interface is unstable and will
change without warning." We therefore:
- Depend on `sdk-internal` as a **git dependency pinned through `Cargo.lock`**
  (never float `main` in a release).
- Keep every SDK call behind the provider/wrapper layer (`auth.rs`,
  `providers/bitwarden.rs`, `vault/`, `mutate/`, `appunlock.rs`) so an SDK API
  break is contained to one layer, not spread across the app.
- Treat the API docs at https://sdk-api-docs.bitwarden.com as the reference.
- Known gap: the SDK's high-level `LoginClient` password flow does **not**
  implement two-factor auth yet. 2FA handling lives in `auth.rs` against the
  lower-level identity flow; if a TOTP/2FA login fails, that wrapper is the
  place to look.

## File Structure
```
src/
  main.tsx              # Entry point: crash handlers, theme, locale, update check,
                        # mounts TrayApp (the popup IS the app)
  styles.css            # Global reset + design tokens (CSS variables)
  lib/
    ipc.ts              # Typed wrappers over Tauri invoke() — the ONLY place invoke is called
    types.ts            # Re-export shim over generated/dto.ts (+ frontend-only helpers)
    generated/dto.ts    # GENERATED from src-tauri/src/dto by `cargo test export_ts_types`
                        # — never hand-edit; change the Rust type and regenerate
    i18n.ts             # themia-style locales; see src/locales/{en,de,es}.ts
    clipboard.ts        # copyWithAutoClear — THE secret-copy path (wipe countdown)
  testing/factories.ts  # THE shared test-data factories
  state/                # Injectable stores (persisted.ts for localStorage prefs,
                        # theme, clipboard, autolock, update, toast, ...)
  tray/
    TrayApp.tsx         # Popup shell: locked/onboarding/list/fill + view router
                        # (footer nav: generator / vaults / settings / lock)
    trayStore.ts        # Injectable store factory (session cache, copy actions,
                        # add/edit-login form, autofill fill mode)
    TrayApp.integration.test.tsx  # Real TrayApp over a mockIPC fake backend
                        # (`npm run test:tray`) — THE integration test layer
    views/
      TrayOnboarding.tsx  # First run: set the app password
      TrayVaults.tsx      # Connections: add (Bitwarden or .kdbx) / unlock / 2FA /
                          # edit / remove
      TrayDetail.tsx      # Full item detail + RepromptGate (app-password gate)
      TrayGenerator.tsx   # Password / passphrase / username generator
      TraySettings.tsx    # All settings: appearance, security (autolock+clipboard),
                          # unlock (app pw + Hello), autostart, autofill, updates, logout
  components/           # Shared pieces the popup uses: CopyButton, Favicon, Toast,
                        # TotpRing, NotesView, RepromptGate, SecuritySettings,
                        # settings/SettingsControls (THE shared toggle/select set)

src-tauri/
  src/
    lib.rs              # Tauri command registration + plugins + tray window events
    setup.rs            # AppState load, autofill watcher arm, tray icon setup
    tray.rs             # Tray icon + popup placement/toggle/pin (the only window)
    state.rs            # AppState, PersistedConfig (accounts w/ ConnectionKind),
                        # Session (VMK + LiveConnection map)
    error.rs            # AgateError → serialized to the frontend (typed, no panics)
    dto/                # serde structs sent to the frontend — SINGLE SOURCE OF TRUTH
                        # for IPC shapes; dto/typegen.rs exports them to
                        # src/lib/generated/dto.ts (cargo test fails when stale)
    providers/          # THE provider abstraction: enum LiveConnection, one
      mod.rs            # variant per provider; adding a provider = new variant,
      bitwarden.rs      # the compiler points at every match needing an arm.
      keepass.rs        # KDBX4 r/w: atomic save (same-dir temp → reopen-verify →
                        # .bak → rename), recycle-bin mapping, favorite=tag
    vault/              # Provider-AGNOSTIC read routers (sync/list/detail/totp/
                        # folders) + generators + CipherView→DTO transform
    mutate/             # Provider-routed writes (items + folders); KeePass writes
                        # go through mutate::keepass_write (block_in_place)
    auth.rs             # Bitwarden master-password login (2FA-capable)
    appunlock.rs        # App-unlock: VMK wrap/unwrap, unlock-all (per-kind arms)
    connections.rs      # add/remove/unlock connections (both kinds), lock/logout
    secrets.rs          # KEK/DEK crypto envelope + OS keychain storage
    server.rs           # Bitwarden server config (cloud regions + self-hosted)
    proxy/              # Loopback prelogin fix for Vaultwarden/self-hosted — KEEP
    autofill/           # Windows UIA watcher + matcher + injector
    strength.rs         # zxcvbn strength + password-reuse count (add-form meter)
    hello.rs            # Windows Hello consent gate + screen-capture protection
```

## Providers — how a vault source plugs in
`providers::LiveConnection` is the unit of polymorphism (enum, NOT trait
objects): every unlocked connection is one variant; reads dispatch via its
methods, writes route in `mutate::route_for`. The connection id (`email` in
config, for back-compat) is the account email for Bitwarden and the absolute
`.kdbx` path for KeePass. Per-connection secrets are sealed under the VMK as a
`StoredConnection` (kind + password + optional kdbx path/keyfile; old blobs
deserialize as Bitwarden via serde defaults). KeePass facts: favorite = the
`Favorite` tag (KeePassXC convention), trash = the recycle-bin group, folders =
groups ("/"-joined paths), TOTP = the `otp` field, only login + secure-note
types are writable, cloning unsupported. Every kdbx save is atomic with a
`.bak` and refuses to clobber a file changed on disk ("sync first").

## Unified app-unlock — security model (the headline feature)
Goal: configure each connection once, then ONE app secret (an app password, or
Windows Hello) unlocks **every** connection at once and the set survives a full
app restart. Items from all unlocked vaults show in one unified list.
Implemented in `secrets.rs` (the crypto envelope) + `appunlock.rs` (unlock flow)
+ `connections.rs` (connection management).

⚠️ **Inverted invariant — read this.** The original design promised "never persist the
master password." That is **no longer true**, by deliberate, user-authorized design.
Delivering "survives restart + the vault actually syncs" is only possible at the pinned
SDK rev by re-logging-in on unlock (token injection is `pub(crate)`; there is no public
token restore), and `login_password` needs the cleartext password. So each Bitwarden
connection's **master password is persisted, sealed** (and each KeePass connection's
database password likewise, when "remember" is on). Hardening below keeps that
acceptable; do not "fix" the apparent contradiction by reintroducing the old
in-memory-only soft-lock.

- **KEK/DEK envelope** (`secrets.rs`): a random **Vault Master Key (VMK)** is the data
  key; it seals every connection's secret into `cred:<id>` and is stable for
  the install's life. The app password derives an **App Unlock Key (AUK)** with
  **Argon2id**; the AUK only *wraps the VMK* (`app-unlock` keychain entry). Every seal is
  **AES-256-GCM with AAD** binding the blob to its identity (version, service, account,
  KDF params), so a swapped / rolled-back / KDF-downgraded blob fails the tag.
- **Configure** (`appunlock::configure`): generate the VMK, wrap it under a fresh AUK,
  hold the VMK in `Session.vmk` so connections can be added immediately.
- **Add connection** (`connections::add_connection` / `add_keepass_connection`):
  verify the secret (SDK login / kdbx open) → seal it under the VMK → only then
  record the connection (no phantom, unopenable accounts).
- **Unlock all** (`appunlock::unlock_all` / Hello): unwrap the VMK (a wrong app password
  fails the GCM tag), then per connection: Bitwarden re-logs-in, KeePass re-opens the
  file. Returns a **per-connection outcome** — `unlocked | twoFactorRequired | failed`
  — because Bitwarden re-login uses an SDK-hardcoded device id, so **2FA-enforced
  accounts re-prompt 2FA on every cold start** (`unlock_connection_2fa` completes them
  in the popup's Vaults view).
- **Change app password** (`appunlock::change`): re-wrap the VMK under a new AUK — one
  atomic keychain write; the per-connection blobs never move, so it can't half-rekey.
- **Windows Hello**: a consent gate (`UserConsentVerifier`) that releases a copy of the
  VMK from the keychain (Credential Manager / DPAPI-protected under the user) to unlock
  all. *Not* a key-binding (KeyCredentialManager signatures are non-deterministic).
- **Lock** clears all clients + caches + the VMK (zeroized). **Logout** additionally
  deletes every `cred:` blob + the `app-unlock` + Hello blobs and resets the app-unlock
  flags (the connection list is kept for easy re-add).
- **Reprompt** ("require master password to view") is gated IN the popup by
  `RepromptGate` (verify_app_password — the app password, never the master pw).
- **Future hardening:** when the SDK exposes public token persistence, store a
  PIN-protected user key + tokens and stop persisting the master password.

## Engineering Principles — READ BEFORE IMPLEMENTING
Non-negotiables for new/changed code (this is a password manager — correctness and
secrecy are the product):
- **No `.unwrap()`/`.expect()` in non-test Rust**, and no `.lock().unwrap()` — recover
  poisoned locks. A `#[tauri::command]` must never panic.
- **No empty `catch {}` / no `unwrap_or_default()` on I/O or crypto.** Every error is
  handled or surfaced via the toast pipeline, or annotated `// ignore: <reason>`.
  Distinguish "absent" (no app-unlock configured) from "corrupt" (tampered blob).
- **Secrets are zeroized.** Passwords, derived keys, and decrypted key material
  use `zeroize`/`Zeroizing`. Never log secret values. Never put secrets in source or
  in plaintext files — keychain only.
- **KeePass writes must never destroy data**: every save goes temp-file →
  reopen-verify → `.bak` → atomic rename; edits mutate the existing entry in
  place (unknown fields/attachments/history preserved); a file changed on disk
  refuses the write.
- **Validate at every trust boundary.** No raw `JSON.parse` into a store — parse
  through a typed shape; on failure return a typed default + a loud log.
- **No `any` in IPC/storage/crypto/config code.** Closed sets are discriminated unions
  (item type, connection kind, server region, unlock method), not bare strings.
- **Security defaults stay secure:** never `danger_accept_invalid_certs`, never weaken
  TLS, never add a debug backdoor that ships in a release build.
- **Design tokens, not literals:** use `var(--primary)` etc.; never hardcode the accent.
- **One path, properly implemented — never two.** Replace old paths cleanly; don't gate
  a structural change behind a flag that keeps the old impl alive.
- **IPC types are generated, never mirrored.** Change the Rust DTO, run
  `cargo test --manifest-path src-tauri/Cargo.toml export_ts_types` (it fails when
  `src/lib/generated/dto.ts` is stale), commit the diff. Never hand-edit the
  generated file or re-declare an IPC shape in TS.
- **Config writes go through `AppState::update_config`** (mutate + persist +
  rollback as one transaction). Order: rollback-able config write FIRST, then
  irreversible keychain side effects (best-effort, loud) — see `connections.rs`.
- **Stores stay injectable.** New localStorage prefs use `state/persisted.ts`;
  stateful stores follow the `createTrayStore(deps)` factory pattern (tests
  inject deps, no module mocking). Settings UI reuses the shared
  Switch/ToggleRow/Select set in `components/settings/SettingsControls.tsx` —
  never roll a new toggle/picker. Test objects come from
  `src/testing/factories.ts` — never re-declare a DTO shape in a test.
- **Keychain-touching Rust tests** use
  `secrets::keychain_testing::install_in_memory_keychain()` — unit tests must
  never touch the real OS keychain. KeePass tests build their own kdbx files in
  temp dirs.
- **i18n:** locale keys live in src/locales/{en,de,es}.ts with identical key
  sets (parity test). Every new UI string ships in all three.

## Build & Dev
```bash
npm install          # JS deps
npm run dev          # Vite + Tauri dev (downloads + builds the SDK on first run — slow)
npm run vite:build   # Frontend-only build (fast sanity check, no Rust)
npm run typecheck    # tsc --noEmit (run after every frontend change)
npm run lint         # eslint
npm run lint:rust    # cargo clippy --all-targets -- -D warnings
npm run test:unit    # vitest (includes the tray integration tests)
npm run test:tray    # just the TrayApp integration suite
npm run check        # typecheck + lint + unit (fast gate)
npm run build        # full Tauri production build (bundles per-platform installer)
```

## Definition of Done (self-check before finishing ANY task)
1. `npm run check` is green (typecheck + lint + unit).
2. Touched Rust? `cargo test` and `npm run lint:rust` clean (the typegen test
   regenerates dto.ts — commit the diff).
3. Touched the SDK wrappers, the KeePass provider, crypto, or the unlock flow?
   State explicitly in the task summary what was verified live vs. what still
   needs manual verification with a real Bitwarden account / a real
   KeePassXC-created .kdbx — never imply a crypto or file-write path is
   verified when it isn't.
4. New behavior is covered by a test; a fixed bug ships with a regression test.
