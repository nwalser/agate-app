//! Windows detection watcher: a dedicated message-loop thread that triggers
//! autofill detection either continuously (a focus hook) or on demand (a global
//! hotkey), per the configured [`AutofillMode`].
//!
//! - **Watch**: `SetWinEventHook(EVENT_OBJECT_FOCUS, …, WINEVENT_SKIPOWNPROCESS)`
//!   fires whenever any control gains focus; we inspect it and offer autofill only
//!   when it's a login field (a password box, or a username/email box). Largest
//!   surface — explicitly opt-in.
//! - **Hotkey**: `RegisterHotKey` (Ctrl+Alt+\) inspects the foreground window's
//!   focused field only when the user asks. Nothing is watched between presses.
//!
//! Both run on one owned thread with a `GetMessageW` loop; `apply` stops the old
//! thread (PostThreadMessage WM_QUIT + join) before starting a new one, so a mode
//! switch never leaves two watchers installed. The thread is COM-initialized MTA
//! so the UIA calls in `uia` work on it.
//!
//! ⚠️ Written and (only) `cargo check`-verified on Windows; the live hook / hotkey
//! / message-loop behaviour must be verified on-device (CLAUDE.md DoD §3).

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use windows::Win32::Foundation::{HMODULE, HWND, LPARAM, WPARAM};
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::Accessibility::{SetWinEventHook, UnhookWinEvent, HWINEVENTHOOK};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, VK_OEM_5,
};
use windows::Win32::UI::WindowsAndMessaging::{
    DispatchMessageW, GetForegroundWindow, GetMessageW, PostThreadMessageW, TranslateMessage,
    EVENT_OBJECT_FOCUS, MSG, WINEVENT_OUTOFCONTEXT, WINEVENT_SKIPOWNPROCESS, WM_HOTKEY, WM_QUIT,
};

use super::uia;
use crate::dto::{AutofillField, AutofillMode};

/// Hotkey id for our `RegisterHotKey` registration (process-unique is enough).
const HOTKEY_ID: i32 = 0x4147; // 'AG'

/// Debounce between detections — focus events can storm, and a settle window after
/// a fill keeps the just-filled field from instantly re-opening the popup.
const DEBOUNCE: Duration = Duration::from_millis(250);

#[derive(Clone, Copy, PartialEq)]
enum Mode {
    Hotkey,
    Watch,
}

struct WatcherHandle {
    thread_id: u32,
    join: std::thread::JoinHandle<()>,
}

fn running() -> &'static Mutex<Option<WatcherHandle>> {
    static RUNNING: OnceLock<Mutex<Option<WatcherHandle>>> = OnceLock::new();
    RUNNING.get_or_init(|| Mutex::new(None))
}

/// AppHandle for the focus-hook callback (which can't capture state). Set while a
/// watch thread runs, cleared when it exits.
fn hook_app() -> &'static Mutex<Option<tauri::AppHandle>> {
    static HOOK_APP: OnceLock<Mutex<Option<tauri::AppHandle>>> = OnceLock::new();
    HOOK_APP.get_or_init(|| Mutex::new(None))
}

/// Suppress detection until this instant (set after a fill, and briefly after each
/// detection, to debounce focus storms).
fn suppress_until() -> &'static Mutex<Option<Instant>> {
    static SUPPRESS: OnceLock<Mutex<Option<Instant>>> = OnceLock::new();
    SUPPRESS.get_or_init(|| Mutex::new(None))
}

/// The per-app denylist snapshot. The watcher thread is synchronous and can't await
/// the config mutex, so `set_denylist_snapshot` mirrors the persisted list here for
/// `detect_focused` to consult. Independent of the watcher thread's lifetime, so it
/// survives mode restarts.
fn denylist() -> &'static Mutex<Vec<String>> {
    static DENYLIST: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    DENYLIST.get_or_init(|| Mutex::new(Vec::new()))
}

/// Replace the live denylist snapshot (called on every denylist change + at launch).
pub fn set_denylist_snapshot(list: Vec<String>) {
    *lock(denylist()) = list;
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Suppress detection for `ms` milliseconds — called around a fill so the
/// re-activated target's focus event doesn't immediately re-open the popup.
pub fn suppress_for(ms: u64) {
    *lock(suppress_until()) = Instant::now().checked_add(Duration::from_millis(ms));
}

fn is_suppressed() -> bool {
    matches!(*lock(suppress_until()), Some(until) if Instant::now() < until)
}

/// The top-level window + field kind we last offered autofill for (Watch mode).
/// This guards the re-pop loop: dismissing our popup hides it, which refocuses the
/// target's still-focused login field and fires another `EVENT_OBJECT_FOCUS` for
/// the SAME window+field. We skip those until focus genuinely leaves that field —
/// any non-login control (same window or not) clears the guard, so deliberately
/// clicking the field again re-offers (see [`watch_decision`]). Keying on the
/// FIELD too means a username box and the password box of one form each get one
/// offer — so a user can fill the username, tab over, and be offered the password.
fn last_detected() -> &'static Mutex<Option<(isize, AutofillField)>> {
    static LAST: OnceLock<Mutex<Option<(isize, AutofillField)>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// What the watch hook does for one focus event.
#[derive(Debug, Clone, Copy, PartialEq)]
enum WatchAction {
    /// Offer autofill for the detected login field.
    Offer,
    /// Focus is not on a login field — close an open autofill popup.
    Dismiss,
    /// Do nothing (bounce-back refocus of the guarded field, or suppressed).
    Skip,
}

/// Decide one watch-mode focus event: `last` is the re-pop guard, `fg` the
/// foreground top-level window, `detected` the focused login field (None = focus
/// is on a non-login control). Returns the next guard value and the action.
/// Pure — unit-tested.
///
/// The guard exists only to eat the bounce-back refocus after our popup hides
/// (the popup's own focus events never reach us — `WINEVENT_SKIPOWNPROCESS`).
/// So it is released the moment focus genuinely leaves the guarded field: a
/// non-login control OR another window. A suppressed event never claims the
/// guard — it must not block the user's next genuine focus.
fn watch_decision(
    last: Option<(isize, AutofillField)>,
    fg: isize,
    detected: Option<(isize, AutofillField)>,
    suppressed: bool,
) -> (Option<(isize, AutofillField)>, WatchAction) {
    let last = last.filter(|(hwnd, _)| *hwnd == fg);
    match detected {
        None => (None, WatchAction::Dismiss),
        Some(key) if last == Some(key) => (Some(key), WatchAction::Skip),
        Some(_) if suppressed => (last, WatchAction::Skip),
        Some(key) => (Some(key), WatchAction::Offer),
    }
}

/// Apply a mode: stop any running watcher, then start the one for `mode`
/// (Off starts nothing). Idempotent and safe to call repeatedly.
pub fn apply(app: tauri::AppHandle, mode: AutofillMode) {
    stop();
    match mode {
        AutofillMode::Off => {}
        AutofillMode::Hotkey => start_thread(app, Mode::Hotkey),
        AutofillMode::Watch => start_thread(app, Mode::Watch),
    }
}

/// Stop the running watcher (if any): ask its message loop to quit, then join.
fn stop() {
    let handle = lock(running()).take();
    if let Some(handle) = handle {
        unsafe {
            let _ = PostThreadMessageW(handle.thread_id, WM_QUIT, WPARAM(0), LPARAM(0));
        }
        let _ = handle.join.join();
    }
}

fn start_thread(app: tauri::AppHandle, mode: Mode) {
    *lock(hook_app()) = Some(app.clone());
    let (tx, rx) = std::sync::mpsc::channel::<u32>();
    let join = std::thread::Builder::new()
        .name("agate-autofill-watcher".into())
        .spawn(move || run_thread(app, mode, tx));
    let join = match join {
        Ok(j) => j,
        Err(e) => {
            log::warn!("autofill watcher thread spawn failed: {e}");
            *lock(hook_app()) = None;
            return;
        }
    };
    // The thread publishes its id once its message queue + hook/hotkey are ready.
    match rx.recv() {
        Ok(thread_id) => *lock(running()) = Some(WatcherHandle { thread_id, join }),
        Err(_) => {
            let _ = join.join();
            *lock(hook_app()) = None;
        }
    }
}

fn run_thread(app: tauri::AppHandle, mode: Mode, tx: std::sync::mpsc::Sender<u32>) {
    unsafe {
        // MTA so the UIA calls in `uia` work on this thread.
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
    let own_pid = unsafe { GetCurrentProcessId() };
    *lock(last_detected()) = None; // fresh guard per watcher start

    let mut hook = HWINEVENTHOOK::default();
    match mode {
        Mode::Watch => {
            hook = unsafe {
                SetWinEventHook(
                    EVENT_OBJECT_FOCUS,
                    EVENT_OBJECT_FOCUS,
                    HMODULE::default(),
                    Some(win_event_proc),
                    0,
                    0,
                    WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
                )
            };
            if hook.is_invalid() {
                log::warn!("autofill: SetWinEventHook failed; watch mode inactive");
            }
        }
        Mode::Hotkey => {
            let r = unsafe {
                RegisterHotKey(
                    HWND::default(),
                    HOTKEY_ID,
                    MOD_CONTROL | MOD_ALT | MOD_NOREPEAT,
                    u32::from(VK_OEM_5.0),
                )
            };
            if r.is_err() {
                log::warn!("autofill: RegisterHotKey failed; hotkey mode inactive");
            }
        }
    }

    // Hook / hotkey registered → the thread now has a message queue. Publish our
    // id so `stop()` can post WM_QUIT here.
    let _ = tx.send(unsafe { GetCurrentThreadId() });

    let mut msg = MSG::default();
    loop {
        let res = unsafe { GetMessageW(&mut msg, HWND::default(), 0, 0) };
        if res.0 <= 0 {
            break; // 0 = WM_QUIT, -1 = error
        }
        if mode == Mode::Hotkey && msg.message == WM_HOTKEY {
            // Explicit press: offer for the focused field if it's a login one and
            // the app isn't on the denylist.
            if let Some(det) = uia::detect_focused(own_pid, &lock(denylist())) {
                offer(&app, det);
            }
        }
        unsafe {
            let _ = TranslateMessage(&msg);
            DispatchMessageW(&msg);
        }
    }

    // Tear down before the thread ends so a restart installs cleanly.
    unsafe {
        if mode == Mode::Watch && !hook.is_invalid() {
            let _ = UnhookWinEvent(hook);
        }
        if mode == Mode::Hotkey {
            let _ = UnregisterHotKey(HWND::default(), HOTKEY_ID);
        }
    }
    *lock(hook_app()) = None;
}

/// Focus-hook callback (watch mode). Runs on the watcher thread, so it can call
/// UIA directly. `WINEVENT_SKIPOWNPROCESS` already filters our own focus events;
/// `detect_focused` re-checks the pid as a belt-and-braces guard.
unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    _hwnd: HWND,
    _id_object: i32,
    _id_child: i32,
    _thread: u32,
    _time: u32,
) {
    if event != EVENT_OBJECT_FOCUS {
        return;
    }
    let fg = GetForegroundWindow().0 as isize;
    let app = lock(hook_app()).clone();
    if let Some(app) = app {
        on_watch_focus(&app, GetCurrentProcessId(), fg);
    }
}

/// Watch-mode focus handler: run the event through [`watch_decision`] — offer
/// autofill when the focused control is a login field, CLOSE any open autofill
/// popup when focus moved to a non-login control, skip bounce-back refocuses.
fn on_watch_focus(app: &tauri::AppHandle, own_pid: u32, fg: isize) {
    let detected = uia::detect_focused(own_pid, &lock(denylist()));
    let key = detected.as_ref().map(|d| (d.hwnd, d.context.field));
    let action = {
        let mut last = lock(last_detected());
        let (next, action) = watch_decision(*last, fg, key, is_suppressed());
        *last = next;
        action
    };
    match action {
        WatchAction::Offer => {
            if let Some(det) = detected {
                suppress_for(DEBOUNCE.as_millis() as u64);
                super::record_detection(app, det.context, det.hwnd);
            }
        }
        WatchAction::Dismiss => super::dismiss_popup_if_pending(app),
        WatchAction::Skip => {}
    }
}

/// Offer autofill for an explicit hotkey press — always (re-)offers, no re-pop
/// guard check (the user asked), but still claims the guard so the focus event
/// the popup raise causes doesn't double-offer.
fn offer(app: &tauri::AppHandle, det: uia::Detected) {
    if is_suppressed() {
        return;
    }
    *lock(last_detected()) = Some((det.hwnd, det.context.field));
    suppress_for(DEBOUNCE.as_millis() as u64);
    super::record_detection(app, det.context, det.hwnd);
}

#[cfg(test)]
mod tests {
    use super::{watch_decision, WatchAction};
    use crate::dto::AutofillField;

    const PW: AutofillField = AutofillField::Password;
    const USER: AutofillField = AutofillField::Username;

    #[test]
    fn fresh_login_field_offers_and_claims_guard() {
        let (next, action) = watch_decision(None, 7, Some((7, PW)), false);
        assert_eq!(action, WatchAction::Offer);
        assert_eq!(next, Some((7, PW)));
    }

    #[test]
    fn popup_dismiss_bounce_back_to_same_field_is_skipped() {
        let (next, action) = watch_decision(Some((7, PW)), 7, Some((7, PW)), false);
        assert_eq!(action, WatchAction::Skip);
        assert_eq!(next, Some((7, PW)));
    }

    #[test]
    fn focus_to_non_login_control_clears_guard_and_dismisses() {
        // Regression: the guard used to survive within-window focus moves, so after
        // a manual dismiss, re-clicking the password field never offered again until
        // the user switched to a different application window.
        let (next, action) = watch_decision(Some((7, PW)), 7, None, false);
        assert_eq!(action, WatchAction::Dismiss);
        assert_eq!(next, None);
    }

    #[test]
    fn returning_to_the_field_after_focus_left_offers_again() {
        let (cleared, _) = watch_decision(Some((7, PW)), 7, None, false);
        let (next, action) = watch_decision(cleared, 7, Some((7, PW)), false);
        assert_eq!(action, WatchAction::Offer);
        assert_eq!(next, Some((7, PW)));
    }

    #[test]
    fn focus_in_another_window_releases_the_old_guard() {
        let (next, action) = watch_decision(Some((7, PW)), 9, Some((9, PW)), false);
        assert_eq!(action, WatchAction::Offer);
        assert_eq!(next, Some((9, PW)));
    }

    #[test]
    fn username_then_password_in_one_form_each_get_an_offer() {
        let (next, action) = watch_decision(Some((7, USER)), 7, Some((7, PW)), false);
        assert_eq!(action, WatchAction::Offer);
        assert_eq!(next, Some((7, PW)));
    }

    #[test]
    fn suppressed_event_neither_offers_nor_claims_the_guard() {
        let (next, action) = watch_decision(None, 7, Some((7, PW)), true);
        assert_eq!(action, WatchAction::Skip);
        assert_eq!(next, None);
    }
}
