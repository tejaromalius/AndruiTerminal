use crate::{
    adb::{adb_version, capture_screencap_png},
    config::MediaConfig,
    error::MediaError,
    protocol::SCRCPY_VERSION,
    session::{create_session_store, start_session, CreateSessionRequest, SessionStore},
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Path, Query, State,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};

#[derive(Clone)]
pub struct AppState {
    pub config: MediaConfig,
    pub sessions: SessionStore,
}

impl AppState {
    pub async fn cleanup_all_sessions(&self) {
        cleanup_all_sessions(&self.sessions).await;
    }
}

pub async fn cleanup_all_sessions(sessions: &SessionStore) {
    let mut map = sessions.write().await;
    for (_, session) in map.drain() {
        session.stop().await;
    }
}

#[derive(Debug, Deserialize)]
pub struct DeviceQuery {
    #[serde(rename = "deviceId")]
    pub device_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResponse {
    pub data_url: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScrcpyServerStatus {
    pub available: bool,
    pub version: String,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaCapabilitiesResponse {
    pub adb_available: bool,
    pub adb_version: Option<String>,
    pub scrcpy_server: ScrcpyServerStatus,
    pub supported_video_codecs: Vec<&'static str>,
    pub supported_audio_codecs: Vec<&'static str>,
    pub max_fps_default: u32,
    pub default_video_bitrate: u32,
}

#[derive(Debug, Serialize)]
pub struct DeleteSessionResponse {
    pub deleted: bool,
    pub id: String,
}

#[derive(Debug, Deserialize)]
pub struct RecordingOptions {
    pub name: Option<String>,
}

/// Public integration router mounting full `/api/v1/screen/...` with existing AppState
pub fn router_with_state(state: AppState) -> Router {
    Router::new().nest("/api/v1/screen", build_screen_router_with_state(state))
}

/// Un-nested router providing `/capture`, `/screenshot`, etc. with existing AppState
pub fn screen_router_with_state(state: AppState) -> Router {
    build_screen_router_with_state(state)
}

/// Router builder containing all screen endpoints using the provided AppState
pub fn build_screen_router_with_state(state: AppState) -> Router {
    Router::new()
        .route("/capture", get(handle_capture))
        .route("/screenshot", get(handle_screenshot))
        .route("/capabilities", get(handle_capabilities))
        .route("/sessions", post(handle_create_session))
        .route("/sessions/{id}", delete(handle_delete_session))
        .route("/sessions/{id}/video", get(handle_ws_video))
        .route("/sessions/{id}/audio", get(handle_ws_audio))
        .route("/sessions/{id}/control", get(handle_ws_control))
        .route("/sessions/{id}/recordings", post(handle_create_recording))
        .route(
            "/sessions/{id}/recordings/current",
            delete(handle_stop_recording),
        )
        .route("/sessions/{id}/screenshot", post(handle_session_screenshot))
        .with_state(state)
}

/// Router builder containing all /api/v1/screen/... endpoints from MediaConfig
pub fn build_screen_router(config: MediaConfig) -> Router {
    let state = AppState {
        config,
        sessions: create_session_store(),
    };
    build_screen_router_with_state(state)
}

/// GET /api/v1/screen/capture?deviceId= -> { dataUrl: "data:image/png;base64,..." }
async fn handle_capture(
    State(state): State<AppState>,
    Query(query): Query<DeviceQuery>,
) -> Result<Json<CaptureResponse>, MediaError> {
    let png_bytes = capture_screencap_png(&state.config.adb_path, &query.device_id).await?;
    let b64 = BASE64.encode(&png_bytes);
    let data_url = format!("data:image/png;base64,{}", b64);
    Ok(Json(CaptureResponse { data_url }))
}

/// GET /api/v1/screen/screenshot?deviceId= -> raw binary PNG
/// Uses static Content-Disposition header to avoid panics on newlines or invalid characters in device IDs.
async fn handle_screenshot(
    State(state): State<AppState>,
    Query(query): Query<DeviceQuery>,
) -> Result<Response, MediaError> {
    let png_bytes = capture_screencap_png(&state.config.adb_path, &query.device_id).await?;
    let mut headers = HeaderMap::new();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("image/png"));
    headers.insert(
        header::CONTENT_DISPOSITION,
        HeaderValue::from_static("inline; filename=\"device-screenshot.png\""),
    );
    if let Ok(val) = HeaderValue::from_str(&png_bytes.len().to_string()) {
        headers.insert(header::CONTENT_LENGTH, val);
    }
    Ok((headers, png_bytes).into_response())
}

/// GET /api/v1/screen/capabilities -> dependency/runtime capabilities
async fn handle_capabilities(
    State(state): State<AppState>,
) -> Result<Json<MediaCapabilitiesResponse>, MediaError> {
    let adb_ver = adb_version(&state.config.adb_path).await.ok();
    let adb_available = adb_ver.is_some();

    let server_path = state.config.find_scrcpy_server();
    let scrcpy_server = ScrcpyServerStatus {
        available: server_path.is_some(),
        version: SCRCPY_VERSION.to_string(),
        path: server_path.map(|p| p.to_string_lossy().to_string()),
    };

    Ok(Json(MediaCapabilitiesResponse {
        adb_available,
        adb_version: adb_ver,
        scrcpy_server,
        supported_video_codecs: vec!["h264", "h265", "av1"],
        supported_audio_codecs: vec!["opus", "aac", "raw"],
        max_fps_default: 60,
        default_video_bitrate: 8_000_000,
    }))
}

/// POST /api/v1/screen/sessions -> { id, videoUrl, audioUrl?, controlUrl, capabilities }
async fn handle_create_session(
    State(state): State<AppState>,
    Json(req): Json<CreateSessionRequest>,
) -> Result<(StatusCode, Json<serde_json::Value>), MediaError> {
    let resp = start_session(&state.config, &state.sessions, req).await?;
    Ok((
        StatusCode::CREATED,
        Json(serde_json::to_value(resp).unwrap()),
    ))
}

/// DELETE /api/v1/screen/sessions/:id -> closes only that session and its owned forwards/processes
async fn handle_delete_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<DeleteSessionResponse>, MediaError> {
    let session = {
        let mut map = state.sessions.write().await;
        map.remove(&id)
    };

    if let Some(session) = session {
        session.stop().await;
        Ok(Json(DeleteSessionResponse { deleted: true, id }))
    } else {
        Err(MediaError::NotFound(format!("Session '{}' not found", id)))
    }
}

/// WS /api/v1/screen/sessions/:id/video
/// Single-consumer attach: returns 409 Conflict if another consumer is already attached.
async fn handle_ws_video(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, MediaError> {
    let session = {
        let map = state.sessions.read().await;
        map.get(&id).cloned()
    };
    let session =
        session.ok_or_else(|| MediaError::NotFound(format!("Session '{}' not found", id)))?;

    // Attempt single consumer attach
    let mut rx_guard = session.video_rx.lock().await;
    let mut rx = rx_guard.take().ok_or_else(|| {
        MediaError::Conflict("Video stream already has an active subscriber".to_string())
    })?;
    drop(rx_guard);

    let sessions_cleanup = state.sessions.clone();
    let id_cleanup = id.clone();

    Ok(ws.on_upgrade(move |socket: WebSocket| async move {
        let (mut sender, mut receiver) = socket.split();
        loop {
            tokio::select! {
                chunk = rx.recv() => match chunk {
                    Some(chunk) => { if sender.send(Message::Binary(chunk)).await.is_err() { break; } }
                    None => break,
                },
                message = receiver.next() => match message {
                    Some(Ok(Message::Ping(bytes))) => { if sender.send(Message::Pong(bytes)).await.is_err() { break; } }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {},
                }
            }
        }
        // Cleanup session when video WebSocket disconnects
        let s = {
            let mut map = sessions_cleanup.write().await;
            map.remove(&id_cleanup)
        };
        if let Some(s) = s {
            s.stop().await;
        }
    }))
}

/// WS /api/v1/screen/sessions/:id/audio
/// Single-consumer attach: returns 409 Conflict if another consumer is already attached.
async fn handle_ws_audio(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, MediaError> {
    let session = {
        let map = state.sessions.read().await;
        map.get(&id).cloned()
    };
    let session =
        session.ok_or_else(|| MediaError::NotFound(format!("Session '{}' not found", id)))?;

    let audio_rx_mutex = session.audio_rx.as_ref().ok_or_else(|| {
        MediaError::BadRequest("Audio is not enabled for this session".to_string())
    })?;

    let mut rx_guard = audio_rx_mutex.lock().await;
    let mut rx = rx_guard.take().ok_or_else(|| {
        MediaError::Conflict("Audio stream already has an active subscriber".to_string())
    })?;
    drop(rx_guard);

    Ok(ws.on_upgrade(move |mut socket: WebSocket| async move {
        while let Some(chunk) = rx.recv().await {
            if socket.send(Message::Binary(chunk)).await.is_err() {
                break;
            }
        }
    }))
}

/// WS /api/v1/screen/sessions/:id/control
/// Single-consumer attach: returns 409 Conflict if another consumer is already attached.
async fn handle_ws_control(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ws: WebSocketUpgrade,
) -> Result<Response, MediaError> {
    let session = {
        let map = state.sessions.read().await;
        map.get(&id).cloned()
    };
    let session =
        session.ok_or_else(|| MediaError::NotFound(format!("Session '{}' not found", id)))?;

    let mut rx_guard = session.control_rx.lock().await;
    let mut control_rx = rx_guard.take().ok_or_else(|| {
        MediaError::Conflict("Control stream already has an active subscriber".to_string())
    })?;
    drop(rx_guard);

    let control_tx = session.control_tx.clone();

    Ok(ws.on_upgrade(move |socket: WebSocket| async move {
        let (mut ws_sender, mut ws_receiver) = socket.split();

        // Device -> Browser WebSocket
        let mut send_task = tokio::spawn(async move {
            while let Some(chunk) = control_rx.recv().await {
                if ws_sender.send(Message::Binary(chunk)).await.is_err() {
                    break;
                }
            }
        });

        // Browser WebSocket -> Device
        let mut recv_task = tokio::spawn(async move {
            while let Some(Ok(msg)) = ws_receiver.next().await {
                match msg {
                    Message::Binary(bytes) => {
                        if control_tx.send(bytes).await.is_err() {
                            break;
                        }
                    }
                    Message::Close(_) => break,
                    _ => {}
                }
            }
        });

        tokio::select! {
            _ = (&mut send_task) => recv_task.abort(),
            _ = (&mut recv_task) => send_task.abort(),
        }
    }))
}

/// POST /api/v1/screen/sessions/:id/recordings -> 501 Not Implemented
/// Server-side mock success is removed; canvas recording runs strictly in-browser.
async fn handle_create_recording(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
    _json: Option<Json<RecordingOptions>>,
) -> Result<Json<serde_json::Value>, MediaError> {
    Err(MediaError::NotImplemented(
        "Server-side session recording is unsupported; use in-browser canvas recording instead"
            .to_string(),
    ))
}

/// DELETE /api/v1/screen/sessions/:id/recordings/current -> 501 Not Implemented
async fn handle_stop_recording(
    State(_state): State<AppState>,
    Path(_id): Path<String>,
) -> Result<Json<serde_json::Value>, MediaError> {
    Err(MediaError::NotImplemented(
        "Server-side session recording is unsupported; use in-browser canvas recording instead"
            .to_string(),
    ))
}

/// POST /api/v1/screen/sessions/:id/screenshot
async fn handle_session_screenshot(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<CaptureResponse>, MediaError> {
    let session = {
        let map = state.sessions.read().await;
        map.get(&id).cloned()
    };
    let session =
        session.ok_or_else(|| MediaError::NotFound(format!("Session '{}' not found", id)))?;
    let png_bytes = capture_screencap_png(&state.config.adb_path, &session.device_id).await?;
    let b64 = BASE64.encode(&png_bytes);
    Ok(Json(CaptureResponse {
        data_url: format!("data:image/png;base64,{}", b64),
    }))
}
