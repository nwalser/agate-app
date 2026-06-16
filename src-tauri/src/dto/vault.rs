//! Vault item DTOs: list rows, full item detail, folders, TOTP, and the
//! create/edit input shapes (frontend → backend). Mirrors `src/lib/types.ts`.

use serde::{Deserialize, Serialize};

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

/// One past password (with when it was replaced) for the login's history viewer.
/// The password VALUE is a secret — the pane masks/reprompt-gates it like any
/// password before revealing.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PasswordHistoryEntry {
    pub password: String,
    /// When this password was replaced (RFC 3339).
    pub last_used_date: String,
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
    /// When the password was last changed (RFC 3339). None if never recorded.
    pub password_revision_date: Option<String>,
    /// Whether autofill-on-page-load is enabled (None = inherit the global default).
    pub autofill_on_page_load: Option<bool>,
    /// Past passwords (cipher-level in Bitwarden; surfaced here under the login for
    /// the history viewer). Empty when none stored.
    pub password_history: Vec<PasswordHistoryEntry>,
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
    /// Credential id (base64url) — the public handle identifying this passkey,
    /// so the UI can target it for removal. Not secret (it's the WebAuthn id).
    pub credential_id: String,
    /// Relying-party (site) id, e.g. "github.com".
    pub rp_id: String,
    pub rp_name: Option<String>,
    pub user_name: Option<String>,
    pub user_display_name: Option<String>,
    pub key_algorithm: String,
    /// Creation timestamp (RFC 3339).
    pub creation_date: String,
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
    /// The owning organization's display name (from the sync profile). Empty when
    /// the name isn't known yet (e.g. profile lacked it) — the UI falls back to a
    /// generic label so the org is still selectable.
    pub organization_name: String,
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
    /// Autofill-on-page-load toggle (None = inherit the global default). Optional
    /// so an older payload that omits it round-trips to None.
    pub autofill_on_page_load: Option<bool>,
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
    /// Bitwarden collections to create the item into (an org cipher belongs to one
    /// or more collections). Create-only: a non-empty list routes the create
    /// through `POST /ciphers/create` as an org cipher. Empty = a personal cipher.
    /// Ignored on edit (collection membership is changed in the main client) and by
    /// non-Bitwarden providers. Defaults to empty so older / personal payloads and
    /// the edit path round-trip without it.
    #[serde(default)]
    pub collection_ids: Vec<String>,
    pub favorite: bool,
    pub reprompt: bool,
    pub notes: Option<String>,
    pub login: Option<LoginInput>,
    pub card: Option<CardInput>,
    pub identity: Option<IdentityInput>,
    pub ssh_key: Option<SshKeyInput>,
    pub fields: Vec<FieldInput>,
}
