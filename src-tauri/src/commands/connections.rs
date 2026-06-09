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
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
    store_credentials: bool,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    connections::add_connection(
        &state,
        server,
        email,
        Zeroizing::new(password),
        store_credentials,
        two_factor,
    )
    .await
}

#[tauri::command]
pub async fn update_connection(
    state: State<'_>,
    email: String,
    server: ServerConfig,
    store_credentials: bool,
    password: Option<String>,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    connections::update_connection(
        &state,
        email,
        server,
        store_credentials,
        password.map(Zeroizing::new),
        two_factor,
    )
    .await
}

#[tauri::command]
pub async fn unlock_connection(
    state: State<'_>,
    email: String,
    password: String,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    connections::unlock_connection(&state, email, Zeroizing::new(password), two_factor).await
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
pub async fn remove_connection(state: State<'_>, email: String) -> AgateResult<()> {
    connections::remove_connection(&state, email).await
}

#[tauri::command]
pub async fn set_active_connection(state: State<'_>, email: String) -> AgateResult<()> {
    connections::set_active(&state, email).await
}

#[tauri::command]
pub async fn lock(state: State<'_>) -> AgateResult<()> {
    connections::lock(&state).await
}

#[tauri::command]
pub async fn logout(state: State<'_>) -> AgateResult<()> {
    connections::logout(&state).await
}
