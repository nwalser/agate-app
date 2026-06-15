# Agate as a system passkey provider — implementation plan

Status: **Phase 0 (storage core) — partially built.** Multi-week, OS-by-OS feature.
This doc is the design of record.

## Implementation status

Built + tested:
- `src-tauri/src/passkey/store.rs` — provider-agnostic shared types:
  `StoredPasskey` (crate-free; PKCS#8-PEM key, base64url ids) and the closed
  `CoseAlgorithm` (ES256 / EdDSA / RS256).
- `providers::LiveConnection` passkey dispatch — `find_passkeys_for_rp`,
  `get_passkey`, `create_passkey`, `update_passkey_sign_count`, `delete_passkey`
  (read-only providers return empty/`BadRequest`, mirroring `mutate::route_for`).
- KeePass persistence — `KPEX_PASSKEY_*` attributes (KeePassXC-compatible:
  credential id / user handle base64url, private key PKCS#8 PEM **protected**,
  `Passkey` tag), via the existing atomic save. Read side wired: `has_passkey`
  flips and `item_detail.passkeys` carries metadata; the private key is excluded
  from custom-field surfaces (security).
- `src-tauri/src/passkey/codec.rs` — the ES256 **CoseKey ↔ PKCS#8 PEM** bridge
  (`passkey::Passkey` ↔ `StoredPasskey`), re-implementing the crate's private
  helpers; round-trip is proven by a sign-then-verify test.
- `src-tauri/src/passkey/authenticator.rs` — `ConnectionStore` implementing the
  `passkey-authenticator` `CredentialStore` over `&mut LiveConnection`
  (provider-blind), plus `make_credential` / `get_assertion` ceremony entry
  points generic over `UserValidationMethod`. Incl. a full
  register→store-in-KeePass→sign-in integration test.
- **Destination-targeted creation** — `PasskeyTarget { item_id, folder_id }`
  threads through the ceremony so the user chooses where a new passkey lands.
  KeePass: attach to an existing login (preserving it) OR create a new item in a
  folder — both tested. `create_passkey` is now async (Bitwarden writes via API).
- **Bitwarden creation (implemented, ⚠️ unverified live)** —
  `BitwardenConnection::create_passkey` builds a `Fido2CredentialFullView`
  (`keyValue` = base64url(PKCS#8 DER), the SDK-confirmed format) and writes via
  `set_new_fido2_credentials` + the same encrypt→POST/PUT flow as `save_item`.
  Compiles + the key conversion is unit-tested, but the server round-trip, the
  base64url variant, and cross-client credential-id interop need a **real
  Bitwarden account** to confirm.
- **140 Rust tests pass, clippy `-D warnings` clean.**

Not built yet (clearly staged):
- **Bitwarden assertion read** — `find_passkeys_for_rp` / `get_passkey` still
  return empty for Bitwarden, so Agate can store a Bitwarden passkey but can't yet
  assert one from it (the create side is the user's ask; the read/sign side is the
  follow-up).
- **User-facing commands** (popup chooser: which vault / item / folder; list /
  delete) — the backend capability exists; the popup wiring is the next piece.
- **OS integration (Layer C)** — §5; the `make_credential` / `get_assertion`
  entry points exist and are tested, but nothing calls them yet (the native shim
  isn't buildable/verifiable here), so they sit under documented
  `#[allow(dead_code)]`. A real biometric `UserValidationMethod` (Windows Hello /
  Touch ID, via `hello.rs`) is supplied by that shim.

Interop caveats to verify live (not yet done): the exact base64 variant KeePassXC
uses for ids (assumed URL-safe no-pad), and reading a *non-Agate* passkey whose
algorithm we currently default to ES256 (no PEM parsing in the storage layer yet).

## 0. Goal

Let Agate act as a **third-party passkey provider** so a browser's
`navigator.credentials.create()` / `.get()` routes to Agate — **without a browser
extension where the OS allows it** — and the passkey lives in whichever vault the user
chose (Bitwarden, KeePass, …). Adding a future provider must require **zero change to the
passkey code**: passkey logic is provider-agnostic, persistence is provider-side.

## 1. Feasibility — "without a browser extension?"

Yes on the OSes that ship a system passkey-provider API; the browser calls the OS
WebAuthn layer, which routes to a registered provider. **No extension.** Per-OS:

| OS | System provider API | No-extension? | Notes |
|----|--------------------|---------------|-------|
| **Windows 11 24H2 / 25H2** | WebAuthn **Plugin Authenticator** (`IPluginAuthenticator` COM + `WebAuthNPlugin*` exports) | **Yes** | GA Nov 2025 (KB5068861). TPM required. App must be **MSIX**-registered COM server. SDK 10.0.26100.7175+. Dev box 26200 (25H2) ✓ |
| **macOS 14+** | AutoFill **Credential Provider** app extension (`ASCredentialProviderExtension`, passkey-capable) | **Yes** | Separate signed **appex** target, entitlement on appex + container, embedded in `.app`. Tauri doesn't build appex. |
| **Linux** | **none** | **No (today)** | Browsers do hardware-key + phone-hybrid only. Software provider ⇒ browser extension, or hacky virtual-CTAP-HID. See §5.3. |
| (Android 14+ / iOS 17+) | Credential Manager / Credential Provider Extension | Yes | Out of scope — Agate has no mobile app yet. |

**Honest headline:** "no browser extension" is achievable on **Windows and macOS**. On
**Linux it is not** with current OS/browsers — that platform needs a separate decision
(defer, ship an extension there only, or spike virtual-CTAP). The user asked for Linux
too; §5.3 lays out the real options.

## 2. Architecture — three layers + one hard problem

```
        ┌─────────────────────── per-OS system integration (Layer C) ───────────────────────┐
browser │  Win: Plugin Authenticator COM server (MSIX)                                       │
  │     │  mac: AutoFill Credential Provider appex                                            │
  ▼     │  linux: (extension | virtual-CTAP | deferred)                                       │
OS WebAuthn ──IPC──▶  Agate tray process (holds the ONE unlocked session)                     │
        └────────────────────────────────────────────┬───────────────────────────────────────┘
                                                       ▼
                              passkey-authenticator (Layer A, provider-agnostic core)
                                 WebAuthn L3 + CTAP2 + COSE + CBOR + crypto
                                                       │  trait CredentialStore
                                                       ▼
                              provider persistence (Layer B, per-provider)
                                 Bitwarden ▸ Fido2Credential cipher (SDK)
                                 KeePass   ▸ KPEX_PASSKEY_* fields (KeePassXC interop)
                                 <new>     ▸ implement the same mapping → done
```

### Layer A — provider-agnostic passkey core: `passkey-rs` (1Password)

Use the `passkey-authenticator` crate (part of `1Password/passkey-rs`, Apache-2.0).
It implements the **CTAP2 software authenticator** (make-credential, get-assertion, COSE
key gen for ES256/EdDSA/RS256, CBOR, signature) and delegates **all** persistence to a
**`CredentialStore` trait** we implement. This crate IS the "passkey side that never
changes per provider." Pairs with `passkey-types`, and `passkey-transports` (CTAP-HID —
relevant only for the Linux virtual-authenticator option, §5.3).

License check before adoption: `passkey-rs` is Apache-2.0; Agate is GPLv3 — GPLv3 can
consume Apache-2.0, so OK. (Record in the SDK/licensing notes.)

### Layer B — provider persistence (the abstraction the user wants)

Define **one** Agate trait, provider-implemented, that `CredentialStore` is built on top
of. Storage is the only thing a provider must supply:

```rust
// new: src-tauri/src/passkey/store.rs  (provider-agnostic shape; impls live per provider)
pub struct StoredPasskey {
    pub credential_id: Vec<u8>,        // base64url at rest
    pub rp_id: String,
    pub rp_name: Option<String>,
    pub user_handle: Vec<u8>,
    pub user_name: Option<String>,
    pub user_display_name: Option<String>,
    pub algorithm: CoseAlg,            // ES256 | EdDSA | RS256
    pub private_key: Zeroizing<Vec<u8>>, // PKCS#8; NEVER leaves the process, NEVER logged
    pub sign_count: u32,
    pub created: String,
}

pub trait PasskeyVault {
    fn create_passkey(&mut self, p: StoredPasskey) -> AgateResult<()>;
    fn passkeys_for_rp(&self, rp_id: &str) -> AgateResult<Vec<StoredPasskey>>;
    fn passkey_by_id(&self, credential_id: &[u8]) -> AgateResult<Option<StoredPasskey>>;
    fn bump_sign_count(&mut self, credential_id: &[u8], n: u32) -> AgateResult<()>;
    fn delete_passkey(&mut self, credential_id: &[u8]) -> AgateResult<()>;
}
```

Then **dispatch through the existing enum** — every provider gets arms (read-only
providers return `BadRequest` on create, exactly like `mutate::route_for` does today):

- `providers/mod.rs` `LiveConnection`: add the `PasskeyVault` methods to the enum's
  match-dispatch (same pattern as `list_items` / `item_detail`).
- `providers/keepass.rs`: persist as **`KPEX_PASSKEY_*` entry fields** — KeePassXC's
  convention (credential id, PKCS#8 PEM, rp id, user handle, username). Free interop with
  KeePassXC and the existing `KeePassPasskey` project. Writes go through the **existing
  atomic save** (`save_item` → temp → reopen-verify → `.bak` → rename) and
  `mutate::keepass_write` (block_in_place). No new write machinery.
- `providers/bitwarden.rs`: persist as a **`Fido2Credential` on a login cipher** via the
  SDK (the read path already exists — `view.decrypt_fido2_credentials`, the
  `PasskeyCredential` DTO, and `VaultItem.has_passkey`). Create/update may need an SDK
  Fido2 surface that isn't public yet — **flag as unverified, contain in the wrapper**
  (per the SDK caveat in CLAUDE.md).
- `Pass` / `Enpass` / `Proton`: read-only → `create_passkey` returns `BadRequest`;
  `passkeys_for_rp` may still surface any creds they store (likely none) — they don't
  need touching beyond a trivial arm.

The `CredentialStore` impl (Layer A glue) is **one** generic adapter over
`&mut LiveConnection` — it does not know which provider it wraps. **New provider ⇒
implement the enum arms only. Passkey core + adapter unchanged.** This is the invariant
the user asked for.

### The hard problem — process/session model (decide first)

The OS activates Layer C in a **separate process** (Windows COM server; macOS appex).
That process does **not** share the tray app's unlocked session (the VMK + live
`LiveConnection` map live in `Session`, in the tray process). Two models:

- **M1 (recommended) — thin shim, single session.** Layer C is a thin OS shim that
  marshals each ceremony over a **local IPC** (Windows named pipe; macOS XPC / Mach
  service, or app-group + XPC) to the **running tray process**, which owns the unlocked
  session, runs `passkey-authenticator`, does the `PasskeyVault` op, and reuses
  `hello.rs` for user verification. Mirrors how `KeePassPasskey` talks to its KeePass
  plugin over a named pipe. One unlock, one source of truth — fits Agate's "configure
  once, one app secret unlocks everything." If the tray is locked/not running, the shim
  triggers unlock (or fails the ceremony cleanly).
- **M2 (rejected) — responder unlocks independently** (own VMK access via keychain +
  Hello). Duplicates the session → two sources of truth → violates "one path, properly
  implemented." Do not do this.

**Pick M1.** Everything below assumes it.

## 3. Backend wiring (provider-agnostic, all OSes share it)

- New module `src-tauri/src/passkey/` : `store.rs` (`PasskeyVault`, `StoredPasskey`),
  `authenticator.rs` (the `CredentialStore` adapter over `LiveConnection` +
  ceremony entry points `make_credential` / `get_assertion`), `ipc.rs` (the local
  request/response types Layer C sends in).
- DTOs: extend `dto/vault.rs` — `PasskeyCredential` already exists for read. Add only
  what the popup UI needs (list/delete passkeys per item). Regenerate with
  `cargo test --manifest-path src-tauri/Cargo.toml export_ts_types`, commit the diff.
  **Never hand-edit `dto.ts`.**
- Writes route through the **existing** `mutate` layer (`route_for` gate +
  `keepass_write`); no parallel write path.
- User verification: reuse `hello::available` / the consent gate
  (`UserConsentVerifier::RequestVerificationForWindowAsync`) and `hello_unix.rs`
  (`robius-authentication`). UV during a ceremony = the same gate the app already uses.
- Persistence-at-rest: **already solved** — passkeys live inside the vault, which the
  provider encrypts (KDBX / Bitwarden). The VMK envelope (`secrets.rs`) is unchanged; we
  store no new keychain blob for passkeys.
- Commands: add thin `#[tauri::command]` wrappers in `commands/` (list/delete passkeys
  for the popup), register in `lib.rs generate_handler!`. The ceremony itself is driven by
  Layer C over IPC, not by a user-facing command.

## 4. Security invariants (this is a password manager)

- Private keys are `Zeroizing`, **never logged**, **never sent to the frontend**, and
  **never leave the tray process** — signing happens where the key is (Layer A in-process).
- No `.unwrap()`/`.expect()` in non-test Rust; a command/ceremony must never panic.
- `sign_count` monotonic per credential; persisted via `bump_sign_count` (atomic save on
  KeePass).
- The IPC shim authenticates its peer (KeePassPasskey checks the package family name;
  Agate should verify the caller is the trusted OS WebAuthn host / signed shim).
- Atomic KeePass save invariant holds for passkey writes (temp → reopen-verify → `.bak` →
  rename; refuse if the file changed on disk).
- Design tokens for any new UI; i18n keys in en/de/es with parity.

## 5. Per-OS integration (Layer C)

### 5.1 Windows (do first — dev box supports it, prior art, Hello already wired)

- Register an **MSIX-packaged COM server** implementing `IPluginAuthenticator`;
  `WebAuthNPluginAddAuthenticator` to add it; maintain the system credential cache via
  `WebAuthNPluginAuthenticatorAddCredentials` / `RemoveCredentials` (this powers the
  browser autofill dropdown); UV via `WebAuthNPluginPerformUserVerification` (or reuse
  `hello.rs`). Enable under Settings → Accounts → Passkeys → Advanced Options.
- **Packaging blocker:** Tauri ships NSIS/MSI, not MSIX, and the COM server must be
  MSIX-registered. Plan: ship a **separate small signed helper exe** (the COM server /
  shim) — like KeePassPasskey's `.NET 10` COM server ↔ named pipe ↔ KeePass plugin — so
  the Tauri bundle isn't forced to MSIX. The helper talks M1 named-pipe to the tray app.
- **windows-rs risk:** the **new** `WebAuthNPlugin*` / `IPluginAuthenticator` surface
  (SDK 26100.7175, Nov 2025) is likely **not yet in the `windows` crate metadata**.
  Expect to hand-roll FFI to `webauthn.dll` exports + a hand-written COM vtable, or build
  the COM server in C++/WinRT or C# (as MS's sample and KeePassPasskey do) and keep only
  the pipe protocol in Rust. **Verify crate coverage before committing to pure-Rust.**
- Reuse: `hello.rs` for UV + `WDA_EXCLUDEFROMCAPTURE`.

### 5.2 macOS (second)

- **AutoFill Credential Provider app extension** (`ASCredentialProviderExtension`,
  passkey methods: `prepareInterfaceToProvideCredential`,
  `provideCredentialWithoutUserInteraction`, the passkey assertion/registration
  callbacks). Entitlement `com.apple.developer.authentication-services.autofill-credential-provider`
  on **both** the appex and the container app; correct `Info.plist` placement
  (`NSExtension > NSExtensionAttribute`).
- **Tauri bundling friction:** Tauri produces a `.app` but not the appex. Need a custom
  **Xcode extension target** + post-build step to embed `Agate.appcredentials.appex` into
  `Agate.app/Contents/PlugIns/`, plus shared signing/provisioning. The appex talks M1 to
  the tray app via **XPC / Mach service** (or app-group + file-backed request) — the appex
  is sandboxed and short-lived, so keep it thin.
- Note: `tauri-plugin-macos-passkey` is **consumer-side** (app logging in *with* a
  passkey) — not reusable for the provider role.

### 5.3 Linux (decision required — no clean no-extension path)

No system credential-provider API exists; browsers route only to hardware keys + phone
hybrid. Options, honest tradeoffs:

- **(a) Defer Linux passkey-provider** (recommended first). Backend Layers A/B are
  cross-platform and ship regardless; Linux just lacks Layer C until the ecosystem adds
  one. Users on Linux still see/manage stored passkeys, just can't auto-serve them to a
  browser without a key/phone.
- **(b) Browser extension on Linux only.** Contradicts the "no extension" goal but is the
  only *reliable* software path today. Could be a thin MV3 extension that proxies WebAuthn
  to the tray over native messaging.
- **(c) Virtual CTAP2 authenticator** via `passkey-transports` (CTAP-HID) + a Linux
  `uhid` virtual USB-HID device, so the browser talks CTAP to Agate as if it were a
  security key. **No extension, but fragile** (HID emulation, permissions, UV UX, browser
  trust). A research spike, not a commitment.

Recommend (a) now, revisit (b)/(c) after Windows+macOS land.

## 6. Risks / must-verify-live

- SDK Fido2 **write** surface for Bitwarden may not be public at the pinned rev → the
  Bitwarden `PasskeyVault::create_passkey` arm may be blocked upstream. Verify early; if
  blocked, ship KeePass-first and gate Bitwarden create behind a clear "unsupported yet."
- `windows` crate coverage of the plugin authenticator API (§5.1) — verify before
  choosing pure-Rust vs. C++/C# helper.
- macOS appex embedding + entitlement approval is historically finicky — spike the
  empty-appex-loads path before building ceremony logic.
- KeePassXC `KPEX_PASSKEY_*` exact field schema — confirm against a real KeePassXC-created
  `.kdbx` so interop actually round-trips (must verify live, not assumed).

## 7. Phased delivery (TDD throughout — test-first per CLAUDE.md)

- **Phase 0 — provider-agnostic core (headless, fully testable, no OS integration).**
  Add `passkey/` module, `PasskeyVault` trait + enum dispatch, KeePass `KPEX_PASSKEY_*`
  read/write, `CredentialStore` adapter, ceremony entry points. Tests: `passkey-authenticator`
  driven against a fake `PasskeyVault`; KeePass round-trip on a real temp `.kdbx` +
  KeePassXC interop assertion; provider-dispatch tests via factories. **This is the bulk
  of the provider-abstraction value and ships independent of any OS hook.**
- **Phase 1 — Windows.** Helper COM server (MSIX) + named-pipe M1 to the tray + register
  + UV via Hello. Live-verify against webauthn.io / a real site in Edge.
- **Phase 2 — macOS.** Appex + XPC M1 + signing/embedding. Live-verify in Safari/Chrome.
- **Phase 3 — Linux decision** per §5.3.

Phase 0 is the right place to start and is safe (no packaging, no native COM, fully
unit/integration testable).

## 8. Open decisions for the user

1. Confirm **M1 (single-session shim)** as the process model. (Recommended.)
2. Windows COM server language: **Rust-FFI** (risky, one codebase) vs **C#/.NET helper**
   (proven by KeePassPasskey, MSIX-friendly, but a second language in the tree).
3. Linux: defer (a) / extension (b) / virtual-CTAP spike (c)?
4. Bitwarden passkey **create** — ship KeePass-first and treat Bitwarden create as
   unverified/blocked until the SDK surface is confirmed?
5. Start with **Phase 0** now?
