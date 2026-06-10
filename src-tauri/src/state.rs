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

use bitwarden_collections::collection::Collection;
use bitwarden_pm::PasswordManagerClient;
use bitwarden_vault::{Cipher, Folder as VaultFolder};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::dto::{AiAuditEntry, AiGrant, BreachRecord, ServerConfig};
use crate::error::{AgateError, AgateResult, ErrorKind};

/// Cap on the in-memory MCP access audit log (newest kept, oldest dropped).
const AI_AUDIT_CAP: usize = 200;

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
    /// Closing the main window keeps Agate running in the system tray instead
    /// of quitting. Off by default — close means quit unless the user opts in
    /// (Settings → Appearance → Startup).
    #[serde(default)]
    pub close_to_tray: bool,
    /// The local MCP (AI access) server is switched on. Off by default — the
    /// feature is opt-in and exposes vault items to an external AI client.
    #[serde(default)]
    pub ai_server_enabled: bool,
    /// The allowlist: the only items the MCP server will ever reveal. Non-secret
    /// (owning account + opaque cipher id). Empty by default — nothing is exposed
    /// until the user explicitly grants an item.
    #[serde(default)]
    pub ai_grants: Vec<AiGrant>,
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

    /// Forget a connection: drop its account record AND its AI allowlist grants.
    /// Grants are capability state tied to the connection — leaving them behind
    /// would silently re-expose the same items if the account is re-added later.
    pub fn remove_account(&mut self, email: &str) {
        self.accounts.retain(|a| a.email != email);
        self.ai_grants.retain(|g| g.account_email != email);
    }

    /// Is this `(account, item)` on the AI allowlist?
    pub fn is_ai_granted(&self, account_email: &str, item_id: &str) -> bool {
        self.ai_grants
            .iter()
            .any(|g| g.account_email == account_email && g.item_id == item_id)
    }

    /// Add (`granted` = true) or remove (`granted` = false) an item from the AI
    /// allowlist. Idempotent: adding twice is a no-op, removing an absent grant is
    /// a no-op.
    pub fn set_ai_grant(&mut self, account_email: &str, item_id: &str, granted: bool) {
        let present = self.is_ai_granted(account_email, item_id);
        if granted && !present {
            self.ai_grants
                .push(AiGrant { account_email: account_email.to_string(), item_id: item_id.to_string() });
        } else if !granted && present {
            self.ai_grants
                .retain(|g| !(g.account_email == account_email && g.item_id == item_id));
        }
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
            close_to_tray: false,
            ai_server_enabled: false,
            ai_grants: Vec::new(),
        }
    }
}

/// One live, unlocked connection: its SDK client plus the last sync's encrypted
/// ciphers and folders, both decrypted on demand (by `list_items` / `list_folders`).
pub struct LiveConnection {
    pub client: PasswordManagerClient,
    pub ciphers: Vec<Cipher>,
    pub folders: Vec<VaultFolder>,
    pub collections: Vec<Collection>,
}

impl LiveConnection {
    pub fn new(client: PasswordManagerClient) -> Self {
        Self { client, ciphers: Vec::new(), folders: Vec::new(), collections: Vec::new() }
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
    /// In-memory MCP access audit log (newest last, capped). Never persisted —
    /// access timing + item names are sensitive, so it lives only for the session.
    pub ai_audit: Mutex<Vec<AiAuditEntry>>,
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
            ai_audit: Mutex::new(Vec::new()),
            config_path,
        }
    }

    /// THE config write path: mutate + persist as one transaction. If the disk
    /// write fails the in-memory value is ROLLED BACK, so memory and disk can
    /// never disagree (the failure mode where a command errors but the app keeps
    /// acting on the unsaved state). Returns the closure's value on success.
    pub async fn update_config<T>(
        &self,
        mutate: impl FnOnce(&mut PersistedConfig) -> T,
    ) -> AgateResult<T> {
        let mut cfg = self.config.lock().await;
        let backup = cfg.clone();
        let out = mutate(&mut cfg);
        if let Err(e) = write_config(&self.config_path, &cfg) {
            *cfg = backup;
            return Err(e);
        }
        Ok(out)
    }

    /// Append one entry to the in-memory MCP audit log, trimming to the cap.
    pub async fn push_ai_audit(&self, entry: AiAuditEntry) {
        let mut log = self.ai_audit.lock().await;
        log.push(entry);
        let len = log.len();
        if len > AI_AUDIT_CAP {
            log.drain(0..len - AI_AUDIT_CAP);
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> PersistedConfig {
        PersistedConfig::fresh()
    }

    #[test]
    fn close_to_tray_defaults_off_for_old_and_fresh_configs() {
        // A pre-feature config.json has no `close_to_tray` key — it must
        // deserialize to off (close keeps meaning quit until the user opts in).
        let old: PersistedConfig =
            serde_json::from_str(r#"{"device_id":"d"}"#).expect("minimal config parses");
        assert!(!old.close_to_tray);
        assert!(!cfg().close_to_tray);
    }

    #[test]
    fn ai_grant_round_trip() {
        let mut c = cfg();
        assert!(!c.is_ai_granted("a@b.com", "item-1"), "nothing is granted by default");

        c.set_ai_grant("a@b.com", "item-1", true);
        assert!(c.is_ai_granted("a@b.com", "item-1"));
        assert_eq!(c.ai_grants.len(), 1);

        c.set_ai_grant("a@b.com", "item-1", false);
        assert!(!c.is_ai_granted("a@b.com", "item-1"));
        assert!(c.ai_grants.is_empty());
    }

    #[test]
    fn ai_grant_is_idempotent_and_scoped_per_account() {
        let mut c = cfg();
        c.set_ai_grant("a@b.com", "item-1", true);
        c.set_ai_grant("a@b.com", "item-1", true); // duplicate add is a no-op
        assert_eq!(c.ai_grants.len(), 1, "granting twice must not duplicate");

        // Same item id under a different connection is a distinct grant.
        c.set_ai_grant("other@b.com", "item-1", true);
        assert_eq!(c.ai_grants.len(), 2);
        assert!(c.is_ai_granted("other@b.com", "item-1"));
        assert!(!c.is_ai_granted("a@b.com", "item-2"), "a different item is not granted");

        // Removing an absent grant is a no-op.
        c.set_ai_grant("a@b.com", "missing", false);
        assert_eq!(c.ai_grants.len(), 2);
    }

    #[test]
    fn remove_account_drops_its_ai_grants() {
        let mut c = cfg();
        c.upsert_account(ServerConfig::default(), "a@b.com", true);
        c.upsert_account(ServerConfig::default(), "other@b.com", true);
        c.set_ai_grant("a@b.com", "item-1", true);
        c.set_ai_grant("other@b.com", "item-2", true);

        c.remove_account("a@b.com");

        assert!(c.account_for("a@b.com").is_none());
        assert!(
            !c.is_ai_granted("a@b.com", "item-1"),
            "grants must not survive connection removal — re-adding the account would silently re-expose them"
        );
        assert!(c.is_ai_granted("other@b.com", "item-2"), "other accounts keep their grants");
    }
}
