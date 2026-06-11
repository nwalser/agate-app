//! Security audit / vault health — all computed client-side.
//!
//! Offline checks (`audit_offline`) run entirely on decrypted `CipherView`s and
//! send nothing anywhere: reused passwords (grouped by a SHA-1 hash, never the
//! plaintext), weak passwords (zxcvbn score below a threshold), old passwords
//! (revision-date age), insecure http:// URIs, and logins missing TOTP. A 0–100
//! health score summarizes them. Each check can be turned off and its threshold
//! tuned via `AuditConfig` (Settings › Audits); the values quoted here are just
//! the defaults (weak < 3, older than 365 days, shared by ≥ 2 logins).
//!
//! The exposed-password check (`audit_exposed`) is opt-in and privacy-preserving:
//! it uses HIBP's Pwned Passwords k-anonymity range API — only the first 5 hex
//! chars of each unique password's SHA-1 ever leave the device, always with
//! `Add-Padding: true`, and padded (count==0) rows are discarded.

mod exposed;
mod offline;

pub use exposed::audit_exposed;
pub use offline::{audit_offline, AuditConfig};

use bitwarden_vault::{Cipher, CipherType, CipherView};
use chrono::Utc;
use sha1::{Digest, Sha1};
use zeroize::Zeroizing;

use crate::error::{AgateError, AgateResult};
use crate::state::AppState;

/// A decrypted login distilled to the fields the audit needs. `password` is a
/// `Zeroizing<String>` so the plaintext is scrubbed on every drop — including
/// early returns (HIBP network errors) and panic unwinding, not just success.
pub(super) struct LoginAudit {
    pub(super) id: String,
    pub(super) name: String,
    pub(super) password: Zeroizing<String>,
    pub(super) username: Option<String>,
    pub(super) uris: Vec<String>,
    pub(super) has_totp: bool,
    /// Age of the password (days since its revision date) — the "old" threshold is
    /// applied later so it stays configurable.
    pub(super) age_days: i64,
}

/// How many existing logins (across every unlocked vault) already use
/// `password` — powers the tray add-form's "password already used" callout.
/// Returns a count only; which logins match never leaves the backend. The
/// candidate arrives and dies in-process (`Zeroizing`).
pub async fn password_in_use(
    state: &AppState,
    password: Zeroizing<String>,
) -> AgateResult<u32> {
    if password.is_empty() {
        return Ok(0);
    }
    let logins = collect_logins(state).await?;
    Ok(logins.iter().filter(|l| *l.password == *password).count() as u32)
}

/// zxcvbn strength score (0–4) for a candidate password — powers the tray
/// add-form's live strength meter. `context` carries the draft's username /
/// website / name so a password equal to one of them scores low, exactly as the
/// offline audit does. The plaintext arrives in a `Zeroizing` and never leaves
/// the process; only the integer score is returned.
pub fn password_strength(password: &Zeroizing<String>, context: &[String]) -> u8 {
    let inputs: Vec<&str> = context
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    offline::password_score(password.as_str(), &inputs)
}

pub(super) fn uppercase_sha1_hex(input: &[u8]) -> String {
    let digest = Sha1::digest(input);
    let mut out = String::with_capacity(40);
    for b in digest {
        out.push_str(&format!("{b:02X}"));
    }
    out
}

/// Decrypt every unlocked connection's cached ciphers and extract login audit
/// rows. The report is over the UNION of all vaults, so e.g. a password reused
/// between a personal and a work account is correctly flagged.
pub(super) async fn collect_logins(state: &AppState) -> AgateResult<Vec<LoginAudit>> {
    let snapshot: Vec<(bitwarden_pm::PasswordManagerClient, Vec<Cipher>)> = {
        let session = state.session.lock().await;
        if session.connections.is_empty() {
            return Err(AgateError::not_authenticated());
        }
        session
            .connections
            .values()
            .map(|c| (bitwarden_pm::PasswordManagerClient(c.client.0.clone()), c.ciphers.clone()))
            .collect()
    };

    let now = Utc::now();
    let mut out = Vec::new();
    for (client, ciphers) in snapshot {
        // Synchronous key-store decrypt in a loop — avoids the async per-item
        // feature-flag fetch that CiphersClient::decrypt does (hundreds of awaits).
        let key_store = client.0.internal.get_key_store();
        for cipher in &ciphers {
            let view: CipherView = match key_store.decrypt(cipher) {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("audit: skipping undecryptable cipher: {e}");
                    continue;
                }
            };
            if view.r#type != CipherType::Login || view.deleted_date.is_some() {
                continue;
            }
            let Some(login) = &view.login else { continue };
            let Some(password) = login.password.clone() else { continue };
            if password.is_empty() {
                continue;
            }
            let uris = login
                .uris
                .as_ref()
                .map(|us| us.iter().filter_map(|u| u.uri.clone()).collect())
                .unwrap_or_default();
            let revision = login.password_revision_date.unwrap_or(view.revision_date);
            let age_days = (now - revision).num_days();
            out.push(LoginAudit {
                id: view.id.map(|i| i.to_string()).unwrap_or_default(),
                name: view.name.clone(),
                password: Zeroizing::new(password),
                username: login.username.clone(),
                uris,
                has_totp: login.totp.as_ref().map(|t| !t.is_empty()).unwrap_or(false),
                age_days,
            });
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sha1_hex_is_uppercase_and_correct() {
        // Known SHA-1 of "password" — also the value HIBP keys its corpus by.
        let h = uppercase_sha1_hex(b"password");
        assert_eq!(h, "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
        assert_eq!(h.len(), 40);
        assert!(h.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()));
        // The HIBP range query sends only the first 5 chars.
        assert_eq!(&h[..5], "5BAA6");
    }
}
