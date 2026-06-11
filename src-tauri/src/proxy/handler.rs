//! The loopback HTTP handler: accept the SDK's identity/api requests on
//! `127.0.0.1`, rewrite the one prelogin path + `/sync` body, and forward
//! everything else verbatim over HTTPS to the real upstream server.

use super::rewrite::{
    skeleton, strip_legacy_cipher_data, strip_legacy_cipher_data_object, NEW_PRELOGIN, OLD_PRELOGIN,
};
use super::sync_shape_cell;

pub(super) fn run_proxy(server: tiny_http::Server, upstream: String) {
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
        let mut bytes = resp.bytes()?.to_vec();
        // Self-hosted compatibility: rewrite the /sync body so the SDK can parse
        // it. Vaultwarden emits a legacy `data` OBJECT on each cipher, but the
        // SDK's CipherDetailsResponseModel types `data` as a string and ignores
        // it (it reads the typed login/card/identity/… sub-objects). Strip it so
        // deserialization doesn't fail with "invalid type: map, expected string".
        // Also stash a types-only shape (no values) that the vault layer surfaces
        // on a sync error, to diagnose any future mismatch.
        if path.contains("/sync") {
            if let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                *sync_shape_cell().lock().unwrap_or_else(|e| e.into_inner()) = Some(skeleton(&v, 8));
                strip_legacy_cipher_data(&mut v);
                if let Ok(reserialized) = serde_json::to_vec(&v) {
                    bytes = reserialized;
                }
            }
        } else if path.contains("/ciphers") {
            // Cipher create (`POST /ciphers`) and save (`PUT /ciphers/{id}`) reply
            // with the written cipher, which on Vaultwarden carries the same legacy
            // `data` OBJECT as the /sync ciphers. The SDK deserializes this reply
            // into `CipherResponseModel` (data typed as string), so strip it here
            // too or the write fails with "invalid type: map, expected a string".
            if let Ok(mut v) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                strip_legacy_cipher_data_object(&mut v);
                if let Ok(reserialized) = serde_json::to_vec(&v) {
                    bytes = reserialized;
                }
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
    use crate::proxy::ensure_proxy;

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
        // Distinguish a read failure (surfaced) from a genuinely empty body.
        let text = resp.text().expect("read proxy response body");
        assert_eq!(status, 200, "prelogin should be rewritten to a 200 endpoint");
        assert!(text.contains("kdf"), "expected KDF json, got: {text}");
    }
}
