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

use std::io::Read;
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

/// What the HTTP transport needs from its surroundings beyond tool execution —
/// split out so the whole gate (enabled → token → method → body cap) is
/// integration-tested over a real socket with a stub, while the live impl reads
/// `AppState` + the OS keychain.
pub(crate) trait ServerGate: mcp::ToolHost {
    fn is_enabled(&self) -> bool;
    fn bearer_token(&self) -> crate::error::AgateResult<Option<String>>;
}

impl ServerGate for tools::AppToolHost {
    fn is_enabled(&self) -> bool {
        self.enabled()
    }
    fn bearer_token(&self) -> crate::error::AgateResult<Option<String>> {
        crate::secrets::load_ai_token()
    }
}

fn serve(server: tiny_http::Server, app: AppHandle) {
    serve_loop(server, tools::AppToolHost::new(app));
}

fn serve_loop<H: ServerGate>(server: tiny_http::Server, host: H) {
    for request in server.incoming_requests() {
        handle(&host, request);
    }
}

fn handle<H: ServerGate>(host: &H, mut request: tiny_http::Request) {
    let method = request.method().as_str().to_ascii_uppercase();

    // Gate 1: the feature must be switched on.
    if !host.is_enabled() {
        respond_json(request, 503, &error_envelope("The AI access server is disabled in Agate."));
        return;
    }

    // Gate 2: a valid bearer token. Load it fresh so a regenerated token takes
    // effect immediately. No token configured ⇒ deny. A keychain FAILURE is not
    // "no token" — that's broken/corrupt storage; log it loudly and fail closed.
    let token = match host.bearer_token() {
        Ok(t) => t,
        Err(e) => {
            log::error!("AI server: could not load the bearer token from the keychain: {}", e.message);
            respond_status(request, 500, "Internal Server Error");
            return;
        }
    };
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

    // Cap the body read: no tool call is anywhere near this large, and an
    // unbounded read_to_string would be a local OOM lever (chunked bodies carry
    // no Content-Length, so the declared-length check alone is not enough).
    const MAX_BODY_BYTES: usize = 1024 * 1024;
    if request.body_length().is_some_and(|l| l > MAX_BODY_BYTES) {
        // Drain the body in small fixed chunks BEFORE rejecting: dropping the
        // request with bytes unread makes tiny_http's EqualReader::drop allocate
        // a buffer of the FULL declared Content-Length (vec![0; remaining]) —
        // the very OOM this cap exists to prevent. Draining costs the client
        // its own bandwidth and keeps our memory at the chunk size.
        drain_body(request.as_reader());
        respond_status(request, 413, "Payload Too Large");
        return;
    }
    let mut body = String::new();
    let mut limited = request.as_reader().take(MAX_BODY_BYTES as u64 + 1);
    if limited.read_to_string(&mut body).is_err() {
        respond_json(request, 400, &error_envelope("Could not read the request body."));
        return;
    }
    if body.len() > MAX_BODY_BYTES {
        drain_body(request.as_reader());
        respond_status(request, 413, "Payload Too Large");
        return;
    }

    match mcp::handle_jsonrpc(&body, host) {
        Some(resp) => respond_json(request, 200, &resp),
        None => respond_status(request, 202, "Accepted"), // notification: no body
    }
}

/// Bearer check: the `Authorization` header must carry exactly the `Bearer `
/// scheme (any case, per RFC 7235) followed by the token, compared in constant
/// time — this is the only auth gate in front of vault secrets, so a local
/// attacker must not get a byte-wise timing oracle out of it.
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
        Some(v) => header_token_matches(&v, expected),
        None => false,
    }
}

/// Does an `Authorization` header value carry `Bearer <expected>`? Split out of
/// `authorized` so the scheme + constant-time rules are unit-testable.
fn header_token_matches(value: &str, expected: &str) -> bool {
    use subtle::ConstantTimeEq;

    const SCHEME: &str = "Bearer ";
    // A bare token (or any other scheme) is rejected outright — accepting it
    // would silently widen what counts as valid credentials.
    if value.len() < SCHEME.len() || !value.is_char_boundary(SCHEME.len()) {
        return false;
    }
    let (scheme, token) = value.split_at(SCHEME.len());
    if !scheme.eq_ignore_ascii_case(SCHEME) {
        return false;
    }
    // ct_eq only short-circuits on length (public anyway), never on content.
    token.as_bytes().ct_eq(expected.as_bytes()).into()
}

/// Read a request body to EOF in small fixed chunks, discarding it. See the
/// call sites: rejecting without consuming would hand the declared
/// Content-Length to tiny_http's drop-drain as one giant allocation.
fn drain_body(reader: &mut dyn Read) {
    let mut buf = [0u8; 64 * 1024];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
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

#[cfg(test)]
mod tests {
    use super::{header_token_matches, serve_loop, ServerGate};
    use super::mcp;

    const TOKEN: &str = "u_4fS9zX0kQ7mB2cD5eF8gH1jK3lM6nP9rT_wVyZaAbCcD";

    /// Stub gate + tool host: the full HTTP layer runs over a real socket, only
    /// the surroundings (AppState, keychain, vault) are faked.
    struct StubHost {
        enabled: bool,
        token: Option<String>,
    }
    impl mcp::ToolHost for StubHost {
        fn list_tools(&self) -> Vec<mcp::ToolDef> {
            Vec::new()
        }
        fn call_tool(&self, _name: &str, _args: &serde_json::Value) -> mcp::ToolResult {
            mcp::ToolResult::ok("{}")
        }
    }
    impl ServerGate for StubHost {
        fn is_enabled(&self) -> bool {
            self.enabled
        }
        fn bearer_token(&self) -> crate::error::AgateResult<Option<String>> {
            Ok(self.token.clone())
        }
    }

    /// Bind an ephemeral loopback port, serve `host` on a background thread, and
    /// return the URL. The thread lives until the test process exits (fine).
    fn spawn_test_server(host: StubHost) -> String {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind test server");
        let addr = server.server_addr().to_ip().expect("ip listen addr");
        std::thread::spawn(move || serve_loop(server, host));
        format!("http://{addr}/mcp")
    }

    #[test]
    fn http_gate_enforces_bearer_auth_end_to_end() {
        let url = spawn_test_server(StubHost { enabled: true, token: Some(TOKEN.into()) });
        let client = reqwest::blocking::Client::new();
        let rpc = r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#;

        // No credentials, a bare token, and a wrong token are all 401.
        assert_eq!(client.post(&url).body(rpc).send().expect("send").status(), 401);
        assert_eq!(
            client.post(&url).header("Authorization", TOKEN).body(rpc).send().expect("send").status(),
            401
        );
        assert_eq!(
            client
                .post(&url)
                .header("Authorization", "Bearer wrong-token")
                .body(rpc)
                .send()
                .expect("send")
                .status(),
            401
        );

        // The real token serves JSON-RPC.
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {TOKEN}"))
            .body(rpc)
            .send()
            .expect("send");
        assert_eq!(resp.status(), 200);
        let body = resp.text().expect("body");
        assert!(body.contains("\"jsonrpc\""), "expected a JSON-RPC body, got: {body}");

        // POST-only transport: GET is 405 even when authorized.
        assert_eq!(
            client
                .get(&url)
                .header("Authorization", format!("Bearer {TOKEN}"))
                .send()
                .expect("send")
                .status(),
            405
        );
    }

    #[test]
    fn http_gate_denies_everything_without_a_provisioned_token() {
        let url = spawn_test_server(StubHost { enabled: true, token: None });
        let client = reqwest::blocking::Client::new();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {TOKEN}"))
            .body("{}")
            .send()
            .expect("send");
        assert_eq!(resp.status(), 401);
    }

    #[test]
    fn http_gate_disabled_server_responds_503_before_auth() {
        let url = spawn_test_server(StubHost { enabled: false, token: Some(TOKEN.into()) });
        let client = reqwest::blocking::Client::new();
        let resp = client
            .post(&url)
            .header("Authorization", format!("Bearer {TOKEN}"))
            .body("{}")
            .send()
            .expect("send");
        assert_eq!(resp.status(), 503);
    }

    #[test]
    fn http_gate_rejects_an_oversized_declared_body_quickly() {
        use std::io::{Read, Write};

        let url = spawn_test_server(StubHost { enabled: true, token: Some(TOKEN.into()) });
        let addr = url.trim_start_matches("http://").trim_end_matches("/mcp").to_string();
        // Raw socket: declare a 1 GiB body, send none, half-close. The server
        // must drain (instantly: EOF) and answer 413 — not allocate the
        // declared length (the EqualReader drop pitfall) and not hang.
        let mut s = std::net::TcpStream::connect(&addr).expect("connect");
        write!(
            s,
            "POST /mcp HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 1073741824\r\n\r\n"
        )
        .expect("write request");
        s.shutdown(std::net::Shutdown::Write).expect("half-close");
        let mut response = String::new();
        s.read_to_string(&mut response).expect("read response");
        assert!(
            response.starts_with("HTTP/1.1 413"),
            "expected 413, got: {}",
            &response[..response.len().min(64)]
        );
    }

    #[test]
    fn accepts_the_exact_bearer_scheme() {
        assert!(header_token_matches(&format!("Bearer {TOKEN}"), TOKEN));
        // The scheme word is case-insensitive (RFC 7235); the token is not.
        assert!(header_token_matches(&format!("bearer {TOKEN}"), TOKEN));
        assert!(header_token_matches(&format!("BEARER {TOKEN}"), TOKEN));
    }

    #[test]
    fn rejects_a_bare_token_without_the_scheme() {
        assert!(!header_token_matches(TOKEN, TOKEN));
    }

    #[test]
    fn rejects_other_schemes_and_wrong_tokens() {
        assert!(!header_token_matches(&format!("Basic {TOKEN}"), TOKEN));
        assert!(!header_token_matches("Bearer wrong-token", TOKEN));
        assert!(!header_token_matches("Bearer ", TOKEN));
        assert!(!header_token_matches("", TOKEN));
    }

    #[test]
    fn rejects_prefix_and_suffix_variants() {
        assert!(!header_token_matches(&format!("Bearer {TOKEN}x"), TOKEN));
        assert!(!header_token_matches(&format!("Bearer x{TOKEN}"), TOKEN));
        let truncated = &TOKEN[..TOKEN.len() - 1];
        assert!(!header_token_matches(&format!("Bearer {truncated}"), TOKEN));
    }
}
