//! HIBP `/breaches` directory provider: the public, CC-BY-4.0 catalogue of every
//! known leak and the data classes it exposed. No email is sent; cached once per
//! process.

use serde::Deserialize;

use crate::dto::BreachRecord;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

use super::{http_client, opt};

const HIBP_BREACHES_URL: &str = "https://haveibeenpwned.com/api/v3/breaches";

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
