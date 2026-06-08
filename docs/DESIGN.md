# Agate — design & feature roadmap

Distilled from a research sweep of the official Bitwarden clients, `sdk-internal`
@ `ef81e7ae1fa63616d84a8275511f4db98c09a64e`, HIBP, Tauri CI/signing/updater, and
desktop-security best practice. This is the plan the implementation follows.

## SDK capabilities at the pinned rev (verified)

The password-manager SDK at this rev is far past decrypt-only — it does **full
server-side CRUD** and even ships a security-audit client. Key surface (all behind
our `vault.rs`/`auth.rs` wrappers):

- `client.vault().ciphers()` → `CiphersClient` (async, persists to local Repository,
  hits api-api): `create(CipherCreateRequest)`, `edit(CipherEditRequest)`,
  `edit_partial(CipherPartialEditRequest)`, `update_collection(id, Vec<CollectionId>, is_admin)`,
  `delete(id)`, `delete_many(Vec<id>, Option<org>)`, `soft_delete(id)`,
  `soft_delete_many(..)`, `restore(id)`, `restore_many(Vec<id>)`,
  `move_many(Vec<id>, Option<FolderId>)`, `bulk_update_collections(org, Vec<id>, Vec<coll>, remove)`,
  `share_cipher(view, org, Vec<coll>, original)`, `delete_attachment(id, att_id)`,
  `decrypt(Cipher)`, `decrypt_list(Vec<Cipher>)`, `get(&str)`, `list()`.
  **Gotcha:** `edit`/`restore`/`move`/`bulk` need the local repository populated →
  run a sync first. `get(&str)` takes a `&str`, others take typed ids.
- `CipherCreateRequest { organization_id, collection_ids, folder_id, name, notes,
  favorite, reprompt: CipherRepromptType, r#type: CipherViewType, fields: Vec<FieldView>,
  archived_date }`. `CipherEditRequest` = id + the above + revision_date + attachments + key;
  `impl TryFrom<CipherView> for CipherEditRequest`. `CipherViewType` = enum of
  `Login(LoginView)|Card|Identity|SecureNote|SshKey|BankAccount|Passport|DriversLicense`.
- `client.vault().folders()` → `create(FolderAddEditRequest{name})`, `edit(id, req)`,
  `get`, `list`. **No delete** — use `bitwarden-api-api` `folders_api().delete()`.
- `client.generator()` → `password(PasswordGeneratorRequest)` (**sync**),
  `passphrase(PassphraseGeneratorRequest)` (**sync**), `username(UsernameGeneratorRequest)` (async).
- `client.vault().totp().generate_totp(key, Option<time>)` (sync) → `TotpResponse{code,period}`.
- `client.vault().cipher_risk()` → `CipherRiskClient`: `password_reuse_map(Vec<CipherLoginDetails>)`
  (sync) and `compute_risk(Vec<CipherLoginDetails>, CipherRiskOptions)` (async — HIBP
  k-anonymity + zxcvbn strength 0-4 + reuse). `CipherLoginDetails{id,password,username}`,
  `CipherRiskOptions{password_map, check_exposed, hibp_base_url}`,
  `CipherRiskResult{id, password_strength, exposed_result, reuse...}`.
- `client.sends()` → full Send CRUD. `client.exporters()` → Csv/Json/EncryptedJson.
- `client.vault().collections()` = encrypt/decrypt + `get_collection_tree` only (no server
  CRUD — use api-api). `attachments()` = local buffer crypto only (upload = manual api-api).

View field lists (for forms): `LoginView{username,password,password_revision_date,uris[],totp,
autofill_on_page_load,fido2_credentials}`, `LoginUriView{uri, r#match: UriMatchType, uri_checksum}`,
`CardView{cardholder_name,number,brand,exp_month,exp_year,code}`,
`IdentityView{title,first/middle/last_name,company,ssn,passport_number,license_number,email,phone,
address1-3,city,state,postal_code,country,username}`, `SshKeyView{private_key,public_key,fingerprint}`,
`FieldView{name,value,r#type: Text|Hidden|Boolean|Linked,linked_id}`,
`PasswordHistoryView{password,last_used_date}`. `UriMatchType`: Domain0/Host1/StartsWith2/Exact3/
RegularExpression4/Never5. `CipherType`: Login1/SecureNote2/Card3/Identity4/SshKey5/BankAccount6/
DriversLicense7/Passport8. `CipherRepromptType`: None0/Password1.

## Feature roadmap (waves)

1. **Vault write + item parity** — create/edit/delete/soft-delete/restore/clone for all
   item types; full field editors; folders create/edit/(delete via api-api); favorites;
   trash view + restore + permanent delete; password history view; URI match types;
   master-password reprompt flag.
2. **Security audit engine** — offline: reused (hash-grouped), weak (zxcvbn<3), old
   (password_revision_date age), insecure http URIs, missing-TOTP; online opt-in: HIBP
   exposed via `CipherRiskClient.compute_risk` (k-anonymity, `Add-Padding`); vault health
   score 0–100 with bands. All client-side, secrets never leave the device (only the
   5-char SHA-1 prefix for the opt-in exposed check).
3. **UX/QoL** — fuzzy subsequence search + scoring + highlight; filter rail (type/folder/
   collection/org/favorite/trash); command palette (Ctrl+K); full keyboard nav; quick-copy
   hotkeys; password+passphrase+username generators UI + generator history; sort/group;
   theme (dark/light/system); clipboard auto-clear; lock-on-idle/blur; settings.
4. **Multi-vault** — accounts registry keyed by (server,email); fast switching; per-account
   session + keychain entries; combined "all vaults" search; org/collection browsing.
5. **Multi-select bulk actions** — checkbox/shift/ctrl selection; bulk move/favorite/delete/
   restore/move-to-org/export-selection.
6. **Windows Hello unlock** (Windows-only) — `UserConsentVerifier` via
   `windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()` +
   `RequestVerificationForWindowAsync(hwnd,..)`; gates a keychain-stored random data key
   that AES-GCM-seals the unlock secret. `#[cfg(target_os="windows")]`; deps under
   `[target.'cfg(windows)'.dependencies]`. Honest: in-process authorization gate, not OS-bound.
7. **Hardening** — `SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)` (Windows), zeroize,
   secure-shutdown on update, anti-phishing http warnings.
8. **CI + updater + signing + README** — `.github/workflows/{ci,release}.yml`,
   `swatinem/rust-cache` (SDK compile is long), `tauri-action` (pinned SHA), minisign updater
   keypair (free), SignPath Foundation for Windows OV (free OSS) + documented macOS
   `xattr -dr com.apple.quarantine`, `tauri-plugin-updater` + `latest.json`.

## Privacy/security invariants (non-negotiable)
- Master password never persisted. Only the 5-char SHA-1 prefix ever leaves the device,
  and only for the opt-in exposed-password check, always with `Add-Padding: true` (drop count==0).
- Reused/duplicate grouping keys off a password hash, not plaintext; zeroize buffers.
- Updater drives secure shutdown (zeroize session key) before Windows force-exits.
- One path, properly implemented; SDK calls isolated in wrappers; no `any` in IPC/crypto.
