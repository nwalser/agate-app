//! Local-password unlock — the headline feature.
//!
//! Flow:
//!   1. After a master-password login (vault unlocked), `enable()` mints a
//!      Bitwarden **session key** via the SDK, seals it under the user's *local*
//!      password (Argon2id + AES-256-GCM, see `secrets.rs`), and stores the
//!      sealed blob in the OS keychain. The master password is never stored.
//!   2. `unlock_local()` opens the sealed blob with the local password and asks
//!      the SDK to unlock the vault from the session key — no master password,
//!      no re-auth round-trip.
//!   3. `disable()` deletes the keychain blob and invalidates the session key.
//!
//! ⚠️ SDK maturity: minting/consuming the session key uses the SDK's `unlock`
//! client (`generate_session_key` / `unlock`). Cross-process-restart unlock also
//! depends on the SDK persisting its key envelope to disk, which is not yet
//! stable in `sdk-internal`. When that backend is missing, `unlock_local()`
//! surfaces a clear `LocalUnlock` error telling the user to use the master
//! password — it never fakes success. This module is the single integration
//! point to revisit when SDK state persistence lands.

use bitwarden_crypto::SymmetricCryptoKey;
use bitwarden_pm::PasswordManagerClient;
use bitwarden_unlock::{SessionKey, UnlockMethod};

use crate::dto::ServerConfig;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::secrets;
use crate::server;
use crate::state::AppState;

/// Serialize a session key to bytes for sealing (base64 of the symmetric key).
fn session_key_to_bytes(key: &SessionKey) -> Vec<u8> {
    key.0.to_base64().to_string().into_bytes()
}

/// Reconstruct a session key from sealed bytes.
fn session_key_from_bytes(bytes: &[u8]) -> AgateResult<SessionKey> {
    let s = std::str::from_utf8(bytes)
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "corrupt session key"))?;
    let key = SymmetricCryptoKey::try_from(s.to_string())
        .map_err(|_| AgateError::new(ErrorKind::LocalUnlock, "invalid session key"))?;
    Ok(SessionKey(key))
}

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

    let client = {
        let session = state.session.lock().await;
        let client = session.client.as_ref().ok_or_else(AgateError::not_authenticated)?;
        if !client.is_unlocked() {
            return Err(AgateError::locked());
        }
        client.clone()
    };

    let session_key = client
        .unlock()
        .generate_session_key()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("could not mint session key: {e}")))?;

    let bytes = session_key_to_bytes(&session_key);
    let blob = secrets::seal(&bytes, &local_password)?;
    secrets::store_blob(&email, &blob)?;

    {
        let mut cfg = state.config.lock().await;
        cfg.local_unlock_configured = true;
    }
    state.save_config().await?;
    Ok(())
}

/// Unlock the vault using the local password (no master password).
pub async fn unlock_local(state: &AppState, local_password: String) -> AgateResult<()> {
    let email = account_email(state).await?;

    let blob = secrets::load_blob(&email)?
        .ok_or_else(|| AgateError::new(ErrorKind::LocalUnlock, "Local unlock is not configured."))?;

    // Wrong local password fails here (GCM tag) with ErrorKind::LocalUnlock.
    let bytes = secrets::open(&blob, &local_password)?;
    let session_key = session_key_from_bytes(&bytes)?;

    let (server, device_id) = {
        let cfg = state.config.lock().await;
        (cfg.server.clone(), cfg.device_id.clone())
    };
    let settings = server::client_settings(&server, device_id)?;
    let client = PasswordManagerClient::new(Some(settings));

    client
        .unlock()
        .unlock(UnlockMethod::SessionKey(session_key))
        .await
        .map_err(|_| {
            AgateError::new(
                ErrorKind::LocalUnlock,
                "Could not unlock from the local password on this device. \
                 Unlock with your master password instead.",
            )
        })?;

    state.session.lock().await.client = Some(client);
    Ok(())
}

/// Turn off local unlock: forget the sealed blob and invalidate the session key.
pub async fn disable(state: &AppState) -> AgateResult<()> {
    let email = account_email(state).await?;
    secrets::delete_blob(&email)?;

    if let Some(client) = state.session.lock().await.client.as_ref() {
        // Best-effort: invalidating the SDK-side session key. Ignore failure —
        // the authoritative off-switch is deleting the keychain blob above.
        let _ = client.unlock().invalidate_session_key().await;
    }

    {
        let mut cfg = state.config.lock().await;
        cfg.local_unlock_configured = false;
    }
    state.save_config().await?;
    Ok(())
}

/// Whether a local-unlock blob exists for the active account.
pub async fn is_configured(state: &AppState) -> bool {
    state.config.lock().await.local_unlock_configured
}

/// Apply a `ServerConfig` chosen on the onboarding screen to persisted config.
pub async fn set_server(state: &AppState, server: ServerConfig) -> AgateResult<()> {
    state.config.lock().await.server = server;
    state.save_config().await
}
