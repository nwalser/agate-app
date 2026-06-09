//! Offline vault-health scoring: reused / weak / old / insecure-URI / no-TOTP
//! checks over the decrypted login union, summarized into a 0–100 score. Sends
//! nothing anywhere.

use std::collections::HashMap;

use serde::Deserialize;

use crate::dto::{HealthBand, ItemAudit, VaultHealthReport};
use crate::error::AgateResult;
use crate::state::AppState;

use super::{collect_logins, uppercase_sha1_hex};

const OLD_PASSWORD_DAYS: i64 = 365;

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

#[cfg(test)]
mod tests {
    use super::*;

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
