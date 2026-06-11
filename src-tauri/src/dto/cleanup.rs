//! Vault-cleanup DTOs (backend → frontend).
//!
//! The link-health checker pings every login URL and reports which ones are dead,
//! so the owning item can be updated. Unlike the security audit this is a
//! *maintenance* concern (stale bookmarks), and it is **on-demand only** — nothing
//! here runs in the background. Implementation: `src-tauri/src/cleanup/`.

use serde::Serialize;

/// Reachability verdict for one checked URL. Skipped URIs (non-web schemes like
/// `androidapp://`, unparseable junk) are never assigned a kind — they only feed
/// the report's aggregate `skipped` count — so there is no `Skipped` variant.
/// - `Ok`: the host answered with a live status (2xx/3xx, or an auth/blocked code
///   like 401/403/405/429 — the site exists, it just didn't serve the page anonymously).
/// - `Broken`: the page is gone (404/410) — needs update.
/// - `Unreachable`: DNS / connection / TLS failure — the host itself is dead — needs update.
/// - `Uncertain`: timeout or 5xx — possibly a transient outage, shown apart from broken.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum LinkStatusKind {
    Ok,
    Broken,
    Unreachable,
    Uncertain,
}

/// One checked URL and its verdict. `http_status` is the final response code when
/// the host answered (after following redirects); absent for unreachable URLs.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LinkStatus {
    pub url: String,
    pub kind: LinkStatusKind,
    pub http_status: Option<u16>,
}

/// A vault item that owns at least one problematic link. `links` lists only the
/// item's URLs that need attention (broken / unreachable / uncertain), each with
/// its verdict, so the user can see exactly which to fix.
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LinkHealthItem {
    pub id: String,
    pub name: String,
    pub account_email: String,
    pub links: Vec<LinkStatus>,
}

/// Aggregate link-health report across every unlocked vault. The counts are over
/// the UNIQUE URLs found (a URL shared by several items is checked once);
/// `scanned == ok + broken + unreachable + uncertain`. `items` holds only the
/// entries needing attention (≥ 1 non-ok link).
#[derive(Debug, Clone, Serialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct LinkCheckReport {
    /// Unique web URLs actually checked over the network (excludes skipped).
    pub scanned: usize,
    pub ok: usize,
    pub broken: usize,
    pub unreachable: usize,
    pub uncertain: usize,
    /// Unique non-web / unparseable URIs that were skipped (e.g. `androidapp://`).
    pub skipped: usize,
    pub items: Vec<LinkHealthItem>,
}
