//! Agate Tauri backend: command registration + managed state.
//!
//! The `#[tauri::command]` wrappers live in `commands/` (grouped by feature); the
//! `.setup` closure body + SDK platform init live in `setup`. This file is just the
//! module tree and the `run()` wiring.

mod aiserver;
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
mod ocr;
mod proxy;
mod qrscan;
mod scancache;
mod secrets;
mod server;
mod setup;
mod state;
mod tray;
mod vault;
mod window;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup::init_platform();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // Re-focus the existing window if a second instance is launched.
            tray::reveal_main(app);
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
                // The tray popup is positioned per-click next to the tray icon;
                // restoring a remembered position would fight that.
                .with_denylist(&["tray"])
                .build(),
        )
        .on_window_event(|window, event| match window.label() {
            // The tray popup never closes for real: focus loss and the close
            // button both just hide it, so the next tray click re-shows it
            // instantly.
            "tray" => match event {
                tauri::WindowEvent::Focused(false) => {
                    let _ = window.hide();
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            },
            // Close-to-tray (Settings → Startup): closing the main window hides
            // it and Agate keeps running in the tray. When OFF, exit explicitly —
            // the hidden tray-popup window would otherwise keep the process
            // alive forever after the main window is destroyed.
            "main" => {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    use tauri::Manager;
                    let state = window.state::<state::AppState>();
                    let close_to_tray = tauri::async_runtime::block_on(async {
                        state.config.lock().await.close_to_tray
                    });
                    if close_to_tray {
                        api.prevent_close();
                        let _ = window.hide();
                    } else {
                        window.app_handle().exit(0);
                    }
                }
            }
            _ => {}
        })
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
            ocr_available,
            ocr_capture_screen,
            ocr_capture_file,
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
            show_main_window,
            hide_tray_window,
            get_close_to_tray,
            set_close_to_tray,
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
            ai_server_status,
            ai_set_server_enabled,
            ai_list_grants,
            ai_set_grant,
            ai_clear_grants,
            ai_audit_log,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agate");
}
