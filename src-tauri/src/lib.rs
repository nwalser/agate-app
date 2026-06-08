//! Agate Tauri backend: command registration + managed state.
//!
//! Commands are thin: they validate input, delegate to a module (`appunlock`,
//! `connections`, `vault`, …), and return a typed `AgateResult`. No business logic
//! or SDK calls live here, and no command panics.

mod appunlock;
mod audit;
mod auth;
mod connections;
mod darkweb;
mod dto;
mod error;
#[cfg(target_os = "windows")]
mod hello;
mod keepass;
mod mutate;
mod proxy;
mod secrets;
mod server;
mod state;
mod vault;
mod window;

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::Manager;
use zeroize::Zeroizing;

use dto::{
    AccountBreaches, BreachRecord, ConnectionSummary, DarkWebReport, ExposedResult, Folder,
    ItemDetail, ItemInput, LoginResult, PassphraseGenOptions, PasswordGenOptions, ServerConfig,
    SessionStatus, TotpCode, TwoFactorInput, UnlockOutcome, VaultHealthReport, VaultItem,
};
use error::{AgateError, AgateResult, ErrorKind};
use state::AppState;
use tauri_plugin_updater::UpdaterExt;

type State<'a> = tauri::State<'a, AppState>;

#[tauri::command]
async fn get_session_status(state: State<'_>) -> AgateResult<SessionStatus> {
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
async fn get_server_config(state: State<'_>) -> AgateResult<ServerConfig> {
    Ok(state.config.lock().await.server.clone())
}

#[tauri::command]
async fn set_server_config(state: State<'_>, server: ServerConfig) -> AgateResult<()> {
    connections::set_server(&state, server).await
}

// ---- app unlock (appunlock.rs) ----

#[tauri::command]
async fn configure_app_unlock(state: State<'_>, app_password: String) -> AgateResult<()> {
    appunlock::configure(&state, Zeroizing::new(app_password)).await
}

#[tauri::command]
async fn change_app_unlock(state: State<'_>, new_password: String) -> AgateResult<()> {
    appunlock::change(&state, Zeroizing::new(new_password)).await
}

#[tauri::command]
async fn unlock_all(state: State<'_>, app_password: String) -> AgateResult<Vec<UnlockOutcome>> {
    appunlock::unlock_all(&state, Zeroizing::new(app_password)).await
}

#[tauri::command]
async fn unlock_connection_2fa(
    state: State<'_>,
    email: String,
    two_factor: TwoFactorInput,
) -> AgateResult<()> {
    appunlock::unlock_connection_2fa(&state, email, two_factor).await
}

#[tauri::command]
async fn send_connection_email_code(state: State<'_>, email: String) -> AgateResult<()> {
    appunlock::send_connection_email_code(&state, email).await
}

// ---- connections (connections.rs) ----

#[tauri::command]
async fn list_connections(state: State<'_>) -> AgateResult<Vec<ConnectionSummary>> {
    connections::list_connections(&state).await
}

#[tauri::command]
async fn add_connection(
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
    two_factor: Option<TwoFactorInput>,
) -> AgateResult<LoginResult> {
    connections::add_connection(&state, server, email, Zeroizing::new(password), two_factor).await
}

#[tauri::command]
async fn send_email_code(
    state: State<'_>,
    server: ServerConfig,
    email: String,
    password: String,
) -> AgateResult<()> {
    connections::send_add_email_code(&state, server, email, Zeroizing::new(password)).await
}

#[tauri::command]
async fn remove_connection(state: State<'_>, email: String) -> AgateResult<()> {
    connections::remove_connection(&state, email).await
}

#[tauri::command]
async fn set_active_connection(state: State<'_>, email: String) -> AgateResult<()> {
    connections::set_active(&state, email).await
}

#[tauri::command]
async fn lock(state: State<'_>) -> AgateResult<()> {
    connections::lock(&state).await
}

#[tauri::command]
async fn logout(state: State<'_>) -> AgateResult<()> {
    connections::logout(&state).await
}

// ---- vault read (vault.rs) ----

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
async fn item_detail(state: State<'_>, account_email: String, id: String) -> AgateResult<ItemDetail> {
    vault::item_detail(&state, &account_email, &id).await
}

#[tauri::command]
async fn item_totp(state: State<'_>, account_email: String, id: String) -> AgateResult<TotpCode> {
    vault::item_totp(&state, &account_email, &id).await
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
async fn save_item(state: State<'_>, account_email: String, input: ItemInput) -> AgateResult<()> {
    mutate::save_item(&state, &account_email, input).await
}

#[tauri::command]
async fn clone_item(state: State<'_>, account_email: String, id: String) -> AgateResult<()> {
    mutate::clone_item(&state, &account_email, &id).await
}

#[tauri::command]
async fn set_favorite(state: State<'_>, account_email: String, id: String, favorite: bool) -> AgateResult<()> {
    mutate::set_favorite(&state, &account_email, &id, favorite).await
}

#[tauri::command]
async fn move_items(
    state: State<'_>,
    account_email: String,
    ids: Vec<String>,
    folder_id: Option<String>,
) -> AgateResult<()> {
    mutate::move_items(&state, &account_email, ids, folder_id).await
}

#[tauri::command]
async fn delete_items(
    state: State<'_>,
    account_email: String,
    ids: Vec<String>,
    permanent: bool,
) -> AgateResult<()> {
    mutate::delete_items(&state, &account_email, ids, permanent).await
}

#[tauri::command]
async fn restore_items(state: State<'_>, account_email: String, ids: Vec<String>) -> AgateResult<()> {
    mutate::restore_items(&state, &account_email, ids).await
}

#[tauri::command]
async fn create_folder(state: State<'_>, account_email: String, name: String) -> AgateResult<Folder> {
    mutate::create_folder(&state, &account_email, name).await
}

#[tauri::command]
async fn rename_folder(state: State<'_>, account_email: String, id: String, name: String) -> AgateResult<Folder> {
    mutate::rename_folder(&state, &account_email, &id, name).await
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

// ---- dark-web / breach monitor (darkweb.rs) ----

#[tauri::command]
async fn set_darkweb_consent(state: State<'_>, enabled: bool) -> AgateResult<()> {
    darkweb::set_consent(&state, enabled).await
}

#[tauri::command]
async fn darkweb_scan_email(state: State<'_>, email: String) -> AgateResult<AccountBreaches> {
    darkweb::scan_email(&state, email).await
}

#[tauri::command]
async fn darkweb_scan_vault(state: State<'_>) -> AgateResult<DarkWebReport> {
    darkweb::scan_vault(&state).await
}

#[tauri::command]
async fn breach_directory(state: State<'_>) -> AgateResult<Vec<BreachRecord>> {
    darkweb::directory(&state).await
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
    // Cross-platform: forget the stored VMK + clear the flag (no Hello API needed).
    secrets::delete_hello_blob()?;
    state.config.lock().await.hello_configured = false;
    state.save_config().await
}

#[tauri::command]
async fn hello_unlock(state: State<'_>, window: tauri::WebviewWindow) -> AgateResult<Vec<UnlockOutcome>> {
    #[cfg(target_os = "windows")]
    {
        hello::unlock_all(&state, &window).await
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
    // Lock the vault and drop all secret material (incl. the VMK) before the
    // installer runs.
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

/// The titlebar's window-control layout for this platform (Linux reads the
/// desktop's `button-layout`; others use a fixed default). Pure host query — no
/// state, never fails.
#[tauri::command]
fn window_controls_layout() -> dto::WindowControlsLayout {
    window::controls_layout()
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

            if let Some(window) = app.get_webview_window("main") {
                // Exclude the window from screen capture on Windows (decrypted
                // secrets are rendered in the DOM).
                #[cfg(target_os = "windows")]
                hello::protect_window(&window);

                // Native window chrome per platform. Windows/Linux run borderless
                // so the custom titlebar (components/Titlebar.tsx) owns the top
                // strip with its own min/maximize/close controls. macOS keeps its
                // real title bar with the overlay style (tauri.conf.json
                // `titleBarStyle`). Best-effort: a failure leaves default chrome.
                #[cfg(not(target_os = "macos"))]
                let _ = window.set_decorations(false);

                // The window starts hidden (`visible: false`) so the decoration
                // change is never visible as a flash; reveal it once chrome is set.
                let _ = window.show();
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_session_status,
            get_server_config,
            set_server_config,
            configure_app_unlock,
            change_app_unlock,
            unlock_all,
            unlock_connection_2fa,
            send_connection_email_code,
            list_connections,
            add_connection,
            send_email_code,
            remove_connection,
            set_active_connection,
            lock,
            logout,
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
            window_controls_layout,
            audit_offline,
            audit_exposed,
            set_darkweb_consent,
            darkweb_scan_email,
            darkweb_scan_vault,
            breach_directory,
            hello_available,
            hello_enable,
            hello_disable,
            hello_unlock,
            check_update,
            run_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agate");
}
