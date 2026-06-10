Always use caveman communication mode (ultra-compressed, minimal tokens).

# Agate — unofficial Bitwarden desktop client

## Project Overview
Agate is a cross-platform (Linux / macOS / Windows) desktop client for Bitwarden,
built with **Tauri 2** (Rust backend) and **SolidJS** (frontend). It talks to the
real Bitwarden vault API (the same `identity` + `api` endpoints the official clients
use) via Bitwarden's **official Rust SDK** (`bitwarden/sdk-internal`).

Agate is **not** affiliated with or endorsed by Bitwarden, Inc. "Bitwarden" is a
trademark of Bitwarden, Inc.; this is an independent third-party client.

## Tech Stack
- **Frontend**: SolidJS 1.9, TypeScript (strict), Vite 6
- **Backend**: Rust (Tauri 2)
- **Vault/auth/crypto**: Bitwarden official Rust SDK — `bitwarden-core`,
  `bitwarden-auth`, `bitwarden-vault`, `bitwarden-crypto`, `bitwarden-generators`
  (git dependency on `bitwarden/sdk-internal`, pinned via `Cargo.lock`).
- **Icons**: lucide-solid (use this for all icons, never emojis in code)
- **Styling**: Plain CSS files, one per component, scoped by a root class. Design
  tokens only — never hardcode colors (see `src/styles.css`).

## ⚠️ SDK caveat — read before touching `src-tauri/src/vault.rs` / `auth.rs`
The password-manager side of the Bitwarden SDK is, per Bitwarden, "not intended for
public use and not supported at this stage. The interface is unstable and will
change without warning." We therefore:
- Depend on `sdk-internal` as a **git dependency pinned through `Cargo.lock`**
  (never float `main` in a release).
- Keep every SDK call behind the thin wrappers in `auth.rs` / `vault.rs` / `appunlock.rs`
  so an SDK API break is contained to one layer, not spread across the app.
- Treat the API docs at https://sdk-api-docs.bitwarden.com as the reference, and the
  `bw` crate in `sdk-internal` as the canonical login/sync example.
- Known gap: the SDK's high-level `LoginClient` password flow does **not** implement
  two-factor auth yet. 2FA handling lives in `auth.rs` against the lower-level
  identity flow; if a TOTP/2FA login fails, that wrapper is the place to look.

## File Structure
```
src/
  main.tsx              # Entry point, global crash handlers, mounts App
  App.tsx               # Root: routes between Onboarding / Unlock / Vault by auth state
  styles.css            # Global reset + design tokens (CSS variables)
  lib/
    ipc.ts              # Typed wrappers over Tauri invoke() — the ONLY place invoke is called
    types.ts            # Re-export shim over generated/dto.ts (+ frontend-only helpers)
    generated/dto.ts    # GENERATED from src-tauri/src/dto by `cargo test export_ts_types`
                        # — never hand-edit; change the Rust type and regenerate
  testing/factories.ts  # THE shared test-data factories (unit tests + e2e fixtures)
  state/
    session.ts          # Auth/lock state store (locked | unlocked | logged-out)
    vault.ts            # Decrypted vault items store + search
    toast.ts            # Toast notification pipeline
  screens/
    Onboarding.tsx      # Server pick + email/master-password/2FA login
    Unlock.tsx          # Unlock with local password (or master password)
    Vault.tsx           # Item list + search + detail pane
    Settings.tsx        # Server, local-unlock config, lock/logout
  tray/                 # Tray quick-access popup (window label "tray"):
                        # TrayApp.tsx UI + trayStore.ts (injectable factory)
  components/            # ItemDetail, Totp, CopyField, Toast, ...

src-tauri/
  src/
    lib.rs              # Tauri command registration + managed AppState
    state.rs            # AppState: the SDK Client + session status behind a Mutex
    error.rs            # AgateError → serialized to the frontend (typed, no panics)
    dto/                # serde structs sent to the frontend — the SINGLE SOURCE OF
                        # TRUTH for IPC shapes; dto/typegen.rs exports them to
                        # src/lib/generated/dto.ts (cargo test fails when stale)
    server.rs           # Server config (cloud regions + self-hosted URL), prelogin/KDF
    auth.rs             # master-password login helpers (2FA-capable), shared
    appunlock.rs        # app-unlock: VMK wrap/unwrap, unlock-all, per-connection 2FA
    connections.rs      # add/remove/list connections, app-wide lock + logout
    vault.rs            # sync, unified item list, item detail, TOTP, generator (per-account)
    mutate.rs           # vault writes (create/edit/delete/move/folders), routed by account
    secrets.rs          # KEK/DEK crypto envelope + OS keychain (keyring) storage
    tray.rs             # Tray icon + quick-access popup (toggle + positioning)
```

## Unified app-unlock — security model (the headline feature)
Goal: configure each Bitwarden connection once, then ONE app secret (an app password,
or Windows Hello) unlocks **every** connection at once and the set survives a full app
restart. Items from all unlocked vaults show in one unified list. Implemented in
`secrets.rs` (the crypto envelope) + `appunlock.rs` (unlock flow) + `connections.rs`
(connection management).

⚠️ **Inverted invariant — read this.** The original design promised "never persist the
master password." That is **no longer true**, by deliberate, user-authorized design.
Delivering "survives restart + the vault actually syncs" is only possible at the pinned
SDK rev by re-logging-in on unlock (token injection is `pub(crate)`; there is no public
token restore — see [[agate-sdk-restart-unlock-constraints]]), and `login_password`
needs the cleartext password. So each connection's **master password is persisted,
sealed**. Hardening below keeps that acceptable; do not "fix" the apparent contradiction
by reintroducing the old in-memory-only soft-lock.

- **KEK/DEK envelope** (`secrets.rs`): a random **Vault Master Key (VMK)** is the data
  key; it seals every connection's master password into `cred:<email>` and is stable for
  the install's life. The app password derives an **App Unlock Key (AUK)** with
  **Argon2id**; the AUK only *wraps the VMK* (`app-unlock` keychain entry). Every seal is
  **AES-256-GCM with AAD** binding the blob to its identity (version, service, account,
  KDF params), so a swapped / rolled-back / KDF-downgraded blob fails the tag.
- **Configure** (`appunlock::configure`): generate the VMK, wrap it under a fresh AUK,
  hold the VMK in `Session.vmk` so connections can be added immediately.
- **Add connection** (`connections::add_connection`): SDK login → seal the master password
  under the VMK → only then record the connection (no phantom, unopenable accounts).
- **Unlock all** (`appunlock::unlock_all` / Hello): unwrap the VMK (a wrong app password
  fails the GCM tag), then re-login every connection. Returns a **per-connection outcome**
  — `unlocked | twoFactorRequired | failed` — because re-login uses an SDK-hardcoded
  device id, so **2FA-enforced accounts re-prompt 2FA on every cold start**
  (`unlock_connection_2fa` completes them).
- **Change app password** (`appunlock::change`): re-wrap the VMK under a new AUK — one
  atomic keychain write; the per-connection blobs never move, so it can't half-rekey.
- **Windows Hello**: a consent gate (`UserConsentVerifier`) that releases a copy of the
  VMK from the keychain (Credential Manager / DPAPI-protected under the user) to unlock
  all. *Not* a key-binding (KeyCredentialManager signatures are non-deterministic).
- **Lock** clears all clients + caches + the VMK (zeroized). **Logout** additionally
  deletes every `cred:` blob + the `app-unlock` + Hello blobs and resets the app-unlock
  flags (the connection list is kept for easy re-add).
- **Future hardening:** when the SDK exposes public token persistence, store a
  PIN-protected user key + tokens and stop persisting the master password.

## Engineering Principles — READ BEFORE IMPLEMENTING
Non-negotiables for new/changed code (this is a password manager — correctness and
secrecy are the product):
- **No `.unwrap()`/`.expect()` in non-test Rust**, and no `.lock().unwrap()` — recover
  poisoned locks. A `#[tauri::command]` must never panic.
- **No empty `catch {}` / no `unwrap_or_default()` on I/O or crypto.** Every error is
  handled or surfaced via the toast pipeline, or annotated `// ignore: <reason>`.
  Distinguish "absent" (no local-unlock configured) from "corrupt" (tampered blob).
- **Secrets are zeroized.** Master password, derived keys, and decrypted key material
  use `zeroize`/`Zeroizing`. Never log secret values. Never put secrets in source or
  in plaintext files — keychain only.
- **Validate at every trust boundary.** No raw `JSON.parse` into a store — parse
  through a typed shape; on failure return a typed default + a loud log.
- **No `any` in IPC/storage/crypto/config code.** Closed sets are discriminated unions
  (item type, cipher type, server region, unlock method), not bare strings.
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
- **Stores and screen wiring stay injectable.** New localStorage prefs use
  `state/persisted.ts`; stateful stores follow the `createSecurityScans(deps)`
  factory pattern (tests inject deps, no module mocking); Vault-screen features
  consume `useVault()` via a connected adapter (`src/screens/vault/`) instead of
  threading props through Vault.tsx. Test objects come from
  `src/testing/factories.ts` — never re-declare a DTO shape in a test or fixture.
- **Keychain-touching Rust tests** use
  `secrets::keychain_testing::install_in_memory_keychain()` — unit tests must
  never touch the real OS keychain.

## Build & Dev
```bash
npm install          # JS deps
npm run dev          # Vite + Tauri dev (downloads + builds the SDK on first run — slow)
npm run vite:build   # Frontend-only build (fast sanity check, no Rust)
npm run typecheck    # tsc --noEmit (run after every frontend change)
npm run lint         # eslint
npm run lint:rust    # cargo clippy -- -D warnings
npm run test:unit    # vitest
npm run check        # typecheck + lint + unit (fast gate)
npm run build        # full Tauri production build (bundles per-platform installer)
```

## Definition of Done (self-check before finishing ANY task)
1. `npm run check` is green (typecheck + lint + unit).
2. Touched Rust? `cargo check` (and `npm run lint:rust`) clean.
3. Touched the SDK wrappers, crypto, or the unlock flow? State explicitly in the task
   summary what was verified live vs. what still needs manual verification with a real
   Bitwarden account — never imply a crypto path is verified when it isn't.
4. New behavior is covered by a test; a fixed bug ships with a regression test.
