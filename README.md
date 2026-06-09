# Agate

A fast, open-source desktop app for your **Bitwarden** vault — for **Windows, macOS, and Linux**.

Connect one or more Bitwarden (or Vaultwarden) accounts, unlock them all with a single
app password or Windows Hello, and manage your logins, cards, notes, and more from one
clean window.

> **Not made by Bitwarden.** Agate is an independent, unofficial client. "Bitwarden" is a
> trademark of Bitwarden, Inc. Agate is not affiliated with or endorsed by Bitwarden, Inc.,
> and you use it at your own risk. It's free and open source.

## What you can do

**Your whole vault, in one place**
- Every item type: logins, cards, identities, secure notes, and SSH keys — including
  custom fields, folders, favorites, and notes.
- Create, edit, duplicate, and delete items. Deleted items go to the trash, where you can
  restore them or remove them for good.
- Built-in time-based one-time codes (TOTP) with a live countdown, and one-click copy for
  usernames, passwords, codes, and website addresses.
- Select several items at once to move them to a folder, favorite them, or send them to the
  trash in one go.
- Quick fuzzy search, plus filters by type, folder, and favorites. A command palette
  (`Ctrl`/`⌘ + K`) gets you anywhere fast.
- Strong password **and** passphrase generators with full options.

**One unlock for all your accounts**
- Add as many Bitwarden / Vaultwarden accounts as you like and see all their items in one
  unified list.
- Set up **one app password** once — it unlocks every connected account together, and stays
  set up after you close and reopen the app.
- On Windows, unlock with **Windows Hello** (fingerprint, face, or PIN) instead of typing.
- Optionally tie your unlock to this one device, so your stored data is useless if copied
  elsewhere.

**Keep your passwords healthy**
- A built-in security check finds reused, weak, and old passwords, sites still using
  insecure `http://`, and logins missing two-factor codes — all on your own device.
- An optional **exposed-password** check (Have I Been Pwned) tells you if a password has
  shown up in a known breach, without ever sending the password itself.
- An optional **breach monitor** watches your own account email addresses and shows you
  which known breaches they appear in.
- A simple **0–100 health score** with a per-category breakdown so you can see progress.

**The little things**
- Works with Bitwarden US, Bitwarden EU, and any self-hosted Bitwarden or **Vaultwarden**
  server.
- Clean dark interface, sensible clipboard handling, and signed automatic updates.

## Download & install

Grab the installer for your system from the
**[Releases page](https://github.com/nwalser/agate-app/releases)**.

Agate is a free, community project, so installers may not yet carry a paid OS code-signing
certificate. That's normal — here's how to get past the first-run warnings:

- **Windows** — if SmartScreen says "unknown publisher", click **More info → Run anyway**.
- **macOS** — after dragging Agate to Applications, right-click it and choose **Open** the
  first time (or run `xattr -dr com.apple.quarantine /Applications/Agate.app`).
- **Linux** — run the `.AppImage`, or install the `.deb`.

For peace of mind, you can check the download's SHA-256 checksum against the value listed in
the release notes.

## Getting started

1. **Open Agate and create one app password.** This is the single secret you'll type to
   open Agate. Pick something strong — it protects every account you add. You can also
   choose to bind it to this device.
2. **Add a Bitwarden account.** Choose your server (Bitwarden US, Bitwarden EU, or a
   self-hosted / Vaultwarden URL), then enter your email and master password. If your
   account uses two-factor authentication, you'll be asked for a code.
3. **Add more accounts if you want** — they'll all share the same app password and show up
   in one combined list.
4. **Next time you open Agate**, just type your app password (or use Windows Hello) and
   everything unlocks at once.

> **Heads-up on two-factor:** for accounts that *enforce* two-factor authentication, you'll
> be asked for a fresh code after fully restarting the app. This is a current limitation of
> the underlying Bitwarden engine, not a bug.

## Your security & privacy

- Your accounts are protected behind your **app password** (or Windows Hello). Agate stores
  each account's credentials **encrypted in your operating system's secure store** — the
  macOS Keychain, Windows Credential Manager, or the Linux Secret Service — sealed with a
  key derived from your app password using strong, modern cryptography (Argon2id +
  AES-256-GCM). A wrong app password simply fails to decrypt; there's no plaintext to leak.
- **The security checks run on your device.** The offline checks (reused / weak / old /
  insecure / missing-code) send nothing anywhere.
- The optional **exposed-password** check uses Have I Been Pwned's privacy-preserving
  method: only the first few characters of a one-way hash of a password ever leave your
  device — never the password itself. You can turn it off in **Settings → Security
  monitoring**.
- The optional **breach monitor** is more sensitive: to look up breaches it sends your own
  account email addresses (only ones already in your vault, never arbitrary ones) over a
  secure connection to a third-party breach database. It's clearly labeled and can be turned
  off on its own in **Settings → Security monitoring**.
- **Updates are verified** with a cryptographic signature before they install, and your
  vault is locked first.

Agate uses Bitwarden's **official Rust engine** for all vault decryption, login, and syncing
— it isn't a home-grown reimplementation of the crypto. The full, technical security policy
lives in **[`SECURITY.md`](SECURITY.md)**, and that's also where to **report a security
issue privately**.

## Updating

Agate updates itself. Open **Settings → Check for updates**; if one is available it's
downloaded, signature-checked, and installed, and your vault is locked beforehand.

## Good to know

- **Is this official?** No. Agate is an independent project and is not affiliated with
  Bitwarden, Inc.
- **Is it stable?** It's under active development and built on a part of the Bitwarden
  engine that Bitwarden itself labels as experimental. It works well, but treat Agate as
  experimental and **keep a backup of your vault**.
- **Does my data go to Agate's servers?** No. Agate talks directly to your Bitwarden /
  Vaultwarden server, the same way the official apps do. There is no Agate server.
- **What if I forget my app password?** It can't be recovered — that's the point. You can
  still log back in with each account's Bitwarden master password to set a new app password.

## Help & feedback

Found a bug or have an idea? Open an
**[issue](https://github.com/nwalser/agate-app/issues)**. For anything security-related,
please use a **private report** instead — see [`SECURITY.md`](SECURITY.md).

Want to build from source or contribute code? See [`CLAUDE.md`](CLAUDE.md) and the
[`docs/`](docs) folder.

## License

[GPL-3.0-or-later](LICENSE). Agate builds on the Bitwarden Rust SDK (also GPLv3), so the
whole app is distributed under the GPL.

---

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by the
[SignPath Foundation](https://signpath.org/) *(pending approval)*.
