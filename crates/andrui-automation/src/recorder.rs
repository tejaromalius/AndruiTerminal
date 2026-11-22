use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::error::ApiError;
use crate::state::{AppState, RecordedStep, RecordingSession};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingRequest {
    pub device_id: String,
    pub name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartRecordingResponse {
    pub id: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub started_at: u64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingDetail {
    pub id: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub started_at: u64,
    pub steps: Vec<RecordedStep>,
}

pub fn get_automation_dir(state: &AppState) -> PathBuf {
    state.config.data_dir.join("automation")
}

pub async fn start_recording(
    State(state): State<AppState>,
    Json(payload): Json<StartRecordingRequest>,
) -> Result<Json<StartRecordingResponse>, ApiError> {
    if payload.device_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_device_id",
            "deviceId is required",
        ));
    }

    let id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let session = RecordingSession {
        id: id.clone(),
        device_id: payload.device_id.clone(),
        name: payload.name.clone(),
        started_at: now,
        steps: Vec::new(),
    };

    {
        let mut recs = state.recordings.write().await;
        recs.insert(id.clone(), session);
    }

    Ok(Json(StartRecordingResponse {
        id,
        device_id: payload.device_id,
        name: payload.name,
        started_at: now,
    }))
}

pub async fn stop_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RecordingDetail>, ApiError> {
    // Validate UUID to prevent path traversal
    uuid::Uuid::parse_str(&id)
        .map_err(|_| ApiError::bad_request("invalid_id", "Recording ID must be a valid UUID"))?;

    let rec = {
        let mut recs = state.recordings.write().await;
        recs.remove(&id).ok_or_else(|| {
            ApiError::not_found(
                "recording_not_found",
                format!("Active recording '{}' not found", id),
            )
        })?
    };

    let dir = get_automation_dir(&state);
    tokio::fs::create_dir_all(&dir).await.map_err(|e| {
        ApiError::internal(
            "storage_error",
            format!("Failed to create automation dir: {}", e),
        )
    })?;

    let file_path = dir.join(format!("{}.json", rec.id));
    let content = serde_json::to_string_pretty(&rec).map_err(|e| {
        ApiError::internal(
            "serialization_error",
            format!("Failed to serialize recording: {}", e),
        )
    })?;

    tokio::fs::write(&file_path, content).await.map_err(|e| {
        ApiError::internal("storage_error", format!("Failed to save recording: {}", e))
    })?;

    Ok(Json(RecordingDetail {
        id: rec.id,
        device_id: rec.device_id,
        name: rec.name,
        started_at: rec.started_at,
        steps: rec.steps,
    }))
}

pub async fn list_recordings(
    State(state): State<AppState>,
) -> Result<Json<Vec<RecordingDetail>>, ApiError> {
    let dir = get_automation_dir(&state);
    let mut results = Vec::new();

    if let Ok(mut entries) = tokio::fs::read_dir(&dir).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) == Some("json") {
                if let Ok(content) = tokio::fs::read_to_string(&path).await {
                    if let Ok(detail) = serde_json::from_str::<RecordingDetail>(&content) {
                        results.push(detail);
                    }
                }
            }
        }
    }

    // Sort by started_at descending
    results.sort_by_key(|a| std::cmp::Reverse(a.started_at));

    Ok(Json(results))
}

pub async fn get_recording(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<RecordingDetail>, ApiError> {
    // Validate UUID to prevent path traversal
    uuid::Uuid::parse_str(&id)
        .map_err(|_| ApiError::bad_request("invalid_id", "Recording ID must be a valid UUID"))?;

    // Check active recordings first
    {
        let recs = state.recordings.read().await;
        if let Some(r) = recs.get(&id) {
            return Ok(Json(RecordingDetail {
                id: r.id.clone(),
                device_id: r.device_id.clone(),
                name: r.name.clone(),
                started_at: r.started_at,
                steps: r.steps.clone(),
            }));
        }
    }

    // Check persisted recordings
    let dir = get_automation_dir(&state);
    let file_path = dir.join(format!("{}.json", id));
    if !file_path.exists() {
        return Err(ApiError::not_found(
            "recording_not_found",
            format!("Recording '{}' not found", id),
        ));
    }

    let content = tokio::fs::read_to_string(&file_path).await.map_err(|e| {
        ApiError::internal(
            "read_error",
            format!("Failed to read recording file: {}", e),
        )
    })?;

    let detail = serde_json::from_str::<RecordingDetail>(&content)
        .map_err(|e| ApiError::internal("parse_error", format!("Invalid recording JSON: {}", e)))?;

    Ok(Json(detail))
}
