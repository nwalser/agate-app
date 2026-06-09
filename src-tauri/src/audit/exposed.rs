//! Opt-in HIBP exposed-password check via the Pwned Passwords k-anonymity range
//! API: only the first 5 hex chars of each unique password's SHA-1 leave the
//! device, always with `Add-Padding: true`, and padded (count==0) rows are
//! discarded.

use std::collections::HashMap;

use crate::dto::ExposedResult;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

use super::{collect_logins, uppercase_sha1_hex};

const HIBP_RANGE_URL: &str = "https://api.pwnedpasswords.com/range/";

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
}
