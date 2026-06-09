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
