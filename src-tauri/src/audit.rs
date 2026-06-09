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

use std::collections::HashMap;

use bitwarden_vault::{Cipher, CipherType, CipherView};
use chrono::Utc;
use serde::Deserialize;
use sha1::{Digest, Sha1};
use zeroize::Zeroizing;

use crate::dto::{ExposedResult, HealthBand, ItemAudit, VaultHealthReport};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

const OLD_PASSWORD_DAYS: i64 = 365;
const HIBP_RANGE_URL: &str = "https://api.pwnedpasswords.com/range/";

/// Which offline checks run, and their thresholds — chosen by the user in the
/// audit settings. Defined here (not dto.rs) because it is audit-specific input;
/// mirrors `AuditConfig` in `src/state/auditConfig.ts`. Every field has a
/// `serde(default)` so an older/partial payload still deserializes to the
/// historical behaviour (all checks on, original thresholds).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditConfig {
    #[serde(default = "enabled")]
    pub reused: bool,
    #[serde(default = "enabled")]
    pub weak: bool,
    #[serde(default = "enabled")]
    pub old: bool,
    #[serde(default = "enabled")]
    pub insecure_uri: bool,
    #[serde(default = "enabled")]
    pub no_totp: bool,
    /// A password scoring below this zxcvbn strength (0–4) counts as weak.
    #[serde(default = "default_weak_max_score")]
    pub weak_max_score: u8,
    /// A password older than this many days counts as old.
    #[serde(default = "default_old_days")]
    pub old_days: i64,
    /// A password shared by at least this many logins counts as reused.
    #[serde(default = "default_reuse_min")]
    pub reuse_min: usize,
}

fn enabled() -> bool {
    true
}
fn default_weak_max_score() -> u8 {
    3
}
fn default_old_days() -> i64 {
    OLD_PASSWORD_DAYS
}
fn default_reuse_min() -> usize {
    2
}

impl Default for AuditConfig {
    fn default() -> Self {
        Self {
            reused: true,
            weak: true,
            old: true,
            insecure_uri: true,
            no_totp: true,
            weak_max_score: default_weak_max_score(),
            old_days: default_old_days(),
            reuse_min: default_reuse_min(),
        }
    }
}

/// A decrypted login distilled to the fields the audit needs. `password` is a
/// `Zeroizing<String>` so the plaintext is scrubbed on every drop — including
/// early returns (HIBP network errors) and panic unwinding, not just success.
struct LoginAudit {
    id: String,
    name: String,
    password: Zeroizing<String>,
    username: Option<String>,
    uris: Vec<String>,
    has_totp: bool,
    /// Age of the password (days since its revision date) — the "old" threshold is
    /// applied later so it stays configurable.
    age_days: i64,
}

fn uppercase_sha1_hex(input: &[u8]) -> String {
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
async fn collect_logins(state: &AppState) -> AgateResult<Vec<LoginAudit>> {
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

/// Parse a HIBP range-API response body for the breach count of `suffix`.
/// Lines are `SUFFIX:COUNT`; padded filler rows (count 0) are ignored. Returns
/// 0 when the suffix is absent or only present as padding (i.e. not breached).
fn hibp_count_for_suffix(body: &str, suffix: &str) -> u64 {
    for line in body.split(['\r', '\n']).filter(|l| !l.is_empty()) {
        let mut parts = line.splitn(2, ':');
        let (s, c) = (parts.next().unwrap_or(""), parts.next().unwrap_or("0"));
        let parsed = c.trim().parse::<u64>().unwrap_or(0);
        if parsed > 0 && s.eq_ignore_ascii_case(suffix) {
            return parsed;
        }
    }
    0
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

/// Run the enabled offline checks (with the configured thresholds) and produce a
/// vault-health report. Disabled checks contribute nothing to the counts, the
/// at-risk list, or the score.
pub async fn audit_offline(state: &AppState, config: AuditConfig) -> AgateResult<VaultHealthReport> {
    let logins = collect_logins(state).await?;

    // Reuse: group by SHA-1 of the password (hash, not plaintext).
    let mut groups: HashMap<String, usize> = HashMap::new();
    for l in &logins {
        *groups.entry(uppercase_sha1_hex(l.password.as_bytes())).or_insert(0) += 1;
    }

    let total_logins = logins.len();
    let (mut reused, mut weak, mut old, mut insecure, mut no_totp) = (0, 0, 0, 0, 0);
    let mut at_risk: Vec<ItemAudit> = Vec::new();

    for l in &logins {
        let share_count = groups.get(&uppercase_sha1_hex(l.password.as_bytes())).copied().unwrap_or(0);
        let is_reused = config.reused && share_count >= config.reuse_min;

        // zxcvbn with item context so e.g. password==username scores low.
        let mut inputs: Vec<&str> = Vec::new();
        if let Some(u) = &l.username {
            inputs.push(u.as_str());
        }
        for uri in &l.uris {
            inputs.push(uri.as_str());
        }
        let score = u8::from(zxcvbn::zxcvbn(l.password.as_str(), &inputs).score());
        let is_weak = config.weak && score < config.weak_max_score;
        let is_old = config.old && l.age_days > config.old_days;
        let is_insecure = config.insecure_uri
            && l.uris.iter().any(|u| u.trim().to_lowercase().starts_with("http://"));
        let is_no_totp = config.no_totp && !l.has_totp;

        if is_reused {
            reused += 1;
        }
        if is_weak {
            weak += 1;
        }
        if is_old {
            old += 1;
        }
        if is_insecure {
            insecure += 1;
        }
        if is_no_totp {
            no_totp += 1;
        }

        if is_reused || is_weak || is_old || is_insecure {
            at_risk.push(ItemAudit {
                id: l.id.clone(),
                name: l.name.clone(),
                reused: is_reused,
                weak: is_weak,
                weak_score: Some(score),
                old: is_old,
                insecure_uri: is_insecure,
                no_totp: is_no_totp,
            });
        }
    }

    // Score: start at 100, subtract weighted penalties, clamp to [0,100].
    let penalty = reused as i32 * 10 + weak as i32 * 8 + insecure as i32 * 5 + old as i32 * 2;
    let score = (100 - penalty).clamp(0, 100) as u8;

    // `logins` (Zeroizing passwords) scrub automatically on drop.
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
    let logins = collect_logins(state).await?;

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
        let count = hibp_count_for_suffix(&body, suffix);
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
    // `logins` (Zeroizing passwords) scrub automatically on every exit path.
    Ok(results)
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

    #[test]
    fn hibp_parsing_matches_suffix_and_ignores_padding() {
        // Real HIBP range body shape: SUFFIX:COUNT lines, CRLF-separated.
        let body = "0018A45C4D1DEF81644B54AB7F969B88D65:1\r\nAAAA:0\r\n00D4F6E8FA6EECAD2A3AA415EEC418D38EC:23547";
        // Present with a real count, case-insensitive.
        assert_eq!(hibp_count_for_suffix(body, "00d4f6e8fa6eecad2a3aa415eec418d38ec"), 23547);
        // Padding rows (count 0) are not a match.
        assert_eq!(hibp_count_for_suffix(body, "AAAA"), 0);
        // Absent suffix → not breached.
        assert_eq!(hibp_count_for_suffix(body, "DEADBEEF"), 0);
    }

    #[test]
    fn audit_config_defaults_and_partial_deserialize() {
        let d = AuditConfig::default();
        assert!(d.reused && d.weak && d.old && d.insecure_uri && d.no_totp);
        assert_eq!(d.weak_max_score, 3);
        assert_eq!(d.old_days, OLD_PASSWORD_DAYS);
        assert_eq!(d.reuse_min, 2);

        // An empty payload deserializes to the historical behaviour (all on).
        let empty: AuditConfig = serde_json::from_str("{}").expect("deserialize");
        assert!(empty.reused && empty.weak && empty.old && empty.insecure_uri && empty.no_totp);
        assert_eq!(empty.weak_max_score, 3);

        // camelCase field names from the frontend; unspecified fields keep defaults.
        let partial: AuditConfig =
            serde_json::from_str(r#"{"weak":false,"oldDays":30,"weakMaxScore":2}"#).expect("deserialize");
        assert!(!partial.weak);
        assert!(partial.reused); // unspecified -> default true
        assert_eq!(partial.old_days, 30);
        assert_eq!(partial.weak_max_score, 2);
    }

    #[test]
    fn band_thresholds_map_correctly() {
        assert!(matches!(band_for(0), HealthBand::Critical));
        assert!(matches!(band_for(39), HealthBand::Critical));
        assert!(matches!(band_for(40), HealthBand::Poor));
        assert!(matches!(band_for(59), HealthBand::Poor));
        assert!(matches!(band_for(60), HealthBand::Fair));
        assert!(matches!(band_for(79), HealthBand::Fair));
        assert!(matches!(band_for(80), HealthBand::Good));
        assert!(matches!(band_for(94), HealthBand::Good));
        assert!(matches!(band_for(95), HealthBand::Excellent));
        assert!(matches!(band_for(100), HealthBand::Excellent));
    }
}
