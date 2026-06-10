//! The MCP tools Agate exposes, plus the allowlist enforcement + audit logging.
//!
//! Two tools, deliberately narrow:
//! - `list_vault_items` — metadata of the *allowlisted* items only (never secrets),
//!   so the AI can discover what it may read and obtain the `(account_email, id)`.
//! - `get_vault_item` — reveals one allowlisted item's secrets (password, current
//!   TOTP code, custom fields, notes). Anything not on the allowlist is denied.
//!
//! Every call is recorded in the in-memory audit log. The tools fail closed: a
//! locked vault, a missing grant, or a decrypt failure all yield a tool error, and
//! a denied read is logged with `allowed = false`.

use bitwarden_vault::generate_totp;
use chrono::Utc;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::dto::AiAuditEntry;
use crate::state::AppState;
use crate::vault;

use super::mcp::{ToolDef, ToolHost, ToolResult};

/// The live tool host, bound to the running app. Bridges the synchronous MCP
/// transport to Agate's async vault layer via the Tauri runtime.
pub struct AppToolHost {
    app: AppHandle,
}

impl AppToolHost {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }

    /// Whether the user has switched the MCP server on (checked per request by the
    /// transport before any vault access).
    pub fn enabled(&self) -> bool {
        tauri::async_runtime::block_on(async {
            self.app.state::<AppState>().config.lock().await.ai_server_enabled
        })
    }
}

impl ToolHost for AppToolHost {
    fn list_tools(&self) -> Vec<ToolDef> {
        tool_defs()
    }

    fn call_tool(&self, name: &str, args: &Value) -> ToolResult {
        tauri::async_runtime::block_on(dispatch(&self.app, name, args))
    }
}

fn tool_defs() -> Vec<ToolDef> {
    vec![
        ToolDef {
            name: "list_vault_items",
            description: "List the vault items the user has explicitly allowed this assistant to access. \
                Returns metadata only (id, account, name, username, uris) — never passwords. \
                Use the returned accountEmail + id with get_vault_item.",
            input_schema: json!({ "type": "object", "properties": {}, "additionalProperties": false }),
        },
        ToolDef {
            name: "get_vault_item",
            description: "Reveal one allowlisted vault item's secrets (password, current TOTP code, custom \
                fields, notes). Only items the user added to the allowlist can be read; anything else is denied.",
            input_schema: json!({
                "type": "object",
                "properties": {
                    "account_email": { "type": "string", "description": "Owning connection, from list_vault_items" },
                    "item_id": { "type": "string", "description": "Item id, from list_vault_items" }
                },
                "required": ["account_email", "item_id"],
                "additionalProperties": false
            }),
        },
    ]
}

async fn dispatch(app: &AppHandle, name: &str, args: &Value) -> ToolResult {
    let state = app.state::<AppState>();
    match name {
        "list_vault_items" => list_vault_items(&state).await,
        "get_vault_item" => get_vault_item(&state, args).await,
        other => ToolResult::error(format!("Unknown tool: {other}")),
    }
}

async fn list_vault_items(state: &AppState) -> ToolResult {
    // Fail closed when locked: no unlocked connection means nothing to read.
    if state.session.lock().await.connection_count() == 0 {
        audit(state, "list_vault_items", None, None, false).await;
        return ToolResult::error("Vault is locked. Unlock Agate, then retry.");
    }

    let all = match vault::list_items(state).await {
        Ok(items) => items,
        Err(e) => return ToolResult::error(format!("Could not read the vault: {}", e.message)),
    };

    let granted: Vec<Value> = {
        let cfg = state.config.lock().await;
        all.iter()
            .filter(|it| cfg.is_ai_granted(&it.account_email, &it.id))
            // VaultItem is non-secret metadata (id, account, name, username, uri, …).
            .filter_map(|it| serde_json::to_value(it).ok())
            .collect()
    };

    audit(state, "list_vault_items", None, None, true).await;
    ToolResult::ok(json!({ "items": granted, "count": granted.len() }).to_string())
}

async fn get_vault_item(state: &AppState, args: &Value) -> ToolResult {
    let (Some(account_email), Some(item_id)) = (
        args.get("account_email").and_then(Value::as_str),
        args.get("item_id").and_then(Value::as_str),
    ) else {
        return ToolResult::error("Missing required arguments: account_email and item_id.");
    };

    // The headline invariant: reveal a secret only for an explicitly allowlisted
    // item. Everything else is denied (and the attempt is audited).
    if !state.config.lock().await.is_ai_granted(account_email, item_id) {
        audit(state, "get_vault_item", None, Some(account_email.to_string()), false).await;
        return ToolResult::error("Not authorized: this item is not on the AI allowlist.");
    }

    let view = match vault::decrypt_one(state, account_email, item_id).await {
        Ok(v) => v,
        Err(e) => {
            audit(state, "get_vault_item", None, Some(account_email.to_string()), false).await;
            return ToolResult::error(format!("Could not read the item: {}", e.message));
        }
    };

    let login = view.login.as_ref();
    let username = login.and_then(|l| l.username.clone());
    let password = login.and_then(|l| l.password.clone());
    let uris: Vec<String> = login
        .and_then(|l| l.uris.clone())
        .unwrap_or_default()
        .into_iter()
        .filter_map(|u| u.uri)
        .collect();
    // The stored TOTP secret never leaves the app; we return the current code only.
    let totp = match login.and_then(|l| l.totp.clone()) {
        Some(secret) => generate_totp(secret, Some(Utc::now())).ok().map(|r| r.code),
        None => None,
    };
    let fields: Vec<Value> = view
        .fields
        .clone()
        .unwrap_or_default()
        .into_iter()
        .map(|f| json!({ "name": f.name, "value": f.value }))
        .collect();

    let body = json!({
        "name": view.name,
        "username": username,
        "password": password,
        "uris": uris,
        "totp": totp,
        "notes": view.notes,
        "fields": fields,
    });

    audit(state, "get_vault_item", Some(view.name.clone()), Some(account_email.to_string()), true).await;
    ToolResult::ok(body.to_string())
}

async fn audit(
    state: &AppState,
    action: &str,
    item_name: Option<String>,
    account_email: Option<String>,
    allowed: bool,
) {
    if !allowed {
        log::warn!("MCP access denied: {action}");
    }
    state
        .push_ai_audit(AiAuditEntry {
            timestamp: Utc::now().to_rfc3339(),
            action: action.to_string(),
            item_name,
            account_email,
            allowed,
        })
        .await;
}
