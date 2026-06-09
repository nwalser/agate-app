//! Password and passphrase generation. These need no unlocked vault, but the SDK's
//! generator hangs off a `PasswordManagerClient`, so we borrow any unlocked
//! connection's client (or a throwaway) via `any_or_throwaway`.

use bitwarden_generators::{PassphraseGeneratorRequest, PasswordGeneratorRequest};

use crate::dto::PasswordGenOptions;
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
