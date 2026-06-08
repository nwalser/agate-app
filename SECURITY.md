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
  missing-TOTP) send nothing anywhere. The opt-in HIBP exposed-password check
  uses k-anonymity: only the first **5 hex chars** of a password's SHA-1 ever
  leave the device, always with `Add-Padding: true`.
- **Dark-web monitor** (`src-tauri/src/darkweb.rs`) is **opt-in and off by
  default**. There is no k-anonymity option for breached-email lookups anywhere
  in the free tier, so when enabled it sends the **full email address** (one of
  the user's own vault/account addresses) over HTTPS to a third-party breach
  database (**XposedOrNot**) — strictly more sensitive than the password check.
  Consent is stored and **enforced at the trust boundary** (the Rust command
  refuses to make the call until the user has opted in), the queried email is
  never logged, and only addresses already in the user's vault are queryable.
  The **breach directory** tab fetches HIBP's public `/breaches` catalogue and
  sends no personal data. Provider attribution is shown in the UI as required by
  both providers' terms (HIBP breach data is CC BY 4.0).
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
