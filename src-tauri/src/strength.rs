//! Live password feedback for the add/edit-login form: zxcvbn strength score +
//! an "already used" reuse count. Both run entirely in-process — the candidate
//! password arrives in a `Zeroizing` and only integers ever leave the backend.

use zeroize::Zeroizing;

use crate::error::{AgateError, AgateResult};
use crate::state::AppState;

/// How many existing logins (across every unlocked connection) already use
/// `password` — powers the add-form's "password already used" callout.
/// Returns a count only; which logins match never leaves the backend.
pub async fn password_in_use(state: &AppState, password: Zeroizing<String>) -> AgateResult<u32> {
    if password.is_empty() {
        return Ok(0);
    }
    let session = state.session.lock().await;
    if session.connections.is_empty() {
        return Err(AgateError::not_authenticated());
    }
    Ok(session
        .connections
        .values()
        .map(|c| c.count_password_use(password.as_str()))
        .sum())
}

/// zxcvbn strength score (0–4) for a candidate password — the add-form's live
/// strength meter. Pure compute (no vault access); `context` carries the draft's
/// non-secret fields (username / website / name) as dictionary inputs so a
/// password equal to one of them scores low.
pub fn password_strength(password: &Zeroizing<String>, context: &[String]) -> u8 {
    if password.is_empty() {
        return 0;
    }
    let inputs: Vec<&str> = context
        .iter()
        .map(String::as_str)
        .filter(|s| !s.is_empty())
        .collect();
    u8::from(zxcvbn::zxcvbn(password.as_str(), &inputs).score())
}
