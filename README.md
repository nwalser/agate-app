# Agate

**Your Bitwarden vault — every account unlocked with one app password, on Windows, macOS & Linux.**

[Download](https://github.com/nwalser/agate-app/releases/latest) · [Report a bug](https://github.com/nwalser/agate-app/issues) · [Security](SECURITY.md)

> Unofficial, open-source client. Not affiliated with or endorsed by Bitwarden, Inc. Use at your own risk.

<!-- hero screenshot: drop an image at .github/assets/hero.png and uncomment
<img src=".github/assets/hero.png" alt="Agate vault on the desktop" width="900" /> -->

---

## Features

- **Vault** — logins · cards · identities · notes · SSH keys, with custom fields, folders, favorites & trash
- **One unlock** — a single app password (or Windows Hello) opens every connected account, and stays set up across restarts
- **All your accounts** — add multiple Bitwarden / Vaultwarden accounts, see every item in one list
- **TOTP** — built-in 2FA codes with a live countdown; one-click copy of username · password · code · URL
- **Generators** — strong passwords & passphrases, full options
- **Health check** — finds reused · weak · old · insecure · missing-2FA logins, plus exposed-password & breach monitors and a 0–100 score
- **Search** — fuzzy search, type/folder/favorite filters, command palette (`Ctrl`/`⌘ K`)

## Why Agate

- **One password, every account** — unlock all your vaults together; no re-typing per account
- **Private by design** — security checks run on your device; only a hashed prefix ever leaves it
- **Open source** — GPLv3, no Agate server; talks straight to your Bitwarden / Vaultwarden
- **Native & fast** — built with Tauri, dark UI, signed automatic updates

## Download

Get the installer from the [**Releases**](https://github.com/nwalser/agate-app/releases/latest) page. Windows · macOS · Linux.

Unsigned builds may warn on first run — **Windows:** More info → Run anyway · **macOS:** right-click → Open · **Linux:** run the `.AppImage` or install the `.deb`.

> Experimental, built on Bitwarden's unstable SDK — **keep a backup of your vault.**

## Security

Each account's credentials are sealed in your OS keychain (Argon2id + AES-256-GCM) behind your app password — a wrong password just fails to decrypt. Vault crypto uses Bitwarden's **official Rust engine**, and updates are signature-verified. Full policy & private bug reports: [`SECURITY.md`](SECURITY.md).

---

<div align="center">

[Download](https://github.com/nwalser/agate-app/releases/latest) · [Report a bug](https://github.com/nwalser/agate-app/issues) · [Security](SECURITY.md) · [License (GPL-3.0)](LICENSE)

</div>
