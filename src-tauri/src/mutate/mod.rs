//! Vault write operations: create / edit / delete / restore / move / favorite /
//! clone items, and folder create / rename / delete. Every operation routes to a
//! specific connection by `account_email` (the unified list mixes accounts, so the
//! caller always says which vault an item lives in / a new item goes into).
//!
//! Module layout:
//! - [`writes`] — item writes (`save_item`/`clone_item`/`set_favorite`/`move_items`/
//!   `delete_items`/`restore_items`) plus the shared encrypt-and-push + `build_*`
//!   helpers and `create_view_json` / `set_type_payload`.
//! - [`folders`] — folder create / rename / delete.

mod folders;
mod writes;

// Item writes, driven by the Tauri commands in `lib.rs`.
pub use writes::{
    clone_item, delete_items, move_items, restore_items, save_item, set_favorite,
};

// Folder writes, also driven from `lib.rs`.
pub use folders::{create_folder, delete_folder, rename_folder};
