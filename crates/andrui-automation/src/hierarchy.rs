use axum::{
    extract::{Query, State},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

use crate::adb::AdbExecutor;
use crate::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct HierarchyQuery {
    #[serde(rename = "deviceId")]
    pub device_id_camel: Option<String>,
    pub device_id: Option<String>,
    pub fallback: Option<bool>,
    /// `xml` (default) or `compact`.
    pub format: Option<String>,
}

impl HierarchyQuery {
    pub fn resolved_device_id(&self) -> Result<&str, ApiError> {
        self.device_id_camel
            .as_deref()
            .or(self.device_id.as_deref())
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                ApiError::bad_request("missing_device_id", "deviceId query parameter is required")
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HierarchyResponse {
    pub xml: String,
    pub captured_at: u64,
    pub snapshot_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

#[derive(Deserialize)]
struct HelperHierarchy {
    xml: String,
    #[serde(rename = "capturedAt")]
    captured_at: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactHierarchyResponse {
    pub nodes: Vec<crate::compact::CompactNode>,
    pub captured_at: u64,
    pub snapshot_only: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

pub fn compact_response(
    hierarchy: HierarchyResponse,
) -> Result<CompactHierarchyResponse, ApiError> {
    let nodes = crate::compact::compact_nodes(&hierarchy.xml).map_err(|e| {
        ApiError::internal(
            "hierarchy_parse_failed",
            format!("Hierarchy XML could not be parsed: {e}"),
        )
    })?;
    Ok(CompactHierarchyResponse {
        nodes,
        captured_at: hierarchy.captured_at,
        snapshot_only: hierarchy.snapshot_only,
        source: hierarchy.source,
        warning: hierarchy.warning,
    })
}

pub async fn get_hierarchy(
    State(state): State<AppState>,
    Query(query): Query<HierarchyQuery>,
) -> Result<Response, ApiError> {
    let compact = match query.format.as_deref() {
        None | Some("xml") => false,
        Some("compact") => true,
        Some(other) => {
            return Err(ApiError::bad_request(
                "invalid_format",
                format!("Unknown format '{other}'; use xml or compact"),
            ))
        }
    };
    let device_id = query.resolved_device_id()?;
    let hierarchy = fetch_hierarchy(&state, device_id, query.fallback.unwrap_or(false)).await?;
    Ok(if compact {
        Json(compact_response(hierarchy)?).into_response()
    } else {
        Json(hierarchy).into_response()
    })
}

/// Hierarchy XML from the helper session, or from `uiautomator dump` when `fallback`.
pub async fn fetch_hierarchy(
    state: &AppState,
    device_id: &str,
    fallback: bool,
) -> Result<HierarchyResponse, ApiError> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    // Fallback path via `adb uiautomator dump`
    if fallback {
        let xml = AdbExecutor::dump_hierarchy_fallback(&state.config.adb_path, device_id).await?;
        return Ok(HierarchyResponse {
            xml,
            captured_at: now,
            snapshot_only: true,
            source: Some("uiautomator_dump".to_string()),
            warning: Some(
                "Snapshot-only fallback does not support semantic actions or live events"
                    .to_string(),
            ),
        });
    }

    // Semantic live helper path
    let session = state.get_device_session(device_id).await.map_err(|_| {
        ApiError::not_found(
            "session_not_found",
            format!(
                "No active automation helper session for device '{}'. Start a session or pass fallback=true for snapshot-only hierarchy.",
                device_id
            ),
        )
    })?;

    let url = session.helper_url("/hierarchy");
    let resp = state
        .http_client
        .get(&url)
        .header("X-Andrui-Token", &session.token)
        .send()
        .await
        .map_err(|e| {
            ApiError::internal(
                "helper_request_failed",
                format!("Failed to query helper hierarchy: {}", e),
            )
        })?;

    if !resp.status().is_success() {
        let err_text = resp.text().await.unwrap_or_default();
        return Err(ApiError::bad_request(
            "helper_error",
            format!("Helper failed to return hierarchy: {}", err_text),
        ));
    }

    let helper_data = resp.json::<HelperHierarchy>().await.map_err(|e| {
        ApiError::internal(
            "helper_parse_failed",
            format!("Invalid JSON from helper hierarchy: {}", e),
        )
    })?;

    Ok(HierarchyResponse {
        xml: helper_data.xml,
        captured_at: helper_data.captured_at.unwrap_or(now),
        snapshot_only: false,
        source: Some("helper_accessibility".to_string()),
        warning: None,
    })
}
