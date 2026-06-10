//! Password / passphrase generator option DTOs (frontend → backend).
//! Mirrors `src/lib/types.ts`.

use serde::Deserialize;

/// Password-generator options from the UI.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PasswordGenOptions {
    pub length: u8,
    pub uppercase: bool,
    pub lowercase: bool,
    pub numbers: bool,
    pub special: bool,
    #[serde(default)]
    pub avoid_ambiguous: bool,
    #[serde(default)]
    pub min_number: Option<u8>,
    #[serde(default)]
    pub min_special: Option<u8>,
}

impl Default for PasswordGenOptions {
    fn default() -> Self {
        Self {
            length: 16,
            uppercase: true,
            lowercase: true,
            numbers: true,
            special: true,
            avoid_ambiguous: false,
            min_number: None,
            min_special: None,
        }
    }
}

/// Passphrase-generator options from the UI.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct PassphraseGenOptions {
    pub num_words: u8,
    pub word_separator: String,
    pub capitalize: bool,
    pub include_number: bool,
}

impl Default for PassphraseGenOptions {
    fn default() -> Self {
        Self { num_words: 3, word_separator: "-".into(), capitalize: true, include_number: true }
    }
}

/// Username-generator mode (closed set). Forwarded-email aliases (SimpleLogin,
/// addy.io, …) are intentionally out of scope — these modes need no network.
#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub enum UsernameMode {
    /// `local+<random>@domain`, derived from a base email ("plus addressing").
    PlusAddressed,
    /// `<random>@domain` for a catch-all domain you control.
    CatchAll,
    /// A standalone random token (no email).
    Random,
}

/// Username-generator options from the UI.
#[derive(Debug, Clone, Deserialize)]
#[cfg_attr(test, derive(specta::Type))]
#[serde(rename_all = "camelCase")]
pub struct UsernameGenOptions {
    pub mode: UsernameMode,
    /// Base email for plus-addressing (mode = `plusAddressed`).
    #[serde(default)]
    pub email: Option<String>,
    /// Domain for catch-all addressing (mode = `catchAll`).
    #[serde(default)]
    pub domain: Option<String>,
}
