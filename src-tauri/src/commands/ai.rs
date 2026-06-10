//! AI-access (MCP server) commands: server status / toggle, the item allowlist, and
//! the access audit log. Thin wrappers — the server itself lives in `crate::aiserver`.

use std::sync::Mutex;

use base64::Engine;
use rand::RngCore;

use super::State;
use crate::aiserver;
use crate::dto::{AiAuditEntry, AiGrant, AiServerStatus};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::secrets;

/// A fresh 256-bit URL-safe bearer token for the MCP endpoint. Uses the fallible
/// RNG path — a `#[tauri::command]` must never panic, even on entropy failure.
fn fresh_token() -> AgateResult<String> {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.try_fill_bytes(&mut bytes).map_err(|e| {
        AgateError::new(ErrorKind::Internal, format!("Could not gather randomness for the token: {e}"))
    })?;
    Ok(base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes))
}

/// Serializes `ensure_token`'s load-then-store, so two concurrent enables can't
/// each mint a token and leave one caller displaying a token the keychain no
/// longer holds.
static TOKEN_INIT: Mutex<()> = Mutex::new(());

/// Ensure a bearer token exists in the keychain; returns it (generating once).
fn ensure_token() -> AgateResult<String> {
    let _guard = TOKEN_INIT.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(token) = secrets::load_ai_token()? {
        return Ok(token);
    }
    let token = fresh_token()?;
    secrets::store_ai_token(&token)?;
    Ok(token)
}

/// Build the status DTO. The URL + token are only surfaced when enabled.
fn status(enabled: bool, token: Option<String>) -> AiServerStatus {
    AiServerStatus {
        enabled,
        running: aiserver::is_running(),
        url: enabled.then(aiserver::server_url),
        token: if enabled { token } else { None },
    }
}

#[tauri::command]
pub async fn ai_server_status(state: State<'_>) -> AgateResult<AiServerStatus> {
    let enabled = state.config.lock().await.ai_server_enabled;
    let token = if enabled { secrets::load_ai_token()? } else { None };
    Ok(status(enabled, token))
}

#[tauri::command]
pub async fn ai_set_server_enabled(
    app: tauri::AppHandle,
    state: State<'_>,
    enabled: bool,
) -> AgateResult<AiServerStatus> {
    // Order matters: provision the token AND bind the listener before the flag is
    // flipped + persisted. The reverse order could persist "enabled" and then fail
    // to bind (port squatted) — a config that claims the server is on with nothing
    // listening, and no error on later launches. Binding first is safe: the
    // handler 503s until the flag flips.
    let token = if enabled { Some(ensure_token()?) } else { None };
    if enabled {
        aiserver::ensure_started(app)?;
    }
    // update_config rolls the in-memory flag back if the disk write fails, so an
    // already-bound listener can never serve while the UI shows the toggle failed.
    state.update_config(|cfg| cfg.ai_server_enabled = enabled).await?;
    Ok(status(enabled, token))
}

#[tauri::command]
pub async fn ai_list_grants(state: State<'_>) -> AgateResult<Vec<AiGrant>> {
    Ok(state.config.lock().await.ai_grants.clone())
}

#[tauri::command]
pub async fn ai_set_grant(
    state: State<'_>,
    account_email: String,
    item_id: String,
    granted: bool,
) -> AgateResult<()> {
    state.update_config(|cfg| cfg.set_ai_grant(&account_email, &item_id, granted)).await
}

#[tauri::command]
pub async fn ai_clear_grants(state: State<'_>) -> AgateResult<()> {
    state.update_config(|cfg| cfg.ai_grants.clear()).await
}

#[tauri::command]
pub async fn ai_audit_log(state: State<'_>) -> AgateResult<Vec<AiAuditEntry>> {
    Ok(state.ai_audit.lock().await.clone())
}
