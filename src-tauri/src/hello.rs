//! Windows Hello passwordless unlock (Windows-only).
//!
//! Uses `UserConsentVerifier` (the biometric/PIN consent gate). We acquire the
//! desktop interop via `windows::core::factory::<UserConsentVerifier,
//! IUserConsentVerifierInterop>()` (NOT `CoCreateInstance`, which fails 0x80040154)
//! and call `RequestVerificationForWindowAsync(hwnd, ..)` parented to the Agate
//! window. The WinRT calls run on a `spawn_blocking` thread initialized MTA so
//! `IAsyncOperation::get()` doesn't deadlock the main STA thread's message pump.
//!
//! Design (consistent with `unlock.rs`): Hello is an in-process authorization
//! gate. On a successful Hello check we reactivate the soft-locked SDK client.
//! The OS does not cryptographically bind anything to the Hello result here, and
//! (like local-password unlock) the held client does not survive a process
//! restart at this SDK revision — the master password remains the fallback.

use tauri::WebviewWindow;
use windows::core::{factory, HSTRING};
use windows::Foundation::IAsyncOperation;
use windows::Security::Credentials::UI::{
    UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;

use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

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

/// Enable Hello unlock for the active (unlocked) account.
pub async fn enable(state: &AppState) -> AgateResult<()> {
    if !available().await {
        return Err(AgateError::new(
            ErrorKind::Internal,
            "Windows Hello is not set up on this device.",
        ));
    }
    {
        let session = state.session.lock().await;
        let client = session.client.as_ref().ok_or_else(AgateError::not_authenticated)?;
        if !client.is_unlocked() {
            return Err(AgateError::locked());
        }
    }
    state.config.lock().await.hello_configured = true;
    state.save_config().await
}

/// Unlock the soft-locked vault after a successful Windows Hello check.
pub async fn unlock(state: &AppState, window: &WebviewWindow) -> AgateResult<()> {
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

    let mut session = state.session.lock().await;
    match session.locked_client.take() {
        Some(client) => {
            session.client = Some(client);
            Ok(())
        }
        None => Err(AgateError::new(
            ErrorKind::LocalUnlock,
            "This session expired (the app was restarted). Unlock with your master password.",
        )),
    }
}
