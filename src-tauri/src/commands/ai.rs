//! AI-access (MCP server) commands: server status / toggle, the item allowlist, and
//! the access audit log. Thin wrappers — the server itself lives in `crate::aiserver`.

use base64::Engine;
use rand::RngCore;

use super::State;
use crate::aiserver;
use crate::dto::{AiAuditEntry, AiGrant, AiServerStatus};
use crate::error::AgateResult;
use crate::secrets;

/// A fresh 256-bit URL-safe bearer token for the MCP endpoint.
fn fresh_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

/// Ensure a bearer token exists in the keychain; returns it (generating once).
fn ensure_token() -> AgateResult<String> {
    if let Some(token) = secrets::load_ai_token()? {
        return Ok(token);
    }
    let token = fresh_token();
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
    // Provision the token before flipping the flag so an enabled server is never
    // tokenless (which would deny every request).
    let token = if enabled { Some(ensure_token()?) } else { None };
    state.config.lock().await.ai_server_enabled = enabled;
    state.save_config().await?;
    if enabled {
        aiserver::ensure_started(app)?;
    }
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
    state.config.lock().await.set_ai_grant(&account_email, &item_id, granted);
    state.save_config().await
}

#[tauri::command]
pub async fn ai_clear_grants(state: State<'_>) -> AgateResult<()> {
    state.config.lock().await.ai_grants.clear();
    state.save_config().await
}

#[tauri::command]
pub async fn ai_audit_log(state: State<'_>) -> AgateResult<Vec<AiAuditEntry>> {
    Ok(state.ai_audit.lock().await.clone())
}
