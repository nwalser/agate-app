//! Process-wide SDK init + the Tauri `.setup` closure body.

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::Manager;

use crate::state::AppState;

fn device_type() -> DeviceType {
    // The desktop variants vary across SDK revs; `SDK` is always present and is a
    // safe, accurate descriptor for a third-party client.
    DeviceType::SDK
}

/// CLI flag historic autostart registrations pass. The app is tray-only now, so
/// the flag has no effect — it is kept (and still registered) only so existing
/// autostart entries that carry it keep launching cleanly.
pub const AUTOSTART_FLAG: &str = "--autostart";

/// Initialize SDK process-wide platform info exactly once.
pub fn init_platform() {
    init_host_platform_info(HostPlatformInfo {
        user_agent: format!("Agate/{}", env!("CARGO_PKG_VERSION")),
        device_type: device_type(),
        device_identifier: None,
        bitwarden_client_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        bitwarden_package_type: None,
    });
}

/// The Tauri `.setup` closure body: locate the config dir, manage `AppState`,
/// arm the autofill watcher, and set up the tray (the app's only surface — the
/// popup window stays hidden until summoned from the tray icon).
pub fn configure_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app.path().app_config_dir().unwrap_or_else(|e| {
        // Survivable (cwd fallback) but must be LOUD: config.json landing next to
        // the executable would read as lost settings/connections on next launch.
        log::error!("could not resolve the app config dir ({e}); falling back to the working directory");
        std::path::PathBuf::from(".")
    });
    app.manage(AppState::load(config_dir));

    // Arm the autofill watcher if the user previously chose a mode (Windows only;
    // a no-op on other platforms and when Off). Best-effort: it spawns its own
    // thread and never blocks launch.
    {
        let mode = {
            let state = app.state::<AppState>();
            tauri::async_runtime::block_on(async { state.config.lock().await.autofill_mode })
        };
        crate::autofill::apply_mode(app.handle().clone(), mode);
    }

    // The popup renders decrypted secrets — exclude it from screen capture on
    // Windows. Release builds only: under `tauri dev`,
    // SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE) makes the WebView2
    // compositor crash the host (exit 1) whenever the webview re-creates its
    // surfaces — which Vite HMR triggers on every frontend save. There are no
    // real secrets in dev, so skip it.
    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    if let Some(popup) = app.get_webview_window("tray") {
        crate::hello::protect_window(&popup);
    }

    // Coordinates the popup's click-outside-to-hide with the tray-icon toggle and
    // the form pin (see `tray::TrayPopup`). Must be managed before the tray +
    // window-event handlers can read it.
    app.manage(crate::tray::TrayPopup::default());

    // System-tray icon — the app's only entry point. A failure here leaves the
    // app unreachable, so show the popup as a fallback surface.
    if let Err(e) = crate::tray::setup_tray(app) {
        log::error!("tray setup failed: {e}");
        crate::tray::show_popup_near_tray(app.handle());
    }
    Ok(())
}
