//! Agate Tauri backend: command registration + managed state.
//!
//! The `#[tauri::command]` wrappers live in `commands/` (grouped by feature); the
//! `.setup` closure body + SDK platform init live in `setup`. This file is just the
//! module tree and the `run()` wiring.

mod appunlock;
mod auth;
mod autofill;
mod commands;
mod connections;
mod dto;
mod error;
#[cfg(target_os = "windows")]
mod hello;
// Biometric unlock for non-Windows (Touch ID / polkit). ⚠️ authored on Windows,
// unverified on its target platforms — see src/hello_unix.rs.
#[cfg(any(target_os = "macos", target_os = "linux"))]
mod hello_unix;
mod mutate;
// Provider-agnostic passkey (FIDO2/WebAuthn) storage types. The per-provider
// persistence is dispatched off `providers::LiveConnection`; the OS-integration
// shims (Layer C) and the CredentialStore ceremony adapter build on these.
mod passkey;
mod providers;
mod proxy;
mod secrets;
mod server;
mod setup;
mod state;
mod strength;
mod tray;
mod vault;

use commands::*;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    setup::init_platform();

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            // A second launch opens the existing instance's popup by the tray.
            tray::show_popup_near_tray(app);
        }))
        .plugin(tauri_plugin_log::Builder::new().build())
        // Launch-at-login (toggled via the set_autostart/get_autostart commands).
        // The flag marks login launches so start-in-tray can apply only to them
        // (see setup::start_hidden).
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![setup::AUTOSTART_FLAG]),
        ))
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .on_window_event(|window, event| {
            // The tray popup (the only window) hides on focus loss (click
            // anywhere outside it), EXCEPT while a form view pins it open (see
            // `tray.rs`). A close request never closes it for real — it just
            // hides, so the next tray click re-shows it instantly.
            if window.label() == "tray" {
                match event {
                    tauri::WindowEvent::CloseRequested { api, .. } => {
                        use tauri::Manager;
                        api.prevent_close();
                        // Closing the popup ends any autofill prompt it was showing.
                        autofill::clear_pending_for(window.app_handle());
                        let _ = window.hide();
                    }
                    // Click-outside-to-dismiss; honors the form pin.
                    tauri::WindowEvent::Focused(false) => tray::on_popup_focus_lost(window),
                    _ => {}
                }
            }
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
            pick_keepass_database,
            pick_keepass_keyfile,
            pick_keepass_new_database,
            add_keepass_connection,
            create_keepass_connection,
            unlock_keepass_connection,
            pick_pass_store,
            pick_pass_keyfile,
            add_pass_connection,
            unlock_pass_connection,
            pick_enpass_vault,
            add_enpass_connection,
            unlock_enpass_connection,
            set_active_connection,
            lock,
            logout,
            sync_vault,
            list_items,
            list_folders,
            list_collections,
            list_custom_field_names,
            item_detail,
            item_totp,
            generate_password,
            generate_passphrase,
            generate_username,
            save_item,
            clone_item,
            set_favorite,
            move_items,
            delete_items,
            restore_items,
            create_folder,
            rename_folder,
            delete_folder,
            hide_tray_window,
            show_tray_window,
            set_tray_pinned,
            get_system_locale,
            get_autostart,
            set_autostart,
            password_in_use,
            password_strength,
            hello_available,
            hello_enable,
            hello_disable,
            hello_unlock,
            check_update,
            run_update,
            autofill_status,
            autofill_set_mode,
            autofill_set_submit,
            autofill_set_denylist,
            autofill_associate,
            autofill_pending,
            autofill_fill,
            autofill_dismiss,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Agate");
}
