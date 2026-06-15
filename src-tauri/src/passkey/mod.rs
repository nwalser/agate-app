//! Passkeys (FIDO2 / WebAuthn credentials), provider-agnostic.
//!
//! Agate's goal is to act as a system passkey provider — a browser's
//! `navigator.credentials.create()` / `.get()` routes (via the OS WebAuthn
//! layer, no browser extension) to Agate, which mints / asserts a credential
//! stored in whichever vault the user chose.
//!
//! The design is three layers (see `docs/passkey-provider-plan.md`):
//! - **core (provider-agnostic):** the WebAuthn/CTAP2 ceremony + crypto, built
//!   on the `passkey-authenticator` crate's `CredentialStore` trait. Lives in
//!   `passkey::authenticator` (a later slice).
//! - **persistence (per-provider):** each backing store reads/writes credentials.
//!   Dispatched off `providers::LiveConnection` exactly like every other
//!   per-connection operation — adding a provider adds a match arm, and the
//!   passkey core never changes.
//! - **OS integration (per-OS):** the registration + request shim (Windows
//!   plugin authenticator, macOS credential-provider appex). Not in this crate.
//!
//! This module holds the **shared types** that cross those layers: a
//! provider-agnostic [`StoredPasskey`] (free of any `passkey`-crate types, so a
//! provider persists it without depending on the ceremony layer) and the closed
//! [`CoseAlgorithm`] set. The CredentialStore adapter is the one place that
//! converts between [`StoredPasskey`] and the crate's `Passkey`.

pub mod authenticator;
pub mod codec;
pub mod store;

pub use store::{CoseAlgorithm, StoredPasskey};
