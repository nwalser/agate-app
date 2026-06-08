//! Authentication: email + master-password login (with two-factor), and logout.
//!
//! Thin wrapper over the SDK's *core* auth (`client.0.auth()`), which — unlike
//! the newer `bitwarden_auth::LoginClient` — supports a second factor. The master
//! password is passed straight into the SDK request and never stored or logged.
//!
//! NOTE: the SDK's password-manager API is unstable. The exact shape of the
//! login response (`two_factor` providers) may shift between pinned revs; this
//! is the one place to adjust if a login flow regresses.

use bitwarden_core::auth::login::{
    PasswordLoginRequest, TwoFactorEmailRequest, TwoFactorProvider, TwoFactorRequest,
};
use bitwarden_pm::PasswordManagerClient;

use crate::dto::{LoginResult, ServerConfig, TwoFactorInput, TwoFactorKind};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::server;
use crate::state::AppState;

fn to_sdk_two_factor(input: TwoFactorInput) -> TwoFactorRequest {
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
fn classify_login_error(msg: &str) -> AgateError {
    let lower = msg.to_lowercase();
    if lower.contains("username or password") || lower.contains("invalid_grant") {
        AgateError::new(ErrorKind::InvalidCredentials, "Invalid email or master password.")
    } else if lower.contains("connect") || lower.contains("dns") || lower.contains("timeout") {
        AgateError::new(ErrorKind::Network, "Could not reach the server.")
    } else {
        AgateError::new(ErrorKind::Internal, format!("Login failed: {msg}"))
    }
}

async fn build_client(state: &AppState, server: &ServerConfig) -> AgateResult<PasswordManagerClient> {
    let device_id = state.config.lock().await.device_id.clone();
    let mut settings = server::client_settings(server, device_id)?;
    // Self-hosted servers may lack the SDK's newer `/accounts/prelogin/password`
    // endpoint. Route identity traffic through a loopback proxy that rewrites
    // that one path; the SDK does all login/crypto/token work unchanged.
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

/// Attempt a master-password login. On success the vault is unlocked and the
/// client is stored in the session. If the server demands a second factor and
/// none was supplied, returns `TwoFactorRequired` without storing a session.
pub async fn login(
    state: &AppState,
    server: ServerConfig,
    email: String,
    password: String,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    // Remember this connection (server + email) up front, so it survives even a
    // failed login — the user shouldn't have to retype a self-hosted URL.
    {
        let mut cfg = state.config.lock().await;
        cfg.upsert_account(server.clone(), &email);
    }
    state.save_config().await?;

    let client = build_client(state, &server).await?;

    let request = PasswordLoginRequest {
        email: email.clone(),
        password,
        two_factor: two_factor.map(to_sdk_two_factor),
    };

    let result = client
        .0
        .auth()
        .login_password(&request)
        .await
        .map_err(|e| classify_login_error(&e.to_string()))?;

    // When the server requires 2FA, the response carries the available providers
    // and the vault stays locked.
    if let Some(providers) = result.two_factor {
        let mut kinds = Vec::new();
        if providers.authenticator.is_some() {
            kinds.push(TwoFactorKind::Authenticator);
        }
        if providers.email.is_some() {
            kinds.push(TwoFactorKind::Email);
        }
        if kinds.is_empty() {
            // An unsupported provider (Duo, WebAuthn, YubiKey…) — be honest rather
            // than pretend we can handle it.
            return Err(AgateError::new(
                ErrorKind::TwoFactorRequired,
                "This account uses a two-factor method Agate doesn't support yet.",
            ));
        }
        return Ok(LoginResult::TwoFactorRequired { providers: kinds });
    }

    // Authenticated + unlocked: mark this the active account and keep the client.
    {
        let mut cfg = state.config.lock().await;
        cfg.server = server;
        cfg.email = Some(email);
    }
    state.save_config().await?;

    state.session.lock().await.client = Some(client);
    Ok(LoginResult::Success)
}

/// Trigger the server to email a login code (Email 2FA provider).
pub async fn send_email_code(
    state: &AppState,
    server: ServerConfig,
    email: String,
    password: String,
) -> AgateResult<()> {
    let client = build_client(state, &server).await?;
    client
        .0
        .auth()
        .send_two_factor_email(&TwoFactorEmailRequest { email, password })
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Could not send email code: {e}")))
}

/// Lock the vault. When local unlock is configured the client is soft-locked
/// (kept in memory behind the local password); otherwise all secret material is
/// dropped and the master password is required to unlock again.
pub async fn lock(state: &AppState) -> AgateResult<()> {
    let soft = state.config.lock().await.local_unlock_configured;
    let mut session = state.session.lock().await;
    if soft {
        session.soft_lock();
    } else {
        session.clear_secrets();
    }
    Ok(())
}

/// Log out completely: clear the session and delete any local-unlock blob.
pub async fn logout(state: &AppState) -> AgateResult<()> {
    state.session.lock().await.clear_secrets();
    *state.breach_directory.lock().await = None;

    let email = {
        let mut cfg = state.config.lock().await;
        let email = cfg.email.take();
        cfg.local_unlock_configured = false;
        cfg.darkweb_consent = false;
        email
    };
    if let Some(email) = email {
        crate::secrets::delete_blob(&email)?;
    }
    state.save_config().await?;
    Ok(())
}
