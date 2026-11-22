use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, State,
    },
    response::Response,
    Json,
};
use futures_util::SinkExt;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{broadcast, watch};

use crate::error::ApiError;
use crate::recorder::get_recording;
use crate::state::AppState;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReplayRequest {
    pub recording_id: String,
    pub device_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartReplayResponse {
    pub id: String,
    pub recording_id: String,
    pub device_id: String,
    pub status: String,
    pub total_steps: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReplayResponse {
    pub id: String,
    pub cancelled: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ReplayEvent {
    pub replay_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub step_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_steps: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

pub async fn start_replay(
    State(state): State<AppState>,
    Json(payload): Json<StartReplayRequest>,
) -> Result<Json<StartReplayResponse>, ApiError> {
    if payload.recording_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_recording_id",
            "recordingId is required",
        ));
    }

    // Validate recording UUID to prevent path traversal
    uuid::Uuid::parse_str(&payload.recording_id)
        .map_err(|_| ApiError::bad_request("invalid_id", "recordingId must be a valid UUID"))?;

    if payload.device_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_device_id",
            "deviceId is required",
        ));
    }

    // 1. Validate recording exists
    let recording = get_recording(State(state.clone()), Path(payload.recording_id.clone()))
        .await?
        .0;

    // 2. Validate device session exists (preserving opaque device ID)
    let session = state.get_device_session(&payload.device_id).await?;

    let replay_id = uuid::Uuid::new_v4().to_string();
    let (cancel_tx, cancel_rx) = watch::channel(false);
    let (event_tx, _event_rx) = broadcast::channel(128);

    {
        let mut replays = state.active_replays.write().await;
        replays.insert(replay_id.clone(), Arc::new(cancel_tx));
        let mut channels = state.replay_channels.write().await;
        channels.insert(replay_id.clone(), event_tx.clone());
    }

    let state_clone = state.clone();
    let replay_id_clone = replay_id.clone();
    let steps = recording.steps.clone();
    let total_steps = steps.len();

    // Spawn async background replay worker
    tokio::spawn(async move {
        // Lock session action to serialize replay with live semantic mutations
        let _action_guard = session.action_lock.lock().await;

        let mut failed = false;
        let mut was_cancelled = false;

        for (i, step) in steps.iter().enumerate() {
            if *cancel_rx.borrow() {
                was_cancelled = true;
                break;
            }

            // Emit step started
            let start_evt = ReplayEvent {
                replay_id: replay_id_clone.clone(),
                step_index: Some(i),
                total_steps: Some(total_steps),
                action: Some(step.action.clone()),
                status: "started".to_string(),
                duration_ms: None,
                error: None,
            };
            let _ = event_tx.send(serde_json::to_string(&start_evt).unwrap_or_default());

            // Execute action via helper
            let helper_url = session.helper_url("/actions");
            let mut helper_body = serde_json::json!({
                "action": step.action,
                "selector": step.selector,
                "timeoutMs": 15000,
            });
            if let Some(t) = &step.text {
                helper_body["text"] = serde_json::Value::String(t.clone());
            }
            if let Some(d) = &step.direction {
                helper_body["direction"] = serde_json::Value::String(d.clone());
            }
            if let Some(c) = &step.condition {
                helper_body["condition"] = serde_json::Value::String(c.clone());
            }

            let start_inst = std::time::Instant::now();
            let action_res = state_clone
                .http_client
                .post(&helper_url)
                .header("X-Andrui-Token", &session.token)
                .json(&helper_body)
                .timeout(Duration::from_secs(20))
                .send()
                .await;

            let duration_ms = start_inst.elapsed().as_millis() as u64;

            match action_res {
                Ok(resp) if resp.status().is_success() => {
                    match resp.json::<crate::actions::ActionResult>().await {
                        Ok(action_out) if action_out.success => {
                            let step_pass = ReplayEvent {
                                replay_id: replay_id_clone.clone(),
                                step_index: Some(i),
                                total_steps: Some(total_steps),
                                action: Some(step.action.clone()),
                                status: "passed".to_string(),
                                duration_ms: Some(duration_ms),
                                error: None,
                            };
                            let _ = event_tx
                                .send(serde_json::to_string(&step_pass).unwrap_or_default());
                        }
                        Ok(_action_out) => {
                            let step_fail = ReplayEvent {
                                replay_id: replay_id_clone.clone(),
                                step_index: Some(i),
                                total_steps: Some(total_steps),
                                action: Some(step.action.clone()),
                                status: "failed".to_string(),
                                duration_ms: Some(duration_ms),
                                error: Some("Action execution reported success=false".to_string()),
                            };
                            let _ = event_tx
                                .send(serde_json::to_string(&step_fail).unwrap_or_default());
                            failed = true;
                            break;
                        }
                        Err(e) => {
                            let step_fail = ReplayEvent {
                                replay_id: replay_id_clone.clone(),
                                step_index: Some(i),
                                total_steps: Some(total_steps),
                                action: Some(step.action.clone()),
                                status: "failed".to_string(),
                                duration_ms: Some(duration_ms),
                                error: Some(format!("Invalid helper response JSON: {}", e)),
                            };
                            let _ = event_tx
                                .send(serde_json::to_string(&step_fail).unwrap_or_default());
                            failed = true;
                            break;
                        }
                    }
                }
                Ok(resp) => {
                    let err_body = resp.text().await.unwrap_or_default();
                    let step_fail = ReplayEvent {
                        replay_id: replay_id_clone.clone(),
                        step_index: Some(i),
                        total_steps: Some(total_steps),
                        action: Some(step.action.clone()),
                        status: "failed".to_string(),
                        duration_ms: Some(duration_ms),
                        error: Some(err_body.clone()),
                    };
                    let _ = event_tx.send(serde_json::to_string(&step_fail).unwrap_or_default());
                    failed = true;
                    break;
                }
                Err(err) => {
                    let step_fail = ReplayEvent {
                        replay_id: replay_id_clone.clone(),
                        step_index: Some(i),
                        total_steps: Some(total_steps),
                        action: Some(step.action.clone()),
                        status: "failed".to_string(),
                        duration_ms: Some(duration_ms),
                        error: Some(err.to_string()),
                    };
                    let _ = event_tx.send(serde_json::to_string(&step_fail).unwrap_or_default());
                    failed = true;
                    break;
                }
            }
        }

        // Final event
        let final_status = if was_cancelled {
            "cancelled"
        } else if failed {
            "failed"
        } else {
            "completed"
        };

        let final_evt = ReplayEvent {
            replay_id: replay_id_clone.clone(),
            step_index: None,
            total_steps: Some(total_steps),
            action: None,
            status: final_status.to_string(),
            duration_ms: None,
            error: None,
        };
        let _ = event_tx.send(serde_json::to_string(&final_evt).unwrap_or_default());

        // Cleanup
        {
            let mut replays = state_clone.active_replays.write().await;
            replays.remove(&replay_id_clone);
        }
    });

    Ok(Json(StartReplayResponse {
        id: replay_id,
        recording_id: payload.recording_id,
        device_id: payload.device_id,
        status: "running".to_string(),
        total_steps,
    }))
}

pub async fn cancel_replay(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CancelReplayResponse>, ApiError> {
    // Validate UUID to prevent invalid identifiers
    uuid::Uuid::parse_str(&id)
        .map_err(|_| ApiError::bad_request("invalid_id", "Replay ID must be a valid UUID"))?;

    let replays = state.active_replays.read().await;
    let sender = replays.get(&id).ok_or_else(|| {
        ApiError::not_found(
            "replay_not_found",
            format!("Active replay '{}' not found", id),
        )
    })?;

    let _ = sender.send(true);

    Ok(Json(CancelReplayResponse {
        id,
        cancelled: true,
    }))
}

pub async fn stream_replay_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Response, ApiError> {
    // Validate UUID to prevent invalid identifiers
    uuid::Uuid::parse_str(&id)
        .map_err(|_| ApiError::bad_request("invalid_id", "Replay ID must be a valid UUID"))?;

    let rx_opt = {
        let channels = state.replay_channels.read().await;
        channels.get(&id).map(|tx| tx.subscribe())
    };

    Ok(ws.on_upgrade(move |socket| handle_replay_socket(socket, rx_opt)))
}

async fn handle_replay_socket(mut socket: WebSocket, rx_opt: Option<broadcast::Receiver<String>>) {
    let mut rx = match rx_opt {
        Some(r) => r,
        None => {
            let err = serde_json::json!({
                "error": { "code": "replay_not_found", "message": "Replay channel not found" }
            });
            let _ = socket.send(Message::Text(err.to_string().into())).await;
            let _ = socket.close().await;
            return;
        }
    };

    while let Ok(msg) = rx.recv().await {
        if socket.send(Message::Text(msg.into())).await.is_err() {
            break;
        }
    }
}
