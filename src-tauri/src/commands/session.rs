//! Session status + server configuration commands.

use super::State;
use crate::connections;
use crate::dto::{ServerConfig, SessionStatus};
use crate::error::AgateResult;

#[tauri::command]
pub async fn get_session_status(state: State<'_>) -> AgateResult<SessionStatus> {
    let (unlocked, live_count) = {
        let session = state.session.lock().await;
        (session.vmk.is_some(), session.connection_count())
    };
    let cfg = state.config.lock().await;
    Ok(SessionStatus {
        app_unlock_configured: cfg.app_unlock_configured,
        unlocked,
        hello_configured: cfg.hello_configured,
        darkweb_consent: cfg.darkweb_consent,
        connection_count: cfg.accounts.len(),
        live_count,
    })
}

#[tauri::command]
pub async fn get_server_config(state: State<'_>) -> AgateResult<ServerConfig> {
    Ok(state.config.lock().await.server.clone())
}

#[tauri::command]
pub async fn set_server_config(state: State<'_>, server: ServerConfig) -> AgateResult<()> {
    connections::set_server(&state, server).await
}
