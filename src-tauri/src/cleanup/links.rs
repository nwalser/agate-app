//! Link-health checker: ping every login URL on demand and classify each one as
//! ok / broken / unreachable / uncertain so stale bookmarks can be fixed.
//!
//! The HTTP-touching part (`check_one` / `link_check_vault`) is kept thin; all the
//! decision logic lives in the pure, unit-tested helpers `normalize_url`,
//! `classify_status`, `classify_error`, and `assemble_report` (no network needed).

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::time::Duration;

use crate::dto::{LinkCheckReport, LinkHealthItem, LinkStatus, LinkStatusKind};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

use super::{collect_link_items, LinkItem};

/// Per-request ceiling. A dead host should fail fast, not hang the whole scan.
const TIMEOUT: Duration = Duration::from_secs(10);
/// Concurrent in-flight requests. Bounded so a large vault doesn't open hundreds
/// of sockets at once (and to be a polite client to the sites we probe).
const MAX_CONCURRENT: usize = 8;
/// Follow redirects so a site that moved (301/302 → 200) reads as ok, not broken,
/// but cap the chain to avoid redirect loops.
const MAX_REDIRECTS: usize = 10;

/// On-demand link-health scan across every unlocked vault. Collects login URIs,
/// checks each UNIQUE web URL once (concurrently), and assembles the report.
pub async fn link_check_vault(state: &AppState) -> AgateResult<LinkCheckReport> {
    let items = collect_link_items(state).await?;

    // Unique web URLs across all items. Normalizing drops non-web schemes and
    // dedups, so a URL shared by many logins is only fetched once.
    let mut unique: HashSet<String> = HashSet::new();
    for item in &items {
        for raw in &item.uris {
            if let Some(url) = normalize_url(raw) {
                unique.insert(url);
            }
        }
    }

    let client = Arc::new(
        reqwest::Client::builder()
            .user_agent(concat!("Agate/", env!("CARGO_PKG_VERSION"), " (link check)"))
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::limited(MAX_REDIRECTS))
            .build()
            .map_err(|e| AgateError::new(ErrorKind::Network, format!("http client: {e}")))?,
    );

    let sem = Arc::new(tokio::sync::Semaphore::new(MAX_CONCURRENT));
    let mut set = tokio::task::JoinSet::new();
    for url in unique {
        let client = client.clone();
        let sem = sem.clone();
        set.spawn(async move {
            // The permit is never closed, so acquire can't realistically fail; if
            // it ever did we'd just proceed unthrottled, which is still correct.
            let _permit = sem.acquire_owned().await.ok();
            check_one(&client, &url).await
        });
    }

    let mut results: HashMap<String, LinkStatus> = HashMap::new();
    while let Some(joined) = set.join_next().await {
        match joined {
            Ok(status) => {
                results.insert(status.url.clone(), status);
            }
            // A join error means the task panicked or was cancelled — log and skip
            // that one URL rather than failing the whole scan.
            Err(e) => log::warn!("link check task failed: {e}"),
        }
    }

    Ok(assemble_report(&items, &results))
}

/// Fetch one URL and turn the outcome into a `LinkStatus`. A GET (not HEAD) because
/// many servers reject HEAD with 405; the body is dropped — only the final status
/// (after redirects) matters.
async fn check_one(client: &reqwest::Client, url: &str) -> LinkStatus {
    match client.get(url).send().await {
        Ok(resp) => {
            let code = resp.status().as_u16();
            LinkStatus { url: url.to_string(), kind: classify_status(code), http_status: Some(code) }
        }
        Err(err) => {
            LinkStatus { url: url.to_string(), kind: classify_error(&err), http_status: None }
        }
    }
}

/// Normalize a raw vault URI into a fetchable `http(s)` URL, or `None` to skip it.
/// Non-web schemes (`androidapp://`, `iosapp://`, `ssh://`, …), empty strings, and
/// unparseable junk are skipped. A schemeless host (`example.com`) gets `https://`.
pub(super) fn normalize_url(raw: &str) -> Option<String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let candidate = if has_scheme(trimmed) {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let url = reqwest::Url::parse(&candidate).ok()?;
    match url.scheme() {
        // Require a real host so `http://` (no host) is skipped, not "checked".
        "http" | "https" if url.host_str().is_some() => Some(url.to_string()),
        _ => None,
    }
}

/// Whether the string starts with a `scheme://` prefix (scheme = letters/digits and
/// `+-.`). Used to decide whether to prepend `https://`.
fn has_scheme(s: &str) -> bool {
    match s.find("://") {
        Some(idx) if idx > 0 => {
            s[..idx].chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        _ => false,
    }
}

/// Map an HTTP status code to a verdict. 404/410 → gone (broken); 5xx → uncertain
/// (maybe transient); everything else (2xx/3xx, and auth/blocked 401/403/405/429)
/// means the host is alive → ok.
pub(super) fn classify_status(code: u16) -> LinkStatusKind {
    match code {
        404 | 410 => LinkStatusKind::Broken,
        500..=599 => LinkStatusKind::Uncertain,
        _ => LinkStatusKind::Ok,
    }
}

/// Map a transport error to a verdict. A timeout might be transient (uncertain);
/// anything else (DNS failure, connection refused, TLS error) means the host is
/// effectively dead (unreachable → needs update).
fn classify_error(err: &reqwest::Error) -> LinkStatusKind {
    if err.is_timeout() {
        LinkStatusKind::Uncertain
    } else {
        LinkStatusKind::Unreachable
    }
}

/// Pure report builder: given the collected items and the url→status results, tally
/// the aggregate counts (over the unique results) and list only the items that have
/// at least one problematic (non-ok) link, carrying just those links.
pub(super) fn assemble_report(
    items: &[LinkItem],
    results: &HashMap<String, LinkStatus>,
) -> LinkCheckReport {
    let (mut ok, mut broken, mut unreachable, mut uncertain) = (0usize, 0, 0, 0);
    for st in results.values() {
        match st.kind {
            LinkStatusKind::Ok => ok += 1,
            LinkStatusKind::Broken => broken += 1,
            LinkStatusKind::Unreachable => unreachable += 1,
            LinkStatusKind::Uncertain => uncertain += 1,
        }
    }

    let mut skipped: HashSet<&str> = HashSet::new();
    let mut report_items = Vec::new();
    for item in items {
        let mut problems = Vec::new();
        for raw in &item.uris {
            match normalize_url(raw) {
                None => {
                    let t = raw.trim();
                    if !t.is_empty() {
                        skipped.insert(t);
                    }
                }
                Some(url) => {
                    if let Some(st) = results.get(&url) {
                        if st.kind != LinkStatusKind::Ok {
                            problems.push(st.clone());
                        }
                    }
                }
            }
        }
        if !problems.is_empty() {
            report_items.push(LinkHealthItem {
                id: item.id.clone(),
                name: item.name.clone(),
                account_email: item.account_email.clone(),
                links: problems,
            });
        }
    }

    LinkCheckReport {
        scanned: results.len(),
        ok,
        broken,
        unreachable,
        uncertain,
        skipped: skipped.len(),
        items: report_items,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(id: &str, uris: &[&str]) -> LinkItem {
        LinkItem {
            id: id.to_string(),
            name: format!("item-{id}"),
            account_email: "me@example.com".to_string(),
            uris: uris.iter().map(|s| s.to_string()).collect(),
        }
    }

    fn status(url: &str, kind: LinkStatusKind, code: Option<u16>) -> LinkStatus {
        LinkStatus { url: url.to_string(), kind, http_status: code }
    }

    #[test]
    fn normalize_skips_non_web_schemes_and_empty() {
        assert_eq!(normalize_url("androidapp://com.foo.bar"), None);
        assert_eq!(normalize_url("iosapp://1234"), None);
        assert_eq!(normalize_url("ssh://host"), None);
        assert_eq!(normalize_url("ftp://files"), None);
        assert_eq!(normalize_url("   "), None);
        assert_eq!(normalize_url(""), None);
    }

    #[test]
    fn normalize_prepends_https_to_bare_host_and_keeps_full_urls() {
        assert_eq!(normalize_url("example.com").as_deref(), Some("https://example.com/"));
        assert_eq!(normalize_url("  example.com/login ").as_deref(), Some("https://example.com/login"));
        assert_eq!(normalize_url("http://insecure.test/").as_deref(), Some("http://insecure.test/"));
        assert_eq!(normalize_url("https://secure.test/a").as_deref(), Some("https://secure.test/a"));
    }

    #[test]
    fn classify_status_flags_404_410_broken_5xx_uncertain_rest_ok() {
        assert_eq!(classify_status(404), LinkStatusKind::Broken);
        assert_eq!(classify_status(410), LinkStatusKind::Broken);
        assert_eq!(classify_status(200), LinkStatusKind::Ok);
        assert_eq!(classify_status(301), LinkStatusKind::Ok);
        assert_eq!(classify_status(403), LinkStatusKind::Ok); // alive, just blocked
        assert_eq!(classify_status(429), LinkStatusKind::Ok);
        assert_eq!(classify_status(500), LinkStatusKind::Uncertain);
        assert_eq!(classify_status(503), LinkStatusKind::Uncertain);
    }

    #[test]
    fn assemble_counts_uniques_and_lists_only_problem_items() {
        let items = vec![
            item("a", &["https://ok.test/", "https://gone.test/"]),
            item("b", &["https://gone.test/", "androidapp://x"]),
            item("c", &["https://ok.test/"]),
        ];
        let mut results = HashMap::new();
        results.insert("https://ok.test/".to_string(), status("https://ok.test/", LinkStatusKind::Ok, Some(200)));
        results.insert("https://gone.test/".to_string(), status("https://gone.test/", LinkStatusKind::Broken, Some(404)));

        let report = assemble_report(&items, &results);

        // Two unique URLs checked; one ok, one broken.
        assert_eq!(report.scanned, 2);
        assert_eq!(report.ok, 1);
        assert_eq!(report.broken, 1);
        assert_eq!(report.unreachable, 0);
        assert_eq!(report.uncertain, 0);
        // One unique skipped scheme (androidapp), counted once.
        assert_eq!(report.skipped, 1);

        // Items a and b own the broken link; c is all-ok → excluded.
        assert_eq!(report.items.len(), 2);
        let ids: Vec<&str> = report.items.iter().map(|i| i.id.as_str()).collect();
        assert!(ids.contains(&"a") && ids.contains(&"b"));
        // Each problem item lists only its broken link (the ok / skipped ones are
        // not noise in the "needs update" list).
        for it in &report.items {
            assert_eq!(it.links.len(), 1);
            assert_eq!(it.links[0].kind, LinkStatusKind::Broken);
        }
    }

    #[test]
    fn assemble_includes_uncertain_and_unreachable_items() {
        let items = vec![
            item("slow", &["https://slow.test/"]),
            item("dead", &["https://dead.test/"]),
        ];
        let mut results = HashMap::new();
        results.insert("https://slow.test/".to_string(), status("https://slow.test/", LinkStatusKind::Uncertain, None));
        results.insert("https://dead.test/".to_string(), status("https://dead.test/", LinkStatusKind::Unreachable, None));

        let report = assemble_report(&items, &results);
        assert_eq!(report.uncertain, 1);
        assert_eq!(report.unreachable, 1);
        assert_eq!(report.items.len(), 2);
    }
}
