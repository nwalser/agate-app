//! XposedOrNot `breach-analytics` provider: the response shapes (deserialization
//! only), the pure provider-shape → DTO mappers, and the single-email lookup.
//! The email is sent in plaintext (over TLS); callers must have established
//! consent, and the address is never logged.

use serde::Deserialize;

use crate::dto::{AccountBreaches, BreachRecord};
use crate::error::{AgateError, AgateResult, ErrorKind};

use super::{opt, opt_risk};

const XON_ANALYTICS_URL: &str = "https://api.xposedornot.com/v1/breach-analytics";

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

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

/// Look up one email against XposedOrNot. The email is sent in plaintext; the
/// caller must have established consent. The address is never logged.
pub(super) async fn fetch_email(client: &reqwest::Client, email: &str) -> AgateResult<AccountBreaches> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_classes() {
        assert_eq!(
            split_classes("Email addresses;Names; ;Passwords"),
            vec!["Email addresses", "Names", "Passwords"]
        );
        assert!(split_classes("").is_empty());
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
}
