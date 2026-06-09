//! Encrypted cache for the breach / exposed-password scan results.
//!
//! The scan results carry the user's email addresses and which breaches they
//! appear in — PII. To match the app's "nothing sensitive on disk in plaintext"
//! posture (the vault itself is never persisted decrypted), the results are sealed
//! under the **VMK** (the same data key that seals every connection credential)
//! and stored in the OS keychain, not in localStorage.
//!
//! The payload is an **opaque** JSON string owned by the frontend
//! (`state/securityScans.ts`) — the backend only seals / unseals it, so the result
//! shape can evolve without touching this layer. Requires the app to be unlocked
//! (the VMK is held only while unlocked); a cache write/read while locked is a
//! `Locked` error, except a *missing* or *corrupt* cache on read is a soft miss
//! (`Ok(None)`) so a stale cache just triggers a fresh scan rather than an error.

use crate::appunlock;
use crate::error::AgateResult;
use crate::secrets;
use crate::state::AppState;

/// Seal the frontend's serialized scan results under the VMK and store them.
pub async fn save(state: &AppState, payload: String) -> AgateResult<()> {
    let vmk = appunlock::current_vmk(state).await?;
    let blob = secrets::seal_with_key(&vmk, payload.as_bytes(), &secrets::scan_cache_aad())?;
    secrets::store_scan_cache(&blob)
}

/// Load + decrypt the cached scan results. `Ok(None)` when there's no cache yet, or
/// when the stored blob can't be opened (treated as a cache miss + logged, so a
/// corrupt cache self-heals on the next scan rather than blocking the view).
pub async fn load(state: &AppState) -> AgateResult<Option<String>> {
    let vmk = appunlock::current_vmk(state).await?;
    let Some(blob) = secrets::load_scan_cache()? else {
        return Ok(None);
    };
    match secrets::open_with_key(&vmk, &blob, &secrets::scan_cache_aad()) {
        Ok(plaintext) => match String::from_utf8(plaintext.to_vec()) {
            Ok(s) => Ok(Some(s)),
            Err(e) => {
                log::warn!("scan cache: non-utf8 payload, ignoring: {e}");
                Ok(None)
            }
        },
        Err(e) => {
            log::warn!("scan cache: could not open (treating as miss): {}", e.message);
            Ok(None)
        }
    }
}
