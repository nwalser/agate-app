//! Harvesting the user's own email addresses to scan: every configured
//! connection's account email plus login usernames / identity emails from each
//! unlocked vault, deduplicated, validated, and sorted for a stable scan window.

use bitwarden_vault::{Cipher, CipherType, CipherView};

use crate::dto::IdentityInput;
use crate::error::{AgateError, AgateResult};
use crate::state::AppState;

/// Loose, conservative email check — enough to avoid sending obvious non-emails
/// (raw usernames, blanks) to the network. Not a full RFC 5322 validator.
pub(super) fn is_email(s: &str) -> bool {
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
pub(super) fn normalize_email(s: &str) -> String {
    s.trim().to_lowercase()
}

/// The result of harvesting addresses to scan.
pub(super) struct Harvest {
    /// All scannable emails — every configured connection's account email (scannable
    /// even while that connection is locked) plus login usernames / identity emails
    /// from each *unlocked* vault. Deduplicated, lowercased, validated, and **sorted**
    /// so the rotating scan window is stable across runs (the session connection map
    /// iterates in nondeterministic order).
    pub(super) emails: Vec<String>,
    /// Configured connections that aren't currently unlocked, so their vault items
    /// couldn't be read this run. Their account email is still scanned; this flags
    /// only that their stored logins/identities went unharvested.
    pub(super) locked_connections: Vec<String>,
}

/// Gather the user's own email addresses to scan: every configured connection's
/// account email (read straight from config, so locked connections still get their
/// address checked) plus login usernames that are emails and identity `email`
/// fields harvested from each *unlocked* vault. Returns `NotAuthenticated` if no
/// connection is open at all.
pub(super) async fn collect_account_emails(state: &AppState) -> AgateResult<Harvest> {
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
    fn normalizes_email() {
        assert_eq!(normalize_email("  Foo@Bar.COM "), "foo@bar.com");
    }
}
