# Agate

An unofficial, open-source, cross-platform desktop client for **Bitwarden**, built
with [Tauri 2](https://v2.tauri.app/) (Rust) and [SolidJS](https://www.solidjs.com/).
Runs on **Linux, macOS, and Windows**.

> **Not affiliated with Bitwarden, Inc.** "Bitwarden" is a trademark of Bitwarden, Inc.
> Agate is an independent third-party client that connects to the Bitwarden API using
> Bitwarden's official Rust SDK. Use it at your own risk.

## Why Agate

- **Local-password unlock.** Lock the app and re-open it with a separate, lighter
  local password (or PIN) instead of retyping your master password. Your master
  password is **never written to disk**. The local password is verified against an
  Argon2id + AES-256-GCM blob sealed in the OS keychain (no plaintext check value is
  stored). _Current SDK limitation:_ the held vault key lives only in memory, so after
  a full app **restart** you unlock once with the master password; in-session locks
  use the local password. (See the security note in [`CLAUDE.md`](CLAUDE.md).)
- **Official crypto.** Auth, sync, and vault decryption go through Bitwarden's own
  Rust SDK rather than a hand-rolled reimplementation of the protocol.
- **Cloud and self-hosted.** Works with `bitwarden.com`, `bitwarden.eu`, and any
  self-hosted Bitwarden / Vaultwarden instance via a custom server URL.

## Status

Early development (`v0.1`). The vault-read path (login → unlock → browse → copy →
TOTP) is the focus; write operations and full feature parity are being built out
incrementally — see [`CLAUDE.md`](CLAUDE.md) for the architecture and roadmap notes.

> ⚠️ Agate depends on the **password-manager side of the Bitwarden SDK**, which
> Bitwarden documents as *"not intended for public use… unstable and will change
> without warning."* It is pinned via `Cargo.lock`. Treat Agate as experimental.

## Quick start

```bash
# Prerequisites: Rust + the Tauri 2 system deps for your OS
#   https://v2.tauri.app/start/prerequisites/
# plus Node 20+.

npm install
npm run dev          # launches the app with hot reload
                     # (first run compiles the Bitwarden SDK — expect a long build)
```

## Quality checks

```bash
npm run check        # typecheck + lint + unit tests (fast gate)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run lint:rust    # cargo clippy -- -D warnings
npm run test:unit    # vitest
```

## Build

```bash
npm run build        # production build; installer under src-tauri/target/release/bundle/
```

## Security

Agate stores no secrets in plaintext and never writes the master password to disk.
The local-unlock feature seals a random verifier under your local password with
Argon2id + AES-256-GCM and stores it in the OS keychain (Keychain on macOS,
Credential Manager on Windows, Secret Service / libsecret on Linux); a wrong local
password fails the AEAD tag, so no plaintext check value is kept. The reusable sealing
layer (`src-tauri/src/secrets.rs`) is unit-tested and ready to seal a persistable
session key the moment the Bitwarden SDK exposes one — at which point local unlock will
also survive restarts. See "Local-password unlock — security model" in
[`CLAUDE.md`](CLAUDE.md).

If you find a security issue, please open a private report rather than a public issue.

## License

[GPL-3.0-or-later](LICENSE). Agate links the Bitwarden Rust SDK, which is GPLv3, so
the combined work is distributed under the GPL.
