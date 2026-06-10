//! Security-audit / vault-health / dark-web DTOs (backend → frontend).
//! All offline-audit data is computed on-device; the dark-web shapes carry
//! breach lookups. Mirrors `src/lib/types.ts`.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum HealthBand {
    Critical,
    Poor,
    Fair,
    Good,
    Excellent,
}

/// Per-item offline audit findings.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ItemAudit {
    pub id: String,
    pub name: String,
    pub reused: bool,
    pub weak: bool,
    pub weak_score: Option<u8>,
    pub old: bool,
    pub insecure_uri: bool,
    pub no_totp: bool,
}

/// Aggregate vault-health report (all offline; no secret leaves the device).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct VaultHealthReport {
    pub score: u8,
    pub band: HealthBand,
    pub total_logins: usize,
    pub reused: usize,
    pub weak: usize,
    pub old: usize,
    pub insecure: usize,
    pub no_totp: usize,
    pub at_risk: Vec<ItemAudit>,
}

/// Result of the opt-in HIBP exposed-password check (k-anonymity).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct ExposedResult {
    pub id: String,
    pub name: String,
    pub count: u64,
}

// ---------------------------------------------------------------------------
// Dark-web / breach monitor (darkweb.rs → frontend). Two free, keyless
// providers: XposedOrNot (per-email breach lookup — full email leaves the
// device, hence opt-in) and HIBP's public /breaches directory (no email sent).
// `BreachRecord` is a unified shape both providers map onto.
// ---------------------------------------------------------------------------

/// One breach. `data_classes` is the headline: *what personal data leaked*.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct BreachRecord {
    /// Display/stable name, e.g. "Adobe".
    pub name: String,
    /// Associated domain (may be empty).
    pub domain: String,
    /// Breach date as the provider gives it (a year "2026" or "YYYY-MM-DD").
    pub breach_date: Option<String>,
    /// Accounts in the breach, if known.
    pub pwn_count: Option<u64>,
    /// Categories of personal data exposed ("Email addresses", "Passwords", …).
    pub data_classes: Vec<String>,
    /// Human description (may contain HTML when sourced from HIBP).
    pub description: Option<String>,
    /// Logo URL, if any.
    pub logo: Option<String>,
    /// Whether the provider marks the breach as verified.
    pub verified: bool,
    /// How exposed passwords were stored ("plaintext", "hardtocrack", …); may be absent.
    pub password_risk: Option<String>,
}

/// Per-email scan result from the dark-web monitor.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct AccountBreaches {
    pub email: String,
    pub breaches: Vec<BreachRecord>,
    /// Union of every data class across this email's breaches.
    pub exposed_data: Vec<String>,
    /// Overall risk label/score the provider assigns the address, if any.
    pub risk_label: Option<String>,
    pub risk_score: Option<i64>,
}

/// One email whose breach lookup failed this run (network / provider error). Kept
/// apart from clean results so a transient failure is never read as "clean"; it is
/// retried on the next scan. `error` is the secret-free `AgateError` message.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct EmailError {
    pub email: String,
    pub error: String,
}

/// Aggregate dark-web report across every account email found in the vault.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct DarkWebReport {
    /// Every email actually checked this run, including clean ones (empty `breaches`).
    pub accounts: Vec<AccountBreaches>,
    /// Emails whose lookup failed this run; retried on the next scan.
    pub errored: Vec<EmailError>,
    /// Emails harvested but not scanned this run (per-run cap, to respect the
    /// provider's daily rate limit). Rotated into a later run so coverage is
    /// eventually complete — never silently dropped.
    pub pending: Vec<String>,
    /// Configured connections that aren't currently unlocked, so their vault items
    /// (and any emails inside them) couldn't be read this run. The connection's own
    /// account email is still scanned; this flags only the unread vault contents.
    pub locked_connections: Vec<String>,
    /// Total breaches across all checked emails.
    pub total_breaches: usize,
    /// How many checked emails came back clean.
    pub clean: usize,
}
