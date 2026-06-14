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
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use zeroize::Zeroizing;

use crate::dto::{AutofillMode, ConnectionKind, ServerConfig};
use crate::error::{AgateError, AgateResult, ErrorKind};
use crate::providers::{BitwardenConnection, LiveConnection};

/// A known connection for the unlock-all set + add-connection prefill
/// (non-secret: provider kind + server + email only).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountRef {
    /// Which provider backs this connection. Missing in pre-provider configs →
    /// `bitwarden` (every connection was one).
    #[serde(default)]
    pub kind: ConnectionKind,
    pub server: ServerConfig,
    /// The connection id: the account email for Bitwarden, the database file
    /// path for KeePass (kept under this name for config back-compat).
    pub email: String,
    /// KeePass only: absolute path of the key file, when one is required.
    /// Non-secret (a path, not key material) — the key file itself must exist
    /// at unlock time.
    #[serde(default)]
    pub keyfile: Option<String>,
    /// Persist this connection's secret (sealed under the VMK) so it
    /// auto-unlocks whenever the app is unlocked. When false the secret is never
    /// stored and the connection must be unlocked manually each session. Defaults
    /// true so existing configs keep their auto-unlock behaviour.
    #[serde(default = "default_true")]
    pub store_credentials: bool,
}

impl AccountRef {
    /// Human label for the connection: the server name for Bitwarden, the
    /// database file name (stem) for KeePass.
    pub fn label(&self) -> String {
        match self.kind {
            ConnectionKind::Bitwarden => crate::server::server_label(&self.server),
            // Proton's id is the account email, like Bitwarden's.
            ConnectionKind::Proton => self.email.clone(),
            // KeePass is a `.kdbx` FILE — the stem drops the extension.
            ConnectionKind::Keepass => std::path::Path::new(&self.email)
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.email.clone()),
            // pass (store dir) and Enpass (vault folder) ids are directories —
            // the final path component is the human label.
            ConnectionKind::Pass | ConnectionKind::Enpass => std::path::Path::new(&self.email)
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.email.clone()),
        }
    }
}

fn default_true() -> bool {
    true
}

/// Cap on the remembered autofill picks — bounds `autofill_recent` so the config
/// file can't grow without limit. Oldest entries fall off the back.
const RECENT_FILL_CAP: usize = 50;

/// One remembered autofill pick: which login the user last filled into a given
/// target (a URL host or an app process — see `matching::recency_key`). Non-secret
/// (a target key + an opaque cipher id + the owning account), so it lives in the
/// plain config like the connection list, never the keychain. Used only to float a
/// remembered login to the top of the candidate list; never to grant access.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentFill {
    /// Stable target key from `matching::recency_key` (e.g. "host:github.com").
    pub target: String,
    pub account_email: String,
    pub item_id: String,
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
    #[serde(default)]
    pub accounts: Vec<AccountRef>,
    /// Whether — and how — Agate watches other apps' login fields to offer
    /// autofill (Off / Hotkey / Watch). Off by default: an opt-in feature that
    /// inspects other windows, so it stays disabled until the user chooses a mode.
    #[serde(default)]
    pub autofill_mode: AutofillMode,
    /// Press Enter after a successful autofill to submit the form. Off by default —
    /// some forms break on a premature submit, so the user opts in.
    #[serde(default)]
    pub autofill_submit: bool,
    /// Process stems (e.g. "discord") the watcher must NEVER offer autofill in.
    /// Empty by default.
    #[serde(default)]
    pub autofill_denylist: Vec<String>,
    /// Most-recent-first record of which login was last filled into each target,
    /// so the picker can float a remembered choice to the top. Bounded to
    /// [`RECENT_FILL_CAP`]; non-secret (see [`RecentFill`]).
    #[serde(default)]
    pub autofill_recent: Vec<RecentFill>,
}

impl PersistedConfig {
    /// Record/update a connection in the list (dedup by email/id).
    pub fn upsert_account(
        &mut self,
        kind: ConnectionKind,
        server: ServerConfig,
        email: &str,
        store_credentials: bool,
    ) {
        self.upsert_account_with_keyfile(kind, server, email, store_credentials, None);
    }

    /// `upsert_account` carrying a KeePass key-file path.
    pub fn upsert_account_with_keyfile(
        &mut self,
        kind: ConnectionKind,
        server: ServerConfig,
        email: &str,
        store_credentials: bool,
        keyfile: Option<String>,
    ) {
        self.accounts.retain(|a| a.email != email);
        self.accounts.push(AccountRef {
            kind,
            server,
            email: email.to_string(),
            keyfile,
            store_credentials,
        });
    }

    /// The server recorded for `email`, if the connection is known.
    pub fn server_for(&self, email: &str) -> Option<ServerConfig> {
        self.accounts.iter().find(|a| a.email == email).map(|a| a.server.clone())
    }

    /// The full account record for `email`, if known.
    pub fn account_for(&self, email: &str) -> Option<&AccountRef> {
        self.accounts.iter().find(|a| a.email == email)
    }

    /// Forget a connection: drop its account record, and any remembered autofill
    /// picks that pointed at it (so a re-added account never inherits stale
    /// recency for a login that may no longer exist).
    pub fn remove_account(&mut self, email: &str) {
        self.accounts.retain(|a| a.email != email);
        self.autofill_recent.retain(|r| r.account_email != email);
    }

    /// The login last filled into `target` (a `matching::recency_key`), if any —
    /// returned as `(account_email, item_id)` for the matcher's recency boost.
    pub fn recent_fill_for(&self, target: &str) -> Option<(String, String)> {
        self.autofill_recent
            .iter()
            .find(|r| r.target == target)
            .map(|r| (r.account_email.clone(), r.item_id.clone()))
    }

    /// Remember that `(account_email, item_id)` was just filled into `target`:
    /// move it to the front (most-recent-first), de-duplicating by target, and
    /// trim to [`RECENT_FILL_CAP`].
    pub fn record_recent_fill(&mut self, target: &str, account_email: &str, item_id: &str) {
        self.autofill_recent.retain(|r| r.target != target);
        self.autofill_recent.insert(
            0,
            RecentFill {
                target: target.to_string(),
                account_email: account_email.to_string(),
                item_id: item_id.to_string(),
            },
        );
        self.autofill_recent.truncate(RECENT_FILL_CAP);
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
            accounts: Vec::new(),
            autofill_mode: AutofillMode::Off,
            autofill_submit: false,
            autofill_denylist: Vec::new(),
            autofill_recent: Vec::new(),
        }
    }
}

/// The live session. All secret material is dropped on lock / logout.
#[derive(Default)]
pub struct Session {
    /// Vault Master Key (the data key that seals every connection credential),
    /// held only while unlocked so newly added connections can be sealed without
    /// re-prompting the app password. Zeroized when dropped/cleared.
    pub vmk: Option<Zeroizing<[u8; 32]>>,
    /// Unlocked connections, keyed by connection id (the account email for
    /// Bitwarden; KeePass will key by file identity).
    pub connections: HashMap<String, LiveConnection>,
    /// Default account for "new item" / folder context (one of `connections`).
    pub active_email: Option<String>,
}

impl Session {
    /// A fresh handle to a BITWARDEN connection's SDK client (the inner `Client`
    /// is cheap to clone — `Arc`-backed, sharing the unlocked key store). `None`
    /// when the connection is absent or not a Bitwarden one.
    pub fn client_for(&self, email: &str) -> Option<PasswordManagerClient> {
        self.connections
            .get(email)
            .and_then(LiveConnection::bitwarden)
            .map(|b| PasswordManagerClient(b.client.0.clone()))
    }

    /// Insert/replace a live Bitwarden connection.
    pub fn insert_bitwarden(&mut self, email: String, client: PasswordManagerClient) {
        self.connections
            .insert(email, LiveConnection::Bitwarden(BitwardenConnection::new(client)));
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
    /// Autofill runtime: the single pending detection awaiting the user's pick.
    /// A std `Mutex` (not tokio) because the Windows focus-hook callback that sets
    /// it is synchronous; locks are brief and never held across an await.
    pub autofill: std::sync::Mutex<crate::autofill::AutofillShared>,
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
            autofill: std::sync::Mutex::new(crate::autofill::AutofillShared::default()),
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
    fn autofill_mode_defaults_off_for_old_and_fresh_configs() {
        // A pre-feature config.json has no `autofill_mode` key — it must
        // deserialize to Off (the feature watches other windows, so it stays
        // disabled until the user opts in).
        let old: PersistedConfig =
            serde_json::from_str(r#"{"device_id":"d"}"#).expect("minimal config parses");
        assert_eq!(old.autofill_mode, AutofillMode::Off);
        assert_eq!(cfg().autofill_mode, AutofillMode::Off);
    }

    #[test]
    fn remove_account_drops_only_that_account() {
        let mut c = cfg();
        c.upsert_account(ConnectionKind::Bitwarden, ServerConfig::default(), "a@b.com", true);
        c.upsert_account(ConnectionKind::Bitwarden, ServerConfig::default(), "other@b.com", true);

        c.remove_account("a@b.com");

        assert!(c.account_for("a@b.com").is_none());
        assert!(c.account_for("other@b.com").is_some(), "other accounts survive");
    }
}
