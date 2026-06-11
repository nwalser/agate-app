//! Process-wide SDK init + the Tauri `.setup` closure body.

use bitwarden_core::{init_host_platform_info, DeviceType, HostPlatformInfo};
use tauri::Manager;

use crate::state::AppState;

fn device_type() -> DeviceType {
    // The desktop variants vary across SDK revs; `SDK` is always present and is a
    // safe, accurate descriptor for a third-party client.
    DeviceType::SDK
}

/// CLI flag the autostart registration passes (see the autostart plugin init in
/// `lib.rs`), so a login launch is distinguishable from the user opening Agate
/// by hand.
pub const AUTOSTART_FLAG: &str = "--autostart";

/// Whether this launch leaves the main window hidden (tray icon only): the
/// user opted in AND the process was started by the OS autostart entry (the
/// args carry [`AUTOSTART_FLAG`]). A manual launch always shows the window.
fn start_hidden(start_in_tray: bool, mut args: impl Iterator<Item = String>) -> bool {
    start_in_tray && args.any(|a| a == AUTOSTART_FLAG)
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
    let config_dir = app.path().app_config_dir().unwrap_or_else(|e| {
        // Survivable (cwd fallback) but must be LOUD: config.json landing next to
        // the executable would read as lost settings/connections on next launch.
        log::error!("could not resolve the app config dir ({e}); falling back to the working directory");
        std::path::PathBuf::from(".")
    });
    app.manage(AppState::load(config_dir));

    // Re-arm the local MCP (AI access) server if the user enabled it previously.
    // It still fails closed until the vault is unlocked + the token matches.
    let (ai_enabled, start_in_tray) = {
        let state = app.state::<AppState>();
        tauri::async_runtime::block_on(async {
            let cfg = state.config.lock().await;
            (cfg.ai_server_enabled, cfg.start_in_tray)
        })
    };
    if ai_enabled {
        if let Err(e) = crate::aiserver::ensure_started(app.handle().clone()) {
            // Error, not warn: the user's MCP client will keep sending the bearer
            // token at a port some other process may now own. The Settings page
            // shows running:false; this is the only other trace.
            log::error!("AI server auto-start failed: {}", e.message);
        }
    }

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

    // Tray-only start: opted in + launched by the OS autostart entry. Skip the
    // first CLI arg (the executable path can be anything, including the flag's
    // text on a pathological install).
    let hidden = start_hidden(start_in_tray, std::env::args().skip(1));

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
        // change is never visible as a flash; reveal it once chrome is set —
        // unless this is a tray-only autostart launch. The explicit hide()
        // guards against the window-state plugin having revealed the window
        // while restoring a maximized state.
        if hidden {
            let _ = window.hide();
        } else {
            let _ = window.show();
        }
    }

    // The tray quick-access popup renders decrypted secrets too — give it the
    // same screen-capture exclusion as the main window (Windows release only;
    // see the comment above for why dev builds skip it).
    #[cfg(all(target_os = "windows", not(debug_assertions)))]
    if let Some(popup) = app.get_webview_window("tray") {
        crate::hello::protect_window(&popup);
    }

    // System-tray icon. Best-effort: a tray failure must never stop the app from
    // launching (the window is the primary surface).
    if let Err(e) = crate::tray::setup_tray(app) {
        log::warn!("tray setup failed: {e}");
        // A hidden start with no tray icon would leave the app unreachable —
        // fall back to showing the window.
        if hidden {
            crate::tray::reveal_main(app.handle());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{start_hidden, AUTOSTART_FLAG};

    fn args(v: &[&str]) -> std::vec::IntoIter<String> {
        v.iter().map(|s| s.to_string()).collect::<Vec<_>>().into_iter()
    }

    #[test]
    fn autostart_launch_with_setting_starts_hidden() {
        assert!(start_hidden(true, args(&[AUTOSTART_FLAG])));
    }

    #[test]
    fn manual_launch_stays_visible_even_with_the_setting_on() {
        assert!(!start_hidden(true, args(&[])));
        assert!(!start_hidden(true, args(&["--some-other-flag"])));
    }

    #[test]
    fn autostart_launch_without_the_setting_stays_visible() {
        assert!(!start_hidden(false, args(&[AUTOSTART_FLAG])));
    }
}
