use axum::{
    body::Body,
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        DefaultBodyLimit, Multipart, Path, Query, State,
    },
    http::{header, HeaderValue, StatusCode},
    middleware,
    response::{
        sse::{Event, KeepAlive, Sse},
        IntoResponse, Response,
    },
    routing::{get, post},
    Json, Router,
};
use futures_util::{Stream, StreamExt};
use std::convert::Infallible;
use tokio_stream::wrappers::BroadcastStream;
use uuid::Uuid;

use crate::approvals::{requires_agent_approval, Approval, ApprovalStatus, CreateApprovalRequest};
use crate::error::{ApiError, ApiResult};
use crate::models::*;
use crate::operations::preview::preview_operation;
use crate::security::middleware::security_middleware;
use crate::server::state::AppState;

pub fn create_router(state: AppState) -> Router {
    let session_store = state.session_store.clone();
    let automation = state.automation.clone();
    let media = state.media.clone();

    let api_routes = Router::new()
        // Unauthenticated / Exempt routes
        .merge(crate::experience::routes())
        .merge(crate::emulators::routes())
        .merge(crate::workflows::reports::routes())
        .route("/health", get(health_handler))
        .route("/session", get(session_handler))
        // Device discovery & Capabilities
        .route("/devices", get(list_devices_handler))
        .route("/discovery", get(discovery_handler))
        .route("/capabilities", get(capabilities_handler))
        // Operations
        .route("/operations", get(list_operations_handler))
        .route("/operations/preview", post(preview_operation_handler))
        // Jobs
        .route("/jobs", get(list_jobs_handler).post(create_job_handler))
        .route("/jobs/{id}", get(get_job_handler))
        .route("/jobs/{id}/cancel", post(cancel_job_handler))
        .route("/jobs/{id}/events", get(job_events_handler))
        // Audit log
        .route("/audit", get(list_audit_handler))
        // Agent approval queue
        .route(
            "/approvals",
            get(list_approvals_handler).post(create_approval_handler),
        )
        .route("/approvals/record", post(record_approval_handler))
        .route("/approvals/{id}", get(get_approval_handler))
        .route("/approvals/{id}/approve", post(approve_approval_handler))
        .route("/approvals/{id}/deny", post(deny_approval_handler))
        // Claude Code integration (MCP registration, skill)
        .route("/ai/status", get(ai_status_handler))
        .route("/ai/mcp/install", post(ai_install_mcp_handler))
        .route("/ai/mcp/remove", post(ai_remove_mcp_handler))
        .route("/ai/mcp/uninstall", post(ai_remove_mcp_handler))
        .route("/ai/mcp/test", post(ai_test_mcp_handler))
        .route("/ai/mcp/access", get(ai_mcp_access_handler))
        .route("/ai/skill/install", post(ai_install_skill_handler))
        .route("/ai/skill/remove", post(ai_remove_skill_handler))
        .route("/ai/skill/uninstall", post(ai_remove_skill_handler))
        // Global WebSocket Events
        .route("/events", get(events_ws_handler))
        // Artifacts
        .route(
            "/artifacts",
            get(list_artifacts_handler)
                .post(upload_artifact_handler)
                .layer(DefaultBodyLimit::max(512 * 1024 * 1024)),
        )
        .route(
            "/artifacts/{id}",
            get(get_artifact_handler).delete(delete_artifact_handler),
        )
        // Filesystem
        .route("/files", get(list_files_handler))
        // Read-only KPI statistics
        .route("/stats", get(device_stats_handler))
        // Host resource and process monitor telemetry
        .route("/host/telemetry", get(host_telemetry_handler))
        .route(
            "/host/reverse",
            get(host_reverse_status_handler).post(host_reverse_toggle_handler),
        )
        .route("/host/open-on-phone", post(host_open_on_phone_handler))
        // Package signing certificates and APK hashes
        .route("/inspect/package/signing", get(package_signing_handler))
        // App-private database inspection and editing
        .route("/inspect/database/access", get(db_access_handler))
        .route("/inspect/database/list", get(db_list_handler))
        .route(
            "/inspect/database/snapshots",
            get(db_snapshots_handler).post(db_snapshot_create_handler),
        )
        .route(
            "/inspect/database/snapshots/{id}",
            get(db_snapshot_get_handler).delete(db_snapshot_delete_handler),
        )
        .route(
            "/inspect/database/snapshots/{id}/schema",
            get(db_schema_handler),
        )
        .route(
            "/inspect/database/snapshots/{id}/query",
            post(db_query_handler),
        )
        .route(
            "/inspect/database/snapshots/{id}/execute",
            post(db_execute_handler),
        )
        .route(
            "/inspect/database/snapshots/{id}/push",
            post(db_push_handler),
        )
        // Process memory usage and heap dumps
        .route("/inspect/memory", get(memory_report_handler))
        .route("/inspect/memory/heapdump", post(memory_heapdump_handler))
        // Firebase: local inspection, device debug toggles, cloud calls
        .route("/inspect/firebase", get(firebase_report_handler))
        .route("/inspect/firebase/debug", post(firebase_debug_handler))
        .route(
            "/inspect/firebase/emulator-reverse",
            post(firebase_reverse_handler),
        )
        .route("/inspect/firebase/fcm/send", post(firebase_fcm_handler))
        .route("/inspect/firebase/remote-config", get(firebase_rc_handler))
        // Shell
        .route("/shell", post(create_shell_handler))
        .route("/shell/{id}", get(shell_ws_handler))
        // Workflows
        .route(
            "/workflows",
            get(list_workflows_handler).post(create_workflow_handler),
        )
        .route(
            "/workflows/{id}",
            get(get_workflow_handler)
                .put(update_workflow_handler)
                .delete(delete_workflow_handler),
        )
        .route("/workflows/{id}/run", post(run_workflow_handler))
        .route(
            "/workflows/{id}/appium",
            get(crate::workflows::appium::handler),
        )
        // Settings
        .route(
            "/settings",
            get(get_settings_handler).put(update_settings_handler),
        );
    let mut router = Router::new().nest("/api/v1", api_routes).with_state(state);
    if let Some(automation) = automation {
        router = router.merge(andrui_automation::router_with_state(automation));
    }
    if let Some(media) = media {
        router = router.merge(andrui_media::router_with_state(media));
    }
    router.layer(middleware::from_fn(move |req, next| {
        security_middleware(session_store.clone(), req, next)
    }))
}

// --- Handler Implementations ---

async fn health_handler(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "status": "ok",
        "mode": state.mode,
        "version": state.version,
    }))
}

async fn session_handler(State(state): State<AppState>) -> Response {
    let token = state.session_store.create_session();
    let cookie_val = format!(
        "andrui_session={}; HttpOnly; SameSite=Strict; Path=/",
        token
    );

    let mut response = Json(serde_json::json!({ "csrfToken": token })).into_response();
    if let Ok(hv) = HeaderValue::from_str(&cookie_val) {
        response.headers_mut().insert(header::SET_COOKIE, hv);
    }
    response
}

async fn list_devices_handler(State(state): State<AppState>) -> ApiResult<Json<Vec<Device>>> {
    let devices = state.device_tracker.list_devices().await?;
    Ok(Json(devices))
}

async fn discovery_handler(
    State(state): State<AppState>,
) -> Json<crate::adb::discovery::DiscoveryStatus> {
    Json(state.discovery.status().await)
}

async fn capabilities_handler(
    State(state): State<AppState>,
) -> ApiResult<Json<CapabilitiesResponse>> {
    let version = state
        .adb_executor
        .get_version()
        .await
        .unwrap_or_else(|_| "unknown".to_string());
    let catalog = crate::operations::runtime_catalog(&state.adb_executor).await;

    let mut capabilities = Vec::new();
    for op in catalog {
        for cov_id in op.coverage_ids {
            if !capabilities.iter().any(|c: &Capability| c.id == cov_id) {
                capabilities.push(Capability {
                    id: cov_id,
                    available: op.available,
                    reason: op.unavailable_reason.clone(),
                });
            }
        }
    }

    Ok(Json(CapabilitiesResponse {
        adb_version: version,
        capabilities,
        mode: state.mode,
    }))
}

async fn list_operations_handler(State(state): State<AppState>) -> Json<Vec<Operation>> {
    Json(crate::operations::runtime_catalog(&state.adb_executor).await)
}

async fn preview_operation_handler(
    State(state): State<AppState>,
    Json(mut req): Json<OperationPreviewRequest>,
) -> ApiResult<Json<CommandPreview>> {
    let adb_prog = state.adb_executor.adb_path().to_str().unwrap_or("adb");
    state
        .job_manager
        .resolve_parameters(&mut req.parameters)
        .await?;
    let preview = preview_operation(adb_prog, &req)?;
    Ok(Json(preview))
}

async fn create_job_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateJobRequest>,
) -> ApiResult<(StatusCode, Json<Job>)> {
    let job = state.job_manager.create_job(req).await?;
    Ok((StatusCode::ACCEPTED, Json(job)))
}

#[derive(Debug, serde::Deserialize)]
pub struct ListJobsQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub full: Option<bool>,
}

#[derive(Debug, serde::Deserialize)]
pub struct ListAuditQuery {
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub source: Option<String>,
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
}

async fn list_audit_handler(
    State(state): State<AppState>,
    Query(query): Query<ListAuditQuery>,
) -> ApiResult<Json<Vec<Job>>> {
    let jobs = state.db.list_audit_log(
        query.limit,
        query.offset,
        query.source.as_deref(),
        query.device_id.as_deref(),
    )?;
    Ok(Json(jobs))
}

fn publish_approval(state: &AppState, approval: &Approval) {
    state
        .job_manager
        .publish_global_event(serde_json::json!({ "type": "approval", "data": approval }));
}

/// Agent submission: queues approval-gated operations, runs the rest immediately.
async fn create_approval_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateApprovalRequest>,
) -> ApiResult<(StatusCode, Json<Approval>)> {
    crate::experience::check_policy(
        &state.db,
        &req.operation_id,
        req.device_id.as_deref(),
        &req.parameters,
    )?;
    let requester = req.requester.trim();
    if requester.is_empty() || requester.len() > 64 {
        return Err(ApiError::bad_request(
            "INVALID_REQUESTER",
            "requester must be 1-64 characters",
        ));
    }
    let catalog = crate::operations::runtime_catalog(&state.adb_executor).await;
    let op = catalog
        .iter()
        .find(|o| o.id == req.operation_id)
        .ok_or_else(|| {
            ApiError::bad_request(
                "UNKNOWN_OPERATION",
                format!("Operation '{}' not found in catalog", req.operation_id),
            )
        })?;
    let mut preview_req = OperationPreviewRequest {
        operation_id: req.operation_id.clone(),
        device_id: req.device_id.clone(),
        parameters: req.parameters.clone(),
    };
    state
        .job_manager
        .resolve_parameters(&mut preview_req.parameters)
        .await?;
    let adb_prog = state.adb_executor.adb_path().to_str().unwrap_or("adb");
    let preview = preview_operation(adb_prog, &preview_req)?;
    let mut approval = Approval {
        id: Uuid::new_v4().to_string(),
        operation_id: op.id.clone(),
        operation_label: op.label.clone(),
        destructive: op.destructive,
        severity: crate::approvals::severity(op),
        device_id: req.device_id.clone(),
        parameters: req.parameters.clone(),
        preview,
        requester: requester.to_string(),
        status: ApprovalStatus::Pending,
        job_id: None,
        error: None,
        created_at: chrono::Utc::now().to_rfc3339(),
        resolved_at: None,
    };
    let policy: crate::experience::AgentPolicy = state.db.read_value("experience.policy")?;
    if policy.auto_approve || !requires_agent_approval(op) {
        let job = state
            .job_manager
            .create_job(CreateJobRequest {
                operation_id: req.operation_id,
                device_id: req.device_id,
                parameters: req.parameters,
                confirmed: if policy.auto_approve && op.destructive {
                    Some(true)
                } else {
                    None
                },
                source: Some("mcp".to_string()),
                requester: Some(requester.to_string()),
            })
            .await?;
        approval.status = ApprovalStatus::NotRequired;
        approval.job_id = Some(job.id);
        approval.resolved_at = Some(chrono::Utc::now().to_rfc3339());
    }
    let approval = state.approvals.insert(approval)?;
    publish_approval(&state, &approval);
    if approval.status == ApprovalStatus::Pending {
        crate::approvals::notify::spawn_desktop_notification(state.clone(), approval.clone());
    }
    Ok((StatusCode::CREATED, Json(approval)))
}

async fn list_approvals_handler(State(state): State<AppState>) -> ApiResult<Json<Vec<Approval>>> {
    Ok(Json(state.approvals.list()?))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecordApprovalRequest {
    operation_id: String,
    operation_label: String,
    #[serde(default)]
    device_id: Option<String>,
    #[serde(default)]
    parameters: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    display: String,
    requester: String,
    #[serde(default)]
    error: Option<String>,
}

async fn record_approval_handler(
    State(state): State<AppState>,
    Json(req): Json<RecordApprovalRequest>,
) -> ApiResult<(StatusCode, Json<Approval>)> {
    let requester = req.requester.trim();
    if requester.is_empty() || requester.len() > 64 {
        return Err(ApiError::bad_request(
            "INVALID_REQUESTER",
            "requester must be 1-64 characters",
        ));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let status = if req.error.is_some() {
        ApprovalStatus::Failed
    } else {
        ApprovalStatus::NotRequired
    };
    let approval = Approval {
        id: Uuid::new_v4().to_string(),
        operation_id: req.operation_id.clone(),
        operation_label: req.operation_label,
        destructive: false,
        severity: crate::approvals::Severity::Low,
        device_id: req.device_id,
        parameters: req.parameters,
        preview: crate::models::CommandPreview {
            program: "mcp".to_string(),
            args: vec![req.operation_id],
            display: req.display,
        },
        requester: requester.to_string(),
        status,
        job_id: None,
        error: req.error,
        created_at: now.clone(),
        resolved_at: Some(now),
    };
    let approval = state.approvals.insert(approval)?;
    publish_approval(&state, &approval);
    Ok((StatusCode::CREATED, Json(approval)))
}

async fn get_approval_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Approval>> {
    Ok(Json(state.approvals.get(&id)?))
}

pub(crate) async fn resolve_approval_decision(
    state: &AppState,
    id: &str,
    approve: bool,
) -> ApiResult<Approval> {
    if !approve {
        let approval = state.approvals.resolve(id, ApprovalStatus::Denied)?;
        publish_approval(state, &approval);
        return Ok(approval);
    }

    let pending = state.approvals.get(id)?;
    crate::experience::check_policy(
        &state.db,
        &pending.operation_id,
        pending.device_id.as_deref(),
        &pending.parameters,
    )?;
    let approval = state.approvals.resolve(id, ApprovalStatus::Approved)?;
    let result = state
        .job_manager
        .create_job(CreateJobRequest {
            operation_id: approval.operation_id,
            device_id: approval.device_id,
            parameters: approval.parameters,
            confirmed: Some(true),
            source: Some("mcp".to_string()),
            requester: Some(approval.requester),
        })
        .await;
    let recorded = state.approvals.record_job(
        id,
        result
            .as_ref()
            .map(|job| job.id.clone())
            .map_err(|e| e.to_string()),
    )?;
    if let Some(approval) = &recorded {
        publish_approval(state, approval);
    }
    result?;
    recorded.ok_or_else(|| ApiError::not_found("APPROVAL_NOT_FOUND", "Approval not found"))
}

async fn approve_approval_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Approval>> {
    Ok(Json(resolve_approval_decision(&state, &id, true).await?))
}

async fn deny_approval_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Approval>> {
    Ok(Json(resolve_approval_decision(&state, &id, false).await?))
}

/// Base URL of this server as the browser reached it (Host is validated as loopback).
fn ai_integration(headers: &axum::http::HeaderMap) -> ApiResult<crate::ai::AiIntegration> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::bad_request("HOST_REQUIRED", "Host header is required"))?;
    crate::ai::AiIntegration::from_env(format!("http://{host}"))
}

async fn ai_status_handler(headers: axum::http::HeaderMap) -> ApiResult<Json<crate::ai::AiStatus>> {
    Ok(Json(ai_integration(&headers)?.status().await))
}

async fn ai_install_mcp_handler(
    headers: axum::http::HeaderMap,
    Json(req): Json<crate::ai::ConfirmRequest>,
) -> ApiResult<Json<crate::ai::AiStatus>> {
    crate::ai::require_confirmation(&req)?;
    Ok(Json(ai_integration(&headers)?.install_mcp().await?))
}

async fn ai_remove_mcp_handler(
    headers: axum::http::HeaderMap,
    Json(req): Json<crate::ai::ConfirmRequest>,
) -> ApiResult<Json<crate::ai::AiStatus>> {
    crate::ai::require_confirmation(&req)?;
    Ok(Json(ai_integration(&headers)?.remove_mcp().await?))
}

async fn ai_test_mcp_handler(
    headers: axum::http::HeaderMap,
) -> ApiResult<Json<crate::ai::McpTestResult>> {
    Ok(Json(ai_integration(&headers)?.test_mcp().await))
}

/// What the MCP tools can reach, and which operations need approval or are blocked by policy.
async fn ai_mcp_access_handler(
    State(state): State<AppState>,
) -> ApiResult<Json<serde_json::Value>> {
    let policy: crate::experience::AgentPolicy = state.db.read_value("experience.policy")?;
    let tools: Vec<serde_json::Value> = crate::ai::mcp_tools::definitions()
        .into_iter()
        .map(|tool| {
            let name = tool["name"].as_str().unwrap_or_default();
            serde_json::json!({
                "name": name,
                "description": tool["description"],
                "approval": crate::ai::mcp_tools::tool_approval(name),
            })
        })
        .collect();
    let operations: Vec<serde_json::Value> =
        crate::operations::runtime_catalog(&state.adb_executor)
            .await
            .iter()
            .map(|op| {
                serde_json::json!({
                    "id": op.id,
                    "label": op.label,
                    "category": op.category,
                    "destructive": op.destructive,
                    "available": op.available,
                    "unavailableReason": op.unavailable_reason,
                    "severity": crate::approvals::severity(op),
                    "blockedReason": policy.operation_block(&op.id),
                })
            })
            .collect();
    Ok(Json(serde_json::json!({
        "paused": policy.paused,
        "autoApprove": policy.auto_approve,
        "deviceIds": policy.device_ids,
        "tools": tools,
        "operations": operations,
    })))
}

async fn ai_install_skill_handler(
    headers: axum::http::HeaderMap,
    Json(req): Json<crate::ai::ConfirmRequest>,
) -> ApiResult<Json<crate::ai::AiStatus>> {
    crate::ai::require_confirmation(&req)?;
    Ok(Json(ai_integration(&headers)?.install_skill().await?))
}

async fn ai_remove_skill_handler(
    headers: axum::http::HeaderMap,
    Json(req): Json<crate::ai::ConfirmRequest>,
) -> ApiResult<Json<crate::ai::AiStatus>> {
    crate::ai::require_confirmation(&req)?;
    Ok(Json(ai_integration(&headers)?.remove_skill().await?))
}

async fn list_jobs_handler(
    Query(params): Query<ListJobsQuery>,
    State(state): State<AppState>,
) -> ApiResult<Response> {
    let jobs = state
        .job_manager
        .list_jobs(params.limit, params.offset, params.full.unwrap_or(false))
        .await?;
    let total = state.job_manager.count_jobs().await?;

    let json_body = serde_json::to_string(&jobs)
        .map_err(|e| ApiError::internal("SERIALIZE_ERROR", e.to_string()))?;

    let response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-Total-Count", total.to_string())
        .header("Access-Control-Expose-Headers", "X-Total-Count")
        .body(Body::from(json_body))
        .map_err(|e| ApiError::internal("RESPONSE_ERROR", e.to_string()))?;

    Ok(response)
}

async fn get_job_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Job>> {
    let job = state.job_manager.get_job(&id).await?;
    Ok(Json(job))
}

async fn cancel_job_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Job>> {
    let job = state.job_manager.cancel_job(&id).await?;
    Ok(Json(job))
}

async fn job_events_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    let stream: std::pin::Pin<Box<dyn Stream<Item = Result<Event, Infallible>> + Send>> =
        if let Some(rx) = state.job_manager.subscribe_job_events(&id) {
            Box::pin(BroadcastStream::new(rx).filter_map(|result| async move {
            let value = match result {
                Ok(event) => serde_json::to_value(event).unwrap_or_default(),
                Err(error) => serde_json::json!({"type":"progress", "data":{"warning":error.to_string(), "recover":"GET /jobs/:id for persisted output"}}),
            };
            Some(Ok(Event::default().data(value.to_string())))
        }))
        } else {
            let job = state.job_manager.get_job(&id).await?;
            let values = vec![
                serde_json::json!({"type":"stdout", "jobId":id, "data":job.stdout}),
                serde_json::json!({"type":"stderr", "jobId":id, "data":job.stderr}),
                serde_json::json!({"type":"status", "jobId":id, "data":{"status":job.status, "exitCode":job.exit_code}}),
            ];
            Box::pin(futures_util::stream::iter(
                values
                    .into_iter()
                    .map(|v| Ok(Event::default().data(v.to_string()))),
            ))
        };
    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn events_ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    let rx = state.job_manager.subscribe_global_events();
    ws.on_upgrade(|mut socket: WebSocket| async move {
        let mut stream = BroadcastStream::new(rx);
        while let Some(msg_res) = stream.next().await {
            if let Ok(val) = msg_res {
                if let Ok(json_str) = serde_json::to_string(&val) {
                    if socket.send(Message::Text(json_str.into())).await.is_err() {
                        break;
                    }
                }
            }
        }
    })
}

async fn upload_artifact_handler(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> ApiResult<(StatusCode, Json<Artifact>)> {
    use tokio::io::AsyncWriteExt;
    while let Some(mut field) = multipart
        .next_field()
        .await
        .map_err(|e| ApiError::bad_request("MULTIPART_ERROR", e.to_string()))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let content_type = field
            .content_type()
            .unwrap_or("application/octet-stream")
            .to_string();
        let (id, name, mut file) = state
            .artifact_store
            .create_upload(field.file_name().unwrap_or("upload.bin"))
            .await?;
        let result: ApiResult<u64> = async {
            let mut size = 0u64;
            while let Some(chunk) = field
                .chunk()
                .await
                .map_err(|e| ApiError::bad_request("MULTIPART_ERROR", e.to_string()))?
            {
                size += chunk.len() as u64;
                if size > 512 * 1024 * 1024 {
                    return Err(ApiError::bad_request(
                        "FILE_TOO_LARGE",
                        "Upload exceeds 512 MiB",
                    ));
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|e| ApiError::internal("ARTIFACT_WRITE_FAILED", e.to_string()))?;
            }
            file.flush()
                .await
                .map_err(|e| ApiError::internal("ARTIFACT_WRITE_FAILED", e.to_string()))?;
            if size == 0 {
                return Err(ApiError::bad_request(
                    "EMPTY_FILE",
                    "Uploaded file is empty",
                ));
            }
            Ok(size)
        }
        .await;
        drop(file);
        let size = match result {
            Ok(size) => size,
            Err(error) => {
                state.artifact_store.delete_artifact_file(&id).await?;
                return Err(error);
            }
        };
        let artifact = Artifact {
            id,
            name,
            size,
            content_type,
            created_at: chrono::Utc::now().to_rfc3339(),
        };
        state.db.insert_artifact(&artifact)?;
        state.job_manager.publish_global_event(serde_json::json!({
            "type": "artifact_created",
            "data": artifact
        }));
        return Ok((StatusCode::CREATED, Json(artifact)));
    }
    Err(ApiError::bad_request(
        "MISSING_FILE",
        "Multipart field 'file' is required",
    ))
}

async fn list_artifacts_handler(State(state): State<AppState>) -> ApiResult<Json<Vec<Artifact>>> {
    let artifacts = state.db.list_artifacts()?;
    Ok(Json(artifacts))
}

async fn get_artifact_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Response> {
    let meta = state
        .db
        .get_artifact(&id)?
        .ok_or_else(|| ApiError::not_found("ARTIFACT_NOT_FOUND", "Artifact metadata not found"))?;

    let path = state.artifact_store.path_for(&id).await?;
    let file = tokio::fs::File::open(path)
        .await
        .map_err(|e| ApiError::internal("ARTIFACT_READ_FAILED", e.to_string()))?;

    let mut res = Response::builder()
        .status(StatusCode::OK)
        .body(Body::from_stream(tokio_util::io::ReaderStream::new(file)))
        .map_err(|e| ApiError::internal("RESPONSE_BUILD_FAILED", e.to_string()))?;

    if let Ok(ct) = HeaderValue::from_str(&meta.content_type) {
        res.headers_mut().insert(header::CONTENT_TYPE, ct);
    }
    let disp = format!("attachment; filename=\"{}\"", meta.name);
    if let Ok(cd) = HeaderValue::from_str(&disp) {
        res.headers_mut().insert(header::CONTENT_DISPOSITION, cd);
    }

    Ok(res)
}

async fn delete_artifact_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state.artifact_store.delete_artifact_file(&id).await?;
    state.db.delete_artifact(&id)?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}

async fn list_files_handler(
    State(state): State<AppState>,
    Query(query): Query<FileQuery>,
) -> ApiResult<Json<FileListing>> {
    let listing = state
        .file_service
        .list_files(&query.device_id, query.path.as_deref())
        .await?;
    Ok(Json(listing))
}

async fn device_stats_handler(
    State(state): State<AppState>,
    Query(query): Query<crate::stats::StatsQuery>,
) -> ApiResult<Json<crate::stats::DeviceStats>> {
    let stats = crate::stats::collect_with_package(
        &state.adb_executor,
        &query.device_id,
        &query.scope,
        query.package.as_deref(),
    )
    .await?;
    Ok(Json(stats))
}

#[derive(serde::Deserialize)]
struct PackageInspectQuery {
    #[serde(rename = "deviceId")]
    device_id: String,
    package: String,
}

async fn package_signing_handler(
    State(state): State<AppState>,
    Query(query): Query<PackageInspectQuery>,
) -> ApiResult<Json<crate::inspect::PackageSigning>> {
    let result = crate::inspect::inspect_package_signing(
        &state.adb_executor,
        &query.device_id,
        &query.package,
    )
    .await?;
    Ok(Json(result))
}

async fn db_access_handler(
    State(state): State<AppState>,
    Query(query): Query<PackageInspectQuery>,
) -> ApiResult<Json<crate::inspect::database::AccessProbe>> {
    let probe = crate::inspect::database::probe_access(
        &state.adb_executor,
        &query.device_id,
        &query.package,
    )
    .await?;
    Ok(Json(probe))
}

async fn db_list_handler(
    State(state): State<AppState>,
    Query(query): Query<PackageInspectQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    let (mode, entries) = crate::inspect::database::list_databases(
        &state.adb_executor,
        &query.device_id,
        &query.package,
    )
    .await?;
    Ok(Json(
        serde_json::json!({ "mode": mode, "databases": entries }),
    ))
}

async fn db_snapshots_handler(
    State(state): State<AppState>,
) -> ApiResult<Json<Vec<crate::inspect::database::SnapshotMeta>>> {
    Ok(Json(state.db_snapshots.list().await?))
}

#[derive(serde::Deserialize)]
struct DbSnapshotCreateRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    package: String,
    database: String,
}

async fn db_snapshot_create_handler(
    State(state): State<AppState>,
    Json(req): Json<DbSnapshotCreateRequest>,
) -> ApiResult<(StatusCode, Json<crate::inspect::database::SnapshotMeta>)> {
    let meta = crate::inspect::database::take_snapshot(
        &state.adb_executor,
        &state.db_snapshots,
        &req.device_id,
        &req.package,
        &req.database,
    )
    .await?;
    Ok((StatusCode::CREATED, Json(meta)))
}

async fn db_snapshot_get_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<crate::inspect::database::SnapshotMeta>> {
    Ok(Json(state.db_snapshots.meta(&id).await?))
}

async fn db_snapshot_delete_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state.db_snapshots.delete(&id).await?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}

async fn db_schema_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    let path = state.db_snapshots.db_path(&id)?;
    state.db_snapshots.meta(&id).await?; // 404 if the snapshot is unknown
    Ok(Json(crate::inspect::database::schema(&path)?))
}

#[derive(serde::Deserialize)]
struct DbQueryRequest {
    sql: String,
    #[serde(rename = "maxRows")]
    max_rows: Option<usize>,
}

async fn db_query_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<DbQueryRequest>,
) -> ApiResult<Json<crate::inspect::database::QueryResult>> {
    let path = state.db_snapshots.db_path(&id)?;
    state.db_snapshots.meta(&id).await?;
    let max_rows = req.max_rows.unwrap_or(1000).min(10_000);
    Ok(Json(crate::inspect::database::query(
        &path, &req.sql, max_rows,
    )?))
}

async fn db_execute_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<DbQueryRequest>,
) -> ApiResult<Json<crate::inspect::database::QueryResult>> {
    let path = state.db_snapshots.db_path(&id)?;
    state.db_snapshots.meta(&id).await?;
    Ok(Json(crate::inspect::database::execute(&path, &req.sql)?))
}

async fn db_push_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<crate::ai::ConfirmRequest>,
) -> ApiResult<Json<crate::inspect::database::PushResult>> {
    let result = crate::inspect::database::push_snapshot(
        &state.adb_executor,
        &state.db_snapshots,
        &state.artifact_store,
        &state.db,
        &id,
        req.confirmed,
    )
    .await?;
    if let Ok(Some(artifact)) = state.db.get_artifact(&result.backup_artifact_id) {
        state.job_manager.publish_global_event(serde_json::json!({
            "type": "artifact_created",
            "data": artifact
        }));
    }
    Ok(Json(result))
}

async fn memory_report_handler(
    State(state): State<AppState>,
    Query(query): Query<PackageInspectQuery>,
) -> ApiResult<Json<crate::inspect::memory::MemoryReport>> {
    let report = crate::inspect::memory::memory_report(
        &state.adb_executor,
        &query.device_id,
        &query.package,
    )
    .await?;
    Ok(Json(report))
}

#[derive(serde::Deserialize)]
struct HeapDumpRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    package: String,
    #[serde(default)]
    native: bool,
    #[serde(default)]
    confirmed: bool,
}

async fn memory_heapdump_handler(
    State(state): State<AppState>,
    Json(req): Json<HeapDumpRequest>,
) -> ApiResult<Json<crate::inspect::memory::HeapDumpResult>> {
    let result = crate::inspect::memory::capture_heap_dump(
        &state.adb_executor,
        &state.artifact_store,
        &state.db,
        &req.device_id,
        &req.package,
        req.native,
        req.confirmed,
    )
    .await?;
    if let Ok(Some(artifact)) = state.db.get_artifact(&result.artifact_id) {
        state.job_manager.publish_global_event(serde_json::json!({
            "type": "artifact_created",
            "data": artifact
        }));
    }
    Ok(Json(result))
}

async fn firebase_report_handler(
    State(state): State<AppState>,
    Query(query): Query<PackageInspectQuery>,
) -> ApiResult<Json<crate::inspect::firebase::FirebaseReport>> {
    let report = crate::inspect::firebase::local_report(
        &state.adb_executor,
        &query.device_id,
        &query.package,
    )
    .await?;
    Ok(Json(report))
}

#[derive(serde::Deserialize)]
struct FirebaseDebugRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    package: String,
    enable: bool,
    #[serde(default)]
    confirmed: bool,
}

async fn firebase_debug_handler(
    State(state): State<AppState>,
    Json(req): Json<FirebaseDebugRequest>,
) -> ApiResult<Json<crate::inspect::firebase::DebugToggleResult>> {
    let result = crate::inspect::firebase::set_debug_logging(
        &state.adb_executor,
        &req.device_id,
        &req.package,
        req.enable,
        req.confirmed,
    )
    .await?;
    Ok(Json(result))
}

#[derive(serde::Deserialize)]
struct FirebaseReverseRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(default)]
    confirmed: bool,
}

async fn firebase_reverse_handler(
    State(state): State<AppState>,
    Json(req): Json<FirebaseReverseRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    let ports = crate::inspect::firebase::setup_emulator_reverse(
        &state.adb_executor,
        &req.device_id,
        req.confirmed,
    )
    .await?;
    Ok(Json(serde_json::json!({ "ports": ports })))
}

async fn firebase_fcm_handler(
    Json(req): Json<crate::inspect::firebase::FcmSendRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(crate::inspect::firebase::fcm_send(&req).await?))
}

#[derive(serde::Deserialize)]
struct RemoteConfigQuery {
    #[serde(rename = "serviceAccountEnv")]
    service_account_env: String,
    #[serde(rename = "projectId", default)]
    project_id: String,
}

async fn firebase_rc_handler(
    Query(query): Query<RemoteConfigQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    Ok(Json(
        crate::inspect::firebase::remote_config_get(&query.service_account_env, &query.project_id)
            .await?,
    ))
}

async fn create_shell_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateShellRequest>,
) -> ApiResult<Json<CreateShellResponse>> {
    let res = state.shell_manager.create_session(req)?;
    Ok(Json(res))
}

async fn shell_ws_handler(
    ws: WebSocketUpgrade,
    Path(id): Path<String>,
    State(state): State<AppState>,
) -> Response {
    let shell_manager = state.shell_manager.clone();
    ws.on_upgrade(move |socket| async move {
        shell_manager.handle_websocket(id, socket).await;
    })
}

async fn list_workflows_handler(State(state): State<AppState>) -> ApiResult<Json<Vec<Workflow>>> {
    let workflows = state.db.list_workflows()?;
    Ok(Json(workflows))
}

async fn create_workflow_handler(
    State(state): State<AppState>,
    Json(req): Json<CreateWorkflowRequest>,
) -> ApiResult<(StatusCode, Json<Workflow>)> {
    crate::experience::validate_workflow(&req)?;
    let workflow = Workflow {
        id: Uuid::new_v4().to_string(),
        name: req.name,
        steps: req.steps,
    };
    state.db.insert_workflow(&workflow)?;
    Ok((StatusCode::CREATED, Json(workflow)))
}

async fn get_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Workflow>> {
    let workflow = state
        .db
        .get_workflow(&id)?
        .ok_or_else(|| ApiError::not_found("WORKFLOW_NOT_FOUND", "Workflow not found"))?;
    Ok(Json(workflow))
}

async fn update_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<CreateWorkflowRequest>,
) -> ApiResult<Json<Workflow>> {
    crate::experience::validate_workflow(&req)?;
    let workflow = Workflow {
        id,
        name: req.name,
        steps: req.steps,
    };
    state.db.update_workflow(&workflow)?;
    Ok(Json(workflow))
}

async fn delete_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    state.db.delete_workflow(&id)?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}

async fn run_workflow_handler(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<RunWorkflowRequest>,
) -> ApiResult<Json<RunWorkflowResponse>> {
    let (job_ids, run_id) = state
        .workflow_runner
        .run_recorded(&id, &req.device_ids, req.confirmed)
        .await?;
    Ok(Json(RunWorkflowResponse { job_ids, run_id }))
}

async fn get_settings_handler(State(state): State<AppState>) -> ApiResult<Json<Settings>> {
    let settings = state.db.get_settings()?;
    Ok(Json(settings))
}

async fn update_settings_handler(
    State(state): State<AppState>,
    Json(settings): Json<Settings>,
) -> ApiResult<Json<Settings>> {
    if settings.adb_path != state.adb_executor.adb_path().to_string_lossy()
        || settings.data_dir != state.db.get_settings()?.data_dir
    {
        return Err(ApiError::bad_request(
            "RESTART_REQUIRED",
            "ADB executable and data directory are startup options; restart with --adb/--data-dir",
        ));
    }
    if settings.default_timeout_ms < 100 || settings.default_timeout_ms > 3_600_000 {
        return Err(ApiError::bad_request(
            "INVALID_TIMEOUT",
            "Timeout must be between 100 and 3600000 milliseconds",
        ));
    }
    state.db.save_settings(&settings)?;
    state
        .job_manager
        .set_default_timeout_ms(settings.default_timeout_ms);
    Ok(Json(settings))
}

async fn host_telemetry_handler() -> Json<crate::host::HostTelemetry> {
    Json(crate::host::collect_host_telemetry().await)
}

pub(crate) const AUTO_REVERSE_DB_KEY: &str = "host.auto_reverse_devices";

#[derive(serde::Deserialize)]
struct HostReverseQuery {
    #[serde(rename = "deviceId")]
    device_id: String,
}

#[derive(serde::Deserialize)]
struct HostReverseRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    enabled: Option<bool>,
    #[serde(rename = "autoReverse")]
    auto_reverse: Option<bool>,
}

#[derive(serde::Deserialize)]
struct OpenHostOnPhoneRequest {
    #[serde(rename = "deviceId")]
    device_id: String,
    #[serde(default)]
    confirmed: bool,
}

fn validate_device_id(device_id: &str) -> ApiResult<()> {
    if device_id.is_empty()
        || device_id.starts_with('-')
        || device_id.chars().any(|c| c.is_whitespace() || c == '\0')
    {
        return Err(ApiError::bad_request(
            "INVALID_DEVICE",
            "A valid device serial is required",
        ));
    }
    Ok(())
}

fn extract_host_port(headers: &axum::http::HeaderMap) -> ApiResult<u16> {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .ok_or_else(|| ApiError::bad_request("HOST_REQUIRED", "Host header is required"))?;
    let parsed = reqwest::Url::parse(&format!("http://{host}"))
        .map_err(|_| ApiError::bad_request("INVALID_HOST", "Invalid Host header"))?;
    parsed
        .port_or_known_default()
        .ok_or_else(|| ApiError::bad_request("INVALID_HOST", "Invalid Host port"))
}

pub(crate) async fn is_host_reverse_active(
    adb: &crate::adb::executor::AdbExecutor,
    device_id: &str,
    port: u16,
) -> ApiResult<bool> {
    let spec = format!("tcp:{port}");
    let out = adb
        .execute(
            &[
                "-s".into(),
                device_id.to_string(),
                "reverse".into(),
                "--list".into(),
            ],
            Some(std::time::Duration::from_secs(10)),
            None,
        )
        .await?;
    if out.exit_code != 0 {
        return Err(ApiError::bad_request(
            "REVERSE_LIST_FAILED",
            format!("adb reverse --list failed: {}", out.stderr.trim()),
        ));
    }
    let active = out.stdout.lines().any(|line| {
        let parts: Vec<&str> = line.split_whitespace().collect();
        parts.len() >= 3 && parts[1] == spec && parts[2] == spec
    });
    Ok(active)
}

pub(crate) async fn set_host_reverse(
    adb: &crate::adb::executor::AdbExecutor,
    device_id: &str,
    port: u16,
    enabled: bool,
) -> ApiResult<()> {
    let spec = format!("tcp:{port}");
    let args: Vec<String> = if enabled {
        vec![
            "-s".into(),
            device_id.to_string(),
            "reverse".into(),
            spec.clone(),
            spec,
        ]
    } else {
        vec![
            "-s".into(),
            device_id.to_string(),
            "reverse".into(),
            "--remove".into(),
            spec,
        ]
    };
    let out = adb
        .execute(&args, Some(std::time::Duration::from_secs(15)), None)
        .await?;
    if out.exit_code != 0 {
        // Removing a non-existent rule is already inactive; only fail on enable or unexpected errors.
        if enabled || !out.stderr.contains("not found") {
            return Err(ApiError::bad_request(
                "REVERSE_FAILED",
                format!("adb reverse failed: {}", out.stderr.trim()),
            ));
        }
    }
    Ok(())
}

fn read_auto_reverse_devices(db: &crate::storage::db::Database) -> ApiResult<Vec<String>> {
    db.read_value::<Vec<String>>(AUTO_REVERSE_DB_KEY)
}

fn set_device_auto_reverse(
    db: &crate::storage::db::Database,
    device_id: &str,
    enabled: bool,
) -> ApiResult<bool> {
    let mut list = read_auto_reverse_devices(db)?;
    list.retain(|id| id != device_id);
    if enabled {
        list.push(device_id.to_string());
    }
    db.write_value(AUTO_REVERSE_DB_KEY, &list)?;
    Ok(enabled)
}

async fn host_reverse_status_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Query(query): Query<HostReverseQuery>,
) -> ApiResult<Json<serde_json::Value>> {
    validate_device_id(&query.device_id)?;
    let port = extract_host_port(&headers)?;
    let active = is_host_reverse_active(&state.adb_executor, &query.device_id, port).await?;
    let auto_reverse = read_auto_reverse_devices(&state.db)?
        .iter()
        .any(|id| id == &query.device_id);
    Ok(Json(serde_json::json!({
        "deviceId": query.device_id,
        "port": port,
        "active": active,
        "autoReverse": auto_reverse,
        "url": format!("http://127.0.0.1:{port}/?view=host"),
    })))
}

async fn host_reverse_toggle_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<HostReverseRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    validate_device_id(&req.device_id)?;
    let port = extract_host_port(&headers)?;
    if let Some(enabled) = req.enabled {
        set_host_reverse(&state.adb_executor, &req.device_id, port, enabled).await?;
    }
    let auto_reverse = match req.auto_reverse {
        Some(flag) => set_device_auto_reverse(&state.db, &req.device_id, flag)?,
        None => read_auto_reverse_devices(&state.db)?
            .iter()
            .any(|id| id == &req.device_id),
    };
    let active = is_host_reverse_active(&state.adb_executor, &req.device_id, port).await?;
    Ok(Json(serde_json::json!({
        "deviceId": req.device_id,
        "port": port,
        "active": active,
        "autoReverse": auto_reverse,
        "url": format!("http://127.0.0.1:{port}/?view=host"),
    })))
}

async fn host_open_on_phone_handler(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    Json(req): Json<OpenHostOnPhoneRequest>,
) -> ApiResult<Json<serde_json::Value>> {
    validate_device_id(&req.device_id)?;
    if !req.confirmed {
        return Err(ApiError::bad_request(
            "CONFIRMATION_REQUIRED",
            "Opening the host dashboard on the phone requires confirmation",
        ));
    }
    let port = extract_host_port(&headers)?;
    set_host_reverse(&state.adb_executor, &req.device_id, port, true).await?;
    let url = format!("http://127.0.0.1:{port}/?view=host");
    let launch = state
        .adb_executor
        .execute(
            &[
                "-s".into(),
                req.device_id.clone(),
                "shell".into(),
                "am".into(),
                "start".into(),
                "-a".into(),
                "android.intent.action.VIEW".into(),
                "-d".into(),
                url.clone(),
            ],
            Some(std::time::Duration::from_secs(15)),
            None,
        )
        .await?;
    if launch.exit_code != 0 {
        let msg = if launch.stderr.trim().is_empty() {
            launch.stdout.trim()
        } else {
            launch.stderr.trim()
        };
        return Err(ApiError::bad_request(
            "LAUNCH_FAILED",
            format!("Failed to open browser on phone: {msg}"),
        ));
    }
    Ok(Json(serde_json::json!({
        "deviceId": req.device_id,
        "port": port,
        "url": url,
    })))
}
