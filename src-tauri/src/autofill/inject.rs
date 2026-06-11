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
//!   We never press Enter — filling is not submitting.
//! - **One-time-code** box → the current TOTP code.
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

use windows::core::HRESULT;
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, UIA_EditControlTypeId,
};
use windows::Win32::UI::Input::KeyboardAndMouse::{
    SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBD_EVENT_FLAGS, KEYBDINPUT, KEYEVENTF_KEYUP,
    KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_TAB,
};
use windows::Win32::UI::WindowsAndMessaging::SetForegroundWindow;

use crate::dto::AutofillField;
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Time for the re-activated window to settle + restore focus before typing.
const FOCUS_SETTLE: Duration = Duration::from_millis(120);

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
    sleep(FOCUS_SETTLE);

    // Re-read the live focused control via UIA to correct a stale detection (COM is
    // needed on this thread; None if the apartment can't be set up — then we trust
    // `detected`). A live password box ALWAYS gets the password.
    let _com = ComApartment::enter();
    let field = unsafe { effective_field(detected, focused_element().as_ref()) };

    match field {
        AutofillField::Password => match values.password {
            Some(pw) => type_unicode(pw),
            None => Ok(()),
        },
        AutofillField::Totp => match values.totp {
            Some(code) => type_unicode(code),
            None => Ok(()),
        },
        AutofillField::Username => {
            let Some(user) = values.username else {
                // No username to type; nothing sensible to do for a username box.
                return Ok(());
            };
            type_unicode(user)?;
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
                            type_unicode(pw)?;
                        }
                    }
                    None => type_unicode(pw)?,
                }
            }
            Ok(())
        }
    }
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

/// Press and release Tab (a virtual-key, not a Unicode char) to move focus from the
/// username field to the password field.
fn press_tab() -> AgateResult<()> {
    send(&[vk_event(VK_TAB, false), vk_event(VK_TAB, true)])
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
