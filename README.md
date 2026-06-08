# Agate

An unofficial, open-source, cross-platform desktop client for **Bitwarden**, built
with [Tauri 2](https://v2.tauri.app/) (Rust) and [SolidJS](https://www.solidjs.com/).
Runs on **Linux, macOS, and Windows**.

> **Not affiliated with Bitwarden, Inc.** "Bitwarden" is a trademark of Bitwarden,
> Inc. Agate is an independent third-party client that connects to the Bitwarden API
> using Bitwarden's official Rust SDK. Use it at your own risk.

## Features

**Vault**
- All item types: logins, cards, identities, secure notes, SSH keys — with custom
  fields, favorites, folders, and notes.
- Create / edit / clone / delete items; trash with restore and permanent delete.
- Per-item TOTP with a live countdown; copy username / password / TOTP / URI.
- Multi-select with bulk move-to-folder, favorite, delete, and restore.
- Fuzzy search and type/folder/favorite filtering; a command palette (Ctrl/⌘-K).
- Password **and** passphrase generators with full options.

**Unlock**
- Master-password login with two-factor (authenticator app or email).
- **Local-password unlock** — re-open with a short local password instead of the
  master password, which is never written to disk.
- **Windows Hello** unlock (Windows) — fingerprint / face / PIN.

**Security audit (all client-side, a free differentiator)**
- Reused, weak (zxcvbn), old, and insecure-`http://` passwords; logins missing TOTP.
- Opt-in **exposed-password** check via HaveIBeenPwned's k-anonymity API — only a
  5-char SHA-1 prefix ever leaves your device.
- A 0–100 **vault health score** with per-category breakdown.

**Servers & sync**
- Bitwarden US / EU cloud, and any self-hosted Bitwarden or **Vaultwarden** server.

**App**
- Auto-updates (signed), dark UI, clipboard handling, single-instance.

## Status

Active development. The vault read+write path, audit engine, and unlock methods are
implemented against Bitwarden's official SDK.

> ⚠️ Agate depends on the **password-manager side of the Bitwarden SDK**, which
> Bitwarden documents as *"not intended for public use… unstable and will change
> without warning."* It is pinned by commit. Treat Agate as experimental, and keep
> a backup of your vault. See [`docs/DESIGN.md`](docs/DESIGN.md) and
> [`SECURITY.md`](SECURITY.md).

## Install

Download the installer for your platform from the
[Releases](https://github.com/nwalser/agate-app/releases) page.

Because Agate is a free OSS project, builds may not yet be OS-code-signed:

- **Windows** — SmartScreen may warn "unknown publisher". Click **More info → Run
  anyway**. (Windows signing via SignPath Foundation is planned — see
  [`docs/SIGNING.md`](docs/SIGNING.md).)
- **macOS** — Gatekeeper quarantines unsigned downloads. After copying to
  Applications: `xattr -dr com.apple.quarantine /Applications/Agate.app` (or
  right-click → Open).
- **Linux** — run the `.AppImage`, or install the `.deb`.

Verify the SHA-256 checksum against the release notes.

## Build from source

```bash
# Prerequisites: Rust + the Tauri 2 system deps for your OS
#   https://v2.tauri.app/start/prerequisites/   (Linux: webkit2gtk-4.1)
# plus Node 20+.

npm install
npm run dev          # launches with hot reload
                     # (first run compiles the Bitwarden SDK — expect a long build)
```

## Quality checks

```bash
npm run check        # typecheck + eslint + vitest (fast gate)
npm run lint:rust    # cargo clippy -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs these on every push/PR ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

## Releases & auto-update

Pushing a `agate-v*` tag triggers [`release.yml`](.github/workflows/release.yml),
which builds Linux/macOS/Windows, signs the updater artifacts with a free minisign
key, and publishes a GitHub Release with `latest.json`. The in-app updater
(Settings → Check for updates) verifies each download against the embedded public
key and locks the vault before installing. Details: [`docs/SIGNING.md`](docs/SIGNING.md).

## Security

See [`SECURITY.md`](SECURITY.md). In short: the master password is never persisted;
local/Hello unlock seal material with Argon2id + AES-256-GCM in the OS keychain;
audits run client-side; updates are signature-verified.

## Contributing

Issues and PRs welcome. Please read [`CLAUDE.md`](CLAUDE.md) for the engineering
non-negotiables (typed IPC, no panics, secrets zeroized, design tokens) before
opening a PR.

## License

[GPL-3.0-or-later](LICENSE). Agate links the Bitwarden Rust SDK, which is GPLv3, so
the combined work is distributed under the GPL.

---

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate
by [SignPath Foundation](https://signpath.org/) *(pending approval)*.
