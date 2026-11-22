//! MCP resources: exposes read-only data streams (device list, audit log, logcat, hierarchy, screenshot)
//! as native MCP resources under the `android://` URI scheme.

use base64::prelude::*;
use serde_json::{json, Value};

use super::client::{ApiClient, ToolError, ToolResult};
use std::time::{Duration, Instant};

pub fn definitions() -> Vec<Value> {
    vec![
        json!({
            "uri": "android://devices",
            "name": "Connected Android Devices",
            "description": "Roster of currently connected Android devices, transports, and states",
            "mimeType": "application/json"
        }),
        json!({
            "uri": "android://audit",
            "name": "Command Audit Log",
            "description": "Historical audit log of commands executed across GUI, MCP agents, and workflows",
            "mimeType": "application/json"
        }),
        json!({
            "uri": "android://logcat",
            "name": "Recent Device Logcat Buffer",
            "description": "Recent logcat messages; specify android://<deviceId>/logcat when multiple devices are connected",
            "mimeType": "text/plain"
        }),
        json!({
            "uri": "android://hierarchy",
            "name": "Current Window UI Hierarchy",
            "description": "Compact interactive accessibility node hierarchy of the active screen",
            "mimeType": "application/json"
        }),
        json!({
            "uri": "android://screenshot",
            "name": "Screen Capture PNG",
            "description": "Current screen capture image from the active Android device",
            "mimeType": "image/png"
        }),
    ]
}

/// Resolves a target device ID from a URI path or queries the first connected device.
async fn resolve_device_id(client: &ApiClient, uri: &str) -> ToolResult<String> {
    let path = uri.strip_prefix("android://").unwrap_or(uri);
    let parts: Vec<&str> = path.split('/').collect();

    // If URI is like android://dev123/screenshot, parts[0] is dev123
    if parts.len() >= 2 && !parts[0].is_empty() {
        client.ensure_device_allowed(parts[0]).await?;
        return Ok(parts[0].to_string());
    }

    let devices = client.get_json("/devices", &[]).await?;
    let id = select_single_device(&devices)?;
    client.ensure_device_allowed(&id).await?;
    Ok(id)
}

fn select_single_device(devices: &Value) -> ToolResult<String> {
    let list = devices.as_array().ok_or("Invalid device list")?;
    if list.len() != 1 {
        return Err(ToolError("Use android://<deviceId>/<resource> with an explicit device ID; the device list is empty or ambiguous".into()));
    }
    if list[0]["state"] != "device" {
        return Err(ToolError("The target device is not ready".into()));
    }
    list[0]["id"]
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| ToolError("Device ID missing".into()))
}

pub async fn read(client: &ApiClient, uri: &str) -> ToolResult<Vec<Value>> {
    let path = uri.strip_prefix("android://").unwrap_or(uri);

    if path == "devices" {
        let devices = client.get_json("/devices", &[]).await?;
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string_pretty(&devices).unwrap_or_default()
        })]);
    }

    if path == "audit" {
        let audit = client.get_json("/audit", &[]).await?;
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string_pretty(&audit).unwrap_or_default()
        })]);
    }

    if path == "logcat" || path.ends_with("/logcat") {
        let device_id = resolve_device_id(client, uri).await?;
        let res = client
            .post_json(
                "/approvals",
                &json!({
                    "operationId": "logcat.dump",
                    "deviceId": device_id,
                    "parameters": {"lines": 200, "dumpOnly": true},
                    "requester": "mcp-resource",
                }),
            )
            .await?;
        let job_id = res["jobId"]
            .as_str()
            .ok_or_else(|| ToolError("Failed to trigger logcat dump".to_string()))?;

        let deadline = Instant::now() + Duration::from_secs(30);
        let job = loop {
            let job = client.get_json(&format!("/jobs/{job_id}"), &[]).await?;
            match job["status"].as_str() {
                Some("completed") => break job,
                Some("failed" | "cancelled") => {
                    return Err(ToolError(format!("Log capture failed: {}", job["error"])))
                }
                _ if Instant::now() >= deadline => return Err(ToolError(
                    "Log capture is still running; use android_get_job with the returned job ID"
                        .into(),
                )),
                _ => tokio::time::sleep(Duration::from_millis(100)).await,
            }
        };
        let stdout = job["stdout"].as_str().unwrap_or("");
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "text/plain",
            "text": format!("Device: {device_id}\n{stdout}")
        })]);
    }

    if path == "hierarchy" || path.ends_with("/hierarchy") {
        let device_id = resolve_device_id(client, uri).await?;
        let hierarchy = client
            .get_json(
                "/automation/hierarchy",
                &[
                    ("deviceId", device_id.clone()),
                    ("format", "compact".to_string()),
                    ("fallback", "true".to_string()),
                ],
            )
            .await?;
        return Ok(vec![json!({
            "uri": uri,
            "mimeType": "application/json",
            "text": serde_json::to_string_pretty(&json!({"deviceId": device_id, "hierarchy": hierarchy})).unwrap_or_default()
        })]);
    }

    if path == "screenshot" || path.ends_with("/screenshot") {
        let device_id = resolve_device_id(client, uri).await?;
        let png = client
            .get_bytes("/automation/screenshot", &[("deviceId", device_id.clone())])
            .await?;
        return Ok(vec![json!({
            "uri": format!("android://{device_id}/screenshot"),
            "mimeType": "image/png",
            "blob": BASE64_STANDARD.encode(png)
        })]);
    }

    Err(ToolError(format!("Unsupported resource URI: {uri}")))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn implicit_target_requires_exactly_one_ready_device() {
        assert!(select_single_device(&json!([])).is_err());
        assert!(select_single_device(
            &json!([{"id":"a","state":"device"},{"id":"b","state":"device"}])
        )
        .is_err());
        assert!(select_single_device(&json!([{"id":"a","state":"offline"}])).is_err());
        assert_eq!(
            select_single_device(&json!([{"id":"a","state":"device"}])).unwrap(),
            "a"
        );
    }
}
