//! Windows 11 (24H2+) WebAuthn **plugin-authenticator** COM server, in Rust.
//!
//! This makes Agate a system passkey provider with no browser extension: a
//! browser's `navigator.credentials.create()/get()` → Windows WebAuthn layer →
//! this COM server → the provider-agnostic ceremony in [`super::host`].
//!
//! ## Status — read this
//! Built against Microsoft's PUBLIC headers (`microsoft/webauthn`:
//! `pluginauthenticator.idl/.h`, `webauthnplugin.h`): the `IPluginAuthenticator`
//! IID, the method order, and the `WEBAUTHN_PLUGIN_*` struct layouts are
//! transcribed from there. It type-checks (`cargo check --features
//! win-plugin-authenticator`), but it is **NOT verified on a real machine** and
//! several things must still happen before it works:
//! - **MSIX packaging** — the OS only activates the COM server when its CLSID is
//!   registered through an MSIX manifest that declares Agate a passkey provider.
//!   Tauri ships NSIS/MSI, so this is a separate packaging step (or a small
//!   MSIX-packaged helper that hosts this server).
//! - **The plugin API is still `EXPERIMENTAL_*`** in current SDKs and finalizing;
//!   `webauthn.dll`'s exports + the struct details may shift — re-check against
//!   the SDK you build with.
//! - **Request-signature verification is a TODO** — the OS signs each request
//!   with the key paired to `pbOpSignPubKey` returned at registration; a real
//!   provider MUST verify `pbRequestSignature` before acting. Marked below.
//! - It links `webauthn.dll`; `cargo check` doesn't link, so a real **build**
//!   needs the 24H2 SDK import lib with these (experimental) exports.
//!
//! The ceremony itself (mint/sign) is the already-tested [`super::host`] +
//! [`super::authenticator`]; this module is only the OS-facing COM shell + the
//! seam ([`PluginCeremonyHost`]) the tray implements to resolve the unlocked
//! connection, show the destination chooser, and supply the Windows Hello UV.

#![allow(non_snake_case)] // mirror the Win32 struct/field names verbatim.

use std::sync::Arc;

use windows::core::{
    implement, interface, w, IUnknown, IUnknown_Vtbl, Interface, GUID, HRESULT, PCSTR, PCWSTR,
};
use windows::Win32::Foundation::{
    BOOL, CLASS_E_NOAGGREGATION, E_INVALIDARG, E_NOTIMPL, E_POINTER, S_OK,
};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::Com::{
    CoRegisterClassObject, CoRevokeClassObject, CoTaskMemAlloc, IClassFactory, IClassFactory_Impl,
    CLSCTX_LOCAL_SERVER, REGCLS_MULTIPLEUSE,
};
use windows::Win32::System::LibraryLoader::{GetProcAddress, LoadLibraryW};

use crate::error::AgateResult;

/// Agate's plugin-authenticator CLSID (also the value to put in the MSIX
/// manifest + pass to `WebAuthNPluginAddAuthenticator`). Stable for the install.
pub const AGATE_PLUGIN_CLSID: GUID = GUID::from_u128(0x6b9d2f10_3a7e_4c81_9a2d_1f0c5e7b4a22);

// ── ABI: transcribed from microsoft/webauthn headers ─────────────────────────

/// `WEBAUTHN_PLUGIN_REQUEST_TYPE` — only CTAP2 CBOR is defined.
const WEBAUTHN_PLUGIN_REQUEST_TYPE_CTAP2_CBOR: i32 = 0x1;

/// `PLUGIN_LOCK_STATUS`.
const PLUGIN_LOCKED: i32 = 0;
const PLUGIN_UNLOCKED: i32 = 1;

#[repr(C)]
pub struct WEBAUTHN_PLUGIN_OPERATION_REQUEST {
    pub hWnd: HWND,
    pub transactionId: GUID,
    pub cbRequestSignature: u32,
    pub pbRequestSignature: *const u8,
    pub requestType: i32,
    pub cbEncodedRequest: u32,
    /// CTAP2 request, CBOR-encoded — what [`super::host`] decodes.
    pub pbEncodedRequest: *const u8,
}

#[repr(C)]
pub struct WEBAUTHN_PLUGIN_OPERATION_RESPONSE {
    pub cbEncodedResponse: u32,
    /// CTAP2 response, CBOR-encoded. Allocated with `CoTaskMemAlloc`; the OS
    /// takes ownership and frees it.
    pub pbEncodedResponse: *mut u8,
}

#[repr(C)]
pub struct WEBAUTHN_PLUGIN_CANCEL_OPERATION_REQUEST {
    pub transactionId: GUID,
    pub cbRequestSignature: u32,
    pub pbRequestSignature: *const u8,
}

#[repr(C)]
pub struct WEBAUTHN_PLUGIN_ADD_AUTHENTICATOR_OPTIONS {
    pub pwszAuthenticatorName: PCWSTR,
    /// `REFCLSID` in the header (a `const GUID*`).
    pub rclsid: *const GUID,
    pub pwszPluginRpId: PCWSTR,
    pub pwszLightThemeLogoSvg: PCWSTR,
    pub pwszDarkThemeLogoSvg: PCWSTR,
    /// CTAP2 `authenticatorGetInfo` response (CBOR). TODO: build this from the
    /// authenticator's real capabilities before registering for real.
    pub cbAuthenticatorInfo: u32,
    pub pbAuthenticatorInfo: *const u8,
    pub cSupportedRpIds: u32,
    pub ppwszSupportedRpIds: *const PCWSTR,
}

#[repr(C)]
pub struct WEBAUTHN_PLUGIN_ADD_AUTHENTICATOR_RESPONSE {
    /// The public key whose private half the OS uses to sign each operation
    /// request — store it and verify `pbRequestSignature` against it.
    pub cbOpSignPubKey: u32,
    pub pbOpSignPubKey: *mut u8,
}

// `webauthn.dll`'s plugin exports are still `EXPERIMENTAL_*` and present only on
// recent Windows builds, so they are resolved at RUNTIME rather than statically
// imported. A static `#[link]` import would make the whole module fail to load
// on a machine without the exports (and won't even link against an SDK whose
// `webauthn.lib` lacks them); runtime resolution lets `register` fail with a
// clear, recoverable error instead.
type WebAuthNPluginAddAuthenticatorFn = unsafe extern "system" fn(
    *const WEBAUTHN_PLUGIN_ADD_AUTHENTICATOR_OPTIONS,
    *mut *mut WEBAUTHN_PLUGIN_ADD_AUTHENTICATOR_RESPONSE,
) -> HRESULT;
type WebAuthNPluginRemoveAuthenticatorFn = unsafe extern "system" fn(*const GUID) -> HRESULT;

/// Resolve a `webauthn.dll` export by null-terminated name, or `None` when this
/// Windows build doesn't expose it.
unsafe fn webauthn_export(name: PCSTR) -> Option<unsafe extern "system" fn() -> isize> {
    let module = LoadLibraryW(w!("webauthn.dll")).ok()?;
    GetProcAddress(module, name)
}

// ── COM interface: IPluginAuthenticator ──────────────────────────────────────

/// `IPluginAuthenticator` — IID + method order from `pluginauthenticator.idl`.
#[interface("d26bcf6f-b54c-43ff-9f06-d5bf148625f7")]
unsafe trait IPluginAuthenticator: IUnknown {
    unsafe fn MakeCredential(
        &self,
        request: *const WEBAUTHN_PLUGIN_OPERATION_REQUEST,
        response: *mut *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE,
    ) -> HRESULT;
    unsafe fn GetAssertion(
        &self,
        request: *const WEBAUTHN_PLUGIN_OPERATION_REQUEST,
        response: *mut *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE,
    ) -> HRESULT;
    unsafe fn CancelOperation(
        &self,
        request: *const WEBAUTHN_PLUGIN_CANCEL_OPERATION_REQUEST,
    ) -> HRESULT;
    unsafe fn GetLockStatus(&self, lockStatus: *mut i32) -> HRESULT;
}

// ── The tray-side seam ────────────────────────────────────────────────────────

/// What the COM server needs from the tray to run a ceremony. The tray's
/// implementation resolves the unlocked connection + destination (the popup
/// chooser: which vault / item / folder), supplies the Windows Hello
/// [`UserValidationMethod`](passkey_authenticator::UserValidationMethod), and
/// runs [`super::host::make_credential_cbor`] / `get_assertion_cbor` (via
/// `block_in_place` + `block_on`, snapshotting out of the session lock — see the
/// note in [`super::ipc`]). It is given the raw CBOR CTAP2 request and returns
/// the raw CBOR CTAP2 response.
pub trait PluginCeremonyHost: Send + Sync {
    fn make_credential(&self, request_cbor: &[u8]) -> AgateResult<Vec<u8>>;
    fn get_assertion(&self, request_cbor: &[u8]) -> AgateResult<Vec<u8>>;
    /// Whether the vault is currently unlocked (drives `GetLockStatus`).
    fn is_unlocked(&self) -> bool;
}

#[derive(Clone, Copy)]
enum Op {
    Make,
    Get,
}

// ── COM object ────────────────────────────────────────────────────────────────

#[implement(IPluginAuthenticator)]
struct AgatePluginAuthenticator {
    host: Arc<dyn PluginCeremonyHost>,
}

impl AgatePluginAuthenticator {
    /// Shared body for make/get: read the CBOR request, run the ceremony via the
    /// host seam, and hand back a `CoTaskMemAlloc`'d CBOR response the OS frees.
    ///
    /// SAFETY: `request`/`response` are the COM out-params; validated for null
    /// before use. The returned buffer is allocated with `CoTaskMemAlloc` per the
    /// COM contract (the OS owns + frees it).
    unsafe fn run(
        &self,
        op: Op,
        request: *const WEBAUTHN_PLUGIN_OPERATION_REQUEST,
        response: *mut *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE,
    ) -> HRESULT {
        if request.is_null() || response.is_null() {
            return E_POINTER;
        }
        let req = &*request;
        if req.requestType != WEBAUTHN_PLUGIN_REQUEST_TYPE_CTAP2_CBOR {
            return E_INVALIDARG;
        }
        // TODO(security): verify `req.pbRequestSignature` against the public key
        // returned by WebAuthNPluginAddAuthenticator before acting on the request.

        let request_cbor: &[u8] = if req.cbEncodedRequest == 0 || req.pbEncodedRequest.is_null() {
            &[]
        } else {
            std::slice::from_raw_parts(req.pbEncodedRequest, req.cbEncodedRequest as usize)
        };

        let result = match op {
            Op::Make => self.host.make_credential(request_cbor),
            Op::Get => self.host.get_assertion(request_cbor),
        };
        let response_cbor = match result {
            Ok(bytes) => bytes,
            Err(e) => {
                log::warn!("passkey plugin ceremony failed: {e}");
                // CTAP/HRESULT mapping is refined once the failure taxonomy is
                // exercised on a real machine; a generic failure is correct here.
                return E_INVALIDARG;
            }
        };

        match alloc_response(&response_cbor) {
            Some(ptr) => {
                *response = ptr;
                S_OK
            }
            None => E_POINTER, // allocation failed
        }
    }
}

impl IPluginAuthenticator_Impl for AgatePluginAuthenticator_Impl {
    unsafe fn MakeCredential(
        &self,
        request: *const WEBAUTHN_PLUGIN_OPERATION_REQUEST,
        response: *mut *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE,
    ) -> HRESULT {
        self.run(Op::Make, request, response)
    }

    unsafe fn GetAssertion(
        &self,
        request: *const WEBAUTHN_PLUGIN_OPERATION_REQUEST,
        response: *mut *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE,
    ) -> HRESULT {
        self.run(Op::Get, request, response)
    }

    unsafe fn CancelOperation(
        &self,
        _request: *const WEBAUTHN_PLUGIN_CANCEL_OPERATION_REQUEST,
    ) -> HRESULT {
        // Agate ceremonies are synchronous from the OS's perspective (no
        // long-lived pending op held across calls), so there's nothing to cancel.
        S_OK
    }

    unsafe fn GetLockStatus(&self, lockStatus: *mut i32) -> HRESULT {
        if lockStatus.is_null() {
            return E_POINTER;
        }
        *lockStatus = if self.host.is_unlocked() { PLUGIN_UNLOCKED } else { PLUGIN_LOCKED };
        S_OK
    }
}

/// `CoTaskMemAlloc` a `WEBAUTHN_PLUGIN_OPERATION_RESPONSE` + its CBOR buffer,
/// copy `cbor` in, and return the response pointer (or `None` on alloc failure).
unsafe fn alloc_response(cbor: &[u8]) -> Option<*mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE> {
    let buf = CoTaskMemAlloc(cbor.len()) as *mut u8;
    if buf.is_null() {
        return None;
    }
    std::ptr::copy_nonoverlapping(cbor.as_ptr(), buf, cbor.len());

    let resp =
        CoTaskMemAlloc(std::mem::size_of::<WEBAUTHN_PLUGIN_OPERATION_RESPONSE>())
            as *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE;
    if resp.is_null() {
        windows::Win32::System::Com::CoTaskMemFree(Some(buf as *const _));
        return None;
    }
    (*resp).cbEncodedResponse = cbor.len() as u32;
    (*resp).pbEncodedResponse = buf;
    Some(resp)
}

// ── Class factory ─────────────────────────────────────────────────────────────

#[implement(IClassFactory)]
struct PluginClassFactory {
    host: Arc<dyn PluginCeremonyHost>,
}

impl IClassFactory_Impl for PluginClassFactory_Impl {
    fn CreateInstance(
        &self,
        outer: Option<&IUnknown>,
        iid: *const GUID,
        object: *mut *mut core::ffi::c_void,
    ) -> windows::core::Result<()> {
        if outer.is_some() {
            return Err(CLASS_E_NOAGGREGATION.into());
        }
        let authenticator: IPluginAuthenticator =
            AgatePluginAuthenticator { host: self.host.clone() }.into();
        unsafe { authenticator.query(iid, object).ok() }
    }

    fn LockServer(&self, _lock: BOOL) -> windows::core::Result<()> {
        Ok(())
    }
}

// ── Registration ──────────────────────────────────────────────────────────────

/// Registers the class object with COM and adds Agate as a plugin authenticator.
/// Call once on startup of the (MSIX-packaged) process that hosts this server.
///
/// Returns the COM registration cookie (pass it to [`unregister`]). The
/// `authenticator_info` is the CTAP2 `authenticatorGetInfo` CBOR — TODO: produce
/// it from the real capabilities; an empty slice is a placeholder.
pub fn register(
    host: Arc<dyn PluginCeremonyHost>,
    authenticator_name: PCWSTR,
    plugin_rp_id: PCWSTR,
    authenticator_info: &[u8],
) -> windows::core::Result<u32> {
    let factory: IClassFactory = PluginClassFactory { host }.into();
    let cookie = unsafe {
        CoRegisterClassObject(
            &AGATE_PLUGIN_CLSID,
            &factory,
            CLSCTX_LOCAL_SERVER,
            REGCLS_MULTIPLEUSE,
        )?
    };

    let options = WEBAUTHN_PLUGIN_ADD_AUTHENTICATOR_OPTIONS {
        pwszAuthenticatorName: authenticator_name,
        rclsid: &AGATE_PLUGIN_CLSID,
        pwszPluginRpId: plugin_rp_id,
        pwszLightThemeLogoSvg: PCWSTR::null(),
        pwszDarkThemeLogoSvg: PCWSTR::null(),
        cbAuthenticatorInfo: authenticator_info.len() as u32,
        pbAuthenticatorInfo: authenticator_info.as_ptr(),
        cSupportedRpIds: 0,
        ppwszSupportedRpIds: std::ptr::null(),
    };
    // Resolve the export at runtime; a typed error when the OS lacks it.
    let add_raw = unsafe { webauthn_export(PCSTR(c"WebAuthNPluginAddAuthenticator".as_ptr().cast())) }
        .ok_or_else(|| {
            windows::core::Error::new(
                E_NOTIMPL,
                "WebAuthNPluginAddAuthenticator is unavailable on this Windows build \
                 (the plugin-authenticator API is still EXPERIMENTAL)",
            )
        })?;
    let add: WebAuthNPluginAddAuthenticatorFn = unsafe { std::mem::transmute(add_raw) };

    let mut response: *mut WEBAUTHN_PLUGIN_ADD_AUTHENTICATOR_RESPONSE = std::ptr::null_mut();
    // SAFETY: FFI into webauthn.dll; `options` outlives the call, `response` is a
    // valid out-pointer. TODO: capture response.pbOpSignPubKey to verify request
    // signatures, and free the response per the API's ownership rules.
    unsafe { add(&options, &mut response).ok()? };
    Ok(cookie)
}

/// Reverses [`register`]: removes the authenticator (best-effort — skipped if the
/// export is unavailable) and revokes the class object.
pub fn unregister(cookie: u32) -> windows::core::Result<()> {
    // SAFETY: FFI; CLSID is 'static, cookie came from CoRegisterClassObject.
    unsafe {
        if let Some(remove_raw) =
            webauthn_export(PCSTR(c"WebAuthNPluginRemoveAuthenticator".as_ptr().cast()))
        {
            let remove: WebAuthNPluginRemoveAuthenticatorFn = std::mem::transmute(remove_raw);
            remove(&AGATE_PLUGIN_CLSID).ok()?;
        }
        CoRevokeClassObject(cookie)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows::Win32::System::Com::CoTaskMemFree;

    /// Stand-in for the tray: echoes the request so the COM glue can be asserted
    /// without the OS WebAuthn layer or a real ceremony.
    struct FakeHost;
    impl PluginCeremonyHost for FakeHost {
        fn make_credential(&self, request_cbor: &[u8]) -> AgateResult<Vec<u8>> {
            let mut out = b"made:".to_vec();
            out.extend_from_slice(request_cbor);
            Ok(out)
        }
        fn get_assertion(&self, _request_cbor: &[u8]) -> AgateResult<Vec<u8>> {
            Ok(b"asserted".to_vec())
        }
        fn is_unlocked(&self) -> bool {
            true
        }
    }

    fn authenticator() -> IPluginAuthenticator {
        AgatePluginAuthenticator { host: Arc::new(FakeHost) }.into()
    }

    fn request(req_type: i32, cbor: &[u8]) -> WEBAUTHN_PLUGIN_OPERATION_REQUEST {
        WEBAUTHN_PLUGIN_OPERATION_REQUEST {
            hWnd: HWND::default(),
            transactionId: GUID::from_u128(0),
            cbRequestSignature: 0,
            pbRequestSignature: std::ptr::null(),
            requestType: req_type,
            cbEncodedRequest: cbor.len() as u32,
            pbEncodedRequest: cbor.as_ptr(),
        }
    }

    /// The full COM path — vtable dispatch → our impl → host → a
    /// `CoTaskMemAlloc`'d response — exercised in-process.
    #[test]
    fn make_credential_runs_the_host_and_allocates_a_response() {
        let auth = authenticator();
        let cbor = [0x01u8, 0x02, 0x03];
        let req = request(WEBAUTHN_PLUGIN_REQUEST_TYPE_CTAP2_CBOR, &cbor);
        let mut response: *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE = std::ptr::null_mut();

        let hr = unsafe { auth.MakeCredential(&req, &mut response) };

        assert!(hr.is_ok(), "hr = {hr:?}");
        assert!(!response.is_null());
        unsafe {
            let resp = &*response;
            let bytes =
                std::slice::from_raw_parts(resp.pbEncodedResponse, resp.cbEncodedResponse as usize);
            assert_eq!(bytes, b"made:\x01\x02\x03");
            CoTaskMemFree(Some(resp.pbEncodedResponse as *const core::ffi::c_void));
            CoTaskMemFree(Some(response as *const core::ffi::c_void));
        }
    }

    #[test]
    fn rejects_non_ctap2_request_type() {
        let auth = authenticator();
        let req = request(0x99, &[1, 2, 3]);
        let mut response: *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE = std::ptr::null_mut();
        let hr = unsafe { auth.MakeCredential(&req, &mut response) };
        assert_eq!(hr, E_INVALIDARG);
        assert!(response.is_null());
    }

    #[test]
    fn null_request_is_e_pointer() {
        let auth = authenticator();
        let mut response: *mut WEBAUTHN_PLUGIN_OPERATION_RESPONSE = std::ptr::null_mut();
        let hr = unsafe { auth.MakeCredential(std::ptr::null(), &mut response) };
        assert_eq!(hr, E_POINTER);
    }

    #[test]
    fn lock_status_reflects_the_host() {
        let auth = authenticator();
        let mut status: i32 = -1;
        let hr = unsafe { auth.GetLockStatus(&mut status) };
        assert!(hr.is_ok());
        assert_eq!(status, PLUGIN_UNLOCKED);
    }
}
