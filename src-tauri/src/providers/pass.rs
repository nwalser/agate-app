//! The `pass` provider: the standard unix password store
//! (<https://www.passwordstore.org/>) — a directory tree of OpenPGP-encrypted
//! `*.gpg` files under a store root (default `~/.password-store`).
//!
//! Unlike KeePass (one decrypted database held in memory) a pass store is many
//! small files, each individually encrypted to the store's recipients. So a
//! `PassConnection` holds the store root + the user's OpenPGP secret key (a
//! `Cert`, read once from an exported key file) and decrypts each entry on
//! demand. The key material is zeroized on drop.
//!
//! ## GPG backend choice — pure-Rust OpenPGP (sequoia-openpgp)
//! Agate seals a per-connection secret under the VMK and re-opens every vault on
//! app unlock WITHOUT prompting the user (see `appunlock::finish_unlock`). That
//! rules out shelling out to the system `gpg`: gpg-agent would prompt for the
//! passphrase (breaking silent restart-unlock), the binary path is unreliable on
//! Windows, and it is near-impossible to unit-test. We therefore use
//! `sequoia-openpgp` and hold the user's EXPORTED secret key:
//! - store root dir   → the `path`-style field
//! - secret-key file  → the `keyfile`-style field
//! - key passphrase   → the `master_password`-style field (sealed like KeePass's
//!   database password; empty string = an unencrypted exported key)
//!
//! This is testable end-to-end (we generate a `Cert` in-memory in the tests,
//! encrypt fixture entries to it, and decrypt them back), cross-platform, and
//! fits the seal + restart-unlock model. The cost: the user must export their
//! GPG secret key once, and gpg-agent / smartcards are not used.
//!
//! ## Mapping conventions (Bitwarden-shaped DTOs ← pass)
//! - item id = the entry's store-relative path WITHOUT `.gpg`, using '/'
//!   separators on every platform (e.g. `web/github.com`). It is stable and
//!   human-meaningful, and doubles as the title source.
//! - The decrypted plaintext follows the pass convention: the FIRST line is the
//!   password; the remaining lines are freeform, conventionally `key: value`
//!   metadata. We map `login:` / `user:` / `username:` → username, `url:` /
//!   `website:` → uri, an `otpauth://…` line (the `pass-otp` convention) → totp,
//!   `title:` → the display name. Every other recognis­able `key: value` line
//!   becomes a custom field; lines that are not `key: value` are collected into
//!   the notes body.
//! - folder id = folder name = the directory path relative to the store root
//!   ('/'-joined), exactly like KeePass groups. The store root is never listed.
//! - An entry is a `Login` when it has a username, a url, or a totp; otherwise a
//!   `SecureNote`. pass has no collections, no favorites, and no trash.
//!
//! ## Writes — READ-ONLY in this provider (deliberately, for now)
//! Writing a pass entry safely means re-encrypting to EVERY recipient key listed
//! in the relevant `.gpg-id` file (pass supports per-subdirectory `.gpg-id` and
//! optional `.gpg-id` signatures), then an atomic temp→rename — and Agate only
//! holds ONE secret key, so we cannot in general round-trip the full recipient
//! set without importing the public keyring. Shipping a write that silently
//! drops recipients (locking other store users / the user's other devices out of
//! that entry) would violate "writes must never destroy data". So this provider
//! is read-only; `save_item` and friends are intentionally absent. See the
//! integration spec for what a future read-write version needs.
//!
//! ## Blocking
//! `open` and every read decrypts with the RustCrypto backend (CPU-bound) and
//! touches the filesystem — callers wrap them in `spawn_blocking`, exactly like
//! the KeePass provider.

use std::io::Read;
use std::path::{Path, PathBuf};

use chrono::Utc;
use sequoia_openpgp::cert::Cert;
use sequoia_openpgp::crypto::SessionKey;
use sequoia_openpgp::packet::key::{SecretParts, UnspecifiedRole};
use sequoia_openpgp::packet::{Key, PKESK, SKESK};
use sequoia_openpgp::parse::stream::{
    DecryptionHelper, DecryptorBuilder, MessageStructure, VerificationHelper,
};
use sequoia_openpgp::parse::Parse;
use sequoia_openpgp::policy::StandardPolicy;
use sequoia_openpgp::types::SymmetricAlgorithm;
use sequoia_openpgp::KeyHandle;
use zeroize::Zeroizing;

use crate::dto::{
    Collection, CustomField, CustomFieldType, Folder, ItemDetail, ItemType, LoginDetail, LoginUri,
    TotpCode, VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Metadata-line keys (case-insensitive) that map to a login's username.
const USERNAME_KEYS: [&str; 3] = ["login", "user", "username"];
/// Metadata-line keys (case-insensitive) that map to a login's primary URI.
const URL_KEYS: [&str; 2] = ["url", "website"];
/// Metadata-line key (case-insensitive) overriding the display title.
const TITLE_KEY: &str = "title";

/// One live, unlocked pass store: the store root, the decrypted OpenPGP secret
/// key (zeroized on drop via `Zeroizing` around the serialized cert), and the
/// passphrase used to unlock encrypted secret-key packets on each decrypt.
pub struct PassConnection {
    /// Absolute path to the store root (the directory containing `*.gpg` files).
    root: PathBuf,
    /// The user's OpenPGP certificate WITH secret key material. Held in memory
    /// for the life of the connection so each entry can be decrypted on demand.
    cert: Cert,
    /// Passphrase protecting the secret-key packets (empty when the exported key
    /// is unencrypted). Zeroized on drop.
    passphrase: Zeroizing<String>,
}

/// Redacted: never prints key material or vault contents.
impl std::fmt::Debug for PassConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PassConnection")
            .field("root", &self.root)
            .field("fingerprint", &self.cert.fingerprint())
            .finish_non_exhaustive()
    }
}

// ── lifecycle (open) ─────────────────────────────────────────────────────────
impl PassConnection {
    /// Open + verify a pass store. Reads the exported secret key, then decrypts
    /// the FIRST entry it can find to confirm the key + passphrase actually work
    /// (mirroring KeePass's "decrypt to prove the key" open). An empty store
    /// opens successfully (nothing to prove against).
    ///
    /// Blocking (RustCrypto decrypt + file I/O) — callers wrap in `spawn_blocking`.
    pub fn open(root: &Path, key_file: &Path, passphrase: &str) -> AgateResult<Self> {
        let key_bytes = Zeroizing::new(std::fs::read(key_file).map_err(|e| {
            AgateError::bad_request(format!("Could not read the OpenPGP secret key file: {e}"))
        })?);
        let cert = Cert::from_bytes(key_bytes.as_slice()).map_err(|e| {
            AgateError::bad_request(format!("Not a valid OpenPGP secret key: {e}"))
        })?;
        if !cert.is_tsk() {
            return Err(AgateError::bad_request(
                "That OpenPGP key has no secret part — export the SECRET key (e.g. `gpg --export-secret-keys --armor`).",
            ));
        }
        if !root.is_dir() {
            return Err(AgateError::bad_request(
                "The password-store path is not a directory.",
            ));
        }
        let conn = Self {
            root: root.to_path_buf(),
            cert,
            passphrase: Zeroizing::new(passphrase.to_string()),
        };
        // Prove the key works against the actual store: decrypt the first entry.
        if let Some(first) = conn.entry_paths().into_iter().next() {
            conn.decrypt_entry(&first)?;
        }
        Ok(conn)
    }
}

// ── read surface (mirrors KeepassConnection / BitwardenConnection) ────────────
impl PassConnection {
    /// All entries as unified list rows, stamped with the connection id + label.
    /// An entry that fails to decrypt is logged and skipped — one bad file never
    /// breaks the whole list (mirrors the Bitwarden provider's decrypt-skip).
    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        let mut out = Vec::new();
        for path in self.entry_paths() {
            let rel = match self.entry_id(&path) {
                Some(rel) => rel,
                None => continue,
            };
            let parsed = match self.decrypt_entry(&path) {
                Ok(plaintext) => ParsedEntry::parse(&rel, &plaintext),
                Err(e) => {
                    log::warn!("pass: skipping an entry that could not be decrypted: {}", e.message);
                    continue;
                }
            };
            let item_type = parsed.item_type();
            let has_totp = parsed.totp.is_some();
            out.push(VaultItem {
                id: rel.clone(),
                account_email: id.to_string(),
                account_label: label.to_string(),
                name: parsed.title,
                item_type,
                username: parsed.username,
                uri: parsed.url,
                has_totp,
                has_passkey: false,
                reprompt: false,
                favorite: false,
                deleted: false,
                folder_id: folder_of(&rel),
                organization_id: None,
            });
        }
        out.sort_by(|a, b| a.id.cmp(&b.id));
        out
    }

    /// Per-login match entries for the autofill index.
    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        let mut out = Vec::new();
        for path in self.entry_paths() {
            let rel = match self.entry_id(&path) {
                Some(rel) => rel,
                None => continue,
            };
            let parsed = match self.decrypt_entry(&path) {
                Ok(plaintext) => ParsedEntry::parse(&rel, &plaintext),
                Err(e) => {
                    log::warn!("pass: skipping an entry in the autofill index: {}", e.message);
                    continue;
                }
            };
            if parsed.item_type() != ItemType::Login {
                continue;
            }
            // The entry name often IS the host (`web/github.com`), so include the
            // last path segment as a match URI too, not just an explicit `url:`.
            let mut uris: Vec<String> = parsed.url.clone().into_iter().collect();
            if let Some(leaf) = rel.rsplit('/').next() {
                if !leaf.is_empty() && !uris.iter().any(|u| u == leaf) {
                    uris.push(leaf.to_string());
                }
            }
            out.push(crate::autofill::MatchItem {
                id: rel.clone(),
                account_email: id.to_string(),
                account_label: label.to_string(),
                name: parsed.title,
                username: parsed.username,
                uris,
                reprompt: false,
            });
        }
        out
    }

    /// Names of every recognised custom field across the store (names only —
    /// values are never read into the result). Sorted + de-duplicated.
    pub fn custom_field_names(&self) -> Vec<String> {
        let mut names: Vec<String> = Vec::new();
        for path in self.entry_paths() {
            let rel = match self.entry_id(&path) {
                Some(rel) => rel,
                None => continue,
            };
            let plaintext = match self.decrypt_entry(&path) {
                Ok(p) => p,
                Err(_) => continue, // names only; a bad entry contributes nothing
            };
            let parsed = ParsedEntry::parse(&rel, &plaintext);
            for field in &parsed.fields {
                if !names.contains(&field.0) {
                    names.push(field.0.clone());
                }
            }
        }
        names.sort();
        names
    }

    /// One entry as full detail (login fields, notes, custom fields). pass stores
    /// no creation/modification times in the ciphertext, so we surface the
    /// file's mtime/ctime as the revision/creation dates (best-effort: the epoch
    /// when the filesystem reports nothing).
    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        let path = self.path_for(item_id)?;
        let plaintext = self.decrypt_entry(&path)?;
        let parsed = ParsedEntry::parse(item_id, &plaintext);
        let item_type = parsed.item_type();

        let login = (item_type == ItemType::Login).then(|| LoginDetail {
            username: parsed.username.clone(),
            password: parsed.password.clone(),
            totp: parsed.totp.clone(),
            uris: parsed
                .url
                .clone()
                .map(|u| vec![LoginUri { uri: Some(u), match_type: None }])
                .unwrap_or_default(),
            has_totp: parsed.totp.is_some(),
            password_revision_date: None,
            autofill_on_page_load: None,
            password_history: Vec::new(),
        });

        let fields: Vec<CustomField> = parsed
            .fields
            .iter()
            .map(|(name, value)| CustomField {
                name: Some(name.clone()),
                value: Some(value.clone()),
                // pass has no notion of protected metadata fields; everything
                // that isn't the first-line password is plain text.
                field_type: CustomFieldType::Text,
                linked_id: None,
            })
            .collect();

        let (creation, revision) = file_times(&path);

        Ok(ItemDetail {
            id: item_id.to_string(),
            account_email: id.to_string(),
            account_label: label.to_string(),
            name: parsed.title,
            item_type,
            favorite: false,
            reprompt: false,
            notes: parsed.notes,
            login,
            card: None,
            identity: None,
            ssh_key: None,
            fields,
            folder_id: folder_of(item_id),
            organization_id: None,
            revision_date: revision,
            creation_date: creation,
            collection_ids: Vec::new(),
            passkeys: Vec::new(),
        })
    }

    /// Current TOTP code from the entry's `otpauth://` line (the `pass-otp`
    /// convention) — same generator the Bitwarden / KeePass providers use.
    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        let path = self.path_for(item_id)?;
        let plaintext = self.decrypt_entry(&path)?;
        let parsed = ParsedEntry::parse(item_id, &plaintext);
        let secret = parsed
            .totp
            .as_deref()
            .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;
        crate::totp::current(secret)
    }

    /// Every directory under the store root that contains entries, as
    /// "A/B"-path-named folders. The root itself is never listed.
    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        let mut names: Vec<String> = Vec::new();
        for path in self.entry_paths() {
            let rel = match self.entry_id(&path) {
                Some(rel) => rel,
                None => continue,
            };
            // Every ancestor directory of the entry is a folder ("a/b/c" →
            // "a", "a/b"). pass nests arbitrarily, so surface each level.
            let mut prefix = String::new();
            let segments: Vec<&str> = rel.split('/').collect();
            for segment in &segments[..segments.len().saturating_sub(1)] {
                if !prefix.is_empty() {
                    prefix.push('/');
                }
                prefix.push_str(segment);
                if !names.contains(&prefix) {
                    names.push(prefix.clone());
                }
            }
        }
        names.sort();
        names
            .into_iter()
            .map(|name| Folder {
                id: Some(name.clone()),
                name,
                account_email: id.to_string(),
                account_label: label.to_string(),
            })
            .collect()
    }

    /// pass has no collections — always empty.
    pub fn list_collections(&self, _id: &str, _label: &str) -> Vec<Collection> {
        Vec::new()
    }

    /// How many entries use `candidate` as their (first-line) password.
    pub fn count_password_use(&self, candidate: &str) -> u32 {
        if candidate.is_empty() {
            return 0;
        }
        let mut count = 0u32;
        for path in self.entry_paths() {
            let rel = match self.entry_id(&path) {
                Some(rel) => rel,
                None => continue,
            };
            let plaintext = match self.decrypt_entry(&path) {
                Ok(p) => p,
                Err(_) => continue,
            };
            let parsed = ParsedEntry::parse(&rel, &plaintext);
            if parsed.password.as_deref() == Some(candidate) {
                count += 1;
            }
        }
        count
    }
}

// ── internals ──────────────────────────────────────────────────────────────
impl PassConnection {
    /// Every `*.gpg` file under the store root, recursively. Hidden directories
    /// (`.git`, etc.) are skipped, and the result is sorted for determinism.
    fn entry_paths(&self) -> Vec<PathBuf> {
        let mut out = Vec::new();
        collect_gpg_files(&self.root, &mut out);
        out.sort();
        out
    }

    /// The store-relative id for an entry path: drop the root prefix + the
    /// `.gpg` extension, and normalise separators to '/'. `None` if `path` is
    /// not under the root or not a `*.gpg` file.
    fn entry_id(&self, path: &Path) -> Option<String> {
        let rel = path.strip_prefix(&self.root).ok()?;
        let rel = rel.to_str()?;
        let rel = rel.strip_suffix(".gpg")?;
        Some(rel.replace('\\', "/"))
    }

    /// The absolute file path for a store-relative id. Rejects ids that escape
    /// the store root (`..`, absolute paths) — a trust-boundary check, since the
    /// id arrives from the frontend.
    fn path_for(&self, item_id: &str) -> AgateResult<PathBuf> {
        let rel = item_id.replace('\\', "/");
        if rel.is_empty()
            || rel.starts_with('/')
            || rel.split('/').any(|seg| seg == ".." || seg == "." || seg.is_empty())
        {
            return Err(AgateError::bad_request("No such item."));
        }
        let mut path = self.root.clone();
        for segment in rel.split('/') {
            path.push(segment);
        }
        // Append ".gpg" rather than set_extension: an entry name like
        // "github.com" already has a dot, and set_extension would clobber it
        // ("github.gpg"), so the file would never be found.
        let mut os = path.into_os_string();
        os.push(".gpg");
        let path = PathBuf::from(os);
        // Defence in depth: the resolved path must still be inside the root.
        if !path.starts_with(&self.root) || !path.is_file() {
            return Err(AgateError::bad_request("No such item."));
        }
        Ok(path)
    }

    /// Decrypt one `*.gpg` file to its UTF-8 plaintext, held in a `Zeroizing`
    /// buffer (the plaintext contains the password). Non-UTF-8 plaintext is a
    /// typed error rather than a panic.
    fn decrypt_entry(&self, path: &Path) -> AgateResult<Zeroizing<String>> {
        let ciphertext = std::fs::read(path).map_err(|e| {
            AgateError::bad_request(format!("Could not read a password-store entry: {e}"))
        })?;
        let policy = StandardPolicy::new();
        let helper = DecryptHelper { cert: &self.cert, passphrase: &self.passphrase };
        let mut decryptor = DecryptorBuilder::from_bytes(&ciphertext)
            .map_err(map_pgp_error)?
            .with_policy(&policy, None, helper)
            .map_err(map_pgp_error)?;
        let mut plaintext = Zeroizing::new(Vec::new());
        decryptor.read_to_end(&mut plaintext).map_err(|e| {
            AgateError::new(ErrorKind::Crypto, format!("Could not decrypt the entry: {e}"))
        })?;
        let text = String::from_utf8(plaintext.to_vec()).map_err(|_| {
            AgateError::new(ErrorKind::Crypto, "Decrypted entry was not valid UTF-8.")
        })?;
        Ok(Zeroizing::new(text))
    }
}

// ── OpenPGP decryption helper ────────────────────────────────────────────────

/// Borrows the connection's cert + passphrase to satisfy sequoia's streaming
/// decryptor. We don't verify signatures (pass entries are encrypted, rarely
/// signed), so `VerificationHelper` is a no-op.
struct DecryptHelper<'a> {
    cert: &'a Cert,
    passphrase: &'a Zeroizing<String>,
}

impl VerificationHelper for DecryptHelper<'_> {
    fn get_certs(&mut self, _ids: &[KeyHandle]) -> sequoia_openpgp::Result<Vec<Cert>> {
        Ok(Vec::new())
    }

    fn check(&mut self, _structure: MessageStructure) -> sequoia_openpgp::Result<()> {
        Ok(())
    }
}

impl DecryptionHelper for DecryptHelper<'_> {
    fn decrypt(
        &mut self,
        pkesks: &[PKESK],
        _skesks: &[SKESK],
        sym_algo: Option<SymmetricAlgorithm>,
        decrypt: &mut dyn FnMut(Option<SymmetricAlgorithm>, &SessionKey) -> bool,
    ) -> sequoia_openpgp::Result<Option<Cert>> {
        let policy = StandardPolicy::new();
        // Try every encryption-capable secret key on the cert against every
        // PKESK packet until one yields a session key the closure accepts.
        for key in self
            .cert
            .keys()
            .with_policy(&policy, None)
            .for_transport_encryption()
            .for_storage_encryption()
            .secret()
        {
            let mut keypair = match unlock_keypair(key.key(), self.passphrase) {
                Some(kp) => kp,
                None => continue,
            };
            for pkesk in pkesks {
                let decrypted = pkesk
                    .decrypt(&mut keypair, sym_algo)
                    .is_some_and(|(algo, session_key)| decrypt(algo, &session_key));
                if decrypted {
                    // sequoia 2.x's DecryptionHelper returns the Cert that
                    // decrypted (was a Fingerprint in 1.x). It is used only to
                    // identify the recipient; we hold exactly one cert.
                    return Ok(Some(self.cert.clone()));
                }
            }
        }
        Err(sequoia_openpgp::Error::InvalidSessionKey(
            "no secret key on this certificate could decrypt the entry".into(),
        )
        .into())
    }
}

/// Turn a (possibly passphrase-encrypted) secret key into a keypair we can
/// decrypt with. Returns `None` when the key cannot be unlocked with the held
/// passphrase, so the caller can try the next key.
fn unlock_keypair(
    key: &Key<SecretParts, UnspecifiedRole>,
    passphrase: &Zeroizing<String>,
) -> Option<sequoia_openpgp::crypto::KeyPair> {
    if key.secret().is_encrypted() {
        let pw = sequoia_openpgp::crypto::Password::from(passphrase.as_str());
        key.clone().decrypt_secret(&pw).ok()?.into_keypair().ok()
    } else {
        key.clone().into_keypair().ok()
    }
}

fn map_pgp_error(e: anyhow::Error) -> AgateError {
    AgateError::new(ErrorKind::Crypto, format!("OpenPGP error: {e}"))
}

// ── plaintext parsing (the pass entry format) ────────────────────────────────

/// A decrypted pass entry split into Agate's item shape. Borrows nothing: every
/// field is an owned `String` so the `Zeroizing` plaintext can be dropped.
struct ParsedEntry {
    title: String,
    password: Option<String>,
    username: Option<String>,
    url: Option<String>,
    totp: Option<String>,
    /// Recognised `key: value` metadata that isn't a typed field, in file order.
    fields: Vec<(String, String)>,
    notes: Option<String>,
}

impl ParsedEntry {
    /// Parse the pass plaintext convention:
    /// - line 0 = the password (empty line → no password)
    /// - each later `key: value` line is classified (username / url / otp /
    ///   title → typed; anything else → a custom field)
    /// - an `otpauth://…` line (with or without a key) → the totp secret
    /// - lines that aren't `key: value` accumulate into the notes body
    ///
    /// `id` supplies the default title: the entry's leaf name.
    fn parse(id: &str, plaintext: &str) -> Self {
        let default_title = id.rsplit('/').next().unwrap_or(id).to_string();
        let mut lines = plaintext.lines();

        let password = lines.next().and_then(|first| {
            let first = first.trim();
            (!first.is_empty()).then(|| first.to_string())
        });

        let mut title: Option<String> = None;
        let mut username = None;
        let mut url = None;
        let mut totp = None;
        let mut fields: Vec<(String, String)> = Vec::new();
        let mut note_lines: Vec<String> = Vec::new();

        for line in lines {
            let trimmed = line.trim_end();
            // A bare otpauth:// URI line is the pass-otp convention (no key:).
            if totp.is_none() && trimmed.trim_start().starts_with("otpauth://") {
                totp = Some(trimmed.trim().to_string());
                continue;
            }
            match split_key_value(trimmed) {
                Some((key, value)) => {
                    let lower = key.to_ascii_lowercase();
                    if lower == TITLE_KEY {
                        title = Some(value.to_string());
                    } else if USERNAME_KEYS.contains(&lower.as_str()) {
                        // First username-like key wins; later ones are kept as
                        // custom fields so nothing is silently lost.
                        if username.is_none() {
                            username = Some(value.to_string());
                        } else {
                            fields.push((key.to_string(), value.to_string()));
                        }
                    } else if URL_KEYS.contains(&lower.as_str()) {
                        if url.is_none() {
                            url = Some(value.to_string());
                        } else {
                            fields.push((key.to_string(), value.to_string()));
                        }
                    } else if value.starts_with("otpauth://") {
                        // `otp: otpauth://…` style.
                        if totp.is_none() {
                            totp = Some(value.to_string());
                        } else {
                            fields.push((key.to_string(), value.to_string()));
                        }
                    } else {
                        fields.push((key.to_string(), value.to_string()));
                    }
                }
                None => {
                    // Not a key:value line — part of the freeform notes body.
                    note_lines.push(line.to_string());
                }
            }
        }

        // Trim leading/trailing blank note lines, keep interior structure.
        while note_lines.first().is_some_and(|l| l.trim().is_empty()) {
            note_lines.remove(0);
        }
        while note_lines.last().is_some_and(|l| l.trim().is_empty()) {
            note_lines.pop();
        }
        let notes = (!note_lines.is_empty()).then(|| note_lines.join("\n"));

        ParsedEntry {
            title: title.unwrap_or(default_title),
            password,
            username,
            url,
            totp,
            fields,
            notes,
        }
    }

    /// Login when it has a username, a url, or a totp; otherwise a secure note.
    /// (A password alone doesn't make it a login — many pass entries are just a
    /// secret string, which is closer to a note.)
    fn item_type(&self) -> ItemType {
        if self.username.is_some() || self.url.is_some() || self.totp.is_some() {
            ItemType::Login
        } else {
            ItemType::SecureNote
        }
    }
}

/// Split a `key: value` line. The key must be non-empty, contain no spaces, and
/// be followed by a colon; the value is everything after the first `": "` (or
/// `":"`), trimmed of surrounding whitespace. Returns `None` for non-metadata
/// lines (e.g. prose, URLs without a key) so they fall through to notes.
fn split_key_value(line: &str) -> Option<(&str, &str)> {
    let colon = line.find(':')?;
    let key = line[..colon].trim();
    if key.is_empty() || key.contains(char::is_whitespace) {
        return None;
    }
    let value = line[colon + 1..].trim();
    Some((key, value))
}

/// The folder id (parent directory path) for a store-relative entry id, or
/// `None` for an entry sitting directly in the store root.
fn folder_of(id: &str) -> Option<String> {
    id.rfind('/').map(|i| id[..i].to_string())
}

/// Recursively collect every `*.gpg` file under `dir`, skipping hidden
/// directories (`.git`, `.gpg-id` lives at file level and is ignored — it has
/// no `.gpg` suffix). I/O errors on a subtree are logged and skipped, never
/// fatal to the listing.
fn collect_gpg_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("pass: could not read a store directory: {e}");
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let file_type = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if file_type.is_dir() {
            if name.starts_with('.') {
                continue; // skip .git and other dotdirs
            }
            collect_gpg_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("gpg") {
            out.push(path);
        }
    }
}

/// (creation, revision) RFC-3339 timestamps from the file's metadata. pass
/// stores no times in the ciphertext, so the file system is the only source;
/// missing times fall back to the unix epoch so the non-optional DTO dates stay
/// valid.
fn file_times(path: &Path) -> (String, String) {
    let epoch = chrono::DateTime::<Utc>::from(std::time::UNIX_EPOCH).to_rfc3339();
    let meta = match std::fs::metadata(path) {
        Ok(m) => m,
        Err(_) => return (epoch.clone(), epoch),
    };
    let to_rfc = |t: std::io::Result<std::time::SystemTime>| {
        t.ok().map_or_else(|| chrono::DateTime::<Utc>::from(std::time::UNIX_EPOCH).to_rfc3339(), |st| chrono::DateTime::<Utc>::from(st).to_rfc3339())
    };
    let creation = to_rfc(meta.created());
    let revision = to_rfc(meta.modified());
    (creation, revision)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    use sequoia_openpgp::cert::CertBuilder;
    use sequoia_openpgp::serialize::stream::{Encryptor, LiteralWriter, Message};
    use sequoia_openpgp::serialize::MarshalInto;

    /// Build a test certificate (with secret key) usable for both encryption and
    /// the decrypt path. No passphrase (an unencrypted exported key).
    fn test_cert() -> Cert {
        let (cert, _revocation) = CertBuilder::new()
            .add_userid("Test <test@example.com>")
            .add_storage_encryption_subkey()
            .add_transport_encryption_subkey()
            .generate()
            .expect("generate a test cert");
        cert
    }

    /// Encrypt `plaintext` to `cert` and write it as `<root>/<rel>.gpg`,
    /// creating parent directories. Mirrors what `pass insert` produces.
    fn write_entry(root: &Path, cert: &Cert, rel: &str, plaintext: &str) {
        let path = {
            let mut p = root.to_path_buf();
            for seg in rel.split('/') {
                p.push(seg);
            }
            // Append ".gpg" (set_extension would clobber a dotted name like
            // "github.com" — see path_for).
            let mut os = p.into_os_string();
            os.push(".gpg");
            PathBuf::from(os)
        };
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();

        let policy = StandardPolicy::new();
        // sequoia 2.x: Encryptor::for_recipients takes items that are
        // Into<Recipient> — the ValidKeyAmalgamation itself, not ka.key().
        let recipients: Vec<_> = cert
            .keys()
            .with_policy(&policy, None)
            .supported()
            .for_transport_encryption()
            .for_storage_encryption()
            .collect();

        let mut sink = Vec::new();
        let message = Message::new(&mut sink);
        let message = Encryptor::for_recipients(message, recipients)
            .build()
            .expect("encryptor");
        let mut writer = LiteralWriter::new(message).build().expect("literal writer");
        writer.write_all(plaintext.as_bytes()).expect("write plaintext");
        writer.finalize().expect("finalize");

        std::fs::write(&path, &sink).expect("write entry file");
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        root: PathBuf,
        key_file: PathBuf,
    }

    /// A store with:
    /// - `web/github.com`  → login (password + login: + url: + otpauth:)
    /// - `web/example.com` → login (password + username: + url:) + custom field
    /// - `notes/wifi`      → secret note (password only + freeform notes)
    /// - root `apikey`     → secure note (no login-shaped fields)
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        std::fs::create_dir_all(&root).unwrap();

        let cert = test_cert();
        let key_file = dir.path().join("secret.asc");
        std::fs::write(&key_file, cert.as_tsk().to_vec().unwrap()).unwrap();

        write_entry(
            &root,
            &cert,
            "web/github.com",
            "hunter2\nlogin: octocat\nurl: https://github.com/login\n\
             otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub\n",
        );
        write_entry(
            &root,
            &cert,
            "web/example.com",
            "s3cr3t\nusername: alice\nurl: https://example.com\nApiKey: abc123\n",
        );
        write_entry(
            &root,
            &cert,
            "notes/wifi",
            "wifi-password-123\nThis is the office wifi.\nSecond line of notes.\n",
        );
        write_entry(&root, &cert, "apikey", "just-a-secret-string\n");

        Fixture { _dir: dir, root, key_file }
    }

    fn open_conn(fx: &Fixture) -> PassConnection {
        PassConnection::open(&fx.root, &fx.key_file, "").unwrap()
    }

    #[test]
    fn open_rejects_non_secret_key() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("store");
        std::fs::create_dir_all(&root).unwrap();
        let cert = test_cert();
        // Export the PUBLIC cert (no secret) — open must refuse it.
        let pub_file = dir.path().join("public.asc");
        std::fs::write(&pub_file, cert.to_vec().unwrap()).unwrap();

        let err = PassConnection::open(&root, &pub_file, "").unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
        assert!(err.message.contains("SECRET"), "got: {}", err.message);
    }

    #[test]
    fn open_rejects_missing_key_file() {
        let dir = tempfile::tempdir().unwrap();
        let err = PassConnection::open(dir.path(), &dir.path().join("nope.asc"), "").unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }

    #[test]
    fn open_with_wrong_key_fails_to_decrypt() {
        let fx = fixture();
        // A DIFFERENT key cannot decrypt the store entries → open fails.
        let other = test_cert();
        let other_file = fx._dir.path().join("other.asc");
        std::fs::write(&other_file, other.as_tsk().to_vec().unwrap()).unwrap();

        let err = PassConnection::open(&fx.root, &other_file, "").unwrap_err();
        assert!(matches!(err.kind, ErrorKind::Crypto), "got: {err}");
    }

    #[test]
    fn list_items_maps_types_and_folders() {
        let fx = fixture();
        let conn = open_conn(&fx);
        let items = conn.list_items("pass", "Pass");
        assert_eq!(items.len(), 4);

        let github = items.iter().find(|i| i.id == "web/github.com").unwrap();
        assert_eq!(github.name, "github.com");
        assert_eq!(github.item_type, ItemType::Login);
        assert_eq!(github.username.as_deref(), Some("octocat"));
        assert_eq!(github.uri.as_deref(), Some("https://github.com/login"));
        assert!(github.has_totp);
        assert!(!github.favorite);
        assert!(!github.deleted);
        assert_eq!(github.folder_id.as_deref(), Some("web"));

        let example = items.iter().find(|i| i.id == "web/example.com").unwrap();
        assert_eq!(example.username.as_deref(), Some("alice"));
        assert!(!example.has_totp);

        let wifi = items.iter().find(|i| i.id == "notes/wifi").unwrap();
        assert_eq!(wifi.item_type, ItemType::SecureNote, "password-only → note");
        assert_eq!(wifi.username, None);
        assert_eq!(wifi.folder_id.as_deref(), Some("notes"));

        let apikey = items.iter().find(|i| i.id == "apikey").unwrap();
        assert_eq!(apikey.item_type, ItemType::SecureNote);
        assert_eq!(apikey.folder_id, None, "root entry has no folder");
    }

    #[test]
    fn item_detail_maps_login_notes_and_custom_fields() {
        let fx = fixture();
        let conn = open_conn(&fx);

        let detail = conn.item_detail("pass", "Pass", "web/example.com").unwrap();
        assert_eq!(detail.item_type, ItemType::Login);
        let login = detail.login.as_ref().unwrap();
        assert_eq!(login.username.as_deref(), Some("alice"));
        assert_eq!(login.password.as_deref(), Some("s3cr3t"));
        assert_eq!(login.uris.len(), 1);
        assert_eq!(login.uris[0].uri.as_deref(), Some("https://example.com"));

        let api_key = detail.fields.iter().find(|f| f.name.as_deref() == Some("ApiKey")).unwrap();
        assert_eq!(api_key.value.as_deref(), Some("abc123"));
        assert_eq!(api_key.field_type, CustomFieldType::Text);

        // dates render as parseable RFC 3339
        assert!(chrono::DateTime::parse_from_rfc3339(&detail.revision_date).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&detail.creation_date).is_ok());

        // a note: password-only entry has no login section and keeps its notes body
        let wifi = conn.item_detail("pass", "Pass", "notes/wifi").unwrap();
        assert!(wifi.login.is_none());
        assert_eq!(
            wifi.notes.as_deref(),
            Some("This is the office wifi.\nSecond line of notes.")
        );
    }

    #[test]
    fn item_detail_rejects_path_traversal() {
        let fx = fixture();
        let conn = open_conn(&fx);
        for evil in ["../secret", "web/../../etc/passwd", "/etc/passwd", ""] {
            let err = conn.item_detail("pass", "Pass", evil).unwrap_err();
            assert!(matches!(err.kind, ErrorKind::BadRequest), "{evil}: {err}");
        }
    }

    #[test]
    fn item_totp_generates_six_digit_code() {
        let fx = fixture();
        let conn = open_conn(&fx);
        let totp = conn.item_totp("web/github.com").unwrap();
        assert_eq!(totp.code.len(), 6);
        assert!(totp.code.chars().all(|c| c.is_ascii_digit()), "code: {}", totp.code);
        assert_eq!(totp.period, 30);
        assert!(totp.remaining >= 1 && totp.remaining <= 30);

        // no otp line → typed error
        let err = conn.item_totp("notes/wifi").unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }

    #[test]
    fn folders_fields_count_and_autofill_views() {
        let fx = fixture();
        let conn = open_conn(&fx);

        let folders = conn.list_folders("pass", "Pass");
        let names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["notes", "web"], "directory paths, root excluded");
        assert_eq!(folders[1].id.as_deref(), Some("web"), "folder id = path");

        assert!(conn.list_collections("pass", "Pass").is_empty());

        let field_names = conn.custom_field_names();
        assert_eq!(field_names, vec!["ApiKey".to_string()]);

        assert_eq!(conn.count_password_use("hunter2"), 1);
        assert_eq!(conn.count_password_use("not-used"), 0);
        assert_eq!(conn.count_password_use(""), 0);

        let matches = conn.autofill_entries("pass", "Pass");
        assert_eq!(matches.len(), 2, "logins only — the two notes are excluded");
        let gh = matches.iter().find(|m| m.id == "web/github.com").unwrap();
        assert!(gh.uris.iter().any(|u| u == "https://github.com/login"));
        assert!(gh.uris.iter().any(|u| u == "github.com"), "leaf name added as a match uri");
        assert_eq!(gh.username.as_deref(), Some("octocat"));
    }

    #[test]
    fn parse_classifies_lines() {
        let parsed = ParsedEntry::parse(
            "web/site",
            "pw\ntitle: My Site\nUser: bob\nurl: https://site\n\
             otpauth://totp/x?secret=AAAA\nNote line\nCustom: value\n",
        );
        assert_eq!(parsed.title, "My Site");
        assert_eq!(parsed.password.as_deref(), Some("pw"));
        assert_eq!(parsed.username.as_deref(), Some("bob"));
        assert_eq!(parsed.url.as_deref(), Some("https://site"));
        assert!(parsed.totp.as_deref().unwrap().starts_with("otpauth://"));
        assert_eq!(parsed.notes.as_deref(), Some("Note line"));
        assert!(parsed.fields.iter().any(|(k, v)| k == "Custom" && v == "value"));
        assert_eq!(parsed.item_type(), ItemType::Login);

        // default title = the leaf of the id when no title: line
        let bare = ParsedEntry::parse("web/github.com", "pw\n");
        assert_eq!(bare.title, "github.com");
        assert_eq!(bare.item_type(), ItemType::SecureNote, "password-only → note");
    }
}
