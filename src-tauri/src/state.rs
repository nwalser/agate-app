//! Managed application state + on-disk (non-secret) config.
//!
//! Secrets never live here or in the config file — only in memory (the SDK
//! client / decrypted ciphers, dropped on lock) and the OS keychain (the
//! local-unlock blob, see `secrets.rs`). The config file holds only the chosen
//! server, a stable device id, the account email, and whether local unlock is
//! configured.

use std::path::PathBuf;

use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::Cipher;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::dto::{Folder, ServerConfig};
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Non-secret config persisted across launches.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistedConfig {
    #[serde(default = "schema_version")]
    pub schema_version: u32,
    pub server: ServerConfig,
    pub device_id: String,
    pub email: Option<String>,
    #[serde(default)]
    pub local_unlock_configured: bool,
}

fn schema_version() -> u32 {
    1
}

impl PersistedConfig {
    fn fresh() -> Self {
        Self {
            schema_version: schema_version(),
            server: ServerConfig::default(),
            device_id: uuid::Uuid::new_v4().to_string(),
            email: None,
            local_unlock_configured: false,
        }
    }
}

/// The live session. Secret material is cleared on full lock / logout.
#[derive(Default)]
pub struct Session {
    /// Active (unlocked) SDK client; `Some` while the vault is unlocked.
    pub client: Option<PasswordManagerClient>,
    /// Soft-locked client held in memory behind the local password. When local
    /// unlock is configured, locking moves `client` here instead of dropping it,
    /// so the user can re-unlock with the local password (no master password).
    /// Lost on full logout and on process exit — see `unlock.rs`.
    pub locked_client: Option<PasswordManagerClient>,
    /// Encrypted domain ciphers from the last sync, kept so the detail pane can
    /// decrypt a single item on demand. Cleared on lock.
    pub ciphers: Vec<Cipher>,
    /// Decrypted folder names from the last sync.
    pub folders: Vec<Folder>,
}

impl Session {
    /// A fresh handle to the active client (the inner SDK `Client` is cheap to
    /// clone — it's `Arc`-backed and shares the unlocked key store).
    pub fn cloned_client(&self) -> Option<PasswordManagerClient> {
        self.client.as_ref().map(|pm| PasswordManagerClient(pm.0.clone()))
    }

    /// True if there is a session at all (unlocked or soft-locked).
    pub fn has_session(&self) -> bool {
        self.client.is_some() || self.locked_client.is_some()
    }

    /// Soft lock: keep the client in memory behind the local password, but clear
    /// the decrypted item cache so a locked window exposes nothing.
    pub fn soft_lock(&mut self) {
        if let Some(client) = self.client.take() {
            self.locked_client = Some(client);
        }
        self.ciphers.clear();
        self.folders.clear();
    }

    /// Drop all in-memory secret material (full lock / logout).
    pub fn clear_secrets(&mut self) {
        self.client = None;
        self.locked_client = None;
        self.ciphers.clear();
        self.folders.clear();
    }
}

/// Tauri-managed application state.
pub struct AppState {
    pub config: Mutex<PersistedConfig>,
    pub session: Mutex<Session>,
    config_path: PathBuf,
}

impl AppState {
    /// Load (or initialize) config from the app config directory.
    pub fn load(config_dir: PathBuf) -> Self {
        let config_path = config_dir.join("config.json");
        let config = read_config(&config_path).unwrap_or_else(|| {
            // Distinguish absent (fresh install) from corrupt: a corrupt file is
            // logged loudly and replaced with defaults rather than silently eaten.
            PersistedConfig::fresh()
        });
        Self {
            config: Mutex::new(config),
            session: Mutex::new(Session::default()),
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
        Ok(cfg) => Some(cfg),
        Err(e) => {
            log::error!("config.json is corrupt, using defaults: {e}");
            None
        }
    }
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
