//! Typed error surfaced to the frontend.
//!
//! Every `#[tauri::command]` returns `Result<T, AgateError>`. `AgateError` is
//! `Serialize`, so the frontend receives a structured `{ kind, message }` and can
//! branch on `kind` (a closed set) rather than string-matching a message.
//!
//! Per CLAUDE.md: commands never panic. SDK / IO / crypto errors are mapped here,
//! and secret values are NEVER included in `message`.

use serde::Serialize;

/// Closed set of error kinds the frontend may branch on.
#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum ErrorKind {
    /// No session / not logged in when one was required.
    NotAuthenticated,
    /// Vault is locked; unlock required before this operation.
    Locked,
    /// Credentials were rejected by the server.
    InvalidCredentials,
    /// The server requires a second factor we don't yet have.
    TwoFactorRequired,
    /// Wrong local password (GCM auth-tag failure) or no local unlock configured.
    LocalUnlock,
    /// Network / server communication failure.
    Network,
    /// OS keychain read/write failure.
    Keychain,
    /// Crypto operation failed (KDF, wrap/unwrap, decrypt).
    Crypto,
    /// Bad input from the frontend (validation at the trust boundary).
    BadRequest,
    /// Anything not otherwise classified.
    Internal,
}

/// Error returned from commands. `message` is human-readable and secret-free.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
pub struct AgateError {
    pub kind: ErrorKind,
    pub message: String,
}

impl AgateError {
    pub fn new(kind: ErrorKind, message: impl Into<String>) -> Self {
        Self { kind, message: message.into() }
    }

    pub fn not_authenticated() -> Self {
        Self::new(ErrorKind::NotAuthenticated, "Not logged in.")
    }

    pub fn bad_request(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::BadRequest, message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        Self::new(ErrorKind::Internal, message)
    }
}

impl std::fmt::Display for AgateError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.kind, self.message)
    }
}

impl std::error::Error for AgateError {}

/// Convenience alias for command results.
pub type AgateResult<T> = Result<T, AgateError>;
