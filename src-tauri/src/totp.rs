//! The single call site for the SDK's `generate_totp`.
//!
//! Every provider (Bitwarden, KeePass, pass, Enpass, Proton) produces its current
//! TOTP code through this module, so a `bitwarden_vault::generate_totp` signature
//! change is contained to ONE function instead of fanning out across five
//! providers — the SDK-containment promise from CLAUDE.md. As a bonus the
//! period/remaining arithmetic, previously copy-pasted into each provider's
//! `item_totp`, lives in one place.

use chrono::{DateTime, Utc};

use crate::dto::TotpCode;
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Current TOTP code for `secret` (an `otpauth://` URI or a raw base32 secret —
/// the SDK accepts either), against the wall clock.
pub fn current(secret: impl AsRef<str>) -> AgateResult<TotpCode> {
    at(secret, Utc::now())
}

/// As [`current`], but at an explicit instant — the seam the unit tests pin
/// against (the wall-clock path is otherwise non-deterministic).
pub fn at(secret: impl AsRef<str>, now: DateTime<Utc>) -> AgateResult<TotpCode> {
    let response = bitwarden_vault::generate_totp(secret.as_ref().to_string(), Some(now))
        .map_err(|e| AgateError::new(ErrorKind::Crypto, format!("TOTP failed: {e}")))?;
    let period = response.period;
    let remaining = if period == 0 { 0 } else { period - (now.timestamp() as u32 % period) };
    Ok(TotpCode { code: response.code, period, remaining })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_a_six_digit_code() {
        let code = current("JBSWY3DPEHPK3PXP").expect("totp");
        assert_eq!(code.code.len(), 6);
        assert!(code.code.chars().all(|c| c.is_ascii_digit()), "code: {}", code.code);
        assert_eq!(code.period, 30);
        assert!(code.remaining >= 1 && code.remaining <= 30);
    }

    #[test]
    fn remaining_is_period_minus_elapsed_in_window() {
        // 5 seconds past a 30-second boundary → 25 seconds remain.
        let now = DateTime::from_timestamp(30 * 1_000_000 + 5, 0).expect("valid timestamp");
        let code = at("JBSWY3DPEHPK3PXP", now).expect("totp");
        assert_eq!(code.period, 30);
        assert_eq!(code.remaining, 25);
    }

    #[test]
    fn accepts_an_otpauth_uri_form_too() {
        let code = current("otpauth://totp/Site:alice?secret=JBSWY3DPEHPK3PXP&issuer=Site")
            .expect("totp");
        assert_eq!(code.code.len(), 6);
    }
}
