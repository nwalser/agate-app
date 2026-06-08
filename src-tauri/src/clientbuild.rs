//! Builds the SDK `PasswordManagerClient` with a self-hosted compatibility shim.
//!
//! The pinned SDK's password prelogin POSTs to `{identity}/accounts/prelogin/password`
//! (a newer endpoint). Self-hosted servers like Vaultwarden may only implement
//! the older `{identity}/accounts/prelogin` (same response shape). For self-hosted
//! servers we add a reqwest middleware that rewrites that one path, so the SDK's
//! own login/crypto/token handling works unchanged — we don't reimplement login.
//!
//! This mirrors `bitwarden_pm::PasswordManagerClientBuilder::build()` but injects
//! the extra middleware via the public `bitwarden_core::ClientBuilder`.

use std::sync::Arc;

use bitwarden_auth::token_management::PasswordManagerTokenHandler;
use bitwarden_core::client::tracing_middleware::ReqwestTracingMiddleware;
use bitwarden_core::{ClientBuilder, ClientSettings};
use bitwarden_pm::PasswordManagerClient;

use crate::dto::ServerConfig;

const NEW_PRELOGIN_SUFFIX: &str = "/accounts/prelogin/password";

/// Rewrites the newer `/accounts/prelogin/password` to the older
/// `/accounts/prelogin` (identical response) for servers that lack the new path.
struct PreloginPathCompat;

#[async_trait::async_trait]
impl reqwest_middleware::Middleware for PreloginPathCompat {
    async fn handle(
        &self,
        mut req: reqwest_middleware::reqwest::Request,
        extensions: &mut http::Extensions,
        next: reqwest_middleware::Next<'_>,
    ) -> reqwest_middleware::Result<reqwest_middleware::reqwest::Response> {
        if req.url().path().ends_with(NEW_PRELOGIN_SUFFIX) {
            if let Some(stripped) = req.url().path().strip_suffix("/password") {
                let stripped = stripped.to_string();
                req.url_mut().set_path(&stripped);
            }
        }
        next.run(req, extensions).await
    }
}

/// Build a `PasswordManagerClient` for the given server. Self-hosted servers get
/// the prelogin compatibility shim; cloud servers are left untouched.
pub fn build_pm_client(server: &ServerConfig, settings: ClientSettings) -> PasswordManagerClient {
    let mut middleware: Vec<Arc<dyn reqwest_middleware::Middleware>> =
        vec![Arc::new(ReqwestTracingMiddleware)];
    if matches!(server, ServerConfig::SelfHosted { .. }) {
        middleware.push(Arc::new(PreloginPathCompat));
    }

    let client = ClientBuilder::new()
        .with_token_handler(Arc::new(PasswordManagerTokenHandler::default()))
        .with_settings(settings)
        .with_middleware(middleware)
        .build();
    PasswordManagerClient(client)
}
