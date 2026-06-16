//! Windows UI Automation detection: is the focused control a login field
//! (password OR username/email), and what app does it belong to?
//!
//! We use the simplest, most robust UIA surface that answers the question:
//! `IUIAutomation::GetFocusedElement` + the `IsPassword` property for secret
//! fields, plus the control type and accessible label for username/email fields.
//! This works through WebView2 / Chromium / Electron (they expose their DOM to
//! UIA), so an Outlook / Microsoft / OAuth sign-in popup's `<input type=password>`
//! or `<input type=email>` is detected exactly like a native edit. The owning
//! window's process name + title come from plain Win32 on the foreground window —
//! never the field's contents. The username rule itself
//! (`matching::classify_field`) is platform-agnostic + unit-tested; this layer
//! only feeds it the UIA-derived control type + labels.
//!
//! ⚠️ Written and (only) `cargo check`-verified on Windows; the live UIA / COM
//! behaviour against real apps must be verified on-device (see CLAUDE.md DoD §3).
//! It runs on the watcher's MTA-initialized thread, so COM is available.

use windows::core::{Interface, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, MAX_PATH};
use windows::Win32::System::Com::{CoCreateInstance, CLSCTX_INPROC_SERVER};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::{
    CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationTreeWalker,
    IUIAutomationValuePattern, UIA_DocumentControlTypeId, UIA_EditControlTypeId, UIA_ValuePatternId,
};
use windows::Win32::UI::WindowsAndMessaging::{
    GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId,
};

use crate::dto::{AutofillContext, AutofillField};

/// A detected login field: the non-secret context to show + match (incl. which
/// kind of field it is), and the top-level window handle to bring forward + fill.
pub struct Detected {
    pub context: AutofillContext,
    pub hwnd: isize,
}

thread_local! {
    /// The UI Automation root, cached per (watcher) thread — focus events fire
    /// often, and re-creating the COM object on each would be wasteful. The COM
    /// object stays in the thread's apartment; the watcher thread is the only
    /// caller, so a thread-local is sound (and IUIAutomation isn't Send).
    static AUTOMATION: std::cell::RefCell<Option<IUIAutomation>> =
        const { std::cell::RefCell::new(None) };
}

/// The cached UI Automation root, created on first use. None if COM creation fails
/// (e.g. the thread wasn't COM-initialized).
fn automation() -> Option<IUIAutomation> {
    AUTOMATION.with(|cell| {
        let mut slot = cell.borrow_mut();
        if slot.is_none() {
            *slot = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok();
        }
        slot.clone()
    })
}

/// Inspect the currently focused UI element. Returns `Some` only when it is a
/// login field — a password (secret) box, or a username/email box — so the
/// watcher offers autofill exactly where a credential belongs.
/// `own_pid` is Agate's process id — a focused field inside our own popup (the
/// app-unlock box is itself `type=password`) is skipped so we never self-trigger.
///
/// Safety: all calls are standard UIA / Win32 on the calling (MTA) thread; handles
/// are closed before returning.
pub fn detect_focused(own_pid: u32, denylist: &[String]) -> Option<Detected> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return None;
        }
        // Skip our own windows (the popup's app-password input is a password field).
        let mut fg_pid = 0u32;
        GetWindowThreadProcessId(foreground, Some(&mut fg_pid as *mut u32));
        if fg_pid == own_pid {
            return None;
        }

        // The user's "never offer here" list — checked against the REAL process
        // (before any browser-suppression below) so a denied browser/app is fully
        // skipped, not just stripped of its process name.
        let raw_process = process_name(foreground);
        if let Some(p) = raw_process.as_deref() {
            if super::matching::is_denied(p, denylist) {
                return None;
            }
        }

        let automation = automation()?;
        let element = automation.GetFocusedElement().ok()?;

        // IsPassword is the authoritative "this is a secret field" signal across
        // native + webview controls (WebView2 / Chromium expose it for
        // `<input type=password>`). For non-secret fields we also offer on a
        // username/email box — an editable control whose accessible label names a
        // user/email/login. The classification rule is the testable
        // `matching::classify_field`; here we just feed it UIA signals. Metadata is
        // read only for non-password fields (never off a secret control).
        let is_password = element.CurrentIsPassword().map(windows::Win32::Foundation::BOOL::as_bool).unwrap_or(false);
        let field = if is_password {
            AutofillField::Password
        } else {
            let is_edit =
                element.CurrentControlType().map(|t| t == UIA_EditControlTypeId).unwrap_or(false);
            let name = bstr(element.CurrentName());
            let automation_id = bstr(element.CurrentAutomationId());
            let help = bstr(element.CurrentHelpText());
            super::matching::classify_field(false, is_edit, &[&name, &automation_id, &help])?
        };

        // Best-effort: the text already in the username/email box, so a
        // "save a new login here" prompt can prefill it. Read ONLY off a
        // non-secret edit — never a password control (the focused secret field
        // itself, or any `IsPassword` node we walk to, is skipped). When the
        // focused field IS the username box, read it directly; when it's the
        // password box, walk its form for a sibling username box.
        let typed_username = match field {
            AutofillField::Username => element_value(&element),
            AutofillField::Password => nearby_username_value(&automation, &element),
            AutofillField::Totp => None,
        };

        let process = raw_process;

        // A browser (or the shared WebView2 runtime) hosts many unrelated sites
        // under ONE process, so its process name (chrome / msedge / msedgewebview2)
        // must NOT drive matching — only the page URL does. Scrape the URL from the
        // focused field's document and suppress the process name. Native apps keep
        // their process (no URL).
        let (process_for_match, url) =
            if process.as_deref().is_some_and(super::matching::is_shared_host_process) {
                (None, document_url(&automation, &element))
            } else {
                (process, None)
            };

        // What "remember this app" stores: the real URL when present (browser), else
        // a synthetic app://<process> association the matcher recognizes (native app).
        let associate_uri = url
            .clone()
            .or_else(|| process_for_match.as_ref().map(|p| format!("{}{p}", super::matching::APP_URI_SCHEME)));

        Some(Detected {
            context: AutofillContext {
                field,
                process_name: process_for_match,
                window_title: window_title(foreground),
                url,
                associate_uri,
                typed_username,
            },
            hwnd: foreground.0 as isize,
        })
    }
}

/// Identify the foreground app / website for the tray match-count badge — WITHOUT
/// requiring a login field. Returns the same matchable context [`detect_focused`]
/// builds (process name for a native app, OR the scraped page URL for a browser,
/// plus the window title), so the badge ranks against the vault exactly as a real
/// detection would. `None` for our own windows, a denied app, no foreground window,
/// or when nothing matchable (no process and no URL) could be read.
///
/// Unlike [`detect_focused`] this reads no field contents — no `IsPassword`
/// inspection, no typed username — only the foreground window's process / title
/// and, for a browser, the focused document's URL. The `field` is irrelevant to
/// the match count (it uses url / process / title only) and stays at its default.
pub fn foreground_context(own_pid: u32, denylist: &[String]) -> Option<AutofillContext> {
    unsafe {
        let foreground = GetForegroundWindow();
        if foreground.0.is_null() {
            return None;
        }
        // Skip our own windows (the popup) so opening it doesn't read as "an app".
        let mut fg_pid = 0u32;
        GetWindowThreadProcessId(foreground, Some(&mut fg_pid as *mut u32));
        if fg_pid == own_pid {
            return None;
        }

        // The user's "never offer here" list, checked against the REAL process.
        let raw_process = process_name(foreground);
        if let Some(p) = raw_process.as_deref() {
            if super::matching::is_denied(p, denylist) {
                return None;
            }
        }

        // A browser (or the shared WebView2 runtime) hosts many sites under one
        // process, so the page URL is the real identity — scrape it from the focused
        // document and suppress the process name. Native apps keep their process.
        let (process_for_match, url) =
            if raw_process.as_deref().is_some_and(super::matching::is_shared_host_process) {
                let url = automation().and_then(|a| {
                    let element = a.GetFocusedElement().ok()?;
                    document_url(&a, &element)
                });
                (None, url)
            } else {
                (raw_process, None)
            };

        // Nothing to rank against (no process, no URL) → no badge.
        if process_for_match.is_none() && url.is_none() {
            return None;
        }

        Some(AutofillContext {
            field: AutofillField::default(),
            process_name: process_for_match,
            window_title: window_title(foreground),
            url,
            associate_uri: None,
            typed_username: None,
        })
    }
}

/// Read a non-secret edit control's current text via its Value pattern (trimmed,
/// None when empty / unavailable). Guards `IsPassword` so a secret value is never
/// read — defence in depth, since callers only pass non-password fields.
unsafe fn element_value(element: &IUIAutomationElement) -> Option<String> {
    if element.CurrentIsPassword().map(windows::Win32::Foundation::BOOL::as_bool).unwrap_or(false) {
        return None;
    }
    let pattern = element.GetCurrentPattern(UIA_ValuePatternId).ok()?;
    let value: IUIAutomationValuePattern = pattern.cast().ok()?;
    let text = value.CurrentValue().ok()?.to_string();
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Best-effort: find the username/email box belonging to the same form as a focused
/// password field and return its typed value. Walks a few ancestors up to a likely
/// form container, then does a bounded depth-first scan of that subtree for the first
/// non-secret edit control whose accessible label classifies as a username (reusing
/// the platform-agnostic [`super::matching::classify_field`]). Never reads a password
/// control. None when no such field is found within the node budget.
///
/// ⚠️ Live UIA tree shape varies per app/toolkit — this is a heuristic that must be
/// verified on-device (CLAUDE.md DoD §3); a miss just means the save prompt isn't
/// pre-seeded with the username, never a wrong fill.
unsafe fn nearby_username_value(
    automation: &IUIAutomation,
    focused: &IUIAutomationElement,
) -> Option<String> {
    let walker: IUIAutomationTreeWalker = automation.ControlViewWalker().ok()?;
    // Climb a few levels so the scan covers the whole form, not just the password
    // field's immediate row. Stop early if we run out of ancestors.
    let mut root = focused.clone();
    for _ in 0..3 {
        match walker.GetParentElement(&root) {
            Ok(parent) => root = parent,
            Err(_) => break,
        }
    }
    // Bounded DFS over the container subtree (node budget guards a huge tree).
    let mut stack = vec![root];
    let mut budget = 200u32;
    while let Some(node) = stack.pop() {
        if budget == 0 {
            break;
        }
        budget -= 1;
        let is_password = node.CurrentIsPassword().map(windows::Win32::Foundation::BOOL::as_bool).unwrap_or(false);
        if !is_password {
            let is_edit =
                node.CurrentControlType().map(|t| t == UIA_EditControlTypeId).unwrap_or(false);
            if is_edit {
                let name = bstr(node.CurrentName());
                let automation_id = bstr(node.CurrentAutomationId());
                let help = bstr(node.CurrentHelpText());
                if matches!(
                    super::matching::classify_field(false, true, &[&name, &automation_id, &help]),
                    Some(AutofillField::Username)
                ) {
                    if let Some(value) = element_value(&node) {
                        return Some(value);
                    }
                }
            }
        }
        // Push every child so the scan is a true DFS over the subtree.
        if let Ok(child) = walker.GetFirstChildElement(&node) {
            let mut sibling = child;
            loop {
                let next = walker.GetNextSiblingElement(&sibling);
                stack.push(sibling);
                match next {
                    Ok(n) => sibling = n,
                    Err(_) => break,
                }
            }
        }
    }
    None
}

/// Read a BSTR-returning UIA property into a plain String (empty on error). Used
/// only for the non-secret accessible label (name / automation-id / help text) of
/// a *non-password* field, to classify it (username / one-time code) — never on a
/// secret. Shared with `inject` (it re-classifies the live focused field at fill).
pub(super) fn bstr(res: windows::core::Result<windows::core::BSTR>) -> String {
    res.map(|b| b.to_string()).unwrap_or_default()
}

/// Best-effort current page URL: walk up from the focused field to the containing
/// Document element and read its Value (Chromium/Firefox expose the page URL there).
/// None if no document is found or it has no value — matching then falls back to the
/// window title. Live UIA behaviour must be verified on-device.
unsafe fn document_url(automation: &IUIAutomation, focused: &IUIAutomationElement) -> Option<String> {
    let walker: IUIAutomationTreeWalker = automation.ControlViewWalker().ok()?;
    let mut current = focused.clone();
    // Bounded walk — the document is a near ancestor; never loop the whole tree.
    for _ in 0..40 {
        if current.CurrentControlType().ok()? == UIA_DocumentControlTypeId {
            let pattern = current.GetCurrentPattern(UIA_ValuePatternId).ok()?;
            let value: IUIAutomationValuePattern = pattern.cast().ok()?;
            let url = value.CurrentValue().ok()?.to_string();
            let url = url.trim();
            return (!url.is_empty()).then(|| url.to_string());
        }
        current = walker.GetParentElement(&current).ok()?;
    }
    None
}

/// The foreground window's title (empty → None).
unsafe fn window_title(hwnd: HWND) -> Option<String> {
    let len = GetWindowTextLengthW(hwnd);
    if len <= 0 {
        return None;
    }
    let mut buf = vec![0u16; len as usize + 1];
    let written = GetWindowTextW(hwnd, &mut buf);
    if written <= 0 {
        return None;
    }
    let title = String::from_utf16_lossy(&buf[..written as usize]);
    (!title.trim().is_empty()).then_some(title)
}

/// The owning process's executable file stem (e.g. "outlook"), lower-cased.
unsafe fn process_name(hwnd: HWND) -> Option<String> {
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid as *mut u32));
    if pid == 0 {
        return None;
    }
    let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
    let mut buf = [0u16; MAX_PATH as usize];
    let mut size = buf.len() as u32;
    let res = QueryFullProcessImageNameW(handle, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut size);
    let _ = CloseHandle(handle);
    if res.is_err() || size == 0 {
        return None;
    }
    let full = String::from_utf16_lossy(&buf[..size as usize]);
    // File stem: drop the directory and the ".exe" extension.
    std::path::Path::new(&full)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(str::to_ascii_lowercase)
}
