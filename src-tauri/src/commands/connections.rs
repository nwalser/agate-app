//! Connection management commands (add / update / unlock / remove / lock / logout).

use zeroize::Zeroizing;

use super::State;
use crate::connections;
use crate::dto::{ConnectionSummary, LoginResult, ServerConfig, TwoFactorInput};
use crate::error::AgateResult;

#[tauri::command]
pub async fn list_connections(state: State<'_>) -> AgateResult<Vec<ConnectionSummary>> {
    connections::list_connections(&state).await
}

#[tauri::command]
pub async fn add_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
    store_credentials: bool,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let res = connections::add_connection(
        &state,
        server,
        email,
        Zeroizing::new(password),
        store_credentials,
        two_factor,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn update_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
    server: ServerConfig,
    store_credentials: bool,
    password: Option<String>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let res = connections::update_connection(
        &state,
        email,
        server,
        store_credentials,
        password.map(Zeroizing::new),
        two_factor,
    )
    .await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn unlock_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
    password: String,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    let res =
        connections::unlock_connection(&state, email, Zeroizing::new(password), two_factor).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn send_email_code(
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
) -> AgateResult<()> {
    connections::send_add_email_code(&state, server, email, Zeroizing::new(password)).await
}

#[tauri::command]
pub async fn remove_connection(
    app: tauri::AppHandle,
    state: State<'_>,
    email: String,
) -> AgateResult<()> {
    let res = connections::remove_connection(&state, email).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn set_active_connection(state: State<'_>, email: String) -> AgateResult<()> {
    connections::set_active(&state, email).await
}

#[tauri::command]
pub async fn lock(app: tauri::AppHandle, state: State<'_>) -> AgateResult<()> {
    let res = connections::lock(&state).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}

#[tauri::command]
pub async fn logout(app: tauri::AppHandle, state: State<'_>) -> AgateResult<()> {
    let res = connections::logout(&state).await;
    if res.is_ok() {
        super::emit_session_changed(&app);
    }
    res
}
