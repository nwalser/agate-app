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
            store_credentials: a.store_credentials,
        })
        .collect())
}

/// Add (or re-authenticate) a connection. Logs in; on success, when
/// `store_credentials` is set, seals the master password under the VMK so the
/// connection auto-unlocks later — otherwise the password is never persisted and
/// the connection is manual-unlock only. Records the connection and adds it live.
/// If the server demands a second factor, returns `TwoFactorRequired`.
pub async fn add_connection(
    state: &AppState,
    server: ServerConfig,
    email: String,
    password: Zeroizing<String>,
    store_credentials: bool,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    // App-unlock must exist first: a connection joins the app's unlock set, and (if
    // storing) we seal its credentials under the VMK. (Onboarding sets the app
    // password before adding accounts.)
    let vmk = appunlock::current_vmk(state)
        .await
        .map_err(|_| AgateError::bad_request("Set an app password before adding a connection."))?;

    match auth::login_password(state, &server, &email, password.clone(), two_factor).await? {
        LoginOutcome::TwoFactorRequired(providers) => Ok(LoginResult::TwoFactorRequired { providers }),
        LoginOutcome::Success(client) => {
            // Seal first (when storing); only record the connection once persisted.
            if store_credentials {
                let stored = StoredConnection {
                    server: server.clone(),
                    email: email.clone(),
                    master_password: (*password).clone(),
                };
                appunlock::seal_connection(&vmk, &stored)?;
            } else {
                // Manual-unlock connection: make sure no stale sealed password lingers.
                secrets::delete_cred(&email)?;
            }

            state
                .update_config(|cfg| {
                    cfg.upsert_account(server.clone(), &email, store_credentials);
                    cfg.server = server.clone();
                })
                .await?;
            {
                let mut session = state.session.lock().await;
                session.connections.insert(email.clone(), LiveConnection::new(client));
                if session.active_email.is_none() {
                    session.active_email = Some(email.clone());
                }
            }
            Ok(LoginResult::Success)
        }
    }
}

/// Edit an existing connection: change its server and/or whether its password is
/// stored, optionally re-authenticating with a new master password.
///
/// * With a `password` (required when the server changes or when turning storage
///   on): re-logs-in, refreshes the live client, then seals the password (store) or
///   drops it (manual).
/// * Without a `password`: only the storage flag may change. Turning storage *off*
///   deletes the sealed password; turning it *on* without a password is rejected
///   (we can't seal what we don't have).
pub async fn update_connection(
    state: &AppState,
    email: String,
    server: ServerConfig,
    store_credentials: bool,
    password: Option<Zeroizing<String>>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let existing = state
        .config
        .lock()
        .await
        .account_for(&email)
        .cloned()
        .ok_or_else(|| AgateError::bad_request("No such connection."))?;

    // Re-auth path: a password was supplied (or is required because the server
    // changed). Validate it, refresh the live client, and (re)seal or drop it.
    let server_changed = !server_eq(&existing.server, &server);
    if let Some(pw) = password {
        let vmk = appunlock::current_vmk(state)
            .await
            .map_err(|_| AgateError::bad_request("Unlock the app first."))?;
        match auth::login_password(state, &server, &email, pw.clone(), two_factor).await? {
            LoginOutcome::TwoFactorRequired(providers) => {
                return Ok(LoginResult::TwoFactorRequired { providers })
            }
            LoginOutcome::Success(client) => {
                if store_credentials {
                    let stored = StoredConnection {
                        server: server.clone(),
                        email: email.clone(),
                        master_password: (*pw).clone(),
                    };
                    appunlock::seal_connection(&vmk, &stored)?;
                } else {
                    secrets::delete_cred(&email)?;
                }
                state
                    .update_config(|cfg| cfg.upsert_account(server.clone(), &email, store_credentials))
                    .await?;
                {
                    let mut session = state.session.lock().await;
                    session.connections.insert(email.clone(), LiveConnection::new(client));
                    if session.active_email.is_none() {
                        session.active_email = Some(email.clone());
                    }
                }
                return Ok(LoginResult::Success);
            }
        }
    }

    // No-password path: only a storage-flag change is allowed.
    if server_changed {
        return Err(AgateError::bad_request(
            "Enter your master password to change this connection's server.",
        ));
    }
    if store_credentials {
        // Turning storage on requires the password to seal it.
        if secrets::load_cred(&email)?.is_none() {
            return Err(AgateError::bad_request(
                "Enter your master password to store this connection.",
            ));
        }
    } else {
        // Turning storage off: forget the sealed password (the live session stays).
        secrets::delete_cred(&email)?;
    }
    state
        .update_config(|cfg| cfg.upsert_account(existing.server.clone(), &email, store_credentials))
        .await?;
    Ok(LoginResult::Success)
}

/// Unlock a single connection on demand with its master password (for
/// manual-unlock connections, or to retry one that failed). Logs in and adds it
/// live for this session — the password is not persisted here. Returns
/// `TwoFactorRequired` if the server demands a second factor.
pub async fn unlock_connection(
    state: &AppState,
    email: String,
    password: Zeroizing<String>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let server = state
        .config
        .lock()
        .await
        .server_for(&email)
        .ok_or_else(|| AgateError::bad_request("No such connection."))?;

    match auth::login_password(state, &server, &email, password, two_factor).await? {
        LoginOutcome::TwoFactorRequired(providers) => Ok(LoginResult::TwoFactorRequired { providers }),
        LoginOutcome::Success(client) => {
            let mut session = state.session.lock().await;
            session.connections.insert(email.clone(), LiveConnection::new(client));
            if session.active_email.is_none() {
                session.active_email = Some(email);
            }
            Ok(LoginResult::Success)
        }
    }
}

/// Structural equality for two server configs (no `PartialEq` derive on the DTO).
fn server_eq(a: &ServerConfig, b: &ServerConfig) -> bool {
    match (a, b) {
        (ServerConfig::Us, ServerConfig::Us) => true,
        (ServerConfig::Eu, ServerConfig::Eu) => true,
        (ServerConfig::SelfHosted { base_url: x }, ServerConfig::SelfHosted { base_url: y }) => x == y,
        _ => false,
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
    // Drops the account record AND its AI allowlist grants — see remove_account.
    state.update_config(|cfg| cfg.remove_account(&email)).await
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
    state.update_config(|cfg| cfg.server = server).await
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
    let _ = secrets::delete_scan_cache(); // ignore: best-effort teardown
    let _ = secrets::delete_ai_token(); // ignore: best-effort teardown of the MCP token

    state.session.lock().await.clear_secrets();
    *state.breach_directory.lock().await = None;
    *state.ai_audit.lock().await = Vec::new();
    state
        .update_config(|cfg| {
            cfg.app_unlock_configured = false;
            cfg.hello_configured = false;
            cfg.darkweb_consent = false;
            // The MCP server's allowlist + opt-in are capability state — drop them
            // on logout. The bound listener stays up but fails closed (disabled +
            // locked).
            cfg.ai_server_enabled = false;
            cfg.ai_grants.clear();
        })
        .await
}
