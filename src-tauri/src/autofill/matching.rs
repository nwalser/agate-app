//! Pure matching: rank vault logins against a detected login-field context.
//!
//! This is the testable core of autofill — no Windows, no SDK, no I/O. Given the
//! best-effort context we can scrape from a focused field (a URL when the host is
//! a webview that exposes one, the owning process name, the window title) and the
//! per-login match index, it produces an ordered candidate list for the popup.
//!
//! It ranks across ALL of a login's URIs, not just the first, so a remembered
//! native-app association — stored as a synthetic [`APP_URI_SCHEME`] URI in any
//! slot (e.g. `app://outlook`, mirroring Bitwarden's `androidapp://` mobile
//! associations) — matches even on a login whose primary URI is a real website.
//!
//! Matching is a *ranking*, not a gate: the tray popup is the disambiguation +
//! verification surface, so a weak or empty match just means "let the user pick /
//! search" rather than a failure. Strong matches float to the top.
//!
//! Signals, strongest first: a user-remembered recency boost (last login filled
//! into this target) → synthetic app association → exact URL host →
//! registrable-domain → process-name (exe stem, plus a tiny hint table for app
//! suites whose exe name doesn't carry their domain) → window title.
//! The window title is only consulted when NO URL is present (a native app): in a
//! browser the URL is authoritative and the title is arbitrary page text, so we
//! never let it surface a login by name.
//!
//! Registrable-domain comparison uses the compiled-in Public Suffix List
//! ([`registrable_domain`]), so multi-part suffixes (`example.co.uk`) compare
//! correctly. Matching only *ranks*; it never *grants* access (the popup does).

use crate::dto::{AutofillCandidate, AutofillContext, AutofillField};

/// Cap on returned candidates — the popup is a quick-pick surface. Logins past this
/// are still reachable via the popup's own search over the full vault.
const MAX_CANDIDATES: usize = 20;

/// Substrings (lower-cased) in a field's accessible label that mark it a
/// username / email / login box. A false positive only offers a popup the user
/// can dismiss, while a missed field just falls back to password-only behaviour.
/// `"user"` subsumes "username" / "user id" / "user name". Covers the three
/// shipped UI locales (en / de / es) so a German/Spanish login form is detected —
/// `to_ascii_lowercase` leaves accented bytes intact, so accented hints (e.g.
/// "teléfono") are written with their accents and still match.
const USERNAME_HINTS: &[&str] = &[
    // English
    "user", "email", "e-mail", "login", "log in", "account", "phone",
    // German
    "benutzer", "anmelden", "anmeldung", "konto", "telefon", "e-post",
    // Spanish
    "usuario", "correo", "cuenta", "iniciar sesión", "teléfono", "telefono",
];

/// Substrings (lower-cased) marking a one-time-code / TOTP / 2FA field. Kept to
/// SPECIFIC phrases — never a bare "code" / "código", which appears in benign
/// fields (zip / country / promo / postal code). Checked before [`USERNAME_HINTS`]
/// so a "verification code" box reads as TOTP, not a username. Covers en / de / es.
const TOTP_HINTS: &[&str] = &[
    // English
    "totp",
    "otp",
    "one-time",
    "one time",
    "onetime",
    "verification code",
    "security code",
    "auth code",
    "authenticator",
    "passcode",
    "2fa",
    "mfa",
    "6-digit",
    "6 digit",
    // German
    "einmalkennwort",
    "einmalcode",
    "bestätigungscode",
    "sicherheitscode",
    "authentifizierungscode",
    "verifizierungscode",
    // Spanish
    "código de verificación",
    "código de seguridad",
    "código de autenticación",
    "verificación",
    "autenticación",
];

/// Classify the focused control from its platform-agnostic UIA signals, so the
/// Windows layer stays a thin shim over this testable rule:
/// - `is_password` (the `IsPassword` property) is authoritative → [`AutofillField::Password`].
/// - otherwise an **editable** control (`is_edit`) whose accessible metadata (name /
///   automation-id / help text) names a one-time code → [`AutofillField::Totp`], or
///   a username/email → [`AutofillField::Username`].
/// - anything else → `None`: we never offer on an arbitrary text box.
///
/// Password is checked first so a secret field is never reclassified by a stray
/// keyword; TOTP before username so a "verification code" box isn't read as a
/// username. Metadata is only consulted for non-secret fields.
pub fn classify_field(is_password: bool, is_edit: bool, metadata: &[&str]) -> Option<AutofillField> {
    if is_password {
        return Some(AutofillField::Password);
    }
    if !is_edit {
        return None;
    }
    if metadata.iter().any(|m| label_matches(m, TOTP_HINTS)) {
        return Some(AutofillField::Totp);
    }
    if metadata.iter().any(|m| label_matches(m, USERNAME_HINTS)) {
        return Some(AutofillField::Username);
    }
    None
}

/// Whether an accessible label contains any of `hints` (case-insensitive).
fn label_matches(label: &str, hints: &[&str]) -> bool {
    let label = label.to_ascii_lowercase();
    hints.iter().any(|kw| label.contains(kw))
}

/// Synthetic URI scheme encoding a native-app association (a target with no real
/// URL). The "remember this app for autofill" action stores `app://<process>` in
/// the login's URIs; this matcher recognizes it and matches it against the detected
/// process. Mirrors Bitwarden's own `androidapp://` / `iosapp://` associations.
pub const APP_URI_SCHEME: &str = "app://";

/// Recency boost added to a candidate that the user last filled into THIS target.
/// Large enough to float a remembered choice to the top of the real candidates, but
/// only ever applied to a login that ALREADY matches (`base score > 0`) — recency
/// never invents a match for an unrelated login.
const RECENCY_BOOST: u32 = 1000;

/// Whether a process file stem hosts many unrelated sites under one process, so its
/// process name must NOT drive matching — only a scraped page URL should. Covers
/// web browsers and the shared WebView2 runtime (Teams, and other WebView2 apps,
/// all run as `msedgewebview2`, so the process name identifies the runtime, not the
/// app — the embedded page URL is the real signal). Pure so the Windows UIA layer
/// stays a thin shim over this list.
pub fn is_shared_host_process(stem: &str) -> bool {
    matches!(
        stem,
        "chrome"
            | "msedge"
            | "firefox"
            | "brave"
            | "opera"
            | "opera_gx"
            | "vivaldi"
            | "chromium"
            | "arc"
            | "iexplore"
            | "msedgewebview2"
    )
}

/// Whether a detected process is on the user's autofill denylist ("never offer in
/// this app"). Case-insensitive and tolerant of a stored ".exe" suffix on either
/// side, so "Discord", "discord", and "discord.exe" all match a "discord" entry.
pub fn is_denied(process: &str, denylist: &[String]) -> bool {
    let p = process.trim().trim_end_matches(".exe").to_ascii_lowercase();
    if p.is_empty() {
        return false;
    }
    denylist
        .iter()
        .any(|d| d.trim().trim_end_matches(".exe").to_ascii_lowercase() == p)
}

/// The stable key identifying a detected target for recency ("what did I last fill
/// here"): the URL host when present, else the process name. The window title is
/// deliberately excluded — it changes with page/state and would scatter recency
/// across many keys. None when neither a host nor a process is known.
pub fn recency_key(ctx: &AutofillContext) -> Option<String> {
    if let Some(host) = ctx.url.as_deref().and_then(host_of) {
        return Some(format!("host:{host}"));
    }
    ctx.process_name
        .as_deref()
        .map(normalize)
        .filter(|p| !p.is_empty())
        .map(|p| format!("proc:{p}"))
}

/// A login to rank, with ALL of its URIs so an associated synthetic URI in any slot
/// still matches. Built by `vault::autofill_index`; logins only.
pub struct MatchItem {
    pub id: String,
    pub account_email: String,
    pub account_label: String,
    pub name: String,
    pub username: Option<String>,
    pub uris: Vec<String>,
    pub reprompt: bool,
}

/// The detected context to match against (the matchable subset of
/// [`AutofillContext`]).
#[derive(Debug, Clone, Default)]
pub struct FillContext {
    pub url: Option<String>,
    pub process_name: Option<String>,
    pub window_title: Option<String>,
}

impl FillContext {
    /// Build from the DTO that the platform layer fills in.
    pub fn from_context(ctx: &AutofillContext) -> Self {
        Self {
            url: ctx.url.clone(),
            process_name: ctx.process_name.clone(),
            window_title: ctx.window_title.clone(),
        }
    }
}

/// Rank `items` against `ctx`. Returns only positive-scoring logins, best first
/// (name breaks ties), capped at [`MAX_CANDIDATES`]. Empty means "no confident
/// match" — the caller falls back to the popup's searchable full list.
///
/// `preferred` is the `(account_email, item_id)` the user last filled into this
/// target; a matching candidate gets [`RECENCY_BOOST`] so it floats to the top.
/// The boost only applies to a login that already matches — recency never surfaces
/// an unrelated login.
pub fn rank(
    items: &[MatchItem],
    ctx: &FillContext,
    preferred: Option<(&str, &str)>,
) -> Vec<AutofillCandidate> {
    let (url_host, process, title) = prepared_signals(ctx);

    let mut scored: Vec<(u32, &MatchItem)> = items
        .iter()
        .filter_map(|it| {
            let s = score_item(it, url_host.as_deref(), process.as_deref(), title.as_deref());
            if s == 0 {
                return None;
            }
            let is_preferred =
                preferred.is_some_and(|(e, id)| e == it.account_email && id == it.id);
            Some((s + if is_preferred { RECENCY_BOOST } else { 0 }, it))
        })
        .collect();

    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    scored.truncate(MAX_CANDIDATES);

    scored
        .into_iter()
        .map(|(score, it)| AutofillCandidate {
            account_email: it.account_email.clone(),
            account_label: it.account_label.clone(),
            item_id: it.id.clone(),
            name: it.name.clone(),
            username: it.username.clone(),
            uri: display_uri(it),
            reprompt: it.reprompt,
            score,
        })
        .collect()
}

/// Count how many of `items` match `ctx` at all (positive score). Unlike [`rank`]
/// this is uncapped and allocates nothing — it feeds the tray match-count badge,
/// which wants the true total (incl. past [`MAX_CANDIDATES`]), not a ranked list.
// The only non-test caller (`autofill::refresh_badge`) is Windows-only; keep the
// pure fn compiled + tested everywhere, just don't warn where nothing calls it.
#[cfg_attr(not(windows), allow(dead_code))]
pub fn count_matches(items: &[MatchItem], ctx: &FillContext) -> usize {
    let (url_host, process, title) = prepared_signals(ctx);
    items
        .iter()
        .filter(|it| score_item(it, url_host.as_deref(), process.as_deref(), title.as_deref()) > 0)
        .count()
}

/// Prepare the normalized matching signals shared by [`rank`] and [`count_matches`].
/// A real URL is authoritative: in a browser/webview the window title is arbitrary
/// PAGE text (an article that merely mentions a brand), so when a URL is present we
/// match on it ALONE and never let the title surface a login by name. The title is a
/// signal only when no URL is available — a native app, where it is app chrome.
fn prepared_signals(ctx: &FillContext) -> (Option<String>, Option<String>, Option<String>) {
    let url_host = ctx.url.as_deref().and_then(host_of);
    let process = ctx.process_name.as_deref().map(normalize);
    let title = if ctx.url.is_some() { None } else { ctx.window_title.as_deref().map(normalize) };
    (url_host, process, title)
}

/// The URI to show for a candidate: the first real (non-synthetic) URI, else the
/// first URI (so a native-app-only login still shows its association).
fn display_uri(item: &MatchItem) -> Option<String> {
    item.uris
        .iter()
        .find(|u| app_uri_target(u).is_none())
        .or_else(|| item.uris.first())
        .cloned()
}

/// Score one login against the prepared (already-normalized) signals.
fn score_item(
    item: &MatchItem,
    url_host: Option<&str>,
    process: Option<&str>,
    title: Option<&str>,
) -> u32 {
    let mut score = 0u32;
    let name = normalize(&item.name);

    // 1. URL host — strongest real-URL signal, across every URI.
    if let Some(target) = url_host {
        for uri in &item.uris {
            if let Some(ih) = host_of(uri) {
                score = score.max(host_match_score(target, &ih));
            }
        }
    }

    // 2. Process name.
    if let Some(proc) = process {
        if !proc.is_empty() {
            // 2a. Synthetic app:// association — the explicit "remember this app".
            if item.uris.iter().any(|u| app_uri_matches(u, proc)) {
                score += 100;
            }
            // 2b. The .exe stem appears in a URI host or the item name.
            let host_hit =
                item.uris.iter().any(|u| host_of(u).is_some_and(|h| token_overlap(proc, &h)));
            if host_hit || token_overlap(proc, &name) {
                score += 50;
            }
            // 2c. Suite hint (e.g. outlook → microsoftonline).
            for kw in process_hint_keywords(proc) {
                let in_host = item.uris.iter().any(|u| host_of(u).is_some_and(|h| h.contains(kw)));
                if in_host || name.contains(kw) {
                    score += 45;
                    break;
                }
            }
        }
    }

    // 3. Window title — the item name or a URI host surfacing in the title. Only
    //    reached when no URL was present (`rank` zeroes the title under a URL), so this
    //    name-based fallback never fires in a browser.
    if let Some(t) = title {
        if !t.is_empty() {
            let host_in_title = item.uris.iter().any(|u| {
                host_of(u)
                    .and_then(|h| h.split('.').next().map(std::string::ToString::to_string))
                    .is_some_and(|label| label.len() >= 3 && t.contains(&label))
            });
            if host_in_title {
                score += 30;
            }
            if name.len() >= 3 && t.contains(&name) {
                score += 40;
            }
        }
    }

    score
}

/// Score how well a target host matches an item host: an exact host is the strongest
/// signal; the same registrable domain (eTLD+1) is a confident site-level match
/// (`accounts.google.com` ↔ `google.com`). There is deliberately NO looser
/// suffix-overlap tier — it would let `evil-github.com` match `github.com` (a phishing
/// footgun) without being a meaningful "same site" signal. Path / query never
/// participate (`host_of` already drops them).
fn host_match_score(target: &str, item: &str) -> u32 {
    if target == item {
        100
    } else if registrable_domain(target) == registrable_domain(item) {
        80
    } else {
        0
    }
}

/// Whether `needle` (a process stem) overlaps `haystack` either direction —
/// substring match, guarding against trivially short stems matching everything.
fn token_overlap(needle: &str, haystack: &str) -> bool {
    if needle.len() < 3 {
        return false;
    }
    haystack.contains(needle) || (needle.contains(haystack) && haystack.len() >= 3)
}

/// The target of a synthetic `app://<id>` URI (lowercased, trailing slash dropped),
/// or None if it isn't one.
fn app_uri_target(uri: &str) -> Option<String> {
    let lower = uri.trim().to_ascii_lowercase();
    let rest = lower.strip_prefix(APP_URI_SCHEME)?.trim_end_matches('/');
    (!rest.is_empty()).then(|| rest.to_string())
}

/// Whether a synthetic `app://` URI matches the detected process (which is an .exe
/// stem with no extension, e.g. "outlook"). Tolerates a stored ".exe" suffix.
fn app_uri_matches(uri: &str, process: &str) -> bool {
    app_uri_target(uri).is_some_and(|t| t.trim_end_matches(".exe") == process)
}

/// Hint keywords for application suites whose executable name does not contain
/// their login domain. Deliberately tiny and conservative. Keyed by .exe stem.
fn process_hint_keywords(process: &str) -> &'static [&'static str] {
    const MICROSOFT: &[&str] = &["microsoft", "microsoftonline", "office", "outlook", "live"];
    match process {
        "outlook" | "teams" | "ms-teams" | "onedrive" | "onenote" | "winword" | "excel"
        | "powerpnt" | "lync" => MICROSOFT,
        _ => &[],
    }
}

/// Extract a comparable host from a URL or stored URI: drop the scheme, any path /
/// query, the port, and a leading "www.", lowercased. Returns None for inputs with
/// no host-like part (incl. synthetic `app://<id>` whose target has no dot).
fn host_of(raw: &str) -> Option<String> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    let after_scheme = match s.find("://") {
        Some(i) => &s[i + 3..],
        None => s,
    };
    let host_port = after_scheme.split(['/', '?', '#']).next().unwrap_or(after_scheme);
    let host = host_port
        .rsplit('@')
        .next()
        .unwrap_or(host_port)
        .split(':')
        .next()
        .unwrap_or(host_port);
    let host = host.trim().trim_start_matches("www.").to_ascii_lowercase();
    if host.is_empty() || !host.contains('.') {
        return None;
    }
    Some(host)
}

/// The registrable domain (eTLD+1) of a host, via the compiled-in Public Suffix
/// List — so `foo.example.co.uk` and `bar.example.co.uk` both reduce to
/// `example.co.uk` (and don't collide at `co.uk`). Falls back to the naive
/// last-two-labels rule when the PSL can't resolve the suffix (unknown / private
/// TLD), so an exotic host still compares sanely. Used only for ranking — never to
/// grant access.
fn registrable_domain(host: &str) -> String {
    psl::domain_str(host).map_or_else(|| naive_base_domain(host), str::to_string)
}

/// Last-two-labels fallback for hosts the PSL doesn't recognize.
fn naive_base_domain(host: &str) -> String {
    let labels: Vec<&str> = host.split('.').filter(|l| !l.is_empty()).collect();
    let n = labels.len();
    if n >= 2 {
        format!("{}.{}", labels[n - 2], labels[n - 1])
    } else {
        host.to_string()
    }
}

fn normalize(s: &str) -> String {
    s.trim().to_ascii_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mi(id: &str, name: &str, username: Option<&str>, uris: &[&str]) -> MatchItem {
        MatchItem {
            id: id.to_string(),
            account_email: "me@example.com".to_string(),
            account_label: "Bitwarden".to_string(),
            name: name.to_string(),
            username: username.map(str::to_string),
            uris: uris.iter().map(std::string::ToString::to_string).collect(),
            reprompt: false,
        }
    }

    #[test]
    fn password_field_is_classified_regardless_of_metadata() {
        // IsPassword wins even with no/odd metadata, and is never re-read as a username.
        assert_eq!(classify_field(true, false, &[]), Some(AutofillField::Password));
        assert_eq!(classify_field(true, true, &["Username"]), Some(AutofillField::Password));
    }

    #[test]
    fn editable_field_named_like_a_username_is_a_username_field() {
        for label in ["Username", "Email", "E-mail address", "User ID", "Account", "Phone", "Sign in / Login"] {
            assert_eq!(
                classify_field(false, true, &[label]),
                Some(AutofillField::Username),
                "{label:?} should read as a username field"
            );
        }
    }

    #[test]
    fn editable_field_named_like_a_one_time_code_is_a_totp_field() {
        for label in
            ["Verification code", "One-time code", "Authenticator code", "TOTP", "Enter the 6-digit code", "2FA code"]
        {
            assert_eq!(
                classify_field(false, true, &[label]),
                Some(AutofillField::Totp),
                "{label:?} should read as a one-time-code field"
            );
        }
    }

    #[test]
    fn totp_wins_over_username_when_a_label_could_be_either() {
        // A "code" field on an account page must not be mistaken for a username.
        assert_eq!(
            classify_field(false, true, &["Account verification code"]),
            Some(AutofillField::Totp)
        );
    }

    #[test]
    fn bare_code_words_do_not_trigger_totp() {
        // Benign "…code" fields are not one-time codes — must NOT offer as TOTP.
        for label in ["Zip code", "Country code", "Promo code", "Postal code"] {
            assert_ne!(
                classify_field(false, true, &[label]),
                Some(AutofillField::Totp),
                "{label:?} must not read as a one-time-code field"
            );
        }
    }

    #[test]
    fn metadata_match_in_any_slot_counts() {
        // name / automation-id / help-text are passed together; a hit in any wins.
        assert_eq!(
            classify_field(false, true, &["", "loginEmail", ""]),
            Some(AutofillField::Username)
        );
    }

    #[test]
    fn non_editable_or_unlabelled_fields_are_not_offered() {
        // A username-looking label on a non-edit control → no offer.
        assert_eq!(classify_field(false, false, &["Username"]), None);
        // An edit control with no login-ish label (a search/note box) → no offer.
        assert_eq!(classify_field(false, true, &["Search", "To", "Subject"]), None);
    }

    #[test]
    fn url_exact_host_beats_domain_match() {
        let items = vec![
            mi("a", "GitHub", Some("u"), &["https://github.com/login"]),
            mi("b", "GH Enterprise", Some("u"), &["https://ci.github.com"]),
        ];
        let ctx = FillContext { url: Some("https://github.com/session".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out[0].item_id, "a", "exact host wins over a subdomain of the same base");
        assert!(out[0].score > out[1].score);
    }

    #[test]
    fn url_matches_ignoring_www_and_scheme_and_port() {
        let items = vec![mi("a", "Example", Some("u"), &["example.com"])];
        let ctx =
            FillContext { url: Some("https://www.example.com:443/login?x=1".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].score, 100, "www/scheme/port/path stripped → exact host");
    }

    #[test]
    fn url_matches_a_secondary_uri_not_just_the_first() {
        // The detected site is the login's SECOND URI — matching must scan all.
        let items = vec![mi("a", "Acme", Some("u"), &["https://acme.com", "https://acme.org"])];
        let ctx = FillContext { url: Some("https://acme.org/login".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].score, 100);
    }

    #[test]
    fn synthetic_app_uri_matches_the_detected_process() {
        // A "remembered" native-app login: its primary URI is a real site, and a
        // synthetic app:// URI carries the association — it must still match.
        let items = vec![
            mi("ms", "Microsoft 365", Some("me@corp.com"), &["https://portal.example", "app://outlook"]),
            mi("other", "Bank", Some("u"), &["https://bank.example"]),
        ];
        let ctx = FillContext { process_name: Some("outlook".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out[0].item_id, "ms");
        assert!(out[0].score >= 100, "the synthetic association is a strong match");
    }

    #[test]
    fn synthetic_app_uri_tolerates_an_exe_suffix() {
        let items = vec![mi("a", "App", Some("u"), &["app://Outlook.exe"])];
        let ctx = FillContext { process_name: Some("outlook".into()), ..Default::default() };
        assert_eq!(rank(&items, &ctx, None)[0].item_id, "a");
    }

    #[test]
    fn process_name_matches_item_by_host_token() {
        let items = vec![
            mi("a", "GitHub", Some("u"), &["https://github.com"]),
            mi("b", "Bank", Some("u"), &["https://mybank.example"]),
        ];
        let ctx = FillContext { process_name: Some("GitHub".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].item_id, "a");
    }

    #[test]
    fn outlook_process_hint_matches_microsoft_login() {
        let items = vec![
            mi("ms", "Microsoft 365", Some("me@corp.com"), &["https://login.microsoftonline.com"]),
            mi("other", "Some Bank", Some("u"), &["https://bank.example"]),
        ];
        let ctx = FillContext { process_name: Some("outlook".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out[0].item_id, "ms", "outlook hint keyword matches microsoftonline host");
    }

    #[test]
    fn window_title_matches_item_name() {
        // Native app (no URL): the window title is the app's own chrome, so it is a
        // valid last-resort signal.
        let items = vec![mi("a", "GitLab", Some("u"), &[])];
        let ctx = FillContext { window_title: Some("Sign in · GitLab".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].item_id, "a");
    }

    #[test]
    fn browser_url_context_ignores_window_title_name() {
        // In a browser the window title is arbitrary PAGE text, not app chrome: a page
        // that merely NAMES a login (a news article about PayPal) must not surface that
        // login. With a URL present, matching is URL-only — never by name. The platform
        // layer suppresses the (shared-host) process name, leaving url + title.
        let items = vec![mi("pp", "PayPal", Some("u"), &["https://paypal.com"])];
        let ctx = FillContext {
            url: Some("https://news.example.com/article".into()),
            window_title: Some("PayPal launches new feature — Example News".into()),
            process_name: None,
        };
        assert!(
            rank(&items, &ctx, None).is_empty(),
            "a browser page that only mentions a login by name must not match it"
        );
    }

    #[test]
    fn no_signal_yields_no_candidates() {
        let items = vec![mi("a", "GitHub", Some("u"), &["https://github.com"])];
        let ctx = FillContext { window_title: Some("Untitled - Notepad".into()), ..Default::default() };
        assert!(rank(&items, &ctx, None).is_empty(), "an unrelated window must not match");
    }

    #[test]
    fn combined_signals_outrank_single_signal() {
        let items = vec![
            mi("strong", "GitHub", Some("u"), &["https://github.com"]),
            mi("weak", "GitHub Mirror", Some("u"), &["https://example.org"]),
        ];
        let ctx = FillContext {
            url: Some("https://github.com/login".into()),
            window_title: Some("Sign in to GitHub".into()),
            process_name: None,
        };
        let out = rank(&items, &ctx, None);
        assert_eq!(out[0].item_id, "strong");
        assert!(out[0].score > out.iter().find(|c| c.item_id == "weak").map_or(0, |c| c.score));
    }

    #[test]
    fn results_are_capped() {
        let items: Vec<MatchItem> =
            (0..50).map(|i| mi(&format!("i{i}"), "GitHub", Some("u"), &["https://github.com"])).collect();
        let ctx = FillContext { url: Some("https://github.com".into()), ..Default::default() };
        assert_eq!(rank(&items, &ctx, None).len(), MAX_CANDIDATES);
    }

    // ── count_matches (tray badge) ───────────────────────────────────────────

    #[test]
    fn count_matches_counts_all_positive_scores_uncapped() {
        // rank() caps at MAX_CANDIDATES; the badge count must be the true total.
        let items: Vec<MatchItem> = (0..50)
            .map(|i| mi(&format!("i{i}"), "GitHub", Some("u"), &["https://github.com"]))
            .collect();
        let ctx = FillContext { url: Some("https://github.com".into()), ..Default::default() };
        assert_eq!(rank(&items, &ctx, None).len(), MAX_CANDIDATES);
        assert_eq!(count_matches(&items, &ctx), 50, "count is uncapped");
    }

    #[test]
    fn count_matches_is_zero_without_a_signal() {
        let items = vec![mi("a", "GitHub", Some("u"), &["https://github.com"])];
        let ctx = FillContext { window_title: Some("Untitled - Notepad".into()), ..Default::default() };
        assert_eq!(count_matches(&items, &ctx), 0);
    }

    #[test]
    fn count_matches_counts_only_matching_logins() {
        let items = vec![
            mi("a", "GitHub Personal", Some("me"), &["https://github.com"]),
            mi("b", "GitHub Work", Some("work"), &["https://github.com"]),
            mi("c", "Bank", Some("u"), &["https://bank.example"]),
        ];
        let ctx = FillContext { url: Some("https://github.com/login".into()), ..Default::default() };
        assert_eq!(count_matches(&items, &ctx), 2, "two github logins, the bank excluded");
    }

    // ── i18n field hints (de / es) ───────────────────────────────────────────

    #[test]
    fn german_and_spanish_username_labels_classify() {
        for label in ["Benutzername", "Anmeldung", "Konto", "Usuario", "Correo electrónico", "Cuenta", "Teléfono"] {
            assert_eq!(
                classify_field(false, true, &[label]),
                Some(AutofillField::Username),
                "{label:?} should read as a username field"
            );
        }
    }

    #[test]
    fn german_and_spanish_one_time_code_labels_classify() {
        for label in
            ["Bestätigungscode", "Sicherheitscode", "Einmalkennwort", "Código de verificación", "Código de seguridad"]
        {
            assert_eq!(
                classify_field(false, true, &[label]),
                Some(AutofillField::Totp),
                "{label:?} should read as a one-time-code field"
            );
        }
    }

    #[test]
    fn spanish_postal_code_is_not_a_one_time_code() {
        // "código postal" must not be mistaken for a one-time code (mirrors the
        // English bare-"code" guard).
        assert_ne!(classify_field(false, true, &["Código postal"]), Some(AutofillField::Totp));
    }

    // ── registrable domain via the PSL ───────────────────────────────────────

    #[test]
    fn multipart_public_suffix_does_not_collide() {
        // Two unrelated co.uk sites must NOT match each other on the domain rule —
        // the naive last-two-labels rule would have collided them at "co.uk".
        let items = vec![mi("a", "Foo", Some("u"), &["https://foo.co.uk"])];
        let ctx = FillContext { url: Some("https://bar.co.uk/login".into()), ..Default::default() };
        assert!(rank(&items, &ctx, None).is_empty(), "different co.uk registrable domains must not match");
    }

    #[test]
    fn subdomain_matches_base_domain_but_a_lookalike_does_not() {
        // The matching rule: same registrable domain matches (subdomains included), so
        // welcome.hello.com ↔ hello.com. A DIFFERENT registrable domain that merely ends
        // with the same string (a phishing lookalike) must NOT match — the removed loose
        // suffix-overlap tier used to match it, which was a footgun.
        let items = vec![mi("a", "Hello", Some("u"), &["https://hello.com"])];

        let sub = FillContext { url: Some("https://welcome.hello.com/login".into()), ..Default::default() };
        assert_eq!(rank(&items, &sub, None).first().map(|c| c.score), Some(80));

        let evil = FillContext { url: Some("https://evil-hello.com/login".into()), ..Default::default() };
        assert!(rank(&items, &evil, None).is_empty(), "a lookalike registrable domain must not match");
    }

    #[test]
    fn subdomains_of_a_multipart_suffix_match_on_registrable_domain() {
        // app.example.co.uk and www.example.co.uk share the registrable domain.
        let items = vec![mi("a", "Example", Some("u"), &["https://app.example.co.uk"])];
        let ctx = FillContext { url: Some("https://www.example.co.uk/login".into()), ..Default::default() };
        let out = rank(&items, &ctx, None);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].score, 80, "same registrable domain, different host → domain-level match");
    }

    // ── recency boost ────────────────────────────────────────────────────────

    #[test]
    fn preferred_candidate_floats_above_an_equal_match() {
        let items = vec![
            mi("a", "GitHub Personal", Some("me"), &["https://github.com"]),
            mi("b", "GitHub Work", Some("work"), &["https://github.com"]),
        ];
        let ctx = FillContext { url: Some("https://github.com/login".into()), ..Default::default() };
        // Without recency, "GitHub Personal" wins on the name tiebreak.
        assert_eq!(rank(&items, &ctx, None)[0].item_id, "a");
        // With "b" remembered for this target, it floats to the top.
        let out = rank(&items, &ctx, Some(("me@example.com", "b")));
        assert_eq!(out[0].item_id, "b");
        assert!(out[0].score > out[1].score);
    }

    #[test]
    fn recency_never_surfaces_a_non_matching_login() {
        // The remembered login doesn't match the current target at all → it must
        // NOT appear just because it was once used elsewhere.
        let items = vec![mi("a", "Unrelated", Some("u"), &["https://elsewhere.example"])];
        let ctx = FillContext { url: Some("https://github.com/login".into()), ..Default::default() };
        assert!(rank(&items, &ctx, Some(("me@example.com", "a"))).is_empty());
    }

    // ── shared-host process classification ───────────────────────────────────

    #[test]
    fn browsers_and_webview2_are_shared_host_processes() {
        for p in ["chrome", "msedge", "firefox", "msedgewebview2"] {
            assert!(is_shared_host_process(p), "{p} should be shared-host");
        }
        for p in ["outlook", "slack", "discord", "1password"] {
            assert!(!is_shared_host_process(p), "{p} should NOT be shared-host");
        }
    }

    // ── denylist ─────────────────────────────────────────────────────────────

    #[test]
    fn denylist_matches_case_and_exe_insensitively() {
        let deny = vec!["Discord".to_string(), "steam.exe".to_string()];
        assert!(is_denied("discord", &deny));
        assert!(is_denied("Discord.exe", &deny));
        assert!(is_denied("STEAM", &deny));
        assert!(!is_denied("chrome", &deny));
        assert!(!is_denied("", &deny));
    }

    // ── recency key ──────────────────────────────────────────────────────────

    #[test]
    fn recency_key_prefers_host_then_process() {
        let host_ctx = AutofillContext {
            url: Some("https://www.github.com/login".into()),
            process_name: Some("chrome".into()),
            ..Default::default()
        };
        assert_eq!(recency_key(&host_ctx).as_deref(), Some("host:github.com"));

        let app_ctx = AutofillContext { process_name: Some("Outlook".into()), ..Default::default() };
        assert_eq!(recency_key(&app_ctx).as_deref(), Some("proc:outlook"));

        // Title-only target has no stable recency key.
        let title_ctx = AutofillContext { window_title: Some("Sign in".into()), ..Default::default() };
        assert_eq!(recency_key(&title_ctx), None);
    }
}
