//! Autofill DTOs: the detection mode, the detected login-field context, ranked
//! candidates, and the feature status surfaced to the frontend.
//!
//! The headline feature behind these shapes: Agate can watch other applications'
//! login fields (a webview OAuth popup, a native app, …) and fill the matching
//! vault login directly — no clipboard, no copy-paste. Detection + injection are
//! Windows-only (UIA); these DTOs are cross-platform so the Settings UI and the
//! tray popup compile everywhere.

use serde::{Deserialize, Serialize};

/// How — and whether — Agate watches other apps' login fields to offer autofill.
/// A closed set so neither the picker nor the persisted config ever carries a
/// bare string (per CLAUDE.md).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum AutofillMode {
    /// Disabled — Agate never inspects other windows. The default.
    #[default]
    Off,
    /// On-demand only: a global hotkey inspects the foreground window when the
    /// user explicitly asks. Smallest surface — nothing is watched continuously.
    Hotkey,
    /// Always-watch: a focus hook offers autofill whenever a login field in
    /// any application gains focus. Most convenient, largest surface.
    Watch,
}

/// Which kind of login field was detected — so the popup knows what a fill would
/// land, and the injector types the right value (the username vs the password).
/// A closed set per CLAUDE.md (no bare strings across IPC).
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum AutofillField {
    /// A masked secret field (`IsPassword`) — fill the login's password. The
    /// default: it's the original, narrowest detection surface.
    #[default]
    Password,
    /// A username / email field (an editable control whose accessible label
    /// names a user/email/login) — fill the login's username, then tab to and
    /// fill the password too.
    Username,
    /// A one-time-code / TOTP / 2FA field (an editable control whose label names a
    /// verification / authenticator code) — fill the login's current TOTP code.
    Totp,
}

/// What was detected at the focused / foreground login field — shown in the popup
/// header so the user sees WHERE a fill would land before confirming. Carries no
/// secrets: a process name, a window title, and a best-effort URL are not secret.
#[derive(Debug, Clone, Default, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AutofillContext {
    /// Which kind of field was focused — the popup labels the fill and the
    /// injector types the matching value (username vs password).
    pub field: AutofillField,
    /// Owning process file stem, e.g. "outlook" / "msedgewebview2". None when it
    /// couldn't be resolved.
    pub process_name: Option<String>,
    /// Foreground window title, e.g. "Sign in to your account".
    pub window_title: Option<String>,
    /// Best-effort URL when the field lives in a webview that exposes one
    /// (browser-like). Usually None for embedded OAuth popups, which is exactly
    /// why matching also falls back to the process name + window title.
    pub url: Option<String>,
    /// The URI to add to a login's autofill URIs when the user picks a
    /// non-matching login and opts to "remember it for this app". The real URL
    /// when present, else a synthetic `app://<process>` association (no local
    /// store — it rides Bitwarden sync and the matcher recognizes it). None when
    /// neither is known.
    pub associate_uri: Option<String>,
}

/// A vault login ranked as a possible fill for the detected target. No password —
/// the secret is fetched only at the moment of fill, in the backend.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AutofillCandidate {
    pub account_email: String,
    pub account_label: String,
    pub item_id: String,
    pub name: String,
    pub username: Option<String>,
    pub uri: Option<String>,
    /// "Require master password to view" (reprompt) is set — the popup gates these
    /// (defers to the main window) instead of filling, mirroring the copy path.
    pub reprompt: bool,
    /// Higher = better match. Purely for ordering the candidates in the popup.
    pub score: u32,
}

/// The detected target plus its ranked candidates — the popup's fill-mode payload.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AutofillPending {
    /// Opaque token tying a later `autofill_fill` back to THIS detection, so a
    /// stale popup can't fill into a window that has since changed underneath it.
    pub token: String,
    pub context: AutofillContext,
    pub candidates: Vec<AutofillCandidate>,
}

/// Feature status for the Settings page + the popup's gating.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AutofillStatus {
    pub mode: AutofillMode,
    /// Whether this platform / build can actually watch + inject (Windows only).
    /// When false the Settings page shows the feature as unavailable rather than
    /// letting the user arm a mode that does nothing.
    pub supported: bool,
    /// Human label for the on-demand hotkey, e.g. "Ctrl+Alt+\".
    pub hotkey: String,
}
