//! Password and passphrase generation. These need no unlocked vault, but the SDK's
//! generator hangs off a `PasswordManagerClient`, so we borrow any unlocked
//! connection's client (or a throwaway) via `any_or_throwaway`.

use bitwarden_generators::{PassphraseGeneratorRequest, PasswordGeneratorRequest};

use crate::dto::{PasswordGenOptions, UsernameGenOptions, UsernameMode};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::state::AppState;

use super::reads::any_or_throwaway;

/// Generate a password with the given options (no unlocked vault required).
pub async fn generate_password(state: &AppState, opts: PasswordGenOptions) -> AgateResult<String> {
    if !(opts.uppercase || opts.lowercase || opts.numbers || opts.special) {
        return Err(AgateError::bad_request("Select at least one character set."));
    }
    let length = opts.length.clamp(5, 128);
    let client = any_or_throwaway(state).await;

    let request = PasswordGeneratorRequest {
        lowercase: opts.lowercase,
        uppercase: opts.uppercase,
        numbers: opts.numbers,
        special: opts.special,
        length,
        avoid_ambiguous: opts.avoid_ambiguous,
        min_number: opts.min_number,
        min_special: opts.min_special,
        ..Default::default()
    };
    client
        .generator()
        .password(request)
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("generate failed: {e}")))
}

/// Generate a passphrase (EFF wordlist) with the given options.
pub async fn generate_passphrase(
    state: &AppState,
    opts: crate::dto::PassphraseGenOptions,
) -> AgateResult<String> {
    let num_words = opts.num_words.clamp(3, 20);
    let client = any_or_throwaway(state).await;
    let request = PassphraseGeneratorRequest {
        num_words,
        word_separator: if opts.word_separator.is_empty() { "-".into() } else { opts.word_separator },
        capitalize: opts.capitalize,
        include_number: opts.include_number,
    };
    client
        .generator()
        .passphrase(request)
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("generate failed: {e}")))
}

/// Generate a random lowercase+digit token of `length` chars, via the SDK's
/// password generator (reused so we don't ship a second RNG path).
async fn random_token(state: &AppState, length: u8) -> AgateResult<String> {
    let client = any_or_throwaway(state).await;
    let request = PasswordGeneratorRequest {
        lowercase: true,
        uppercase: false,
        numbers: true,
        special: false,
        length,
        avoid_ambiguous: true,
        ..Default::default()
    };
    client
        .generator()
        .password(request)
        .map_err(|e| AgateError::new(ErrorKind::Internal, format!("generate failed: {e}")))
}

/// Generate a username / email alias. Plus-addressed and catch-all build off a
/// random token; `random` returns the bare token. Forwarded-email services are
/// intentionally out of scope (they need network + per-service API keys).
pub async fn generate_username(
    state: &AppState,
    opts: UsernameGenOptions,
) -> AgateResult<String> {
    match opts.mode {
        UsernameMode::Random => random_token(state, 12).await,
        UsernameMode::PlusAddressed => {
            let token = random_token(state, 8).await?;
            let email = opts.email.unwrap_or_default();
            let email = email.trim();
            let (local, domain) = email
                .split_once('@')
                .ok_or_else(|| AgateError::bad_request("Enter a base email like you@example.com."))?;
            if local.is_empty() || domain.is_empty() {
                return Err(AgateError::bad_request("Enter a valid base email."));
            }
            Ok(format!("{local}+{token}@{domain}"))
        }
        UsernameMode::CatchAll => {
            let token = random_token(state, 8).await?;
            let domain = opts.domain.unwrap_or_default();
            let domain = domain.trim().trim_start_matches('@');
            if domain.is_empty() || !domain.contains('.') {
                return Err(AgateError::bad_request("Enter a catch-all domain like example.com."));
            }
            Ok(format!("{token}@{domain}"))
        }
    }
}
