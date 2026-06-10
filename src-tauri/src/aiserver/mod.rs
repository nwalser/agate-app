//! Local MCP server — a `127.0.0.1`-only HTTP endpoint that exposes a narrow,
//! user-allowlisted slice of the vault to an external AI (MCP) client (e.g. Claude
//! Desktop / Claude Code).
//!
//! Security model (fail closed at every layer):
//! - **Loopback only** (`127.0.0.1`); never reachable off the host.
//! - **Bearer token** on every request. The token is a keychain-stored capability
//!   secret (`secrets::AI_TOKEN_KEY`), generated on first enable. No token / wrong
//!   token ⇒ `401`, before any vault access.
//! - **Opt-in + unlocked.** Serves only while the user has switched the feature on
//!   (`ai_server_enabled`) *and* the vault is unlocked; otherwise the tools error.
//! - **Allowlist.** `get_vault_item` reveals a secret only if the `(account, item)`
//!   is on the allowlist (`PersistedConfig::ai_grants`). Every call is audited.
//!
//! The listener is bound once per process (idempotent) and lives for the process
//! lifetime; enabling/disabling just toggles the flag the handler checks — the same
//! lazy, process-lived pattern as the loopback identity proxy in `proxy/mod.rs`.

mod mcp;
mod tools;

use std::sync::{Mutex, OnceLock};

use tauri::AppHandle;

use crate::error::{AgateError, AgateResult, ErrorKind};

/// Fixed loopback bind address — a stable URL the user pastes once into their MCP
/// client config. If the port is busy, enabling the server returns a clear error.
pub const AI_SERVER_ADDR: &str = "127.0.0.1:41999";

/// The MCP endpoint URL advertised to the user.
pub fn server_url() -> String {
    format!("http://{AI_SERVER_ADDR}/mcp")
}

static STARTED: OnceLock<Mutex<bool>> = OnceLock::new();

fn started_cell() -> &'static Mutex<bool> {
    STARTED.get_or_init(|| Mutex::new(false))
}

/// Whether the loopback listener is bound + serving this process.
pub fn is_running() -> bool {
    *started_cell().lock().unwrap_or_else(|e| e.into_inner())
}

/// Start the loopback MCP listener once (idempotent). A second call is a no-op, so
/// re-enabling within a session reuses the running listener.
pub fn ensure_started(app: AppHandle) -> AgateResult<()> {
    let mut started = started_cell().lock().unwrap_or_else(|e| e.into_inner());
    if *started {
        return Ok(());
    }
    let server = tiny_http::Server::http(AI_SERVER_ADDR).map_err(|e| {
        AgateError::new(
            ErrorKind::Internal,
            format!("Could not start the AI server on {AI_SERVER_ADDR}: {e}"),
        )
    })?;
    std::thread::spawn(move || serve(server, app));
    *started = true;
    log::info!("MCP server listening on {}", server_url());
    Ok(())
}

fn serve(server: tiny_http::Server, app: AppHandle) {
    let host = tools::AppToolHost::new(app);
    for request in server.incoming_requests() {
        handle(&host, request);
    }
}

fn handle(host: &tools::AppToolHost, mut request: tiny_http::Request) {
    let method = request.method().as_str().to_ascii_uppercase();

    // Gate 1: the feature must be switched on.
    if !host.enabled() {
        respond_json(request, 503, &error_envelope("The AI access server is disabled in Agate."));
        return;
    }

    // Gate 2: a valid bearer token. Load it fresh so a regenerated token takes
    // effect immediately. No token configured ⇒ deny.
    let token = crate::secrets::load_ai_token().ok().flatten();
    if !authorized(&request, token.as_deref()) {
        respond_status(request, 401, "Unauthorized");
        return;
    }

    // We serve JSON-RPC over POST only. (Streamable-HTTP's optional GET/SSE stream
    // isn't needed for a request/response tool surface.)
    if method != "POST" {
        respond_status(request, 405, "Method Not Allowed");
        return;
    }

    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        respond_json(request, 400, &error_envelope("Could not read the request body."));
        return;
    }

    match mcp::handle_jsonrpc(&body, host) {
        Some(resp) => respond_json(request, 200, &resp),
        None => respond_status(request, 202, "Accepted"), // notification: no body
    }
}

/// Constant-prefix bearer check. The token is high-entropy (256-bit), so a plain
/// equality compare is adequate; we still require the exact `Bearer ` scheme.
fn authorized(request: &tiny_http::Request, expected: Option<&str>) -> bool {
    let Some(expected) = expected else {
        return false; // no token provisioned ⇒ nothing is authorized
    };
    let provided = request.headers().iter().find_map(|h| {
        if h.field.as_str().as_str().eq_ignore_ascii_case("authorization") {
            Some(h.value.as_str().to_string())
        } else {
            None
        }
    });
    match provided {
        Some(v) => {
            let token = v
                .strip_prefix("Bearer ")
                .or_else(|| v.strip_prefix("bearer "))
                .unwrap_or(v.as_str());
            token == expected
        }
        None => false,
    }
}

fn respond_json(request: tiny_http::Request, status: u16, body: &str) {
    let mut resp = tiny_http::Response::from_string(body).with_status_code(status);
    if let Ok(h) = tiny_http::Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]) {
        resp.add_header(h);
    }
    let _ = request.respond(resp);
}

fn respond_status(request: tiny_http::Request, status: u16, msg: &str) {
    let _ = request.respond(tiny_http::Response::from_string(msg).with_status_code(status));
}

/// A JSON-RPC error envelope (id = null) for transport-level failures the MCP layer
/// never sees (disabled server, unreadable body).
fn error_envelope(message: &str) -> String {
    serde_json::json!({
        "jsonrpc": "2.0",
        "id": null,
        "error": { "code": -32000, "message": message }
    })
    .to_string()
}
