//! DTOs for the local MCP (AI access) server.
//!
//! These mirror the `Ai*` types in `src/lib/types.ts`. The MCP server exposes a
//! NARROW, user-allowlisted slice of the vault to an external AI client; these
//! shapes drive the Settings → "AI Access" page (server status, the allowlist,
//! and the access audit log). No secret values ever appear in any of them — the
//! plaintext only leaves the app over the authenticated loopback MCP tool calls.

use serde::{Deserialize, Serialize};

/// One allowlist entry: a single vault item (in one connection) the AI may read.
/// Non-secret — just the owning account + the opaque cipher id. Persisted in
/// `config.json` (see `state::PersistedConfig`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiGrant {
    pub account_email: String,
    pub item_id: String,
}

/// Status of the local MCP server, shown on the AI Access settings page. `url` and
/// `token` are only populated when the server is enabled, so the page can render
/// the connect string + bearer token for the user to paste into their MCP client.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiServerStatus {
    /// The user has switched the MCP server on (persisted).
    pub enabled: bool,
    /// The loopback listener is actually bound + serving this process.
    pub running: bool,
    /// `http://127.0.0.1:<port>/mcp`, when enabled.
    pub url: Option<String>,
    /// Bearer token the MCP client must send (Authorization: Bearer …), when enabled.
    pub token: Option<String>,
}

/// One line in the in-memory access audit log: every tool call the MCP server
/// served (or denied) this session. Cleared on restart (never written to disk —
/// access timing + item names are sensitive). `allowed` is false for a denied
/// (non-allowlisted) read attempt.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiAuditEntry {
    /// RFC 3339 timestamp of the access.
    pub timestamp: String,
    /// The MCP tool that was invoked (e.g. `get_vault_item`).
    pub action: String,
    /// The decrypted item name, when the access targeted a specific item.
    pub item_name: Option<String>,
    /// The owning connection, when the access targeted a specific item.
    pub account_email: Option<String>,
    /// Whether the access was permitted (on the allowlist + unlocked) or denied.
    pub allowed: bool,
}
