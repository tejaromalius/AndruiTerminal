//! MCP tools backed by the AndruiTerminal HTTP API.
//!
//! Operations are submitted through `POST /approvals`: the server runs read-only operations
//! immediately and holds other operations for the user's approval in the
//! browser. These tools never send `confirmed: true`.

use std::time::{Duration, Instant};

use andrui_core::ai::mcp_tools::STATS_SCOPES;
use base64::prelude::*;
use serde_json::{json, Map, Value};

use super::client::{id_segment, ApiClient, ToolError, ToolResult};

const REQUESTER: &str = "mcp";
const STDOUT_CAP: usize = 32 * 1024;
const STDERR_CAP: usize = 8 * 1024;
const DEFAULT_WAIT_MS: u64 = 15_000;
const MAX_WAIT_MS: u64 = 60_000;
const SECTION_CAP: usize = 16 * 1024;

pub fn definitions() -> Vec<Value> {
    andrui_core::ai::mcp_tools::definitions()
}

fn text(value: &Value) -> Value {
    json!({"type": "text", "text": serde_json::to_string_pretty(value).unwrap_or_default()})
}

fn str_arg<'a>(args: &'a Map<String, Value>, key: &str) -> ToolResult<&'a str> {
    args.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ToolError(format!("'{key}' is required")))
}

fn wait_arg(args: &Map<String, Value>) -> Duration {
    let ms = args
        .get("waitMs")
        .and_then(Value::as_u64)
        .unwrap_or(DEFAULT_WAIT_MS)
        .min(MAX_WAIT_MS);
    Duration::from_millis(ms)
}

/// Keeps the last `cap` bytes on a char boundary.
fn tail(text: &str, cap: usize) -> (&str, bool) {
    if text.len() <= cap {
        return (text, false);
    }
    let mut start = text.len() - cap;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    (&text[start..], true)
}

fn summarize_job(job: &Value) -> Value {
    let raw_stdout = job["stdout"].as_str().unwrap_or("");
    let op_id = job["operationId"].as_str().unwrap_or("");
    let (stdout, stdout_truncated) = tail(raw_stdout, STDOUT_CAP);
    let (stderr, stderr_truncated) = tail(job["stderr"].as_str().unwrap_or(""), STDERR_CAP);
    let mut summary = json!({
        "jobId": job["id"],
        "operationId": job["operationId"],
        "status": job["status"],
        "stdout": stdout,
        "stderr": stderr,
    });
    if let Some(parsed) = andrui_core::parsers::parse_command_output(op_id, raw_stdout) {
        summary["structured"] = parsed;
    }
    for key in [
        "deviceId",
        "exitCode",
        "error",
        "artifactIds",
        "source",
        "requester",
    ] {
        if !job[key].is_null() {
            summary[key] = job[key].clone();
        }
    }
    if stdout_truncated || stderr_truncated {
        summary["truncated"] = json!({"stdout": stdout_truncated, "stderr": stderr_truncated});
    }
    summary
}

async fn wait_job(client: &ApiClient, job_id: &str, wait: Duration) -> ToolResult<Value> {
    let path = format!("/jobs/{}", id_segment(job_id)?);
    let deadline = Instant::now() + wait;
    loop {
        let job = client.get_json(&path, &[]).await?;
        let active = matches!(job["status"].as_str(), Some("queued" | "running"));
        if !active || Instant::now() >= deadline {
            return Ok(summarize_job(&job));
        }
        tokio::time::sleep(Duration::from_millis(300)).await;
    }
}

async fn submit(
    client: &ApiClient,
    operation_id: &str,
    device_id: Option<&str>,
    parameters: Value,
    wait: Duration,
) -> ToolResult<Value> {
    let approval = client
        .post_json(
            "/approvals",
            &json!({
                "operationId": operation_id,
                "deviceId": device_id,
                "parameters": parameters,
                "requester": REQUESTER,
            }),
        )
        .await?;
    approval_result(client, &approval, wait).await
}

async fn approval_result(
    client: &ApiClient,
    approval: &Value,
    wait: Duration,
) -> ToolResult<Value> {
    if let Some(job_id) = approval["jobId"].as_str() {
        let mut result = wait_job(client, job_id, wait).await?;
        if approval["status"] != "not_required" {
            result["approvalId"] = approval["id"].clone();
            result["approvalStatus"] = approval["status"].clone();
        }
        return Ok(result);
    }
    let message = match approval["status"].as_str() {
        Some("pending") => "Waiting for the user to approve this in the AndruiTerminal UI. Poll with android_get_approval; do not retry the request.",
        Some("denied") => "The user denied this request.",
        Some("expired") => "The approval expired without a decision.",
        _ => "The approved job could not be started.",
    };
    let mut result = json!({
        "approvalId": approval["id"],
        "status": approval["status"],
        "operationId": approval["operationId"],
        "command": approval["preview"]["display"],
        "message": message,
    });
    if !approval["error"].is_null() {
        result["error"] = approval["error"].clone();
    }
    Ok(result)
}

fn compact_operation(op: &Value) -> Value {
    let mut out = json!({
        "id": op["id"],
        "label": op["label"],
        "category": op["category"],
        "destructive": op["destructive"],
        "available": op["available"],
    });
    if !op["unavailableReason"].is_null() {
        out["unavailableReason"] = op["unavailableReason"].clone();
    }
    out
}

fn device_query(args: &Map<String, Value>) -> ToolResult<Vec<(&'static str, String)>> {
    Ok(vec![("deviceId", str_arg(args, "deviceId")?.to_string())])
}

/// Runs a tool. Unknown names return `None` so the protocol layer can report -32602.
pub async fn call(
    client: &ApiClient,
    name: &str,
    args: &Map<String, Value>,
) -> Option<ToolResult<Vec<Value>>> {
    if let Some(device) = args.get("deviceId").and_then(Value::as_str) {
        if let Err(error) = client.ensure_device_allowed(device).await {
            return Some(Err(error));
        }
    }
    let result = match name {
        "android_list_devices" => client
            .get_json("/devices", &[])
            .await
            .map(|v| vec![text(&v)]),
        "android_device_info" => device_info(client, args).await,
        "android_list_operations" => list_operations(client, args).await,
        "android_preview_operation" => preview(client, args).await,
        "android_run_operation" => run_operation(client, args).await,
        "android_get_approval" => get_approval(client, args).await,
        "android_get_job" => get_job(client, args).await,
        "android_cancel_job" => cancel_job(client, args).await,
        "android_get_logs" => get_logs(client, args).await,
        "android_get_hierarchy" => get_hierarchy(client, args).await,
        "android_screenshot" => screenshot(client, args).await,
        "android_ui_action" => ui_action(client, args).await,
        _ => return None,
    };
    Some(result)
}

async fn list_operations(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let operations = client.get_json("/operations", &[]).await?;
    let operations = operations.as_array().cloned().unwrap_or_default();
    if let Some(id) = args.get("operationId").and_then(Value::as_str) {
        let op = operations
            .iter()
            .find(|op| op["id"] == id)
            .ok_or_else(|| ToolError(format!("Unknown operation '{id}'")))?;
        return Ok(vec![text(op)]);
    }
    let category = args.get("category").and_then(Value::as_str);
    let list: Vec<Value> = operations
        .iter()
        .filter(|op| category.is_none_or(|c| op["category"] == c))
        .map(compact_operation)
        .collect();
    Ok(vec![text(&Value::Array(list))])
}

async fn preview(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let body = json!({
        "operationId": str_arg(args, "operationId")?,
        "deviceId": args.get("deviceId"),
        "parameters": args.get("parameters").cloned().unwrap_or(json!({})),
    });
    let preview = client.post_json("/operations/preview", &body).await?;
    Ok(vec![text(&preview)])
}

async fn run_operation(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let result = submit(
        client,
        str_arg(args, "operationId")?,
        args.get("deviceId").and_then(Value::as_str),
        args.get("parameters").cloned().unwrap_or(json!({})),
        wait_arg(args),
    )
    .await?;
    Ok(vec![text(&result)])
}

async fn get_approval(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let id = id_segment(str_arg(args, "approvalId")?)?;
    let approval = client.get_json(&format!("/approvals/{id}"), &[]).await?;
    Ok(vec![text(
        &approval_result(client, &approval, wait_arg(args)).await?,
    )])
}

async fn get_job(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let job = wait_job(client, str_arg(args, "jobId")?, wait_arg(args)).await?;
    Ok(vec![text(&job)])
}

/// Cancels only jobs submitted through MCP, so an agent cannot stop the user's own jobs.
async fn cancel_job(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let id = id_segment(str_arg(args, "jobId")?)?;
    let job = client.get_json(&format!("/jobs/{id}"), &[]).await?;
    if job["source"] != "mcp" {
        return Err(ToolError(
            "Only jobs started through MCP can be cancelled with this tool".into(),
        ));
    }
    let job = client
        .post_json(&format!("/jobs/{id}/cancel"), &json!({}))
        .await?;
    Ok(vec![text(&summarize_job(&job))])
}

/// Keeps the first `cap` bytes on a char boundary.
fn head(text: &str, cap: usize) -> (&str, bool) {
    if text.len() <= cap {
        return (text, false);
    }
    let mut end = cap;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    (&text[..end], true)
}

fn filter_sections(stats: &Value, sections: Option<&[Value]>, grep: Option<&str>) -> Value {
    let grep = grep.map(str::to_lowercase);
    let mut out = Map::new();
    for (name, section) in stats["sections"].as_object().into_iter().flatten() {
        if sections.is_some_and(|wanted| !wanted.iter().any(|w| w == name)) {
            continue;
        }
        let output = section["output"].as_str().unwrap_or("");
        let filtered: String = match &grep {
            Some(needle) => output
                .lines()
                .filter(|line| line.to_lowercase().contains(needle))
                .collect::<Vec<_>>()
                .join("\n"),
            None => output.to_string(),
        };
        let (kept, truncated) = head(&filtered, SECTION_CAP);
        let mut entry = json!({"exitCode": section["exitCode"], "output": kept});
        if let Some(parsed) = andrui_core::parsers::parse_command_output(name, output) {
            entry["structured"] = parsed;
        }
        if truncated {
            entry["truncated"] = json!(true);
        }
        out.insert(name.clone(), entry);
    }
    json!({"deviceId": stats["deviceId"], "scope": stats["scope"], "sections": out})
}

async fn device_info(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let mut query = device_query(args)?;
    let scope = args
        .get("scope")
        .and_then(Value::as_str)
        .unwrap_or("device");
    if !STATS_SCOPES.contains(&scope) {
        return Err(ToolError(format!("Unknown scope '{scope}'")));
    }
    query.push(("scope", scope.to_string()));
    if scope == "package" {
        query.push(("package", str_arg(args, "package")?.to_string()));
    }
    let stats = client.get_json("/stats", &query).await?;
    let sections = args
        .get("sections")
        .and_then(Value::as_array)
        .map(Vec::as_slice);
    let grep = args
        .get("grep")
        .and_then(Value::as_str)
        .filter(|g| !g.is_empty());
    Ok(vec![text(&filter_sections(&stats, sections, grep))])
}

async fn get_logs(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let mut parameters = json!({
        "lines": args.get("lines").and_then(Value::as_u64).unwrap_or(200),
    });
    for key in ["buffer", "filter"] {
        if let Some(value) = args.get(key).and_then(Value::as_str) {
            parameters[key] = json!(value);
        }
    }
    let result = submit(
        client,
        "logcat.dump",
        Some(str_arg(args, "deviceId")?),
        parameters,
        Duration::from_millis(MAX_WAIT_MS),
    )
    .await?;
    Ok(vec![text(&result)])
}

async fn get_hierarchy(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let mut query = device_query(args)?;
    let raw = args.get("raw").and_then(Value::as_bool).unwrap_or(false);
    query.push(("format", if raw { "xml" } else { "compact" }.to_string()));
    if args
        .get("fallback")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        query.push(("fallback", "true".to_string()));
    }
    let hierarchy = client.get_json("/automation/hierarchy", &query).await?;
    Ok(vec![text(&hierarchy)])
}

async fn screenshot(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    let mut query = device_query(args)?;
    if args.get("marks").and_then(Value::as_bool).unwrap_or(false) {
        query.push(("marks", "true".to_string()));
        query.push(("format", "json".to_string()));
        let marked = client.get_json("/automation/screenshot", &query).await?;
        let png = marked["pngBase64"]
            .as_str()
            .ok_or("Marked screenshot response has no pngBase64")?;
        return Ok(vec![
            json!({"type": "image", "data": png, "mimeType": "image/png"}),
            text(&json!({"nodes": marked["nodes"]})),
        ]);
    }
    let png = client.get_bytes("/automation/screenshot", &query).await?;
    Ok(vec![json!({
        "type": "image",
        "data": BASE64_STANDARD.encode(png),
        "mimeType": "image/png",
    })])
}

async fn ui_action(client: &ApiClient, args: &Map<String, Value>) -> ToolResult<Vec<Value>> {
    str_arg(args, "deviceId")?;
    str_arg(args, "action")?;
    let mut body = Map::new();
    for key in [
        "deviceId",
        "action",
        "selector",
        "text",
        "direction",
        "condition",
        "key",
        "keyCode",
        "startX",
        "startY",
        "endX",
        "endY",
        "durationMs",
        "timeoutMs",
    ] {
        if let Some(value) = args.get(key) {
            body.insert(key.to_string(), value.clone());
        }
    }
    let action = str_arg(args, "action")?;
    body.remove("deviceId");
    body.remove("action");
    let result = submit(
        client,
        &format!("automation.{action}"),
        Some(str_arg(args, "deviceId")?),
        Value::Object(body),
        wait_arg(args),
    )
    .await?;
    Ok(vec![text(&result)])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tail_keeps_char_boundaries() {
        assert_eq!(tail("abc", 5), ("abc", false));
        assert_eq!(tail("abcdef", 3), ("def", true));
        let (kept, truncated) = tail("aé", 1);
        assert!(truncated);
        assert_eq!(kept, "");
    }

    #[test]
    fn summary_reports_truncation() {
        let job = json!({"id": "j", "operationId": "o", "status": "completed",
                         "stdout": "x".repeat(STDOUT_CAP + 10), "stderr": "", "exitCode": 0});
        let summary = summarize_job(&job);
        assert_eq!(summary["stdout"].as_str().unwrap().len(), STDOUT_CAP);
        assert_eq!(summary["truncated"]["stdout"], true);
        assert_eq!(summary["exitCode"], 0);
        assert!(summary.get("error").is_none());
    }

    #[test]
    fn device_info_filters_sections_and_lines() {
        let stats = json!({"deviceId": "d", "scope": "device", "sections": {
            "props": {"exitCode": 0, "output": "[ro.product.model]: [Pixel]\n[ro.build.version.sdk]: [36]\n[persist.x]: [1]"},
            "uptime": {"exitCode": 0, "output": "up 3 days"},
        }});
        let only_props = [json!("props")];
        let out = filter_sections(&stats, Some(&only_props), Some("RO."));
        assert_eq!(
            out["sections"]["props"]["output"],
            "[ro.product.model]: [Pixel]\n[ro.build.version.sdk]: [36]"
        );
        assert!(out["sections"].get("uptime").is_none());
        let all = filter_sections(&stats, None, None);
        assert_eq!(all["sections"]["uptime"]["output"], "up 3 days");
        assert_eq!(head("aé", 2), ("a", true));
    }

    #[test]
    fn summary_attaches_structured_output_when_available() {
        let battery_stdout = "Current Battery Service state:\n  AC powered: false\n  USB powered: true\n  level: 80\n  scale: 100\n  voltage: 4100\n";
        let job = json!({
            "id": "job-bat",
            "operationId": "diagnostics.batterystats",
            "status": "completed",
            "stdout": battery_stdout,
            "stderr": "",
            "exitCode": 0,
            "source": "mcp",
            "requester": "claude"
        });
        let summary = summarize_job(&job);
        assert_eq!(summary["source"], "mcp");
        assert_eq!(summary["requester"], "claude");
        assert_eq!(summary["structured"]["level"], 80);
        assert_eq!(summary["structured"]["usbPowered"], true);
    }
}
