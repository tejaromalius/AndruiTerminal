//! MCP JSON-RPC 2.0 message handling (stdio transport, one message per line).

use serde_json::{json, Map, Value};

use super::client::ApiClient;
use super::resources;
use super::tools;

/// Newest first; an unsupported client version is answered with the newest.
const PROTOCOL_VERSIONS: &[&str] = &["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Controls Android devices through the local AndruiTerminal server. \
Start with android_list_devices. Destructive operations and shell commands return a pending \
approval that only the user can approve in the AndruiTerminal UI.";

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}})
}

fn success(id: Value, result: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "result": result})
}

pub fn parse_error() -> Value {
    error(Value::Null, -32700, "Parse error")
}

/// Handles one message; returns the response, or `None` for notifications.
pub async fn handle(client: &ApiClient, message: Value) -> Option<Value> {
    let Some(object) = message.as_object() else {
        return Some(error(Value::Null, -32600, "Invalid request"));
    };
    let id = object.get("id").cloned();
    let method = object.get("method").and_then(Value::as_str);
    let (Some(id), Some(method)) = (id, method) else {
        // Notifications (initialized, cancelled) and responses need no reply.
        return None;
    };
    if object.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error(id, -32600, "Invalid request"));
    }
    let empty = Map::new();
    let params = object
        .get("params")
        .and_then(Value::as_object)
        .unwrap_or(&empty);

    Some(match method {
        "initialize" => {
            let requested = params.get("protocolVersion").and_then(Value::as_str);
            let version = requested
                .filter(|v| PROTOCOL_VERSIONS.contains(v))
                .unwrap_or(PROTOCOL_VERSIONS[0]);
            success(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": {
                        "tools": {"listChanged": false},
                        "resources": {"subscribe": false, "listChanged": false}
                    },
                    "serverInfo": {"name": "andrui-terminal", "version": env!("CARGO_PKG_VERSION")},
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => success(id, json!({})),
        "tools/list" => success(id, json!({"tools": tools::definitions()})),
        "tools/call" => {
            let Some(name) = params.get("name").and_then(Value::as_str) else {
                return Some(error(id, -32602, "Missing tool name"));
            };
            let args = params
                .get("arguments")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            match tools::call(client, name, args).await {
                None => error(id, -32602, &format!("Unknown tool: {name}")),
                Some(Ok(content)) => success(id, json!({"content": content, "isError": false})),
                Some(Err(e)) => success(
                    id,
                    json!({"content": [{"type": "text", "text": e.0}], "isError": true}),
                ),
            }
        }
        "resources/list" => success(id, json!({"resources": resources::definitions()})),
        "resources/read" => {
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return Some(error(id, -32602, "Missing uri parameter"));
            };
            match resources::read(client, uri).await {
                Ok(contents) => success(id, json!({"contents": contents})),
                Err(e) => success(
                    id,
                    json!({"contents": [{"uri": uri, "mimeType": "text/plain", "text": format!("Error reading resource: {}", e.0)}]}),
                ),
            }
        }
        _ => error(id, -32601, &format!("Method not found: {method}")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn client() -> ApiClient {
        // Port 9 (discard) on loopback: nothing should connect in these tests.
        ApiClient::new("http://127.0.0.1:9").unwrap()
    }

    async fn call(message: Value) -> Option<Value> {
        handle(&client(), message).await
    }

    #[tokio::test]
    async fn initialize_negotiates_version() {
        let res = call(json!({"jsonrpc": "2.0", "id": 1, "method": "initialize",
                              "params": {"protocolVersion": "2024-11-05"}}))
        .await
        .unwrap();
        assert_eq!(res["id"], 1);
        assert_eq!(res["result"]["protocolVersion"], "2024-11-05");
        assert!(res["result"]["capabilities"]["tools"].is_object());
        assert!(res["result"]["capabilities"]["resources"].is_object());

        let res = call(json!({"jsonrpc": "2.0", "id": 2, "method": "initialize",
                              "params": {"protocolVersion": "1999-01-01"}}))
        .await
        .unwrap();
        assert_eq!(res["result"]["protocolVersion"], PROTOCOL_VERSIONS[0]);
    }

    #[tokio::test]
    async fn lists_tools() {
        let res = call(json!({"jsonrpc": "2.0", "id": "a", "method": "tools/list"}))
            .await
            .unwrap();
        let tools = res["result"]["tools"].as_array().unwrap();
        assert!(tools.iter().any(|t| t["name"] == "android_list_devices"));
        assert!(tools.iter().any(|t| t["name"] == "android_run_operation"));
    }

    #[tokio::test]
    async fn lists_resources() {
        let res = call(json!({"jsonrpc": "2.0", "id": "res1", "method": "resources/list"}))
            .await
            .unwrap();
        let resources = res["result"]["resources"].as_array().unwrap();
        assert!(resources.iter().any(|r| r["uri"] == "android://devices"));
        assert!(resources.iter().any(|r| r["uri"] == "android://audit"));
        assert!(resources.iter().any(|r| r["uri"] == "android://hierarchy"));
        assert!(resources.iter().any(|r| r["uri"] == "android://screenshot"));
        assert!(resources.iter().any(|r| r["uri"] == "android://logcat"));
    }

    #[tokio::test]
    async fn errors_and_notifications() {
        assert!(
            call(json!({"jsonrpc": "2.0", "method": "notifications/initialized"}))
                .await
                .is_none()
        );
        let res = call(json!({"jsonrpc": "2.0", "id": 3, "method": "nope"}))
            .await
            .unwrap();
        assert_eq!(res["error"]["code"], -32601);
        let res = call(json!({"jsonrpc": "2.0", "id": 4, "method": "tools/call",
                              "params": {"name": "no_such_tool"}}))
        .await
        .unwrap();
        assert_eq!(res["error"]["code"], -32602);
        let res = call(json!([1, 2])).await.unwrap();
        assert_eq!(res["error"]["code"], -32600);
        let res = call(json!({"id": 5, "method": "ping"})).await.unwrap();
        assert_eq!(res["error"]["code"], -32600);
    }

    #[tokio::test]
    async fn tool_failure_is_reported_in_result() {
        let res = call(json!({"jsonrpc": "2.0", "id": 6, "method": "tools/call",
                              "params": {"name": "android_get_job", "arguments": {"jobId": "../x"}}}))
        .await
        .unwrap();
        assert_eq!(res["result"]["isError"], true);
        assert!(res["result"]["content"][0]["text"]
            .as_str()
            .unwrap()
            .contains("Invalid id"));
    }
}
