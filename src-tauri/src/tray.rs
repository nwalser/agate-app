//! System-tray icon + the quick-access popup window — the app's ONLY window.
//!
//! Left-click toggles the popup (label `tray`, declared in `tauri.conf.json`)
//! placed next to the click and clamped onto the monitor; the tray menu keeps
//! explicit Open / Quit entries. The popup hides as soon as it loses focus (a
//! click anywhere outside it) — plus the tray icon (toggle), Escape, or a close
//! request — EXCEPT while a form view pins it (`TrayPopup::set_pinned`, driven
//! by TrayApp) so a stray click can't discard half-typed input. The focus-loss
//! hide lives in `on_window_event` (`lib.rs`) → `on_popup_focus_lost`. The
//! command layer broadcasts `agate://session-changed` (see `commands/mod.rs`)
//! and the popup re-reads session state on it (plus on every show), so it never
//! renders a stale unlocked list after a lock.
//!
//! Linux caveat: appindicator trays deliver no left-click events, so only the
//! menu works there — the popup is effectively Windows/macOS.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// Gap between the popup and the click point / monitor edges (physical px).
const POPUP_MARGIN: i32 = 8;

/// How long after a focus-loss auto-hide a tray click counts as the *same*
/// gesture, so the toggle leaves the popup hidden instead of re-opening it.
const AUTO_HIDE_DEBOUNCE: Duration = Duration::from_millis(200);

/// Managed (one per install, via `app.manage` in `setup`) coordination for the
/// popup's click-outside-to-hide behaviour — see the module docs.
#[derive(Default)]
pub struct TrayPopup {
    /// True while the add/edit-login form is open — the one view kept up on a
    /// focus loss, so a click elsewhere can't throw away a half-typed login.
    pinned: AtomicBool,
    /// When `on_popup_focus_lost` last auto-hid the popup. A tray-icon click
    /// blurs the popup (hide) and *then* fires the toggle a beat later; this
    /// timestamp lets the toggle tell that gesture apart from a fresh open, so it
    /// doesn't re-show what the same click just hid.
    last_auto_hidden: Mutex<Option<Instant>>,
}

impl TrayPopup {
    /// Pin (form open) or release (form closed) the popup against the focus-loss
    /// auto-hide. Driven by TrayApp via the `set_tray_pinned` command.
    pub fn set_pinned(&self, pinned: bool) {
        self.pinned.store(pinned, Ordering::Relaxed);
    }

    fn is_pinned(&self) -> bool {
        self.pinned.load(Ordering::Relaxed)
    }

    fn mark_auto_hidden(&self) {
        // Recover a poisoned lock rather than panic in a UI path.
        *self.last_auto_hidden.lock().unwrap_or_else(|e| e.into_inner()) = Some(Instant::now());
    }

    /// True iff a focus-loss auto-hide happened within `AUTO_HIDE_DEBOUNCE` — the
    /// current tray click is that same blur, so the toggle should leave the popup
    /// hidden. Consumes the timestamp so it only suppresses one open.
    fn took_recent_auto_hide(&self) -> bool {
        let mut slot = self.last_auto_hidden.lock().unwrap_or_else(|e| e.into_inner());
        match *slot {
            Some(at) if at.elapsed() < AUTO_HIDE_DEBOUNCE => {
                *slot = None;
                true
            }
            _ => false,
        }
    }
}

/// Hide the popup when it loses focus (a click anywhere outside it), unless the
/// add/edit-login form pins it open. Records the hide so the tray-icon click that
/// caused the blur doesn't immediately re-open it (see `toggle_popup`). Called
/// from `on_window_event` on `WindowEvent::Focused(false)`.
pub fn on_popup_focus_lost(window: &tauri::Window) {
    let app = window.app_handle();
    let popup = app.state::<TrayPopup>();
    // Form open — keep it up; a stray click must not discard a draft login.
    if popup.is_pinned() {
        return;
    }
    // Only an actually-visible popup can lose focus into hiding; guard against
    // spurious blur events so we never arm a debounce we didn't act on.
    if !window.is_visible().unwrap_or(false) {
        return;
    }
    // A focus loss ends any autofill prompt the popup was showing (mirrors the
    // close-request path).
    crate::autofill::clear_pending_for(app);
    let _ = window.hide();
    popup.mark_auto_hidden();
}

/// Emitted to the popup the instant it is shown, so it re-reads session + items
/// deterministically. The popup also refreshes on the OS focus event, but
/// WebView2 doesn't reliably deliver that after a hide()/show() cycle (a popup
/// can be shown without taking foreground), which left it rendering stale state —
/// e.g. still "locked" after the vault was unlocked in the main window. This
/// signal does not depend on focus, so the refresh always fires on show.
const TRAY_SHOWN_EVENT: &str = "agate://tray-shown";

/// Build the system-tray icon: Open / Quit menu; left-click toggles the popup.
pub fn setup_tray(app: &tauri::App) -> tauri::Result<()> {
    let Some(icon) = app.default_window_icon().cloned() else {
        log::warn!("no default window icon; skipping tray");
        return Ok(());
    };

    let show = MenuItem::with_id(app, "show", "Open Agate", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;

    TrayIconBuilder::with_id("main-tray")
        .icon(icon)
        .tooltip("Agate")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_popup_near_tray(app),
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
        // The window is declared in tauri.conf.json, so this is config drift.
        log::error!("tray popup window missing; the click has nowhere to go");
        return;
    };
    // A tray-icon open/close is never an autofill flow — drop any pending
    // detection so a stale one can't render the popup in fill mode here.
    crate::autofill::clear_pending_for(app);
    if popup.is_visible().unwrap_or(false) {
        let _ = popup.hide();
        return;
    }
    // The same click re-opening us may have just blurred + auto-hidden the popup
    // (the tray icon sits outside it, so the click is a focus loss too); honor
    // that as toggle-OFF rather than flickering it straight back open.
    if app.state::<TrayPopup>().took_recent_auto_hide() {
        return;
    }
    place_and_show(app, &popup, (cursor.x, cursor.y));
}

/// Show the popup next to the tray icon, unconditionally (never a toggle). Used by
/// autofill detection so the picker appears exactly where the popup always opens —
/// reusing the same work-area clamping as a tray click.
pub fn show_popup_near_tray(app: &tauri::AppHandle) {
    let Some(popup) = app.get_webview_window("tray") else {
        log::error!("tray popup window missing; nothing to show");
        return;
    };
    place_and_show(app, &popup, tray_anchor_point(app, &popup));
}

/// The physical screen point to open the popup at: the centre of the tray icon
/// when its rectangle is known, else the bottom-right corner of the primary work
/// area (where the Windows tray lives). `place_and_show` clamps it onto the
/// monitor and opens upward, so either way the popup hugs the tray.
fn tray_anchor_point(app: &tauri::AppHandle, popup: &tauri::WebviewWindow) -> (f64, f64) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if let Ok(Some(rect)) = tray.rect() {
            let scale = popup.scale_factor().unwrap_or(1.0);
            let pos = rect.position.to_physical::<f64>(scale);
            let size = rect.size.to_physical::<f64>(scale);
            return (pos.x + size.width / 2.0, pos.y + size.height / 2.0);
        }
    }
    if let Ok(Some(monitor)) = popup.primary_monitor() {
        let area = monitor.work_area();
        return (
            (area.position.x + area.size.width as i32) as f64,
            (area.position.y + area.size.height as i32) as f64,
        );
    }
    (0.0, 0.0)
}

/// Clamp the popup onto the work area around `cursor` and show + focus it.
fn place_and_show(app: &tauri::AppHandle, popup: &tauri::WebviewWindow, cursor: (f64, f64)) {
    // Best-effort placement: without monitor info the popup still opens, just
    // wherever the OS last left it.
    let monitor = app
        .monitor_from_point(cursor.0, cursor.1)
        .ok()
        .flatten()
        .or_else(|| popup.primary_monitor().ok().flatten());
    if let (Some(monitor), Ok(size)) = (monitor, popup.outer_size()) {
        // The WORK AREA (monitor minus taskbar/menubar/dock) — clamping against
        // it is what keeps the popup from overlapping the taskbar.
        let area = monitor.work_area();
        let (x, y) = popup_position(
            cursor,
            (area.position.x, area.position.y),
            (area.size.width, area.size.height),
            (size.width, size.height),
        );
        let _ = popup.set_position(tauri::PhysicalPosition::new(x, y));
    }
    let _ = popup.show();
    let _ = popup.set_focus();
    // Tell the now-visible popup to re-read session state, independent of whether
    // the OS delivered a focus event (see TRAY_SHOWN_EVENT). Best-effort.
    let _ = app.emit_to("tray", TRAY_SHOWN_EVENT, ());
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
    use super::{popup_position, TrayPopup};

    #[test]
    fn traypopup_pin_defaults_off_and_toggles() {
        let p = TrayPopup::default();
        assert!(!p.is_pinned());
        p.set_pinned(true);
        assert!(p.is_pinned());
        p.set_pinned(false);
        assert!(!p.is_pinned());
    }

    #[test]
    fn took_recent_auto_hide_is_false_without_a_mark() {
        let p = TrayPopup::default();
        assert!(!p.took_recent_auto_hide());
    }

    #[test]
    fn took_recent_auto_hide_fires_once_then_resets() {
        let p = TrayPopup::default();
        p.mark_auto_hidden();
        // Just marked → within the debounce → suppress this re-open...
        assert!(p.took_recent_auto_hide());
        // ...but only once: the next tray click is a real open.
        assert!(!p.took_recent_auto_hide());
    }

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
