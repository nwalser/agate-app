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

use std::time::Duration;

use bitwarden_vault::{Cipher, CipherType, CipherView};
use serde::Deserialize;

use crate::dto::{AccountBreaches, BreachRecord, DarkWebReport, EmailError, IdentityInput};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

const XON_ANALYTICS_URL: &str = "https://api.xposedornot.com/v1/breach-analytics";
const HIBP_BREACHES_URL: &str = "https://haveibeenpwned.com/api/v3/breaches";

/// XposedOrNot allows ≤2 req/s per IP; stay well under it between vault scans.
const THROTTLE: Duration = Duration::from_millis(600);

/// Cap on emails scanned per vault run, to respect the provider's ~100 req/day
/// per-IP budget. Anything beyond this is reported as `skipped`, never dropped
/// silently.
const MAX_VAULT_EMAILS: usize = 25;

// ---------------------------------------------------------------------------
// Email validation + collection
// ---------------------------------------------------------------------------

/// Loose, conservative email check — enough to avoid sending obvious non-emails
/// (raw usernames, blanks) to the network. Not a full RFC 5322 validator.
fn is_email(s: &str) -> bool {
    let s = s.trim();
    let mut parts = s.splitn(2, '@');
    let (local, domain) = match (parts.next(), parts.next()) {
        (Some(l), Some(d)) => (l, d),
        _ => return false,
    };
    if local.is_empty() || domain.len() < 3 || s.contains(' ') {
        return false;
    }
    // Domain must have a dot with non-empty labels either side of the last one.
    match domain.rsplit_once('.') {
        Some((host, tld)) => !host.is_empty() && tld.len() >= 2,
        None => false,
    }
}

/// Normalize for dedup + lookup: trimmed + lowercased.
fn normalize_email(s: &str) -> String {
    s.trim().to_lowercase()
}

/// The result of harvesting addresses to scan.
struct Harvest {
    /// All scannable emails — every configured connection's account email (scannable
    /// even while that connection is locked) plus login usernames / identity emails
    /// from each *unlocked* vault. Deduplicated, lowercased, validated, and **sorted**
    /// so the rotating scan window is stable across runs (the session connection map
    /// iterates in nondeterministic order).
    emails: Vec<String>,
    /// Configured connections that aren't currently unlocked, so their vault items
    /// couldn't be read this run. Their account email is still scanned; this flags
    /// only that their stored logins/identities went unharvested.
    locked_connections: Vec<String>,
}

/// Gather the user's own email addresses to scan: every configured connection's
/// account email (read straight from config, so locked connections still get their
/// address checked) plus login usernames that are emails and identity `email`
/// fields harvested from each *unlocked* vault. Returns `NotAuthenticated` if no
/// connection is open at all.
async fn collect_account_emails(state: &AppState) -> AgateResult<Harvest> {
    // Configured connection emails — scannable even while that connection is locked,
    // since checking an address needs only the string, not its decrypted vault.
    let configured: Vec<String> = {
        let cfg = state.config.lock().await;
        cfg.accounts.iter().map(|a| a.email.clone()).collect()
    };

    // Snapshot every *unlocked* connection's email + a client handle + its ciphers.
    // Under the unified-connection model the vault is a set of live connections;
    // each connection's own login email is one of the user's own accounts, and we
    // also harvest emails from that connection's login/identity items.
    let conns: Vec<(String, bitwarden_pm::PasswordManagerClient, Vec<Cipher>)> = {
        let session = state.session.lock().await;
        if session.connections.is_empty() {
            return Err(AgateError::not_authenticated());
        }
        session
            .connections
            .iter()
            .map(|(email, c)| {
                (email.clone(), bitwarden_pm::PasswordManagerClient(c.client.0.clone()), c.ciphers.clone())
            })
            .collect()
    };

    let unlocked: std::collections::HashSet<String> =
        conns.iter().map(|(e, _, _)| normalize_email(e)).collect();

    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    let push = |raw: &str, out: &mut Vec<String>, seen: &mut std::collections::HashSet<String>| {
        if is_email(raw) {
            let n = normalize_email(raw);
            if seen.insert(n.clone()) {
                out.push(n);
            }
        }
    };

    // Always scan every configured account email, locked or not.
    for email in &configured {
        push(email, &mut out, &mut seen);
    }

    // Harvest login usernames + identity emails from each unlocked vault.
    for (conn_email, client, ciphers) in conns {
        push(&conn_email, &mut out, &mut seen);
        let ciphers_client = client.vault().ciphers();
        for cipher in ciphers {
            let view: CipherView = match ciphers_client.decrypt(cipher).await {
                Ok(v) => v,
                Err(e) => {
                    log::warn!("darkweb: skipping undecryptable cipher: {e}");
                    continue;
                }
            };
            if view.deleted_date.is_some() {
                continue;
            }
            match view.r#type {
                CipherType::Login => {
                    if let Some(username) = view.login.as_ref().and_then(|l| l.username.clone()) {
                        push(&username, &mut out, &mut seen);
                    }
                }
                CipherType::Identity => {
                    // Round-trip through our own IdentityInput (the proven, SDK-version-
                    // tolerant path used in vault.rs) to read the email field.
                    let email = view
                        .identity
                        .as_ref()
                        .and_then(|i| serde_json::to_value(i).ok())
                        .and_then(|v| serde_json::from_value::<IdentityInput>(v).ok())
                        .and_then(|i| i.email);
                    if let Some(email) = email {
                        push(&email, &mut out, &mut seen);
                    }
                }
                _ => {}
            }
        }
    }

    // Stable order for the rotating scan window across runs.
    out.sort();

    // Configured connections we couldn't read this run (not unlocked — e.g. 2FA
    // pending after a cold start). Original casing kept for display.
    let locked_connections: Vec<String> = configured
        .into_iter()
        .filter(|e| !unlocked.contains(&normalize_email(e)))
        .collect();

    Ok(Harvest { emails: out, locked_connections })
}

// ---------------------------------------------------------------------------
// Provider response shapes (deserialization only; never leave this module)
// ---------------------------------------------------------------------------

/// XposedOrNot `breach-analytics` response. Clean email ⇒ `exposed_breaches` is
/// null (the endpoint still returns HTTP 200).
#[derive(Debug, Deserialize)]
struct XonAnalytics {
    #[serde(rename = "ExposedBreaches")]
    exposed_breaches: Option<XonExposed>,
    #[serde(rename = "BreachMetrics")]
    breach_metrics: Option<XonMetrics>,
}

#[derive(Debug, Deserialize)]
struct XonExposed {
    #[serde(default)]
    breaches_details: Vec<XonDetail>,
}

/// One breach in the analytics response. Note the provider's quirky typing:
/// `verified` is a `"Yes"`/`"No"` string, `xposed_data` is a `;`-delimited
/// string, and `xposed_records` is an int that is occasionally a string.
#[derive(Debug, Deserialize)]
struct XonDetail {
    #[serde(default)]
    breach: String,
    #[serde(default)]
    details: String,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    logo: String,
    #[serde(default)]
    password_risk: String,
    #[serde(default)]
    verified: String,
    #[serde(default)]
    xposed_data: String,
    #[serde(default)]
    xposed_date: String,
    #[serde(default)]
    xposed_records: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
struct XonMetrics {
    #[serde(default)]
    risk: Vec<XonRisk>,
}

#[derive(Debug, Deserialize)]
struct XonRisk {
    #[serde(default)]
    risk_label: String,
    #[serde(default)]
    risk_score: i64,
}

/// HIBP `/breaches` directory entry (PascalCase). Only the fields we surface.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct HibpBreach {
    #[serde(default)]
    title: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    domain: String,
    #[serde(default)]
    breach_date: String,
    #[serde(default)]
    pwn_count: u64,
    #[serde(default)]
    description: String,
    #[serde(default)]
    data_classes: Vec<String>,
    #[serde(default)]
    is_verified: bool,
    #[serde(default)]
    logo_path: String,
}

// ---------------------------------------------------------------------------
// Pure mappers (provider shape → frontend DTO). Unit-tested without the network.
// ---------------------------------------------------------------------------

/// Normalize XposedOrNot's `xposed_records` (int, or occasionally a string) to a
/// count.
fn value_to_count(v: &Option<serde_json::Value>) -> Option<u64> {
    match v {
        Some(serde_json::Value::Number(n)) => n.as_u64(),
        Some(serde_json::Value::String(s)) => s.trim().parse::<u64>().ok(),
        _ => None,
    }
}

/// Split a `;`-delimited data-class string, trimming blanks.
fn split_classes(s: &str) -> Vec<String> {
    s.split(';')
        .map(str::trim)
        .filter(|p| !p.is_empty())
        .map(String::from)
        .collect()
}

fn xon_detail_to_record(d: &XonDetail) -> BreachRecord {
    BreachRecord {
        name: d.breach.clone(),
        domain: d.domain.clone(),
        breach_date: opt(&d.xposed_date),
        pwn_count: value_to_count(&d.xposed_records),
        data_classes: split_classes(&d.xposed_data),
        description: opt(&d.details),
        logo: opt(&d.logo),
        verified: d.verified.eq_ignore_ascii_case("yes"),
        password_risk: opt_risk(&d.password_risk),
    }
}

/// Map a parsed analytics response onto the frontend `AccountBreaches`.
fn analytics_to_account(email: &str, a: &XonAnalytics) -> AccountBreaches {
    let breaches: Vec<BreachRecord> = a
        .exposed_breaches
        .as_ref()
        .map(|e| {
            e.breaches_details
                .iter()
                .map(xon_detail_to_record)
                // Drop any malformed entry with no breach name (defensive: `breach`
                // defaults to empty if the provider ever omits it).
                .filter(|r| !r.name.is_empty())
                .collect()
        })
        .unwrap_or_default();

    // Union of data classes across all of this email's breaches, order-preserving.
    let mut exposed_data = Vec::new();
    for b in &breaches {
        for c in &b.data_classes {
            if !exposed_data.iter().any(|e: &String| e.eq_ignore_ascii_case(c)) {
                exposed_data.push(c.clone());
            }
        }
    }

    let risk = a.breach_metrics.as_ref().and_then(|m| m.risk.first());
    AccountBreaches {
        email: email.to_string(),
        breaches,
        exposed_data,
        risk_label: risk.map(|r| r.risk_label.clone()).filter(|l| !l.is_empty()),
        risk_score: risk.map(|r| r.risk_score),
    }
}

fn hibp_to_record(b: &HibpBreach) -> BreachRecord {
    BreachRecord {
        name: if b.title.is_empty() { b.name.clone() } else { b.title.clone() },
        domain: b.domain.clone(),
        breach_date: opt(&b.breach_date),
        pwn_count: (b.pwn_count > 0).then_some(b.pwn_count),
        data_classes: b.data_classes.clone(),
        description: opt(&b.description),
        logo: opt(&b.logo_path),
        verified: b.is_verified,
        password_risk: None,
    }
}

fn opt(s: &str) -> Option<String> {
    let t = s.trim();
    (!t.is_empty()).then(|| t.to_string())
}

/// Like `opt`, but also drops the provider's "unknown" placeholder.
fn opt_risk(s: &str) -> Option<String> {
    opt(s).filter(|v| !v.eq_ignore_ascii_case("unknown"))
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

fn http_client() -> AgateResult<reqwest::Client> {
    reqwest::Client::builder()
        // HIBP requires a descriptive, non-empty User-Agent (missing ⇒ HTTP 403).
        .user_agent(concat!("Agate/", env!("CARGO_PKG_VERSION"), " (Bitwarden client)"))
        .build()
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("http client: {e}")))
}

/// Opt-in guard, enforced at the trust boundary: refuse any email lookup unless
/// the user has explicitly consented to the dark-web monitor.
async fn require_consent(state: &AppState) -> AgateResult<()> {
    if state.config.lock().await.darkweb_consent {
        Ok(())
    } else {
        Err(AgateError::bad_request(
            "Dark-web monitor is not enabled. Turn it on to scan your accounts.",
        ))
    }
}

/// Look up one email against XposedOrNot. The email is sent in plaintext; the
/// caller must have established consent. The address is never logged.
async fn fetch_email(client: &reqwest::Client, email: &str) -> AgateResult<AccountBreaches> {
    let resp = client
        .get(XON_ANALYTICS_URL)
        .query(&[("email", email)])
        .send()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("breach lookup failed: {e}")))?;
    let status = resp.status();
    if status.as_u16() == 429 {
        return Err(AgateError::new(
            ErrorKind::Network,
            "Breach provider rate limit reached. Try again shortly.",
        ));
    }
    if !status.is_success() {
        return Err(AgateError::new(
            ErrorKind::Network,
            format!("Breach provider returned HTTP {}.", status.as_u16()),
        ));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("breach read failed: {e}")))?;
    let parsed: XonAnalytics = serde_json::from_str(&text)
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("breach response parse: {e}")))?;
    Ok(analytics_to_account(email, &parsed))
}

// ---------------------------------------------------------------------------
// Public API (called from lib.rs commands)
// ---------------------------------------------------------------------------

/// Scan a single email (must be one of the user's own vault/account addresses —
/// validated by the frontend picking from `collect_account_emails`). Opt-in.
pub async fn scan_email(state: &AppState, email: String) -> AgateResult<AccountBreaches> {
    require_consent(state).await?;
    let email = normalize_email(&email);
    if !is_email(&email) {
        return Err(AgateError::bad_request("Not a valid email address."));
    }
    let client = http_client()?;
    fetch_email(&client, &email).await
}

/// Split the harvested emails into the window scanned this run and the pending
/// remainder, and compute the next rotation offset. Pure (no network / state) so the
/// rotation invariant — every email is eventually scanned and none is dropped — is
/// unit-tested. `cap` is the per-run limit; `offset` wraps the list.
fn rotate_window(emails: &[String], offset: usize, cap: usize) -> (Vec<String>, Vec<String>, usize) {
    let total = emails.len();
    let window_len = cap.min(total);
    // When the whole list fits under the cap there's nothing to rotate: scan it in
    // order from the front and reset the offset. Only a capped run honors `offset`.
    let start = if total <= cap { 0 } else { offset % total };
    let window: Vec<String> = emails.iter().cycle().skip(start).take(window_len).cloned().collect();
    let in_window: std::collections::HashSet<&String> = window.iter().collect();
    let pending: Vec<String> = emails.iter().filter(|e| !in_window.contains(e)).cloned().collect();
    let next_offset = if total > window_len { (start + window_len) % total } else { 0 };
    (window, pending, next_offset)
}

/// Scan the vault's account emails. Opt-in. Throttled to stay under the provider's
/// rate limit. At most `MAX_VAULT_EMAILS` are scanned per run (the provider's daily
/// budget); when the vault holds more, the scan walks a **rotating window** whose
/// start advances each run, so every email is eventually covered instead of the tail
/// being permanently dropped. A single email's lookup failure is **recorded, not
/// fatal** — the rest of the scan still completes and the failure is retried next run.
pub async fn scan_vault(state: &AppState) -> AgateResult<DarkWebReport> {
    require_consent(state).await?;
    let Harvest { emails, locked_connections } = collect_account_emails(state).await?;
    let total = emails.len();
    let client = http_client()?;

    // Window of up to MAX_VAULT_EMAILS starting at the persisted rotation offset,
    // wrapping the (sorted, stable) list; everything else is pending for a later run.
    let offset = state.config.lock().await.darkweb_scan_offset;
    let (window, pending, next_offset) = rotate_window(&emails, offset, MAX_VAULT_EMAILS);
    let window_len = window.len();

    let mut accounts = Vec::new();
    let mut errored = Vec::new();
    for (i, email) in window.iter().enumerate() {
        if i > 0 {
            tokio::time::sleep(THROTTLE).await;
        }
        match fetch_email(&client, email).await {
            Ok(acct) => accounts.push(acct),
            // One email's failure (rate limit, transient 5xx, parse) must never abort
            // the whole scan: record it and keep going.
            Err(e) => errored.push(EmailError { email: email.clone(), error: e.message }),
        }
    }

    // Advance the rotation offset for next run (only meaningful when capped).
    if total > window_len {
        {
            let mut cfg = state.config.lock().await;
            cfg.darkweb_scan_offset = next_offset;
        }
        if let Err(e) = state.save_config().await {
            // Non-fatal: a failed persist just means next run may repeat this window.
            log::warn!("darkweb: failed to persist scan rotation offset: {e}");
        }
    }

    let total_breaches = accounts.iter().map(|a| a.breaches.len()).sum();
    let clean = accounts.iter().filter(|a| a.breaches.is_empty()).count();
    Ok(DarkWebReport { accounts, errored, pending, locked_connections, total_breaches, clean })
}

/// The public HIBP breach directory — every known leak and what it exposed.
/// Cached for the life of the process (no email is sent; non-secret data).
pub async fn directory(state: &AppState) -> AgateResult<Vec<BreachRecord>> {
    if let Some(cached) = state.breach_directory.lock().await.as_ref() {
        return Ok(cached.clone());
    }
    let client = http_client()?;
    let resp = client
        .get(HIBP_BREACHES_URL)
        .send()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("breach directory failed: {e}")))?;
    if !resp.status().is_success() {
        return Err(AgateError::new(
            ErrorKind::Network,
            format!("Breach directory returned HTTP {}.", resp.status().as_u16()),
        ));
    }
    let text = resp
        .text()
        .await
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("breach directory read: {e}")))?;
    let raw: Vec<HibpBreach> = serde_json::from_str(&text)
        .map_err(|e| AgateError::new(ErrorKind::Network, format!("breach directory parse: {e}")))?;
    let mut records: Vec<BreachRecord> = raw.iter().map(hibp_to_record).collect();
    // Newest breaches first (BreachDate is "YYYY-MM-DD", lexicographically sortable).
    records.sort_by(|a, b| b.breach_date.cmp(&a.breach_date));
    *state.breach_directory.lock().await = Some(records.clone());
    Ok(records)
}

/// Persist the user's opt-in decision for the dark-web monitor.
pub async fn set_consent(state: &AppState, enabled: bool) -> AgateResult<()> {
    state.config.lock().await.darkweb_consent = enabled;
    state.save_config().await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn email_validation() {
        assert!(is_email("a@b.com"));
        assert!(is_email("First.Last+tag@sub.example.co.uk"));
        assert!(!is_email("not-an-email"));
        assert!(!is_email("missing@tld"));
        assert!(!is_email("@b.com"));
        assert!(!is_email("a@.com"));
        assert!(!is_email("a@b.c"));
        assert!(!is_email("two @spaces.com"));
        assert!(!is_email(""));
    }

    #[test]
    fn splits_and_normalizes() {
        assert_eq!(
            split_classes("Email addresses;Names; ;Passwords"),
            vec!["Email addresses", "Names", "Passwords"]
        );
        assert!(split_classes("").is_empty());
        assert_eq!(normalize_email("  Foo@Bar.COM "), "foo@bar.com");
    }

    #[test]
    fn xposed_records_int_or_string() {
        assert_eq!(value_to_count(&Some(serde_json::json!(11854655))), Some(11854655));
        assert_eq!(value_to_count(&Some(serde_json::json!("23547"))), Some(23547));
        assert_eq!(value_to_count(&Some(serde_json::json!("n/a"))), None);
        assert_eq!(value_to_count(&None), None);
    }

    #[test]
    fn parses_xposedornot_breached_response() {
        // Real shape from api.xposedornot.com/v1/breach-analytics (trimmed to 2 breaches).
        let body = r#"{
          "BreachMetrics": { "risk": [{ "risk_label": "Critical", "risk_score": 100 }] },
          "ExposedBreaches": { "breaches_details": [
            { "breach": "ZenBusiness", "details": "ShinyHunters leak", "domain": "zenbusiness.com",
              "logo": "https://x/Z.png", "password_risk": "unknown", "references": "",
              "searchable": "Yes", "verified": "Yes",
              "xposed_data": "Email addresses;Names;Phone numbers", "xposed_date": "2026",
              "xposed_records": 11854655, "added": "2026-06-05T05:46:12+00:00" },
            { "breach": "Adobe", "details": "Adobe 2013", "domain": "adobe.com",
              "logo": "https://x/A.png", "password_risk": "plaintext", "references": "",
              "searchable": "Yes", "verified": "No",
              "xposed_data": "Email addresses;Passwords", "xposed_date": "2013",
              "xposed_records": "152445165", "added": "2013-12-04T00:00:00+00:00" }
          ] }
        }"#;
        let parsed: XonAnalytics = serde_json::from_str(body).expect("parse");
        let acct = analytics_to_account("user@example.com", &parsed);

        assert_eq!(acct.email, "user@example.com");
        assert_eq!(acct.breaches.len(), 2);
        assert_eq!(acct.risk_label.as_deref(), Some("Critical"));
        assert_eq!(acct.risk_score, Some(100));

        let zen = &acct.breaches[0];
        assert_eq!(zen.name, "ZenBusiness");
        assert!(zen.verified);
        assert_eq!(zen.pwn_count, Some(11854655));
        assert_eq!(zen.data_classes, vec!["Email addresses", "Names", "Phone numbers"]);
        assert_eq!(zen.password_risk, None); // "unknown" dropped

        let adobe = &acct.breaches[1];
        assert!(!adobe.verified); // "No"
        assert_eq!(adobe.pwn_count, Some(152445165)); // string normalized
        assert_eq!(adobe.password_risk.as_deref(), Some("plaintext"));

        // Union, order-preserving, case-insensitive de-dup.
        assert_eq!(
            acct.exposed_data,
            vec!["Email addresses", "Names", "Phone numbers", "Passwords"]
        );
    }

    #[test]
    fn drops_breach_detail_with_missing_name() {
        // Defensive: a detail object missing `breach` must not crash the parse,
        // and must be filtered out rather than surfaced as a nameless breach.
        let body = r#"{
          "ExposedBreaches": { "breaches_details": [
            { "domain": "x.com", "xposed_data": "Email addresses", "verified": "Yes" },
            { "breach": "Adobe", "xposed_data": "Passwords", "verified": "Yes" }
          ] }
        }"#;
        let parsed: XonAnalytics = serde_json::from_str(body).expect("parse");
        let acct = analytics_to_account("user@example.com", &parsed);
        assert_eq!(acct.breaches.len(), 1);
        assert_eq!(acct.breaches[0].name, "Adobe");
    }

    #[test]
    fn parses_clean_xposedornot_response() {
        // Clean email: HTTP 200 with all bodies null.
        let body = r#"{"BreachMetrics":null,"BreachesSummary":{"site":""},
          "ExposedBreaches":null,"ExposedPastes":null,"PasteMetrics":null,
          "PastesSummary":{"cnt":0,"domain":"","tmpstmp":""}}"#;
        let parsed: XonAnalytics = serde_json::from_str(body).expect("parse");
        let acct = analytics_to_account("clean@example.com", &parsed);
        assert!(acct.breaches.is_empty());
        assert!(acct.exposed_data.is_empty());
        assert_eq!(acct.risk_label, None);
    }

    #[test]
    fn parses_hibp_directory_entry() {
        // Real shape from haveibeenpwned.com/api/v3/breaches.
        let body = r#"[{ "Name":"Adobe","Title":"Adobe","Domain":"adobe.com",
          "BreachDate":"2013-10-04","AddedDate":"2013-12-04T00:00:00Z","PwnCount":152445165,
          "Description":"In October 2013...","LogoPath":"https://logos.hibp.com/Adobe.png",
          "DataClasses":["Email addresses","Password hints","Passwords","Usernames"],
          "IsVerified":true,"IsFabricated":false,"IsSensitive":false }]"#;
        let raw: Vec<HibpBreach> = serde_json::from_str(body).expect("parse");
        let rec = hibp_to_record(&raw[0]);
        assert_eq!(rec.name, "Adobe");
        assert_eq!(rec.pwn_count, Some(152445165));
        assert!(rec.verified);
        assert_eq!(rec.breach_date.as_deref(), Some("2013-10-04"));
        assert_eq!(rec.data_classes.len(), 4);
        assert_eq!(rec.logo.as_deref(), Some("https://logos.hibp.com/Adobe.png"));
    }

    fn v(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("{i:02}@x.com")).collect()
    }

    #[test]
    fn rotate_window_under_cap_scans_all() {
        let emails = v(3);
        let (window, pending, next) = rotate_window(&emails, 7, 25);
        assert_eq!(window, emails); // offset ignored, everything fits
        assert!(pending.is_empty());
        assert_eq!(next, 0); // no rotation when nothing is capped
    }

    #[test]
    fn rotate_window_empty_is_safe() {
        let (window, pending, next) = rotate_window(&[], 5, 25);
        assert!(window.is_empty());
        assert!(pending.is_empty());
        assert_eq!(next, 0);
    }

    #[test]
    fn rotate_window_caps_and_advances() {
        let emails = v(30); // 30 emails, cap 25
        let (w0, p0, n0) = rotate_window(&emails, 0, 25);
        assert_eq!(w0.len(), 25);
        assert_eq!(p0.len(), 5);
        assert_eq!(n0, 25);
        // Next run starts at 25 and wraps: 25..30 then 0..19.
        let (w1, _p1, _n1) = rotate_window(&emails, n0, 25);
        assert_eq!(w1.len(), 25);
        assert_eq!(w1[0], "25@x.com");
        assert_eq!(w1[5], "00@x.com"); // wrapped to the front
    }

    #[test]
    fn rotate_window_covers_everything_over_runs() {
        // Invariant: rotating the offset eventually scans every email, none dropped.
        let emails = v(30);
        let mut offset = 0;
        let mut covered = std::collections::HashSet::new();
        for _ in 0..2 {
            let (window, _pending, next) = rotate_window(&emails, offset, 25);
            covered.extend(window);
            offset = next;
        }
        assert_eq!(covered.len(), emails.len()); // full coverage in 2 runs
    }

    #[test]
    fn rotate_window_stale_offset_wraps_safely() {
        let emails = v(4);
        // Offset far past the end (e.g. vault shrank) must still index validly.
        let (window, pending, next) = rotate_window(&emails, 99, 25);
        assert_eq!(window.len(), 4);
        assert!(pending.is_empty());
        assert_eq!(next, 0);
    }
}
