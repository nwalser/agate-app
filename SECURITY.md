# Security policy

## Reporting a vulnerability

Agate handles password-vault data. If you find a security issue, please report it
**privately** — open a [GitHub security advisory](https://github.com/nwalser/agate-app/security/advisories/new)
rather than a public issue. We'll acknowledge within a few days.

Please do not include real vault data or credentials in a report.

## Security model

- **Master password** is held in memory only during login and is **never written
  to disk**.
- **Local-password unlock** seals a verifier (and, when the SDK exposes a
  persistable key, the unlock key) with **Argon2id + AES-256-GCM** in the OS
  keychain (Keychain / Credential Manager / Secret Service). A wrong local
  password fails the AEAD tag — no plaintext check value is stored.
- **Windows Hello** unlock (Windows only) gates re-activation of the in-memory
  session behind a `UserConsentVerifier` check. This is an in-process
  authorization gate, not OS-cryptographic sealing — documented honestly in
  `src-tauri/src/hello.rs`.
- **Security audits** are client-side. Offline checks (reused/weak/old/insecure/
  missing-TOTP) send nothing anywhere. The HIBP exposed-password check uses
  k-anonymity: only the first **5 hex chars** of a password's SHA-1 ever leave
  the device, always with `Add-Padding: true`. It runs periodically and can be
  turned off in **Settings → Security monitoring**.
- **Dark-web monitor** (`src-tauri/src/darkweb.rs`) is **on by default** and can
  be turned off in **Settings → Security monitoring**. It periodically scans
  *all* of the user's own account email addresses (no arbitrary-address lookup).
  There is no k-anonymity option for breached-email lookups anywhere in the free
  tier, so it sends the **full email address** over HTTPS to a third-party breach
  database (**XposedOrNot**) — strictly more sensitive than the password check,
  which is why it is a separate, clearly-disclosed, individually-disableable
  control. The queried email is never logged, only addresses already in the
  user's vault are scanned, and toggling the feature off revokes the backend
  consent flag the scan command enforces at the trust boundary. The **Breaches**
  view shows only the breaches the user's own accounts actually appear in (and
  what each exposed) — derived from the scan, never the full public catalogue.
  Provider attribution is shown in the UI as required by the provider's terms.
- **Auto-updates** are verified against an embedded **minisign** public key before
  install; the vault is locked (secrets zeroized) before the installer runs.
- Vault decryption, auth, and the protocol use Bitwarden's **official Rust SDK**,
  not a re-implementation.

## Scope / known limitations

- Agate depends on the **password-manager side of the Bitwarden SDK**, which
  Bitwarden documents as unstable and not intended for public use. It is pinned
  by commit. Treat Agate as experimental.
- At the pinned SDK revision there is no public serializable unlock key, so
  local-password / Windows Hello unlock work **within a running session** but the
  master password is required again after a full app restart.
- This is an unofficial client and is **not** affiliated with or endorsed by
  Bitwarden, Inc.
