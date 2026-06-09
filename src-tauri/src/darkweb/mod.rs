//! Dark-web / breach monitor. Two third-party providers, both **free and
//! keyless**:
//!
//! - **XposedOrNot** `breach-analytics` — given one of the user's own email
//!   addresses, returns the breaches it appears in and *what categories of
//!   personal data leaked* in each. There is no k-anonymity option for email
//!   lookups anywhere in the free tier: the **full email is sent in plaintext**
//!   (over TLS) to the provider. This is therefore strictly opt-in behind a
//!   stored consent flag, enforced **here at the trust boundary** — not just in
//!   the UI. We only ever query addresses the user already holds in their vault.
//!
//! - **HIBP** `/breaches` — the public, CC-BY-4.0 breach *directory*: every known
//!   leak and the data classes it exposed. No email is sent; this is a read-only
//!   catalogue, cached once per process.
//!
//! Both providers' terms require visible attribution, surfaced in the UI. The
//! existing privacy-preserving password check (HIBP k-anonymity range API) lives
//! in `audit.rs` and is deliberately separate — it is strictly less sensitive.
//!
//! Error discipline mirrors `audit.rs`: a thin `reqwest` wrapper, no `.unwrap()`,
//! no empty `catch`, every failure mapped to a typed `AgateError`. The queried
//! email is never logged.

mod emails;
mod hibp;
mod scan;
mod xon;

pub use hibp::directory;
pub use scan::{scan_email, scan_vault, set_consent};

use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

pub(super) fn http_client() -> AgateResult<reqwest::Client> {
    reqwest::Client::builder()
        // HIBP requires a descriptive, non-empty User-Agent (missing ⇒ HTTP 403).
        .user_agent(concat!("Agate/", env!("CARGO_PKG_VERSION"), " (Bitwarden client)"))
        .build()
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("http client: {e}")))
}

/// Opt-in guard, enforced at the trust boundary: refuse any email lookup unless
/// the user has explicitly consented to the dark-web monitor.
pub(super) async fn require_consent(state: &AppState) -> AgateResult<()> {
    if state.config.lock().await.darkweb_consent {
        Ok(())
    } else {
        Err(AgateError::bad_request(
            "Dark-web monitor is not enabled. Turn it on to scan your accounts.",
        ))
    }
}

pub(super) fn opt(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Like `opt`, but also drops the provider's "unknown" placeholder.
pub(super) fn opt_risk(s: &str) -> Option<String> {
    opt(s).filter(|v| !v.eq_ignore_ascii_case("unknown"))
}
