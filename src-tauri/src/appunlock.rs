//! Unified app-unlock — the headline feature.
//!
//! Goal: configure each Bitwarden connection once, then a single app secret (one
//! app password, or Windows Hello) unlocks *every* connection at once and the set
//! survives a full app restart.
//!
//! Why the master password is persisted (sealed): at the pinned SDK rev a restored
//! session must re-login to get fresh server tokens (token injection is
//! `pub(crate)`; there is no public token restore), and `login_password` needs the
//! cleartext password. So each connection's master password is sealed — under a
//! random **Vault Master Key (VMK)**, which the app password only *wraps*. See
//! `secrets.rs` for the KEK/DEK envelope and CLAUDE.md for the (intentionally
//! inverted) security posture.
//!
//! Honest limitation: re-login uses a device id the SDK hardcodes, so a
//! 2FA-enforced account re-prompts for a second factor on every cold-start
//! unlock. `unlock_all` therefore returns a per-connection outcome vector and the
//! UI completes 2FA per connection (`unlock_connection_2fa`).

use rand::RngCore;
use zeroize::Zeroizing;

use crate::auth::{self, LoginOutcome};
use crate::dto::{TwoFactorInput, TwoFactorKind, UnlockOutcome, UnlockStatus};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::secrets::{
    self, AppUnlockBlob, StoredConnection, ARGON_M_COST, ARGON_P_COST, ARGON_T_COST, BLOB_VERSION,
};
use crate::server;
use crate::state::{AppState, LiveConnection};

/// Minimum length for the single app password. It guards every connection, so
/// keep it meaningfully strong without being hostile.
const MIN_APP_PASSWORD_LEN: usize = 8;

// ---------------------------------------------------------------------------
// Key helpers
// ---------------------------------------------------------------------------

/// Derive the App Unlock Key (the KEK) from the app password + KDF params (and an
/// optional device pepper for machine binding), run off the async runtime
/// (Argon2id is CPU-bound).
async fn derive_auk(
    password: &Zeroizing<String>,
    salt: [u8; 16],
    m: u32,
    t: u32,
    p: u32,
    pepper: Option<Zeroizing<Vec<u8>>>,
) -> AgateResult<Zeroizing<[u8; 32]>> {
    let pw = password.clone();
    let salt = salt.to_vec();
    tokio::task::spawn_blocking(move || {
        let pep = pepper.as_ref().map(|z| z.as_slice());
        secrets::derive_auk(pw.as_str(), &salt, m, t, p, pep)
    })
    .await
    .map_err(|_| AgateError::internal("key derivation was interrupted"))?
}

fn fresh_vmk() -> Zeroizing<[u8; 32]> {
    let mut k = Zeroizing::new([0u8; 32]);
    rand::thread_rng().fill_bytes(&mut *k);
    k
}

fn to_array32(bytes: &[u8]) -> AgateResult<Zeroizing<[u8; 32]>> {
    let arr: [u8; 32] = bytes
        .try_into()
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "bad key length"))?;
    Ok(Zeroizing::new(arr))
}

/// The VMK held in the session (the app must be unlocked).
pub(crate) async fn current_vmk(state: &AppState) -> AgateResult<Zeroizing<[u8; 32]>> {
    state
        .session
        .lock()
        .await
        .vmk
        .clone()
        .ok_or_else(|| AgateError::new(ErrorKind::Locked, "Unlock the app first."))
}

fn build_blob(salt: &[u8], sealed_vmk: secrets::SealedBlob) -> AppUnlockBlob {
    AppUnlockBlob {
        version: BLOB_VERSION,
        kdf_salt: secrets::encode_b64(salt),
        m_cost: ARGON_M_COST,
        t_cost: ARGON_T_COST,
        p_cost: ARGON_P_COST,
        // Unlock is always machine-bound (see `configure` / `change`).
        device_bound: true,
        sealed_vmk,
    }
}

/// Resolve the device pepper, reusing this machine's existing one or generating +
/// storing a fresh one on first use. Unlock is always machine-bound, so this never
/// returns `None`; the keychain-protected pepper is what ties the wrapped VMK to
/// this device.
fn ensure_pepper() -> AgateResult<Zeroizing<Vec<u8>>> {
    if let Some(p) = secrets::load_device_pepper()? {
        return Ok(p);
    }
    let p = secrets::fresh_pepper();
    secrets::store_device_pepper(&*p)?;
    Ok(Zeroizing::new(p.to_vec()))
}

fn check_password_len(password: &Zeroizing<String>) -> AgateResult<()> {
    if password.chars().count() < MIN_APP_PASSWORD_LEN {
        return Err(AgateError::bad_request(format!(
            "App password must be at least {MIN_APP_PASSWORD_LEN} characters."
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Configure / change the app password
// ---------------------------------------------------------------------------

/// First-time setup: generate the VMK, wrap it under a freshly derived AUK, and
/// hold the VMK in the session so connections can be added immediately. Unlock is
/// always machine-bound — a device pepper is mixed into the AUK so the stored blob
/// can only be unlocked on this machine, even with the right app password.
pub async fn configure(state: &AppState, app_password: Zeroizing<String>) -> AgateResult<()> {
    check_password_len(&app_password)?;
    if state.config.lock().await.app_unlock_configured {
        return Err(AgateError::bad_request("App unlock is already configured."));
    }

    let vmk = fresh_vmk();
    let salt = secrets::fresh_salt();
    let pepper = ensure_pepper()?;
    let auk =
        derive_auk(&app_password, salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, Some(pepper))
            .await?;
    let aad = secrets::app_unlock_aad(ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, true);
    let sealed_vmk = secrets::seal_with_key(&auk, &*vmk, &aad)?;
    secrets::store_app_unlock(&build_blob(&salt, sealed_vmk))?;

    state.session.lock().await.vmk = Some(vmk);
    state.config.lock().await.app_unlock_configured = true;
    state.save_config().await
}

/// Change the app password: re-wrap the VMK under a new AUK. A single keychain write
/// commits it; the per-connection credential blobs never move, so this can never
/// half-rekey the store. Requires the app to be unlocked. The new blob stays
/// machine-bound to this device's pepper. Windows Hello stores the VMK directly, so
/// it is unaffected.
pub async fn change(state: &AppState, new_password: Zeroizing<String>) -> AgateResult<()> {
    check_password_len(&new_password)?;
    let vmk = current_vmk(state).await?;
    let salt = secrets::fresh_salt();
    let pepper = ensure_pepper()?;
    let auk =
        derive_auk(&new_password, salt, ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, Some(pepper))
            .await?;
    let aad = secrets::app_unlock_aad(ARGON_M_COST, ARGON_T_COST, ARGON_P_COST, true);
    let sealed_vmk = secrets::seal_with_key(&auk, &*vmk, &aad)?;
    secrets::store_app_unlock(&build_blob(&salt, sealed_vmk))
}

// ---------------------------------------------------------------------------
// Unlock everything
// ---------------------------------------------------------------------------

/// Unlock with the app password: unwrap the VMK, then re-login every connection.
pub async fn unlock_all(
    state: &AppState,
    app_password: Zeroizing<String>,
) -> AgateResult<Vec<UnlockOutcome>> {
    let vmk = unwrap_vmk_with_password(state, app_password).await?;
    finish_unlock(state, vmk).await
}

async fn unwrap_vmk_with_password(
    state: &AppState,
    app_password: Zeroizing<String>,
) -> AgateResult<Zeroizing<[u8; 32]>> {
    let _ = state; // (kept symmetric with the Hello path; no state needed here)
    let blob = secrets::load_app_unlock()?
        .ok_or_else(|| AgateError::bad_request("App unlock is not set up."))?;
    if blob.version != BLOB_VERSION {
        return Err(AgateError::new(ErrorKind::Crypto, "Unsupported app-unlock version."));
    }
    let salt = secrets::decode_b64(&blob.kdf_salt)?;
    let salt16: [u8; 16] = salt
        .as_slice()
        .try_into()
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt salt"))?;

    // A device-bound blob needs the device pepper from the keychain; its absence
    // means the blob was moved from another machine (or the entry was lost).
    let pepper = if blob.device_bound {
        match secrets::load_device_pepper()? {
            Some(p) => Some(p),
            None => {
                return Err(AgateError::new(
                    ErrorKind::InvalidCredentials,
                    "This vault is bound to a different device.",
                ))
            }
        }
    } else {
        None
    };

    let auk =
        derive_auk(&app_password, salt16, blob.m_cost, blob.t_cost, blob.p_cost, pepper).await?;
    let aad = secrets::app_unlock_aad(blob.m_cost, blob.t_cost, blob.p_cost, blob.device_bound);
    // A wrong app password fails the GCM tag here.
    let vmk_bytes = secrets::open_with_key(&auk, &blob.sealed_vmk, &aad)
        .map_err(|_| AgateError::new(ErrorKind::InvalidCredentials, "Incorrect app password."))?;
    to_array32(&vmk_bytes)
}

/// Given the VMK (from the password path or Hello), re-login every configured
/// connection and return a per-connection outcome. Connections that need a second
/// factor or fail are reported, not fatal — the session opens with whatever
/// succeeded.
pub(crate) async fn finish_unlock(
    state: &AppState,
    vmk: Zeroizing<[u8; 32]>,
) -> AgateResult<Vec<UnlockOutcome>> {
    let accounts = state.config.lock().await.accounts.clone();
    let mut outcomes = Vec::with_capacity(accounts.len());
    for acct in &accounts {
        // Manual-unlock connections have no stored password — leave them locked for
        // the user to unlock on demand, rather than failing to load a sealed cred.
        let status = if !acct.store_credentials {
            UnlockStatus::ManualUnlock
        } else {
            match unlock_one(state, &acct.email, &vmk).await {
                Ok(()) => UnlockStatus::Unlocked,
                Err(UnlockOneError::TwoFactor(providers)) => {
                    UnlockStatus::TwoFactorRequired { providers }
                }
                Err(UnlockOneError::Failed(message)) => UnlockStatus::Failed { message },
            }
        };
        outcomes.push(UnlockOutcome {
            email: acct.email.clone(),
            server_label: server::server_label(&acct.server),
            status,
        });
    }
    {
        let mut session = state.session.lock().await;
        session.vmk = Some(vmk);
        if session.active_email.is_none() {
            session.active_email = session.connections.keys().next().cloned();
        }
    }
    Ok(outcomes)
}

enum UnlockOneError {
    TwoFactor(Vec<TwoFactorKind>),
    Failed(String),
}

async fn unlock_one(state: &AppState, email: &str, vmk: &[u8; 32]) -> Result<(), UnlockOneError> {
    let conn = load_connection(email, vmk).map_err(|e| UnlockOneError::Failed(e.message))?;
    let pw = Zeroizing::new(conn.master_password.clone());
    match auth::login_password(state, &conn.server, &conn.email, pw, None).await {
        Ok(LoginOutcome::Success(client)) => {
            state
                .session
                .lock()
                .await
                .connections
                .insert(email.to_string(), LiveConnection::new(client));
            Ok(())
        }
        Ok(LoginOutcome::TwoFactorRequired(providers)) => Err(UnlockOneError::TwoFactor(providers)),
        Err(e) => Err(UnlockOneError::Failed(e.message)),
    }
}

/// Open one connection's sealed credentials with the VMK.
fn load_connection(email: &str, vmk: &[u8; 32]) -> AgateResult<StoredConnection> {
    let blob = secrets::load_cred(email)?
        .ok_or_else(|| AgateError::bad_request("No stored credentials for this connection."))?;
    let pt = secrets::open_with_key(vmk, &blob, &secrets::cred_aad(email))?;
    serde_json::from_slice::<StoredConnection>(&pt)
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "Stored credentials are unreadable."))
}

// ---------------------------------------------------------------------------
// Per-connection 2FA completion (cold-start re-login of a 2FA-enforced account)
// ---------------------------------------------------------------------------

/// Complete a second factor for one connection that reported `TwoFactorRequired`
/// during `unlock_all`. Uses the stored master password + the supplied code.
pub async fn unlock_connection_2fa(
    state: &AppState,
    email: String,
    two_factor: TwoFactorInput,
) -> AgateResult<()> {
    let vmk = current_vmk(state).await?;
    let conn = load_connection(&email, &vmk)?;
    let pw = Zeroizing::new(conn.master_password.clone());
    match auth::login_password(state, &conn.server, &conn.email, pw, Some(two_factor)).await? {
        LoginOutcome::Success(client) => {
            let mut session = state.session.lock().await;
            session.connections.insert(email.clone(), LiveConnection::new(client));
            if session.active_email.is_none() {
                session.active_email = Some(email);
            }
            Ok(())
        }
        LoginOutcome::TwoFactorRequired(_) => Err(AgateError::new(
            ErrorKind::TwoFactorRequired,
            "Two-factor code was not accepted.",
        )),
    }
}

/// Trigger the Email-2FA code for a connection being unlocked (loads the stored
/// master password the provider's send endpoint requires).
pub async fn send_connection_email_code(state: &AppState, email: String) -> AgateResult<()> {
    let vmk = current_vmk(state).await?;
    let conn = load_connection(&email, &vmk)?;
    let pw = Zeroizing::new(conn.master_password.clone());
    auth::send_email_code(state, &conn.server, conn.email.clone(), pw).await
}

// ---------------------------------------------------------------------------
// Seal a newly added connection (called by connections.rs)
// ---------------------------------------------------------------------------

/// Seal a connection's credentials under the current VMK and store them. The
/// plaintext (with the master password) is serialized into a zeroizing buffer.
pub(crate) fn seal_connection(vmk: &[u8; 32], stored: &StoredConnection) -> AgateResult<()> {
    let json = Zeroizing::new(
        serde_json::to_vec(stored)
            .map_err(|e| AgateError::internal(format!("serialize connection: {e}")))?,
    );
    let blob = secrets::seal_with_key(vmk, &json, &secrets::cred_aad(&stored.email))?;
    secrets::store_cred(&stored.email, &blob)
}
