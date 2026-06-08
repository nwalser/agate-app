//! Agate Tauri backend: command registration + managed state.
//!
//! Commands are thin: they validate input, delegate to a module (`auth`,
//! `vault`, `unlock`), and return a typed `AgateResult`. No business logic or
//! SDK calls live here, and no command panics.

mod accounts;
mod audit;
mod auth;
mod dto;
mod error;
#[cfg(target_os = "windows")]
mod hello;
mod mutate;
mod secrets;
mod server;
mod state;
mod unlock;
mod vault;

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::Manager;

use dto::{
    AccountSummary, ExposedResult, Folder, ItemDetail, ItemInput, LoginResult, PassphraseGenOptions,
    PasswordGenOptions, ServerConfig, SessionStatus, TotpCode, TwoFactorInput, VaultHealthReport,
    VaultItem,
};
use error::{AgateError, AgateResult, ErrorKind};
use state::AppState;
use tauri_plugin_updater::UpdaterExt;

type State<'a> = tauri::State<'a, AppState>;

#[tauri::command]
async fn get_session_status(state: State<'_>) -> AgateResult<SessionStatus> {
    let (logged_in, unlocked) = {
        let session = state.session.lock().await;
        let logged_in = session.has_session();
        let unlocked = session.client.as_ref().map(|c| c.is_unlocked()).unwrap_or(false);
        (logged_in, unlocked)
    };
    let cfg = state.config.lock().await;
    Ok(SessionStatus {
        logged_in,
        unlocked,
        local_unlock_configured: cfg.local_unlock_configured,
        hello_configured: cfg.hello_configured,
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

#[tauri::command]
async fn generate_passphrase(state: State<'_>, options: PassphraseGenOptions) -> AgateResult<String> {
    vault::generate_passphrase(&state, options).await
}

// ---- vault write operations (mutate.rs) ----

#[tauri::command]
async fn save_item(state: State<'_>, input: ItemInput) -> AgateResult<()> {
    mutate::save_item(&state, input).await
}

#[tauri::command]
async fn clone_item(state: State<'_>, id: String) -> AgateResult<()> {
    mutate::clone_item(&state, &id).await
}

#[tauri::command]
async fn set_favorite(state: State<'_>, id: String, favorite: bool) -> AgateResult<()> {
    mutate::set_favorite(&state, &id, favorite).await
}

#[tauri::command]
async fn move_items(state: State<'_>, ids: Vec<String>, folder_id: Option<String>) -> AgateResult<()> {
    mutate::move_items(&state, ids, folder_id).await
}

#[tauri::command]
async fn delete_items(state: State<'_>, ids: Vec<String>, permanent: bool) -> AgateResult<()> {
    mutate::delete_items(&state, ids, permanent).await
}

#[tauri::command]
async fn restore_items(state: State<'_>, ids: Vec<String>) -> AgateResult<()> {
    mutate::restore_items(&state, ids).await
}

// ---- multiple accounts (accounts.rs) ----

#[tauri::command]
async fn list_accounts(state: State<'_>) -> AgateResult<Vec<AccountSummary>> {
    accounts::list_accounts(&state).await
}

#[tauri::command]
async fn switch_account(state: State<'_>, email: String) -> AgateResult<()> {
    accounts::switch_account(&state, email).await
}

#[tauri::command]
async fn remove_account(state: State<'_>, email: String) -> AgateResult<()> {
    accounts::remove_account(&state, email).await
}

// ---- security audit (audit.rs) ----

#[tauri::command]
async fn audit_offline(state: State<'_>) -> AgateResult<VaultHealthReport> {
    audit::audit_offline(&state).await
}

#[tauri::command]
async fn audit_exposed(state: State<'_>) -> AgateResult<Vec<ExposedResult>> {
    audit::audit_exposed(&state).await
}

// ---- Windows Hello unlock (hello.rs; stubs on other platforms) ----

#[tauri::command]
async fn hello_available() -> bool {
    #[cfg(target_os = "windows")]
    {
        hello::available().await
    }
    #[cfg(not(target_os = "windows"))]
    {
        false
    }
}

#[tauri::command]
async fn hello_enable(state: State<'_>) -> AgateResult<()> {
    #[cfg(target_os = "windows")]
    {
        hello::enable(&state).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = &state;
        Err(AgateError::new(ErrorKind::Internal, "Windows Hello is only available on Windows."))
    }
}

#[tauri::command]
async fn hello_disable(state: State<'_>) -> AgateResult<()> {
    state.config.lock().await.hello_configured = false;
    state.save_config().await
}

#[tauri::command]
async fn hello_unlock(state: State<'_>, window: tauri::WebviewWindow) -> AgateResult<()> {
    #[cfg(target_os = "windows")]
    {
        hello::unlock(&state, &window).await
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (&state, &window);
        Err(AgateError::new(ErrorKind::Internal, "Windows Hello is only available on Windows."))
    }
}

// ---- auto-updater ----

/// Returns the available update version, or null if up to date.
#[tauri::command]
async fn check_update(app: tauri::AppHandle) -> AgateResult<Option<String>> {
    let updater = app.updater().map_err(|e| AgateError::internal(format!("updater: {e}")))?;
    match updater.check().await {
        Ok(Some(update)) => Ok(Some(update.version)),
        Ok(None) => Ok(None),
        Err(e) => Err(AgateError::new(ErrorKind::Network, format!("Update check failed: {e}"))),
    }
}

/// Download + install the available update, locking the vault first (Windows
/// force-exits to run the installer), then relaunch.
#[tauri::command]
async fn run_update(app: tauri::AppHandle, state: State<'_>) -> AgateResult<()> {
    // Lock the vault and drop all secret material before the installer runs.
    state.session.lock().await.clear_secrets();
    let updater = app.updater().map_err(|e| AgateError::internal(format!("updater: {e}")))?;
    let Some(update) = updater
        .check()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Update check failed: {e}")))?
    else {
        return Ok(());
    };
    update
        .download_and_install(|_chunk, _total| {}, || {})
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("Update install failed: {e}")))?;
    app.restart();
}

#[tauri::command]
async fn create_folder(state: State<'_>, name: String) -> AgateResult<Folder> {
    mutate::create_folder(&state, name).await
}

#[tauri::command]
async fn rename_folder(state: State<'_>, id: String, name: String) -> AgateResult<Folder> {
    mutate::rename_folder(&state, &id, name).await
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
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let config_dir = app
                .path()
                .app_config_dir()
                .unwrap_or_else(|_| std::path::PathBuf::from("."));
            app.manage(AppState::load(config_dir));

            // Exclude the window from screen capture on Windows (decrypted
            // secrets are rendered in the DOM).
            #[cfg(target_os = "windows")]
            if let Some(window) = app.get_webview_window("main") {
                hello::protect_window(&window);
            }
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
            generate_passphrase,
            save_item,
            clone_item,
            set_favorite,
            move_items,
            delete_items,
            restore_items,
            create_folder,
            rename_folder,
            audit_offline,
            audit_exposed,
            hello_available,
            hello_enable,
            hello_disable,
            hello_unlock,
            check_update,
            run_update,
            list_accounts,
            switch_account,
            remove_account,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agate");
}
