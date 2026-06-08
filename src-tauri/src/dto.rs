//! Data-transfer objects shared with the frontend.
//!
//! These mirror `src/lib/types.ts`. Keep the two in sync. All closed sets are
//! enums (serialized as lowercase strings) — never bare strings — per CLAUDE.md.

use serde::{Deserialize, Serialize};

/// Which Bitwarden server to talk to.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(tag = "region", rename_all = "camelCase")]
pub enum ServerConfig {
    /// Bitwarden US cloud (bitwarden.com).
    #[default]
    Us,
    /// Bitwarden EU cloud (bitwarden.eu).
    Eu,
    /// Self-hosted Bitwarden or Vaultwarden at an arbitrary base URL.
    #[serde(rename_all = "camelCase")]
    SelfHosted { base_url: String },
}

/// Second-factor input from the unlock/login screen.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TwoFactorInput {
    pub provider: TwoFactorKind,
    pub token: String,
    #[serde(default)]
    pub remember: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TwoFactorKind {
    Authenticator,
    Email,
}

/// Result of a login attempt.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LoginResult {
    /// Authenticated and the vault is unlocked.
    Success,
    /// Server requires a second factor; `providers` lists what it offers.
    #[serde(rename_all = "camelCase")]
    TwoFactorRequired { providers: Vec<TwoFactorKind> },
}

/// Overall app/session status the frontend uses to pick a screen.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// A logged-in session exists (tokens present).
    pub logged_in: bool,
    /// The vault key is loaded (decryption possible).
    pub unlocked: bool,
    /// A local-password unlock has been configured for this account.
    pub local_unlock_configured: bool,
    /// Email of the logged-in account, if known.
    pub email: Option<String>,
}

/// Closed set of Bitwarden item types.
#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
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
#[serde(rename_all = "camelCase")]
pub struct VaultItem {
    pub id: String,
    pub name: String,
    pub item_type: ItemType,
    pub username: Option<String>,
    pub has_totp: bool,
    pub favorite: bool,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
}

/// A single login URI.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginUri {
    pub uri: Option<String>,
}

/// Login-type detail.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoginDetail {
    pub username: Option<String>,
    pub password: Option<String>,
    pub uris: Vec<LoginUri>,
    pub has_totp: bool,
}

/// A custom field on an item.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomField {
    pub name: Option<String>,
    pub value: Option<String>,
    /// "text" | "hidden" | "boolean" | "linked"
    pub field_type: String,
}

/// Full decrypted item detail for the detail pane.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemDetail {
    pub id: String,
    pub name: String,
    pub item_type: ItemType,
    pub favorite: bool,
    pub notes: Option<String>,
    pub login: Option<LoginDetail>,
    pub fields: Vec<CustomField>,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
}

/// A generated TOTP code plus timing so the UI can render a countdown.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TotpCode {
    pub code: String,
    pub period: u32,
    /// Seconds remaining until this code rolls over.
    pub remaining: u32,
}

/// A vault folder.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: Option<String>,
    pub name: String,
}

/// Password-generator options from the UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PasswordGenOptions {
    pub length: u8,
    pub uppercase: bool,
    pub lowercase: bool,
    pub numbers: bool,
    pub special: bool,
}

impl Default for PasswordGenOptions {
    fn default() -> Self {
        Self { length: 16, uppercase: true, lowercase: true, numbers: true, special: true }
    }
}
