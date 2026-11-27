//! MCP tool definitions served by `andrui-terminal mcp` and listed by `GET /ai/mcp/access`.

use serde_json::{json, Value};

pub const STATS_SCOPES: [&str; 12] = [
    "device",
    "network",
    "permissions",
    "files",
    "applications",
    "logs",
    "shell",
    "telemetry",
    "screen",
    "system",
    "processes",
    "package",
];

/// UI actions submitted as `automation.<action>` catalog operations.
pub const UI_ACTIONS: [&str; 9] = [
    "click",
    "longClick",
    "setText",
    "clearText",
    "scroll",
    "swipe",
    "pressKey",
    "wait",
    "assert",
];

/// How a tool is gated: `never` tools only read or cancel MCP jobs; `perOperation` tools
/// submit catalog operations through `POST /approvals` and follow that operation's rule.
pub fn tool_approval(name: &str) -> &'static str {
    match name {
        "android_run_operation" | "android_ui_action" => "perOperation",
        _ => "never",
    }
}

fn tool(name: &str, description: &str, properties: Value, required: &[&str]) -> Value {
    json!({
        "name": name,
        "description": description,
        "inputSchema": {"type": "object", "properties": properties, "required": required},
    })
}

pub fn definitions() -> Vec<Value> {
    let device = json!({"type": "string", "description": "Device ID from android_list_devices"});
    let wait = json!({"type": "integer", "description": "Milliseconds to wait for the job to finish (default 15000, max 60000)"});
    let number = json!({"type": "number"});
    vec![
        tool(
            "android_list_devices",
            "List connected Android devices with their state (device, offline, unauthorized, recovery, ...).",
            json!({}),
            &[],
        ),
        tool(
            "android_device_info",
            "Read device facts with fixed read-only probes; no approval needed. Scope 'device' (default) returns sections props (getprop), battery, meminfo, storage, screenSize, density, ipAddr, uptime. Use sections and grep to keep output small.",
            json!({
                "deviceId": device,
                "scope": {"type": "string", "enum": STATS_SCOPES},
                "package": {"type": "string", "description": "Package identifier required for package scope"},
                "sections": {"type": "array", "items": {"type": "string"}, "description": "Only these section names"},
                "grep": {"type": "string", "description": "Keep only lines containing this text (case-insensitive)"},
            }),
            &["deviceId"],
        ),
        tool(
            "android_list_operations",
            "List catalog ADB operations (id, label, category, destructive, available). Pass operationId to get one operation's parameter fields.",
            json!({
                "operationId": {"type": "string"},
                "category": {"type": "string", "description": "Filter by category: a letter such as 'D', or 'Automation'"},
            }),
            &[],
        ),
        tool(
            "android_preview_operation",
            "Show the exact adb command an operation would run, without running it.",
            json!({"operationId": {"type": "string"}, "deviceId": device, "parameters": {"type": "object"}}),
            &["operationId"],
        ),
        tool(
            "android_run_operation",
            "Run a catalog operation. Operations outside the read-only allowlist are not run directly: they return a pending approval that the user must approve in the AndruiTerminal UI; poll it with android_get_approval.",
            json!({"operationId": {"type": "string"}, "deviceId": device, "parameters": {"type": "object"}, "waitMs": wait}),
            &["operationId"],
        ),
        tool(
            "android_get_approval",
            "Get the status of a pending approval (pending, approved, denied, expired, failed) and the job it started.",
            json!({"approvalId": {"type": "string"}, "waitMs": wait}),
            &["approvalId"],
        ),
        tool(
            "android_get_job",
            "Get a job's status, exit code and output (output is tail-truncated).",
            json!({"jobId": {"type": "string"}, "waitMs": wait}),
            &["jobId"],
        ),
        tool(
            "android_cancel_job",
            "Cancel a queued or running job that was started through MCP. Jobs started by the user cannot be cancelled here.",
            json!({"jobId": {"type": "string"}}),
            &["jobId"],
        ),
        tool(
            "android_get_logs",
            "Dump recent logcat lines without clearing the buffer.",
            json!({
                "deviceId": device,
                "buffer": {"type": "string", "enum": ["main", "system", "crash", "radio", "events", "all"]},
                "lines": {"type": "integer", "description": "Most recent N lines (default 200)"},
                "filter": {"type": "string", "description": "logcat filterspec, e.g. '*:E' or 'ActivityManager:I *:S'"},
            }),
            &["deviceId"],
        ),
        tool(
            "android_get_hierarchy",
            "Read the current UI as a compact list of interactive/text nodes (id, class, text, desc, resourceId, bounds, center, flags). Node ids are valid for this snapshot only. Requires a running automation helper session unless fallback=true.",
            json!({
                "deviceId": device,
                "raw": {"type": "boolean", "description": "Return the full accessibility XML instead"},
                "fallback": {"type": "boolean", "description": "Use a snapshot-only uiautomator dump when no helper session runs"},
            }),
            &["deviceId"],
        ),
        tool(
            "android_screenshot",
            "Capture the screen as PNG. With marks=true, interactive nodes are boxed and numbered with the ids from the compact hierarchy, and the node list is returned too. Uses the active automation helper session or falls back to ADB screencap.",
            json!({
                "deviceId": device,
                "marks": {"type": "boolean"},
                "fallback": {"type": "boolean", "description": "Force ADB screencap fallback (true) or require an active helper session (false)"},
            }),
            &["deviceId"],
        ),
        tool(
            "android_ui_action",
            "Perform a semantic UI action through the automation helper on a selector (resourceId, text, description, className, xpath, ...). swipe takes startX/startY/endX/endY or a selector; pressKey takes key or keyCode and no selector. wait and assert run without approval; the other actions require approval. Needs a helper session started from the UI.",
            json!({
                "deviceId": device,
                "action": {"type": "string", "enum": UI_ACTIONS},
                "selector": {"type": "object"},
                "text": {"type": "string"},
                "direction": {"type": "string", "enum": ["forward", "backward"]},
                "condition": {"type": "string", "enum": ["exists", "absent"]},
                "key": {"type": "string", "description": "Key name for pressKey, e.g. BACK, HOME, ENTER"},
                "keyCode": {"type": "integer", "description": "Android keycode for pressKey"},
                "startX": number,
                "startY": number,
                "endX": number,
                "endY": number,
                "durationMs": {"type": "integer", "description": "Swipe duration"},
                "timeoutMs": {"type": "integer"},
            }),
            &["deviceId", "action"],
        ),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn definitions_have_unique_names_and_schemas() {
        let defs = definitions();
        let mut names: Vec<&str> = defs.iter().map(|d| d["name"].as_str().unwrap()).collect();
        names.sort();
        names.dedup();
        assert_eq!(names.len(), defs.len());
        assert!(defs.iter().all(|d| d["inputSchema"]["type"] == "object"));
    }

    #[test]
    fn ui_action_covers_semantic_catalog() {
        let catalog: Vec<String> = crate::operations::semantic::catalog()
            .into_iter()
            .map(|op| op.id)
            .collect();
        let actions: Vec<String> = UI_ACTIONS
            .iter()
            .map(|a| format!("automation.{a}"))
            .collect();
        assert_eq!(catalog, actions);
    }
}
