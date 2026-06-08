//! Low-level master-password login helpers, shared by `connections.rs` and
//! `appunlock.rs`. These build an SDK client and run the core 2FA-capable login
//! (`client.0.auth()`), but DO NOT touch session/config state — callers decide
//! what to do with a freshly logged-in client (store it as a live connection,
//! seal its credentials, …).
//!
//! The master password is passed straight into the SDK request and never logged
//! here. Persisted credentials live, sealed, in `secrets.rs`.
//!
//! NOTE: the SDK's password-manager API is unstable. The exact shape of the login
//! response (`two_factor` providers) may shift between pinned revs; this is the
//! one place to adjust if a login flow regresses.

use bitwarden_core::auth::login::{
    PasswordLoginRequest, TwoFactorEmailRequest, TwoFactorProvider, TwoFactorRequest,
};
use bitwarden_pm::PasswordManagerClient;
use zeroize::Zeroizing;

use crate::dto::{ServerConfig, TwoFactorInput, TwoFactorKind};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::server;
use crate::state::AppState;

/// Outcome of a master-password login (no session side effects).
pub(crate) enum LoginOutcome {
    /// Authenticated + unlocked; the caller owns the returned client.
    Success(PasswordManagerClient),
    /// The server requires a second factor it offers via `providers`.
    TwoFactorRequired(Vec<TwoFactorKind>),
}

pub(crate) fn to_sdk_two_factor(input: TwoFactorInput) -> TwoFactorRequest {
    TwoFactorRequest {
        token: input.token,
        provider: match input.provider {
            TwoFactorKind::Authenticator => TwoFactorProvider::Authenticator,
            TwoFactorKind::Email => TwoFactorProvider::Email,
        },
        remember: input.remember,
    }
}

/// Classify a login error from its message (the SDK error type is not stable
/// enough to match on; the message is). Secret-free.
pub(crate) fn classify_login_error(msg: &str) -> AgateError {
    let lower = msg.to_lowercase();
    if lower.contains("username or password") || lower.contains("invalid_grant") {
        AgateError::new(ErrorKind::InvalidCredentials, "Invalid email or master password.")
    } else if lower.contains("connect") || lower.contains("dns") || lower.contains("timeout") {
        AgateError::new(ErrorKind::Network, "Could not reach the server.")
    } else {
        AgateError::new(ErrorKind::Internal, format!("Login failed: {msg}"))
    }
}

pub(crate) async fn build_client(
    state: &AppState,
    server: &ServerConfig,
) -> AgateResult<PasswordManagerClient> {
    let device_id = state.config.lock().await.device_id.clone();
    let mut settings = server::client_settings(server, device_id)?;
    // Self-hosted servers may lack the SDK's newer `/accounts/prelogin/password`
    // endpoint. Route identity traffic through a loopback proxy that rewrites that
    // one path; the SDK does all login/crypto/token work unchanged.
    if matches!(server, ServerConfig::SelfHosted { .. }) {
        let upstream_identity = settings.identity_url.clone();
        settings.identity_url = crate::proxy::ensure_proxy(&upstream_identity)
            .map_err(|e| AgateError::new(ErrorKind::Network, format!("identity proxy: {e}")))?;
        // Route the API through the proxy too (no path rewrite needed there; this
        // also captures the /sync response shape for diagnostics).
        let upstream_api = settings.api_url.clone();
        settings.api_url = crate::proxy::ensure_proxy(&upstream_api)
            .map_err(|e| AgateError::new(ErrorKind::Network, format!("api proxy: {e}")))?;
    }
    Ok(PasswordManagerClient::new(Some(settings)))
}

/// Run a master-password login. Builds a client for `server`, performs the core
/// 2FA-capable login, and returns the client on success or the offered 2FA
/// providers. No session/config mutation — the caller owns the result.
pub(crate) async fn login_password(
    state: &AppState,
    server: &ServerConfig,
    email: &str,
    password: Zeroizing<String>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginOutcome> {
    let client = build_client(state, server).await?;

    let request = PasswordLoginRequest {
        email: email.to_string(),
        // The SDK consumes the password by value; this owned copy is the
        // documented unavoidable residue (we can't zeroize inside the SDK).
        password: (*password).clone(),
        two_factor: two_factor.map(to_sdk_two_factor),
    };

    let result = client
        .0
        .auth()
        .login_password(&request)
        .await
        .map_err(|e| classify_login_error(&e.to_string()))?;

    if let Some(providers) = result.two_factor {
        let mut kinds = Vec::new();
        if providers.authenticator.is_some() {
            kinds.push(TwoFactorKind::Authenticator);
        }
        if providers.email.is_some() {
            kinds.push(TwoFactorKind::Email);
        }
        if kinds.is_empty() {
            // An unsupported provider (Duo, WebAuthn, YubiKey…) — be honest.
            return Err(AgateError::new(
                ErrorKind::TwoFactorRequired,
                "This account uses a two-factor method Agate doesn't support yet.",
            ));
        }
        return Ok(LoginOutcome::TwoFactorRequired(kinds));
    }

    Ok(LoginOutcome::Success(client))
}

/// Trigger the server to email a login code (Email 2FA provider). Used by the
/// add-connection flow, where the caller still holds the typed master password.
pub(crate) async fn send_email_code(
    state: &AppState,
    server: &ServerConfig,
    email: String,
    password: Zeroizing<String>,
) -> AgateResult<()> {
    let client = build_client(state, server).await?;
    client
        .0
        .auth()
        .send_two_factor_email(&TwoFactorEmailRequest { email, password: (*password).clone() })
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Could not send email code: {e}")))
}
