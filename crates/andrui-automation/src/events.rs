use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query, State,
    },
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::state::AppState;

#[derive(Deserialize)]
pub struct EventsQuery {
    #[serde(rename = "deviceId")]
    pub device_id_camel: Option<String>,
    pub device_id: Option<String>,
}

#[derive(Deserialize)]
struct HelperEventsResponse {
    events: Vec<serde_json::Value>,
    sequence: u64,
    #[serde(default)]
    dropped: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SequenceGapMessage {
    r#type: &'static str,
    dropped: u64,
    last_sequence: u64,
    next_sequence: u64,
    message: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EventsBatchMessage<'a> {
    r#type: &'static str,
    sequence: u64,
    events: &'a [serde_json::Value],
}

pub async fn stream_events(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Query(query): Query<EventsQuery>,
) -> Response {
    let device_id = query
        .device_id_camel
        .or(query.device_id)
        .unwrap_or_default();

    ws.on_upgrade(move |socket| handle_events_socket(socket, state, device_id))
}

async fn handle_events_socket(mut socket: WebSocket, state: AppState, device_id: String) {
    if device_id.trim().is_empty() {
        let err = serde_json::json!({
            "error": { "code": "missing_device_id", "message": "deviceId is required" }
        });
        let _ = socket.send(Message::Text(err.to_string().into())).await;
        let _ = socket.close().await;
        return;
    }

    let mut last_seq = 0u64;

    loop {
        // Retrieve current active session for this device
        let session = match state.get_device_session(&device_id).await {
            Ok(s) => s,
            Err(_) => {
                let err = serde_json::json!({
                    "error": { "code": "session_not_found", "message": "No active session for device" }
                });
                let _ = socket.send(Message::Text(err.to_string().into())).await;
                tokio::time::sleep(Duration::from_millis(1000)).await;
                continue;
            }
        };

        let url = session.helper_url(&format!("/events?since={}", last_seq));
        let resp_result = state
            .http_client
            .get(&url)
            .header("X-Andrui-Token", &session.token)
            .timeout(Duration::from_millis(2500))
            .send()
            .await;

        match resp_result {
            Ok(resp) if resp.status().is_success() => {
                if let Ok(data) = resp.json::<HelperEventsResponse>().await {
                    if !data.events.is_empty() {
                        let first_seq = data.events[0]
                            .get("sequence")
                            .and_then(|v| v.as_u64())
                            .unwrap_or(last_seq + 1);

                        // Detect sequence gap from 512-ring buffer overflow
                        if last_seq > 0 && first_seq > last_seq + 1 {
                            let dropped_count = data.dropped.unwrap_or(first_seq - (last_seq + 1));
                            let gap = SequenceGapMessage {
                                r#type: "sequence_gap",
                                dropped: dropped_count,
                                last_sequence: last_seq,
                                next_sequence: first_seq,
                                message: "Event buffer overflow: accessibility events were dropped. Re-fetch hierarchy snapshot.",
                            };
                            let gap_json = serde_json::to_string(&gap).unwrap_or_default();
                            if socket.send(Message::Text(gap_json.into())).await.is_err() {
                                break;
                            }
                        }

                        let batch = EventsBatchMessage {
                            r#type: "events",
                            sequence: data.sequence,
                            events: &data.events,
                        };
                        let batch_json = serde_json::to_string(&batch).unwrap_or_default();
                        if socket.send(Message::Text(batch_json.into())).await.is_err() {
                            break;
                        }

                        last_seq = data.sequence;
                    }
                }
            }
            Ok(resp) if resp.status().as_u16() == 403 => {
                // Token mismatch or helper restarted
                let err = serde_json::json!({
                    "type": "reconnect_needed",
                    "message": "Helper session token changed; reconnecting"
                });
                let _ = socket.send(Message::Text(err.to_string().into())).await;
                tokio::time::sleep(Duration::from_millis(1000)).await;
            }
            _ => {
                // Network glitch or helper busy; short backoff
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
        }

        // Check if client has closed connection
        tokio::select! {
            msg = socket.next() => {
                match msg {
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    _ => {}
                }
            }
            _ = tokio::time::sleep(Duration::from_millis(100)) => {}
        }
    }
}
