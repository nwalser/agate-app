//! System-tray icon + the quick-access popup window.
//!
//! Left-click toggles the popup (the second window, label `tray`, declared in
//! `tauri.conf.json`) placed next to the click and clamped onto the monitor;
//! the tray menu keeps explicit Show / Quit entries. The popup hides on focus
//! loss and close (see `on_window_event` in `lib.rs`), and its webview re-reads
//! session state every time it shows, so it never renders a stale unlocked
//! list after a lock.
//!
//! Linux caveat: appindicator trays deliver no left-click events, so only the
//! menu works there — the popup is effectively Windows/macOS.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::Manager;

/// Gap between the popup and the click point / monitor edges (physical px).
const POPUP_MARGIN: i32 = 8;

/// Bring the main window to the front (tray menu "Show", a second app launch,
/// and the popup's "Open Agate" button).
pub fn reveal_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Build the system-tray icon: Show / Quit menu; left-click toggles the popup.
pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
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
                position,
                ..
            } = event
            {
                toggle_popup(tray.app_handle(), position);
            }
        })
        .build(app)?;
    Ok(())
}

/// Show the popup next to the tray click, or hide it if it's already open.
fn toggle_popup(app: &tauri::AppHandle, cursor: tauri::PhysicalPosition<f64>) {
    let Some(popup) = app.get_webview_window("tray") else {
        // The window is declared in tauri.conf.json, so this is config drift —
        // fall back to the main window rather than swallowing the click.
        log::warn!("tray popup window missing; revealing the main window instead");
        reveal_main(app);
        return;
    };
    if popup.is_visible().unwrap_or(false) {
        let _ = popup.hide();
        return;
    }
    // Best-effort placement: without monitor info the popup still opens, just
    // wherever the OS last left it.
    let monitor = app
        .monitor_from_point(cursor.x, cursor.y)
        .ok()
        .flatten()
        .or_else(|| popup.primary_monitor().ok().flatten());
    if let (Some(monitor), Ok(size)) = (monitor, popup.outer_size()) {
        // The WORK AREA (monitor minus taskbar/menubar/dock) — clamping against
        // it is what keeps the popup from overlapping the taskbar.
        let area = monitor.work_area();
        let (x, y) = popup_position(
            (cursor.x, cursor.y),
            (area.position.x, area.position.y),
            (area.size.width, area.size.height),
            (size.width, size.height),
        );
        let _ = popup.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = popup.show();
    let _ = popup.set_focus();
}

/// Top-left corner for the popup so it hugs the click point and stays fully
/// inside the monitor's WORK AREA — the region excluding the taskbar / menu
/// bar / dock — so it never overlaps them (all physical px). Horizontally
/// centered on the click, opening away from the taskbar edge (above when the
/// click is in the lower half — Windows taskbar — below when in the upper
/// half — macOS menu bar), then clamped into the area with a margin. A click
/// ON the taskbar itself sits outside the area and clamps back inside.
/// Pure, unit-tested.
fn popup_position(
    cursor: (f64, f64),
    area_pos: (i32, i32),
    area_size: (u32, u32),
    window_size: (u32, u32),
) -> (i32, i32) {
    let (cx, cy) = (cursor.0 as i32, cursor.1 as i32);
    let (mx, my) = area_pos;
    let (mw, mh) = (area_size.0 as i32, area_size.1 as i32);
    let (ww, wh) = (window_size.0 as i32, window_size.1 as i32);

    // Safe clamp: never panics when the window is larger than the monitor
    // (std's clamp would); the low bound wins so the popup pins to the
    // top/left edge instead.
    let clamp = |v: i32, lo: i32, hi: i32| v.max(lo).min(hi.max(lo));

    let x = clamp(cx - ww / 2, mx + POPUP_MARGIN, mx + mw - ww - POPUP_MARGIN);
    let y = if cy > my + mh / 2 {
        cy - wh - POPUP_MARGIN // click in the lower half → open upward
    } else {
        cy + POPUP_MARGIN // click in the upper half → open downward
    };
    let y = clamp(y, my + POPUP_MARGIN, my + mh - wh - POPUP_MARGIN);
    (x, y)
}

#[cfg(test)]
mod tests {
    use super::popup_position;

    // A 2560x1440 monitor whose bottom 48px are the Windows taskbar — the work
    // area the OS reports stops at y=1392.
    const AREA_POS: (i32, i32) = (0, 0);
    const AREA_SIZE: (u32, u32) = (2560, 1392);
    const WIN: (u32, u32) = (380, 520);

    #[test]
    fn click_on_bottom_taskbar_clamps_fully_above_it() {
        // Cursor at y=1430 is ON the taskbar (below the work area). The popup's
        // bottom edge must end above the work-area bottom, not overlap the bar.
        let (x, y) = popup_position((2000.0, 1430.0), AREA_POS, AREA_SIZE, WIN);
        assert_eq!(x, 2000 - 190);
        assert_eq!(y, 1392 - 520 - 8);
    }

    #[test]
    fn click_inside_lower_half_opens_above_centered_on_click() {
        let (x, y) = popup_position((2000.0, 1000.0), AREA_POS, AREA_SIZE, WIN);
        assert_eq!(x, 2000 - 190);
        assert_eq!(y, 1000 - 520 - 8);
    }

    #[test]
    fn top_menubar_opens_below_click_inside_area() {
        // macOS: the menu bar sits above the work area (area starts at y=25);
        // a click on it must open downward, inside the area.
        let (x, y) = popup_position((1280.0, 5.0), (0, 25), (2560, 1415), WIN);
        assert_eq!(x, 1280 - 190);
        assert_eq!(y, 25 + 8);
    }

    #[test]
    fn clamps_inside_right_edge() {
        let (x, _) = popup_position((2550.0, 1430.0), AREA_POS, AREA_SIZE, WIN);
        assert_eq!(x, 2560 - 380 - 8);
    }

    #[test]
    fn clamps_on_negative_origin_secondary_monitor() {
        let (x, y) = popup_position((-30.0, 1430.0), (-2560, 0), AREA_SIZE, WIN);
        assert_eq!(x, -2560 + 2560 - 380 - 8);
        assert_eq!(y, 1392 - 520 - 8);
    }

    #[test]
    fn window_taller_than_area_pins_to_top_without_panicking() {
        let (_, y) = popup_position((100.0, 190.0), (0, 0), (2560, 200), WIN);
        assert_eq!(y, 8);
    }
}
