//! Security audit / vault health — all computed client-side.
//!
//! Offline checks (`audit_offline`) run entirely on decrypted `CipherView`s and
//! send nothing anywhere: reused passwords (grouped by a SHA-1 hash, never the
//! plaintext), weak passwords (zxcvbn score < 3), old passwords (revision-date
//! age), insecure http:// URIs, and logins missing TOTP. A 0–100 health score
//! summarizes them.
//!
//! The exposed-password check (`audit_exposed`) is opt-in and privacy-preserving:
//! it uses HIBP's Pwned Passwords k-anonymity range API — only the first 5 hex
//! chars of each unique password's SHA-1 ever leave the device, always with
//! `Add-Padding: true`, and padded (count==0) rows are discarded.

use std::collections::HashMap;

use bitwarden_vault::{CipherType, CipherView};
use chrono::Utc;
use sha1::{Digest, Sha1};
use zeroize::Zeroize;

use crate::dto::{ExposedResult, HealthBand, ItemAudit, VaultHealthReport};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

const OLD_PASSWORD_DAYS: i64 = 365;
const HIBP_RANGE_URL: &str = "https://api.pwnedpasswords.com/range/";

/// A decrypted login distilled to the fields the audit needs.
struct LoginAudit {
    id: String,
    name: String,
    password: String,
    username: Option<String>,
    uris: Vec<String>,
    has_totp: bool,
    old: bool,
}

fn uppercase_sha1_hex(input: &[u8]) -> String {
    let digest = Sha1::digest(input);
    let mut out = String::with_capacity(40);
    for b in digest {
        out.push_str(&format!("{b:02X}"));
    }
    out
}

/// Decrypt all cached ciphers and extract the login audit rows.
async fn collect_logins(state: &AppState) -> AgateResult<Vec<LoginAudit>> {
    let (client, ciphers) = {
        let session = state.session.lock().await;
        let client = session.client.as_ref().ok_or_else(AgateError::not_authenticated)?;
        (
            bitwarden_pm::PasswordManagerClient(client.0.clone()),
            session.ciphers.clone(),
        )
    };
    let ciphers_client = client.vault().ciphers();
    let now = Utc::now();
    let mut out = Vec::new();
    for cipher in ciphers {
        let view: CipherView = match ciphers_client.decrypt(cipher).await {
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
        let old = (now - revision).num_days() > OLD_PASSWORD_DAYS;
        out.push(LoginAudit {
            id: view.id.map(|i| i.to_string()).unwrap_or_default(),
            name: view.name.clone(),
            password,
            username: login.username.clone(),
            uris,
            has_totp: login.totp.as_ref().map(|t| !t.is_empty()).unwrap_or(false),
            old,
        });
    }
    Ok(out)
}

fn band_for(score: u8) -> HealthBand {
    match score {
        0..=39 => HealthBand::Critical,
        40..=59 => HealthBand::Poor,
        60..=79 => HealthBand::Fair,
        80..=94 => HealthBand::Good,
        _ => HealthBand::Excellent,
    }
}

/// Run all offline checks and produce a vault-health report.
pub async fn audit_offline(state: &AppState) -> AgateResult<VaultHealthReport> {
    let mut logins = collect_logins(state).await?;

    // Reuse: group by SHA-1 of the password (hash, not plaintext).
    let mut groups: HashMap<String, usize> = HashMap::new();
    for l in &logins {
        *groups.entry(uppercase_sha1_hex(l.password.as_bytes())).or_insert(0) += 1;
    }

    let total_logins = logins.len();
    let (mut reused, mut weak, mut old, mut insecure, mut no_totp) = (0, 0, 0, 0, 0);
    let mut at_risk: Vec<ItemAudit> = Vec::new();

    for l in &logins {
        let is_reused = groups.get(&uppercase_sha1_hex(l.password.as_bytes())).copied().unwrap_or(0) > 1;

        // zxcvbn with item context so e.g. password==username scores low.
        let mut inputs: Vec<&str> = Vec::new();
        if let Some(u) = &l.username {
            inputs.push(u.as_str());
        }
        for uri in &l.uris {
            inputs.push(uri.as_str());
        }
        let score = u8::from(zxcvbn::zxcvbn(&l.password, &inputs).score());
        let is_weak = score < 3;
        let is_insecure = l.uris.iter().any(|u| u.trim().to_lowercase().starts_with("http://"));
        let is_no_totp = !l.has_totp;

        if is_reused {
            reused += 1;
        }
        if is_weak {
            weak += 1;
        }
        if l.old {
            old += 1;
        }
        if is_insecure {
            insecure += 1;
        }
        if is_no_totp {
            no_totp += 1;
        }

        if is_reused || is_weak || l.old || is_insecure {
            at_risk.push(ItemAudit {
                id: l.id.clone(),
                name: l.name.clone(),
                reused: is_reused,
                weak: is_weak,
                weak_score: Some(score),
                old: l.old,
                insecure_uri: is_insecure,
                no_totp: is_no_totp,
            });
        }
    }

    // Score: start at 100, subtract weighted penalties, clamp to [0,100].
    let penalty = reused as i32 * 10 + weak as i32 * 8 + insecure as i32 * 5 + old as i32 * 2;
    let score = (100 - penalty).clamp(0, 100) as u8;

    // Scrub plaintext password buffers.
    for l in &mut logins {
        l.password.zeroize();
    }

    Ok(VaultHealthReport {
        score,
        band: band_for(score),
        total_logins,
        reused,
        weak,
        old,
        insecure,
        no_totp,
        at_risk,
    })
}

/// Opt-in HIBP exposed-password check via the k-anonymity range API.
pub async fn audit_exposed(state: &AppState) -> AgateResult<Vec<ExposedResult>> {
    let mut logins = collect_logins(state).await?;

    // Query each UNIQUE password once. Map prefix -> suffix -> count for matching.
    let client = reqwest::Client::builder()
        .user_agent(concat!("Agate/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("http client: {e}")))?;

    let mut counts: HashMap<String, u64> = HashMap::new(); // full hash -> count
    let mut seen_prefixes: HashMap<String, String> = HashMap::new(); // prefix -> body
    for l in &logins {
        let hash = uppercase_sha1_hex(l.password.as_bytes());
        if counts.contains_key(&hash) {
            continue;
        }
        let (prefix, suffix) = hash.split_at(5);
        let body = match seen_prefixes.get(prefix) {
            Some(b) => b.clone(),
            None => {
                let resp = client
                    .get(format!("{HIBP_RANGE_URL}{prefix}"))
                    .header("Add-Padding", "true")
                    .send()
                    .await
                    .map_err(|e| AgateError::new(ErrorKind::Network, format!("HIBP request failed: {e}")))?;
                let text = resp
                    .text()
                    .await
                    .map_err(|e| AgateError::new(ErrorKind::Network, format!("HIBP read failed: {e}")))?;
                seen_prefixes.insert(prefix.to_string(), text.clone());
                text
            }
        };
        let mut count = 0u64;
        for line in body.split(['\r', '\n']).filter(|l| !l.is_empty()) {
            let mut parts = line.splitn(2, ':');
            let (s, c) = (parts.next().unwrap_or(""), parts.next().unwrap_or("0"));
            // Padded filler rows have count 0 — discard them.
            let parsed = c.trim().parse::<u64>().unwrap_or(0);
            if parsed > 0 && s.eq_ignore_ascii_case(suffix) {
                count = parsed;
                break;
            }
        }
        counts.insert(hash, count);
    }

    let mut results = Vec::new();
    for l in &logins {
        let hash = uppercase_sha1_hex(l.password.as_bytes());
        if let Some(&c) = counts.get(&hash) {
            if c > 0 {
                results.push(ExposedResult { id: l.id.clone(), name: l.name.clone(), count: c });
            }
        }
    }

    for l in &mut logins {
        l.password.zeroize();
    }
    Ok(results)
}
