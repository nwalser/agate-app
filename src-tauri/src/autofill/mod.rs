//! Autofill — watch other applications' login fields and fill the matching vault
//! login directly, with no clipboard and no copy-paste.
//!
//! Flow: a platform watcher (Windows UIA) detects a focused / foreground password
//! field, records a [`PendingTarget`] (context + native window handle + a one-shot
//! token) in [`AppState`], shows the tray popup, and emits `autofill://detected`.
//! The popup reads [`pending`] (which ranks the unified vault against the context
//! via [`matching`]), the user picks a login, and [`fill`] fetches the secret and
//! injects it into the original window.
//!
//! Security posture (this is a password manager):
//! - **Opt-in, off by default.** [`AutofillMode::Off`] inspects nothing.
//!   [`AutofillMode::Hotkey`] inspects the foreground window only when the user
//!   presses the hotkey. [`AutofillMode::Watch`] installs a focus hook (largest
//!   surface) — the user chooses it explicitly in Settings.
//! - **The popup is the verification gate.** Nothing fills without the user
//!   picking the login in the popup; reprompt-protected items defer to the main
//!   window exactly as the copy path does.
//! - **Almost no window contents cross IPC.** UIA inspection stays in the backend;
//!   only the minimal [`AutofillContext`] (process name / title / best-effort URL)
//!   and ranked candidate metadata are sent to the popup. Secrets are fetched only
//!   at fill time and zeroized after injection. The one deliberate exception is
//!   [`AutofillContext::typed_username`]: when nothing in the vault matches, the
//!   text already in the target's username/email box is read so the "save a new
//!   login here" prompt can prefill it. It is a username/email, **never** a
//!   password (`IsPassword` controls are never read), and rides this same opt-in.
//! - **The one-shot token** binds a fill to the exact detection that raised the
//!   popup, so a stale popup can't fill into a window that has since changed.
//!
//! Platform support: detection + injection are Windows-only (`uia` / `inject` /
//! `watcher`). On other platforms the engine compiles, reports `supported = false`,
//! and refuses to arm a mode — the macOS (AXUIElement) / Linux (AT-SPI) backends
//! are future work, mirroring the tray popup's Windows/macOS-only note.

mod matching;

/// The per-login match index built by `vault::autofill_index` (all URIs per login).
pub(crate) use matching::MatchItem;

#[cfg(windows)]
mod inject;
#[cfg(windows)]
mod uia;
#[cfg(windows)]
mod watcher;

use tauri::{Emitter, Manager};
use zeroize::Zeroizing;

use crate::dto::{AutofillContext, AutofillField, AutofillMode, AutofillPending, AutofillStatus};
use crate::error::{AgateError, AgateResult};
use crate::state::AppState;
use crate::vault;

/// The Tauri event the popup listens for to enter fill mode.
pub const DETECTED_EVENT: &str = "autofill://detected";

/// Display label for the on-demand hotkey (see `watcher` for the real binding).
pub const HOTKEY_LABEL: &str = "Ctrl+Alt+\\";

/// A detected login target awaiting the user's pick. Held in [`AppState`] behind a
/// std `Mutex` because the Windows focus-hook callback is synchronous and cannot
/// await a tokio mutex.
pub struct PendingTarget {
    /// One-shot token bound to this detection; `fill` rejects a mismatched token.
    pub token: String,
    /// Non-secret context shown in the popup header + matched against the vault.
    pub context: AutofillContext,
    /// Native window handle to bring forward + fill into. `0` / unused off-Windows.
    pub hwnd: isize,
}

/// Shared autofill runtime state. Just the single pending target — the mode lives
/// in the persisted config, and the watcher owns its own thread handle.
#[derive(Default)]
pub struct AutofillShared {
    pub pending: Option<PendingTarget>,
}

/// Whether this platform / build can actually watch + inject.
pub fn supported() -> bool {
    cfg!(windows)
}

/// Feature status for the Settings page + popup gating.
pub async fn status(state: &AppState) -> AutofillStatus {
    let cfg = state.config.lock().await;
    AutofillStatus {
        mode: cfg.autofill_mode,
        supported: supported(),
        hotkey: HOTKEY_LABEL.to_string(),
        submit: cfg.autofill_submit,
        denylist: cfg.autofill_denylist.clone(),
    }
}

/// Switch the detection mode: persist it, then (re)start or stop the watcher.
/// Refuses any non-Off mode on a platform that can't honour it, so the user never
/// arms something that silently does nothing.
pub async fn set_mode(
    app: &tauri::AppHandle,
    state: &AppState,
    mode: AutofillMode,
) -> AgateResult<()> {
    if mode != AutofillMode::Off && !supported() {
        return Err(AgateError::bad_request(
            "Autofill watching isn't available on this platform yet.",
        ));
    }
    state.update_config(|c| c.autofill_mode = mode).await?;
    // Stop the watcher and clear any stale target when turning the feature off, so
    // a leftover detection can't be filled after the user disables it.
    if mode == AutofillMode::Off {
        clear_pending(state);
    }
    apply_mode(app.clone(), mode);
    Ok(())
}

/// Apply a mode to the platform watcher (start / restart / stop). Called by
/// `set_mode` and once at launch.
pub fn apply_mode(app: tauri::AppHandle, mode: AutofillMode) {
    #[cfg(windows)]
    {
        watcher::apply(app, mode);
    }
    #[cfg(not(windows))]
    {
        let _ = (app, mode);
    }
}

/// Persist whether a successful fill presses Enter to submit the form.
pub async fn set_submit(state: &AppState, submit: bool) -> AgateResult<()> {
    state.update_config(|c| c.autofill_submit = submit).await
}

/// Persist the per-app denylist and refresh the live watcher snapshot, so a newly
/// denied app stops being offered immediately (no mode toggle needed).
pub async fn set_denylist(state: &AppState, denylist: Vec<String>) -> AgateResult<()> {
    state.update_config(|c| c.autofill_denylist = denylist.clone()).await?;
    push_denylist(denylist);
    Ok(())
}

/// Push the denylist into the platform watcher's snapshot. The watcher thread is
/// synchronous and can't await the config mutex, so it reads this snapshot instead.
/// Called on every denylist change and once at launch. No-op off-Windows.
pub fn push_denylist(denylist: Vec<String>) {
    #[cfg(windows)]
    {
        watcher::set_denylist_snapshot(denylist);
    }
    #[cfg(not(windows))]
    {
        let _ = denylist;
    }
}

/// The current pending target with its ranked candidates, or `None` when nothing is
/// awaiting a pick. Ranks the unified vault against the detected context; an empty
/// candidate list just means "no confident match" — the popup falls back to its own
/// search over the full vault.
pub async fn pending(state: &AppState) -> AgateResult<Option<AutofillPending>> {
    let (token, context) = {
        let shared = state.autofill.lock().unwrap_or_else(|e| e.into_inner());
        match &shared.pending {
            Some(p) => (p.token.clone(), p.context.clone()),
            None => return Ok(None),
        }
    };
    // The login the user last filled into THIS target floats to the top of the
    // ranked list (recency). Looked up by the target's stable key.
    let preferred = match matching::recency_key(&context) {
        Some(key) => state.config.lock().await.recent_fill_for(&key),
        None => None,
    };
    // The match index covers every unlocked login with ALL its URIs (so a synthetic
    // app:// association in any slot matches). Empty when locked → zero candidates,
    // never an error.
    let items = vault::autofill_index(state).await?;
    let fc = matching::FillContext::from_context(&context);
    let preferred_ref = preferred.as_ref().map(|(e, id)| (e.as_str(), id.as_str()));
    let candidates = matching::rank(&items, &fc, preferred_ref);
    Ok(Some(AutofillPending { token, context, candidates }))
}

/// Fill the chosen login into the detected target. Validates the one-shot token,
/// fetches the secret (zeroized after injection), injects it, then clears the
/// target and hides the popup.
pub async fn fill(
    app: &tauri::AppHandle,
    state: &AppState,
    token: &str,
    account_email: &str,
    item_id: &str,
) -> AgateResult<()> {
    // Take the handle + detected field kind + context only if the token matches the
    // live detection. The field kind decides what we type: a password box gets the
    // password, a username/email box gets the username. The context drives recency.
    let (hwnd, field, context) = {
        let shared = state.autofill.lock().unwrap_or_else(|e| e.into_inner());
        match &shared.pending {
            Some(p) if p.token == token => (p.hwnd, p.context.field, p.context.clone()),
            _ => {
                return Err(AgateError::bad_request(
                    "This autofill prompt is no longer valid — try again.",
                ))
            }
        }
    };

    let detail = vault::item_detail(state, account_email, item_id).await?;
    if detail.reprompt {
        // The popup gates reprompt items before calling us, but never trust the
        // client: refuse to inject a master-password-protected secret here too.
        return Err(AgateError::bad_request(
            "This item requires the master password — open Agate to use it.",
        ));
    }
    let login = detail
        .login
        .ok_or_else(|| AgateError::bad_request("That item isn't a login."))?;

    // Gather every value the injector might need. The username field fills BOTH the
    // username and (tab →) the password, and the live focused control is re-checked
    // at inject time, so we pass all three regardless of `field` and let the
    // injector pick. Secrets stay in `Zeroizing`; the username isn't secret.
    let has_totp = login.totp.as_deref().map(|t| !t.is_empty()).unwrap_or(false);
    let username = login.username;
    let password = login.password.map(Zeroizing::new);

    // Guard the detected field's required value up front so the user gets a clear
    // message instead of a silent no-op.
    match field {
        AutofillField::Password if password.is_none() => {
            return Err(AgateError::bad_request("That login has no password."))
        }
        AutofillField::Username if username.is_none() => {
            return Err(AgateError::bad_request("That login has no username."))
        }
        AutofillField::Totp if !has_totp => {
            return Err(AgateError::bad_request("That login has no one-time code."))
        }
        _ => {}
    }

    // Generate the current TOTP code only when the item actually has one (a fresh
    // crypto computation); the injector types it into a detected one-time-code field.
    let totp = if has_totp {
        Some(Zeroizing::new(vault::item_totp(state, account_email, item_id).await?.code))
    } else {
        None
    };

    // Press Enter after filling to submit the form, only if the user opted in.
    let submit = state.config.lock().await.autofill_submit;

    // A fill re-activates the target window; suppress the watcher so that window's
    // focus event doesn't immediately re-open the popup over what we just filled.
    #[cfg(windows)]
    watcher::suppress_for(2000);
    inject_blocking(hwnd, field, username, password, totp, submit).await?;

    // Remember this pick for the target so the picker offers it first next time.
    // Best-effort: a recency-write failure must never fail the fill itself.
    if let Some(key) = matching::recency_key(&context) {
        if let Err(e) = state
            .update_config(|c| c.record_recent_fill(&key, account_email, item_id))
            .await
        {
            log::warn!("autofill: could not record recent fill: {}", e.message);
        }
    }

    clear_pending(state);
    if let Some(popup) = app.get_webview_window("tray") {
        let _ = popup.hide();
    }
    Ok(())
}

/// Discard the pending target without filling (the user dismissed the popup).
/// Briefly suppress the watcher: hiding the popup re-activates the target window,
/// and that focus storm must not immediately re-offer what was just dismissed —
/// while a deliberate later click on the field should (and does) re-offer.
pub async fn dismiss(state: &AppState) {
    clear_pending(state);
    #[cfg(windows)]
    watcher::suppress_for(500);
}

/// Clear any pending detection given an app handle. Called when the popup is
/// opened or closed via the tray icon (not an autofill flow) so a stale detection
/// never renders fill mode on a normal open. Safe to call anytime.
pub fn clear_pending_for(app: &tauri::AppHandle) {
    clear_pending(&app.state::<AppState>());
}

/// Close the autofill popup IF a detection is currently open: clear the pending
/// target and hide the popup. Called by the watcher when focus moves to a
/// non-password field or away, so the picker gets out of the way. No-op when
/// nothing is pending (e.g. the popup was opened from the tray, or already filled).
#[cfg(windows)]
pub(crate) fn dismiss_popup_if_pending(app: &tauri::AppHandle) {
    let had_pending = {
        let state = app.state::<AppState>();
        let mut shared = state.autofill.lock().unwrap_or_else(|e| e.into_inner());
        let had = shared.pending.is_some();
        shared.pending = None;
        had
    };
    if had_pending {
        if let Some(popup) = app.get_webview_window("tray") {
            let _ = popup.hide();
        }
    }
}

fn clear_pending(state: &AppState) {
    state.autofill.lock().unwrap_or_else(|e| e.into_inner()).pending = None;
}

/// Inject the chosen login's value(s) into the target window on a blocking thread
/// (it sleeps to let the re-activated window settle, re-checks the live focused
/// field via UIA, then synthesizes keystrokes). The injector picks what to type
/// from `field` + the live focus: a password box gets the password, a username box
/// gets username→tab→password, a one-time-code box gets the TOTP. Windows only;
/// errors as a typed failure elsewhere, though `supported()` keeps a target from
/// ever being recorded on those platforms.
#[allow(unused_variables)]
async fn inject_blocking(
    hwnd: isize,
    field: AutofillField,
    username: Option<String>,
    password: Option<Zeroizing<String>>,
    totp: Option<Zeroizing<String>>,
    submit: bool,
) -> AgateResult<()> {
    #[cfg(windows)]
    {
        tokio::task::spawn_blocking(move || {
            let values = inject::FillValues {
                username: username.as_deref(),
                password: password.as_ref().map(|p| p.as_str()),
                totp: totp.as_ref().map(|t| t.as_str()),
                submit,
            };
            inject::fill(hwnd, field, &values)
        })
        .await
        .map_err(|_| AgateError::internal("Autofill injection was interrupted."))?
    }
    #[cfg(not(windows))]
    {
        Err(AgateError::internal("Autofill injection isn't available on this platform."))
    }
}

/// Record a fresh detection: store the target, show the popup by the tray icon,
/// and emit [`DETECTED_EVENT`] so the popup enters fill mode. Called by the
/// platform watcher. The token is minted here so every detection is distinct.
#[cfg(windows)]
pub(crate) fn record_detection(app: &tauri::AppHandle, context: AutofillContext, hwnd: isize) {
    let token = uuid::Uuid::new_v4().to_string();
    // Dev-only: a non-secret breadcrumb so detection can be confirmed in the
    // `npm run dev` terminal before trusting injection. Never in release (it would
    // log which apps the user focuses password fields in).
    #[cfg(debug_assertions)]
    log::info!(
        "autofill: detected login field (field={:?}, process={:?}, title={:?})",
        context.field,
        context.process_name,
        context.window_title
    );
    {
        let state = app.state::<AppState>();
        let mut shared = state.autofill.lock().unwrap_or_else(|e| e.into_inner());
        shared.pending = Some(PendingTarget { token, context, hwnd });
    }
    crate::tray::show_popup_near_tray(app);
    let _ = app.emit(DETECTED_EVENT, ());
}
