//! Loopback identity proxy for self-hosted server compatibility.
//!
//! The pinned SDK posts password prelogin to `{identity}/accounts/prelogin/password`,
//! but some self-hosted servers (e.g. Vaultwarden 2025.x) only implement
//! `{identity}/accounts/prelogin` (identical response). The SDK builds its
//! identity HTTP client WITHOUT a middleware hook, so we can't rewrite the path
//! inside the SDK. Instead we run a tiny `127.0.0.1`-only HTTP proxy: the SDK's
//! identity client is pointed at the loopback address, the proxy rewrites just
//! that one path and forwards everything (prelogin, token, refresh) over HTTPS
//! to the real server. The SDK does all login/crypto/token work unchanged.
//!
//! One proxy per upstream identity base is started lazily and lives for the
//! process lifetime (reused across logins/refreshes).

mod handler;
mod rewrite;

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

static PROXIES: OnceLock<Mutex<HashMap<String, u16>>> = OnceLock::new();
/// The last observed `/sync` response shape (types only, never values), so the
/// vault layer can surface it in a sync error for diagnosis.
static LAST_SYNC_SHAPE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

fn registry() -> &'static Mutex<HashMap<String, u16>> {
    PROXIES.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sync_shape_cell() -> &'static Mutex<Option<String>> {
    LAST_SYNC_SHAPE.get_or_init(|| Mutex::new(None))
}

/// The type-only skeleton of the most recent `/sync` response, if captured.
pub fn last_sync_shape() -> Option<String> {
    sync_shape_cell().lock().unwrap_or_else(std::sync::PoisonError::into_inner).clone()
}

/// Ensure a loopback identity proxy is running for `upstream_identity_base`
/// (e.g. `https://vault.example.com/identity`) and return its loopback base URL
/// (e.g. `http://127.0.0.1:54321`) to use as the SDK `identity_url`.
pub fn ensure_proxy(upstream_identity_base: &str) -> std::io::Result<String> {
    let key = upstream_identity_base.trim_end_matches('/').to_string();

    {
        let guard = registry().lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(port) = guard.get(&key) {
            return Ok(format!("http://127.0.0.1:{port}"));
        }
    }

    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| std::io::Error::other(e.to_string()))?;
    let port = server
        .server_addr()
        .to_ip()
        .map(|a| a.port())
        .ok_or_else(|| std::io::Error::other("proxy: no bound port"))?;

    let upstream = key.clone();
    std::thread::spawn(move || handler::run_proxy(server, upstream));

    registry().lock().unwrap_or_else(std::sync::PoisonError::into_inner).insert(key, port);
    Ok(format!("http://127.0.0.1:{port}"))
}
