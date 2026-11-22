use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{
    extract::{Path, State},
    Json,
};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tokio::time::sleep;

use crate::adb::AdbExecutor;
use crate::error::ApiError;
use crate::state::{AppState, AutomationSession};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub device_id: String,
    pub confirmed: Option<bool>,
    pub helper_apk: Option<PathBuf>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub id: String,
    pub device_id: String,
    pub helper_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub device_id: String,
    pub helper_version: String,
    pub host_port: u16,
    pub created_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StopSessionResponse {
    pub id: String,
    pub stopped: bool,
}

#[derive(Deserialize)]
struct HealthResponse {
    version: Option<String>,
    #[serde(rename = "protocolVersion")]
    protocol_version: Option<u32>,
}

pub async fn create_session(
    State(state): State<AppState>,
    Json(payload): Json<CreateSessionRequest>,
) -> Result<Json<CreateSessionResponse>, ApiError> {
    if payload.device_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "invalid_device_id",
            "deviceId must not be empty",
        ));
    }

    if !payload.confirmed.unwrap_or(false) {
        return Err(ApiError::bad_request(
            "confirmation_required",
            "Starting an automation session installs and starts instrumentation on the device and requires confirmed=true",
        ));
    }

    // Determine helper APK path
    let apk_path = payload
        .helper_apk
        .as_ref()
        .or(state.config.helper_apk.as_ref())
        .ok_or_else(|| {
            ApiError::service_unavailable(
                "helper_apk_unavailable",
                "Automation helper APK is not configured in ExtensionsConfig or request",
            )
        })?;

    if !apk_path.exists() {
        return Err(ApiError::service_unavailable(
            "helper_apk_unavailable",
            format!("Automation helper APK not found at {:?}", apk_path),
        ));
    }

    let device_id = payload.device_id.as_str();

    // Serialize session startup per device to avoid concurrent startup races
    let device_startup_lock = state.get_device_startup_lock(device_id).await;
    let _startup_guard = device_startup_lock.lock().await;

    // If an existing session exists for this device, clean it up first
    if let Ok(existing) = state.get_device_session(device_id).await {
        let _ = stop_session_internal(&state, &existing.id).await;
    }

    // 1. Install helper APK via ADB
    AdbExecutor::install_helper_apk(&state.config.adb_path, device_id, apk_path).await?;

    // 2. Forward tcp:0 -> device tcp:9008
    let host_port = AdbExecutor::forward_port(&state.config.adb_path, device_id, 9008).await?;

    // 3. Generate random token (>= 24 characters)
    let token = format!("andrui_{}", uuid::Uuid::new_v4().simple());

    // 4. Spawn instrumentation
    let mut child =
        match AdbExecutor::spawn_instrumentation(&state.config.adb_path, device_id, 9008, &token) {
            Ok(c) => c,
            Err(err) => {
                let _ =
                    AdbExecutor::remove_forward(&state.config.adb_path, device_id, host_port).await;
                return Err(err);
            }
        };

    // 5. Poll /health endpoint with bounded timeout (up to 15 seconds)
    let health_url = format!("http://127.0.0.1:{}/health", host_port);
    let mut helper_version = String::from("0.1.0");
    let mut health_ok = false;

    for _ in 0..60 {
        // Check if child exited prematurely
        if let Ok(Some(status)) = child.try_wait() {
            let _ = AdbExecutor::remove_forward(&state.config.adb_path, device_id, host_port).await;
            return Err(ApiError::bad_request(
                "instrumentation_exited",
                format!(
                    "Helper instrumentation exited prematurely with status {}",
                    status
                ),
            ));
        }

        match state
            .http_client
            .get(&health_url)
            .header("X-Andrui-Token", &token)
            .timeout(Duration::from_millis(500))
            .send()
            .await
        {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(health) = resp.json::<HealthResponse>().await {
                    if health.protocol_version == Some(1) {
                        if let Some(v) = health.version {
                            helper_version = v;
                        }
                        health_ok = true;
                        break;
                    }
                }
            }
            _ => {
                sleep(Duration::from_millis(250)).await;
            }
        }
    }

    if !health_ok {
        let _ = child.kill().await;
        let _ = AdbExecutor::remove_forward(&state.config.adb_path, device_id, host_port).await;
        return Err(ApiError::timeout(
            "helper_health_timeout",
            format!(
                "Timed out waiting for automation helper on device '{}' at port {}",
                device_id, host_port
            ),
        ));
    }

    let session_id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);

    let session = Arc::new(AutomationSession {
        id: session_id.clone(),
        device_id: device_id.to_string(),
        token,
        host_port,
        helper_version: helper_version.clone(),
        created_at: now,
        child: Mutex::new(Some(child)),
        action_lock: device_startup_lock.clone(),
    });

    {
        let mut dev_map = state.device_sessions.write().await;
        let mut sessions = state.sessions.write().await;
        dev_map.insert(device_id.to_string(), session_id.clone());
        sessions.insert(session_id.clone(), session);
    }

    Ok(Json(CreateSessionResponse {
        id: session_id,
        device_id: device_id.to_string(),
        helper_version,
    }))
}

pub async fn list_sessions(State(state): State<AppState>) -> Json<Vec<SessionSummary>> {
    let sessions = state.sessions.read().await;
    let list = sessions
        .values()
        .map(|s| SessionSummary {
            id: s.id.clone(),
            device_id: s.device_id.clone(),
            helper_version: s.helper_version.clone(),
            host_port: s.host_port,
            created_at: s.created_at,
        })
        .collect();
    Json(list)
}

pub async fn get_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<SessionSummary>, ApiError> {
    let sessions = state.sessions.read().await;
    let s = sessions.get(&id).ok_or_else(|| {
        ApiError::not_found("session_not_found", format!("Session '{}' not found", id))
    })?;

    Ok(Json(SessionSummary {
        id: s.id.clone(),
        device_id: s.device_id.clone(),
        helper_version: s.helper_version.clone(),
        host_port: s.host_port,
        created_at: s.created_at,
    }))
}

pub async fn delete_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<StopSessionResponse>, ApiError> {
    stop_session_internal(&state, &id).await?;
    Ok(Json(StopSessionResponse { id, stopped: true }))
}

pub async fn stop_session_internal(state: &AppState, id: &str) -> Result<(), ApiError> {
    let session = {
        let mut dev_map = state.device_sessions.write().await;
        let mut sessions = state.sessions.write().await;
        let s = sessions.remove(id).ok_or_else(|| {
            ApiError::not_found("session_not_found", format!("Session '{}' not found", id))
        })?;
        if dev_map.get(&s.device_id) == Some(&s.id) {
            dev_map.remove(&s.device_id);
        }
        s
    };

    // 1. Post stop to helper endpoint (short timeout, ignore failure)
    let stop_url = session.helper_url("/stop");
    let _ = state
        .http_client
        .post(&stop_url)
        .header("X-Andrui-Token", &session.token)
        .timeout(Duration::from_secs(1))
        .send()
        .await;

    // 2. Kill spawned instrumentation process
    let mut child_guard = session.child.lock().await;
    if let Some(child) = child_guard.as_mut() {
        let _ = child.kill().await;
    }

    // 3. Remove ADB forward
    let _ = AdbExecutor::remove_forward(
        &state.config.adb_path,
        &session.device_id,
        session.host_port,
    )
    .await;

    Ok(())
}
