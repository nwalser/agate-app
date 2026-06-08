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

/// One configured connection for the unlock screen, settings, and the
/// add-connection quick-pick. Non-secret (server + email only).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    pub email: String,
    pub server_label: String,
    /// The full server config, so the add-connection form can prefill it.
    pub server: ServerConfig,
    /// Whether this connection is currently unlocked (live this session).
    pub unlocked: bool,
}

/// Per-connection result of an `unlock_all`, so the UI can show progress and
/// drive per-connection reconnect / 2FA.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UnlockStatus {
    /// Connection re-logged-in and unlocked.
    Unlocked,
    /// The server needs a second factor before this connection can unlock.
    #[serde(rename_all = "camelCase")]
    TwoFactorRequired { providers: Vec<TwoFactorKind> },
    /// Re-login failed (network / credentials / corrupt blob); message is
    /// secret-free.
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

/// One connection's outcome from `unlock_all`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UnlockOutcome {
    pub email: String,
    pub server_label: String,
    #[serde(flatten)]
    pub status: UnlockStatus,
}

/// Overall app/session status the frontend uses to pick a screen.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// An app-unlock password has been configured (the unified unlock secret).
    pub app_unlock_configured: bool,
    /// The app is unlocked (the App Unlock Key is held; the vault is visible).
    pub unlocked: bool,
    /// Windows Hello unlock has been enabled (app-wide; Windows only).
    pub hello_configured: bool,
    /// The user has opted in to the dark-web monitor (sends emails to a third
    /// party). Default false; gates the network email-breach lookups.
    pub darkweb_consent: bool,
    /// Number of configured connections (whether or not currently unlocked).
    pub connection_count: usize,
    /// Number of connections currently unlocked this session.
    pub live_count: usize,
}

/// Closed set of Bitwarden item types.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
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
    pub favorite: bool,
    pub deleted: bool,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
}

/// A single login URI (with its match strategy so edits round-trip).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginUri {
    pub uri: Option<String>,
    pub match_type: Option<u8>,
}

/// Login-type detail.
#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LoginDetail {
    pub username: Option<String>,
    pub password: Option<String>,
    /// The TOTP secret/URI itself (so an edit can preserve it).
    pub totp: Option<String>,
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

/// Full decrypted item detail for the detail pane and the editor (prefill).
#[derive(Debug, Clone, Serialize)]
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

/// A vault folder. In the unified view folders are per-connection, so each
/// carries its owning account; "move to folder" is scoped to that account.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Folder {
    pub id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub account_email: String,
    #[serde(default)]
    pub account_label: String,
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
    #[serde(default)]
    pub avoid_ambiguous: bool,
    #[serde(default)]
    pub min_number: Option<u8>,
    #[serde(default)]
    pub min_special: Option<u8>,
}

impl Default for PasswordGenOptions {
    fn default() -> Self {
        Self {
            length: 16,
            uppercase: true,
            lowercase: true,
            numbers: true,
            special: true,
            avoid_ambiguous: false,
            min_number: None,
            min_special: None,
        }
    }
}

/// Passphrase-generator options from the UI.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassphraseGenOptions {
    pub num_words: u8,
    pub word_separator: String,
    pub capitalize: bool,
    pub include_number: bool,
}

impl Default for PassphraseGenOptions {
    fn default() -> Self {
        Self { num_words: 3, word_separator: "-".into(), capitalize: true, include_number: true }
    }
}

// ---------------------------------------------------------------------------
// Item create/edit input (frontend → backend). Discriminated by `itemType`;
// only the matching sub-object is read. Mirrors `src/lib/types.ts` ItemInput.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UriInput {
    pub uri: Option<String>,
    /// 0=Domain,1=Host,2=StartsWith,3=Exact,4=Regex,5=Never; null = default.
    pub match_type: Option<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginInput {
    pub username: Option<String>,
    pub password: Option<String>,
    pub totp: Option<String>,
    #[serde(default)]
    pub uris: Vec<UriInput>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
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
#[serde(rename_all = "camelCase")]
pub struct SshKeyInput {
    pub private_key: String,
    pub public_key: String,
    pub fingerprint: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldInput {
    pub name: Option<String>,
    pub value: Option<String>,
    /// 0=Text,1=Hidden,2=Boolean,3=Linked
    pub field_type: u8,
}

// ---------------------------------------------------------------------------
// Security audit / vault health (backend → frontend).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HealthBand {
    Critical,
    Poor,
    Fair,
    Good,
    Excellent,
}

/// Per-item offline audit findings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemAudit {
    pub id: String,
    pub name: String,
    pub reused: bool,
    pub weak: bool,
    pub weak_score: Option<u8>,
    pub old: bool,
    pub insecure_uri: bool,
    pub no_totp: bool,
}

/// Aggregate vault-health report (all offline; no secret leaves the device).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultHealthReport {
    pub score: u8,
    pub band: HealthBand,
    pub total_logins: usize,
    pub reused: usize,
    pub weak: usize,
    pub old: usize,
    pub insecure: usize,
    pub no_totp: usize,
    pub at_risk: Vec<ItemAudit>,
}

/// Result of the opt-in HIBP exposed-password check (k-anonymity).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExposedResult {
    pub id: String,
    pub name: String,
    pub count: u64,
}

// ---------------------------------------------------------------------------
// Dark-web / breach monitor (darkweb.rs → frontend). Two free, keyless
// providers: XposedOrNot (per-email breach lookup — full email leaves the
// device, hence opt-in) and HIBP's public /breaches directory (no email sent).
// `BreachRecord` is a unified shape both providers map onto.
// ---------------------------------------------------------------------------

/// One breach. `data_classes` is the headline: *what personal data leaked*.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreachRecord {
    /// Display/stable name, e.g. "Adobe".
    pub name: String,
    /// Associated domain (may be empty).
    pub domain: String,
    /// Breach date as the provider gives it (a year "2026" or "YYYY-MM-DD").
    pub breach_date: Option<String>,
    /// Accounts in the breach, if known.
    pub pwn_count: Option<u64>,
    /// Categories of personal data exposed ("Email addresses", "Passwords", …).
    pub data_classes: Vec<String>,
    /// Human description (may contain HTML when sourced from HIBP).
    pub description: Option<String>,
    /// Logo URL, if any.
    pub logo: Option<String>,
    /// Whether the provider marks the breach as verified.
    pub verified: bool,
    /// How exposed passwords were stored ("plaintext", "hardtocrack", …); may be absent.
    pub password_risk: Option<String>,
}

/// Per-email scan result from the dark-web monitor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountBreaches {
    pub email: String,
    pub breaches: Vec<BreachRecord>,
    /// Union of every data class across this email's breaches.
    pub exposed_data: Vec<String>,
    /// Overall risk label/score the provider assigns the address, if any.
    pub risk_label: Option<String>,
    pub risk_score: Option<i64>,
}

/// Aggregate dark-web report across every account email found in the vault.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DarkWebReport {
    /// Every email actually scanned, including clean ones (empty `breaches`).
    pub accounts: Vec<AccountBreaches>,
    /// Total breaches across all scanned emails.
    pub total_breaches: usize,
    /// How many scanned emails came back clean.
    pub clean: usize,
    /// Emails found in the vault but NOT scanned (per-run cap, to respect the
    /// provider's daily rate limit). Surfaced so coverage is never silently lost.
    pub skipped: usize,
}

/// One create-or-edit payload for any item type.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ItemInput {
    /// Present → edit; absent → create.
    pub id: Option<String>,
    pub item_type: ItemType,
    pub name: String,
    pub folder_id: Option<String>,
    pub organization_id: Option<String>,
    #[serde(default)]
    pub favorite: bool,
    #[serde(default)]
    pub reprompt: bool,
    pub notes: Option<String>,
    pub login: Option<LoginInput>,
    pub card: Option<CardInput>,
    pub identity: Option<IdentityInput>,
    pub ssh_key: Option<SshKeyInput>,
    #[serde(default)]
    pub fields: Vec<FieldInput>,
}

/// Where the custom titlebar's window-control buttons sit and in what order, so
/// a borderless window (Windows/Linux) matches the host. On Linux this is read
/// from the desktop's `button-layout`; elsewhere it's a fixed platform default.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowControlsLayout {
    pub side: ControlsSide,
    pub buttons: Vec<WindowControl>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ControlsSide {
    Left,
    Right,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum WindowControl {
    Minimize,
    Maximize,
    Close,
}
