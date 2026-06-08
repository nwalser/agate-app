//! Server configuration → SDK `ClientSettings`.
//!
//! Supports the two Bitwarden clouds and arbitrary self-hosted / Vaultwarden
//! instances. Self-hosted Bitwarden uses `<base>/identity` and `<base>/api`
//! (the standard reverse-proxy layout); a bare host is treated the same way.

use bitwarden_core::{ClientSettings, DeviceType};

use crate::dto::ServerConfig;
use crate::error::{AgateError, AgateResult, ErrorKind};

const US_IDENTITY: &str = "https://identity.bitwarden.com";
const US_API: &str = "https://api.bitwarden.com";
const EU_IDENTITY: &str = "https://identity.bitwarden.eu";
const EU_API: &str = "https://api.bitwarden.eu";

/// Build SDK client settings for the given server + this device's stable id.
pub fn client_settings(server: &ServerConfig, device_identifier: String) -> AgateResult<ClientSettings> {
    let (identity_url, api_url) = match server {
        ServerConfig::Us => (US_IDENTITY.to_string(), US_API.to_string()),
        ServerConfig::Eu => (EU_IDENTITY.to_string(), EU_API.to_string()),
        ServerConfig::SelfHosted { base_url } => {
            let base = normalize_base(base_url)?;
            (format!("{base}/identity"), format!("{base}/api"))
        }
    };

    Ok(ClientSettings {
        identity_url,
        api_url,
        user_agent: format!("Agate/{}", env!("CARGO_PKG_VERSION")),
        device_type: DeviceType::SDK,
        device_identifier: Some(device_identifier),
        bitwarden_client_version: Some(env!("CARGO_PKG_VERSION").to_string()),
        bitwarden_package_type: None,
    })
}

/// Validate + trim a self-hosted base URL. Requires https unless it's a
/// loopback host (local dev / testing against a LAN Vaultwarden).
fn normalize_base(raw: &str) -> AgateResult<String> {
    let trimmed = raw.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(AgateError::bad_request("Server URL is empty."));
    }

    let is_https = trimmed.starts_with("https://");
    let is_http_loopback = trimmed.starts_with("http://localhost")
        || trimmed.starts_with("http://127.0.0.1")
        || trimmed.starts_with("http://[::1]");

    if !is_https && !is_http_loopback {
        return Err(AgateError::new(
            ErrorKind::BadRequest,
            "Server URL must use https:// (http:// allowed only for localhost).",
        ));
    }

    Ok(trimmed.to_string())
}
