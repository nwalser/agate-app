//! Security-audit commands (offline reuse/weak/old report + HIBP-exposed check).

use super::State;
use crate::audit;
use crate::dto::{ExposedResult, VaultHealthReport};
use crate::error::AgateResult;

#[tauri::command]
pub async fn audit_offline(
    state: State<'_>,
    config: Option<audit::AuditConfig>,
) -> AgateResult<VaultHealthReport> {
    audit::audit_offline(&state, config.unwrap_or_default()).await
}

#[tauri::command]
pub async fn audit_exposed(state: State<'_>) -> AgateResult<Vec<ExposedResult>> {
    audit::audit_exposed(&state).await
}

#[tauri::command]
pub async fn password_in_use(state: State<'_>, password: String) -> AgateResult<u32> {
    audit::password_in_use(&state, zeroize::Zeroizing::new(password)).await
}

/// zxcvbn strength score (0–4) for a candidate password — the tray add-form's
/// live strength meter. Pure compute (no vault access); `context` is the draft's
/// non-secret fields (username / website / name) fed as zxcvbn dictionary inputs.
#[tauri::command]
pub fn password_strength(password: String, context: Vec<String>) -> u8 {
    audit::password_strength(&zeroize::Zeroizing::new(password), &context)
}
