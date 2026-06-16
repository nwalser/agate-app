//! The Enpass provider: a local Enpass 6+ vault (a `vault.enpassdb` SQLCipher
//! database plus its `vault.json` descriptor) opened read-only and exposed with
//! the same read surface as the Bitwarden / KeePass connections.
//!
//! # Why this module is self-contained
//! It is modeled line-for-line on `providers::keepass`: identical public method
//! signatures (so `LiveConnection::Enpass(..)` dispatch slots in with no other
//! changes), the same DTO mapping conventions, and the same in-memory-after-open
//! shape (KeePass holds the decrypted `Database`; we hold the decrypted item set
//! we read once at `open`). The only structural difference is the backing store
//! (SQLCipher rows vs. a KDBX tree) and that this provider is **read-only** — see
//! the "Writes" section below.
//!
//! # Enpass on-disk format (reverse-engineered — see the citations at the bottom)
//! A vault is a *folder* containing:
//! - `vault.enpassdb` — a SQLCipher-encrypted SQLite database.
//! - `vault.json` — a small cleartext descriptor: `{ kdf_algo, kdf_iter,
//!   encryption_algo, have_keyfile, version, vault_name, ... }`.
//!
//! ## Two encryption layers
//! 1. **The database (SQLCipher).** Enpass does NOT let SQLCipher run its own KDF.
//!    Instead it derives the 32-byte raw key itself and hands it to SQLCipher:
//!    - salt = the **first 16 bytes** of `vault.enpassdb` (SQLCipher's standard
//!      per-database salt header, which Enpass leaves in place);
//!    - `raw_key = PBKDF2-HMAC-SHA512(password [‖ keyfile-bytes], salt, kdf_iter)`,
//!      where `kdf_iter` comes from `vault.json` (Enpass ships 100_000), and the
//!      first 32 bytes of that 64-byte output are the SQLCipher key.
//!
//!    We do NOT link SQLCipher (its `bundled-sqlcipher-vendored-openssl` feature
//!    needs Perl/NASM/OpenSSL to build). Instead this module implements SQLCipher's
//!    page format in **pure Rust** (`sqlcipher_decrypt`): every page is
//!    HMAC-verified then AES-256-CBC decrypted, the whole file is rewritten to a
//!    plaintext SQLite database, and that is opened with plain **bundled**
//!    `rusqlite` (C SQLite only — no OpenSSL/Perl). We try `cipher_compatibility 4`
//!    (Enpass 6.8+) first, then `3` (older vaults). A wrong password/keyfile fails
//!    the HMAC on page 1 for every compatibility level → `InvalidCredentials`.
//! 2. **Per-field (only `password` fields).** After SQLCipher decryption, every
//!    `itemfield.value` is cleartext EXCEPT rows whose `type = 'password'`, which
//!    are *additionally* AES-256-GCM encrypted with a per-item key:
//!    - `item.key` is a BLOB = 32-byte AES key ‖ 12-byte GCM nonce;
//!    - `itemfield.value` (for a password) is `hex(ciphertext ‖ 16-byte tag)`;
//!    - the AAD is the item UUID with dashes removed, decoded from hex.
//!
//!    A TOTP secret is a `type = 'totp'` field and is therefore **cleartext** at
//!    the SQLCipher layer (no per-field GCM) — handy, because Agate's TOTP
//!    generator wants the raw secret/URI.
//!
//! ## Schema (the columns we read)
//! - `item(uuid, title, subtitle, note, category, favorite, trashed, deleted,
//!    created_at, field_updated_at, key, icon, …)`
//! - `itemfield(item_uuid, label, value, type, sensitive, deleted, orde, …)`
//!
//! ## DTO mapping (Bitwarden-shaped DTOs ← Enpass)
//! - item id = `item.uuid`; `title` → name; `note` → notes.
//! - An item is a `Login` when it has any `username` / `password` / `url` / `totp`
//!   field, otherwise a `SecureNote` (matches the KeePass provider's rule).
//! - `username` / `password` / `url` fields → the login section; the FIRST of each
//!   wins (Enpass can carry several — e.g. a secondary email — extras fall through
//!   to custom fields). `totp` field → the login's TOTP (`has_totp`).
//! - `trashed != 0` (or `deleted != 0`) → `deleted`; `favorite != 0` → `favorite`.
//! - Every other (non-deleted) field → a custom field; a `sensitive` field → Hidden.
//! - Folders: Enpass stores folders in a `folder` table and membership in
//!   `folder_items`; we read them when present and map an item to its FIRST folder
//!   (Enpass allows multiple — Agate's model is one). When the tables are absent
//!   (older vaults) folders are simply empty and items have `folder_id = None`.
//! - Collections: Enpass has no equivalent — always empty.
//!
//! # Writes
//! **Read-only, by design.** Enpass's schema is proprietary and undocumented, the
//! app re-encrypts/normalizes on its own writes, and its cloud sync can rewrite
//! the file underneath us — a partial write here could corrupt a user's real
//! vault. Per CLAUDE.md ("KeePass writes must never destroy data" generalizes to
//! "never risk a vault we don't fully understand") we ship no writer rather than a
//! half-safe one. See the integration spec for the conditions under which a narrow,
//! atomic writer could be revisited.
//!
//! # Blocking
//! `open` runs PBKDF2 (kdf_iter rounds of HMAC-SHA512) and SQLCipher page
//! decryption — both blocking. Callers wrap `open` in `spawn_blocking`, exactly
//! like the KeePass provider.

use std::path::{Path, PathBuf};

use aes::Aes256;
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
// `cbc` re-exports the `cipher` crate, so we get its traits without depending on
// `cipher` directly (the orchestrator only adds aes/cbc/hmac/sha*/pbkdf2).
use cbc::cipher::{BlockDecryptMut, KeyIvInit};
use chrono::{TimeZone, Utc};
use rusqlite::{Connection, OpenFlags};
use zeroize::Zeroizing;

use crate::dto::{
    Collection, CustomField, CustomFieldType, Folder, ItemDetail, ItemType, LoginDetail, LoginUri,
    TotpCode, VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};

/// File names inside an Enpass vault folder.
const VAULT_DB_FILE: &str = "vault.enpassdb";
const VAULT_INFO_FILE: &str = "vault.json";

/// SQLCipher per-database salt header length (the first bytes of the db file).
const SALT_LEN: usize = 16;

/// Enpass derives a 64-byte PBKDF2 output but uses only the first 32 bytes (a
/// 256-bit AES key) for SQLCipher.
const SQLCIPHER_KEY_LEN: usize = 32;

/// Default PBKDF2 iteration count when `vault.json` doesn't carry one (Enpass 6
/// ships 100_000). We never silently weaken it: a value present in `vault.json`
/// is always preferred.
const DEFAULT_KDF_ITER: u32 = 100_000;

/// `cipher_compatibility` levels we try, newest first (Enpass 6.8+ uses 4; older
/// vaults use 3). Each level fixes the page size + HMAC algorithm we decode with.
const CIPHER_COMPATIBILITY_CANDIDATES: [CipherCompat; 2] =
    [CipherCompat::V4, CipherCompat::V3];

/// SQLCipher CBC initialization-vector size, and the AES block size — both 16
/// bytes for AES-256-CBC.
const IV_LEN: usize = 16;
const AES_BLOCK_LEN: usize = 16;

/// SQLCipher's per-database "fast" PBKDF2 iteration count used to derive the
/// page-HMAC subkey from the raw key (a fixed 2 in every SQLCipher release).
const FAST_PBKDF2_ITER: u32 = 2;

/// The byte SQLCipher XORs into every salt byte before deriving the HMAC subkey,
/// so the HMAC subkey is domain-separated from the page-encryption key.
const HMAC_SALT_MASK: u8 = 0x3a;

/// The fixed 16-byte SQLite file header ("SQLite format 3\0"). Page 1's first 16
/// bytes are the plaintext salt on disk; a valid plaintext database needs this
/// header restored in their place.
const SQLITE_HEADER: &[u8; 16] = b"SQLite format 3\x00";

/// One SQLCipher `cipher_compatibility` level and the parameters it implies.
/// `reserve` is the per-page reserved tail = `align_up(IV_LEN + hmac_len, block)`:
/// v4 = align_up(16 + 64) = 80, v3 = align_up(16 + 20) = 48.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CipherCompat {
    /// Enpass 6.8+: 4096-byte pages, HMAC-SHA512 (64-byte tag), SHA-512 KDF PRF.
    V4,
    /// Older vaults: 1024-byte pages, HMAC-SHA1 (20-byte tag), SHA-1 KDF PRF.
    V3,
}

impl CipherCompat {
    fn page_size(self) -> usize {
        match self {
            CipherCompat::V4 => 4096,
            CipherCompat::V3 => 1024,
        }
    }

    fn hmac_len(self) -> usize {
        match self {
            CipherCompat::V4 => 64, // SHA-512
            CipherCompat::V3 => 20, // SHA-1
        }
    }

    /// Per-page reserved tail: IV ‖ HMAC, rounded up to a whole AES block.
    fn reserve(self) -> usize {
        let raw = IV_LEN + self.hmac_len();
        raw.div_ceil(AES_BLOCK_LEN) * AES_BLOCK_LEN
    }
}

/// The Enpass field `type` strings we treat specially (everything else becomes a
/// custom field). These are the values Enpass writes for the corresponding
/// built-in field roles.
const FIELD_TYPE_USERNAME: &str = "username";
const FIELD_TYPE_PASSWORD: &str = "password";
const FIELD_TYPE_URL: &str = "url";
const FIELD_TYPE_TOTP: &str = "totp";
/// Field types that should never surface as custom fields (decorative section
/// headers Enpass inserts to group fields in its UI).
const FIELD_TYPE_SECTION: &str = "section";

/// One decrypted Enpass field, already past both encryption layers.
#[derive(Clone)]
struct EnpassField {
    label: String,
    /// Plaintext value (per-field GCM already undone for `password` fields).
    /// `None` when the field had no value (or a password row whose value/key was
    /// cleared by an Enpass delete).
    value: Option<String>,
    field_type: String,
    sensitive: bool,
}

/// One decrypted Enpass item plus everything the read surface needs. Built once
/// at `open`; the connection holds these so reads never touch SQLCipher again
/// (mirroring how the KeePass provider holds the decrypted `Database`).
#[derive(Clone)]
struct EnpassItem {
    uuid: String,
    title: String,
    note: Option<String>,
    favorite: bool,
    deleted: bool,
    folder_id: Option<String>,
    created_at: Option<i64>,
    updated_at: Option<i64>,
    fields: Vec<EnpassField>,
}

/// A folder (Enpass "tag"/folder), id = folder uuid.
#[derive(Clone)]
struct EnpassFolder {
    uuid: String,
    title: String,
}

/// One live, unlocked Enpass connection: the vault folder path, the key material
/// (zeroized on drop), and the decrypted snapshot read at `open`.
pub struct EnpassConnection {
    /// The vault *folder* (the directory that holds `vault.enpassdb`).
    path: PathBuf,
    items: Vec<EnpassItem>,
    folders: Vec<EnpassFolder>,
}

/// Redacted: never prints key material or vault contents.
impl std::fmt::Debug for EnpassConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EnpassConnection")
            .field("path", &self.path)
            .field("items", &self.items.len())
            .finish_non_exhaustive()
    }
}

// ── lifecycle (open) ──────────────────────────────────────────────────────────

impl EnpassConnection {
    /// Open + decrypt an Enpass vault. `path` may be either the vault *folder* or
    /// the `vault.enpassdb` file itself (we normalize to the folder so we can
    /// also read the sibling `vault.json`). A wrong password or key file makes the
    /// first SQLCipher-backed query fail → `InvalidCredentials`.
    ///
    /// Blocking (PBKDF2 + SQLCipher page decryption) — callers wrap in
    /// `spawn_blocking`.
    pub fn open(path: &Path, password: &str, keyfile: Option<&Path>) -> AgateResult<Self> {
        let folder = vault_folder(path);
        let db_path = folder.join(VAULT_DB_FILE);
        let info_path = folder.join(VAULT_INFO_FILE);

        let info = VaultInfo::load(&info_path)?;
        let keyfile_bytes = match keyfile {
            Some(p) => Some(load_keyfile(p)?),
            None => None,
        };
        let raw_key =
            derive_key(&db_path, password, keyfile_bytes.as_deref().map(|v| v.as_slice()), info.kdf_iter)?;

        // Read the whole encrypted file (zeroized) and decode it to a plaintext
        // SQLite database in pure Rust — no SQLCipher/OpenSSL linkage.
        let db_bytes = Zeroizing::new(std::fs::read(&db_path).map_err(|e| {
            AgateError::bad_request(format!("Cannot read the Enpass database file: {e}"))
        })?);
        // `raw_key` is `Zeroizing<[u8; 32]>`; pass the inner array (held until here
        // so the key is zeroized only after decode).
        let plaintext = sqlcipher_decrypt(db_bytes.as_slice(), &raw_key)?;

        let (items, folders) = read_plaintext_snapshot(plaintext.as_slice())?;
        Ok(Self { path: folder, items, folders })
    }
}

// ── read surface (mirrors KeepassConnection / BitwardenConnection) ────────────

impl EnpassConnection {
    /// All items as unified list rows, stamped with the connection id + label.
    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        self.items.iter().map(|item| item.to_list_item(id, label)).collect()
    }

    /// Per-login match entries for the autofill index (logins only).
    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        let mut out = Vec::new();
        for item in &self.items {
            if item.deleted || item.item_type() != ItemType::Login {
                continue;
            }
            let mut uris: Vec<String> = Vec::new();
            for field in &item.fields {
                if field.field_type == FIELD_TYPE_URL {
                    if let Some(v) = non_empty(field.value.as_deref()) {
                        if !uris.contains(&v) {
                            uris.push(v);
                        }
                    }
                }
            }
            out.push(crate::autofill::MatchItem {
                id: item.uuid.clone(),
                account_email: id.to_string(),
                account_label: label.to_string(),
                name: item.title.clone(),
                username: item.first_field_value(FIELD_TYPE_USERNAME),
                uris,
                reprompt: false,
            });
        }
        out
    }

    /// Names of every custom field across the vault (names only — values are
    /// never read here). Sorted + de-duplicated for determinism.
    pub fn custom_field_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .items
            .iter()
            .flat_map(|item| item.custom_fields().map(|f| f.label.clone()))
            .filter(|n| !n.is_empty())
            .collect();
        names.sort();
        names.dedup();
        names
    }

    /// One item as full detail (login fields, notes, custom fields, dates).
    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        let item = self.find_item(item_id)?;
        let item_type = item.item_type();

        let login = (item_type == ItemType::Login).then(|| {
            let totp = item.first_field_value(FIELD_TYPE_TOTP);
            LoginDetail {
                username: item.first_field_value(FIELD_TYPE_USERNAME),
                password: item.first_field_value(FIELD_TYPE_PASSWORD),
                has_totp: totp.is_some(),
                totp,
                uris: item
                    .first_field_value(FIELD_TYPE_URL)
                    .map(|u| vec![LoginUri { uri: Some(u), match_type: None }])
                    .unwrap_or_default(),
                password_revision_date: None,
                autofill_on_page_load: None,
                password_history: Vec::new(),
            }
        });

        let mut fields: Vec<CustomField> = item
            .custom_fields()
            .filter_map(|f| {
                non_empty(f.value.as_deref()).map(|value| CustomField {
                    name: Some(f.label.clone()),
                    value: Some(value),
                    field_type: if f.sensitive {
                        CustomFieldType::Hidden
                    } else {
                        CustomFieldType::Text
                    },
                    linked_id: None,
                })
            })
            .collect();
        // Stable detail pane regardless of row order.
        fields.sort_by(|a, b| a.name.cmp(&b.name));

        Ok(ItemDetail {
            id: item.uuid.clone(),
            account_email: id.to_string(),
            account_label: label.to_string(),
            name: item.title.clone(),
            item_type,
            favorite: item.favorite,
            reprompt: false,
            notes: non_empty(item.note.as_deref()),
            login,
            card: None,
            identity: None,
            ssh_key: None,
            fields,
            folder_id: item.folder_id.clone(),
            organization_id: None,
            revision_date: rfc3339(item.updated_at),
            creation_date: rfc3339(item.created_at),
            collection_ids: Vec::new(),
            passkeys: Vec::new(),
        })
    }

    /// Current TOTP code from the item's `totp` field (otpauth:// URI or raw
    /// secret — the same generator the other providers use).
    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        let item = self.find_item(item_id)?;
        let secret = item
            .first_field_value(FIELD_TYPE_TOTP)
            .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;
        crate::totp::current(secret)
    }

    /// Every folder, stamped with the connection id + label. Empty for vaults
    /// without a folder table.
    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        let mut out: Vec<Folder> = self
            .folders
            .iter()
            .map(|f| Folder {
                id: Some(f.uuid.clone()),
                name: f.title.clone(),
                account_email: id.to_string(),
                account_label: label.to_string(),
            })
            .collect();
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// Enpass has no collections — always empty.
    pub fn list_collections(&self, _id: &str, _label: &str) -> Vec<Collection> {
        Vec::new()
    }

    /// How many non-deleted items use `candidate` as a password.
    pub fn count_password_use(&self, candidate: &str) -> u32 {
        if candidate.is_empty() {
            return 0;
        }
        let mut count = 0u32;
        for item in &self.items {
            if item.deleted {
                continue;
            }
            if item.first_field_value(FIELD_TYPE_PASSWORD).as_deref() == Some(candidate) {
                count += 1;
            }
        }
        count
    }

    fn find_item(&self, item_id: &str) -> AgateResult<&EnpassItem> {
        self.items
            .iter()
            .find(|i| i.uuid == item_id)
            .ok_or_else(|| AgateError::bad_request("No such item."))
    }
}

// ── EnpassItem helpers ────────────────────────────────────────────────────────

impl EnpassItem {
    /// Login when any login-shaped field carries a value, else a secure note
    /// (mirrors the KeePass provider, so an empty Enpass entry stays a note).
    fn item_type(&self) -> ItemType {
        let has_login_field = self.fields.iter().any(|f| {
            matches!(
                f.field_type.as_str(),
                FIELD_TYPE_USERNAME | FIELD_TYPE_PASSWORD | FIELD_TYPE_URL | FIELD_TYPE_TOTP
            ) && f.value.as_deref().is_some_and(|v| !v.is_empty())
        });
        if has_login_field {
            ItemType::Login
        } else {
            ItemType::SecureNote
        }
    }

    /// First non-empty value of a given Enpass field type.
    fn first_field_value(&self, field_type: &str) -> Option<String> {
        self.fields
            .iter()
            .filter(|f| f.field_type == field_type)
            .find_map(|f| non_empty(f.value.as_deref()))
    }

    /// Fields that should surface as Agate custom fields: not deleted (already
    /// filtered out at read), not a built-in login role, not a section header.
    /// Note the FIRST username/password/url/totp is consumed by the login
    /// section; any *extra* same-type fields still fall through here so nothing
    /// is silently dropped.
    fn custom_fields(&self) -> impl Iterator<Item = &EnpassField> {
        let mut seen_username = false;
        let mut seen_password = false;
        let mut seen_url = false;
        let mut seen_totp = false;
        self.fields.iter().filter(move |f| {
            match f.field_type.as_str() {
                FIELD_TYPE_SECTION => false,
                FIELD_TYPE_USERNAME if !seen_username => {
                    seen_username = true;
                    false
                }
                FIELD_TYPE_PASSWORD if !seen_password => {
                    seen_password = true;
                    false
                }
                FIELD_TYPE_URL if !seen_url => {
                    seen_url = true;
                    false
                }
                FIELD_TYPE_TOTP if !seen_totp => {
                    seen_totp = true;
                    false
                }
                _ => true,
            }
        })
    }

    fn to_list_item(&self, id: &str, label: &str) -> VaultItem {
        VaultItem {
            id: self.uuid.clone(),
            account_email: id.to_string(),
            account_label: label.to_string(),
            name: self.title.clone(),
            item_type: self.item_type(),
            username: self.first_field_value(FIELD_TYPE_USERNAME),
            uri: self.first_field_value(FIELD_TYPE_URL),
            has_totp: self.first_field_value(FIELD_TYPE_TOTP).is_some(),
            has_passkey: false,
            reprompt: false,
            favorite: self.favorite,
            deleted: self.deleted,
            folder_id: self.folder_id.clone(),
            organization_id: None,
        }
    }
}

// ── vault.json ────────────────────────────────────────────────────────────────

/// The subset of `vault.json` we need. Other keys (`encryption_algo`,
/// `kdf_algo`, `vault_name`, `version`, …) are ignored — we only require the KDF
/// iteration count, and only as a hint with a safe default.
struct VaultInfo {
    kdf_iter: u32,
}

impl VaultInfo {
    fn load(path: &Path) -> AgateResult<Self> {
        // `vault.json` is cleartext; a missing or unreadable one is still
        // recoverable because `kdf_iter` defaults to Enpass's shipped value.
        let kdf_iter = match std::fs::read(path) {
            Ok(bytes) => parse_kdf_iter(&bytes).unwrap_or_else(|| {
                log::warn!(
                    "Enpass vault.json present but kdf_iter unreadable; \
                     falling back to the default iteration count"
                );
                DEFAULT_KDF_ITER
            }),
            Err(e) => {
                log::warn!(
                    "Enpass vault.json not readable ({e}); \
                     falling back to the default iteration count"
                );
                DEFAULT_KDF_ITER
            }
        };
        Ok(Self { kdf_iter })
    }
}

/// Pull `kdf_iter` out of `vault.json` without a serde struct (keeps the parse a
/// pure leaf, and tolerates the many other keys Enpass writes). Returns `None`
/// when the key is absent or not a positive integer.
fn parse_kdf_iter(bytes: &[u8]) -> Option<u32> {
    let value: serde_json::Value = serde_json::from_slice(bytes).ok()?;
    let n = value.get("kdf_iter")?.as_u64()?;
    if n == 0 || n > u32::MAX as u64 {
        return None;
    }
    Some(n as u32)
}

// ── key derivation ──────────────────────────────────────────────────────────

/// Read the SQLCipher salt: the first 16 bytes of `vault.enpassdb`.
fn read_salt(db_path: &Path) -> AgateResult<[u8; SALT_LEN]> {
    use std::io::Read;
    let mut file = std::fs::File::open(db_path).map_err(|e| {
        AgateError::bad_request(format!("Cannot open the Enpass database file: {e}"))
    })?;
    let mut salt = [0u8; SALT_LEN];
    file.read_exact(&mut salt).map_err(|e| {
        AgateError::bad_request(format!("Enpass database file is too short to be valid: {e}"))
    })?;
    Ok(salt)
}

/// Load a keyfile's raw key bytes. Enpass keyfiles are XML wrapping a hex string
/// (`<Key>…hex…</Key>` style); we accept that, and also a bare hex string, and
/// fall back to the raw file bytes. The bytes are appended to the password before
/// PBKDF2 (Enpass's scheme).
fn load_keyfile(path: &Path) -> AgateResult<Zeroizing<Vec<u8>>> {
    let raw = std::fs::read(path)
        .map_err(|e| AgateError::bad_request(format!("Could not read the key file: {e}")))?;
    let text = String::from_utf8_lossy(&raw);
    // Try to pull hex out of an XML-ish keyfile, else treat the whole trimmed
    // file as hex, else use the bytes verbatim.
    if let Some(hex) = extract_keyfile_hex(&text) {
        if let Ok(decoded) = decode_hex(&hex) {
            return Ok(Zeroizing::new(decoded));
        }
    }
    Ok(Zeroizing::new(raw))
}

/// Extract the inner hex of a `<Key>…</Key>`-style keyfile (any single XML
/// element wrapping hex), or the whole trimmed string when there is no markup.
fn extract_keyfile_hex(text: &str) -> Option<String> {
    let trimmed = text.trim();
    // `find('>')` = end of the OPENING tag; `rfind("</")` = start of the closing
    // tag. (rfind('>') would land on the closing tag's '>', giving start > end.)
    if let (Some(start), Some(end)) = (trimmed.find('>'), trimmed.rfind("</")) {
        if start < end {
            let inner: String =
                trimmed[start + 1..end].chars().filter(|c| !c.is_whitespace()).collect();
            if !inner.is_empty() {
                return Some(inner);
            }
        }
    }
    let inner: String = trimmed.chars().filter(|c| !c.is_whitespace()).collect();
    if inner.is_empty() {
        None
    } else {
        Some(inner)
    }
}

/// Derive the 32-byte SQLCipher raw key:
/// `PBKDF2-HMAC-SHA512(password ‖ keyfile-bytes, salt, kdf_iter)[..32]`.
fn derive_key(
    db_path: &Path,
    password: &str,
    keyfile_bytes: Option<&[u8]>,
    kdf_iter: u32,
) -> AgateResult<Zeroizing<[u8; SQLCIPHER_KEY_LEN]>> {
    use hmac::Hmac;
    use sha2::Sha512;

    let salt = read_salt(db_path)?;

    // password ‖ keyfile bytes (zeroized).
    let mut secret = Zeroizing::new(password.as_bytes().to_vec());
    if let Some(kf) = keyfile_bytes {
        secret.extend_from_slice(kf);
    }

    // PBKDF2 produces a 64-byte block; we keep only the first 32.
    let mut out = Zeroizing::new([0u8; 64]);
    pbkdf2::pbkdf2::<Hmac<Sha512>>(&secret, &salt, kdf_iter, out.as_mut_slice()).map_err(|e| {
        AgateError::new(ErrorKind::Crypto, format!("Could not derive the Enpass database key: {e}"))
    })?;

    let mut key = Zeroizing::new([0u8; SQLCIPHER_KEY_LEN]);
    key.copy_from_slice(&out[..SQLCIPHER_KEY_LEN]);
    Ok(key)
}

// ── pure-Rust SQLCipher decode ────────────────────────────────────────────────

/// Decode an entire SQLCipher database file to a plaintext SQLite database, in
/// pure Rust (no SQLCipher/OpenSSL linkage).
///
/// Implements the SQLCipher page format documented at
/// <https://www.zetetic.net/sqlcipher/design/> ("How SQLCipher encrypts a
/// database"): per page, an AES-256-CBC ciphertext followed by a reserved tail of
/// `IV ‖ HMAC` (the HMAC authenticates `ciphertext ‖ IV ‖ pgno_le32` under a
/// PBKDF2-derived subkey). Page 1's first 16 bytes hold the plaintext salt on
/// disk; the plaintext database restores the SQLite header there.
///
/// We try `cipher_compatibility 4` (Enpass 6.8+) first, then `3` (older vaults).
/// The compatibility level is chosen by the **page-1 HMAC**: a level whose page-1
/// HMAC verifies is the right one. If *no* level's page-1 HMAC verifies the
/// password/key is wrong → `InvalidCredentials`. A page-1-OK level that then fails
/// a *later* page's HMAC is a corrupt database → `Crypto`.
fn sqlcipher_decrypt(
    db_bytes: &[u8],
    raw_key: &[u8; SQLCIPHER_KEY_LEN],
) -> AgateResult<Zeroizing<Vec<u8>>> {
    let mut last_err: Option<AgateError> = None;
    for compat in CIPHER_COMPATIBILITY_CANDIDATES {
        match decrypt_with_compat(db_bytes, raw_key, compat) {
            Ok(plaintext) => return Ok(plaintext),
            // Page-1 HMAC failed: this level is simply not the right one — try the
            // next without surfacing it as the final error.
            Err(e) if matches!(e.kind, ErrorKind::InvalidCredentials) => last_err = Some(e),
            // Page-1 verified but the file is malformed/corrupt (a later page failed,
            // or the geometry is wrong): that is a real, level-specific failure — do
            // not keep trying other levels behind it.
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| {
        AgateError::new(
            ErrorKind::InvalidCredentials,
            "Wrong password or key file for this Enpass vault.",
        )
    }))
}

/// Decode every page at one `cipher_compatibility` level. Returns
/// `InvalidCredentials` only when page 1's HMAC fails (wrong key / wrong level);
/// any other failure (geometry, a later page) is `Crypto`.
fn decrypt_with_compat(
    db_bytes: &[u8],
    raw_key: &[u8; SQLCIPHER_KEY_LEN],
    compat: CipherCompat,
) -> AgateResult<Zeroizing<Vec<u8>>> {
    let page_size = compat.page_size();
    let reserve = compat.reserve();

    if db_bytes.len() < SALT_LEN {
        return Err(AgateError::bad_request("Enpass database file is too short to be valid."));
    }
    if db_bytes.len() < page_size || db_bytes.len() % page_size != 0 {
        // Not a whole number of pages at this geometry → this level cannot apply.
        // Treat as "wrong level" so the other candidate is still tried.
        return Err(AgateError::new(
            ErrorKind::InvalidCredentials,
            "Enpass database does not match this cipher layout.",
        ));
    }

    // salt = first 16 bytes of the file.
    let mut salt = [0u8; SALT_LEN];
    salt.copy_from_slice(&db_bytes[..SALT_LEN]);

    // HMAC subkey = PBKDF2(PRF, password = raw_key, salt = salt XOR 0x3a, iters = 2).
    let hmac_salt: Zeroizing<[u8; SALT_LEN]> =
        Zeroizing::new(std::array::from_fn(|i| salt[i] ^ HMAC_SALT_MASK));
    let hmac_subkey = derive_hmac_subkey(raw_key, &hmac_salt, compat)?;

    let page_count = db_bytes.len() / page_size;
    let mut plaintext = Zeroizing::new(Vec::with_capacity(db_bytes.len()));

    for pgno_zero in 0..page_count {
        let pgno = (pgno_zero + 1) as u32; // SQLCipher page numbers are 1-based.
        let page = &db_bytes[pgno_zero * page_size..(pgno_zero + 1) * page_size];
        let off = if pgno == 1 { SALT_LEN } else { 0 };

        // Layout: [off..page_size-reserve] ciphertext | [..+16] IV | [..+hmac_len] HMAC.
        let ct_end = page_size - reserve;
        let iv_start = ct_end;
        let iv_end = iv_start + IV_LEN;
        let hmac_start = iv_end;
        let hmac_end = hmac_start + compat.hmac_len();
        // `reserve` is sized so hmac_end <= page_size, but never trust geometry blindly.
        if off >= ct_end || hmac_end > page_size {
            return Err(AgateError::new(
                ErrorKind::Crypto,
                "Enpass database page layout is invalid.",
            ));
        }

        let ciphertext = &page[off..ct_end];
        let iv = &page[iv_start..iv_end];
        let stored_hmac = &page[hmac_start..hmac_end];

        // HMAC is over (ciphertext ‖ IV) followed by the 1-based page number as a
        // 4-byte little-endian integer — i.e. page[off..iv_end] ‖ pgno_le32.
        let ok = verify_page_hmac(&hmac_subkey, &page[off..iv_end], pgno, stored_hmac, compat)?;
        if !ok {
            return Err(if pgno == 1 {
                // Page 1 is the authenticator for the whole key/level.
                AgateError::new(
                    ErrorKind::InvalidCredentials,
                    "Wrong password or key file for this Enpass vault.",
                )
            } else {
                AgateError::new(
                    ErrorKind::Crypto,
                    "Enpass database failed page authentication (corrupt or truncated).",
                )
            });
        }

        // AES-256-CBC decrypt; the ciphertext is a whole number of 16-byte blocks
        // (SQLCipher never pads — the page geometry guarantees block alignment).
        let decrypted = aes_cbc_decrypt_no_padding(raw_key, iv, ciphertext)?;

        // Reassemble to exactly `page_size`: [page-1 header] ‖ decrypted ‖ zero tail.
        if pgno == 1 {
            plaintext.extend_from_slice(SQLITE_HEADER);
        }
        plaintext.extend_from_slice(&decrypted);
        // Zero-fill the reserved tail (the IV+HMAC region SQLite leaves unused).
        let padded_len = plaintext.len() + reserve;
        plaintext.resize(padded_len, 0u8);
    }

    Ok(plaintext)
}

/// Derive the per-page HMAC subkey: PBKDF2(PRF = the level's hash, password =
/// `raw_key`, salt = the masked salt, iterations = `FAST_PBKDF2_ITER`) truncated to
/// 32 bytes. The PRF matches SQLCipher's HMAC algorithm for the level (SHA-512 for
/// v4, SHA-1 for v3).
fn derive_hmac_subkey(
    raw_key: &[u8; SQLCIPHER_KEY_LEN],
    masked_salt: &[u8; SALT_LEN],
    compat: CipherCompat,
) -> AgateResult<Zeroizing<[u8; 32]>> {
    use hmac::Hmac;
    use sha1::Sha1;
    use sha2::Sha512;

    let mut subkey = Zeroizing::new([0u8; 32]);
    let res = match compat {
        CipherCompat::V4 => pbkdf2::pbkdf2::<Hmac<Sha512>>(
            raw_key.as_slice(),
            masked_salt,
            FAST_PBKDF2_ITER,
            subkey.as_mut_slice(),
        ),
        CipherCompat::V3 => pbkdf2::pbkdf2::<Hmac<Sha1>>(
            raw_key.as_slice(),
            masked_salt,
            FAST_PBKDF2_ITER,
            subkey.as_mut_slice(),
        ),
    };
    res.map_err(|e| {
        AgateError::new(ErrorKind::Crypto, format!("Could not derive the page HMAC subkey: {e}"))
    })?;
    Ok(subkey)
}

/// Compute HMAC(subkey) over `body ‖ pgno_le32` and constant-time compare it to
/// `stored`. The MAC algorithm is the level's hash (SHA-512 for v4, SHA-1 for v3).
fn verify_page_hmac(
    subkey: &[u8; 32],
    body: &[u8],
    pgno: u32,
    stored: &[u8],
    compat: CipherCompat,
) -> AgateResult<bool> {
    use hmac::{Hmac, Mac};
    use sha1::Sha1;
    use sha2::Sha512;

    // The page number is fed in as 4 little-endian bytes (SQLCipher convention).
    let pgno_le = pgno.to_le_bytes();

    let computed: Vec<u8> = match compat {
        CipherCompat::V4 => {
            let mut mac = <Hmac<Sha512> as hmac::Mac>::new_from_slice(subkey).map_err(|e| {
                AgateError::new(ErrorKind::Crypto, format!("HMAC-SHA512 init failed: {e}"))
            })?;
            mac.update(body);
            mac.update(&pgno_le);
            mac.finalize().into_bytes().to_vec()
        }
        CipherCompat::V3 => {
            let mut mac = <Hmac<Sha1> as hmac::Mac>::new_from_slice(subkey).map_err(|e| {
                AgateError::new(ErrorKind::Crypto, format!("HMAC-SHA1 init failed: {e}"))
            })?;
            mac.update(body);
            mac.update(&pgno_le);
            mac.finalize().into_bytes().to_vec()
        }
    };

    Ok(constant_time_eq(&computed, stored))
}

/// AES-256-CBC decrypt `ciphertext` (a whole number of 16-byte blocks) with no
/// padding removal. The output is the same length as the input.
fn aes_cbc_decrypt_no_padding(
    key: &[u8; SQLCIPHER_KEY_LEN],
    iv: &[u8],
    ciphertext: &[u8],
) -> AgateResult<Zeroizing<Vec<u8>>> {
    use cbc::cipher::block_padding::NoPadding;

    if iv.len() != IV_LEN {
        return Err(AgateError::new(ErrorKind::Crypto, "Enpass page IV has the wrong length."));
    }
    if ciphertext.is_empty() || ciphertext.len() % AES_BLOCK_LEN != 0 {
        return Err(AgateError::new(
            ErrorKind::Crypto,
            "Enpass page ciphertext is not a whole number of AES blocks.",
        ));
    }

    let cipher = cbc::Decryptor::<Aes256>::new_from_slices(key, iv).map_err(|e| {
        AgateError::new(ErrorKind::Crypto, format!("AES-CBC init failed: {e}"))
    })?;

    // NoPadding: the input is a whole number of blocks, so the output length
    // equals the input length — `decrypt_padded_mut` decrypts in place and the
    // buffer stays full. Avoids touching the (deprecated) GenericArray API.
    let mut out = Zeroizing::new(ciphertext.to_vec());
    let out_len = cipher
        .decrypt_padded_mut::<NoPadding>(&mut out[..])
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("AES-CBC decrypt failed: {e}")))?
        .len();
    out.truncate(out_len);
    Ok(out)
}

/// Constant-time byte-slice equality (length-checked). Used for the page HMAC
/// compare so a wrong key/level can't be distinguished by timing.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

// ── snapshot read + per-field decrypt ─────────────────────────────────────────

/// Write the decrypted plaintext SQLite bytes to a temp file, open it read-only
/// with plain bundled `rusqlite`, read the snapshot, then drop the temp file.
fn read_plaintext_snapshot(
    plaintext: &[u8],
) -> AgateResult<(Vec<EnpassItem>, Vec<EnpassFolder>)> {
    use std::io::Write;

    // A same-process temp file holds the decrypted database only for the duration
    // of the read; `NamedTempFile` deletes it on drop. We never write it back.
    let mut tmp = tempfile::NamedTempFile::new().map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("Could not create a scratch file: {e}"))
    })?;
    tmp.write_all(plaintext).map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("Could not stage the decrypted vault: {e}"))
    })?;
    tmp.flush().map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("Could not flush the decrypted vault: {e}"))
    })?;

    // Read-only open of plain SQLite — no SQLCipher key, the file is already
    // plaintext. Read-only also avoids any `-wal`/`-journal` side files.
    let conn = Connection::open_with_flags(tmp.path(), OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(map_plaintext_open_error)?;
    let snapshot = read_snapshot(&conn);
    // Close before the temp file is removed, so the decrypted bytes don't linger.
    drop(conn);
    drop(tmp);
    snapshot
}

/// A failure opening the *decrypted* file as plain SQLite means the decode
/// produced garbage — in practice a wrong key whose page-1 HMAC nonetheless
/// (astronomically unlikely) matched, or a genuinely corrupt vault. Map to
/// `InvalidCredentials` (the actionable message for the unlock UI); never leak key
/// material.
fn map_plaintext_open_error(err: rusqlite::Error) -> AgateError {
    AgateError::new(
        ErrorKind::InvalidCredentials,
        format!("The Enpass vault could not be read after decryption ({err})."),
    )
}

/// Read every item + field once, decrypting `password` fields, and read folders
/// when the optional folder tables exist.
fn read_snapshot(conn: &Connection) -> AgateResult<(Vec<EnpassItem>, Vec<EnpassFolder>)> {
    let folder_membership = read_folder_membership(conn);
    let folders = read_folders(conn);
    let items = read_items(conn, &folder_membership)?;
    Ok((items, folders))
}

/// Read all items joined with their fields. `item.key` (the per-item AES key‖nonce)
/// is read alongside each field so a `password` field can be GCM-decrypted with
/// the item's UUID as AAD.
fn read_items(
    conn: &Connection,
    folder_membership: &std::collections::HashMap<String, String>,
) -> AgateResult<Vec<EnpassItem>> {
    let mut stmt = conn
        .prepare(
            "SELECT item.uuid, item.title, item.note, item.favorite, \
                    item.trashed, item.deleted, item.created_at, item.field_updated_at, \
                    item.key, \
                    itemfield.label, itemfield.value, itemfield.type, \
                    itemfield.sensitive, itemfield.deleted \
             FROM item \
             LEFT JOIN itemfield ON item.uuid = itemfield.item_uuid \
             ORDER BY item.uuid, itemfield.orde",
        )
        .map_err(|e| query_error("prepare item/itemfield read", e))?;

    // (uuid, base fields) accumulated in first-seen order; fields appended as rows
    // arrive. A `LEFT JOIN` means an item with no fields still yields one row
    // (with NULL field columns), so notes-only items aren't lost.
    let mut order: Vec<String> = Vec::new();
    let mut map: std::collections::HashMap<String, EnpassItem> = std::collections::HashMap::new();

    let mut rows = stmt.query([]).map_err(|e| query_error("run item/itemfield read", e))?;
    while let Some(row) = rows.next().map_err(|e| query_error("read item/itemfield row", e))? {
        let uuid: String = row.get(0).map_err(|e| query_error("read item.uuid", e))?;
        // First time we see this uuid: read the item's base columns and insert it.
        // (Done as a separate `contains_key` check + insert rather than a
        // `match map.get_mut(..)` so the borrow checker accepts the conditional
        // insert without Polonius — the `&mut` is taken unconditionally below.)
        if !map.contains_key(&uuid) {
            let title: String = row
                .get::<_, Option<String>>(1)
                .map_err(|e| query_error("read item.title", e))?
                .unwrap_or_default();
            let note: Option<String> = row.get(2).map_err(|e| query_error("read item.note", e))?;
            let favorite: i64 = row
                .get::<_, Option<i64>>(3)
                .map_err(|e| query_error("read item.favorite", e))?
                .unwrap_or(0);
            let trashed: i64 = row
                .get::<_, Option<i64>>(4)
                .map_err(|e| query_error("read item.trashed", e))?
                .unwrap_or(0);
            let deleted: i64 = row
                .get::<_, Option<i64>>(5)
                .map_err(|e| query_error("read item.deleted", e))?
                .unwrap_or(0);
            let created_at: Option<i64> =
                row.get(6).map_err(|e| query_error("read item.created_at", e))?;
            let updated_at: Option<i64> =
                row.get(7).map_err(|e| query_error("read item.field_updated_at", e))?;
            order.push(uuid.clone());
            map.insert(
                uuid.clone(),
                EnpassItem {
                    uuid: uuid.clone(),
                    title,
                    note,
                    favorite: favorite != 0,
                    deleted: trashed != 0 || deleted != 0,
                    folder_id: folder_membership.get(&uuid).cloned(),
                    created_at,
                    updated_at,
                    fields: Vec::new(),
                },
            );
        }
        // Safe to expect-free unwrap: we just inserted it if it was absent.
        let entry = match map.get_mut(&uuid) {
            Some(e) => e,
            None => continue, // unreachable in practice; never panic
        };

        // The field columns are NULL for an item with no fields (LEFT JOIN).
        let label: Option<String> =
            row.get(9).map_err(|e| query_error("read itemfield.label", e))?;
        let field_type: Option<String> =
            row.get(11).map_err(|e| query_error("read itemfield.type", e))?;
        let Some(field_type) = field_type else { continue };
        let field_deleted: i64 = row.get::<_, Option<i64>>(13)
            .map_err(|e| query_error("read itemfield.deleted", e))?
            .unwrap_or(0);
        if field_deleted != 0 {
            continue; // a removed field is not part of the item
        }
        let sensitive: i64 = row.get::<_, Option<i64>>(12)
            .map_err(|e| query_error("read itemfield.sensitive", e))?
            .unwrap_or(0);
        let raw_value: Option<String> =
            row.get(10).map_err(|e| query_error("read itemfield.value", e))?;

        let value = if field_type == FIELD_TYPE_PASSWORD {
            // Password fields are GCM-encrypted under the per-item key.
            let item_key: Option<Vec<u8>> =
                row.get(8).map_err(|e| query_error("read item.key", e))?;
            decrypt_password_field(&uuid, raw_value.as_deref(), item_key.as_deref())
        } else {
            // Every other field type is cleartext after SQLCipher.
            non_empty(raw_value.as_deref())
        };

        entry.fields.push(EnpassField {
            label: label.unwrap_or_default(),
            value,
            field_type,
            sensitive: sensitive != 0,
        });
    }

    Ok(order.into_iter().filter_map(|uuid| map.remove(&uuid)).collect())
}

/// Decrypt one `password` field: `value` = hex(ciphertext‖16-byte tag), key =
/// `item.key` (32-byte AES key ‖ 12-byte nonce), AAD = item UUID without dashes.
/// Returns `None` (rather than erroring the whole read) when the field/key was
/// cleared by an Enpass delete or fails to authenticate — a single corrupt field
/// must not blank the entire vault list. The failure is logged (never the value).
fn decrypt_password_field(uuid: &str, value: Option<&str>, item_key: Option<&[u8]>) -> Option<String> {
    let value = non_empty(value)?;
    let item_key = item_key?;
    // 32-byte key + 12-byte nonce.
    if item_key.len() < 44 {
        log::warn!("Enpass item has a malformed per-item key; password field skipped");
        return None;
    }
    let (key_bytes, nonce_bytes) = item_key.split_at(32);
    let ciphertext = match decode_hex(&value) {
        Ok(bytes) => bytes,
        Err(_) => {
            log::warn!("Enpass password field is not valid hex; skipped");
            return None;
        }
    };
    let aad = match decode_hex(&uuid.replace('-', "")) {
        Ok(bytes) => bytes,
        Err(_) => {
            log::warn!("Enpass item UUID is not valid hex; password field skipped");
            return None;
        }
    };
    let cipher = match Aes256Gcm::new_from_slice(key_bytes) {
        Ok(c) => c,
        Err(_) => {
            log::warn!("Enpass per-item key has the wrong length; password field skipped");
            return None;
        }
    };
    let nonce_arr: [u8; 12] = match nonce_bytes[..12].try_into() {
        Ok(arr) => arr,
        Err(_) => return None, // unreachable: item_key.len() >= 44 checked above
    };
    match cipher.decrypt(&Nonce::from(nonce_arr), Payload { msg: &ciphertext, aad: &aad }) {
        Ok(plaintext) => match String::from_utf8(plaintext) {
            Ok(s) => non_empty(Some(&s)),
            Err(_) => {
                log::warn!("Enpass decrypted password is not valid UTF-8; skipped");
                None
            }
        },
        Err(_) => {
            log::warn!("Enpass password field failed authentication; skipped");
            None
        }
    }
}

/// Read item→folder membership (first folder wins) when the `folder_items` table
/// exists. Absent in older vaults → empty map (items get `folder_id = None`).
fn read_folder_membership(conn: &Connection) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Ok(mut stmt) = conn.prepare("SELECT item_uuid, folder_uuid FROM folder_items") else {
        return out;
    };
    let Ok(mut rows) = stmt.query([]) else { return out };
    while let Ok(Some(row)) = rows.next() {
        let item_uuid: Result<String, _> = row.get(0);
        let folder_uuid: Result<String, _> = row.get(1);
        if let (Ok(item_uuid), Ok(folder_uuid)) = (item_uuid, folder_uuid) {
            out.entry(item_uuid).or_insert(folder_uuid);
        }
    }
    out
}

/// Read folders when the `folder` table exists; absent → empty.
fn read_folders(conn: &Connection) -> Vec<EnpassFolder> {
    let mut out = Vec::new();
    let Ok(mut stmt) = conn.prepare("SELECT uuid, title FROM folder") else {
        return out;
    };
    let Ok(mut rows) = stmt.query([]) else { return out };
    while let Ok(Some(row)) = rows.next() {
        let uuid: Result<String, _> = row.get(0);
        let title: Result<Option<String>, _> = row.get(1);
        if let (Ok(uuid), Ok(title)) = (uuid, title) {
            out.push(EnpassFolder { uuid, title: title.unwrap_or_default() });
        }
    }
    out
}

// ── pure helpers ─────────────────────────────────────────────────────────────

/// Normalize a path to the vault *folder*: if the caller passed the
/// `vault.enpassdb` file (or any file), use its parent directory.
fn vault_folder(path: &Path) -> PathBuf {
    if path.is_file() || path.file_name().is_some_and(|n| n == VAULT_DB_FILE) {
        path.parent().map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from("."))
    } else {
        path.to_path_buf()
    }
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|v| !v.is_empty()).map(str::to_string)
}

/// Enpass timestamps are Unix seconds; render RFC 3339 (missing/zero → epoch so
/// the DTO's non-optional dates stay valid).
fn rfc3339(secs: Option<i64>) -> String {
    let secs = secs.filter(|s| *s > 0).unwrap_or(0);
    Utc.timestamp_opt(secs, 0)
        .single()
        .unwrap_or_else(|| Utc.timestamp_opt(0, 0).single().unwrap_or_default())
        .to_rfc3339()
}

/// Hex-encode bytes. Used only by the test encryptor/fixtures now that the raw
/// SQLCipher key is consumed as bytes (no more `PRAGMA key = "x'<hex>'"`).
#[cfg(test)]
fn encode_hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        use std::fmt::Write;
        // ignore: writing to a String never fails.
        let _ = write!(s, "{b:02x}");
    }
    s
}

fn decode_hex(s: &str) -> Result<Vec<u8>, ()> {
    let s = s.trim();
    if s.len() % 2 != 0 {
        return Err(());
    }
    let mut out = Vec::with_capacity(s.len() / 2);
    let bytes = s.as_bytes();
    for pair in bytes.chunks_exact(2) {
        let hi = hex_val(pair[0]).ok_or(())?;
        let lo = hex_val(pair[1]).ok_or(())?;
        out.push((hi << 4) | lo);
    }
    Ok(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

fn query_error(context: &str, e: rusqlite::Error) -> AgateError {
    AgateError::new(ErrorKind::Internal, format!("Enpass {context} failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    use aes_gcm::aead::Aead;
    // `KeyIvInit` / `BlockDecryptMut` are already in scope via `super::*`; the
    // encryptor additionally needs the encrypt trait and the no-padding marker.
    use cbc::cipher::block_padding::NoPadding;
    use cbc::cipher::BlockEncryptMut;
    use hmac::{Hmac, Mac};
    use rand::RngCore;
    use sha1::Sha1;
    use sha2::Sha512;

    const PASSWORD: &str = "test-master-password";
    const OTPAUTH: &str =
        "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";
    const KDF_ITER: u32 = 2_000; // small so tests stay fast (real vaults use 100k)

    /// A fully-built fixture vault folder. `_dir` holds the tempdir alive.
    struct Fixture {
        _dir: tempfile::TempDir,
        folder: PathBuf,
        github_uuid: String,
        note_uuid: String,
        trashed_uuid: String,
        folder_uuid: String,
    }

    /// GCM-encrypt a password value the way Enpass does and return
    /// (hex(ciphertext‖tag), key‖nonce blob).
    fn encrypt_password(uuid: &str, plaintext: &str) -> (String, Vec<u8>) {
        let mut key = [0u8; 32];
        let mut nonce = [0u8; 12];
        rand::thread_rng().fill_bytes(&mut key);
        rand::thread_rng().fill_bytes(&mut nonce);
        let cipher = Aes256Gcm::new_from_slice(&key).unwrap();
        let aad = decode_hex(&uuid.replace('-', "")).unwrap();
        let ct = cipher
            .encrypt(
                &Nonce::from(nonce),
                aead::Payload { msg: plaintext.as_bytes(), aad: &aad },
            )
            .unwrap();
        let mut blob = key.to_vec();
        blob.extend_from_slice(&nonce);
        (encode_hex(&ct), blob)
    }

    // bring the Payload type into scope for the helper above
    use aes_gcm::aead;

    /// Pure-Rust SQLCipher **encryptor** — the exact inverse of
    /// `sqlcipher_decrypt`: AES-256-CBC encrypt each page, append `IV ‖ HMAC`, and
    /// (for page 1) replace the leading SQLite header with the salt. Used only by
    /// tests, since no SQLCipher is available to build fixtures.
    ///
    /// `plaintext_db` must be a valid plaintext SQLite file whose page size and
    /// reserved-bytes-per-page already match the chosen `compat` level (i.e. SQLite
    /// header byte 16-17 = page_size, byte 20 = reserve). `raw_key`/`salt` are the
    /// same values `derive_key` would produce / `sqlcipher_decrypt` would read.
    fn sqlcipher_encrypt(
        plaintext_db: &[u8],
        raw_key: &[u8; SQLCIPHER_KEY_LEN],
        salt: &[u8; SALT_LEN],
        compat: CipherCompat,
    ) -> Vec<u8> {
        let page_size = compat.page_size();
        let reserve = compat.reserve();
        let hmac_len = compat.hmac_len();
        assert_eq!(plaintext_db.len() % page_size, 0, "plaintext must be whole pages");

        // HMAC subkey, identical to the decrypt path.
        let masked: [u8; SALT_LEN] = std::array::from_fn(|i| salt[i] ^ HMAC_SALT_MASK);
        let subkey = derive_hmac_subkey(raw_key, &masked, compat).unwrap();

        let page_count = plaintext_db.len() / page_size;
        let mut out = Vec::with_capacity(plaintext_db.len());

        for pgno_zero in 0..page_count {
            let pgno = (pgno_zero + 1) as u32;
            let page = &plaintext_db[pgno_zero * page_size..(pgno_zero + 1) * page_size];
            let off = if pgno == 1 { SALT_LEN } else { 0 };
            // The body SQLite stores (excluding the page-1 header and the reserved tail).
            let body = &page[off..page_size - reserve];

            // Random IV per page (matches SQLCipher).
            let mut iv = [0u8; IV_LEN];
            rand::thread_rng().fill_bytes(&mut iv);

            // AES-256-CBC encrypt the body (whole blocks, no padding added).
            assert_eq!(body.len() % AES_BLOCK_LEN, 0, "body must be block-aligned");
            let enc = cbc::Encryptor::<Aes256>::new_from_slices(raw_key, &iv).unwrap();
            let mut ct = vec![0u8; body.len()];
            enc.encrypt_padded_b2b_mut::<NoPadding>(body, &mut ct).unwrap();

            // HMAC over (ciphertext ‖ IV ‖ pgno_le32).
            let hmac = page_hmac(&subkey, &ct, &iv, pgno, compat);
            assert_eq!(hmac.len(), hmac_len);

            // Page on disk: [page-1: salt] ‖ ciphertext ‖ IV ‖ HMAC ‖ zero pad to page_size.
            if pgno == 1 {
                out.extend_from_slice(salt);
            }
            out.extend_from_slice(&ct);
            out.extend_from_slice(&iv);
            out.extend_from_slice(&hmac);
            // Pad the reserved tail out to page_size (IV+HMAC may be shorter than reserve).
            let written = ct.len() + IV_LEN + hmac_len + off;
            out.resize(out.len() + (page_size - written), 0u8);
        }
        assert_eq!(out.len(), plaintext_db.len());
        out
    }

    /// HMAC of (ciphertext ‖ IV ‖ pgno_le32) under the page subkey — the value the
    /// decryptor recomputes and compares.
    fn page_hmac(
        subkey: &[u8; 32],
        ct: &[u8],
        iv: &[u8],
        pgno: u32,
        compat: CipherCompat,
    ) -> Vec<u8> {
        match compat {
            CipherCompat::V4 => {
                let mut mac = <Hmac<Sha512> as hmac::Mac>::new_from_slice(subkey).unwrap();
                mac.update(ct);
                mac.update(iv);
                mac.update(&pgno.to_le_bytes());
                mac.finalize().into_bytes().to_vec()
            }
            CipherCompat::V3 => {
                let mut mac = <Hmac<Sha1> as hmac::Mac>::new_from_slice(subkey).unwrap();
                mac.update(ct);
                mac.update(iv);
                mac.update(&pgno.to_le_bytes());
                mac.finalize().into_bytes().to_vec()
            }
        }
    }

    /// Derive the raw key the way `derive_key` would, over a known salt (no keyfile).
    fn raw_key_for(salt: &[u8; SALT_LEN], password: &str, kdf_iter: u32) -> [u8; SQLCIPHER_KEY_LEN] {
        let mut block = [0u8; 64];
        pbkdf2::pbkdf2::<Hmac<Sha512>>(password.as_bytes(), salt, kdf_iter, &mut block).unwrap();
        let mut key = [0u8; SQLCIPHER_KEY_LEN];
        key.copy_from_slice(&block[..SQLCIPHER_KEY_LEN]);
        key
    }

    /// Build a *plaintext* SQLite database (plain bundled rusqlite) whose on-disk
    /// geometry matches the chosen compat level — the right page size AND the right
    /// per-page reserved bytes — then fill it with `build` and return its raw bytes.
    ///
    /// Matching the reserved-bytes-per-page is essential: SQLCipher carves the
    /// IV+HMAC tail out of each page, so a faithfully-decrypted page is a SQLite
    /// page with `reserve` unused trailing bytes. We set that via SQLite's
    /// `SQLITE_FCNTL_RESERVE_BYTES` file control *before any page is written*, so
    /// SQLite never lays cell content into the reserved tail (it stays zero — which
    /// is exactly what `sqlcipher_decrypt` zero-fills back). Patching header byte 20
    /// after the fact does NOT work: SQLite then sees the existing pages as
    /// malformed.
    fn build_plaintext_db(compat: CipherCompat, build: impl FnOnce(&Connection)) -> Vec<u8> {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plain.sqlite");
        {
            let conn = Connection::open(&path).unwrap();
            // Page size first (must precede any write that fixes the geometry).
            conn.pragma_update(None, "page_size", compat.page_size() as i64).unwrap();
            conn.pragma_update(None, "journal_mode", "DELETE").unwrap();
            set_reserved_bytes(&conn, compat.reserve());
            build(&conn);
            // VACUUM rewrites every page under the new geometry, so the reserved
            // tail of each page is genuinely unused.
            conn.execute_batch("VACUUM").unwrap();
        }
        std::fs::read(&path).unwrap()
    }

    /// Ask SQLite (via the raw FFI handle) to reserve `reserve` bytes at the end of
    /// every page. Must be called on a fresh connection before the first page is
    /// written; SQLite then uses `usable_size = page_size - reserve` for all writes.
    fn set_reserved_bytes(conn: &Connection, reserve: usize) {
        use rusqlite::ffi;
        use std::ffi::c_void;
        let mut n: std::os::raw::c_int = reserve as std::os::raw::c_int;
        // SAFETY: `handle()` returns this connection's live `sqlite3*`; the "main"
        // schema name is a valid NUL-terminated C string; `&mut n` outlives the call
        // and matches the `int*` the RESERVE_BYTES file control expects.
        let rc = unsafe {
            ffi::sqlite3_file_control(
                conn.handle(),
                c"main".as_ptr(),
                ffi::SQLITE_FCNTL_RESERVE_BYTES,
                &mut n as *mut std::os::raw::c_int as *mut c_void,
            )
        };
        assert_eq!(rc, ffi::SQLITE_OK, "SQLITE_FCNTL_RESERVE_BYTES failed (rc={rc})");
    }

    /// Build the encrypted Enpass-shaped vault: a plaintext SQLite DB with the
    /// `item`/`itemfield`/`folder`/`folder_items` tables, encrypted to SQLCipher v4
    /// with a key derived exactly like `derive_key`.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_path_buf();
        let db_path = folder.join(VAULT_DB_FILE);

        // vault.json with our small kdf_iter
        std::fs::write(
            folder.join(VAULT_INFO_FILE),
            format!(
                "{{\"encryption_algo\":\"aes-256-cbc\",\"kdf_algo\":\"pbkdf2\",\
                  \"kdf_iter\":{KDF_ITER},\"have_keyfile\":0,\"version\":6,\
                  \"vault_name\":\"Test\"}}"
            ),
        )
        .unwrap();

        // Fixed 16-byte salt we control (the file's first 16 bytes on disk).
        let salt: [u8; SALT_LEN] = *b"0123456789abcdef";
        let raw_key = raw_key_for(&salt, PASSWORD, KDF_ITER);

        let github_uuid = "a2ec30c0-aeed-41f7-aed7-cc50e69ff506".to_string();
        let note_uuid = "b3fd41d1-bffe-52a8-bfe8-dd61f70aa617".to_string();
        let trashed_uuid = "c4ae52e2-c00f-63b9-c0f9-ee72a81bb728".to_string();
        let folder_uuid = "d5bf63f3-d110-74ca-d10a-ff83b92cc839".to_string();

        let (gh_pw_value, gh_key) = encrypt_password(&github_uuid, "hunter2");
        let (tr_pw_value, tr_key) = encrypt_password(&trashed_uuid, "old-pass");

        let github_uuid_c = github_uuid.clone();
        let note_uuid_c = note_uuid.clone();
        let trashed_uuid_c = trashed_uuid.clone();
        let folder_uuid_c = folder_uuid.clone();

        // Build the plaintext DB, then encrypt it to a real SQLCipher v4 file.
        let plaintext = build_plaintext_db(CipherCompat::V4, |conn| {
            conn.execute_batch(
                "CREATE TABLE item(ID INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT UNIQUE NOT NULL, \
                   created_at INTEGER, meta_updated_at INTEGER, field_updated_at INTEGER, \
                   title TEXT, subtitle TEXT, note TEXT, icon TEXT, favorite INTEGER DEFAULT 0, \
                   trashed INTEGER DEFAULT 0, archived INTEGER DEFAULT 0, deleted INTEGER DEFAULT 0, \
                   auto_submit INTEGER DEFAULT 1, form_data TEXT DEFAULT '', category TEXT, \
                   template TEXT, wearable INTEGER DEFAULT 0, usage_count INTEGER DEFAULT 0, \
                   last_used INTEGER, key BLOB, extra TEXT DEFAULT '', updated_at INTEGER DEFAULT 0); \
                 CREATE TABLE itemfield(ID INTEGER PRIMARY KEY AUTOINCREMENT, item_uuid TEXT, \
                   item_field_uid INTEGER, label TEXT, value TEXT, deleted INTEGER, sensitive INTEGER, \
                   historical INTEGER, type TEXT, form_id TEXT, updated_at INTEGER, \
                   value_updated_at INTEGER, orde INTEGER, wearable INTEGER, history TEXT, \
                   initial TEXT, hash TEXT, strength INTEGER DEFAULT -1, algo_version INTEGER DEFAULT 0, \
                   expiry INTEGER DEFAULT 0, excluded INTEGER DEFAULT 0, pwned_check_time INTEGER DEFAULT 0, \
                   extra TEXT DEFAULT ''); \
                 CREATE TABLE folder(ID INTEGER PRIMARY KEY AUTOINCREMENT, uuid TEXT, title TEXT); \
                 CREATE TABLE folder_items(folder_uuid TEXT, item_uuid TEXT);",
            )
            .unwrap();

            // folder + membership
            conn.execute(
                "INSERT INTO folder(uuid, title) VALUES (?1, ?2)",
                rusqlite::params![folder_uuid_c, "Work"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO folder_items(folder_uuid, item_uuid) VALUES (?1, ?2)",
                rusqlite::params![folder_uuid_c, github_uuid_c],
            )
            .unwrap();

            // GitHub login: username/password/url/totp + a sensitive + a plain
            // custom field, favorite, in the Work folder.
            conn.execute(
                "INSERT INTO item(uuid, title, note, favorite, trashed, deleted, created_at, field_updated_at, key, category) \
                 VALUES (?1, ?2, ?3, 1, 0, 0, 1700000000, 1700000500, ?4, 'login')",
                rusqlite::params![github_uuid_c, "GitHub", "main account", gh_key],
            )
            .unwrap();
            let gh_fields: &[(&str, &str, &str, i64, i64)] = &[
                // (label, value, type, sensitive, orde)
                ("Username", "octocat", FIELD_TYPE_USERNAME, 0, 1),
                ("Password", gh_pw_value.as_str(), FIELD_TYPE_PASSWORD, 1, 2),
                ("Website", "https://github.com/login", FIELD_TYPE_URL, 0, 3),
                ("One-time code", OTPAUTH, FIELD_TYPE_TOTP, 1, 4),
                ("API Key", "secret-api-key", "text", 1, 5),
                ("Plan", "pro", "text", 0, 6),
                ("Section", "", FIELD_TYPE_SECTION, 0, 0),
            ];
            for (i, (label, value, ty, sensitive, orde)) in gh_fields.iter().enumerate() {
                conn.execute(
                    "INSERT INTO itemfield(item_uuid, item_field_uid, label, value, deleted, sensitive, type, orde) \
                     VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6, ?7)",
                    rusqlite::params![github_uuid_c, i as i64, label, value, sensitive, ty, orde],
                )
                .unwrap();
            }

            // A secure note: only a note, no login-shaped fields.
            conn.execute(
                "INSERT INTO item(uuid, title, note, favorite, trashed, deleted, created_at, field_updated_at, category) \
                 VALUES (?1, ?2, ?3, 0, 0, 0, 1700000000, 1700000000, 'note')",
                rusqlite::params![note_uuid_c, "Backup codes", "1234 5678"],
            )
            .unwrap();

            // A trashed login (trashed != 0).
            conn.execute(
                "INSERT INTO item(uuid, title, favorite, trashed, deleted, created_at, field_updated_at, key, category) \
                 VALUES (?1, ?2, 0, 1, 0, 1700000000, 1700000000, ?3, 'login')",
                rusqlite::params![trashed_uuid_c, "Old account", tr_key],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO itemfield(item_uuid, item_field_uid, label, value, deleted, sensitive, type, orde) \
                 VALUES (?1, 0, 'Password', ?2, 0, 1, 'password', 1)",
                rusqlite::params![trashed_uuid_c, tr_pw_value],
            )
            .unwrap();
        });

        // Encrypt the plaintext DB to a real SQLCipher v4 file and write it.
        let encrypted = sqlcipher_encrypt(&plaintext, &raw_key, &salt, CipherCompat::V4);
        std::fs::write(&db_path, &encrypted).unwrap();

        Fixture { _dir: dir, folder, github_uuid, note_uuid, trashed_uuid, folder_uuid }
    }

    fn open_conn(folder: &Path) -> EnpassConnection {
        EnpassConnection::open(folder, PASSWORD, None).unwrap()
    }

    // ── open ──────────────────────────────────────────────────────────────────

    #[test]
    fn open_with_wrong_password_is_invalid_credentials() {
        let fx = fixture();
        let err = EnpassConnection::open(&fx.folder, "wrong-password", None).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::InvalidCredentials), "got: {err}");
        // right password opens
        assert!(EnpassConnection::open(&fx.folder, PASSWORD, None).is_ok());
    }

    #[test]
    fn open_accepts_the_db_file_path_too() {
        let fx = fixture();
        let db = fx.folder.join(VAULT_DB_FILE);
        assert!(EnpassConnection::open(&db, PASSWORD, None).is_ok());
    }

    #[test]
    fn open_missing_vault_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let err = EnpassConnection::open(dir.path(), PASSWORD, None).unwrap_err();
        // No db file → salt read fails → BadRequest.
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }

    // ── reads ─────────────────────────────────────────────────────────────────

    #[test]
    fn list_items_maps_types_favorite_folder_and_trash() {
        let fx = fixture();
        let conn = open_conn(&fx.folder);
        let items = conn.list_items("enp", "Enpass");
        assert_eq!(items.len(), 3);

        let github = items.iter().find(|i| i.id == fx.github_uuid).unwrap();
        assert_eq!(github.name, "GitHub");
        assert_eq!(github.item_type, ItemType::Login);
        assert_eq!(github.username.as_deref(), Some("octocat"));
        assert_eq!(github.uri.as_deref(), Some("https://github.com/login"));
        assert!(github.has_totp);
        assert!(github.favorite);
        assert!(!github.deleted);
        assert_eq!(github.folder_id.as_deref(), Some(fx.folder_uuid.as_str()));

        let note = items.iter().find(|i| i.id == fx.note_uuid).unwrap();
        assert_eq!(note.item_type, ItemType::SecureNote, "no login fields → note");
        assert_eq!(note.username, None);

        let trashed = items.iter().find(|i| i.id == fx.trashed_uuid).unwrap();
        assert!(trashed.deleted, "trashed != 0 maps to deleted");
    }

    #[test]
    fn item_detail_decrypts_password_and_maps_fields() {
        let fx = fixture();
        let conn = open_conn(&fx.folder);
        let detail = conn.item_detail("enp", "Enpass", &fx.github_uuid).unwrap();

        assert_eq!(detail.item_type, ItemType::Login);
        assert_eq!(detail.notes.as_deref(), Some("main account"));
        assert!(detail.favorite);

        let login = detail.login.as_ref().unwrap();
        assert_eq!(login.username.as_deref(), Some("octocat"));
        assert_eq!(login.password.as_deref(), Some("hunter2"), "GCM password decrypted");
        assert_eq!(login.totp.as_deref(), Some(OTPAUTH));
        assert!(login.has_totp);
        assert_eq!(login.uris.len(), 1);
        assert_eq!(login.uris[0].uri.as_deref(), Some("https://github.com/login"));

        // custom fields: the API Key (sensitive → hidden) + Plan (text); the login
        // roles and the section header never leak in.
        let api_key =
            detail.fields.iter().find(|f| f.name.as_deref() == Some("API Key")).unwrap();
        assert_eq!(api_key.value.as_deref(), Some("secret-api-key"));
        assert_eq!(api_key.field_type, CustomFieldType::Hidden);
        let plan = detail.fields.iter().find(|f| f.name.as_deref() == Some("Plan")).unwrap();
        assert_eq!(plan.field_type, CustomFieldType::Text);
        assert!(detail.fields.iter().all(|f| f.name.as_deref() != Some("Password")));
        assert!(detail.fields.iter().all(|f| f.name.as_deref() != Some("Username")));
        assert!(detail.fields.iter().all(|f| f.name.as_deref() != Some("Section")));

        // dates render as parseable RFC 3339
        assert!(chrono::DateTime::parse_from_rfc3339(&detail.revision_date).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&detail.creation_date).is_ok());

        // the note has no login section
        let note = conn.item_detail("enp", "Enpass", &fx.note_uuid).unwrap();
        assert!(note.login.is_none());
        assert_eq!(note.notes.as_deref(), Some("1234 5678"));
    }

    #[test]
    fn item_totp_generates_six_digit_code() {
        let fx = fixture();
        let conn = open_conn(&fx.folder);
        let totp = conn.item_totp(&fx.github_uuid).unwrap();
        assert_eq!(totp.code.len(), 6);
        assert!(totp.code.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(totp.period, 30);
        assert!(totp.remaining >= 1 && totp.remaining <= 30);

        // a note has no otp field → typed error
        let err = conn.item_totp(&fx.note_uuid).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest));
    }

    #[test]
    fn folders_fields_count_and_autofill_views() {
        let fx = fixture();
        let conn = open_conn(&fx.folder);

        let folders = conn.list_folders("enp", "Enpass");
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Work");
        assert_eq!(folders[0].id.as_deref(), Some(fx.folder_uuid.as_str()));

        assert!(conn.list_collections("enp", "Enpass").is_empty());

        let names = conn.custom_field_names();
        assert!(names.contains(&"API Key".to_string()));
        assert!(names.contains(&"Plan".to_string()));
        assert!(!names.contains(&"Password".to_string()));

        // password reuse counts decrypted passwords; the trashed item is excluded.
        assert_eq!(conn.count_password_use("hunter2"), 1);
        assert_eq!(conn.count_password_use("old-pass"), 0, "trashed item excluded");
        assert_eq!(conn.count_password_use("not-used"), 0);
        assert_eq!(conn.count_password_use(""), 0);

        // autofill: logins only, excludes the trashed login and the note.
        let matches = conn.autofill_entries("enp", "Enpass");
        assert_eq!(matches.len(), 1);
        let gh = &matches[0];
        assert_eq!(gh.id, fx.github_uuid);
        assert_eq!(gh.username.as_deref(), Some("octocat"));
        assert_eq!(gh.uris, vec!["https://github.com/login".to_string()]);
    }

    // ── unit helpers ───────────────────────────────────────────────────────────

    #[test]
    fn hex_roundtrip() {
        let bytes = [0x00u8, 0x0f, 0xa5, 0xff, 0x10];
        let hex = encode_hex(&bytes);
        assert_eq!(hex, "000fa5ff10");
        assert_eq!(decode_hex(&hex).unwrap(), bytes);
        assert!(decode_hex("xyz").is_err());
        assert!(decode_hex("abc").is_err(), "odd length is rejected");
    }

    #[test]
    fn parse_kdf_iter_reads_value_or_none() {
        assert_eq!(parse_kdf_iter(br#"{"kdf_iter":100000}"#), Some(100_000));
        assert_eq!(parse_kdf_iter(br#"{"other":1}"#), None);
        assert_eq!(parse_kdf_iter(br#"{"kdf_iter":0}"#), None);
        assert_eq!(parse_kdf_iter(b"not json"), None);
    }

    #[test]
    fn extract_keyfile_hex_handles_xml_and_bare() {
        assert_eq!(
            extract_keyfile_hex("<Key>00 11 22</Key>").as_deref(),
            Some("001122")
        );
        assert_eq!(extract_keyfile_hex("  aabbcc  ").as_deref(), Some("aabbcc"));
        assert_eq!(extract_keyfile_hex("   "), None);
    }

    // ── pure-Rust SQLCipher codec self-consistency ─────────────────────────────

    /// Build a small plaintext SQLite DB at the level's geometry, encrypt it to
    /// SQLCipher with the test encryptor, decrypt with the production decoder, and
    /// assert byte-for-byte equality + that the result reopens as plain SQLite.
    fn codec_roundtrip(compat: CipherCompat) {
        let salt: [u8; SALT_LEN] = *b"fedcba9876543210";
        let raw_key = raw_key_for(&salt, PASSWORD, KDF_ITER);

        // A plaintext DB big enough to span several pages (so non-page-1 paths run).
        let plaintext = build_plaintext_db(compat, |conn| {
            conn.execute_batch("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)").unwrap();
            for i in 0..40i64 {
                conn.execute(
                    "INSERT INTO t(id, v) VALUES (?1, ?2)",
                    rusqlite::params![i, format!("row-{i}-{}", "x".repeat(30))],
                )
                .unwrap();
            }
        });
        assert!(plaintext.len() >= compat.page_size() * 2, "fixture should span pages");

        let encrypted = sqlcipher_encrypt(&plaintext, &raw_key, &salt, compat);

        // Decode with the production codec and compare exactly.
        let decoded = sqlcipher_decrypt(&encrypted, &raw_key).unwrap();
        assert_eq!(&decoded[..], &plaintext[..], "{compat:?}: decode != plaintext");

        // The decoded bytes must open + read as a real SQLite database.
        let mut tmp = tempfile::NamedTempFile::new().unwrap();
        std::io::Write::write_all(&mut tmp, &decoded).unwrap();
        let conn =
            Connection::open_with_flags(tmp.path(), OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let ic: String = conn.query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap();
        assert_eq!(ic, "ok", "{compat:?}: integrity_check");
        let n: i64 = conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 40);

        // A wrong key fails page-1 HMAC for every level → InvalidCredentials.
        let wrong = raw_key_for(&salt, "totally-wrong", KDF_ITER);
        let err = sqlcipher_decrypt(&encrypted, &wrong).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::InvalidCredentials), "{compat:?}: got {err}");
    }

    #[test]
    fn sqlcipher_codec_roundtrips_v4() {
        codec_roundtrip(CipherCompat::V4);
    }

    #[test]
    fn sqlcipher_codec_roundtrips_v3() {
        codec_roundtrip(CipherCompat::V3);
    }

    #[test]
    fn reserve_sizes_match_spec() {
        // v4 = align_up(16 + 64, 16) = 80; v3 = align_up(16 + 20, 16) = 48.
        assert_eq!(CipherCompat::V4.reserve(), 80);
        assert_eq!(CipherCompat::V3.reserve(), 48);
        assert_eq!(CipherCompat::V4.page_size(), 4096);
        assert_eq!(CipherCompat::V3.page_size(), 1024);
    }

    #[test]
    fn decrypt_rejects_non_page_aligned_input() {
        // A buffer that is not a whole number of pages at either geometry is a wrong
        // password (no level applies), never a panic.
        let raw_key = raw_key_for(b"0123456789abcdef", PASSWORD, KDF_ITER);
        let junk = vec![0u8; 100];
        let err = sqlcipher_decrypt(&junk, &raw_key).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::InvalidCredentials), "got {err}");
    }
}
