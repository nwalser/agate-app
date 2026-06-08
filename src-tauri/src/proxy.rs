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

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

const NEW_PRELOGIN: &str = "/accounts/prelogin/password";
const OLD_PRELOGIN: &str = "/accounts/prelogin";

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
    sync_shape_cell().lock().unwrap_or_else(|e| e.into_inner()).clone()
}

/// Ensure a loopback identity proxy is running for `upstream_identity_base`
/// (e.g. `https://vault.example.com/identity`) and return its loopback base URL
/// (e.g. `http://127.0.0.1:54321`) to use as the SDK `identity_url`.
pub fn ensure_proxy(upstream_identity_base: &str) -> std::io::Result<String> {
    let key = upstream_identity_base.trim_end_matches('/').to_string();

    {
        let guard = registry().lock().unwrap_or_else(|e| e.into_inner());
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
    std::thread::spawn(move || run_proxy(server, upstream));

    registry().lock().unwrap_or_else(|e| e.into_inner()).insert(key, port);
    Ok(format!("http://127.0.0.1:{port}"))
}

/// Render a JSON value as a type-only skeleton (keys preserved, values replaced
/// by their type) so we can diagnose schema mismatches without logging secrets.
fn skeleton(v: &serde_json::Value, depth: usize) -> String {
    use serde_json::Value;
    if depth == 0 {
        return "…".to_string();
    }
    match v {
        Value::Null => "null".into(),
        Value::Bool(_) => "bool".into(),
        Value::Number(_) => "num".into(),
        Value::String(_) => "str".into(),
        Value::Array(a) => match a.first() {
            Some(first) => format!("[{}]x{}", skeleton(first, depth - 1), a.len()),
            None => "[]".into(),
        },
        Value::Object(map) => {
            let inner: Vec<String> = map
                .iter()
                .map(|(k, val)| format!("{k}:{}", skeleton(val, depth - 1)))
                .collect();
            format!("{{{}}}", inner.join(","))
        }
    }
}

fn run_proxy(server: tiny_http::Server, upstream: String) {
    let client = match reqwest::blocking::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            log::error!("identity proxy: failed to build http client: {e}");
            return;
        }
    };

    for request in server.incoming_requests() {
        handle(&client, &upstream, request);
    }
}

type UpstreamResult = Result<(u16, Vec<(String, String)>, Vec<u8>), Box<dyn std::error::Error>>;

fn handle(client: &reqwest::blocking::Client, upstream: &str, mut request: tiny_http::Request) {
    // `respond` consumes the request, so compute the upstream response first
    // (borrowing the request), then respond on every path.
    let result: UpstreamResult = (|| {
        // Rewrite only the prelogin path; pass everything else (incl. query) through.
        let raw = request.url().to_string();
        let path = if let Some(rest) = raw.strip_prefix(NEW_PRELOGIN) {
            format!("{OLD_PRELOGIN}{rest}")
        } else {
            raw
        };
        let url = format!("{upstream}{path}");

        let method = reqwest::Method::from_bytes(request.method().as_str().as_bytes())
            .unwrap_or(reqwest::Method::POST);

        let mut headers: Vec<(String, String)> = Vec::new();
        for h in request.headers() {
            let name = h.field.as_str().as_str();
            // Host/content-length are set by reqwest; don't forward encoding hints
            // so reqwest returns a decoded body we can re-serve with a correct length.
            if name.eq_ignore_ascii_case("host")
                || name.eq_ignore_ascii_case("content-length")
                || name.eq_ignore_ascii_case("accept-encoding")
            {
                continue;
            }
            headers.push((name.to_string(), h.value.as_str().to_string()));
        }

        let mut body = Vec::new();
        request.as_reader().read_to_end(&mut body)?;

        let mut rb = client.request(method, &url).body(body);
        for (k, v) in &headers {
            rb = rb.header(k, v);
        }

        let resp = rb.send()?;
        let status = resp.status().as_u16();
        let mut out_headers: Vec<(String, String)> = Vec::new();
        for (k, v) in resp.headers().iter() {
            let kl = k.as_str();
            // reqwest already decoded the body; drop framing/encoding headers.
            if kl.eq_ignore_ascii_case("content-length")
                || kl.eq_ignore_ascii_case("transfer-encoding")
                || kl.eq_ignore_ascii_case("content-encoding")
            {
                continue;
            }
            if let Ok(vs) = v.to_str() {
                out_headers.push((kl.to_string(), vs.to_string()));
            }
        }
        let bytes = resp.bytes()?.to_vec();
        // Diagnostic: log the TYPE STRUCTURE of the sync response (keys + value
        // types only — never the values) to help pinpoint server/SDK schema
        // mismatches. Safe to share: contains no secrets.
        if path.contains("/sync") {
            if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                let shape = skeleton(&v, 8);
                log::error!("AGATE_SYNC_SHAPE (types only, no values): {shape}");
                *sync_shape_cell().lock().unwrap_or_else(|e| e.into_inner()) = Some(shape);
            }
        }
        Ok((status, out_headers, bytes))
    })();

    match result {
        Ok((status, headers, bytes)) => {
            let mut tresp = tiny_http::Response::from_data(bytes).with_status_code(status);
            for (k, v) in headers {
                if let Ok(header) = tiny_http::Header::from_bytes(k.as_bytes(), v.as_bytes()) {
                    tresp.add_header(header);
                }
            }
            let _ = request.respond(tresp);
        }
        Err(e) => {
            log::warn!("identity proxy forward error: {e}");
            let _ = request.respond(
                tiny_http::Response::from_string("proxy error").with_status_code(502),
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// End-to-end check against a real self-hosted identity base. Set
    /// `AGATE_TEST_IDENTITY` to e.g. `https://vault.example.com/identity` and run
    /// `cargo test -- --ignored`. Skipped (passes trivially) when the var is unset,
    /// so no private URL is committed and CI never makes a network call.
    #[test]
    #[ignore = "network: requires AGATE_TEST_IDENTITY"]
    fn prelogin_path_is_rewritten_against_live_server() {
        let Ok(base) = std::env::var("AGATE_TEST_IDENTITY") else {
            return;
        };
        let local = ensure_proxy(&base).expect("start proxy");
        let client = reqwest::blocking::Client::new();
        // The SDK posts the NEW path; the proxy must rewrite it to the OLD one.
        let resp = client
            .post(format!("{local}/accounts/prelogin/password"))
            .header("content-type", "application/json")
            .body(r#"{"email":"nobody@example.com"}"#)
            .send()
            .expect("proxy request");
        let status = resp.status().as_u16();
        let text = resp.text().unwrap_or_default();
        assert_eq!(status, 200, "prelogin should be rewritten to a 200 endpoint");
        assert!(text.contains("kdf"), "expected KDF json, got: {text}");
    }
}
