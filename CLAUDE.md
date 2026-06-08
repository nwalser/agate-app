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
- Keep every SDK call behind the thin wrappers in `auth.rs` / `vault.rs` / `unlock.rs`
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
    types.ts            # DTOs + discriminated unions shared with Rust (mirror src-tauri/src/dto.rs)
  state/
    session.ts          # Auth/lock state store (locked | unlocked | logged-out)
    vault.ts            # Decrypted vault items store + search
    toast.ts            # Toast notification pipeline
  screens/
    Onboarding.tsx      # Server pick + email/master-password/2FA login
    Unlock.tsx          # Unlock with local password (or master password)
    Vault.tsx           # Item list + search + detail pane
    Settings.tsx        # Server, local-unlock config, lock/logout
  components/            # ItemDetail, Totp, CopyField, Toast, ...

src-tauri/
  src/
    lib.rs              # Tauri command registration + managed AppState
    state.rs            # AppState: the SDK Client + session status behind a Mutex
    error.rs            # AgateError → serialized to the frontend (typed, no panics)
    dto.rs              # serde structs sent to the frontend (mirror src/lib/types.ts)
    server.rs           # Server config (cloud regions + self-hosted URL), prelogin/KDF
    auth.rs             # login (email+master password), 2FA, logout
    vault.rs            # sync, list items, item detail, TOTP, password generator
    unlock.rs           # local-password unlock: wrap/unwrap the vault key
    secrets.rs          # OS keychain (keyring) storage of the wrapped key + session
```

## Local-password unlock — security model (the headline feature)
Goal: don't force the master password on every unlock, AND never persist the master
password. Implemented in `secrets.rs` (the crypto envelope) + `unlock.rs` (the flow).

- **First login** uses email + master password; the SDK unlocks the vault in memory.
  The master password is never written to disk.
- **Enabling local unlock** (`unlock::enable`): the user sets a separate local password.
  We derive a key from it with **Argon2id** (random per-user salt) and seal a random
  verifier token with **AES-256-GCM**, storing the blob in the **OS keychain**
  (`keyring`). No plaintext check value is stored — opening the blob *is* the check.
- **Lock** (`auth::lock`): when local unlock is configured, the app *soft-locks* — the
  SDK client is moved to `Session.locked_client` (kept in memory) and the decrypted
  item cache is cleared. Otherwise it hard-clears all key material.
- **Unlock** (`unlock::unlock_local`): the local password must open the keychain blob
  (GCM tag = the check), then the held client is reactivated — no master password.
- **Current SDK limitation:** at the pinned `sdk-internal` rev, `SessionKey` has no
  public serialization, so we cannot seal a *persistable* vault key to the keychain
  yet. The held client therefore lives only in memory and does not survive a process
  restart (after relaunch, unlock once with the master password). `secrets.rs` already
  seals/opens arbitrary bytes, so when the SDK exposes a serializable unlock key,
  `enable`/`unlock_local` seal/restore *that* instead of a verifier and local unlock
  survives restarts. `unlock.rs` is the single integration point for that upgrade.
- **Logout** clears the session and deletes the keychain blob.

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
