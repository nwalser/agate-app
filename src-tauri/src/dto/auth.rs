//! Auth / session / connection DTOs shared with the frontend.
//!
//! Server config, two-factor input, login + unlock outcomes, and the overall
//! session status the UI uses to pick a screen. Mirrors `src/lib/types.ts`.

use serde::{Deserialize, Serialize};

/// Which Bitwarden server to talk to.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
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
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct TwoFactorInput {
    pub provider: TwoFactorKind,
    pub token: String,
    // No serde(default): every 2FA caller states `remember` explicitly, and the
    // generated TS contract should require it (an omitted security choice is a
    // bug, not a default).
    pub remember: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum TwoFactorKind {
    Authenticator,
    Email,
}

/// Result of a login attempt.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum LoginResult {
    /// Authenticated and the vault is unlocked.
    Success,
    /// Server requires a second factor; `providers` lists what it offers.
    #[serde(rename_all = "camelCase")]
    TwoFactorRequired { providers: Vec<TwoFactorKind> },
}

/// One configured connection for the unlock screen, settings, and the
/// Closed set of vault providers a connection can speak. Serialized lowercase
/// into `config.json` and over IPC; a missing value deserializes to `bitwarden`
/// (every pre-provider connection was one).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ConnectionKind {
    #[default]
    Bitwarden,
    Keepass,
}

/// add-connection quick-pick. Non-secret (server + email only).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSummary {
    /// Which provider backs this connection.
    pub kind: ConnectionKind,
    pub email: String,
    pub server_label: String,
    /// The full server config, so the add-connection form can prefill it.
    pub server: ServerConfig,
    /// Whether this connection is currently unlocked (live this session).
    pub unlocked: bool,
    /// Whether this connection's master password is stored (sealed) so it
    /// auto-unlocks, vs. manual-unlock only (password never persisted).
    pub store_credentials: bool,
}

/// Per-connection result of an `unlock_all`, so the UI can show progress and
/// drive per-connection reconnect / 2FA.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum UnlockStatus {
    /// Connection re-logged-in and unlocked.
    Unlocked,
    /// The server needs a second factor before this connection can unlock.
    #[serde(rename_all = "camelCase")]
    TwoFactorRequired { providers: Vec<TwoFactorKind> },
    /// This connection is manual-unlock only (its password is not stored), so it
    /// was left locked — the user unlocks it on demand with its master password.
    ManualUnlock,
    /// Re-login failed (network / credentials / corrupt blob); message is
    /// secret-free.
    #[serde(rename_all = "camelCase")]
    Failed { message: String },
}

/// One connection's outcome from `unlock_all`.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UnlockOutcome {
    pub email: String,
    pub server_label: String,
    #[serde(flatten)]
    pub status: UnlockStatus,
}

/// Overall app/session status the frontend uses to pick a screen.
#[derive(Debug, Clone, Serialize, Default)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    /// An app-unlock password has been configured (the unified unlock secret).
    pub app_unlock_configured: bool,
    /// The app is unlocked (the App Unlock Key is held; the vault is visible).
    pub unlocked: bool,
    /// Windows Hello unlock has been enabled (app-wide; Windows only).
    pub hello_configured: bool,
    /// Number of configured connections (whether or not currently unlocked).
    pub connection_count: usize,
    /// Number of connections currently unlocked this session.
    pub live_count: usize,
}
