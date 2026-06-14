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
use crate::dto::{ConnectionKind, ConnectionSummary, LoginResult, ServerConfig, TwoFactorInput};
use crate::error::{AgateError, AgateResult};
use crate::secrets::{self, StoredConnection};
use crate::state::AppState;

/// List configured connections, marking which are currently unlocked.
pub async fn list_connections(state: &AppState) -> AgateResult<Vec<ConnectionSummary>> {
    let accounts = state.config.lock().await.accounts.clone();
    let live: std::collections::HashSet<String> =
        state.session.lock().await.connections.keys().cloned().collect();
    Ok(accounts
        .iter()
        .map(|a| ConnectionSummary {
            kind: a.kind,
            email: a.email.clone(),
            server_label: a.label(),
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
                    kind: ConnectionKind::Bitwarden,
                    server: server.clone(),
                    email: email.clone(),
                    master_password: (*password).clone(),
                    path: None,
                    keyfile: None,
                };
                appunlock::seal_connection(&vmk, &stored)?;
            } else {
                // Manual-unlock connection: make sure no stale sealed password lingers.
                secrets::delete_cred(&email)?;
            }

            if let Err(e) = state
                .update_config(|cfg| {
                    cfg.upsert_account(ConnectionKind::Bitwarden, server.clone(), &email, store_credentials);
                    cfg.server = server.clone();
                })
                .await
            {
                // Compensate: the config rolled back, so a just-sealed master
                // password must not stay orphaned in the keychain.
                if store_credentials {
                    let _ = secrets::delete_cred(&email); // ignore: best-effort compensation
                }
                return Err(e);
            }
            {
                let mut session = state.session.lock().await;
                session.insert_bitwarden(email.clone(), client);
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
                        kind: ConnectionKind::Bitwarden,
                        server: server.clone(),
                        email: email.clone(),
                        master_password: (*pw).clone(),
                        path: None,
                        keyfile: None,
                    };
                    appunlock::seal_connection(&vmk, &stored)?;
                } else {
                    secrets::delete_cred(&email)?;
                }
                state
                    .update_config(|cfg| {
                        cfg.upsert_account(ConnectionKind::Bitwarden, server.clone(), &email, store_credentials)
                    })
                    .await?;
                {
                    let mut session = state.session.lock().await;
                    session.insert_bitwarden(email.clone(), client);
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
    }
    // Config transaction first (rollback-able), keychain delete after — see
    // remove_connection for the ordering rationale.
    state
        .update_config(|cfg| {
            cfg.upsert_account(existing.kind, existing.server.clone(), &email, store_credentials)
        })
        .await?;
    if !store_credentials {
        // Turning storage off: forget the sealed password (the live session stays).
        if let Err(e) = secrets::delete_cred(&email) {
            log::error!("could not delete the stored credential after turning storage off: {}", e.message);
        }
    }
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
            session.insert_bitwarden(email.clone(), client);
            if session.active_email.is_none() {
                session.active_email = Some(email);
            }
            Ok(LoginResult::Success)
        }
    }
}

/// Add a KeePass database as a connection. Opens (and thereby verifies) the
/// database first; when `store_credentials` is set, seals the database password
/// under the VMK so it auto-unlocks with the app. The file path doubles as the
/// connection id (`email` in the config record, for back-compat).
pub async fn add_keepass_connection(
    state: &AppState,
    path: String,
    password: Zeroizing<String>,
    keyfile: Option<String>,
    store_credentials: bool,
) -> AgateResult<()> {
    let vmk = appunlock::current_vmk(state)
        .await
        .map_err(|_| AgateError::bad_request("Set an app password before adding a connection."))?;

    let conn = open_keepass(path.clone(), password.clone(), keyfile.clone()).await?;

    if store_credentials {
        let stored = StoredConnection {
            kind: ConnectionKind::Keepass,
            server: ServerConfig::default(),
            email: path.clone(),
            master_password: (*password).clone(),
            path: Some(path.clone()),
            keyfile: keyfile.clone(),
        };
        appunlock::seal_connection(&vmk, &stored)?;
    } else {
        // Manual-unlock connection: make sure no stale sealed password lingers.
        secrets::delete_cred(&path)?;
    }

    if let Err(e) = state
        .update_config(|cfg| {
            cfg.upsert_account_with_keyfile(
                ConnectionKind::Keepass,
                ServerConfig::default(),
                &path,
                store_credentials,
                keyfile.clone(),
            );
        })
        .await
    {
        // Compensate: the config rolled back, so a just-sealed database
        // password must not stay orphaned in the keychain.
        if store_credentials {
            let _ = secrets::delete_cred(&path); // ignore: best-effort compensation
        }
        return Err(e);
    }
    {
        let mut session = state.session.lock().await;
        session.connections.insert(path.clone(), crate::providers::LiveConnection::Keepass(conn));
        if session.active_email.is_none() {
            session.active_email = Some(path);
        }
    }
    Ok(())
}

/// Unlock one KeePass connection on demand with its database password (manual
/// connections, or retrying a failed one). The key file path comes from the
/// connection record; the password is not persisted here.
pub async fn unlock_keepass_connection(
    state: &AppState,
    path: String,
    password: Zeroizing<String>,
) -> AgateResult<()> {
    let acct = state
        .config
        .lock()
        .await
        .account_for(&path)
        .cloned()
        .ok_or_else(|| AgateError::bad_request("No such connection."))?;
    if acct.kind != ConnectionKind::Keepass {
        return Err(AgateError::bad_request("Not a KeePass connection."));
    }

    let conn = open_keepass(path.clone(), password, acct.keyfile.clone()).await?;
    let mut session = state.session.lock().await;
    session.connections.insert(path.clone(), crate::providers::LiveConnection::Keepass(conn));
    if session.active_email.is_none() {
        session.active_email = Some(path);
    }
    Ok(())
}

/// Open a KeePass database off the async runtime (the KDF is CPU-bound).
async fn open_keepass(
    path: String,
    password: Zeroizing<String>,
    keyfile: Option<String>,
) -> AgateResult<crate::providers::KeepassConnection> {
    tokio::task::spawn_blocking(move || {
        crate::providers::KeepassConnection::open(
            std::path::Path::new(&path),
            password.as_str(),
            keyfile.as_deref().map(std::path::Path::new),
        )
    })
    .await
    .map_err(|_| AgateError::internal("database open was interrupted"))?
}

/// Add a `pass` store (the standard unix password store) as a connection. The
/// store root path doubles as the connection id; the user's exported OpenPGP
/// secret-key file is the (non-secret) key-file path, the key passphrase is the
/// sealed secret. Opens (verifies) the store first, then seals + records — same
/// ordering as the KeePass path.
pub async fn add_pass_connection(
    state: &AppState,
    store_root: String,
    key_file: String,
    passphrase: Zeroizing<String>,
    store_credentials: bool,
) -> AgateResult<()> {
    let vmk = appunlock::current_vmk(state)
        .await
        .map_err(|_| AgateError::bad_request("Set an app password before adding a connection."))?;

    let conn = open_pass(store_root.clone(), key_file.clone(), passphrase.clone()).await?;

    if store_credentials {
        let stored = StoredConnection {
            kind: ConnectionKind::Pass,
            server: ServerConfig::default(),
            email: store_root.clone(),
            master_password: (*passphrase).clone(),
            path: Some(store_root.clone()),
            keyfile: Some(key_file.clone()),
        };
        appunlock::seal_connection(&vmk, &stored)?;
    } else {
        secrets::delete_cred(&store_root)?;
    }

    if let Err(e) = state
        .update_config(|cfg| {
            cfg.upsert_account_with_keyfile(
                ConnectionKind::Pass,
                ServerConfig::default(),
                &store_root,
                store_credentials,
                Some(key_file.clone()),
            );
        })
        .await
    {
        if store_credentials {
            let _ = secrets::delete_cred(&store_root); // ignore: best-effort compensation
        }
        return Err(e);
    }
    {
        let mut session = state.session.lock().await;
        session
            .connections
            .insert(store_root.clone(), crate::providers::LiveConnection::Pass(conn));
        if session.active_email.is_none() {
            session.active_email = Some(store_root);
        }
    }
    Ok(())
}

/// Unlock one `pass` connection on demand with its key passphrase (manual
/// connections, or retrying a failed one). The key-file path comes from the
/// connection record; the passphrase is not persisted here.
pub async fn unlock_pass_connection(
    state: &AppState,
    store_root: String,
    passphrase: Zeroizing<String>,
) -> AgateResult<()> {
    let acct = state
        .config
        .lock()
        .await
        .account_for(&store_root)
        .cloned()
        .ok_or_else(|| AgateError::bad_request("No such connection."))?;
    if acct.kind != ConnectionKind::Pass {
        return Err(AgateError::bad_request("Not a pass connection."));
    }
    let key_file = acct
        .keyfile
        .clone()
        .ok_or_else(|| AgateError::bad_request("This pass store has no OpenPGP key file configured."))?;

    let conn = open_pass(store_root.clone(), key_file, passphrase).await?;
    let mut session = state.session.lock().await;
    session
        .connections
        .insert(store_root.clone(), crate::providers::LiveConnection::Pass(conn));
    if session.active_email.is_none() {
        session.active_email = Some(store_root);
    }
    Ok(())
}

/// Open a `pass` store off the async runtime (OpenPGP decrypt is CPU-bound).
async fn open_pass(
    store_root: String,
    key_file: String,
    passphrase: Zeroizing<String>,
) -> AgateResult<crate::providers::PassConnection> {
    tokio::task::spawn_blocking(move || {
        crate::providers::PassConnection::open(
            std::path::Path::new(&store_root),
            std::path::Path::new(&key_file),
            passphrase.as_str(),
        )
    })
    .await
    .map_err(|_| AgateError::internal("password store open was interrupted"))?
}

/// Add an Enpass 6+ vault as a connection. The vault path (folder or
/// `vault.enpassdb`) doubles as the connection id; opens (verifies) the vault
/// first, then seals the master password under the VMK when storing — same
/// ordering as the KeePass path. Read-only (see `providers::enpass`).
pub async fn add_enpass_connection(
    state: &AppState,
    path: String,
    password: Zeroizing<String>,
    keyfile: Option<String>,
    store_credentials: bool,
) -> AgateResult<()> {
    let vmk = appunlock::current_vmk(state)
        .await
        .map_err(|_| AgateError::bad_request("Set an app password before adding a connection."))?;

    let conn = open_enpass(path.clone(), password.clone(), keyfile.clone()).await?;

    if store_credentials {
        let stored = StoredConnection {
            kind: ConnectionKind::Enpass,
            server: ServerConfig::default(),
            email: path.clone(),
            master_password: (*password).clone(),
            path: Some(path.clone()),
            keyfile: keyfile.clone(),
        };
        appunlock::seal_connection(&vmk, &stored)?;
    } else {
        secrets::delete_cred(&path)?;
    }

    if let Err(e) = state
        .update_config(|cfg| {
            cfg.upsert_account_with_keyfile(
                ConnectionKind::Enpass,
                ServerConfig::default(),
                &path,
                store_credentials,
                keyfile.clone(),
            );
        })
        .await
    {
        if store_credentials {
            let _ = secrets::delete_cred(&path); // ignore: best-effort compensation
        }
        return Err(e);
    }
    {
        let mut session = state.session.lock().await;
        session
            .connections
            .insert(path.clone(), crate::providers::LiveConnection::Enpass(conn));
        if session.active_email.is_none() {
            session.active_email = Some(path);
        }
    }
    Ok(())
}

/// Unlock one Enpass connection on demand with its master password (manual
/// connections, or retrying a failed one). The key-file path comes from the
/// connection record; the password is not persisted here.
pub async fn unlock_enpass_connection(
    state: &AppState,
    path: String,
    password: Zeroizing<String>,
) -> AgateResult<()> {
    let acct = state
        .config
        .lock()
        .await
        .account_for(&path)
        .cloned()
        .ok_or_else(|| AgateError::bad_request("No such connection."))?;
    if acct.kind != ConnectionKind::Enpass {
        return Err(AgateError::bad_request("Not an Enpass connection."));
    }

    let conn = open_enpass(path.clone(), password, acct.keyfile.clone()).await?;
    let mut session = state.session.lock().await;
    session
        .connections
        .insert(path.clone(), crate::providers::LiveConnection::Enpass(conn));
    if session.active_email.is_none() {
        session.active_email = Some(path);
    }
    Ok(())
}

/// Open an Enpass vault off the async runtime (PBKDF2 + SQLCipher decrypt are
/// CPU-bound).
async fn open_enpass(
    path: String,
    password: Zeroizing<String>,
    keyfile: Option<String>,
) -> AgateResult<crate::providers::EnpassConnection> {
    tokio::task::spawn_blocking(move || {
        crate::providers::EnpassConnection::open(
            std::path::Path::new(&path),
            password.as_str(),
            keyfile.as_deref().map(std::path::Path::new),
        )
    })
    .await
    .map_err(|_| AgateError::internal("vault open was interrupted"))?
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

/// Forget a connection: remove it from the config list, drop the live client,
/// and delete its sealed credentials.
///
/// ORDER: the rollback-able config transaction commits FIRST; the irreversible
/// keychain delete runs after, best-effort but LOUD — a lingering sealed blob is
/// recoverable (overwritten on re-add, sealed under the VMK), whereas deleting
/// it before a failed config write would resurrect an account whose stored
/// credential no longer exists (guaranteed unlock failure).
pub async fn remove_connection(state: &AppState, email: String) -> AgateResult<()> {
    // Drops the account record AND its AI allowlist grants — see remove_account.
    state.update_config(|cfg| cfg.remove_account(&email)).await?;
    {
        let mut session = state.session.lock().await;
        session.connections.remove(&email);
        if session.active_email.as_deref() == Some(email.as_str()) {
            session.active_email = session.connections.keys().next().cloned();
        }
    }
    if let Err(e) = secrets::delete_cred(&email) {
        log::error!("could not delete the stored credential for a removed connection: {}", e.message);
    }
    Ok(())
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
///
/// ORDER: the config transaction commits FIRST. If the disk write fails, logout
/// aborts cleanly (keychain untouched, in-memory flags rolled back, error shown,
/// user retries) — committing the irreversible keychain wipe before the rollback-
/// able write could leave memory claiming "configured" with an empty keychain.
pub async fn logout(state: &AppState) -> AgateResult<()> {
    let accounts = state.config.lock().await.accounts.clone();
    state
        .update_config(|cfg| {
            cfg.app_unlock_configured = false;
            cfg.hello_configured = false;
        })
        .await?;

    for a in &accounts {
        let _ = secrets::delete_cred(&a.email); // ignore: best-effort teardown
    }
    let _ = secrets::delete_key(secrets::APP_UNLOCK_KEY);
    let _ = secrets::delete_hello_blob();
    let _ = secrets::delete_device_pepper(); // ignore: best-effort teardown
    // Legacy entries written by removed features (security-scan cache, MCP AI
    // token) — keep wiping them so old installs don't leave orphans behind.
    let _ = secrets::delete_key("scan-cache"); // ignore: best-effort teardown
    let _ = secrets::delete_key("ai-mcp-token"); // ignore: best-effort teardown

    state.session.lock().await.clear_secrets();
    Ok(())
}
