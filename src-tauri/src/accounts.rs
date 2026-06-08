//! Multiple-account support (Bitwarden-style account switching).
//!
//! Like the official desktop client, one account is active at a time; the rest
//! are remembered (server + email only — no secrets) so the user can switch
//! without retyping. Switching clears the in-memory session, so the target
//! account is re-unlocked (local password if a keychain blob exists for it,
//! otherwise the master password). Local-unlock state is per-account, keyed by
//! email in the OS keychain.

use crate::dto::{AccountSummary, ServerConfig};
use crate::error::{AgateError, AgateResult};
use crate::secrets;
use crate::state::AppState;

fn server_label(s: &ServerConfig) -> String {
    match s {
        ServerConfig::Us => "Bitwarden US".to_string(),
        ServerConfig::Eu => "Bitwarden EU".to_string(),
        ServerConfig::SelfHosted { base_url } => base_url.clone(),
    }
}

/// List known accounts, marking the active one.
pub async fn list_accounts(state: &AppState) -> AgateResult<Vec<AccountSummary>> {
    let cfg = state.config.lock().await;
    let active = cfg.email.clone();
    Ok(cfg
        .accounts
        .iter()
        .map(|a| AccountSummary {
            email: a.email.clone(),
            server_label: server_label(&a.server),
            active: active.as_deref() == Some(a.email.as_str()),
        })
        .collect())
}

/// Make `email` the active account and clear the session so it can be unlocked.
pub async fn switch_account(state: &AppState, email: String) -> AgateResult<()> {
    let acct = {
        let cfg = state.config.lock().await;
        cfg.accounts.iter().find(|a| a.email == email).cloned()
    }
    .ok_or_else(|| AgateError::bad_request("Unknown account."))?;

    // Local-unlock availability is per-account (keychain entry keyed by email).
    let has_local = secrets::load_blob(&email)?.is_some();
    {
        let mut cfg = state.config.lock().await;
        cfg.server = acct.server;
        cfg.email = Some(email);
        cfg.local_unlock_configured = has_local;
        cfg.hello_configured = false; // Hello is re-enabled per account
    }
    state.session.lock().await.clear_secrets();
    state.save_config().await
}

/// Forget an account: remove it from the list, delete its keychain blob, and if
/// it was active, clear the session.
pub async fn remove_account(state: &AppState, email: String) -> AgateResult<()> {
    secrets::delete_blob(&email)?;
    let was_active = {
        let mut cfg = state.config.lock().await;
        cfg.accounts.retain(|a| a.email != email);
        let active = cfg.email.as_deref() == Some(email.as_str());
        if active {
            cfg.email = None;
            cfg.local_unlock_configured = false;
            cfg.hello_configured = false;
        }
        active
    };
    if was_active {
        state.session.lock().await.clear_secrets();
    }
    state.save_config().await
}
