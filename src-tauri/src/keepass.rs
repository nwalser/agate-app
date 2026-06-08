//! KeePass (.kdbx) vault source — the single integration point for the `keepass`
//! crate, mirroring how `vault.rs` / `auth.rs` wrap the Bitwarden SDK so a crate
//! API break is contained to one layer (see the SDK caveat in CLAUDE.md).
//!
//! Read: KDB / KDBX3 / KDBX4 with a composite key (master password + optional key
//! file). Write: KDBX4 only — the crate's writer is experimental and KDBX4-only,
//! so opening an older KDBX3 file works but saving it back is refused with a clear
//! error rather than silently changing the format.
//!
//! Fidelity is the whole game for read-write on a real password vault: we keep the
//! parsed `Database` in memory and mutate ONLY the fields the editor touched, so
//! attachments, entry history, custom icons, custom data, tags, times and autotype
//! — everything the crate models — survive the round-trip untouched. The crate
//! drops only fields it does not parse at all; `tests` below pin what is preserved.
//! Every save first backs up the on-disk file and writes atomically (temp +
//! rename), so a bad write can always be recovered from `<file>.bak`.
//!
//! Mapping onto the existing `VaultItem` / `ItemDetail` DTOs lets the unified vault
//! list render KeePass entries unchanged. A KeePass "account id" is a synthetic
//! string (e.g. `keepass:<path>`) carried in the same `account_email` slot the
//! Bitwarden side uses; it routes every per-item op back to the right open file.

use std::path::{Path, PathBuf};

use bitwarden_vault::generate_totp;
use chrono::Utc;
use keepass::db::{fields, DatabaseOpenError, DatabaseSaveError, EntryId, GroupId, GroupRef};
use keepass::{Database, DatabaseKey};
use serde::Serialize;
use tauri::State;
use uuid::Uuid;
use zeroize::Zeroizing;

use crate::dto::{
    CustomField, Folder, ItemDetail, ItemInput, ItemType, LoginDetail, LoginUri, TotpCode, VaultItem,
};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

/// The tag Agate uses to mark a KeePass entry as a favorite (KDBX has no native
/// favorite flag, so we round-trip it as a tag the user can also see in KeePassXC).
const FAVORITE_TAG: &str = "Favorite";

/// Field names that map onto dedicated DTO slots; everything else is a custom field.
const STANDARD_FIELDS: [&str; 6] = [
    fields::TITLE,
    fields::USERNAME,
    fields::PASSWORD,
    fields::URL,
    fields::NOTES,
    fields::OTP,
];

fn is_standard_field(key: &str) -> bool {
    STANDARD_FIELDS.contains(&key)
}

// ---------------------------------------------------------------------------
// Open
// ---------------------------------------------------------------------------

/// Build the composite `DatabaseKey` from a master password and/or a key file.
/// Either component may be absent, but at least one must be present (the crate
/// enforces this when the key is used). The returned key is zeroize-on-drop and is
/// kept in the session so in-session saves don't re-prompt.
pub(crate) fn build_key(
    password: Option<&Zeroizing<String>>,
    keyfile: Option<&Path>,
) -> AgateResult<DatabaseKey> {
    let mut key = DatabaseKey::new();
    if let Some(pw) = password {
        key = key.with_password(pw.as_str());
    }
    if let Some(kf) = keyfile {
        let bytes = std::fs::read(kf)
            .map_err(|e| AgateError::new(ErrorKind::BadRequest, format!("Could not read key file: {e}")))?;
        key = key
            .with_keyfile(&mut bytes.as_slice())
            .map_err(|e| AgateError::new(ErrorKind::BadRequest, format!("Invalid key file: {e}")))?;
    }
    Ok(key)
}

/// Open a `.kdbx` file at `path` with a prepared composite `key`. The returned
/// `Database` holds decrypted secrets in memory; the caller keeps it in the session
/// and drops it on lock.
pub(crate) fn open(path: &Path, key: &DatabaseKey) -> AgateResult<Database> {
    let data = std::fs::read(path)
        .map_err(|e| AgateError::new(ErrorKind::BadRequest, format!("Could not read KeePass file: {e}")))?;
    Database::parse(&data, key.clone()).map_err(map_open_err)
}

/// Map the crate's open error to a typed `AgateError`, distinguishing "wrong
/// password / key file" (a credential problem the user can fix) from "corrupt /
/// unsupported file" (CLAUDE.md: absent vs corrupt). Never leaks secret data — the
/// crate's error messages describe formats and crypto, not vault contents.
fn map_open_err(e: DatabaseOpenError) -> AgateError {
    match e {
        DatabaseOpenError::Key(_) | DatabaseOpenError::Cryptography(_) => AgateError::new(
            ErrorKind::InvalidCredentials,
            "Wrong master password or key file for this KeePass file.",
        ),
        DatabaseOpenError::UnsupportedVersion => AgateError::new(
            ErrorKind::BadRequest,
            "This KeePass file uses a database version Agate can't open.",
        ),
        other => AgateError::new(ErrorKind::Internal, format!("Could not open KeePass file: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Save (KDBX4 only, with backup + atomic write)
// ---------------------------------------------------------------------------

/// Serialize + encrypt the database and write it back to `path`, preserving a
/// backup of the previous file. Serialization happens fully in memory first, so a
/// failure never touches the on-disk file. Only after a clean serialize do we copy
/// the old file to `<path>.bak` and atomically swap in the new one (temp + rename).
pub(crate) fn save(db: &Database, path: &Path, key: &DatabaseKey) -> AgateResult<()> {
    // 1. Serialize to memory. A non-KDBX4 source fails here (writer is KDBX4-only).
    let mut buf: Vec<u8> = Vec::new();
    db.save(&mut buf, key.clone()).map_err(map_save_err)?;

    // 2. Back up the previous on-disk state so a bad edit is recoverable.
    if path.exists() {
        let backup = sibling_path(path, ".bak");
        std::fs::copy(path, &backup)
            .map_err(|e| AgateError::internal(format!("Could not back up KeePass file: {e}")))?;
    }

    // 3. Atomic swap: write a temp file in the same directory, then rename over.
    let tmp = sibling_path(path, ".tmp");
    std::fs::write(&tmp, &buf)
        .map_err(|e| AgateError::internal(format!("Could not write KeePass file: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AgateError::internal(format!("Could not replace KeePass file: {e}")))?;
    Ok(())
}

/// `path` with `suffix` appended to the full file name (so `vault.kdbx` →
/// `vault.kdbx.bak`, not `vault.bak`).
fn sibling_path(path: &Path, suffix: &str) -> std::path::PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(suffix);
    std::path::PathBuf::from(name)
}

fn map_save_err(e: DatabaseSaveError) -> AgateError {
    match e {
        DatabaseSaveError::UnsupportedVersion => AgateError::new(
            ErrorKind::BadRequest,
            "Agate can only save KeePass files in KDBX4 format. Re-save this file as KDBX4 in \
             KeePass (or KeePassXC) first, then reopen it here.",
        ),
        other => AgateError::new(ErrorKind::Internal, format!("Could not save KeePass file: {other}")),
    }
}

// ---------------------------------------------------------------------------
// Read mapping (Database → DTOs)
// ---------------------------------------------------------------------------

fn parse_entry_id(s: &str) -> AgateResult<EntryId> {
    Uuid::parse_str(s)
        .map(EntryId::from_uuid)
        .map_err(|_| AgateError::bad_request("Invalid KeePass item id."))
}

fn parse_group_id(s: &str) -> AgateResult<GroupId> {
    Uuid::parse_str(s)
        .map(GroupId::from_uuid)
        .map_err(|_| AgateError::bad_request("Invalid KeePass folder id."))
}

/// Decide a DTO item type for a KeePass entry. KeePass models only logins and
/// notes; an entry with any login-ish field is a Login, otherwise a SecureNote.
fn entry_item_type(e: &keepass::db::Entry) -> ItemType {
    let has_login = e.get_username().is_some()
        || e.get_password().is_some()
        || e.get_url().is_some()
        || e.get_raw_otp_value().is_some();
    if has_login {
        ItemType::Login
    } else {
        ItemType::SecureNote
    }
}

fn entry_is_favorite(e: &keepass::db::Entry) -> bool {
    e.tags.iter().any(|t| t.eq_ignore_ascii_case(FAVORITE_TAG))
}

/// Walk every group/entry from the root, producing one `VaultItem` per entry. Each
/// row is stamped with the owning KeePass source id + label and its folder; entries
/// inside the recycle-bin subtree are flagged `deleted` so Trash filtering works.
pub(crate) fn to_vault_items(db: &Database, account_id: &str, account_label: &str) -> Vec<VaultItem> {
    let mut out = Vec::new();
    let root_id = db.root().id();
    let recycle_id = db.recycle_bin().map(|g| g.id());
    collect_items(db.root(), root_id, recycle_id, false, account_id, account_label, &mut out);
    out
}

fn collect_items(
    group: GroupRef<'_>,
    root_id: GroupId,
    recycle_id: Option<GroupId>,
    parent_in_trash: bool,
    account_id: &str,
    account_label: &str,
    out: &mut Vec<VaultItem>,
) {
    let group_id = group.id();
    let in_trash = parent_in_trash || Some(group_id) == recycle_id;
    let folder_id = (group_id != root_id).then(|| group_id.uuid().to_string());

    for entry in group.entries() {
        let (username, has_totp) = (
            entry.get_username().map(str::to_string),
            entry.get_raw_otp_value().is_some(),
        );
        out.push(VaultItem {
            id: entry.id().uuid().to_string(),
            account_email: account_id.to_string(),
            account_label: account_label.to_string(),
            name: entry.get_title().unwrap_or("").to_string(),
            item_type: entry_item_type(&entry),
            username,
            uri: entry.get_url().map(str::to_string),
            has_totp,
            favorite: entry_is_favorite(&entry),
            deleted: in_trash,
            folder_id: folder_id.clone(),
            organization_id: None,
        });
    }

    for sub in group.groups() {
        collect_items(sub, root_id, recycle_id, in_trash, account_id, account_label, out);
    }
}

/// Map one entry (by uuid) to a full `ItemDetail`. Standard fields become the login
/// sub-object + notes; everything else becomes a custom field (protected → hidden).
pub(crate) fn to_item_detail(
    db: &Database,
    account_id: &str,
    account_label: &str,
    entry_uuid: &str,
) -> AgateResult<ItemDetail> {
    let id = parse_entry_id(entry_uuid)?;
    let entry = db.entry(id).ok_or_else(|| AgateError::bad_request("No such KeePass item."))?;

    let item_type = entry_item_type(&entry);

    let login = if matches!(item_type, ItemType::Login) {
        let totp = entry.get_raw_otp_value().map(str::to_string);
        let uris = entry
            .get_url()
            .filter(|u| !u.is_empty())
            .map(|u| vec![LoginUri { uri: Some(u.to_string()), match_type: None }])
            .unwrap_or_default();
        Some(LoginDetail {
            username: entry.get_username().map(str::to_string),
            password: entry.get_password().map(str::to_string),
            has_totp: totp.as_ref().map(|t| !t.is_empty()).unwrap_or(false),
            totp,
            uris,
        })
    } else {
        None
    };

    // Custom fields: every field that isn't one of the standard slots, in a stable
    // (sorted) order so the editor doesn't reshuffle them on each open.
    let mut fields: Vec<CustomField> = entry
        .fields
        .iter()
        .filter(|(k, _)| !is_standard_field(k))
        .map(|(k, v)| CustomField {
            name: Some(k.clone()),
            value: Some(v.get().clone()),
            field_type: if v.is_protected() { "hidden" } else { "text" }.to_string(),
        })
        .collect();
    fields.sort_by(|a, b| a.name.cmp(&b.name));

    let folder_id = {
        let parent = entry.parent();
        (parent.id() != db.root().id()).then(|| parent.id().uuid().to_string())
    };

    Ok(ItemDetail {
        id: entry_uuid.to_string(),
        account_email: account_id.to_string(),
        account_label: account_label.to_string(),
        name: entry.get_title().unwrap_or("").to_string(),
        item_type,
        favorite: entry_is_favorite(&entry),
        reprompt: false,
        notes: entry.get(fields::NOTES).map(str::to_string),
        login,
        card: None,
        identity: None,
        ssh_key: None,
        fields,
        folder_id,
        organization_id: None,
    })
}

/// The raw `otp` field value of an entry (an `otpauth://` URI or a base32 secret),
/// for the caller to turn into a live code via the shared TOTP generator.
pub(crate) fn entry_raw_otp(db: &Database, entry_uuid: &str) -> AgateResult<String> {
    let id = parse_entry_id(entry_uuid)?;
    let entry = db.entry(id).ok_or_else(|| AgateError::bad_request("No such KeePass item."))?;
    entry
        .get_raw_otp_value()
        .filter(|v| !v.is_empty())
        .map(str::to_string)
        .ok_or_else(|| AgateError::bad_request("Item has no TOTP secret."))
}

/// Every group except the root and the recycle bin, as a flat folder list. KeePass
/// groups nest; Agate folders are flat, so each folder's name is its full path
/// ("Parent/Child") to keep the hierarchy legible after flattening.
pub(crate) fn to_folders(db: &Database, account_id: &str, account_label: &str) -> Vec<Folder> {
    let mut out = Vec::new();
    let recycle_id = db.recycle_bin().map(|g| g.id());
    for sub in db.root().groups() {
        collect_folders(sub, String::new(), recycle_id, account_id, account_label, &mut out);
    }
    out
}

fn collect_folders(
    group: GroupRef<'_>,
    parent_path: String,
    recycle_id: Option<GroupId>,
    account_id: &str,
    account_label: &str,
    out: &mut Vec<Folder>,
) {
    if Some(group.id()) == recycle_id {
        return; // the recycle bin is "Trash", not a normal folder
    }
    let path = if parent_path.is_empty() {
        group.name.clone()
    } else {
        format!("{parent_path}/{}", group.name)
    };
    out.push(Folder {
        id: Some(group.id().uuid().to_string()),
        name: path.clone(),
        account_email: account_id.to_string(),
        account_label: account_label.to_string(),
    });
    for sub in group.groups() {
        collect_folders(sub, path.clone(), recycle_id, account_id, account_label, out);
    }
}

// ---------------------------------------------------------------------------
// Write mapping (DTO → Database). Mutates the in-memory db in place; the caller
// saves afterwards. Only login + secure-note items are written; KeePass has no
// native card/identity/ssh-key model, so those are refused rather than silently
// stuffed into lossy custom fields.
// ---------------------------------------------------------------------------

/// Create (when `input.id` is absent) or edit an entry. Returns the entry's uuid.
pub(crate) fn apply_item(db: &mut Database, input: &ItemInput) -> AgateResult<String> {
    if input.name.trim().is_empty() {
        return Err(AgateError::bad_request("Name is required."));
    }
    match input.item_type {
        ItemType::Login | ItemType::SecureNote => {}
        _ => {
            return Err(AgateError::bad_request(
                "KeePass files only support logins and secure notes. Use a Bitwarden account for \
                 cards, identities, or SSH keys.",
            ))
        }
    }

    match &input.id {
        None => {
            let target = match &input.folder_id {
                Some(fid) if !fid.is_empty() => {
                    let gid = parse_group_id(fid)?;
                    if db.group(gid).is_none() {
                        return Err(AgateError::bad_request("Target folder does not exist."));
                    }
                    gid
                }
                _ => db.root().id(),
            };
            // group_mut is guaranteed Some: target is root or was just checked above.
            let new_id = {
                let mut group = db
                    .group_mut(target)
                    .ok_or_else(|| AgateError::bad_request("Target folder does not exist."))?;
                group.add_entry().id()
            };
            write_entry_fields(db, new_id, input)?;
            Ok(new_id.uuid().to_string())
        }
        Some(id_str) => {
            let id = parse_entry_id(id_str)?;
            if db.entry(id).is_none() {
                return Err(AgateError::bad_request("No such KeePass item."));
            }
            write_entry_fields(db, id, input)?;
            // Move between folders if requested (after field edits, to avoid holding
            // two mutable borrows at once).
            let target = match &input.folder_id {
                Some(fid) if !fid.is_empty() => parse_group_id(fid)?,
                _ => db.root().id(),
            };
            let current = db
                .entry(id)
                .ok_or_else(|| AgateError::bad_request("No such KeePass item."))?
                .parent()
                .id();
            if current != target {
                if db.group(target).is_none() {
                    return Err(AgateError::bad_request("Target folder does not exist."));
                }
                let mut entry = db
                    .entry_mut(id)
                    .ok_or_else(|| AgateError::bad_request("No such KeePass item."))?;
                entry
                    .move_to(target)
                    .map_err(|e| AgateError::internal(format!("Could not move item: {e}")))?;
            }
            Ok(id_str.clone())
        }
    }
}

/// Write the title / login / notes / custom fields of `input` onto entry `id`,
/// reconciling custom fields (those the editor dropped are removed) while leaving
/// everything the editor never models — attachments, history, icon, tags other
/// than Favorite, autotype, times — untouched.
fn write_entry_fields(db: &mut Database, id: EntryId, input: &ItemInput) -> AgateResult<()> {
    let mut entry = db
        .entry_mut(id)
        .ok_or_else(|| AgateError::bad_request("No such KeePass item."))?;

    entry.set_unprotected(fields::TITLE, input.name.clone());

    // Notes: set when present, clear otherwise.
    match &input.notes {
        Some(n) if !n.is_empty() => entry.set_unprotected(fields::NOTES, n.clone()),
        _ => {
            entry.fields.remove(fields::NOTES);
        }
    }

    // Login sub-object → UserName / Password (protected) / URL / otp.
    if let Some(login) = &input.login {
        set_or_clear(&mut entry, fields::USERNAME, login.username.as_deref(), false);
        set_or_clear(&mut entry, fields::PASSWORD, login.password.as_deref(), true);
        set_or_clear(&mut entry, fields::URL, login.uris.first().and_then(|u| u.uri.as_deref()), false);
        set_or_clear(&mut entry, fields::OTP, login.totp.as_deref(), true);
    }

    // Reconcile custom fields: keep the standard slots and the names the editor sent;
    // drop other custom fields (the user removed them); set/overwrite the rest.
    let kept: std::collections::HashSet<&str> = input
        .fields
        .iter()
        .filter_map(|f| f.name.as_deref())
        .filter(|n| !n.is_empty())
        .collect();
    let to_remove: Vec<String> = entry
        .fields
        .keys()
        .filter(|k| !is_standard_field(k) && !kept.contains(k.as_str()))
        .cloned()
        .collect();
    for k in to_remove {
        entry.fields.remove(&k);
    }
    for f in &input.fields {
        let Some(name) = f.name.as_deref().filter(|n| !n.is_empty()) else { continue };
        if is_standard_field(name) {
            continue; // never let a custom field shadow a standard slot
        }
        let value = f.value.clone().unwrap_or_default();
        // dto FieldInput.field_type: 1 = Hidden → protected; everything else plain.
        if f.field_type == 1 {
            entry.set_protected(name, value);
        } else {
            entry.set_unprotected(name, value);
        }
    }

    // Favorite is stored as a tag.
    apply_favorite_tag(&mut entry, input.favorite);
    Ok(())
}

fn set_or_clear(entry: &mut keepass::db::EntryMut<'_>, key: &str, value: Option<&str>, protected: bool) {
    match value.filter(|v| !v.is_empty()) {
        Some(v) if protected => entry.set_protected(key, v.to_string()),
        Some(v) => entry.set_unprotected(key, v.to_string()),
        None => {
            entry.fields.remove(key);
        }
    }
}

fn apply_favorite_tag(entry: &mut keepass::db::EntryMut<'_>, favorite: bool) {
    let present = entry.tags.iter().any(|t| t.eq_ignore_ascii_case(FAVORITE_TAG));
    if favorite && !present {
        entry.tags.push(FAVORITE_TAG.to_string());
    } else if !favorite && present {
        entry.tags.retain(|t| !t.eq_ignore_ascii_case(FAVORITE_TAG));
    }
}

/// Toggle the favorite tag on one entry.
pub(crate) fn set_favorite(db: &mut Database, entry_uuid: &str, favorite: bool) -> AgateResult<()> {
    let id = parse_entry_id(entry_uuid)?;
    let mut entry = db.entry_mut(id).ok_or_else(|| AgateError::bad_request("No such KeePass item."))?;
    apply_favorite_tag(&mut entry, favorite);
    Ok(())
}

/// Delete entries. `permanent` removes them outright; otherwise they move to the
/// recycle bin (created on demand) so they show up under Trash and can be restored.
pub(crate) fn delete_items(db: &mut Database, ids: &[String], permanent: bool) -> AgateResult<()> {
    if permanent {
        for id_str in ids {
            let id = parse_entry_id(id_str)?;
            if let Some(entry) = db.entry_mut(id) {
                entry.remove();
            }
        }
        return Ok(());
    }

    let recycle_id = ensure_recycle_bin(db);
    for id_str in ids {
        let id = parse_entry_id(id_str)?;
        if let Some(mut entry) = db.entry_mut(id) {
            entry
                .move_to(recycle_id)
                .map_err(|e| AgateError::internal(format!("Could not move item to trash: {e}")))?;
        }
    }
    Ok(())
}

/// Restore entries from the recycle bin back to the root group.
pub(crate) fn restore_items(db: &mut Database, ids: &[String]) -> AgateResult<()> {
    let root_id = db.root().id();
    for id_str in ids {
        let id = parse_entry_id(id_str)?;
        if let Some(mut entry) = db.entry_mut(id) {
            entry
                .move_to(root_id)
                .map_err(|e| AgateError::internal(format!("Could not restore item: {e}")))?;
        }
    }
    Ok(())
}

/// Move entries to a folder (group), or to the root when `folder_id` is `None`.
pub(crate) fn move_items(db: &mut Database, ids: &[String], folder_id: Option<&str>) -> AgateResult<()> {
    let target = match folder_id.filter(|f| !f.is_empty()) {
        Some(fid) => parse_group_id(fid)?,
        None => db.root().id(),
    };
    if db.group(target).is_none() {
        return Err(AgateError::bad_request("Target folder does not exist."));
    }
    for id_str in ids {
        let id = parse_entry_id(id_str)?;
        if let Some(mut entry) = db.entry_mut(id) {
            entry
                .move_to(target)
                .map_err(|e| AgateError::internal(format!("Could not move item: {e}")))?;
        }
    }
    Ok(())
}

/// Create a new top-level folder (group) under the root.
pub(crate) fn create_folder(
    db: &mut Database,
    name: &str,
    account_id: &str,
    account_label: &str,
) -> AgateResult<Folder> {
    if name.trim().is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    let id = {
        let mut root = db.root_mut();
        let mut group = root.add_group();
        group.name = name.to_string();
        group.id()
    };
    Ok(Folder {
        id: Some(id.uuid().to_string()),
        name: name.to_string(),
        account_email: account_id.to_string(),
        account_label: account_label.to_string(),
    })
}

/// Rename an existing folder (group). Returns the group's new full path label.
pub(crate) fn rename_folder(
    db: &mut Database,
    folder_uuid: &str,
    name: &str,
    account_id: &str,
    account_label: &str,
) -> AgateResult<Folder> {
    if name.trim().is_empty() {
        return Err(AgateError::bad_request("Folder name is required."));
    }
    let id = parse_group_id(folder_uuid)?;
    {
        let mut group = db
            .group_mut(id)
            .ok_or_else(|| AgateError::bad_request("No such folder."))?;
        group.name = name.to_string();
    }
    // Recompute the flat-path label so the UI shows the same string as the list.
    let label = to_folders(db, account_id, account_label)
        .into_iter()
        .find(|f| f.id.as_deref() == Some(folder_uuid))
        .map(|f| f.name)
        .unwrap_or_else(|| name.to_string());
    Ok(Folder {
        id: Some(folder_uuid.to_string()),
        name: label,
        account_email: account_id.to_string(),
        account_label: account_label.to_string(),
    })
}

/// Find or create the recycle-bin group, recording it in the database meta so other
/// KeePass clients recognize it as the recycle bin.
fn ensure_recycle_bin(db: &mut Database) -> GroupId {
    if let Some(g) = db.recycle_bin() {
        return g.id();
    }
    let id = {
        let mut root = db.root_mut();
        let mut group = root.add_group();
        group.name = "Recycle Bin".to_string();
        group.id()
    };
    db.meta.recyclebin_uuid = Some(id.uuid());
    id
}

// ---------------------------------------------------------------------------
// Session-held source + Tauri commands. KeePass sources live in their own map on
// the session (`Session.keepass`), separate from the Bitwarden connections, and
// have their own command surface so the Bitwarden vault/mutate paths are untouched.
// Each command is `keepass_*` and routes by the synthetic source id `keepass:<path>`.
// ---------------------------------------------------------------------------

/// One open KeePass file held in memory while unlocked. The decrypted `db` and the
/// composite `key` are secret; both are dropped (the key zeroizes on drop) when the
/// session is cleared on lock/logout.
pub(crate) struct KeePassSource {
    pub db: Database,
    pub key: DatabaseKey,
    pub path: PathBuf,
    pub label: String,
}

/// Non-secret summary of an open KeePass file for the UI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeePassSummary {
    pub id: String,
    pub label: String,
    pub path: String,
}

/// Stable synthetic account id for a KeePass file (mirrors the `account_email`
/// slot the Bitwarden side uses, so items route back to the right open file).
fn source_id(path: &Path) -> String {
    format!("keepass:{}", path.to_string_lossy())
}

/// Display label for a KeePass file: its file stem.
fn source_label(path: &Path) -> String {
    path.file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "KeePass".to_string())
}

fn not_open() -> AgateError {
    AgateError::new(ErrorKind::NotAuthenticated, "That KeePass file is not open.")
}

/// Run `f` against an open source's database + label (read-only).
async fn with_source<F, R>(state: &AppState, account_id: &str, f: F) -> AgateResult<R>
where
    F: FnOnce(&Database, &str) -> AgateResult<R>,
{
    let session = state.session.lock().await;
    let source = session.keepass.get(account_id).ok_or_else(not_open)?;
    f(&source.db, &source.label)
}

/// Mutate an open source's database, then persist it. The mutation runs on a CLONE
/// and is only committed back into the session after a successful save, so a failed
/// write never leaves the in-memory vault ahead of what's on disk.
async fn mutate_and_save<F, R>(state: &AppState, account_id: &str, f: F) -> AgateResult<R>
where
    F: FnOnce(&mut Database, &str) -> AgateResult<R>,
{
    let (mut db, key, path, label) = {
        let session = state.session.lock().await;
        let s = session.keepass.get(account_id).ok_or_else(not_open)?;
        (s.db.clone(), s.key.clone(), s.path.clone(), s.label.clone())
    };
    let result = f(&mut db, &label)?;

    // Save is CPU-bound (Argon2 KDF) — run off the async runtime.
    let to_save = db.clone();
    tokio::task::spawn_blocking(move || save(&to_save, &path, &key))
        .await
        .map_err(|_| AgateError::internal("KeePass save was interrupted."))??;

    // Commit only on success.
    if let Some(s) = state.session.lock().await.keepass.get_mut(account_id) {
        s.db = db;
    }
    Ok(result)
}

/// Open a `.kdbx` file and hold it in the session. Returns its synthetic account id.
#[tauri::command]
pub async fn open_keepass(
    state: State<'_, AppState>,
    path: String,
    password: Option<String>,
    keyfile: Option<String>,
) -> AgateResult<String> {
    let path_buf = PathBuf::from(&path);
    let pw = password.map(Zeroizing::new);
    let kf = keyfile.map(PathBuf::from);
    let open_path = path_buf.clone();

    // Opening runs Argon2 — do it off the async runtime.
    let (db, key) = tokio::task::spawn_blocking(move || -> AgateResult<(Database, DatabaseKey)> {
        let key = build_key(pw.as_ref(), kf.as_deref())?;
        let db = open(&open_path, &key)?;
        Ok((db, key))
    })
    .await
    .map_err(|_| AgateError::internal("KeePass open was interrupted."))??;

    let id = source_id(&path_buf);
    let label = source_label(&path_buf);
    state
        .session
        .lock()
        .await
        .keepass
        .insert(id.clone(), KeePassSource { db, key, path: path_buf, label });
    Ok(id)
}

/// Close an open KeePass file, dropping its in-memory secrets.
#[tauri::command]
pub async fn close_keepass(state: State<'_, AppState>, account_id: String) -> AgateResult<()> {
    state.session.lock().await.keepass.remove(&account_id);
    Ok(())
}

/// List the currently-open KeePass files.
#[tauri::command]
pub async fn list_keepass_sources(state: State<'_, AppState>) -> AgateResult<Vec<KeePassSummary>> {
    let session = state.session.lock().await;
    let mut out: Vec<KeePassSummary> = session
        .keepass
        .values()
        .map(|s| KeePassSummary {
            id: source_id(&s.path),
            label: s.label.clone(),
            path: s.path.to_string_lossy().into_owned(),
        })
        .collect();
    out.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(out)
}

#[tauri::command]
pub async fn keepass_list_items(state: State<'_, AppState>, account_id: String) -> AgateResult<Vec<VaultItem>> {
    with_source(&state, &account_id, |db, label| Ok(to_vault_items(db, &account_id, label))).await
}

#[tauri::command]
pub async fn keepass_list_folders(state: State<'_, AppState>, account_id: String) -> AgateResult<Vec<Folder>> {
    with_source(&state, &account_id, |db, label| Ok(to_folders(db, &account_id, label))).await
}

#[tauri::command]
pub async fn keepass_item_detail(
    state: State<'_, AppState>,
    account_id: String,
    id: String,
) -> AgateResult<ItemDetail> {
    with_source(&state, &account_id, |db, label| to_item_detail(db, &account_id, label, &id)).await
}

#[tauri::command]
pub async fn keepass_item_totp(
    state: State<'_, AppState>,
    account_id: String,
    id: String,
) -> AgateResult<TotpCode> {
    let secret = with_source(&state, &account_id, |db, _| entry_raw_otp(db, &id)).await?;
    let now = Utc::now();
    let response = generate_totp(secret, Some(now))
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("TOTP failed: {e}")))?;
    let period = response.period;
    let remaining = if period == 0 { 0 } else { period - (now.timestamp() as u32 % period) };
    Ok(TotpCode { code: response.code, period, remaining })
}

#[tauri::command]
pub async fn keepass_save_item(
    state: State<'_, AppState>,
    account_id: String,
    input: ItemInput,
) -> AgateResult<String> {
    mutate_and_save(&state, &account_id, |db, _| apply_item(db, &input)).await
}

#[tauri::command]
pub async fn keepass_set_favorite(
    state: State<'_, AppState>,
    account_id: String,
    id: String,
    favorite: bool,
) -> AgateResult<()> {
    mutate_and_save(&state, &account_id, |db, _| set_favorite(db, &id, favorite)).await
}

#[tauri::command]
pub async fn keepass_move_items(
    state: State<'_, AppState>,
    account_id: String,
    ids: Vec<String>,
    folder_id: Option<String>,
) -> AgateResult<()> {
    mutate_and_save(&state, &account_id, |db, _| move_items(db, &ids, folder_id.as_deref())).await
}

#[tauri::command]
pub async fn keepass_delete_items(
    state: State<'_, AppState>,
    account_id: String,
    ids: Vec<String>,
    permanent: bool,
) -> AgateResult<()> {
    mutate_and_save(&state, &account_id, |db, _| delete_items(db, &ids, permanent)).await
}

#[tauri::command]
pub async fn keepass_restore_items(
    state: State<'_, AppState>,
    account_id: String,
    ids: Vec<String>,
) -> AgateResult<()> {
    mutate_and_save(&state, &account_id, |db, _| restore_items(db, &ids)).await
}

#[tauri::command]
pub async fn keepass_create_folder(
    state: State<'_, AppState>,
    account_id: String,
    name: String,
) -> AgateResult<Folder> {
    mutate_and_save(&state, &account_id, |db, label| create_folder(db, &name, &account_id, label)).await
}

#[tauri::command]
pub async fn keepass_rename_folder(
    state: State<'_, AppState>,
    account_id: String,
    id: String,
    name: String,
) -> AgateResult<Folder> {
    mutate_and_save(&state, &account_id, |db, label| rename_folder(db, &id, &name, &account_id, label)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dto::{FieldInput, LoginInput, UriInput};
    use keepass::db::Value;

    const PW: &str = "correct horse battery staple";
    const ACCT: &str = "keepass:test";
    const LABEL: &str = "test.kdbx";

    fn key(pw: &str) -> DatabaseKey {
        DatabaseKey::new().with_password(pw)
    }

    /// Build a small database with one group and one fully-populated login entry
    /// (custom field + attachment + favorite tag + a forced history version), then
    /// round-trip it through save/open so tests run against real serialized bytes.
    fn fixture() -> (Database, String) {
        let mut db = Database::new();

        // A subgroup to exercise folders.
        let work_id = {
            let mut root = db.root_mut();
            let mut g = root.add_group();
            g.name = "Work".to_string();
            g.id()
        };

        let entry_id = {
            let mut group = db.group_mut(work_id).unwrap();
            let mut e = group.add_entry();
            e.set_unprotected(fields::TITLE, "GitHub");
            e.set_unprotected(fields::USERNAME, "octocat");
            e.set_protected(fields::PASSWORD, "s3cr3t");
            e.set_unprotected(fields::URL, "https://github.com");
            e.set_unprotected(fields::NOTES, "my notes");
            e.set_unprotected(fields::OTP, "otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
            e.set_protected("Recovery Code", "abcd-efgh"); // custom hidden field
            e.tags.push(FAVORITE_TAG.to_string());
            e.add_attachment("note.txt", Value::unprotected(b"hello".to_vec()));
            e.id()
        };

        // Force a history version so we can assert it survives edits.
        db.entry_mut(entry_id).unwrap().edit_tracking(|e| {
            e.set_unprotected(fields::TITLE, "GitHub");
        });

        let mut buf = Vec::new();
        db.save(&mut buf, key(PW)).expect("save fixture");
        let reopened = Database::parse(&buf, key(PW)).expect("reopen fixture");
        (reopened, entry_id.uuid().to_string())
    }

    #[test]
    fn maps_entries_to_vault_items() {
        let (db, entry_id) = fixture();
        let items = to_vault_items(&db, ACCT, LABEL);
        assert_eq!(items.len(), 1);
        let it = &items[0];
        assert_eq!(it.id, entry_id);
        assert_eq!(it.name, "GitHub");
        assert_eq!(it.account_email, ACCT);
        assert!(matches!(it.item_type, ItemType::Login));
        assert_eq!(it.username.as_deref(), Some("octocat"));
        assert!(it.has_totp);
        assert!(it.favorite);
        assert!(!it.deleted);
        assert!(it.folder_id.is_some()); // it's inside "Work"
    }

    #[test]
    fn maps_entry_detail_including_custom_field() {
        let (db, entry_id) = fixture();
        let d = to_item_detail(&db, ACCT, LABEL, &entry_id).unwrap();
        assert_eq!(d.name, "GitHub");
        let login = d.login.expect("login");
        assert_eq!(login.username.as_deref(), Some("octocat"));
        assert_eq!(login.password.as_deref(), Some("s3cr3t"));
        assert_eq!(login.uris.first().and_then(|u| u.uri.as_deref()), Some("https://github.com"));
        assert!(login.has_totp);
        assert_eq!(d.notes.as_deref(), Some("my notes"));
        let cf = d.fields.iter().find(|f| f.name.as_deref() == Some("Recovery Code")).expect("custom field");
        assert_eq!(cf.value.as_deref(), Some("abcd-efgh"));
        assert_eq!(cf.field_type, "hidden"); // it was a protected field
    }

    #[test]
    fn folders_list_excludes_root_and_uses_paths() {
        let (db, _) = fixture();
        let folders = to_folders(&db, ACCT, LABEL);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].name, "Work");
    }

    #[test]
    fn wrong_password_is_invalid_credentials() {
        let (db, _) = fixture();
        let mut buf = Vec::new();
        db.save(&mut buf, key(PW)).unwrap();
        let err = Database::parse(&buf, key("wrong")).map_err(map_open_err).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::InvalidCredentials), "got {:?}", err.kind);
    }

    #[test]
    fn keyfile_is_required_when_set() {
        let mut db = Database::new();
        db.root_mut().add_entry().edit(|e| e.set_unprotected(fields::TITLE, "x"));
        let kf = b"my-key-file-bytes-1234567890";
        let composite = key(PW).with_keyfile(&mut kf.as_slice()).unwrap();
        let mut buf = Vec::new();
        db.save(&mut buf, composite).unwrap();
        // Password alone must fail; password + same keyfile must succeed.
        assert!(Database::parse(&buf, key(PW)).is_err());
        let composite2 = key(PW).with_keyfile(&mut kf.as_slice()).unwrap();
        assert!(Database::parse(&buf, composite2).is_ok());
    }

    #[test]
    fn edit_preserves_attachment_history_and_untouched_fields() {
        let (mut db, entry_id) = fixture();
        assert_eq!(db.num_attachments(), 1);

        // Edit the password + name only; leave the custom field, attachment, history.
        let input = ItemInput {
            id: Some(entry_id.clone()),
            item_type: ItemType::Login,
            name: "GitHub (work)".to_string(),
            folder_id: to_item_detail(&db, ACCT, LABEL, &entry_id).unwrap().folder_id,
            organization_id: None,
            favorite: true,
            reprompt: false,
            notes: Some("my notes".to_string()),
            login: Some(LoginInput {
                username: Some("octocat".to_string()),
                password: Some("rotated-pw".to_string()),
                totp: Some("otpauth://totp/GitHub:octocat?secret=JBSWY3DPEHPK3PXP&issuer=GitHub".to_string()),
                uris: vec![UriInput { uri: Some("https://github.com".to_string()), match_type: None }],
            }),
            card: None,
            identity: None,
            ssh_key: None,
            fields: vec![FieldInput {
                name: Some("Recovery Code".to_string()),
                value: Some("abcd-efgh".to_string()),
                field_type: 1,
            }],
        };
        apply_item(&mut db, &input).unwrap();

        // Round-trip through save/open and assert fidelity.
        let mut buf = Vec::new();
        db.save(&mut buf, key(PW)).unwrap();
        let db2 = Database::parse(&buf, key(PW)).unwrap();

        assert_eq!(db2.num_attachments(), 1, "attachment must survive an edit");
        let d = to_item_detail(&db2, ACCT, LABEL, &entry_id).unwrap();
        assert_eq!(d.name, "GitHub (work)");
        assert_eq!(d.login.as_ref().unwrap().password.as_deref(), Some("rotated-pw"));
        assert!(d.fields.iter().any(|f| f.name.as_deref() == Some("Recovery Code")));
        // history preserved (the forced version + the version pushed by edit_tracking, if any)
        let id = parse_entry_id(&entry_id).unwrap();
        let hist = db2.entry(id).unwrap().history.clone();
        assert!(hist.map(|h| !h.get_entries().is_empty()).unwrap_or(false), "history must survive");
    }

    #[test]
    fn create_then_soft_delete_then_restore() {
        let (mut db, _) = fixture();
        let input = ItemInput {
            id: None,
            item_type: ItemType::Login,
            name: "New Login".to_string(),
            folder_id: None,
            organization_id: None,
            favorite: false,
            reprompt: false,
            notes: None,
            login: Some(LoginInput {
                username: Some("user".to_string()),
                password: Some("pw".to_string()),
                totp: None,
                uris: vec![],
            }),
            card: None,
            identity: None,
            ssh_key: None,
            fields: vec![],
        };
        let new_id = apply_item(&mut db, &input).unwrap();
        assert!(to_vault_items(&db, ACCT, LABEL).iter().any(|i| i.id == new_id && !i.deleted));

        delete_items(&mut db, std::slice::from_ref(&new_id), false).unwrap();
        assert!(to_vault_items(&db, ACCT, LABEL).iter().any(|i| i.id == new_id && i.deleted));

        restore_items(&mut db, std::slice::from_ref(&new_id)).unwrap();
        assert!(to_vault_items(&db, ACCT, LABEL).iter().any(|i| i.id == new_id && !i.deleted));

        delete_items(&mut db, std::slice::from_ref(&new_id), true).unwrap();
        assert!(!to_vault_items(&db, ACCT, LABEL).iter().any(|i| i.id == new_id));
    }

    #[test]
    fn rejects_non_login_note_types() {
        let (mut db, _) = fixture();
        let input = ItemInput {
            id: None,
            item_type: ItemType::Card,
            name: "My Card".to_string(),
            folder_id: None,
            organization_id: None,
            favorite: false,
            reprompt: false,
            notes: None,
            login: None,
            card: None,
            identity: None,
            ssh_key: None,
            fields: vec![],
        };
        let err = apply_item(&mut db, &input).unwrap_err();
        assert!(matches!(err.kind, ErrorKind::BadRequest));
    }
}
