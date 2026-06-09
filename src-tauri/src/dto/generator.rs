//! Password / passphrase generator option DTOs (frontend → backend).
//! Mirrors `src/lib/types.ts`.

use serde::Deserialize;

/// Password-generator options from the UI.
#[derive(Debug, Clone, Deserialize)]
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
