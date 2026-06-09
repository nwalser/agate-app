//! Process-wide SDK init + the Tauri `.setup` closure body.

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::Manager;

use crate::state::AppState;

fn device_type() -> DeviceType {
    // The desktop variants vary across SDK revs; `SDK` is always present and is a
    // safe, accurate descriptor for a third-party client.
    DeviceType::SDK
}

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
/// then set native window chrome and reveal the window.
pub fn configure_app(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config_dir = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("."));
    app.manage(AppState::load(config_dir));

    if let Some(window) = app.get_webview_window("main") {
        // Exclude the window from screen capture on Windows (decrypted
        // secrets are rendered in the DOM). Release builds only: under
        // `tauri dev`, SetWindowDisplayAffinity(WDA_EXCLUDEFROMCAPTURE)
        // makes the WebView2 compositor crash the host (exit 1) whenever
        // the webview re-creates its surfaces — which Vite HMR triggers on
        // every frontend save. There are no real secrets in dev, so skip it.
        #[cfg(all(target_os = "windows", not(debug_assertions)))]
        crate::hello::protect_window(&window);

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
}
