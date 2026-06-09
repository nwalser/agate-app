//! Agate Tauri backend: command registration + managed state.
//!
//! The `#[tauri::command]` wrappers live in `commands/` (grouped by feature); the
//! `.setup` closure body + SDK platform init live in `setup`. This file is just the
//! module tree and the `run()` wiring.

mod appunlock;
mod audit;
mod auth;
mod commands;
mod connections;
mod darkweb;
mod dto;
mod error;
#[cfg(target_os = "windows")]
mod hello;
// Biometric unlock for non-Windows (Touch ID / polkit). ⚠️ authored on Windows,
// unverified on its target platforms — see src/hello_unix.rs.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod hello_unix;
mod mutate;
mod proxy;
mod qrscan;
mod scancache;
mod secrets;
mod server;
mod setup;
mod state;
mod vault;
mod window;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup::init_platform();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Re-focus the existing window if a second instance is launched.
            if let Some(window) = tauri::Manager::get_webview_window(app, "main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        // Launch-at-login (toggled via the set_autostart/get_autostart commands).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        // Remember the window's size/position/maximized state across restarts.
        // Restrict the flags: VISIBLE stays out because the window deliberately
        // starts hidden and is shown by hand once chrome is set (see setup), and
        // DECORATIONS stays out because we own decorations per-platform — letting
        // the plugin restore either would fight that flow.
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .setup(|app| setup::configure_app(app))
        .invoke_handler(tauri::generate_handler![
            get_session_status,
            get_server_config,
            set_server_config,
            configure_app_unlock,
            change_app_unlock,
            unlock_all,
            verify_app_password,
            unlock_connection_2fa,
            send_connection_email_code,
            list_connections,
            add_connection,
            update_connection,
            unlock_connection,
            send_email_code,
            remove_connection,
            set_active_connection,
            lock,
            logout,
            sync_vault,
            list_items,
            list_folders,
            list_collections,
            list_sends,
            delete_send,
            download_attachment,
            item_detail,
            item_totp,
            scan_totp_qr,
            generate_password,
            generate_passphrase,
            generate_username,
            export_vault,
            import_vault,
            save_item,
            clone_item,
            set_favorite,
            move_items,
            delete_items,
            restore_items,
            create_folder,
            rename_folder,
            delete_folder,
            window_controls_layout,
            get_autostart,
            set_autostart,
            audit_offline,
            audit_exposed,
            set_darkweb_consent,
            darkweb_scan_email,
            darkweb_scan_vault,
            breach_directory,
            cache_security_scans,
            load_security_scans,
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
