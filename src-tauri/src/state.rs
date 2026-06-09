//! Managed application state + on-disk (non-secret) config.
//!
//! Secrets never live in the config file — only in memory (the per-connection SDK
//! clients / decrypted ciphers and the App Unlock Key, all dropped on lock) and
//! the OS keychain (the sealed per-connection credentials + the app-unlock
//! descriptor, see `secrets.rs`). The config file holds only the connection list
//! (server + email), a stable device id, the app-unlock flags, and non-secret
//! preferences (dark-web opt-in).

use std::collections::HashMap;
use std::path::PathBuf;

use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::Cipher;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::dto::{BreachRecord, Folder, ServerConfig};
use crate::error::{AgateError, AgateResult, ErrorKind};

/// A known connection for the unlock-all set + add-connection prefill
/// (non-secret: server + email only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRef {
    pub server: ServerConfig,
    pub email: String,
    /// Persist this connection's master password (sealed under the VMK) so it
    /// auto-unlocks whenever the app is unlocked. When false the password is never
    /// stored and the connection must be unlocked manually each session. Defaults
    /// true so existing configs keep their auto-unlock behaviour.
    #[serde(default = "default_true")]
    pub store_credentials: bool,
}

fn default_true() -> bool {
    true
}

/// Non-secret config persisted across launches. `accounts` is the set of
/// configured connections; `server` is just the last-used server (add-connection
/// form prefill). The app-unlock flags are app-wide, not per-account.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedConfig {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    #[serde(default)]
    pub server: ServerConfig,
    pub device_id: String,
    /// A single app password (App Unlock Key) is configured. Unlock is always bound
    /// to this machine (a device pepper mixes into the AUK, so the stored blob is
    /// unusable on another device); there is no unbound mode.
    #[serde(default)]
    pub app_unlock_configured: bool,
    /// Windows Hello unlock is enabled (app-wide).
    #[serde(default)]
    pub hello_configured: bool,
    /// The user opted in to the dark-web monitor (emails leave the device to a
    /// third-party breach API). Default false; a non-secret preference.
    #[serde(default)]
    pub darkweb_consent: bool,
    /// Rotating start index for the dark-web vault scan. When the vault holds more
    /// emails than one run's rate-budget cap, the scan walks a window from here and
    /// advances it each run so every email is eventually covered rather than the
    /// tail being permanently dropped. Non-secret; default 0.
    #[serde(default)]
    pub darkweb_scan_offset: usize,
    #[serde(default)]
    pub accounts: Vec<AccountRef>,
}

impl PersistedConfig {
    /// Record/update a connection in the list (dedup by email).
    pub fn upsert_account(&mut self, server: ServerConfig, email: &str, store_credentials: bool) {
        self.accounts.retain(|a| a.email != email);
        self.accounts
            .push(AccountRef { server, email: email.to_string(), store_credentials });
    }

    /// The server recorded for `email`, if the connection is known.
    pub fn server_for(&self, email: &str) -> Option<ServerConfig> {
        self.accounts.iter().find(|a| a.email == email).map(|a| a.server.clone())
    }

    /// The full account record for `email`, if known.
    pub fn account_for(&self, email: &str) -> Option<&AccountRef> {
        self.accounts.iter().find(|a| a.email == email)
    }
}

fn schema_version() -> u32 {
    2
}

impl PersistedConfig {
    fn fresh() -> Self {
        Self {
            schema_version: schema_version(),
            server: ServerConfig::default(),
            device_id: uuid::Uuid::new_v4().to_string(),
            app_unlock_configured: false,
            hello_configured: false,
            darkweb_consent: false,
            darkweb_scan_offset: 0,
            accounts: Vec::new(),
        }
    }
}

/// One live, unlocked connection: its SDK client plus the last sync's encrypted
/// ciphers (decrypted on demand) and decrypted folders.
pub struct LiveConnection {
    pub client: PasswordManagerClient,
    pub ciphers: Vec<Cipher>,
    pub folders: Vec<Folder>,
}

impl LiveConnection {
    pub fn new(client: PasswordManagerClient) -> Self {
        Self { client, ciphers: Vec::new(), folders: Vec::new() }
    }
}

/// The live session. All secret material is dropped on lock / logout.
#[derive(Default)]
pub struct Session {
    /// Vault Master Key (the data key that seals every connection credential),
    /// held only while unlocked so newly added connections can be sealed without
    /// re-prompting the app password. Zeroized when dropped/cleared.
    pub vmk: Option<Zeroizing<[u8; 32]>>,
    /// Unlocked connections, keyed by account email.
    pub connections: HashMap<String, LiveConnection>,
    /// Default account for "new item" / folder context (one of `connections`).
    pub active_email: Option<String>,
}

impl Session {
    /// A fresh handle to a connection's client (the inner SDK `Client` is cheap to
    /// clone — `Arc`-backed, sharing the unlocked key store).
    pub fn client_for(&self, email: &str) -> Option<PasswordManagerClient> {
        self.connections.get(email).map(|c| PasswordManagerClient(c.client.0.clone()))
    }

    /// Number of live connections.
    pub fn connection_count(&self) -> usize {
        self.connections.len()
    }

    /// Drop all in-memory secret material (lock / logout): every client, the
    /// decrypted caches, and the AUK (zeroized on drop).
    pub fn clear_secrets(&mut self) {
        self.vmk = None; // Zeroizing zeroes the VMK on drop.
        self.connections.clear();
        self.active_email = None;
    }
}

/// Tauri-managed application state.
pub struct AppState {
    pub config: Mutex<PersistedConfig>,
    pub session: Mutex<Session>,
    /// Cached HIBP public breach directory (large, CDN-cached, non-secret). Fetched
    /// once per process the first time the breach directory is opened. See darkweb.rs.
    pub breach_directory: Mutex<Option<Vec<BreachRecord>>>,
    config_path: PathBuf,
}

impl AppState {
    /// Load (or initialize) config from the app config directory.
    pub fn load(config_dir: PathBuf) -> Self {
        let config_path = config_dir.join("config.json");
        let config = read_config(&config_path).unwrap_or_else(PersistedConfig::fresh);
        Self {
            config: Mutex::new(config),
            session: Mutex::new(Session::default()),
            breach_directory: Mutex::new(None),
            config_path,
        }
    }

    /// Persist the current config atomically (temp file + rename).
    pub async fn save_config(&self) -> AgateResult<()> {
        let cfg = self.config.lock().await;
        write_config(&self.config_path, &cfg)
    }
}

fn read_config(path: &PathBuf) -> Option<PersistedConfig> {
    let bytes = std::fs::read(path).ok()?;
    match serde_json::from_slice::<PersistedConfig>(&bytes) {
        Ok(mut cfg) => {
            migrate(&mut cfg);
            Some(cfg)
        }
        Err(e) => {
            // Distinguish absent (the `?` above) from corrupt: a corrupt file is
            // logged loudly and replaced with defaults rather than silently eaten.
            log::error!("config.json is corrupt, using defaults: {e}");
            None
        }
    }
}

/// Migrate older config in place. v1 (single-account local-unlock) → v2 (unified
/// app-unlock): keep the connection list and the dark-web opt-in, but the old
/// per-account local-unlock / Hello flags no longer apply — clear them so the user
/// is routed through app-unlock setup, and best-effort delete the orphaned v1
/// keychain verifiers (which were keyed by bare email).
fn migrate(cfg: &mut PersistedConfig) {
    if cfg.schema_version >= 2 {
        return;
    }
    for acct in &cfg.accounts {
        let _ = crate::secrets::delete_key(&acct.email); // ignore: best-effort cleanup
    }
    cfg.app_unlock_configured = false;
    cfg.hello_configured = false;
    cfg.schema_version = 2;
    log::info!("migrated config v1 → v2 (app-unlock); {} connection(s) kept", cfg.accounts.len());
}

fn write_config(path: &PathBuf, cfg: &PersistedConfig) -> AgateResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| AgateError::new(ErrorKind::Internal, format!("create config dir: {e}")))?;
    }
    let json = serde_json::to_vec_pretty(cfg)
        .map_err(|e| AgateError::internal(format!("serialize config: {e}")))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &json)
        .map_err(|e| AgateError::internal(format!("write temp config: {e}")))?;
    std::fs::rename(&tmp, path)
        .map_err(|e| AgateError::internal(format!("rename config: {e}")))?;
    Ok(())
}
