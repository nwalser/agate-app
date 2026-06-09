//! Vault operations across all unlocked connections: sync, the unified item list,
//! item detail, TOTP, and password generation.
//!
//! In the unified model every read aggregates across every unlocked connection and
//! stamps each row/detail with its owning account (`account_email` + a label), and
//! every per-item operation routes by `(account_email, id)` to the right client.
//!
//! All SDK calls are isolated here. The read path decrypts each cipher to a full
//! `CipherView` (a stable SDK type) rather than the more volatile `CipherListView`.
//!
//! Module layout:
//! - [`reads`] — sync / list / detail / TOTP / folders + the per-connection client
//!   and decrypt helpers.
//! - [`transform`] — pure `CipherView` → DTO mapping (list rows + `ItemDetail`).
//! - [`generators`] — password / passphrase generation.

mod attachments;
mod export;
mod generators;
mod import;
mod reads;
mod sends;
mod transform;

// Read path consumed by the Tauri commands in `lib.rs`.
pub use reads::{item_detail, item_totp, list_collections, list_folders, list_items, sync};

// Generation, also driven from `lib.rs`.
pub use generators::{generate_passphrase, generate_password, generate_username};

// Vault export (decrypt → JSON/CSV), driven from `lib.rs`.
pub use export::export_string;

// Vault import (CSV → create-ready inputs), driven from `lib.rs`.
pub use import::parse_csv;

// Attachment download (fetch + decrypt), driven from `lib.rs`.
pub use attachments::download_attachment;

// Bitwarden Send (list + revoke), driven from `lib.rs`.
pub use sends::{delete_send, list_sends};

// Per-connection helpers shared with the write path (`mutate`).
pub(crate) use reads::{client_for, decrypt_one};
