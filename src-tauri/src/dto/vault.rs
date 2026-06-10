//! Vault item DTOs: list rows, full item detail, folders, TOTP, and the
//! create/edit input shapes (frontend → backend). Mirrors `src/lib/types.ts`.

use serde::{Deserialize, Serialize};

/// Closed set of vault-export file formats (frontend → backend).
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ExportFormat {
    /// Pretty JSON: an array of full item details (Agate's own shape).
    Json,
    /// Bitwarden-compatible CSV (login-centric columns).
    Csv,
}

/// Closed set of Bitwarden item types.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ItemType {
    Login,
    SecureNote,
    Card,
    Identity,
    SshKey,
    Unknown,
}

/// Row in the vault list (no secrets beyond what a list needs).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: String,
    /// Which connection (account email) this item belongs to — routes every
    /// per-item operation to the right unlocked client in the unified list.
    pub account_email: String,
    /// Human label for the owning connection's server (badge in the list).
    pub account_label: String,
    pub name: String,
    pub item_type: ItemType,
    pub username: Option<String>,
    /// First login URI (decrypted; URIs are not secret). Powers the list's
    /// website column and favicon host. None for non-logins / no URI.
    pub uri: Option<String>,
    pub has_totp: bool,
    /// Whether the login has at least one stored passkey (FIDO2 credential).
    /// Presence only — the credential material is never sent to the frontend.
    pub has_passkey: bool,
    /// Whether "require master password to view" (reprompt) is set — the list
    /// needs it so cell/context-menu copies can gate without a detail fetch.
    pub reprompt: bool,
    pub favorite: bool,
    pub deleted: bool,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
}

/// A single login URI (with its match strategy so edits round-trip).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LoginUri {
    pub uri: Option<String>,
    pub match_type: Option<u8>,
}

/// Login-type detail.
#[derive(Debug, Clone, Serialize, Default)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LoginDetail {
    pub username: Option<String>,
    pub password: Option<String>,
    /// The TOTP secret/URI itself (so an edit can preserve it).
    pub totp: Option<String>,
    pub uris: Vec<LoginUri>,
    pub has_totp: bool,
}

/// Closed set of custom-field kinds on a decrypted item (backend → frontend).
/// camelCase yields exactly "text" / "hidden" / "boolean" / "linked" — the same
/// wire values the frontend contract expects.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum CustomFieldType {
    Text,
    Hidden,
    Boolean,
    Linked,
}

/// A custom field on an item.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    pub name: Option<String>,
    pub value: Option<String>,
    pub field_type: CustomFieldType,
    /// For linked fields: the numeric `LinkedIdType` target (None otherwise).
    pub linked_id: Option<u32>,
}

/// Full decrypted item detail for the detail pane and the editor (prefill).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub id: String,
    /// Owning connection (account email) — routes edits/clones/TOTP correctly.
    pub account_email: String,
    pub account_label: String,
    pub name: String,
    pub item_type: ItemType,
    pub favorite: bool,
    /// Whether "require master password to view" (reprompt) is set.
    pub reprompt: bool,
    pub notes: Option<String>,
    pub login: Option<LoginDetail>,
    pub card: Option<CardInput>,
    pub identity: Option<IdentityInput>,
    pub ssh_key: Option<SshKeyInput>,
    pub fields: Vec<CustomField>,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
    /// Last-modified timestamp (RFC 3339). Shown as "updated X ago" in the pane.
    pub revision_date: String,
    /// Creation timestamp (RFC 3339).
    pub creation_date: String,
    /// Collections this item belongs to (IDs; resolve to names via list_collections).
    pub collection_ids: Vec<String>,
    /// File attachments on this item (metadata; download via download_attachment).
    pub attachments: Vec<Attachment>,
    /// Stored passkeys (FIDO2 credentials) on this login — display metadata only.
    pub passkeys: Vec<PasskeyCredential>,
}

/// A generated TOTP code plus timing so the UI can render a countdown.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub period: u32,
    /// Seconds remaining until this code rolls over.
    pub remaining: u32,
}

/// A stored passkey (FIDO2 credential) on a login — display metadata only; the
/// private key material never leaves the backend. Standalone vaults can show and
/// manage passkeys; using them for sign-in needs browser integration (extension).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PasskeyCredential {
    /// Relying-party (site) id, e.g. "github.com".
    pub rp_id: String,
    pub rp_name: Option<String>,
    pub user_name: Option<String>,
    pub user_display_name: Option<String>,
    pub key_algorithm: String,
    /// Creation timestamp (RFC 3339).
    pub creation_date: String,
}

/// One file attachment on an item (metadata only — bytes are fetched + decrypted
/// on demand by `download_attachment`). The encryption key/URL stay in the backend.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    pub id: String,
    pub file_name: Option<String>,
    /// Human-readable size, e.g. "12 KB" (from the SDK).
    pub size_name: Option<String>,
}

/// A Bitwarden Send (ephemeral share) summary for the Sends manager. Named
/// `SendSummary` to avoid colliding with the `Send` marker trait. Read + revoke
/// only for now (create is a follow-up).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SendSummary {
    pub id: String,
    pub name: String,
    /// "text" or "file".
    pub send_type: String,
    pub disabled: bool,
    pub has_password: bool,
    pub access_count: u32,
    pub max_access_count: Option<u32>,
    /// When the Send is auto-deleted (RFC 3339).
    pub deletion_date: String,
    /// Optional expiry (RFC 3339).
    pub expiration_date: Option<String>,
    pub account_email: String,
    pub account_label: String,
}

/// A decrypted collection (a shared-vault grouping). Per-connection in the
/// unified view, like folders. Read-only browsing for now.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Collection {
    pub id: String,
    pub name: String,
    pub organization_id: String,
    pub account_email: String,
    pub account_label: String,
}

/// A vault folder. In the unified view folders are per-connection, so each
/// carries its owning account; "move to folder" is scoped to that account.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: Option<String>,
    pub name: String,
    pub account_email: String,
    pub account_label: String,
}

// ---------------------------------------------------------------------------
// Item create/edit input (frontend → backend). Discriminated by `itemType`;
// only the matching sub-object is read. Mirrors `src/lib/types.ts` ItemInput.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UriInput {
    pub uri: Option<String>,
    /// 0=Domain,1=Host,2=StartsWith,3=Exact,4=Regex,5=Never; null = default.
    pub match_type: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub username: Option<String>,
    pub password: Option<String>,
    pub totp: Option<String>,
    // No serde(default): an edit payload missing uris must be REJECTED, not
    // silently treated as wipe every URI (same for favorite/reprompt/fields).
    pub uris: Vec<UriInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct CardInput {
    pub cardholder_name: Option<String>,
    pub number: Option<String>,
    pub brand: Option<String>,
    pub exp_month: Option<String>,
    pub exp_year: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct IdentityInput {
    pub title: Option<String>,
    pub first_name: Option<String>,
    pub middle_name: Option<String>,
    pub last_name: Option<String>,
    pub username: Option<String>,
    pub company: Option<String>,
    pub ssn: Option<String>,
    pub passport_number: Option<String>,
    pub license_number: Option<String>,
    pub email: Option<String>,
    pub phone: Option<String>,
    pub address1: Option<String>,
    pub address2: Option<String>,
    pub address3: Option<String>,
    pub city: Option<String>,
    pub state: Option<String>,
    pub postal_code: Option<String>,
    pub country: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SshKeyInput {
    pub private_key: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct FieldInput {
    pub name: Option<String>,
    pub value: Option<String>,
    /// 0=Text,1=Hidden,2=Boolean,3=Linked
    pub field_type: u8,
    /// For linked fields: the numeric `LinkedIdType` target (None otherwise).
    pub linked_id: Option<u32>,
}

/// One create-or-edit payload for any item type.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    /// Present → edit; absent → create.
    pub id: Option<String>,
    pub item_type: ItemType,
    pub name: String,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
    pub favorite: bool,
    pub reprompt: bool,
    pub notes: Option<String>,
    pub login: Option<LoginInput>,
    pub card: Option<CardInput>,
    pub identity: Option<IdentityInput>,
    pub ssh_key: Option<SshKeyInput>,
    pub fields: Vec<FieldInput>,
}
