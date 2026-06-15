//! Layer C ↔ tray IPC contract (the "M1" single-session process model).
//!
//! **NOT YET WIRED — this is the contract, not a working transport.**
//!
//! The OS passkey-provider shim runs in a *separate* process that the OS
//! activates for a ceremony:
//! - **Windows**: a WebAuthn plugin-authenticator COM server (MSIX-packaged).
//! - **macOS**: an AutoFill credential-provider app extension (`.appex`).
//!
//! That shim has no access to the tray's unlocked [`Session`](crate::state) (the
//! VMK + live connections live in the tray process). Under the M1 model the shim
//! stays thin and forwards each browser ceremony to the **running tray process**
//! over a local transport (Windows named pipe / macOS XPC), which runs the
//! [`passkey::authenticator`](crate::passkey::authenticator) ceremony against the
//! chosen connection and returns the result. One unlock, one source of truth —
//! matching Agate's "configure once, one app secret unlocks everything".
//!
//! This module defines the **messages** they exchange. What is deliberately
//! *not* here, because it can't be built or verified in this environment
//! (packaging / signing / a real browser): the native shim, the transport, and
//! the peer-authentication of the pipe/XPC channel. See
//! `docs/passkey-provider-plan.md` §5.
//!
//! ## Open design question (flagged for whoever wires this)
//! The Bitwarden create path writes via the API and currently borrows the
//! connection across `.await`; the session is behind a `std::Mutex` whose guard
//! can't cross an await. The transport handler must therefore follow the
//! `mutate` pattern — snapshot the client/connection data out of the lock first,
//! then run the ceremony — rather than holding the session lock across the
//! network write. (KeePass writes are synchronous and already lock-safe via
//! `mutate::keepass_write`'s `block_in_place`.)

use serde::{Deserialize, Serialize};

/// Which connection (and, for registration, where in it) a ceremony targets —
/// the wire form of the user's destination choice surfaced in the tray popup.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CeremonyDestination {
    /// The unlocked connection id (account email for Bitwarden, absolute `.kdbx`
    /// path for KeePass).
    pub account_email: String,
    /// Attach the new passkey to this existing item; `None` = create a new item.
    /// Ignored for assertions.
    pub item_id: Option<String>,
    /// Folder for the new item (provider-specific id). Ignored when attaching or
    /// asserting.
    pub folder_id: Option<String>,
}

/// Tray ← shim: a ceremony to run. The CTAP2 request is carried as its canonical
/// CBOR encoding (`request_cbor`) — the shim already speaks CTAP to the OS — so
/// this contract doesn't restate the (large) request shape; the tray decodes it
/// into the `passkey-types` request and runs the matching ceremony.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "op")]
pub enum CeremonyRequest {
    /// Registration: mint + store a credential at `destination`.
    MakeCredential {
        destination: CeremonyDestination,
        /// CBOR-encoded `passkey_types::ctap2::make_credential::Request`.
        request_cbor: Vec<u8>,
    },
    /// Assertion: sign with a credential in `destination`'s connection.
    GetAssertion {
        destination: CeremonyDestination,
        /// CBOR-encoded `passkey_types::ctap2::get_assertion::Request`.
        request_cbor: Vec<u8>,
    },
}

/// Tray → shim: the ceremony outcome. The CTAP2 response is the canonical CBOR
/// the shim hands back to the OS; an error carries a user-facing message.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "status")]
pub enum CeremonyResponse {
    /// Success: CBOR-encoded CTAP2 response (make-credential or get-assertion).
    Ok { response_cbor: Vec<u8> },
    /// The user cancelled / declined consent (maps to CTAP "operation denied").
    Cancelled,
    /// Anything else, with a message safe to surface (never key material).
    Error { message: String },
}
