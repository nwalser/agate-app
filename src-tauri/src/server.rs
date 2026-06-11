//! Server configuration → SDK `ClientSettings`.
//!
//! Supports the two Bitwarden clouds and arbitrary self-hosted / Vaultwarden
//! instances. Self-hosted Bitwarden uses `<base>/identity` and `<base>/api`
//! (the standard reverse-proxy layout); a bare host is treated the same way.

use bitwarden_core::{ClientSettings, DeviceType};

use crate::dto::ServerConfig;
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Human label for a server: the cloud region name, or the self-hosted base URL.
pub fn server_label(server: &ServerConfig) -> String {
    match server {
        ServerConfig::Us => "Bitwarden US".to_string(),
        ServerConfig::Eu => "Bitwarden EU".to_string(),
        ServerConfig::SelfHosted { base_url } => base_url.clone(),
    }
}

/// Public access URL for a Send, given its server-issued access id and the
/// base64url decryption key. The key lives in the URL fragment (`#`), so it is
/// never sent to the server when the recipient opens the link — same as the
/// official clients. US cloud uses the short `send.bitwarden.com` host; EU and
/// self-hosted use the web vault's `/#/send/` route.
pub fn send_link(server: &ServerConfig, access_id: &str, key: &str) -> String {
    match server {
        ServerConfig::Us => format!("https://send.bitwarden.com/#{access_id}/{key}"),
        ServerConfig::Eu => format!("https://vault.bitwarden.eu/#/send/{access_id}/{key}"),
        ServerConfig::SelfHosted { base_url } => {
            let base = base_url.trim().trim_end_matches('/');
            format!("{base}/#/send/{access_id}/{key}")
        }
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn self_hosted_urls_get_identity_and_api_suffixes() {
        let s = client_settings(
            &ServerConfig::SelfHosted { base_url: "https://vault.example.com/".into() },
            "dev-id".into(),
        )
        .unwrap();
        assert_eq!(s.identity_url, "https://vault.example.com/identity");
        assert_eq!(s.api_url, "https://vault.example.com/api");
    }

    #[test]
    fn cloud_regions_resolve() {
        assert!(client_settings(&ServerConfig::Us, "d".into()).unwrap().api_url.contains("api.bitwarden.com"));
        assert!(client_settings(&ServerConfig::Eu, "d".into()).unwrap().identity_url.contains("identity.bitwarden.eu"));
    }

    #[test]
    fn send_link_uses_short_host_for_us_and_web_route_elsewhere() {
        assert_eq!(
            send_link(&ServerConfig::Us, "abc", "k3y"),
            "https://send.bitwarden.com/#abc/k3y",
        );
        assert_eq!(
            send_link(&ServerConfig::Eu, "abc", "k3y"),
            "https://vault.bitwarden.eu/#/send/abc/k3y",
        );
    }

    #[test]
    fn send_link_self_hosted_trims_trailing_slash() {
        assert_eq!(
            send_link(
                &ServerConfig::SelfHosted { base_url: "https://vault.example.com/".into() },
                "abc",
                "k3y",
            ),
            "https://vault.example.com/#/send/abc/k3y",
        );
    }

    #[test]
    fn normalize_base_enforces_scheme() {
        assert_eq!(normalize_base("https://x.test/").unwrap(), "https://x.test");
        assert!(normalize_base("http://x.test").is_err());
        assert!(normalize_base("http://localhost:8080").is_ok());
        assert!(normalize_base("http://127.0.0.1").is_ok());
        assert!(normalize_base("   ").is_err());
    }
}
