//! Connection management: add / remove / list connections, plus app-wide lock and
//! logout. A "connection" is one Bitwarden account (server + email) whose master
//! password is sealed under the VMK (see `appunlock.rs` / `secrets.rs`).
//!
//! Adding a connection requires the app to be unlocked (a VMK in the session) so
//! the credentials can be sealed immediately — we never hold an unsealed
//! connection. The connection is recorded in config only *after* the keychain
//! write succeeds, so there are no phantom accounts that can't be unlocked.

use zeroize::Zeroizing;

use crate::appunlock;
use crate::auth::{self, LoginOutcome};
use crate::dto::{ConnectionSummary, LoginResult, ServerConfig, TwoFactorInput};
use crate::error::{AgateError, AgateResult};
use crate::secrets::{self, StoredConnection};
use crate::server;
use crate::state::{AppState, LiveConnection};

/// List configured connections, marking which are currently unlocked.
pub async fn list_connections(state: &AppState) -> AgateResult<Vec<ConnectionSummary>> {
    let accounts = state.config.lock().await.accounts.clone();
    let live: std::collections::HashSet<String> =
        state.session.lock().await.connections.keys().cloned().collect();
    Ok(accounts
        .iter()
        .map(|a| ConnectionSummary {
            email: a.email.clone(),
            server_label: server::server_label(&a.server),
            server: a.server.clone(),
            unlocked: live.contains(&a.email),
        })
        .collect())
}

/// Add (or re-authenticate) a connection. Logs in; on success seals the master
/// password under the VMK, records the connection, and adds it live. If the
/// server demands a second factor, returns `TwoFactorRequired` and the frontend
/// re-calls with the code.
pub async fn add_connection(
    state: &AppState,
    server: ServerConfig,
    email: String,
    password: Zeroizing<String>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    // App-unlock must exist first so we can seal the credentials we're about to
    // accept. (The onboarding flow sets the app password before adding accounts.)
    let vmk = appunlock::current_vmk(state)
        .await
        .map_err(|_| AgateError::bad_request("Set an app password before adding a connection."))?;

    match auth::login_password(state, &server, &email, password.clone(), two_factor).await? {
        LoginOutcome::TwoFactorRequired(providers) => Ok(LoginResult::TwoFactorRequired { providers }),
        LoginOutcome::Success(client) => {
            // Seal first; only record the connection if the keychain write succeeds.
            let stored = StoredConnection {
                server: server.clone(),
                email: email.clone(),
                master_password: (*password).clone(),
            };
            appunlock::seal_connection(&vmk, &stored)?;

            {
                let mut cfg = state.config.lock().await;
                cfg.upsert_account(server.clone(), &email);
                cfg.server = server;
            }
            {
                let mut session = state.session.lock().await;
                session.connections.insert(email.clone(), LiveConnection::new(client));
                if session.active_email.is_none() {
                    session.active_email = Some(email.clone());
                }
            }
            state.save_config().await?;
            Ok(LoginResult::Success)
        }
    }
}

/// Send the Email-2FA login code while *adding* a connection (the caller still
/// holds the typed master password).
pub async fn send_add_email_code(
    state: &AppState,
    server: ServerConfig,
    email: String,
    password: Zeroizing<String>,
) -> AgateResult<()> {
    auth::send_email_code(state, &server, email, password).await
}

/// Forget a connection: delete its sealed credentials, drop the live client, and
/// remove it from the config list.
pub async fn remove_connection(state: &AppState, email: String) -> AgateResult<()> {
    secrets::delete_cred(&email)?;
    {
        let mut session = state.session.lock().await;
        session.connections.remove(&email);
        if session.active_email.as_deref() == Some(email.as_str()) {
            session.active_email = session.connections.keys().next().cloned();
        }
    }
    {
        let mut cfg = state.config.lock().await;
        cfg.accounts.retain(|a| a.email != email);
    }
    state.save_config().await
}

/// Set which account is "active" (the default target for creating new items).
pub async fn set_active(state: &AppState, email: String) -> AgateResult<()> {
    let mut session = state.session.lock().await;
    if !session.connections.contains_key(&email) {
        return Err(AgateError::bad_request("That connection is not unlocked."));
    }
    session.active_email = Some(email);
    Ok(())
}

/// Remember the last-used server (add-connection form prefill).
pub async fn set_server(state: &AppState, server: ServerConfig) -> AgateResult<()> {
    state.config.lock().await.server = server;
    state.save_config().await
}

/// Lock the app: drop every client, the decrypted caches, and the VMK. Re-unlock
/// with the app password (or Hello).
pub async fn lock(state: &AppState) -> AgateResult<()> {
    state.session.lock().await.clear_secrets();
    Ok(())
}

/// Log out of everything: delete every sealed credential, the app-unlock blob, and
/// the Hello blob; clear the session and app-unlock flags. The connection list
/// (server + email, non-secret) is kept so re-adding is prefilled.
pub async fn logout(state: &AppState) -> AgateResult<()> {
    let accounts = state.config.lock().await.accounts.clone();
    for a in &accounts {
        let _ = secrets::delete_cred(&a.email); // ignore: best-effort teardown
    }
    let _ = secrets::delete_key(secrets::APP_UNLOCK_KEY);
    let _ = secrets::delete_hello_blob();
    let _ = secrets::delete_device_pepper(); // ignore: best-effort teardown

    state.session.lock().await.clear_secrets();
    *state.breach_directory.lock().await = None;
    {
        let mut cfg = state.config.lock().await;
        cfg.app_unlock_configured = false;
        cfg.hello_configured = false;
        cfg.darkweb_consent = false;
        cfg.unlock_device_bound = false;
    }
    state.save_config().await
}
