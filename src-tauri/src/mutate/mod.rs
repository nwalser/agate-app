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
    associate_uri, clone_item, delete_items, move_items, remove_passkey, restore_items, save_item,
    set_favorite,
};

// Folder writes, also driven from `lib.rs`.
pub use folders::{create_folder, delete_folder, rename_folder};

use bitwarden_pm::PasswordManagerClient;

use crate::dto::ConnectionKind;
use crate::error::{AgateError, AgateResult};
use crate::providers::KeepassConnection;
use crate::state::AppState;

/// Which provider a write should hit, resolved from the live connection.
pub(crate) enum WriteRoute {
    Bitwarden,
    Keepass,
}

/// Route a write to its provider. BOTH provider bodies are REQUIRED, so unlike the
/// old `if let WriteRoute::Keepass = .. { keepass } /* else fall through */` shape,
/// a write can no longer silently run the Bitwarden path against a KeePass
/// connection, and adding a writable provider is a compile error at every call
/// site until its arm is added. Read-only providers are rejected once, in
/// [`route_for`]. The Bitwarden closure is handed a fresh SDK client so the body
/// keeps only its encode-and-push internals.
pub(crate) async fn dispatch_write<R, Fut>(
    state: &AppState,
    account_email: &str,
    bitwarden: impl FnOnce(PasswordManagerClient) -> Fut,
    keepass: impl FnOnce(&mut KeepassConnection) -> AgateResult<R>,
) -> AgateResult<R>
where
    Fut: std::future::Future<Output = AgateResult<R>>,
{
    match route_for(state, account_email).await? {
        WriteRoute::Bitwarden => {
            let client = crate::vault::client_for(state, account_email).await?;
            bitwarden(client).await
        }
        WriteRoute::Keepass => keepass_write(state, account_email, keepass).await,
    }
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
        // pass / Enpass / Proton are read-only in Agate. Every write entry point
        // calls `route_for(..).await?` before routing, so returning the error here
        // is the single, exhaustive rejection point — no per-call-site guard needed.
        ConnectionKind::Pass | ConnectionKind::Enpass | ConnectionKind::Proton => {
            return Err(AgateError::bad_request("This vault is read-only in Agate."))
        }
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
