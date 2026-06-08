//! Agate Tauri backend: command registration + managed state.
//!
//! Commands are thin: they validate input, delegate to a module (`auth`,
//! `vault`, `unlock`), and return a typed `AgateResult`. No business logic or
//! SDK calls live here, and no command panics.

mod auth;
mod dto;
mod error;
mod secrets;
mod server;
mod state;
mod unlock;
mod vault;

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::Manager;

use dto::{
    Folder, ItemDetail, LoginResult, PasswordGenOptions, ServerConfig, SessionStatus, TotpCode,
    TwoFactorInput, VaultItem,
};
use error::AgateResult;
use state::AppState;

type State<'a> = tauri::State<'a, AppState>;

#[tauri::command]
async fn get_session_status(state: State<'_>) -> AgateResult<SessionStatus> {
    let (logged_in, unlocked) = {
        let session = state.session.lock().await;
        let logged_in = session.client.is_some();
        let unlocked = session.client.as_ref().map(|c| c.is_unlocked()).unwrap_or(false);
        (logged_in, unlocked)
    };
    let cfg = state.config.lock().await;
    Ok(SessionStatus {
        logged_in,
        unlocked,
        local_unlock_configured: cfg.local_unlock_configured,
        email: cfg.email.clone(),
    })
}

#[tauri::command]
async fn get_server_config(state: State<'_>) -> AgateResult<ServerConfig> {
    Ok(state.config.lock().await.server.clone())
}

#[tauri::command]
async fn set_server_config(state: State<'_>, server: ServerConfig) -> AgateResult<()> {
    unlock::set_server(&state, server).await
}

#[tauri::command]
async fn login(
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    auth::login(&state, server, email, password, two_factor).await
}

#[tauri::command]
async fn send_email_code(
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
) -> AgateResult<()> {
    auth::send_email_code(&state, server, email, password).await
}

#[tauri::command]
async fn lock(state: State<'_>) -> AgateResult<()> {
    auth::lock(&state).await
}

#[tauri::command]
async fn logout(state: State<'_>) -> AgateResult<()> {
    auth::logout(&state).await
}

#[tauri::command]
async fn enable_local_unlock(state: State<'_>, local_password: String) -> AgateResult<()> {
    unlock::enable(&state, local_password).await
}

#[tauri::command]
async fn unlock_local(state: State<'_>, local_password: String) -> AgateResult<()> {
    unlock::unlock_local(&state, local_password).await
}

#[tauri::command]
async fn disable_local_unlock(state: State<'_>) -> AgateResult<()> {
    unlock::disable(&state).await
}

#[tauri::command]
async fn sync_vault(state: State<'_>, force: bool) -> AgateResult<()> {
    vault::sync(&state, force).await
}

#[tauri::command]
async fn list_items(state: State<'_>) -> AgateResult<Vec<VaultItem>> {
    vault::list_items(&state).await
}

#[tauri::command]
async fn list_folders(state: State<'_>) -> AgateResult<Vec<Folder>> {
    vault::list_folders(&state).await
}

#[tauri::command]
async fn item_detail(state: State<'_>, id: String) -> AgateResult<ItemDetail> {
    vault::item_detail(&state, &id).await
}

#[tauri::command]
async fn item_totp(state: State<'_>, id: String) -> AgateResult<TotpCode> {
    vault::item_totp(&state, &id).await
}

#[tauri::command]
async fn generate_password(state: State<'_>, options: PasswordGenOptions) -> AgateResult<String> {
    vault::generate_password(&state, options).await
}

fn device_type() -> DeviceType {
    // The desktop variants vary across SDK revs; `SDK` is always present and is a
    // safe, accurate descriptor for a third-party client.
    DeviceType::SDK
}

/// Initialize SDK process-wide platform info exactly once.
fn init_platform() {
    init_host_platform_info(HostPlatformInfo {
        user_agent: format!("Agate/{}", env!("CARGO_PKG_VERSION")),
        device_type: device_type(),
        device_identifier: None,
        bitwarden_client_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        bitwarden_package_type: None,
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_platform();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Re-focus the existing window if a second instance is launched.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            app.manage(AppState::load(config_dir));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_session_status,
            get_server_config,
            set_server_config,
            login,
            send_email_code,
            lock,
            logout,
            enable_local_unlock,
            unlock_local,
            disable_local_unlock,
            sync_vault,
            list_items,
            list_folders,
            item_detail,
            item_totp,
            generate_password,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agate");
}
