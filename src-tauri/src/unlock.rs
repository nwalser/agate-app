//! Local-password unlock — the headline feature.
//!
//! Goal: don't retype the master password every time, and never store the master
//! password on disk.
//!
//! How it works at this SDK revision: after a master-password login the vault is
//! unlocked in memory. `enable()` registers a *local* password by sealing a
//! random verifier token under it (Argon2id + AES-256-GCM, see `secrets.rs`) and
//! storing the sealed blob in the OS keychain. Locking the app then *soft-locks*
//! — the SDK client is kept in memory behind the local password and the
//! decrypted item cache is cleared — and `unlock_local()` re-opens it after the
//! local password verifies against the keychain blob. The master password is
//! never written anywhere.
//!
//! Limitation (honest): the public `sdk-internal` API at the pinned rev does not
//! expose a serializable session key, so the held client cannot survive a full
//! process restart yet. After relaunching Agate you unlock with the master
//! password once; thereafter the local password works for in-session locks. When
//! the SDK exposes a persistable unlock key, `secrets.rs` already provides the
//! sealing — `enable()`/`unlock_local()` then seal/restore that key instead of a
//! verifier token, and local unlock survives restarts. This module is the single
//! integration point for that change.

use rand::RngCore;

use crate::dto::ServerConfig;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::secrets;
use crate::state::AppState;

async fn account_email(state: &AppState) -> AgateResult<String> {
    state
        .config
        .lock()
        .await
        .email
        .clone()
        .ok_or_else(AgateError::not_authenticated)
}

/// Configure local-password unlock for the currently-unlocked account.
pub async fn enable(state: &AppState, local_password: String) -> AgateResult<()> {
    if local_password.len() < 4 {
        return Err(AgateError::bad_request("Local password is too short."));
    }
    let email = account_email(state).await?;

    {
        let session = state.session.lock().await;
        let client = session.client.as_ref().ok_or_else(AgateError::not_authenticated)?;
        if !client.is_unlocked() {
            return Err(AgateError::locked());
        }
    }

    // Seal a random verifier under the local password. Opening it later proves
    // the local password without storing a plaintext check value.
    let mut token = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut token);
    let blob = secrets::seal(&token, &local_password)?;
    secrets::store_blob(&email, &blob)?;

    {
        let mut cfg = state.config.lock().await;
        cfg.local_unlock_configured = true;
    }
    state.save_config().await?;
    Ok(())
}

/// Unlock the vault using the local password (no master password). Re-activates
/// the soft-locked client after the local password verifies.
pub async fn unlock_local(state: &AppState, local_password: String) -> AgateResult<()> {
    let email = account_email(state).await?;

    let blob = secrets::load_blob(&email)?
        .ok_or_else(|| AgateError::new(ErrorKind::LocalUnlock, "Local unlock is not configured."))?;

    // Wrong local password fails here (GCM tag) with ErrorKind::LocalUnlock.
    let _verifier = secrets::open(&blob, &local_password)?;

    let mut session = state.session.lock().await;
    match session.locked_client.take() {
        Some(client) => {
            session.client = Some(client);
            Ok(())
        }
        None => Err(AgateError::new(
            ErrorKind::LocalUnlock,
            "This session expired (the app was restarted). Unlock with your master password.",
        )),
    }
}

/// Turn off local unlock: forget the sealed blob for this account.
pub async fn disable(state: &AppState) -> AgateResult<()> {
    let email = account_email(state).await?;
    secrets::delete_blob(&email)?;
    {
        let mut cfg = state.config.lock().await;
        cfg.local_unlock_configured = false;
    }
    state.save_config().await?;
    Ok(())
}

/// Apply a `ServerConfig` chosen on the onboarding screen to persisted config.
pub async fn set_server(state: &AppState, server: ServerConfig) -> AgateResult<()> {
    state.config.lock().await.server = server;
    state.save_config().await
}
