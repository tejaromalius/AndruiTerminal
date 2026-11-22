use crate::mcp::client::ApiClient;
use serde_json::json;

pub async fn run(
    server: &str,
    id: &str,
    devices: Vec<String>,
    confirmed: bool,
    junit: bool,
) -> Result<bool, String> {
    let client = ApiClient::with_timeout(server, std::time::Duration::from_secs(3600))?;
    let id = crate::mcp::client::id_segment(id).map_err(|e| e.0)?;
    let response = client
        .post_json(
            &format!("/workflows/{id}/run"),
            &json!({"deviceIds":devices,"confirmed":confirmed}),
        )
        .await
        .map_err(|e| e.0)?;
    let run_id = response["runId"]
        .as_str()
        .ok_or("Server did not return a workflow run ID")?;
    let report = client
        .get_json(&format!("/workflow-runs/{run_id}"), &[])
        .await
        .map_err(|e| e.0)?;
    if junit {
        let bytes = client
            .get_bytes(&format!("/workflow-runs/{run_id}/junit"), &[])
            .await
            .map_err(|e| e.0)?;
        println!("{}", String::from_utf8(bytes).map_err(|e| e.to_string())?);
    } else {
        println!(
            "{}",
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())?
        );
    }
    Ok(report["status"] == "completed")
}
