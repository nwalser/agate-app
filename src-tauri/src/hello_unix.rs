//! Touch ID (macOS) / polkit (Linux) biometric unlock, via the cross-platform
//! `robius-authentication` crate. Mirrors the Windows Hello consent-gate in
//! `hello.rs`: enabling stores the Vault Master Key in the OS keychain, and a
//! successful biometric check releases it and unlocks every connection through
//! `appunlock::finish_unlock`. Like Hello, this is a *consent gate*, not a
//! key-binding.
//!
//! ⚠️ UNVERIFIED — AUTHORED ON A WINDOWS HOST.
//! This module is `cfg`-gated to macOS/Linux, so it is NOT compiled or executed in
//! the environment it was written in. The `robius-authentication` API usage here
//! is written against the crate's documented API but has **not been compiled or
//! run** — it must be built and verified on real macOS/Linux hardware (and likely
//! adjusted) before being relied upon. The Windows unlock path (`hello.rs`) is
//! untouched and unaffected. Fails closed: any error denies the unlock.

use robius_authentication::{
    AndroidText, BiometricStrength, Context, PolicyBuilder, Text, WindowsText,
};
use zeroize::Zeroizing;

use crate::dto::UnlockOutcome;
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

/// Whether biometric unlock can be offered. robius exposes no pre-flight query, so
/// we report available and let the prompt surface "no biometric configured" when
/// the user actually tries to unlock.
pub async fn available() -> bool {
    true
}

/// Enable biometric unlock: store the (currently unlocked) VMK in the OS keychain
/// so a later biometric check can release it. Identical to the Windows Hello path.
pub async fn enable(state: &AppState) -> AgateResult<()> {
    let vmk = crate::appunlock::current_vmk(state).await?;
    crate::secrets::store_hello_blob(&*vmk)?;
    state.update_config(|cfg| cfg.hello_configured = true).await
}

/// Unlock every connection after a successful Touch ID / polkit check.
pub async fn unlock_all(state: &AppState) -> AgateResult<Vec<UnlockOutcome>> {
    if !state.config.lock().await.hello_configured {
        return Err(AgateError::new(ErrorKind::LocalUnlock, "Biometric unlock is not enabled."));
    }

    // The OS prompt is blocking; run it off the async runtime's worker threads.
    let ok = tokio::task::spawn_blocking(|| {
        let policy = match PolicyBuilder::new()
            .biometrics(Some(BiometricStrength::Strong))
            .password(true)
            .build()
        {
            Ok(p) => p,
            Err(_) => return false,
        };
        let text = Text {
            android: AndroidText { title: "Unlock Agate", subtitle: None, description: None },
            apple: "unlock Agate",
            windows: WindowsText::new("Unlock Agate", "Unlock your vault"),
        };
        // Fails closed: a denied/failed/errored check returns false.
        Context::new(()).blocking_authenticate(text, &policy).is_ok()
    })
    .await
    .map_err(|_| AgateError::internal("Biometric verification was interrupted."))?;

    if !ok {
        return Err(AgateError::new(
            ErrorKind::LocalUnlock,
            "Biometric verification was not approved.",
        ));
    }

    let bytes = crate::secrets::load_hello_blob()?.ok_or_else(|| {
        AgateError::new(ErrorKind::LocalUnlock, "Biometric data is missing; re-enable it.")
    })?;
    let arr: [u8; 32] = bytes
        .as_slice()
        .try_into()
        .map_err(|_| AgateError::new(ErrorKind::Crypto, "corrupt biometric key"))?;
    crate::appunlock::finish_unlock(state, Zeroizing::new(arr)).await
}
