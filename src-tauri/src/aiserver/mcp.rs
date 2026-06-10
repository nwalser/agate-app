//! MCP (Model Context Protocol) over JSON-RPC 2.0 — the wire-format layer.
//!
//! Pure + transport-agnostic: [`handle_jsonrpc`] parses one request body, dispatches
//! the MCP methods we support (`initialize`, `ping`, `tools/list`, `tools/call`),
//! and returns the response body — or `None` for a notification that needs no
//! reply. Tool execution is delegated to a [`ToolHost`] so this layer is fully
//! unit-testable without a live vault (see the tests below).

use serde_json::{json, Value};

/// Protocol revision we advertise. Clients that negotiate a different revision
/// still interoperate with the basic `tools` surface used here.
const PROTOCOL_VERSION: &str = "2024-11-05";

/// A tool advertised by `tools/list`.
pub struct ToolDef {
    pub name: &'static str,
    pub description: &'static str,
    pub input_schema: Value,
}

/// The outcome of a `tools/call`. `is_error` marks a tool-level failure (surfaced
/// to the model inside the result, per the MCP spec) — distinct from a JSON-RPC
/// protocol error (unknown method / bad params), which is returned as an `error`.
pub struct ToolResult {
    pub text: String,
    pub is_error: bool,
}

impl ToolResult {
    pub fn ok(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: false }
    }
    pub fn error(text: impl Into<String>) -> Self {
        Self { text: text.into(), is_error: true }
    }
}

/// Executes the actual tools. Implemented by the live server (over `AppState`) and
/// by a fake in tests. Synchronous: the live impl bridges to async internally.
pub trait ToolHost {
    fn list_tools(&self) -> Vec<ToolDef>;
    fn call_tool(&self, name: &str, args: &Value) -> ToolResult;
}

/// Handle one request body (a single JSON-RPC object, or a batch array). Returns
/// the serialized response body, or `None` when every message was a notification
/// (no reply expected).
pub fn handle_jsonrpc(body: &str, host: &dyn ToolHost) -> Option<String> {
    let parsed: Value = match serde_json::from_str(body) {
        Ok(v) => v,
        Err(e) => return Some(error_body(Value::Null, -32700, format!("Parse error: {e}"))),
    };

    match parsed {
        Value::Array(items) => {
            let responses: Vec<Value> = items.iter().filter_map(|m| handle_one(m, host)).collect();
            if responses.is_empty() {
                None
            } else {
                Some(Value::Array(responses).to_string())
            }
        }
        obj => handle_one(&obj, host).map(|v| v.to_string()),
    }
}

/// Dispatch one message. Returns `None` for a notification (no `id`).
fn handle_one(msg: &Value, host: &dyn ToolHost) -> Option<Value> {
    // A JSON-RPC notification carries no `id` and never gets a response.
    let id = msg.get("id").cloned()?;
    let method = msg.get("method").and_then(Value::as_str).unwrap_or("");
    let params = msg.get("params").cloned().unwrap_or(Value::Null);

    let result: Result<Value, (i64, String)> = match method {
        "initialize" => Ok(initialize_result()),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(tools_list_result(host)),
        "tools/call" => tools_call_result(host, &params),
        other => Err((-32601, format!("Method not found: {other}"))),
    };

    Some(match result {
        Ok(value) => json!({ "jsonrpc": "2.0", "id": id, "result": value }),
        Err((code, message)) => {
            json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
        }
    })
}

fn initialize_result() -> Value {
    json!({
        "protocolVersion": PROTOCOL_VERSION,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": { "name": "agate", "version": env!("CARGO_PKG_VERSION") },
    })
}

fn tools_list_result(host: &dyn ToolHost) -> Value {
    let tools: Vec<Value> = host
        .list_tools()
        .into_iter()
        .map(|t| {
            json!({
                "name": t.name,
                "description": t.description,
                "inputSchema": t.input_schema,
            })
        })
        .collect();
    json!({ "tools": tools })
}

fn tools_call_result(host: &dyn ToolHost, params: &Value) -> Result<Value, (i64, String)> {
    let name = params
        .get("name")
        .and_then(Value::as_str)
        .ok_or((-32602, "Invalid params: missing tool name".to_string()))?;
    let args = params.get("arguments").cloned().unwrap_or(Value::Null);
    let result = host.call_tool(name, &args);
    Ok(json!({
        "content": [ { "type": "text", "text": result.text } ],
        "isError": result.is_error,
    }))
}

fn error_body(id: Value, code: i64, message: String) -> String {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fake host: advertises one `echo` tool that returns its `text` argument,
    /// and reports an error for any other tool. Lets us exercise the protocol layer
    /// with no AppState / vault.
    struct FakeHost;
    impl ToolHost for FakeHost {
        fn list_tools(&self) -> Vec<ToolDef> {
            vec![ToolDef {
                name: "echo",
                description: "echoes text back",
                input_schema: json!({ "type": "object" }),
            }]
        }
        fn call_tool(&self, name: &str, args: &Value) -> ToolResult {
            if name == "echo" {
                ToolResult::ok(args.get("text").and_then(Value::as_str).unwrap_or("").to_string())
            } else {
                ToolResult::error(format!("no such tool: {name}"))
            }
        }
    }

    fn call(body: &str) -> Value {
        let out = handle_jsonrpc(body, &FakeHost).expect("expected a response body");
        serde_json::from_str(&out).expect("response must be valid JSON")
    }

    #[test]
    fn initialize_reports_server_info() {
        let resp = call(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}"#);
        assert_eq!(resp["id"], json!(1));
        assert_eq!(resp["result"]["serverInfo"]["name"], json!("agate"));
        assert_eq!(resp["result"]["protocolVersion"], json!(PROTOCOL_VERSION));
    }

    #[test]
    fn tools_list_advertises_the_hosts_tools() {
        let resp = call(r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#);
        let tools = resp["result"]["tools"].as_array().expect("tools array");
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], json!("echo"));
        assert!(tools[0]["inputSchema"].is_object(), "each tool carries an inputSchema");
    }

    #[test]
    fn tools_call_routes_arguments_to_the_host() {
        let resp = call(
            r#"{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"echo","arguments":{"text":"hi"}}}"#,
        );
        assert_eq!(resp["result"]["isError"], json!(false));
        assert_eq!(resp["result"]["content"][0]["type"], json!("text"));
        assert_eq!(resp["result"]["content"][0]["text"], json!("hi"));
    }

    #[test]
    fn tool_level_failure_is_marked_is_error_not_a_protocol_error() {
        let resp = call(
            r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"nope","arguments":{}}}"#,
        );
        // The call still "succeeds" at the protocol level; the failure rides in the result.
        assert!(resp.get("error").is_none(), "tool failure must not be a JSON-RPC error");
        assert_eq!(resp["result"]["isError"], json!(true));
        assert!(resp["result"]["content"][0]["text"].as_str().unwrap().contains("no such tool"));
    }

    #[test]
    fn unknown_method_is_a_protocol_error() {
        let resp = call(r#"{"jsonrpc":"2.0","id":5,"method":"does/not/exist"}"#);
        assert_eq!(resp["error"]["code"], json!(-32601));
    }

    #[test]
    fn notification_without_id_gets_no_response() {
        let out = handle_jsonrpc(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#, &FakeHost);
        assert!(out.is_none(), "a notification must not produce a reply");
    }

    #[test]
    fn malformed_json_returns_a_parse_error() {
        let out = handle_jsonrpc("{not json", &FakeHost).expect("parse errors still reply");
        let resp: Value = serde_json::from_str(&out).unwrap();
        assert_eq!(resp["error"]["code"], json!(-32700));
    }
}
