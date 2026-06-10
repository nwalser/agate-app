//! Command-facing scan entry points: scan one email, scan the whole vault (via a
//! rotating window that respects the provider's daily budget), and persist the
//! opt-in consent flag. Throttled to stay under the provider's rate limit.

use std::time::Duration;

use crate::dto::{AccountBreaches, DarkWebReport, EmailError};
use crate::error::{AgateError, AgateResult};
use crate::state::AppState;

use super::emails::{collect_account_emails, is_email, normalize_email, Harvest};
use super::xon::fetch_email;
use super::{http_client, require_consent};

/// XposedOrNot allows ≤2 req/s per IP; stay well under it between vault scans.
const THROTTLE: Duration = Duration::from_millis(600);

/// Cap on emails scanned per vault run, to respect the provider's ~100 req/day
/// per-IP budget. Anything beyond this is reported as `skipped`, never dropped
/// silently.
const MAX_VAULT_EMAILS: usize = 25;

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
        if let Err(e) = state.update_config(|cfg| cfg.darkweb_scan_offset = next_offset).await {
            // Non-fatal: a failed persist just means next run may repeat this window.
            log::warn!("darkweb: failed to persist scan rotation offset: {e}");
        }
    }

    let total_breaches = accounts.iter().map(|a| a.breaches.len()).sum();
    let clean = accounts.iter().filter(|a| a.breaches.is_empty()).count();
    Ok(DarkWebReport { accounts, errored, pending, locked_connections, total_breaches, clean })
}

/// Persist the user's opt-in decision for the dark-web monitor.
pub async fn set_consent(state: &AppState, enabled: bool) -> AgateResult<()> {
    state.update_config(|cfg| cfg.darkweb_consent = enabled).await
}

#[cfg(test)]
mod tests {
    use super::*;

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
