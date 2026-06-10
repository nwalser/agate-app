//! Windows Hello passwordless unlock (Windows-only).
//!
//! Uses `UserConsentVerifier` (the biometric/PIN consent gate). We acquire the
//! desktop interop via `windows::core::factory::<UserConsentVerifier,
//! IUserConsentVerifierInterop>()` (NOT `CoCreateInstance`, which fails 0x80040154)
//! and call `RequestVerificationForWindowAsync(hwnd, ..)` parented to the Agate
//! window. The WinRT calls run on a `spawn_blocking` thread initialized MTA so
//! `IAsyncOperation::get()` doesn't deadlock the main STA thread's message pump.
//!
//! Design: Hello is a *consent gate*, not a key-binding (KeyCredentialManager
//! signatures are non-deterministic, so the OS can't derive a stable key from a
//! Hello result). Enabling stores the Vault Master Key in the OS keychain
//! (Credential Manager, which is DPAPI-protected under the logged-in user); a
//! successful Hello check releases it and unlocks every connection via
//! `appunlock::finish_unlock`. Future hardening: an explicit DPAPI entropy wrap on
//! top of the keychain entry.

use tauri::WebviewWindow;
use windows::core::{factory, HSTRING};
use windows::Foundation::IAsyncOperation;
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows::Win32::UI::WindowsAndMessaging::{SetWindowDisplayAffinity, WDA_EXCLUDEFROMCAPTURE};
use zeroize::Zeroizing;

use crate::dto::UnlockOutcome;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

/// Exclude the window from screen capture (screenshots / screen recording /
/// screen-share) on Windows, so decrypted secrets can't be grabbed off-screen.
/// Best-effort: capture shows the window as black where supported.
///
/// Release-only (see the call site in `lib.rs`): with this affinity set, a
/// WebView2 *navigation* crashes the host on Windows 11, and `tauri dev` navigates
/// on every Vite HMR reload — so it's skipped in debug builds, where it would
/// otherwise be dead code.
#[cfg_attr(debug_assertions, allow(dead_code))]
pub fn protect_window(window: &WebviewWindow) {
    if let Ok(hwnd) = window.hwnd() {
        let h = HWND(hwnd.0 as isize as *mut core::ffi::c_void);
        unsafe {
            let _ = SetWindowDisplayAffinity(h, WDA_EXCLUDEFROMCAPTURE);
        }
    }
}

fn co_init() {
    // Idempotent; RPC_E_CHANGED_MODE if the thread was already initialized — fine.
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn check_available_blocking() -> windows::core::Result<bool> {
    co_init();
    let op = UserConsentVerifier::CheckAvailabilityAsync()?;
    Ok(op.get()? == UserConsentVerifierAvailability::Available)
}

/// Whether Windows Hello is configured and usable on this device.
pub async fn available() -> bool {
    tokio::task::spawn_blocking(|| check_available_blocking().unwrap_or(false))
        .await
        .unwrap_or(false)
}

fn verify_blocking(hwnd_isize: isize, message: &str) -> windows::core::Result<bool> {
    co_init();
    let interop: IUserConsentVerifierInterop =
        factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
    let hwnd = HWND(hwnd_isize as *mut core::ffi::c_void);
    let op: IAsyncOperation<UserConsentVerificationResult> =
        unsafe { interop.RequestVerificationForWindowAsync(hwnd, &HSTRING::from(message))? };
    Ok(op.get()? == UserConsentVerificationResult::Verified)
}

/// Enable Hello unlock: store the (unlocked) VMK in the keychain so a later Hello
/// check can release it. Requires the app to be unlocked.
pub async fn enable(state: &AppState) -> AgateResult<()> {
    if !available().await {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Windows Hello is not set up on this device.",
        ));
    }
    let vmk = crate::appunlock::current_vmk(state).await?;
    crate::secrets::store_hello_blob(&*vmk)?;
    state.update_config(|cfg| cfg.hello_configured = true).await
}

/// Unlock every connection after a successful Windows Hello check.
pub async fn unlock_all(state: &AppState, window: &WebviewWindow) -> AgateResult<Vec<UnlockOutcome>> {
    if !state.config.lock().await.hello_configured {
        return Err(AgateError::new(ErrorKind::LocalUnlock, "Windows Hello is not enabled."));
    }
    let hwnd = window.hwnd().map_err(|e| AgateError::internal(format!("window handle: {e}")))?;
    let hwnd_isize = hwnd.0 as isize;

    let ok = tokio::task::spawn_blocking(move || {
        verify_blocking(hwnd_isize, "Unlock Agate").unwrap_or(false)
    })
    .await
    .map_err(|_| AgateError::internal("Hello verification was interrupted."))?;

    if !ok {
        return Err(AgateError::new(
            ErrorKind::LocalUnlock,
            "Windows Hello verification was not approved.",
        ));
    }

    let bytes = crate::secrets::load_hello_blob()?
        .ok_or_else(|| AgateError::new(ErrorKind::LocalUnlock, "Windows Hello data is missing; re-enable it."))?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt Hello key"))?;
    let vmk = Zeroizing::new(arr);
    crate::appunlock::finish_unlock(state, vmk).await
}
