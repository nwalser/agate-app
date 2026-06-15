//! The KeePass provider: a decrypted KDBX database held in memory, read with
//! the same surface as a Bitwarden connection and written back through an
//! atomic, verified save.
//!
//! Mapping conventions (Bitwarden-shaped DTOs ← KeePass):
//! - item id = entry UUID, folder id = group UUID (hyphenated lowercase).
//! - An entry is a `Login` when any of UserName / Password / URL / otp is
//!   non-empty, otherwise a `SecureNote`.
//! - favorite = the KeePassXC "Favorite" tag; deleted = the entry lives under
//!   the recycle-bin group's subtree.
//! - Folder names are the group's full path joined with "/" (the app renders
//!   "A/B" as nesting); the root group is never listed, and neither is the
//!   recycle-bin subtree (Agate has its own Trash view driven by `deleted`).
//! - Custom fields are every non-standard string field; protected → hidden.
//!
//! Write safety: upstream KDBX4 write support is labeled experimental, so every
//! save serializes to a same-directory temp file, REOPENS and verifies it with
//! the same key, copies the current database to `<file>.bak`, and only then
//! atomically renames the temp over the original. A save also refuses to run
//! when the file's mtime changed behind our back ("changed on disk — sync
//! first").
//!
//! Blocking: `open` / `reload` (Argon2 KDF) and every write (file I/O + KDF for
//! the save + verify) block — callers wrap them in `spawn_blocking`.

use std::collections::HashSet;
use std::io::Seek;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use bitwarden_vault::generate_totp;
use chrono::{NaiveDateTime, Utc};
use keepass::config::{DatabaseConfig, DatabaseVersion, KdfConfig};
use keepass::db::{fields as kpf, Database, Entry, EntryId, EntryRef, GroupId, Times};
use keepass::error::{DatabaseKeyError, DatabaseOpenError};
use keepass::DatabaseKey;
use zeroize::Zeroizing;

use crate::dto::{
    Collection, CustomField, CustomFieldType, Folder, ItemDetail, ItemInput, ItemType,
    LoginDetail, LoginUri, PasskeyCredential, TotpCode, VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::passkey::{CoseAlgorithm, PasskeyTarget, StoredPasskey};

/// KeePassXC's favorite convention: a literal "Favorite" tag on the entry.
const FAVORITE_TAG: &str = "Favorite";

/// Keepass2Android / KeePassXC convention for extra autofill URLs beyond the
/// primary `URL` field: custom fields named `KP2A_URL` and `KP2A_URL_<n>`. Agate
/// reads these into a login's match URIs and writes a login association ("remember
/// this app/site") into the next free one, so multi-URL + native-app associations
/// interoperate with other KeePass clients.
const ADDITIONAL_URL_FIELD: &str = "KP2A_URL";

/// Name for a recycle-bin group we create on first soft delete (mirrors
/// KeePassXC's default).
const RECYCLE_BIN_NAME: &str = "Recycle Bin";

/// KeePassXC's passkey storage convention: a passkey lives on a normal entry as
/// a set of `KPEX_PASSKEY_*` string attributes plus a `Passkey` tag, so a
/// credential Agate writes is usable by KeePassXC and vice-versa.
/// - `CREDENTIAL_ID` / `USER_HANDLE`: raw bytes, base64url (no padding).
/// - `PRIVATE_KEY_PEM`: the PKCS#8 private key in PEM, stored **protected**.
/// - `ALGORITHM`: an Agate convenience attribute ("ES256"/"EdDSA"/"RS256") so a
///   reader needn't parse the PEM; KeePassXC ignores unknown attributes, so it's
///   harmless to interop. A passkey written by *another* client lacks it — we
///   then default to ES256 (the common case) until the ceremony layer (which has
///   the crypto crate) can infer the algorithm from the key.
const PASSKEY_CREDENTIAL_ID: &str = "KPEX_PASSKEY_CREDENTIAL_ID";
const PASSKEY_PRIVATE_KEY_PEM: &str = "KPEX_PASSKEY_PRIVATE_KEY_PEM";
const PASSKEY_RELYING_PARTY: &str = "KPEX_PASSKEY_RELYING_PARTY";
const PASSKEY_USER_HANDLE: &str = "KPEX_PASSKEY_USER_HANDLE";
const PASSKEY_USERNAME: &str = "KPEX_PASSKEY_USERNAME";
const PASSKEY_ALGORITHM: &str = "KPEX_PASSKEY_ALGORITHM";
const PASSKEY_FLAG_BE: &str = "KPEX_PASSKEY_FLAG_BE";
const PASSKEY_FLAG_BS: &str = "KPEX_PASSKEY_FLAG_BS";
const PASSKEY_FIELD_PREFIX: &str = "KPEX_PASSKEY_";
// Only the (currently-unwired) create path tags an entry; allow until the
// ceremony adapter calls it.
#[allow(dead_code)]
const PASSKEY_TAG: &str = "Passkey";

/// KeePass standard fields owned by the typed parts of `ItemInput` — never
/// surfaced or writable as custom fields. Exact match: KeePass field names are
/// case-sensitive, so e.g. a custom "password" field is a different key and
/// stays a custom field.
const RESERVED_FIELDS: [&str; 6] =
    [kpf::TITLE, kpf::USERNAME, kpf::PASSWORD, kpf::URL, kpf::NOTES, kpf::OTP];

/// One live, unlocked KeePass connection: the file path, the composite key
/// material (zeroized on drop), the decrypted database, and the file's
/// modification time as of our last read/write (the concurrent-change guard).
pub struct KeepassConnection {
    path: PathBuf,
    password: Zeroizing<String>,
    /// Raw key-file bytes, read once at `open` (so the key stays stable even if
    /// the key file later moves).
    keyfile: Option<Zeroizing<Vec<u8>>>,
    db: Database,
    /// mtime of the database file when we last read or wrote it. `None` only
    /// when the filesystem reports no mtime (change detection then disabled).
    mtime: Option<SystemTime>,
    /// KDBX4 can be written back; KDBX3 (and older) opens read-only.
    writable: bool,
}

/// Redacted: never prints key material or vault contents.
impl std::fmt::Debug for KeepassConnection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("KeepassConnection")
            .field("path", &self.path)
            .field("writable", &self.writable)
            .finish_non_exhaustive()
    }
}

// ── lifecycle (open / reload) + writes ──────────────────────────────────────
impl KeepassConnection {
    /// Open + decrypt a `.kdbx` file. KDBX3 and KDBX4 both open; only KDBX4 can
    /// be saved — for older formats `open` SUCCEEDS but every write returns a
    /// typed `BadRequest` telling the user to upgrade the database first.
    ///
    /// Blocking (Argon2 KDF) — callers wrap in `spawn_blocking`.
    pub fn open(path: &Path, password: &str, keyfile: Option<&Path>) -> AgateResult<Self> {
        let keyfile = match keyfile {
            Some(p) => Some(Zeroizing::new(std::fs::read(p).map_err(|e| {
                AgateError::bad_request(format!("Could not read the key file: {e}"))
            })?)),
            None => None,
        };
        let mut conn = Self {
            path: path.to_path_buf(),
            password: Zeroizing::new(password.to_string()),
            keyfile,
            db: Database::new(),
            mtime: None,
            writable: false,
        };
        conn.read_from_disk()?;
        Ok(conn)
    }

    /// Re-read the database from disk with the held key — the provider's
    /// "sync". Blocking, like `open`.
    pub fn reload(&mut self) -> AgateResult<()> {
        self.read_from_disk()
    }

    /// Create a brand-new, empty KDBX4 database at `path` and open it as a live
    /// connection. REFUSES to overwrite an existing file — a new vault must
    /// never clobber data (open the existing one instead). The database uses the
    /// `keepass` crate's default KDBX4 + Argon2id configuration, so it is
    /// immediately writable.
    ///
    /// Blocking (Argon2 KDF on the initial save) — callers wrap in
    /// `spawn_blocking`.
    pub fn create(path: &Path, password: &str, keyfile: Option<&Path>) -> AgateResult<Self> {
        if path.exists() {
            return Err(AgateError::bad_request(
                "A file already exists there. Pick a different name, \
                 or open the existing database instead.",
            ));
        }
        let keyfile = match keyfile {
            Some(p) => Some(Zeroizing::new(std::fs::read(p).map_err(|e| {
                AgateError::bad_request(format!("Could not read the key file: {e}"))
            })?)),
            None => None,
        };
        let mut db = Database::with_config(new_database_config());
        db.meta.generator = Some("Agate".to_string());
        if let Some(name) = path.file_stem().and_then(|s| s.to_str()) {
            db.meta.database_name = Some(name.to_string());
            db.meta.database_name_changed = Some(Times::now());
        }
        let mut conn = Self {
            path: path.to_path_buf(),
            password: Zeroizing::new(password.to_string()),
            keyfile,
            db,
            mtime: None,
            // `Database::new()` is KDBX4 (see the crate's DatabaseConfig default).
            writable: true,
        };
        conn.write_new_file()?;
        Ok(conn)
    }

    /// Serialize a freshly-created database to its (not-yet-existing) path:
    /// same-directory temp → reopen + verify with the key → atomic
    /// no-clobber rename into place → record the mtime. Unlike `save_to_disk`
    /// there is no prior file to `.bak`, and `persist_noclobber` refuses to
    /// replace a file that appeared since `create`'s existence check.
    fn write_new_file(&mut self) -> AgateResult<()> {
        let dir = match self.path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => PathBuf::from("."),
        };

        let mut tmp = tempfile::Builder::new()
            .prefix(".agate-new-")
            .suffix(".kdbx.tmp")
            .tempfile_in(dir)
            .map_err(|e| {
                AgateError::internal(format!(
                    "Could not create a scratch file next to the new database: {e}"
                ))
            })?;
        self.db.save(tmp.as_file_mut(), self.key()?).map_err(|e| {
            AgateError::new(
                ErrorKind::Crypto,
                format!("Could not serialize the new KeePass database: {e}"),
            )
        })?;
        tmp.as_file()
            .sync_all()
            .map_err(|e| AgateError::internal(format!("Could not flush the new database: {e}")))?;

        // Verify the new file reopens with the same key before committing it.
        tmp.as_file_mut().rewind().map_err(|e| {
            AgateError::internal(format!("Could not rewind the new database for verification: {e}"))
        })?;
        Database::open(tmp.as_file_mut(), self.key()?).map_err(|e| {
            AgateError::new(
                ErrorKind::Crypto,
                format!("New database verification failed — it was NOT written: {e}"),
            )
        })?;

        // No-clobber persist: never replace a file (a new vault must not destroy
        // an existing one), closing the gap since the `path.exists()` check.
        tmp.persist_noclobber(&self.path).map_err(|e| {
            AgateError::internal(format!("Could not write the new database file: {e}"))
        })?;

        self.mtime = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        Ok(())
    }

    /// Create (id absent) or edit (id present) a login / secure note, then save.
    ///
    /// Edits mutate only what the input owns (Title / login fields / Notes /
    /// named custom fields / favorite tag / group); everything else on the
    /// entry — attachments, icons, history, fields the input does not name —
    /// is preserved, and the pre-edit state is pushed into the entry's KeePass
    /// history. Custom fields are merge-upserts: a field named with `value:
    /// None` is removed, a field not named at all is left untouched.
    pub fn save_item(&mut self, input: &ItemInput) -> AgateResult<()> {
        if !matches!(input.item_type, ItemType::Login | ItemType::SecureNote) {
            return Err(AgateError::bad_request(
                "Only logins and secure notes can be saved to a KeePass vault.",
            ));
        }
        let edit_id = match &input.id {
            Some(s) => Some(EntryId::from_uuid(parse_uuid(s, "No such item.")?)),
            None => None,
        };
        self.mutate_and_save(|db| {
            let target = resolve_target_group(db, input.folder_id.as_deref())?;
            match edit_id {
                Some(eid) => edit_entry(db, eid, input, target),
                None => create_entry(db, input, target),
            }
        })
    }

    /// Remember an autofill URL for an entry ("use this login here"): fill the
    /// primary `URL` field if it's empty, otherwise store it in the next free
    /// `KP2A_URL` custom field. Idempotent — a URL already present (primary or
    /// additional) is a no-op. The pre-edit state is pushed into the entry's
    /// history like any other edit.
    pub fn add_autofill_uri(&mut self, item_id: &str, uri: &str) -> AgateResult<()> {
        let uri = uri.trim();
        if uri.is_empty() {
            return Err(AgateError::bad_request("There's nothing to remember for this app."));
        }
        let eid = EntryId::from_uuid(parse_uuid(item_id, "No such item.")?);
        let uri = uri.to_string();
        self.mutate_and_save(move |db| {
            let mut entry =
                db.entry_mut(eid).ok_or_else(|| AgateError::bad_request("No such item."))?;
            entry.edit_tracking(|tracked| {
                add_additional_url(tracked, &uri);
                tracked.times.last_modification = Some(Times::now());
            });
            Ok(())
        })
    }

    /// Toggle the KeePassXC-style "Favorite" tag.
    pub fn set_favorite(&mut self, item_id: &str, favorite: bool) -> AgateResult<()> {
        let eid = EntryId::from_uuid(parse_uuid(item_id, "No such item.")?);
        self.mutate_and_save(|db| {
            let mut entry = db
                .entry_mut(eid)
                .ok_or_else(|| AgateError::bad_request("No such item."))?;
            set_favorite_tag(&mut entry, favorite);
            entry.times.last_modification = Some(Times::now());
            Ok(())
        })
    }

    /// Move entries to a group (`None` = the root group).
    pub fn move_items(&mut self, ids: &[String], folder_id: Option<&str>) -> AgateResult<()> {
        let eids = parse_entry_ids(ids)?;
        self.mutate_and_save(|db| {
            let target = resolve_target_group(db, folder_id)?;
            for eid in eids {
                move_entry(db, eid, target)?;
            }
            Ok(())
        })
    }

    /// Soft delete moves entries into the recycle-bin group (created + enabled
    /// on first use, mirroring KeePassXC); permanent delete removes the entry
    /// node (recording it in the database's deleted-objects list).
    pub fn delete_items(&mut self, ids: &[String], permanent: bool) -> AgateResult<()> {
        let eids = parse_entry_ids(ids)?;
        self.mutate_and_save(|db| {
            if permanent {
                for eid in eids {
                    let mut entry = db
                        .entry_mut(eid)
                        .ok_or_else(|| AgateError::bad_request("No such item."))?;
                    entry.track_changes().remove();
                }
            } else {
                let bin = ensure_recycle_bin(db);
                for eid in eids {
                    move_entry(db, eid, bin)?;
                }
            }
            Ok(())
        })
    }

    /// Move entries back to their previous parent group when the model still
    /// tracks it (`PreviousParentGroup`), otherwise to the root group.
    pub fn restore_items(&mut self, ids: &[String]) -> AgateResult<()> {
        let eids = parse_entry_ids(ids)?;
        self.mutate_and_save(|db| {
            let root = db.root().id();
            for eid in eids {
                let target = db
                    .entry(eid)
                    .ok_or_else(|| AgateError::bad_request("No such item."))?
                    .previous_parent()
                    .map(|g| g.id())
                    .unwrap_or(root);
                move_entry(db, eid, target)?;
            }
            Ok(())
        })
    }

    /// Create a group under the root. `name` may be a "/"-joined path
    /// ("A/B") — each missing segment becomes a nested group; existing
    /// segments (matched case-insensitively, like the KeePass tree) are reused.
    ///
    /// The returned `Folder` carries empty `account_email` / `account_label` —
    /// the caller stamps the connection identity (this provider doesn't know it).
    pub fn create_folder(&mut self, name: &str) -> AgateResult<Folder> {
        let segments = split_folder_path(name)?;
        let leaf = self.mutate_and_save(|db| {
            let mut current = db.root().id();
            for segment in &segments {
                current = find_or_create_child_group(db, current, segment)?;
            }
            Ok(current)
        })?;
        Ok(Folder {
            id: Some(leaf.uuid().to_string()),
            name: group_path(&self.db, leaf),
            account_email: String::new(),
            account_label: String::new(),
        })
    }

    /// Rename a group so its rendered path equals `name`: the leaf segment
    /// becomes the group's name, and if the path prefix differs the group is
    /// moved (creating missing parent groups) — mirroring how Bitwarden folder
    /// names ARE their full path.
    pub fn rename_folder(&mut self, folder_id: &str, name: &str) -> AgateResult<()> {
        let gid = GroupId::from_uuid(parse_uuid(folder_id, "No such folder.")?);
        let segments = split_folder_path(name)?;
        self.mutate_and_save(|db| {
            let root = db.root().id();
            if gid == root {
                return Err(AgateError::bad_request("Cannot rename the root group."));
            }
            if db.group(gid).is_none() {
                return Err(AgateError::bad_request("No such folder."));
            }
            let (leaf, parents) = match segments.split_last() {
                Some(split) => split,
                None => return Err(AgateError::bad_request("Folder name is required.")),
            };
            let mut parent_id = root;
            for segment in parents {
                parent_id = find_or_create_child_group(db, parent_id, segment)?;
            }
            let current_parent = db.group(gid).and_then(|g| g.parent().map(|p| p.id()));
            if current_parent != Some(parent_id) {
                let mut group = db
                    .group_mut(gid)
                    .ok_or_else(|| AgateError::bad_request("No such folder."))?;
                group
                    .move_to(parent_id)
                    .map_err(|e| AgateError::bad_request(format!("Cannot move folder: {e}")))?;
                group.times.location_changed = Some(Times::now());
            }
            let mut group = db
                .group_mut(gid)
                .ok_or_else(|| AgateError::bad_request("No such folder."))?;
            group.name = leaf.clone();
            group.times.last_modification = Some(Times::now());
            Ok(())
        })
    }

    /// Delete a group (and its subgroups). Every entry in the subtree is moved
    /// to the root group first — deleting a folder never deletes items.
    pub fn delete_folder(&mut self, folder_id: &str) -> AgateResult<()> {
        let gid = GroupId::from_uuid(parse_uuid(folder_id, "No such folder.")?);
        self.mutate_and_save(|db| {
            let root = db.root().id();
            if gid == root {
                return Err(AgateError::bad_request("Cannot delete the root group."));
            }
            if db.group(gid).is_none() {
                return Err(AgateError::bad_request("No such folder."));
            }
            for eid in subtree_entry_ids(db, gid) {
                move_entry(db, eid, root)?;
            }
            let mut group = db
                .group_mut(gid)
                .ok_or_else(|| AgateError::bad_request("No such folder."))?;
            group
                .track_changes()
                .remove()
                .map_err(|e| AgateError::bad_request(e.to_string()))?;
            // If the recycle bin lived inside the deleted subtree, don't leave a
            // dangling meta reference (GroupTrack::remove keeps meta as-is).
            if let Some(bin_uuid) = db.meta.recyclebin_uuid {
                if db.group(GroupId::from_uuid(bin_uuid)).is_none() {
                    db.meta.recyclebin_uuid = None;
                }
            }
            Ok(())
        })
    }
}

// ── passkeys (FIDO2 / WebAuthn) ──────────────────────────────────────────────
//
// A passkey is stored on its own entry as KeePassXC-compatible `KPEX_PASSKEY_*`
// attributes (see the constants above) — so the same atomic-save guarantees as
// any other write apply, and credentials interoperate with KeePassXC.
//
// `create_passkey` is driven by the ceremony adapter; `remove_passkey` by
// `mutate::remove_passkey`. (Read-side display — `has_passkey` and the detail
// metadata — is live via `list_items` / `item_detail`.)
impl KeepassConnection {
    /// Every stored passkey whose relying party matches `rp_id` (deleted entries
    /// excluded). A malformed passkey entry is skipped with a warning, never
    /// fatal to the lookup.
    pub fn find_passkeys_for_rp(&self, rp_id: &str) -> AgateResult<Vec<StoredPasskey>> {
        let bin = bin_group_ids(&self.db);
        let mut out = Vec::new();
        for entry in self.db.iter_all_entries() {
            if bin.contains(&entry.parent().id()) {
                continue;
            }
            if entry.get(PASSKEY_RELYING_PARTY) == Some(rp_id) {
                if let Some(passkey) = read_stored_passkey(&entry) {
                    out.push(passkey);
                }
            }
        }
        Ok(out)
    }

    /// One stored passkey by credential id, if present and not deleted.
    pub fn get_passkey(&self, credential_id: &[u8]) -> AgateResult<Option<StoredPasskey>> {
        let target = URL_SAFE_NO_PAD.encode(credential_id);
        let bin = bin_group_ids(&self.db);
        for entry in self.db.iter_all_entries() {
            if bin.contains(&entry.parent().id()) {
                continue;
            }
            if entry.get(PASSKEY_CREDENTIAL_ID) == Some(target.as_str()) {
                return Ok(read_stored_passkey(&entry));
            }
        }
        Ok(None)
    }

    /// Store a freshly-minted passkey at `target`, then save atomically:
    /// - `target.item_id` set → attach it to that existing entry (e.g. the
    ///   user's existing login for the site); refuses if the entry already holds
    ///   a passkey (one passkey per entry, the KeePassXC convention).
    /// - otherwise → create a new entry in `target.folder_id` (or the root),
    ///   titled by the relying party.
    pub fn create_passkey(&mut self, passkey: &StoredPasskey, target: &PasskeyTarget) -> AgateResult<()> {
        match &target.item_id {
            Some(item_id) => {
                let eid = EntryId::from_uuid(parse_uuid(item_id, "No such item.")?);
                self.mutate_and_save(|db| {
                    match db.entry(eid) {
                        Some(entry) if entry.get(PASSKEY_CREDENTIAL_ID).is_some_and(|v| !v.is_empty()) => {
                            return Err(AgateError::bad_request("That item already has a passkey."));
                        }
                        Some(_) => {}
                        None => return Err(AgateError::bad_request("No such item.")),
                    }
                    let mut entry = db
                        .entry_mut(eid)
                        .ok_or_else(|| AgateError::bad_request("No such item."))?;
                    entry.edit_tracking(|tracked| {
                        set_passkey_attrs(tracked, passkey);
                        tracked.times.last_modification = Some(Times::now());
                    });
                    Ok(())
                })
            }
            None => {
                self.mutate_and_save(|db| {
                    let group_id = resolve_target_group(db, target.folder_id.as_deref())?;
                    let title = passkey.rp_name.clone().unwrap_or_else(|| passkey.rp_id.clone());
                    let mut group = db
                        .group_mut(group_id)
                        .ok_or_else(|| AgateError::bad_request("No such folder."))?;
                    let mut entry = group.add_entry();
                    entry.set_unprotected(kpf::TITLE, title.as_str());
                    if let Some(name) = &passkey.user_name {
                        entry.set_unprotected(kpf::USERNAME, name.as_str());
                    }
                    set_passkey_attrs(&mut entry, passkey);
                    Ok(())
                })
            }
        }
    }

    /// Remove a passkey from its entry: strips the `KPEX_PASSKEY_*` attributes
    /// and the `Passkey` tag, leaving the entry (and any login it was attached
    /// to) intact. Non-destructive — it never deletes the item itself.
    pub fn remove_passkey(&mut self, credential_id: &[u8]) -> AgateResult<()> {
        let target = URL_SAFE_NO_PAD.encode(credential_id);
        let eid = self
            .db
            .iter_all_entries()
            .find(|e| e.get(PASSKEY_CREDENTIAL_ID) == Some(target.as_str()))
            .map(|e| e.id());
        let Some(eid) = eid else {
            return Err(AgateError::bad_request("No such passkey."));
        };
        self.mutate_and_save(move |db| {
            let mut entry = db
                .entry_mut(eid)
                .ok_or_else(|| AgateError::bad_request("No such passkey."))?;
            entry.edit_tracking(|tracked| {
                strip_passkey_attrs(tracked);
                tracked.times.last_modification = Some(Times::now());
            });
            Ok(())
        })
    }
}

// ── read surface (mirrors BitwardenConnection) ──────────────────────────────

impl KeepassConnection {
    /// All entries as unified list rows, stamped with the connection id + label.
    pub fn list_items(&self, id: &str, label: &str) -> Vec<VaultItem> {
        let bin = bin_group_ids(&self.db);
        let root = self.db.root().id();
        self.db
            .iter_all_entries()
            .map(|e| entry_to_list_item(&e, id, label, root, &bin))
            .collect()
    }

    /// Per-login match entries for the autofill index.
    pub fn autofill_entries(&self, id: &str, label: &str) -> Vec<crate::autofill::MatchItem> {
        let bin = bin_group_ids(&self.db);
        let mut out = Vec::new();
        for e in self.db.iter_all_entries() {
            if bin.contains(&e.parent().id()) || entry_item_type(&e) != ItemType::Login {
                continue;
            }
            let mut uris: Vec<String> = non_empty(e.get_url()).into_iter().collect();
            // Pull any Keepass2Android-style additional URLs (KP2A_URL*) too, so a
            // login with several sites — or a native-app `app://` association — is
            // matched on all of them, not just the primary URL field.
            for (name, value) in e.fields.iter() {
                if is_additional_url_field(name) {
                    if let Some(v) = non_empty(Some(value.get())) {
                        if !uris.contains(&v) {
                            uris.push(v);
                        }
                    }
                }
            }
            out.push(crate::autofill::MatchItem {
                id: e.id().uuid().to_string(),
                account_email: id.to_string(),
                account_label: label.to_string(),
                name: e.get_title().unwrap_or_default().to_string(),
                username: non_empty(e.get_username()),
                uris,
                reprompt: false,
            });
        }
        out
    }

    /// Names of every non-standard field across the database (names only —
    /// values are never read here). Sorted for determinism.
    pub fn custom_field_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self
            .db
            .iter_all_entries()
            .flat_map(|e| {
                e.fields
                    .keys()
                    .filter(|k| !RESERVED_FIELDS.contains(&k.as_str()) && !is_passkey_field(k))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .collect();
        names.sort();
        names
    }

    /// One entry as full detail (login fields, notes, custom fields, dates).
    pub fn item_detail(&self, id: &str, label: &str, item_id: &str) -> AgateResult<ItemDetail> {
        let entry = self.find_entry(item_id)?;
        let root = self.db.root().id();
        let parent = entry.parent().id();
        let item_type = entry_item_type(&entry);

        let login = (item_type == ItemType::Login).then(|| LoginDetail {
            username: non_empty(entry.get_username()),
            password: non_empty(entry.get_password()),
            totp: non_empty(entry.get_raw_otp_value()),
            uris: non_empty(entry.get_url())
                .map(|u| vec![LoginUri { uri: Some(u), match_type: None }])
                .unwrap_or_default(),
            has_totp: non_empty(entry.get_raw_otp_value()).is_some(),
            password_revision_date: None,
            autofill_on_page_load: None,
            password_history: Vec::new(),
        });

        let mut fields: Vec<CustomField> = entry
            .fields
            .iter()
            // Passkey `KPEX_PASSKEY_*` attributes (incl. the private key) must
            // never surface as user-visible/editable custom fields.
            .filter(|(name, _)| !RESERVED_FIELDS.contains(&name.as_str()) && !is_passkey_field(name))
            .map(|(name, value)| CustomField {
                name: Some(name.clone()),
                value: Some(value.get().clone()),
                field_type: if value.is_protected() {
                    CustomFieldType::Hidden
                } else {
                    CustomFieldType::Text
                },
                linked_id: None,
            })
            .collect();
        // KeePass stores fields unordered; sort for a stable detail pane.
        fields.sort_by(|a, b| a.name.cmp(&b.name));

        // A passkey entry surfaces display-only metadata (the private key never
        // leaves the backend, so it is not part of the DTO).
        let passkeys = match read_stored_passkey(&entry) {
            Some(pk) => vec![PasskeyCredential {
                credential_id: URL_SAFE_NO_PAD.encode(&pk.credential_id),
                rp_id: pk.rp_id,
                rp_name: pk.rp_name,
                user_name: pk.user_name,
                user_display_name: pk.user_display_name,
                key_algorithm: pk.algorithm.label().to_string(),
                creation_date: pk.created,
            }],
            None => Vec::new(),
        };

        Ok(ItemDetail {
            id: entry.id().uuid().to_string(),
            account_email: id.to_string(),
            account_label: label.to_string(),
            name: entry.get_title().unwrap_or_default().to_string(),
            item_type,
            favorite: has_favorite_tag(&entry),
            reprompt: false,
            notes: non_empty(entry.get(kpf::NOTES)),
            login,
            card: None,
            identity: None,
            ssh_key: None,
            fields,
            folder_id: (parent != root).then(|| parent.uuid().to_string()),
            organization_id: None,
            revision_date: rfc3339(entry.times.last_modification),
            creation_date: rfc3339(entry.times.creation),
            collection_ids: Vec::new(),
            passkeys,
        })
    }

    /// Current TOTP code from the entry's `otp` field (otpauth:// URI or raw
    /// secret — same generator the Bitwarden provider uses).
    pub fn item_totp(&self, item_id: &str) -> AgateResult<TotpCode> {
        let entry = self.find_entry(item_id)?;
        let secret = non_empty(entry.get_raw_otp_value())
            .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))?;
        let now = Utc::now();
        let response = generate_totp(secret, Some(now))
            .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("TOTP failed: {e}")))?;
        let period = response.period;
        let remaining = if period == 0 { 0 } else { period - (now.timestamp() as u32 % period) };
        Ok(TotpCode { code: response.code, period, remaining })
    }

    /// Every group except the root and the recycle-bin subtree, as
    /// "A/B"-path-named folders.
    pub fn list_folders(&self, id: &str, label: &str) -> Vec<Folder> {
        let bin = bin_group_ids(&self.db);
        let root = self.db.root().id();
        let mut out = Vec::new();
        for group in self.db.iter_all_groups() {
            let gid = group.id();
            if gid == root || bin.contains(&gid) {
                continue;
            }
            out.push(Folder {
                id: Some(gid.uuid().to_string()),
                name: group_path(&self.db, gid),
                account_email: id.to_string(),
                account_label: label.to_string(),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        out
    }

    /// KeePass has no collections — always empty.
    pub fn list_collections(&self, _id: &str, _label: &str) -> Vec<Collection> {
        Vec::new()
    }

    /// How many non-deleted entries use `candidate` as their password.
    pub fn count_password_use(&self, candidate: &str) -> u32 {
        if candidate.is_empty() {
            return 0;
        }
        let bin = bin_group_ids(&self.db);
        let mut count = 0u32;
        for e in self.db.iter_all_entries() {
            if bin.contains(&e.parent().id()) {
                continue;
            }
            if e.get_password() == Some(candidate) {
                count += 1;
            }
        }
        count
    }
}

// ── internals ────────────────────────────────────────────────────────────────

impl KeepassConnection {
    /// Build the composite key from the held material. `DatabaseKey` zeroizes
    /// on drop, so per-call construction never leaks copies.
    fn key(&self) -> AgateResult<DatabaseKey> {
        let mut key = DatabaseKey::new().with_password(self.password.as_str());
        if let Some(bytes) = &self.keyfile {
            let mut reader: &[u8] = bytes.as_slice();
            key = key.with_keyfile(&mut reader).map_err(|e| {
                AgateError::new(ErrorKind::Crypto, format!("Could not parse the key file: {e}"))
            })?;
        }
        Ok(key)
    }

    fn read_from_disk(&mut self) -> AgateResult<()> {
        // Capture the mtime BEFORE reading: if the file changes between stat and
        // read we hold the older stamp and the next save conflicts (the safe
        // direction — never silently overwrite).
        let mtime = match std::fs::metadata(&self.path) {
            Ok(meta) => meta.modified().ok(),
            Err(e) => {
                return Err(AgateError::bad_request(format!(
                    "Cannot open the KeePass database file: {e}"
                )))
            }
        };
        if mtime.is_none() {
            log::warn!(
                "KeePass database filesystem reports no modification time; \
                 concurrent-change detection is disabled"
            );
        }
        let mut file = std::fs::File::open(&self.path).map_err(|e| {
            AgateError::bad_request(format!("Cannot open the KeePass database file: {e}"))
        })?;
        let db = Database::open(&mut file, self.key()?).map_err(map_open_error)?;
        self.writable = matches!(db.config.version, DatabaseVersion::KDB4(_));
        self.db = db;
        self.mtime = mtime;
        Ok(())
    }

    fn require_writable(&self) -> AgateResult<()> {
        if self.writable {
            Ok(())
        } else {
            Err(AgateError::bad_request(
                "This database uses a pre-KDBX4 format Agate cannot write. \
                 Upgrade it to KDBX4 in your KeePass app first.",
            ))
        }
    }

    /// The held mtime must still match the file on disk, or someone else wrote
    /// it since we read it.
    fn check_disk_unchanged(&self) -> AgateResult<()> {
        let Some(held) = self.mtime else { return Ok(()) };
        let on_disk = std::fs::metadata(&self.path)
            .and_then(|m| m.modified())
            .map_err(|e| {
                AgateError::internal(format!(
                    "Cannot check the KeePass database for external changes: {e}"
                ))
            })?;
        if on_disk != held {
            return Err(AgateError::bad_request(
                "The KeePass database changed on disk — sync first, then retry.",
            ));
        }
        Ok(())
    }

    /// Run a mutation against the in-memory database and persist it atomically.
    /// On ANY failure (mutation or save) the in-memory database is rolled back
    /// to the pre-mutation snapshot, so memory never diverges from disk.
    fn mutate_and_save<T>(
        &mut self,
        mutate: impl FnOnce(&mut Database) -> AgateResult<T>,
    ) -> AgateResult<T> {
        self.require_writable()?;
        self.check_disk_unchanged()?;
        let snapshot = self.db.clone();
        let out = match mutate(&mut self.db) {
            Ok(value) => value,
            Err(e) => {
                self.db = snapshot;
                return Err(e);
            }
        };
        if let Err(e) = self.save_to_disk() {
            self.db = snapshot;
            return Err(e);
        }
        Ok(out)
    }

    /// The atomic save: temp file in the same directory → reopen + verify →
    /// `.bak` the current file → rename the temp over the original → refresh
    /// the held mtime. A failure at any step leaves the original untouched.
    fn save_to_disk(&mut self) -> AgateResult<()> {
        self.require_writable()?;
        self.check_disk_unchanged()?;

        let dir = match self.path.parent() {
            Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
            _ => PathBuf::from("."),
        };

        // Same directory = same filesystem, so the final persist is an atomic
        // rename, never a cross-device copy.
        let mut tmp = tempfile::Builder::new()
            .prefix(".agate-save-")
            .suffix(".kdbx.tmp")
            .tempfile_in(dir)
            .map_err(|e| {
                AgateError::internal(format!(
                    "Could not create a scratch file next to the database: {e}"
                ))
            })?;
        self.db.save(tmp.as_file_mut(), self.key()?).map_err(|e| {
            AgateError::new(ErrorKind::Crypto, format!("Could not serialize the KeePass database: {e}"))
        })?;
        tmp.as_file()
            .sync_all()
            .map_err(|e| AgateError::internal(format!("Could not flush the saved database: {e}")))?;

        // Verify BEFORE touching the original: the temp must reopen with the
        // same key and carry the expected entry/group counts.
        tmp.as_file_mut().rewind().map_err(|e| {
            AgateError::internal(format!("Could not rewind the saved database for verification: {e}"))
        })?;
        let reread = Database::open(tmp.as_file_mut(), self.key()?).map_err(|e| {
            AgateError::new(
                ErrorKind::Crypto,
                format!("Save verification failed — the database was NOT replaced: {e}"),
            )
        })?;
        if reread.num_entries() != self.db.num_entries()
            || reread.num_groups() != self.db.num_groups()
        {
            return Err(AgateError::internal(
                "Save verification failed (entry/group count mismatch) — the database was NOT replaced.",
            ));
        }

        // Keep the previous version as <file>.bak (overwrite an older .bak),
        // then atomically swap the verified temp in. `NamedTempFile::persist`
        // replaces an existing destination on every platform (MoveFileExW with
        // MOVEFILE_REPLACE_EXISTING on Windows).
        std::fs::copy(&self.path, backup_path(&self.path))
            .map_err(|e| AgateError::internal(format!("Could not write the .bak backup: {e}")))?;
        tmp.persist(&self.path).map_err(|e| {
            AgateError::internal(format!("Could not replace the database file: {e}"))
        })?;

        self.mtime = std::fs::metadata(&self.path).and_then(|m| m.modified()).ok();
        Ok(())
    }

    fn find_entry(&self, item_id: &str) -> AgateResult<EntryRef<'_>> {
        let eid = EntryId::from_uuid(parse_uuid(item_id, "No such item.")?);
        self.db
            .entry(eid)
            .ok_or_else(|| AgateError::bad_request("No such item."))
    }
}

// ── pure helpers ─────────────────────────────────────────────────────────────

fn parse_uuid(value: &str, not_found: &str) -> AgateResult<uuid::Uuid> {
    uuid::Uuid::parse_str(value).map_err(|_| AgateError::bad_request(not_found))
}

fn parse_entry_ids(ids: &[String]) -> AgateResult<Vec<EntryId>> {
    ids.iter()
        .map(|id| Ok(EntryId::from_uuid(parse_uuid(id, "No such item.")?)))
        .collect()
}

fn map_open_error(e: DatabaseOpenError) -> AgateError {
    match e {
        DatabaseOpenError::Key(DatabaseKeyError::IncorrectKey) => AgateError::new(
            ErrorKind::InvalidCredentials,
            "Wrong password or key file for this KeePass database.",
        ),
        DatabaseOpenError::Key(other) => {
            AgateError::new(ErrorKind::Crypto, format!("Key error: {other}"))
        }
        DatabaseOpenError::UnsupportedVersion => {
            AgateError::bad_request("Unsupported KeePass database version.")
        }
        DatabaseOpenError::VersionParse(e) => {
            AgateError::bad_request(format!("Not a valid KeePass database file: {e}"))
        }
        DatabaseOpenError::Io(e) => {
            AgateError::internal(format!("Could not read the KeePass database: {e}"))
        }
        other => AgateError::new(
            ErrorKind::Crypto,
            format!("Could not decrypt the KeePass database: {other}"),
        ),
    }
}

/// Config for a database Agate creates. Starts from the crate default (KDBX4,
/// AES-256 outer, ChaCha20 inner) but re-tunes the KDF: the crate's default is
/// ~1 GiB Argon2 at 50 iterations (≈10 s per open in the tray) — far heavier
/// than needed. Use Argon2id at KeePassXC-like cost so created vaults open
/// quickly, reusing the default's argon2 *version* value (so we never pin the
/// `argon2` crate's `Version` type ourselves).
fn new_database_config() -> DatabaseConfig {
    let mut config = DatabaseConfig::default();
    let version = match &config.kdf_config {
        KdfConfig::Argon2 { version, .. } | KdfConfig::Argon2id { version, .. } => Some(*version),
        // AES KDF (or any future variant): keep the crate default untouched.
        _ => None,
    };
    if let Some(version) = version {
        config.kdf_config = KdfConfig::Argon2id {
            iterations: 10,
            memory: 64 * 1024, // 64 MiB
            parallelism: 4,
            version,
        };
    }
    config
}

fn backup_path(path: &Path) -> PathBuf {
    let mut os = path.as_os_str().to_os_string();
    os.push(".bak");
    PathBuf::from(os)
}

fn non_empty(value: Option<&str>) -> Option<String> {
    value.filter(|v| !v.is_empty()).map(str::to_string)
}

/// KDBX times are naive UTC; render RFC 3339 (missing times fall back to epoch
/// so the DTO's non-optional dates stay valid).
fn rfc3339(time: Option<NaiveDateTime>) -> String {
    time.unwrap_or_else(Times::epoch).and_utc().to_rfc3339()
}

/// Login when any login-shaped field is non-empty, otherwise a secure note
/// (KeePass apps create entries with all standard fields present-but-empty, so
/// presence alone would make every note a login).
fn entry_item_type(entry: &Entry) -> ItemType {
    let login_marker = [kpf::USERNAME, kpf::PASSWORD, kpf::URL, kpf::OTP]
        .iter()
        .any(|field| entry.get(field).is_some_and(|v| !v.is_empty()));
    if login_marker {
        ItemType::Login
    } else {
        ItemType::SecureNote
    }
}

fn has_favorite_tag(entry: &Entry) -> bool {
    entry.tags.iter().any(|t| t.eq_ignore_ascii_case(FAVORITE_TAG))
}

fn set_favorite_tag(entry: &mut Entry, favorite: bool) {
    entry.tags.retain(|t| !t.eq_ignore_ascii_case(FAVORITE_TAG));
    if favorite {
        entry.tags.push(FAVORITE_TAG.to_string());
    }
}

/// Whether a field name is one of the passkey `KPEX_PASSKEY_*` attributes —
/// managed by the passkey layer, never surfaced or editable as a custom field
/// (the private key must never reach the frontend or be clobbered by an edit).
fn is_passkey_field(name: &str) -> bool {
    name.starts_with(PASSKEY_FIELD_PREFIX)
}

/// Whether an entry carries a passkey (has a non-empty credential-id attribute).
fn entry_has_passkey(entry: &EntryRef<'_>) -> bool {
    entry.get(PASSKEY_CREDENTIAL_ID).is_some_and(|v| !v.is_empty())
}

fn bool_str(value: bool) -> &'static str {
    if value {
        "true"
    } else {
        "false"
    }
}

/// Write the `KPEX_PASSKEY_*` attributes (+ `Passkey` tag) for a passkey onto an
/// entry, leaving the entry's other fields (title/username/etc.) untouched — so
/// it works both for a fresh entry and for attaching to an existing login.
fn set_passkey_attrs(entry: &mut Entry, passkey: &StoredPasskey) {
    let cred_b64 = URL_SAFE_NO_PAD.encode(&passkey.credential_id);
    let handle_b64 = URL_SAFE_NO_PAD.encode(&passkey.user_handle);
    if let Some(name) = &passkey.user_name {
        entry.set_unprotected(PASSKEY_USERNAME, name.as_str());
    }
    entry.set_unprotected(PASSKEY_RELYING_PARTY, passkey.rp_id.as_str());
    entry.set_unprotected(PASSKEY_CREDENTIAL_ID, cred_b64.as_str());
    entry.set_unprotected(PASSKEY_USER_HANDLE, handle_b64.as_str());
    // The private key is the one secret here → store it protected.
    entry.set_protected(PASSKEY_PRIVATE_KEY_PEM, passkey.private_key_pem.as_str());
    entry.set_unprotected(PASSKEY_ALGORITHM, passkey.algorithm.label());
    entry.set_unprotected(PASSKEY_FLAG_BE, bool_str(passkey.backup_eligible));
    entry.set_unprotected(PASSKEY_FLAG_BS, bool_str(passkey.backup_state));
    if !entry.tags.iter().any(|t| t == PASSKEY_TAG) {
        entry.tags.push(PASSKEY_TAG.to_string());
    }
}

/// Strip every `KPEX_PASSKEY_*` attribute (+ the `Passkey` tag) from an entry,
/// removing the passkey while leaving the rest of the entry untouched.
fn strip_passkey_attrs(entry: &mut Entry) {
    for field in [
        PASSKEY_USERNAME,
        PASSKEY_RELYING_PARTY,
        PASSKEY_CREDENTIAL_ID,
        PASSKEY_USER_HANDLE,
        PASSKEY_PRIVATE_KEY_PEM,
        PASSKEY_ALGORITHM,
        PASSKEY_FLAG_BE,
        PASSKEY_FLAG_BS,
    ] {
        entry.fields.remove(field);
    }
    entry.tags.retain(|t| t != PASSKEY_TAG);
}

/// Read a passkey off an entry, or `None` when the entry holds no passkey (or
/// its base64 is unreadable — logged and skipped, never fatal to a lookup).
fn read_stored_passkey(entry: &EntryRef<'_>) -> Option<StoredPasskey> {
    let cred_b64 = entry.get(PASSKEY_CREDENTIAL_ID).filter(|s| !s.is_empty())?;
    let credential_id = match URL_SAFE_NO_PAD.decode(cred_b64) {
        Ok(bytes) => bytes,
        Err(e) => {
            log::warn!("skipping passkey entry with an unreadable credential id: {e}");
            return None;
        }
    };
    let user_handle = entry
        .get(PASSKEY_USER_HANDLE)
        .and_then(|s| URL_SAFE_NO_PAD.decode(s).ok())
        .unwrap_or_default();
    // A passkey written by another client has no ALGORITHM attribute; default to
    // ES256 (the common case) until the ceremony layer can infer it from the key.
    let algorithm = entry
        .get(PASSKEY_ALGORITHM)
        .and_then(CoseAlgorithm::from_label)
        .unwrap_or(CoseAlgorithm::Es256);
    Some(StoredPasskey {
        credential_id,
        rp_id: entry.get(PASSKEY_RELYING_PARTY).unwrap_or_default().to_string(),
        rp_name: None,
        user_handle,
        user_name: non_empty(entry.get(PASSKEY_USERNAME)),
        user_display_name: None,
        algorithm,
        private_key_pem: Zeroizing::new(
            entry.get(PASSKEY_PRIVATE_KEY_PEM).unwrap_or_default().to_string(),
        ),
        sign_count: 0,
        created: rfc3339(entry.times.creation),
        backup_eligible: entry.get(PASSKEY_FLAG_BE) == Some("true"),
        backup_state: entry.get(PASSKEY_FLAG_BS) == Some("true"),
    })
}

/// Every group id in the recycle-bin subtree (the bin itself included), or
/// empty when the database has no bin. Entries whose parent is in this set are
/// "deleted".
fn bin_group_ids(db: &Database) -> HashSet<GroupId> {
    let mut out = HashSet::new();
    if let Some(bin) = db.recycle_bin() {
        collect_group_subtree(db, bin.id(), &mut out);
    }
    out
}

fn collect_group_subtree(db: &Database, id: GroupId, out: &mut HashSet<GroupId>) {
    if !out.insert(id) {
        return; // already visited (defensive against malformed trees)
    }
    if let Some(group) = db.group(id) {
        let children: Vec<GroupId> = group.group_ids().collect();
        for child in children {
            collect_group_subtree(db, child, out);
        }
    }
}

fn subtree_entry_ids(db: &Database, gid: GroupId) -> Vec<EntryId> {
    let mut groups = HashSet::new();
    collect_group_subtree(db, gid, &mut groups);
    let mut out = Vec::new();
    for id in groups {
        if let Some(group) = db.group(id) {
            out.extend(group.entry_ids());
        }
    }
    out
}

/// The group's full path from (but excluding) the root, joined with "/".
fn group_path(db: &Database, id: GroupId) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut cursor = Some(id);
    while let Some(gid) = cursor {
        let Some(group) = db.group(gid) else { break };
        match group.parent().map(|p| p.id()) {
            Some(parent) => {
                parts.push(group.name.clone());
                cursor = Some(parent);
            }
            None => cursor = None, // reached the root — not part of the path
        }
    }
    parts.reverse();
    parts.join("/")
}

fn entry_to_list_item(
    entry: &EntryRef<'_>,
    id: &str,
    label: &str,
    root: GroupId,
    bin: &HashSet<GroupId>,
) -> VaultItem {
    let parent = entry.parent().id();
    VaultItem {
        id: entry.id().uuid().to_string(),
        account_email: id.to_string(),
        account_label: label.to_string(),
        name: entry.get_title().unwrap_or_default().to_string(),
        item_type: entry_item_type(entry),
        username: non_empty(entry.get_username()),
        uri: non_empty(entry.get_url()),
        has_totp: non_empty(entry.get_raw_otp_value()).is_some(),
        has_passkey: entry_has_passkey(entry),
        reprompt: false,
        favorite: has_favorite_tag(entry),
        deleted: bin.contains(&parent),
        folder_id: (parent != root).then(|| parent.uuid().to_string()),
        organization_id: None,
    }
}

// ── write helpers (free functions so `mutate_and_save` closures can use them) ─

fn resolve_target_group(db: &Database, folder_id: Option<&str>) -> AgateResult<GroupId> {
    match folder_id {
        None => Ok(db.root().id()),
        Some(fid) => {
            let gid = GroupId::from_uuid(parse_uuid(fid, "No such folder.")?);
            if db.group(gid).is_some() {
                Ok(gid)
            } else {
                Err(AgateError::bad_request("No such folder."))
            }
        }
    }
}

fn move_entry(db: &mut Database, eid: EntryId, target: GroupId) -> AgateResult<()> {
    let parent = db
        .entry(eid)
        .ok_or_else(|| AgateError::bad_request("No such item."))?
        .parent()
        .id();
    if parent == target {
        return Ok(());
    }
    let mut entry = db
        .entry_mut(eid)
        .ok_or_else(|| AgateError::bad_request("No such item."))?;
    entry
        .move_to(target)
        .map_err(|e| AgateError::internal(format!("Move failed: {e}")))?;
    entry.times.location_changed = Some(Times::now());
    Ok(())
}

/// Apply the parts of an `ItemInput` that the input owns onto an entry. Plain
/// `&mut Entry` so it works for both creates (`EntryMut`) and tracked edits
/// (`EntryTrack`) via deref.
fn apply_input(entry: &mut Entry, input: &ItemInput) {
    set_or_remove(entry, kpf::TITLE, Some(input.name.as_str()), false);
    set_or_remove(entry, kpf::NOTES, input.notes.as_deref(), false);
    if let Some(login) = &input.login {
        set_or_remove(entry, kpf::USERNAME, login.username.as_deref(), false);
        set_or_remove(entry, kpf::PASSWORD, login.password.as_deref(), true);
        set_or_remove(entry, kpf::OTP, login.totp.as_deref(), true);
        let first_uri = login.uris.iter().find_map(|u| u.uri.as_deref().filter(|v| !v.is_empty()));
        set_or_remove(entry, kpf::URL, first_uri, false);
        if login.uris.iter().filter(|u| u.uri.as_deref().is_some_and(|v| !v.is_empty())).count() > 1
        {
            log::warn!("KeePass entries store a single URL; extra URIs were not saved");
        }
    }
    // Custom fields are merge-upserts: a named field is set (or removed when its
    // value is None); fields the input does not name are left untouched, so
    // KeePass-side data (plugin fields, etc.) survives Agate edits.
    for field in &input.fields {
        let Some(name) = field.name.as_deref().filter(|n| !n.is_empty()) else { continue };
        if RESERVED_FIELDS.contains(&name) {
            log::warn!("ignoring custom field that collides with a standard KeePass field");
            continue;
        }
        if is_passkey_field(name) {
            log::warn!("ignoring custom field that collides with a passkey attribute");
            continue;
        }
        match field.value.as_deref() {
            // 1 = Hidden (see FieldInput) → KeePass protected value.
            Some(value) if field.field_type == 1 => entry.set_protected(name, value),
            Some(value) => entry.set_unprotected(name, value),
            None => {
                entry.fields.remove(name);
            }
        }
    }
    set_favorite_tag(entry, input.favorite);
}

/// Whether a custom-field name is an additional-URL field (`KP2A_URL` or
/// `KP2A_URL_<n>` for a numeric suffix).
fn is_additional_url_field(name: &str) -> bool {
    if name == ADDITIONAL_URL_FIELD {
        return true;
    }
    match name.strip_prefix(&format!("{ADDITIONAL_URL_FIELD}_")) {
        Some(suffix) => !suffix.is_empty() && suffix.bytes().all(|b| b.is_ascii_digit()),
        None => false,
    }
}

/// The next free additional-URL field name given the ones already used: prefer the
/// bare `KP2A_URL`, then `KP2A_URL_1`, `KP2A_URL_2`, … finding the first gap.
fn next_additional_url_key(used: &[String]) -> String {
    if !used.iter().any(|k| k == ADDITIONAL_URL_FIELD) {
        return ADDITIONAL_URL_FIELD.to_string();
    }
    let mut n = 1u32;
    loop {
        let candidate = format!("{ADDITIONAL_URL_FIELD}_{n}");
        if !used.contains(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Add `uri` to an entry's autofill URLs, choosing the right slot: the primary
/// `URL` field when empty, else the next free `KP2A_URL` field. No-op when the URL
/// is already present (primary or additional).
fn add_additional_url(entry: &mut Entry, uri: &str) {
    let primary = entry.get_url().map(str::to_string);
    if primary.as_deref() == Some(uri) {
        return;
    }
    let mut used_keys: Vec<String> = Vec::new();
    for (name, value) in entry.fields.iter() {
        if is_additional_url_field(name) {
            if value.get() == uri {
                return; // already associated
            }
            used_keys.push(name.clone());
        }
    }
    if primary.as_deref().filter(|v| !v.is_empty()).is_none() {
        entry.set_unprotected(kpf::URL, uri);
    } else {
        entry.set_unprotected(next_additional_url_key(&used_keys), uri);
    }
}

fn set_or_remove(entry: &mut Entry, key: &str, value: Option<&str>, protected: bool) {
    match value.filter(|v| !v.is_empty()) {
        Some(v) if protected => entry.set_protected(key, v),
        Some(v) => entry.set_unprotected(key, v),
        None => {
            entry.fields.remove(key);
        }
    }
}

/// Edit in place: mutate ONLY what the input owns, push the pre-edit state
/// into the entry's KeePass history, then move it if the target group changed.
fn edit_entry(db: &mut Database, eid: EntryId, input: &ItemInput, target: GroupId) -> AgateResult<()> {
    {
        let mut entry = db
            .entry_mut(eid)
            .ok_or_else(|| AgateError::bad_request("No such item."))?;
        entry.edit_tracking(|tracked| {
            apply_input(tracked, input);
            tracked.times.last_modification = Some(Times::now());
        });
    }
    move_entry(db, eid, target)
}

fn create_entry(db: &mut Database, input: &ItemInput, target: GroupId) -> AgateResult<()> {
    let mut group = db
        .group_mut(target)
        .ok_or_else(|| AgateError::bad_request("No such folder."))?;
    let mut entry = group.add_entry();
    apply_input(&mut entry, input);
    Ok(())
}

/// The recycle-bin group, created + enabled on first use (KeePassXC style).
fn ensure_recycle_bin(db: &mut Database) -> GroupId {
    if let Some(bin) = db.recycle_bin() {
        return bin.id();
    }
    let id = db
        .root_mut()
        .add_group()
        .edit(|g| {
            g.name = RECYCLE_BIN_NAME.to_string();
            g.enable_autotype = Some(false);
            g.enable_searching = Some(false);
            g.set_icon_builtin(43); // the standard KeePass trash icon
        })
        .id();
    db.meta.recyclebin_uuid = Some(id.uuid());
    db.meta.recyclebin_enabled = Some(true);
    db.meta.recyclebin_changed = Some(Times::now());
    id
}

fn split_folder_path(name: &str) -> AgateResult<Vec<String>> {
    let segments: Vec<String> = name
        .split('/')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    if segments.is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    Ok(segments)
}

/// Find a child group by name (case-insensitive, like the KeePass tree) or
/// create it.
fn find_or_create_child_group(db: &mut Database, parent: GroupId, name: &str) -> AgateResult<GroupId> {
    let existing = db
        .group(parent)
        .and_then(|g| g.group_by_name(name).map(|child| child.id()));
    if let Some(id) = existing {
        return Ok(id);
    }
    let mut group = db
        .group_mut(parent)
        .ok_or_else(|| AgateError::internal("Parent folder disappeared during folder creation."))?;
    Ok(group.add_group().edit(|g| g.name = name.to_string()).id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use keepass::config::{DatabaseConfig, KdfConfig};
    use keepass::db::Value;

    use crate::dto::{CardInput, FieldInput, LoginInput, UriInput};

    const PASSWORD: &str = "test-master-password";
    const OTPAUTH: &str = "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub";

    /// Default KDBX4 config costs ~1 GiB of Argon2 per open; tests open the
    /// database dozens of times, so use a trivial AES KDF instead.
    fn cheap_config() -> DatabaseConfig {
        let mut config = DatabaseConfig::default();
        config.kdf_config = KdfConfig::Aes { rounds: 16 };
        config
    }

    fn save_to(path: &Path, db: &Database) {
        let mut file = std::fs::File::create(path).unwrap();
        db.save(&mut file, DatabaseKey::new().with_password(PASSWORD)).unwrap();
        file.sync_all().unwrap();
    }

    fn open_raw(path: &Path) -> Database {
        let mut file = std::fs::File::open(path).unwrap();
        Database::open(&mut file, DatabaseKey::new().with_password(PASSWORD)).unwrap()
    }

    struct Fixture {
        // Held for its Drop (deletes the directory).
        _dir: tempfile::TempDir,
        path: PathBuf,
        github_id: String,
        note_id: String,
        work_id: String,
        dev_id: String,
        dev_entry_id: String,
    }

    /// Root: "GitHub" login (otp + protected/plain custom fields + attachment,
    /// Favorite tag) and a "Backup codes" note; nested groups Work/Dev with a
    /// "Dev box" login inside Dev.
    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.kdbx");

        let mut db = Database::with_config(cheap_config());
        let work = db.root_mut().add_group().edit(|g| g.name = "Work".into()).id();
        let dev = db.group_mut(work).unwrap().add_group().edit(|g| g.name = "Dev".into()).id();

        let github = db
            .root_mut()
            .add_entry()
            .edit(|e| {
                e.set_unprotected(kpf::TITLE, "GitHub");
                e.set_unprotected(kpf::USERNAME, "octocat");
                e.set_protected(kpf::PASSWORD, "hunter2");
                e.set_unprotected(kpf::URL, "https://github.com/login");
                e.set_protected(kpf::OTP, OTPAUTH);
                e.set_unprotected(kpf::NOTES, "main account");
                e.set_protected("API Key", "secret-api-key");
                e.set_unprotected("Plan", "pro");
                e.add_attachment("readme.txt", Value::unprotected(b"hello".to_vec()));
                e.tags.push(FAVORITE_TAG.to_string());
            })
            .id();

        let note = db
            .root_mut()
            .add_entry()
            .edit(|e| {
                e.set_unprotected(kpf::TITLE, "Backup codes");
                e.set_unprotected(kpf::NOTES, "1234 5678");
                // present-but-empty standard fields, like KeePass apps create
                e.set_unprotected(kpf::USERNAME, "");
                e.set_unprotected(kpf::PASSWORD, "");
            })
            .id();

        let dev_entry = db
            .group_mut(dev)
            .unwrap()
            .add_entry()
            .edit(|e| {
                e.set_unprotected(kpf::TITLE, "Dev box");
                e.set_unprotected(kpf::USERNAME, "root");
                e.set_protected(kpf::PASSWORD, "hunter2");
            })
            .id();

        save_to(&path, &db);
        Fixture {
            _dir: dir,
            path,
            github_id: github.uuid().to_string(),
            note_id: note.uuid().to_string(),
            work_id: work.uuid().to_string(),
            dev_id: dev.uuid().to_string(),
            dev_entry_id: dev_entry.uuid().to_string(),
        }
    }

    fn open_conn(path: &Path) -> KeepassConnection {
        KeepassConnection::open(path, PASSWORD, None).unwrap()
    }

    fn login_input(name: &str, folder_id: Option<String>) -> ItemInput {
        ItemInput {
            id: None,
            item_type: ItemType::Login,
            name: name.to_string(),
            folder_id,
            organization_id: None,
            collection_ids: Vec::new(),
            favorite: false,
            reprompt: false,
            notes: None,
            login: Some(LoginInput {
                username: Some("user".into()),
                password: Some("pw".into()),
                totp: None,
                uris: vec![UriInput { uri: Some("https://example.com".into()), match_type: None }],
                autofill_on_page_load: None,
            }),
            card: None,
            identity: None,
            ssh_key: None,
            fields: Vec::new(),
        }
    }

    // ── open ────────────────────────────────────────────────────────────────

    #[test]
    fn open_with_wrong_password_is_invalid_credentials() {
        let fx = fixture();
        let err = KeepassConnection::open(&fx.path, "wrong-password", None).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::InvalidCredentials), "got: {err}");

        // right password opens
        assert!(KeepassConnection::open(&fx.path, PASSWORD, None).is_ok());
    }

    #[test]
    fn open_missing_file_is_bad_request() {
        let dir = tempfile::tempdir().unwrap();
        let err =
            KeepassConnection::open(&dir.path().join("nope.kdbx"), PASSWORD, None).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }

    #[test]
    fn create_makes_a_writable_kdbx4_that_reopens_and_persists() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("new.kdbx");

        let mut conn = KeepassConnection::create(&path, PASSWORD, None).unwrap();
        assert!(path.exists(), "the database file was written");
        assert!(conn.list_items("kp", "KeePass").is_empty(), "a new vault starts empty");

        // It's a writable KDBX4: a create persists, and survives a cold reopen
        // with the same password (proving the key + format are sound).
        conn.save_item(&login_input("First", None)).unwrap();
        let reopened = KeepassConnection::open(&path, PASSWORD, None).unwrap();
        assert!(
            reopened.list_items("kp", "KeePass").iter().any(|i| i.name == "First"),
            "the created database is openable and writable"
        );

        // The wrong password cannot open it.
        let err = KeepassConnection::open(&path, "nope", None).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::InvalidCredentials), "got: {err}");
    }

    #[test]
    fn create_refuses_to_overwrite_an_existing_file() {
        let fx = fixture(); // fx.path already holds a database
        let err = KeepassConnection::create(&fx.path, PASSWORD, None).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
        assert!(err.message.contains("already exists"), "got: {}", err.message);

        // The original file is untouched (still openable, still has its entries).
        let conn = open_conn(&fx.path);
        assert_eq!(conn.list_items("kp", "KeePass").len(), 3);
    }

    // ── reads ───────────────────────────────────────────────────────────────

    #[test]
    fn list_items_maps_types_favorite_and_folders() {
        let fx = fixture();
        let conn = open_conn(&fx.path);
        let items = conn.list_items("kp", "KeePass");
        assert_eq!(items.len(), 3);

        let github = items.iter().find(|i| i.id == fx.github_id).unwrap();
        assert_eq!(github.name, "GitHub");
        assert_eq!(github.item_type, ItemType::Login);
        assert_eq!(github.username.as_deref(), Some("octocat"));
        assert_eq!(github.uri.as_deref(), Some("https://github.com/login"));
        assert!(github.has_totp);
        assert!(github.favorite);
        assert!(!github.deleted);
        assert!(!github.has_passkey);
        assert!(!github.reprompt);
        assert_eq!(github.folder_id, None, "root entries have no folder");
        assert_eq!(github.organization_id, None);

        let note = items.iter().find(|i| i.id == fx.note_id).unwrap();
        assert_eq!(note.item_type, ItemType::SecureNote, "empty login fields stay a note");
        assert_eq!(note.username, None);
        assert!(!note.favorite);

        let dev = items.iter().find(|i| i.id == fx.dev_entry_id).unwrap();
        assert_eq!(dev.folder_id.as_deref(), Some(fx.dev_id.as_str()));
    }

    #[test]
    fn item_detail_maps_login_notes_and_custom_fields() {
        let fx = fixture();
        let conn = open_conn(&fx.path);
        let detail = conn.item_detail("kp", "KeePass", &fx.github_id).unwrap();

        assert_eq!(detail.item_type, ItemType::Login);
        assert_eq!(detail.notes.as_deref(), Some("main account"));
        assert!(detail.favorite);
        assert!(detail.collection_ids.is_empty());
        assert!(detail.passkeys.is_empty());

        let login = detail.login.as_ref().unwrap();
        assert_eq!(login.username.as_deref(), Some("octocat"));
        assert_eq!(login.password.as_deref(), Some("hunter2"));
        assert_eq!(login.totp.as_deref(), Some(OTPAUTH));
        assert!(login.has_totp);
        assert_eq!(login.uris.len(), 1);
        assert_eq!(login.uris[0].uri.as_deref(), Some("https://github.com/login"));

        let api_key = detail
            .fields
            .iter()
            .find(|f| f.name.as_deref() == Some("API Key"))
            .unwrap();
        assert_eq!(api_key.value.as_deref(), Some("secret-api-key"));
        assert_eq!(api_key.field_type, CustomFieldType::Hidden, "protected → hidden");

        let plan = detail.fields.iter().find(|f| f.name.as_deref() == Some("Plan")).unwrap();
        assert_eq!(plan.field_type, CustomFieldType::Text);

        // standard fields never leak through as custom fields
        assert!(detail.fields.iter().all(|f| f.name.as_deref() != Some("Password")));

        // dates render as parseable RFC 3339
        assert!(chrono::DateTime::parse_from_rfc3339(&detail.revision_date).is_ok());
        assert!(chrono::DateTime::parse_from_rfc3339(&detail.creation_date).is_ok());

        // a note has no login section
        let note = conn.item_detail("kp", "KeePass", &fx.note_id).unwrap();
        assert!(note.login.is_none());
        assert_eq!(note.notes.as_deref(), Some("1234 5678"));
    }

    #[test]
    fn item_totp_generates_six_digit_code() {
        let fx = fixture();
        let conn = open_conn(&fx.path);
        let totp = conn.item_totp(&fx.github_id).unwrap();
        assert_eq!(totp.code.len(), 6);
        assert!(totp.code.chars().all(|c| c.is_ascii_digit()), "code: {}", totp.code);
        assert_eq!(totp.period, 30);
        assert!(totp.remaining >= 1 && totp.remaining <= 30);

        // no otp field → typed error
        let err = conn.item_totp(&fx.note_id).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest));
    }

    #[test]
    fn folders_fields_reuse_and_autofill_views() {
        let fx = fixture();
        let conn = open_conn(&fx.path);

        let folders = conn.list_folders("kp", "KeePass");
        let names: Vec<&str> = folders.iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, vec!["Work", "Work/Dev"], "path-joined names, root excluded");
        assert_eq!(
            folders[1].id.as_deref(),
            Some(fx.dev_id.as_str()),
            "folder id = group uuid"
        );

        assert!(conn.list_collections("kp", "KeePass").is_empty());

        let field_names = conn.custom_field_names();
        assert_eq!(field_names, vec!["API Key".to_string(), "Plan".to_string()]);

        assert_eq!(conn.count_password_use("hunter2"), 2);
        assert_eq!(conn.count_password_use("not-used"), 0);
        assert_eq!(conn.count_password_use(""), 0);

        let matches = conn.autofill_entries("kp", "KeePass");
        assert_eq!(matches.len(), 2, "logins only — the note is excluded");
        let gh = matches.iter().find(|m| m.id == fx.github_id).unwrap();
        assert_eq!(gh.uris, vec!["https://github.com/login".to_string()]);
        assert_eq!(gh.username.as_deref(), Some("octocat"));
    }

    // ── writes ──────────────────────────────────────────────────────────────

    #[test]
    fn save_item_rejects_non_login_note_types() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        let mut input = login_input("Card", None);
        input.item_type = ItemType::Card;
        input.login = None;
        input.card = Some(CardInput {
            cardholder_name: None,
            number: None,
            brand: None,
            exp_month: None,
            exp_year: None,
            code: None,
        });
        let err = conn.save_item(&input).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest));
        assert!(err.message.contains("Only logins and secure notes"), "got: {}", err.message);
    }

    #[test]
    fn save_item_creates_login_in_folder_and_persists() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        let mut input = login_input("New Login", Some(fx.work_id.clone()));
        input.favorite = true;
        input.notes = Some("created by test".into());
        input.fields.push(FieldInput {
            name: Some("Env".into()),
            value: Some("prod".into()),
            field_type: 1, // Hidden
            linked_id: None,
        });
        conn.save_item(&input).unwrap();

        let items = conn.list_items("kp", "KeePass");
        let created = items.iter().find(|i| i.name == "New Login").unwrap();
        assert_eq!(created.item_type, ItemType::Login);
        assert_eq!(created.folder_id.as_deref(), Some(fx.work_id.as_str()));
        assert!(created.favorite);
        assert_eq!(created.uri.as_deref(), Some("https://example.com"));

        let detail = conn.item_detail("kp", "KeePass", &created.id).unwrap();
        assert_eq!(detail.notes.as_deref(), Some("created by test"));
        let env = detail.fields.iter().find(|f| f.name.as_deref() == Some("Env")).unwrap();
        assert_eq!(env.field_type, CustomFieldType::Hidden);
        assert_eq!(env.value.as_deref(), Some("prod"));

        // survives a cold reopen from disk
        let conn2 = open_conn(&fx.path);
        assert!(conn2.list_items("kp", "KeePass").iter().any(|i| i.name == "New Login"));
    }

    /// The headline edit guarantee: changing only the password must preserve
    /// everything the input doesn't carry — custom fields, attachments — and
    /// must push the pre-edit state into KeePass history.
    #[test]
    fn save_item_edit_preserves_uncarried_fields_attachments_and_history() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        let before = conn.item_detail("kp", "KeePass", &fx.github_id).unwrap();
        let before_login = before.login.clone().unwrap();

        let input = ItemInput {
            id: Some(fx.github_id.clone()),
            item_type: ItemType::Login,
            name: before.name.clone(),
            folder_id: before.folder_id.clone(),
            organization_id: None,
            collection_ids: Vec::new(),
            favorite: before.favorite,
            reprompt: false,
            notes: before.notes.clone(),
            login: Some(LoginInput {
                username: before_login.username.clone(),
                password: Some("new-password".into()),
                totp: before_login.totp.clone(),
                uris: before_login
                    .uris
                    .iter()
                    .map(|u| UriInput { uri: u.uri.clone(), match_type: u.match_type })
                    .collect(),
                autofill_on_page_load: None,
            }),
            card: None,
            identity: None,
            ssh_key: None,
            // deliberately does NOT carry the entry's custom fields
            fields: Vec::new(),
        };
        conn.save_item(&input).unwrap();

        let after = conn.item_detail("kp", "KeePass", &fx.github_id).unwrap();
        let after_login = after.login.unwrap();
        assert_eq!(after_login.password.as_deref(), Some("new-password"));
        assert_eq!(after_login.totp.as_deref(), Some(OTPAUTH), "totp carried → kept");
        assert!(after.favorite, "favorite tag preserved");
        assert_eq!(after.notes.as_deref(), Some("main account"));

        let api_key =
            after.fields.iter().find(|f| f.name.as_deref() == Some("API Key")).unwrap();
        assert_eq!(api_key.value.as_deref(), Some("secret-api-key"), "uncarried field survives");
        assert_eq!(api_key.field_type, CustomFieldType::Hidden, "protection survives");
        assert!(after.fields.iter().any(|f| f.name.as_deref() == Some("Plan")));

        // crate-level checks on the file actually written to disk
        let raw = open_raw(&fx.path);
        let entry = raw
            .entry(EntryId::from_uuid(uuid::Uuid::parse_str(&fx.github_id).unwrap()))
            .unwrap();
        assert!(entry.attachment_by_name("readme.txt").is_some(), "attachment survives");
        let history = entry.history.clone().unwrap();
        assert!(!history.get_entries().is_empty(), "edit pushed a history snapshot");
        assert_eq!(
            history.get_entries()[0].get_password(),
            Some("hunter2"),
            "history holds the pre-edit password"
        );
    }

    #[test]
    fn save_item_field_upsert_and_remove() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        let input = ItemInput {
            id: Some(fx.github_id.clone()),
            item_type: ItemType::Login,
            name: "GitHub".into(),
            folder_id: None,
            organization_id: None,
            collection_ids: Vec::new(),
            favorite: true,
            reprompt: false,
            notes: Some("main account".into()),
            login: Some(LoginInput {
                username: Some("octocat".into()),
                password: Some("hunter2".into()),
                totp: Some(OTPAUTH.into()),
                uris: vec![UriInput { uri: Some("https://github.com/login".into()), match_type: None }],
                autofill_on_page_load: None,
            }),
            card: None,
            identity: None,
            ssh_key: None,
            fields: vec![
                // update an existing field
                FieldInput { name: Some("Plan".into()), value: Some("enterprise".into()), field_type: 0, linked_id: None },
                // explicit remove: named with value None
                FieldInput { name: Some("API Key".into()), value: None, field_type: 1, linked_id: None },
                // reserved names are refused (never clobber the real password)
                FieldInput { name: Some("Password".into()), value: Some("evil".into()), field_type: 0, linked_id: None },
            ],
        };
        conn.save_item(&input).unwrap();

        let after = conn.item_detail("kp", "KeePass", &fx.github_id).unwrap();
        let plan = after.fields.iter().find(|f| f.name.as_deref() == Some("Plan")).unwrap();
        assert_eq!(plan.value.as_deref(), Some("enterprise"));
        assert!(
            after.fields.iter().all(|f| f.name.as_deref() != Some("API Key")),
            "value:None removes the named field"
        );
        assert_eq!(
            after.login.unwrap().password.as_deref(),
            Some("hunter2"),
            "a custom field named 'Password' must not clobber the real one"
        );
    }

    #[test]
    fn set_favorite_tag_roundtrip() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);

        conn.set_favorite(&fx.note_id, true).unwrap();
        let items = conn.list_items("kp", "KeePass");
        assert!(items.iter().find(|i| i.id == fx.note_id).unwrap().favorite);

        conn.set_favorite(&fx.note_id, false).unwrap();
        let items = conn.list_items("kp", "KeePass");
        assert!(!items.iter().find(|i| i.id == fx.note_id).unwrap().favorite);

        // persisted: the tag round-trips through the file
        let conn2 = open_conn(&fx.path);
        assert!(!conn2.list_items("kp", "KeePass").iter().find(|i| i.id == fx.note_id).unwrap().favorite);
    }

    #[test]
    fn additional_url_field_name_recognition() {
        assert!(is_additional_url_field("KP2A_URL"));
        assert!(is_additional_url_field("KP2A_URL_1"));
        assert!(is_additional_url_field("KP2A_URL_42"));
        assert!(!is_additional_url_field("KP2A_URL_"));
        assert!(!is_additional_url_field("KP2A_URLx"));
        assert!(!is_additional_url_field("URL"));
        assert!(!is_additional_url_field("Plan"));
    }

    #[test]
    fn next_additional_url_key_finds_the_first_gap() {
        assert_eq!(next_additional_url_key(&[]), "KP2A_URL");
        assert_eq!(next_additional_url_key(&["KP2A_URL".into()]), "KP2A_URL_1");
        assert_eq!(
            next_additional_url_key(&["KP2A_URL".into(), "KP2A_URL_1".into()]),
            "KP2A_URL_2"
        );
    }

    #[test]
    fn associate_uri_fills_empty_url_then_spills_to_additional_fields() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);

        // The note has no URL → the first association fills the primary URL field,
        // which makes it match an app association in the autofill index.
        conn.add_autofill_uri(&fx.note_id, "app://outlook").unwrap();
        // The GitHub login already has a URL → a new association spills into KP2A_URL.
        conn.add_autofill_uri(&fx.github_id, "https://github.example/login").unwrap();
        // Idempotent: re-adding an existing URL is a no-op, no extra field.
        conn.add_autofill_uri(&fx.github_id, "https://github.com/login").unwrap();
        conn.add_autofill_uri(&fx.github_id, "https://github.example/login").unwrap();

        // Round-trips through the file and feeds the matcher's URI list.
        let conn2 = open_conn(&fx.path);
        let entries = conn2.autofill_entries("kp", "KeePass");
        let note = entries.iter().find(|e| e.id == fx.note_id).unwrap();
        assert!(note.uris.iter().any(|u| u == "app://outlook"), "empty URL filled with association");

        let gh = entries.iter().find(|e| e.id == fx.github_id).unwrap();
        assert!(gh.uris.iter().any(|u| u == "https://github.com/login"), "primary URL preserved");
        assert!(
            gh.uris.iter().any(|u| u == "https://github.example/login"),
            "second URL added as an additional URL"
        );
        // No duplication from the idempotent re-adds.
        assert_eq!(gh.uris.iter().filter(|u| *u == "https://github.example/login").count(), 1);
    }

    #[test]
    fn move_items_changes_folder() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        conn.move_items(std::slice::from_ref(&fx.github_id), Some(&fx.work_id)).unwrap();
        let items = conn.list_items("kp", "KeePass");
        assert_eq!(
            items.iter().find(|i| i.id == fx.github_id).unwrap().folder_id.as_deref(),
            Some(fx.work_id.as_str())
        );

        conn.move_items(std::slice::from_ref(&fx.github_id), None).unwrap();
        let items = conn.list_items("kp", "KeePass");
        assert_eq!(items.iter().find(|i| i.id == fx.github_id).unwrap().folder_id, None);
    }

    #[test]
    fn delete_to_recycle_bin_restore_then_permanent() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);

        // soft delete → recycle bin (created on demand)
        conn.delete_items(std::slice::from_ref(&fx.dev_entry_id), false).unwrap();
        let items = conn.list_items("kp", "KeePass");
        let deleted = items.iter().find(|i| i.id == fx.dev_entry_id).unwrap();
        assert!(deleted.deleted, "entry under the bin subtree is deleted");

        // the bin group never shows up as a folder
        let folders = conn.list_folders("kp", "KeePass");
        assert!(folders.iter().all(|f| f.name != RECYCLE_BIN_NAME));

        // the bin exists + is enabled in the file on disk
        let raw = open_raw(&fx.path);
        assert!(raw.recycle_bin().is_some());
        assert_eq!(raw.meta.recyclebin_enabled, Some(true));

        // restore → back to its previous group
        conn.restore_items(std::slice::from_ref(&fx.dev_entry_id)).unwrap();
        let items = conn.list_items("kp", "KeePass");
        let restored = items.iter().find(|i| i.id == fx.dev_entry_id).unwrap();
        assert!(!restored.deleted);
        assert_eq!(restored.folder_id.as_deref(), Some(fx.dev_id.as_str()));

        // permanent delete → gone, also from the file on disk
        conn.delete_items(std::slice::from_ref(&fx.dev_entry_id), true).unwrap();
        assert!(conn.list_items("kp", "KeePass").iter().all(|i| i.id != fx.dev_entry_id));
        let raw = open_raw(&fx.path);
        assert!(raw
            .entry(EntryId::from_uuid(uuid::Uuid::parse_str(&fx.dev_entry_id).unwrap()))
            .is_none());
    }

    #[test]
    fn create_rename_delete_folder() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);

        // create a nested path → both groups appear
        let folder = conn.create_folder("Personal/Finance").unwrap();
        assert_eq!(folder.name, "Personal/Finance");
        let fid = folder.id.clone().unwrap();
        let names: Vec<String> =
            conn.list_folders("kp", "KeePass").iter().map(|f| f.name.clone()).collect();
        assert!(names.contains(&"Personal".to_string()));
        assert!(names.contains(&"Personal/Finance".to_string()));

        // put an item inside, so delete_folder can prove items survive
        conn.save_item(&login_input("Bank", Some(fid.clone()))).unwrap();

        // rename the leaf in place
        conn.rename_folder(&fid, "Personal/Money").unwrap();
        let names: Vec<String> =
            conn.list_folders("kp", "KeePass").iter().map(|f| f.name.clone()).collect();
        assert!(names.contains(&"Personal/Money".to_string()));
        assert!(!names.contains(&"Personal/Finance".to_string()));

        // rename with a different path prefix = move under the new parent
        conn.rename_folder(&fid, "Money").unwrap();
        let names: Vec<String> =
            conn.list_folders("kp", "KeePass").iter().map(|f| f.name.clone()).collect();
        assert!(names.contains(&"Money".to_string()));
        assert!(!names.contains(&"Personal/Money".to_string()));

        // delete the folder holding "Bank": the entry moves to root, never dies
        conn.delete_folder(&fid).unwrap();
        let items = conn.list_items("kp", "KeePass");
        let bank = items.iter().find(|i| i.name == "Bank").unwrap();
        assert_eq!(bank.folder_id, None, "entries of a deleted folder move to root");
        assert!(!bank.deleted);
        let names: Vec<String> =
            conn.list_folders("kp", "KeePass").iter().map(|f| f.name.clone()).collect();
        assert!(!names.contains(&"Money".to_string()));
    }

    // ── atomic save behavior ────────────────────────────────────────────────

    #[test]
    fn save_refuses_when_file_changed_on_disk_and_reload_recovers() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);

        // bump the file's mtime behind the connection's back
        let file = std::fs::File::options().write(true).open(&fx.path).unwrap();
        file.set_modified(SystemTime::UNIX_EPOCH + Duration::from_secs(1_000_000_000)).unwrap();
        drop(file);

        let err = conn.set_favorite(&fx.note_id, true).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
        assert!(err.message.contains("changed on disk"), "got: {}", err.message);

        // the failed write must not leave the in-memory db mutated
        let items = conn.list_items("kp", "KeePass");
        assert!(!items.iter().find(|i| i.id == fx.note_id).unwrap().favorite);

        // reload (the provider's sync) picks up the disk state; saving works again
        conn.reload().unwrap();
        conn.set_favorite(&fx.note_id, true).unwrap();
        let items = conn.list_items("kp", "KeePass");
        assert!(items.iter().find(|i| i.id == fx.note_id).unwrap().favorite);
    }

    #[test]
    fn save_writes_a_bak_of_the_previous_version() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        conn.set_favorite(&fx.note_id, true).unwrap();

        let bak = backup_path(&fx.path);
        assert!(bak.exists(), "a .bak of the previous file exists after a save");

        // the .bak is the PRE-save version, openable with the same key
        let raw = open_raw(&bak);
        let entry = raw
            .entry(EntryId::from_uuid(uuid::Uuid::parse_str(&fx.note_id).unwrap()))
            .unwrap();
        assert!(
            !entry.tags.iter().any(|t| t == FAVORITE_TAG),
            ".bak holds the previous (pre-favorite) version"
        );
    }

    #[test]
    fn reload_picks_up_external_changes() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);

        // someone else (e.g. KeePassXC) adds an entry and saves
        let mut external = open_raw(&fx.path);
        external.root_mut().add_entry().edit(|e| {
            e.set_unprotected(kpf::TITLE, "External");
            e.set_unprotected(kpf::USERNAME, "ext");
        });
        save_to(&fx.path, &external);

        conn.reload().unwrap();
        assert!(conn.list_items("kp", "KeePass").iter().any(|i| i.name == "External"));

        // and the refreshed mtime lets saves proceed again
        conn.set_favorite(&fx.note_id, true).unwrap();
    }

    // ── passkeys ──────────────────────────────────────────────────────────────

    fn sample_passkey(rp: &str) -> StoredPasskey {
        StoredPasskey {
            credential_id: vec![1, 2, 3, 4, 5, 6, 7, 8],
            rp_id: rp.to_string(),
            rp_name: Some("Example Site".into()),
            user_handle: vec![9, 8, 7],
            user_name: Some("octocat".into()),
            user_display_name: Some("Octo Cat".into()),
            algorithm: CoseAlgorithm::Es256,
            // The storage layer treats the PEM as an opaque protected blob — a
            // placeholder is enough here; real key material arrives with the
            // ceremony layer.
            private_key_pem: Zeroizing::new(
                "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n".into(),
            ),
            sign_count: 0,
            created: String::new(),
            backup_eligible: true,
            backup_state: true,
        }
    }

    #[test]
    fn passkey_create_find_get_roundtrips_through_disk() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        conn.create_passkey(&sample_passkey("github.com"), &PasskeyTarget::default()).unwrap();

        // reopened from disk → the credential persisted
        let conn2 = open_conn(&fx.path);
        let found = conn2.find_passkeys_for_rp("github.com").unwrap();
        assert_eq!(found.len(), 1);
        let pk = &found[0];
        assert_eq!(pk.rp_id, "github.com");
        assert_eq!(pk.credential_id, vec![1, 2, 3, 4, 5, 6, 7, 8]);
        assert_eq!(pk.user_handle, vec![9, 8, 7]);
        assert_eq!(pk.user_name.as_deref(), Some("octocat"));
        assert_eq!(pk.algorithm, CoseAlgorithm::Es256);
        assert!(pk.backup_eligible && pk.backup_state);
        assert!(pk.private_key_pem.contains("BEGIN PRIVATE KEY"));

        // lookup by credential id; unknown ids and other RPs return nothing
        assert!(conn2.get_passkey(&[1, 2, 3, 4, 5, 6, 7, 8]).unwrap().is_some());
        assert!(conn2.get_passkey(&[0, 0, 0, 0]).unwrap().is_none());
        assert!(conn2.find_passkeys_for_rp("example.org").unwrap().is_empty());
    }

    #[test]
    fn passkey_flags_has_passkey_and_detail_metadata_without_leaking_the_key() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        conn.create_passkey(&sample_passkey("github.com"), &PasskeyTarget::default()).unwrap();
        let conn2 = open_conn(&fx.path);

        let items = conn2.list_items("kp", "KeePass");
        let row = items.iter().find(|i| i.has_passkey).expect("a row flags has_passkey");

        let detail = conn2.item_detail("kp", "KeePass", &row.id).unwrap();
        assert_eq!(detail.passkeys.len(), 1);
        assert_eq!(detail.passkeys[0].rp_id, "github.com");
        assert_eq!(detail.passkeys[0].key_algorithm, "ES256");
        assert_eq!(detail.passkeys[0].user_name.as_deref(), Some("octocat"));

        // SECURITY: the KPEX_PASSKEY_* attributes (incl. the private key) must
        // never surface as user-visible/editable custom fields.
        assert!(
            detail
                .fields
                .iter()
                .all(|f| f.name.as_deref().is_none_or(|n| !n.starts_with("KPEX_PASSKEY_"))),
            "passkey attributes leaked into custom fields: {:?}",
            detail.fields
        );
        assert!(!conn2.custom_field_names().iter().any(|n| n.starts_with("KPEX_PASSKEY_")));
    }

    #[test]
    fn passkey_uses_keepassxc_compatible_attributes() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        conn.create_passkey(&sample_passkey("github.com"), &PasskeyTarget::default()).unwrap();

        // Open the file with the raw crate (no Agate) and assert the exact
        // KeePassXC attribute names + that the private key is stored protected.
        let raw = open_raw(&fx.path);
        let entry = raw
            .iter_all_entries()
            .find(|e| e.get("KPEX_PASSKEY_RELYING_PARTY") == Some("github.com"))
            .expect("a KeePassXC-named passkey entry exists");
        assert!(entry.get("KPEX_PASSKEY_CREDENTIAL_ID").is_some());
        assert!(entry.get("KPEX_PASSKEY_USER_HANDLE").is_some());
        assert_eq!(entry.get("KPEX_PASSKEY_USERNAME"), Some("octocat"));
        assert!(
            entry.fields.get("KPEX_PASSKEY_PRIVATE_KEY_PEM").unwrap().is_protected(),
            "the passkey private key must be stored protected"
        );
        assert!(entry.tags.iter().any(|t| t == "Passkey"), "passkey entry carries the Passkey tag");
    }

    #[test]
    fn passkey_remove_strips_it_without_deleting_the_item() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        // attach a passkey to the GitHub login, then remove just the passkey
        let target = PasskeyTarget { item_id: Some(fx.github_id.clone()), folder_id: None };
        conn.create_passkey(&sample_passkey("github.com"), &target).unwrap();
        conn.remove_passkey(&[1, 2, 3, 4, 5, 6, 7, 8]).unwrap();

        let conn2 = open_conn(&fx.path);
        // the passkey is gone from lookups + a cold reopen...
        assert!(conn2.find_passkeys_for_rp("github.com").unwrap().is_empty());
        assert!(conn2.get_passkey(&[1, 2, 3, 4, 5, 6, 7, 8]).unwrap().is_none());
        // ...but the GitHub login is INTACT (not deleted; its fields preserved)
        let detail = conn2.item_detail("kp", "KeePass", &fx.github_id).unwrap();
        assert!(detail.passkeys.is_empty(), "passkey metadata gone");
        assert_eq!(detail.login.as_ref().unwrap().password.as_deref(), Some("hunter2"));
        assert!(
            conn2.list_items("kp", "KeePass").iter().any(|i| i.id == fx.github_id && !i.has_passkey),
            "the login item still exists, without a passkey"
        );

        // removing an unknown credential is a typed error, not a panic
        let mut conn3 = open_conn(&fx.path);
        let err = conn3.remove_passkey(&[0, 0]).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }

    #[test]
    fn passkey_attaches_to_an_existing_item() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        // attach a passkey to the user's existing GitHub login
        let target = PasskeyTarget { item_id: Some(fx.github_id.clone()), folder_id: None };
        conn.create_passkey(&sample_passkey("github.com"), &target).unwrap();

        let conn2 = open_conn(&fx.path);
        // no NEW entry was created — still the fixture's 3 items
        assert_eq!(conn2.list_items("kp", "KeePass").len(), 3);
        // the GitHub item now carries the passkey AND keeps its login fields
        let detail = conn2.item_detail("kp", "KeePass", &fx.github_id).unwrap();
        assert_eq!(detail.passkeys.len(), 1);
        let login = detail.login.as_ref().unwrap();
        assert_eq!(login.username.as_deref(), Some("octocat"));
        assert_eq!(login.password.as_deref(), Some("hunter2"), "attaching a passkey preserves the login");

        // a second passkey on the same item is refused
        let mut conn3 = open_conn(&fx.path);
        let err = conn3.create_passkey(&sample_passkey("github.com"), &target).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest), "got: {err}");
    }

    #[test]
    fn passkey_creates_new_item_in_target_folder() {
        let fx = fixture();
        let mut conn = open_conn(&fx.path);
        let target = PasskeyTarget { item_id: None, folder_id: Some(fx.work_id.clone()) };
        conn.create_passkey(&sample_passkey("example.com"), &target).unwrap();

        let conn2 = open_conn(&fx.path);
        let items = conn2.list_items("kp", "KeePass");
        let created = items.iter().find(|i| i.has_passkey).expect("a new passkey item exists");
        assert_eq!(
            created.folder_id.as_deref(),
            Some(fx.work_id.as_str()),
            "the new passkey item lands in the chosen folder"
        );
        assert_eq!(conn2.find_passkeys_for_rp("example.com").unwrap().len(), 1);
    }
}
