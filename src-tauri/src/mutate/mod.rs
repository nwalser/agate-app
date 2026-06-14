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

use crate::dto::ConnectionKind;
use crate::error::{AgateError, AgateResult};
use crate::providers::KeepassConnection;
use crate::state::AppState;

/// Which provider a write should hit, resolved from the live connection.
pub(crate) enum WriteRoute {
    Bitwarden,
    Keepass,
}

/// Resolve the write route for a connection (typed error when it isn't live).
pub(crate) async fn route_for(state: &AppState, account_email: &str) -> AgateResult<WriteRoute> {
    let session = state.session.lock().await;
    let conn = session
        .connections
        .get(account_email)
        .ok_or_else(AgateError::not_authenticated)?;
    Ok(match conn.kind() {
        ConnectionKind::Bitwarden => WriteRoute::Bitwarden,
        ConnectionKind::Keepass => WriteRoute::Keepass,
    })
}

/// Run one KeePass write. The provider mutates the in-memory database and
/// atomically saves the file, so it needs `&mut` — the session lock is held
/// across the (blocking) write; `block_in_place` keeps the multi-threaded
/// runtime healthy while the KDF + file I/O run.
pub(crate) async fn keepass_write<R>(
    state: &AppState,
    account_email: &str,
    f: impl FnOnce(&mut KeepassConnection) -> AgateResult<R>,
) -> AgateResult<R> {
    let mut session = state.session.lock().await;
    let k = session
        .connections
        .get_mut(account_email)
        .ok_or_else(AgateError::not_authenticated)?
        .keepass_mut()
        .ok_or_else(|| AgateError::internal("write routed to the wrong provider"))?;
    tokio::task::block_in_place(|| f(k))
}
