//! Process-wide SDK init + the Tauri `.setup` closure body.

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
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

    // Re-arm the local MCP (AI access) server if the user enabled it previously.
    // It still fails closed until the vault is unlocked + the token matches.
    let ai_enabled = tauri::async_runtime::block_on(async {
        app.state::<AppState>().config.lock().await.ai_server_enabled
    });
    if ai_enabled {
        if let Err(e) = crate::aiserver::ensure_started(app.handle().clone()) {
            log::warn!("AI server auto-start failed: {}", e.message);
        }
    }

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

    // System-tray icon. Best-effort: a tray failure must never stop the app from
    // launching (the window is the primary surface).
    if let Err(e) = setup_tray(app) {
        log::warn!("tray setup failed: {e}");
    }
    Ok(())
}

/// Bring the main window to the front (tray left-click / the "Show" menu item).
fn reveal_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Build the system-tray icon: a Show / Quit menu; left-click reveals the window.
fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else {
        log::warn!("no default window icon; skipping tray");
        return Ok(());
    };

    let show = MenuItem::with_id(app, "show", "Show Agate", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Agate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => reveal_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}
