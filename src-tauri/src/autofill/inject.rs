//! Windows credential injection: bring the target window forward and type the
//! login value(s) into its fields — no clipboard, ever.
//!
//! Approach (the classic "auto-type"): `SetForegroundWindow` re-activates the
//! window the field lives in (which restores focus to the control the user last
//! had — the box that triggered detection), then `SendInput` sends the value as
//! Unicode keystrokes. We do NOT touch the clipboard, so a secret is never exposed
//! to clipboard history / other listeners.
//!
//! What gets typed is driven by the field kind, RE-CHECKED against the live focused
//! control at fill time (a stale detection must never type a username into a
//! password box — see `effective_field`):
//! - **Password** box → the password.
//! - **Username** box → the username, then **Tab**, then the password (best-effort
//!   both-field fill; tab order is the near-universal username→password sequence).
//! - **One-time-code** box → the current TOTP code.
//!
//! Each value REPLACES the field's existing content: we send **Ctrl+A** (select all)
//! right before typing, so a half-typed username/password is overwritten, not appended
//! to. Select-all is only ever sent immediately before a stored value is typed — a
//! field we have no value for is left untouched (never cleared to empty).
//!
//! After the value(s) land, we press **Enter** to submit ONLY when the user has
//! opted in (`FillValues.submit`) — off by default, since some forms break on a
//! premature submit. Submitting also drives multi-step (username-page → password-
//! page) flows: the username page advances and the watcher re-offers on the next
//! password field.
//!
//! We **verify the username after typing** (read its value back via UIA
//! `ValuePattern`) and retry the keystrokes once on a mismatch — this catches the
//! "focus wasn't really in the field" silent no-fill. A password is NOT verified:
//! a masked field reports an empty/placeholder value, so a read-back can't tell
//! "didn't land" from "masked".
//!
//! Window-settle timing is ADAPTIVE: we poll for the focused element up to
//! [`MAX_FOCUS_SETTLE`] instead of sleeping a fixed time, so a fast app proceeds at
//! once and a slow one still gets a real chance to paint + restore focus.
//!
//! ⚠️ Hard limits, surfaced not swallowed:
//! - **UIPI**: a non-elevated Agate cannot send input to an elevated (admin)
//!   window — `SendInput` inserts nothing. We detect the short write and return a
//!   typed error rather than silently "succeeding".
//!
//! ⚠️ Written and (only) `cargo check`-verified on Windows; the live SendInput /
//! focus / UIA behaviour against real apps must be verified on-device (CLAUDE.md
//! DoD §3).

use std::ffi::c_void;
use std::thread::sleep;
use std::time::Duration;

use windows::core::{Interface, HRESULT};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationValuePattern,
    UIA_EditControlTypeId, UIA_ValuePatternId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_A, VK_CONTROL, VK_RETURN, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

use crate::dto::AutofillField;
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Max time to wait for the re-activated window to settle + restore focus before
/// typing. We poll for the focused element rather than sleeping a fixed time, so a
/// fast app proceeds immediately and a slow one still gets a real chance to settle.
const MAX_FOCUS_SETTLE: Duration = Duration::from_millis(600);

/// Poll interval while waiting for the focused element to appear.
const SETTLE_POLL: Duration = Duration::from_millis(20);

/// Pause between fields in the username→Tab→password sequence, so the target form's
/// per-field JS (validation, focus handlers) keeps up with the synthesized input.
const INTER_FIELD: Duration = Duration::from_millis(40);

/// The values available to fill for the chosen login — all optional and borrowed
/// from the caller's zeroized storage. `username` is not secret; `password` and
/// `totp` are (the caller holds them in `Zeroizing`).
pub struct FillValues<'a> {
    pub username: Option<&'a str>,
    pub password: Option<&'a str>,
    pub totp: Option<&'a str>,
    /// Press Enter after the final value to submit the form (user opt-in).
    pub submit: bool,
}

/// Bring `hwnd` to the foreground and type the value(s) for the detected field into
/// it. `detected` is the field kind from the popup's detection; it's re-checked
/// against the live focused control here so a stale detection can't type the wrong
/// value. Runs on a blocking thread (it sleeps + does COM); never on the async runtime.
pub fn fill(hwnd: isize, detected: AutofillField, values: &FillValues) -> AgateResult<()> {
    let target = HWND(hwnd as *mut c_void);

    // Re-activate the target. Our process owns the foreground (the popup was just
    // focused), so this is permitted; a failure means the window vanished.
    let activated = unsafe { SetForegroundWindow(target) };
    if !activated.as_bool() {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Couldn't focus the target window to autofill — it may have closed.",
        ));
    }

    // Re-read the live focused control via UIA to correct a stale detection (COM is
    // needed on this thread; None if the apartment can't be set up — then we trust
    // `detected`). We poll for the focused element (adaptive settle) rather than
    // sleeping a fixed time. A live password box ALWAYS gets the password.
    let _com = ComApartment::enter();
    let focused = unsafe { wait_for_focused_element() };
    let field = unsafe { effective_field(detected, focused.as_ref()) };

    // Whether the credential's terminal value was typed — gates the optional submit.
    let typed = match field {
        AutofillField::Password => match values.password {
            Some(pw) => {
                type_replacing(pw)?;
                true
            }
            None => false,
        },
        AutofillField::Totp => match values.totp {
            Some(code) => {
                type_replacing(code)?;
                true
            }
            None => false,
        },
        AutofillField::Username => {
            let Some(user) = values.username else {
                // No username to type; nothing sensible to do for a username box.
                return Ok(());
            };
            // Type the username and verify it landed (retry once on mismatch).
            type_and_verify(user, focused.as_ref())?;
            // Best-effort: tab to the password field and fill it too.
            if let Some(pw) = values.password {
                sleep(INTER_FIELD);
                press_tab()?;
                sleep(INTER_FIELD);
                // Only type the password if Tab actually landed on a password box.
                // This guards the Microsoft-style "username first" page (Tab → a
                // "Next" button, not a password field) and forms with a control
                // between the two fields. When UIA gives us no view of the focus
                // (no element at all), fall back to best-effort typing.
                match unsafe { focused_element() } {
                    Some(el) => {
                        let is_pw =
                            unsafe { el.CurrentIsPassword() }.map(|b| b.as_bool()).unwrap_or(false);
                        if is_pw {
                            type_replacing(pw)?;
                        }
                    }
                    None => type_replacing(pw)?,
                }
            }
            // Even a username-only fill (no stored password) counts as typed, so an
            // opted-in submit advances a username-first page to its password step.
            true
        }
    };

    if values.submit && typed {
        sleep(INTER_FIELD);
        press_enter()?;
    }
    Ok(())
}

/// Poll for the focused UI element up to [`MAX_FOCUS_SETTLE`], returning as soon as
/// one is available. Replaces a fixed settle sleep: a snappy app proceeds in one
/// poll, a slow one gets the full budget to paint + restore focus. None if UIA is
/// unavailable or nothing focuses within the budget.
unsafe fn wait_for_focused_element() -> Option<IUIAutomationElement> {
    let deadline = std::time::Instant::now() + MAX_FOCUS_SETTLE;
    loop {
        if let Some(el) = focused_element() {
            return Some(el);
        }
        if std::time::Instant::now() >= deadline {
            return None;
        }
        sleep(SETTLE_POLL);
    }
}

/// Type a non-secret value (REPLACING any existing content) and confirm it landed by
/// reading the control's value back via UIA `ValuePattern`; on a readable mismatch,
/// replace once more. This catches the "focus wasn't really in the field" silent
/// no-fill. Used only for the username — a masked password field reports no readable
/// value, so it is never verified (a read-back can't tell "didn't land" from
/// "masked"). Best-effort: if the control exposes no ValuePattern we trust the first
/// type. The retry is safe because `type_replacing` overwrites — it never appends to
/// whatever the field already held.
fn type_and_verify(text: &str, focused: Option<&IUIAutomationElement>) -> AgateResult<()> {
    type_replacing(text)?;
    let Some(el) = focused else { return Ok(()) };
    match unsafe { read_value(el) } {
        Some(v) if v == text => Ok(()),    // landed
        Some(_) => type_replacing(text),   // wrong / empty → replace once more
        None => Ok(()),                    // unreadable → trust the first type
    }
}

/// Read a control's value via UIA `ValuePattern`, or None when it exposes none.
unsafe fn read_value(el: &IUIAutomationElement) -> Option<String> {
    let pattern = el.GetCurrentPattern(UIA_ValuePatternId).ok()?;
    let value: IUIAutomationValuePattern = pattern.cast().ok()?;
    Some(value.CurrentValue().ok()?.to_string())
}

/// Re-classify the live focused control so a detection that has gone stale (the
/// user moved focus while the popup was up) can't type the wrong value:
/// - a live password box → [`AutofillField::Password`] (never type a username here);
/// - else its accessible label decides username vs one-time code (same rule as
///   detection, [`crate::autofill::matching::classify_field`]);
/// - if there's no focused element or it doesn't classify, trust `detected`.
unsafe fn effective_field(
    detected: AutofillField,
    focused: Option<&IUIAutomationElement>,
) -> AutofillField {
    let Some(el) = focused else {
        return detected;
    };
    if el.CurrentIsPassword().map(|b| b.as_bool()).unwrap_or(false) {
        return AutofillField::Password;
    }
    let is_edit = el.CurrentControlType().map(|t| t == UIA_EditControlTypeId).unwrap_or(false);
    let name = super::uia::bstr(el.CurrentName());
    let automation_id = super::uia::bstr(el.CurrentAutomationId());
    let help = super::uia::bstr(el.CurrentHelpText());
    super::matching::classify_field(false, is_edit, &[&name, &automation_id, &help])
        .unwrap_or(detected)
}

/// The currently focused UI element via a fresh UIA root, or None if UIA is
/// unavailable on this thread (no COM apartment) or nothing is focused.
unsafe fn focused_element() -> Option<IUIAutomationElement> {
    let automation: IUIAutomation =
        CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER).ok()?;
    automation.GetFocusedElement().ok()
}

/// RAII MTA COM apartment for the injection thread, balanced on drop. `entered`
/// tracks whether WE initialized it (so we don't `CoUninitialize` a thread that was
/// already STA — `RPC_E_CHANGED_MODE` — where we simply skip UIA).
struct ComApartment {
    entered: bool,
}

impl ComApartment {
    fn enter() -> Self {
        // `S_OK` and `S_FALSE` (already initialized) are both successes we must
        // balance with `CoUninitialize`; `RPC_E_CHANGED_MODE` means a different
        // apartment is already set on this thread — we didn't enter, so don't leave.
        let hr: HRESULT = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        ComApartment { entered: hr.is_ok() }
    }
}

impl Drop for ComApartment {
    fn drop(&mut self) {
        if self.entered {
            unsafe { CoUninitialize() };
        }
    }
}

/// Send a string as a sequence of Unicode key-down / key-up events to the focused
/// control. Returns a typed error if the OS rejected the input (UIPI / elevated
/// target), so the caller can tell the user instead of pretending it worked.
fn type_unicode(text: &str) -> AgateResult<()> {
    // Two INPUTs (down + up) per UTF-16 code unit. Surrogate pairs send as two
    // units, which Windows reassembles.
    let mut inputs: Vec<INPUT> = Vec::with_capacity(text.encode_utf16().count() * 2);
    for unit in text.encode_utf16() {
        inputs.push(unicode_event(unit, false));
        inputs.push(unicode_event(unit, true));
    }
    if inputs.is_empty() {
        return Ok(());
    }
    send(&inputs)
}

/// Type `text` so it REPLACES the focused field's content: select-all first, then
/// type — a half-typed value is overwritten, never appended. Harmless on an empty
/// field (select-all selects nothing). Only ever called with a real stored value, so
/// a field is never cleared and left empty.
fn type_replacing(text: &str) -> AgateResult<()> {
    select_all()?;
    type_unicode(text)
}

/// Select all of the focused control's text (Ctrl+A) so the value typed next replaces
/// it. Ctrl is held down across the 'A' press — 'A' is sent as a virtual key (not a
/// Unicode event, which would ignore the held modifier).
fn select_all() -> AgateResult<()> {
    send(&[
        vk_event(VK_CONTROL, false),
        vk_event(VK_A, false),
        vk_event(VK_A, true),
        vk_event(VK_CONTROL, true),
    ])
}

/// Press and release Tab (a virtual-key, not a Unicode char) to move focus from the
/// username field to the password field.
fn press_tab() -> AgateResult<()> {
    send(&[vk_event(VK_TAB, false), vk_event(VK_TAB, true)])
}

/// Press and release Enter to submit the form (only when the user opted into
/// submit-after-fill).
fn press_enter() -> AgateResult<()> {
    send(&[vk_event(VK_RETURN, false), vk_event(VK_RETURN, true)])
}

/// Submit a batch of synthesized inputs; a short write means the OS blocked us
/// (UIPI / elevated target).
fn send(inputs: &[INPUT]) -> AgateResult<()> {
    let sent = unsafe { SendInput(inputs, std::mem::size_of::<INPUT>() as i32) };
    if sent as usize != inputs.len() {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Windows blocked autofill keystrokes — the target app may be running as administrator.",
        ));
    }
    Ok(())
}

/// One Unicode keyboard event (key-down, or key-up when `up`).
fn unicode_event(scan: u16, up: bool) -> INPUT {
    let mut flags = KEYEVENTF_UNICODE;
    if up {
        flags |= KEYEVENTF_KEYUP;
    }
    keyboard_input(VIRTUAL_KEY(0), scan, flags)
}

/// One virtual-key keyboard event (key-down, or key-up when `up`).
fn vk_event(vk: VIRTUAL_KEY, up: bool) -> INPUT {
    let flags = if up { KEYEVENTF_KEYUP } else { KEYBD_EVENT_FLAGS(0) };
    keyboard_input(vk, 0, flags)
}

fn keyboard_input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 },
        },
    }
}
