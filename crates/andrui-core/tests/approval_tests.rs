use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
    Router,
};
use http_body_util::BodyExt;
use serde_json::{json, Value};
use std::{
    fs::{self, Permissions},
    os::unix::fs::PermissionsExt,
};
use tempfile::TempDir;
use tower::ServiceExt;

use andrui_core::{
    adb::{device_tracker::DeviceTracker, executor::AdbExecutor},
    approvals::ApprovalStore,
    files::service::FileService,
    jobs::manager::JobManager,
    security::session::SessionStore,
    server::{router::create_router, state::AppState},
    shell::manager::ShellManager,
    storage::{artifacts::ArtifactStore, db::Database},
    workflows::runner::WorkflowRunner,
};

const FAKE_ADB: &str = r#"#!/usr/bin/env bash
if [ "$1" = "help" ]; then echo "Android Debug Bridge shell install uninstall devices"; exit 0; fi
if [ "$1" = "version" ]; then echo "Android Debug Bridge version 1.0.41"; exit 0; fi
echo "fake adb ran: $@"
exit 0
"#;

struct Harness {
    router: Router,
    token: String,
    _dir: TempDir,
}

async fn harness() -> Harness {
    let dir = TempDir::new().unwrap();
    let adb_path = dir.path().join("adb");
    fs::write(&adb_path, FAKE_ADB).unwrap();
    fs::set_permissions(&adb_path, Permissions::from_mode(0o755)).unwrap();
    let db = Database::in_memory().unwrap();
    let executor = AdbExecutor::new(&adb_path);
    let job_manager = JobManager::new(executor.clone(), db.clone());
    let state = AppState {
        emulators: andrui_core::emulators::EmulatorManager::default(),
        automation: None,
        media: None,
        mode: "native".to_string(),
        version: "test".to_string(),
        adb_executor: executor.clone(),
        device_tracker: DeviceTracker::new(executor.clone()),
        discovery: andrui_core::adb::discovery::DeviceDiscovery::start(),
        job_manager: job_manager.clone(),
        artifact_store: ArtifactStore::new(dir.path()),
        db_snapshots: andrui_core::inspect::database::DbSnapshotStore::new(dir.path()),
        db: db.clone(),
        shell_manager: ShellManager::new(adb_path),
        file_service: FileService::new(executor),
        workflow_runner: WorkflowRunner::new(job_manager, db),
        session_store: SessionStore::new(),
        approvals: ApprovalStore::new(),
        web_dir: None,
    };
    let router = create_router(state);
    let (_, session) = send(&router, Method::GET, "/api/v1/session", None, None).await;
    let token = session["csrfToken"].as_str().unwrap().to_string();
    Harness {
        router,
        token,
        _dir: dir,
    }
}

async fn send(
    router: &Router,
    method: Method,
    uri: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> (StatusCode, Value) {
    let mut req = Request::builder()
        .method(method)
        .uri(uri)
        .header(header::HOST, "127.0.0.1:19801")
        .header(header::CONTENT_TYPE, "application/json");
    if let Some(token) = token {
        req = req
            .header("X-CSRF-Token", token)
            .header(header::COOKIE, format!("andrui_session={token}"));
    }
    let body = body.map(|b| Body::from(b.to_string())).unwrap_or_default();
    let res = router
        .clone()
        .oneshot(req.body(body).unwrap())
        .await
        .unwrap();
    let status = res.status();
    let bytes = res.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

async fn job_count(h: &Harness) -> usize {
    let (status, jobs) = send(&h.router, Method::GET, "/api/v1/jobs", None, None).await;
    assert_eq!(status, StatusCode::OK);
    jobs.as_array().unwrap().len()
}

impl Harness {
    async fn post(&self, uri: &str, body: Value) -> (StatusCode, Value) {
        send(
            &self.router,
            Method::POST,
            uri,
            Some(&self.token),
            Some(body),
        )
        .await
    }
}

#[tokio::test]
async fn destructive_and_shell_requests_wait_for_approval() {
    let h = harness().await;
    for (operation_id, parameters, severity) in [
        (
            "package.uninstall",
            json!({"package": "com.example"}),
            "high",
        ),
        (
            "shell.exec",
            json!({"command": "pm uninstall com.example"}),
            "medium",
        ),
    ] {
        let (status, approval) = h
            .post(
                "/api/v1/approvals",
                json!({"operationId": operation_id, "deviceId": "emulator-5554",
                       "parameters": parameters, "requester": "mcp", "confirmed": true}),
            )
            .await;
        assert_eq!(status, StatusCode::CREATED, "{approval}");
        assert_eq!(approval["status"], "pending");
        assert_eq!(approval["severity"], severity);
        assert_eq!(approval["parameters"], parameters);
        assert!(approval.get("jobId").is_none());
        assert!(approval["preview"]["display"]
            .as_str()
            .unwrap()
            .contains("emulator-5554"));
    }
    assert_eq!(job_count(&h).await, 0, "no job may start before approval");
}

#[tokio::test]
async fn approve_starts_job_once_and_deny_blocks() {
    let h = harness().await;
    let body = json!({"operationId": "package.uninstall", "deviceId": "emulator-5554",
                      "parameters": {"package": "com.example"}, "requester": "mcp"});
    let (_, first) = h.post("/api/v1/approvals", body.clone()).await;
    let (_, second) = h.post("/api/v1/approvals", body).await;
    let first_id = first["id"].as_str().unwrap();
    let second_id = second["id"].as_str().unwrap();

    // Approval without CSRF is rejected by the middleware.
    let (status, _) = send(
        &h.router,
        Method::POST,
        &format!("/api/v1/approvals/{first_id}/approve"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let (status, approved) = h
        .post(&format!("/api/v1/approvals/{first_id}/approve"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK, "{approved}");
    assert_eq!(approved["status"], "approved");
    let job_id = approved["jobId"].as_str().unwrap();
    let (status, job) = send(
        &h.router,
        Method::GET,
        &format!("/api/v1/jobs/{job_id}"),
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(job["operationId"], "package.uninstall");
    assert_eq!(job["source"], "mcp");
    assert_eq!(job["requester"], "mcp");

    // Verify /api/v1/audit returns this job with source attribution
    let (status, audit) = send(
        &h.router,
        Method::GET,
        "/api/v1/audit?source=mcp",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let list = audit.as_array().expect("audit must return array");
    assert!(list
        .iter()
        .any(|j| j["id"] == job_id && j["source"] == "mcp"));

    let (status, _) = h
        .post(&format!("/api/v1/approvals/{first_id}/approve"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (status, denied) = h
        .post(&format!("/api/v1/approvals/{second_id}/deny"), json!({}))
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(denied["status"], "denied");
    let (status, _) = h
        .post(&format!("/api/v1/approvals/{second_id}/approve"), json!({}))
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(job_count(&h).await, 1);

    let (_, list) = send(&h.router, Method::GET, "/api/v1/approvals", None, None).await;
    assert_eq!(list.as_array().unwrap().len(), 2);
}

#[tokio::test]
async fn safe_operation_runs_immediately_as_not_required() {
    let h = harness().await;
    let (status, approval) = h
        .post(
            "/api/v1/approvals",
            json!({"operationId": "device.list", "requester": "mcp"}),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED, "{approval}");
    assert_eq!(approval["status"], "not_required");
    assert_eq!(approval["severity"], "low");
    assert!(approval["jobId"].is_string());
    assert_eq!(job_count(&h).await, 1);
}

#[tokio::test]
async fn invalid_requests_are_rejected() {
    let h = harness().await;
    let (status, error) = h
        .post(
            "/api/v1/approvals",
            json!({"operationId": "no.such", "requester": "mcp"}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "UNKNOWN_OPERATION");
    let (status, error) = h
        .post(
            "/api/v1/approvals",
            json!({"operationId": "device.list", "requester": "  "}),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "INVALID_REQUESTER");
    let (status, _) = send(
        &h.router,
        Method::GET,
        "/api/v1/approvals/missing",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn ai_install_routes_require_confirmation() {
    let h = harness().await;
    for route in [
        "/api/v1/ai/mcp/install",
        "/api/v1/ai/mcp/remove",
        "/api/v1/ai/skill/install",
        "/api/v1/ai/skill/remove",
    ] {
        let (status, error) = h.post(route, json!({})).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{route}");
        assert_eq!(error["error"]["code"], "CONFIRMATION_REQUIRED");
    }
    // Status is read-only; the expected MCP entry points at the URL the browser used.
    let (status, ai) = send(&h.router, Method::GET, "/api/v1/ai/status", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        ai["mcp"]["expectedArgs"],
        json!(["mcp", "--server", "http://127.0.0.1:19801"])
    );
    assert!(ai["skill"]["bundledContent"]
        .as_str()
        .unwrap()
        .contains("name: andrui-terminal"));

    // POST /ai/mcp/test returns diagnostic results
    let (status, test_result) = h.post("/api/v1/ai/mcp/test", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    assert!(test_result.get("ok").is_some());
    assert!(test_result.get("latencyMs").is_some());
    assert!(test_result.get("toolCount").is_some());
}

#[tokio::test]
async fn agent_policy_blocks_cross_device_and_stop_denies_pending() {
    let h = harness().await;
    let (status, _) = send(&h.router, Method::PUT, "/api/v1/ai/policy", Some(&h.token), Some(json!({"paused":false,"readOnly":false,"deviceIds":["allowed"],"packages":[],"operationPrefixes":[]}))).await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = send(&h.router, Method::POST, "/api/v1/approvals", Some(&h.token), Some(json!({"requester":"mcp","operationId":"shell.exec","deviceId":"other","parameters":{"command":"echo test"}}))).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (_, pending) = send(&h.router, Method::POST, "/api/v1/approvals", Some(&h.token), Some(json!({"requester":"mcp","operationId":"shell.exec","deviceId":"allowed","parameters":{"command":"echo test"}}))).await;
    assert_eq!(pending["status"], "pending");
    let (status, result) = send(
        &h.router,
        Method::POST,
        "/api/v1/ai/stop",
        Some(&h.token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(result["paused"], true);
    let (_, pending) = send(
        &h.router,
        Method::GET,
        &format!("/api/v1/approvals/{}", pending["id"].as_str().unwrap()),
        None,
        None,
    )
    .await;
    assert_eq!(pending["status"], "denied");
    let (status, _) = send(
        &h.router,
        Method::POST,
        "/api/v1/approvals",
        Some(&h.token),
        Some(json!({"requester":"mcp","operationId":"device.list","parameters":{}})),
    )
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn device_profiles_persist_and_reject_ambiguous_transports() {
    let h = harness().await;
    let profile = json!({"id":"phone","name":"Test phone","kind":"tv","tags":["lab"],"transports":["usb-id","192.0.2.1:5555"],"notes":"Linked explicitly"});
    let (status, _) = send(
        &h.router,
        Method::PUT,
        "/api/v1/device-profiles",
        Some(&h.token),
        Some(json!([profile])),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, profiles) = send(
        &h.router,
        Method::GET,
        "/api/v1/device-profiles",
        None,
        None,
    )
    .await;
    assert_eq!(profiles[0]["name"], "Test phone");
    let (status, _) = send(&h.router, Method::PUT, "/api/v1/device-profiles", Some(&h.token), Some(json!([profile, {"id":"other","name":"Other","kind":"phone","tags":[],"transports":["usb-id"],"notes":""}]))).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (_, unchanged) = send(
        &h.router,
        Method::GET,
        "/api/v1/device-profiles",
        None,
        None,
    )
    .await;
    assert_eq!(unchanged.as_array().unwrap().len(), 1);
}

#[tokio::test]
async fn semantic_mutations_queue_approval_and_require_a_real_helper() {
    let h = harness().await;
    let (status, approval) = send(&h.router, Method::POST, "/api/v1/approvals", Some(&h.token), Some(json!({"requester":"mcp","operationId":"automation.click","deviceId":"test","parameters":{"selector":{"text":"Delete"}}}))).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(approval["status"], "pending");
    assert_eq!(job_count(&h).await, 0);
    let (status, error) = send(
        &h.router,
        Method::POST,
        &format!(
            "/api/v1/approvals/{}/approve",
            approval["id"].as_str().unwrap()
        ),
        Some(&h.token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(error["error"]["code"], "HELPER_UNAVAILABLE");
}

#[tokio::test]
async fn model_gateway_requires_review_and_saves_real_model_output() {
    use axum::routing::{get, post};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}/v1", listener.local_addr().unwrap());
    let model = Router::new().route("/v1/models",get(|| async { axum::Json(json!({"data":[{"id":"test-model"}]})) })).route("/v1/chat/completions",post(|axum::Json(body):axum::Json<Value>| async move {
        assert_eq!(body["model"],"test-model");
        assert_eq!(body["stream"],false);
        assert!(body["messages"][0]["content"].as_str().unwrap().contains("untrusted"));
        axum::Json(json!({"choices":[{"message":{"content":"Evidence shows an example crash; no fix was executed."}}],"usage":{"total_tokens":12}}))
    }));
    let server = tokio::spawn(async move {
        axum::serve(listener, model).await.unwrap();
    });
    let h = harness().await;
    let (status, _) = send(
        &h.router,
        Method::PUT,
        "/api/v1/ai/provider",
        Some(&h.token),
        Some(json!({"endpoint":endpoint,"model":"test-model","apiKeyEnv":""})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, models) = send(
        &h.router,
        Method::POST,
        "/api/v1/ai/provider/test",
        Some(&h.token),
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(models["models"]["data"][0]["id"], "test-model");
    let (status, get_models) = send(
        &h.router,
        Method::GET,
        "/api/v1/ai/provider/models",
        None,
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(get_models["models"]["data"][0]["id"], "test-model");
    let (status, override_models) = send(
        &h.router,
        Method::POST,
        "/api/v1/ai/provider/test",
        Some(&h.token),
        Some(json!({"probe":"models","provider":{"endpoint":endpoint,"model":"","apiKeyEnv":""}})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(override_models["models"]["data"][0]["id"], "test-model");
    let (status, _) = send(
        &h.router,
        Method::POST,
        "/api/v1/ai/provider/test",
        Some(&h.token),
        Some(json!({"probe":"models","provider":{"endpoint":"http://remote.example.com/v1","model":"","apiKeyEnv":""}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, _) = send(
        &h.router,
        Method::POST,
        "/api/v1/ai/assist",
        Some(&h.token),
        Some(json!({"question":"Why?","evidence":{"test":"crash"}})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    let (status, report) = send(
        &h.router,
        Method::POST,
        "/api/v1/ai/assist",
        Some(&h.token),
        Some(json!({"question":"Why?","evidence":{"test":"crash"},"confirmed":true})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(report["answer"]
        .as_str()
        .unwrap()
        .contains("no fix was executed"));
    let (_, saved) = send(
        &h.router,
        Method::GET,
        &format!("/api/v1/reports/{}", report["id"].as_str().unwrap()),
        None,
        None,
    )
    .await;
    assert_eq!(saved["evidence"], json!({"test":"crash"}));
    assert_eq!(job_count(&h).await, 0);
    server.abort();
}

#[tokio::test]
async fn workflow_reports_fail_on_assertions_even_when_command_succeeds() {
    let h = harness().await;
    let (status,wf) = send(&h.router,Method::POST,"/api/v1/workflows",Some(&h.token),Some(json!({"name":"Assertion check","steps":[{"operationId":"shell.exec","parameters":{"command":"echo hello"},"assertion":{"kind":"stdout_contains","value":"this does not occur"}},{"operationId":"shell.exec","parameters":{"command":"echo second"}}]}))).await;
    assert_eq!(status, StatusCode::CREATED);
    let (status, run) = send(
        &h.router,
        Method::POST,
        &format!("/api/v1/workflows/{}/run", wf["id"].as_str().unwrap()),
        Some(&h.token),
        Some(json!({"deviceIds":["first","second"]})),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (_, report) = send(
        &h.router,
        Method::GET,
        &format!("/api/v1/workflow-runs/{}", run["runId"].as_str().unwrap()),
        None,
        None,
    )
    .await;
    assert_eq!(report["status"], "failed");
    assert_eq!(report["steps"][0]["assertionPassed"], false);
    assert_eq!(report["steps"][1]["status"], "skipped");
    assert_eq!(run["jobIds"].as_array().unwrap().len(), 2);
}

async fn completed(manager: &JobManager, id: &str) -> andrui_core::models::Job {
    for _ in 0..200 {
        let job = manager.get_job(id).await.unwrap();
        if !matches!(
            job.status,
            andrui_core::models::JobStatus::Queued | andrui_core::models::JobStatus::Running
        ) {
            return job;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("Job did not finish");
}

#[tokio::test]
async fn semantic_jobs_execute_real_helper_protocol_and_assertions() {
    use andrui_core::automation::{state::AutomationSession, ExtensionsConfig};
    use std::sync::Arc;
    let dir = TempDir::new().unwrap();
    let adb = dir.path().join("adb");
    fs::write(&adb, FAKE_ADB).unwrap();
    fs::set_permissions(&adb, Permissions::from_mode(0o755)).unwrap();
    let automation = andrui_core::automation::AppState::new(ExtensionsConfig {
        adb_path: adb.clone(),
        data_dir: dir.path().into(),
        helper_apk: None,
    });
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let server = tokio::spawn(async move {
        axum::serve(listener,Router::new().route("/actions",axum::routing::post(|headers:axum::http::HeaderMap, axum::Json(body):axum::Json<Value>|async move {
        assert_eq!(headers.get("X-Andrui-Token").unwrap(),"test-token");
        assert_eq!(body["selector"]["resourceId"],"com.example:id/button");
        axum::Json(json!({"success":true,"action":body["action"],"matched":body["action"]!="assert"}))
    }))).await.unwrap();
    });
    let lock = automation.get_device_startup_lock("test-device").await;
    automation.sessions.write().await.insert(
        "session".into(),
        Arc::new(AutomationSession {
            id: "session".into(),
            device_id: "test-device".into(),
            token: "test-token".into(),
            host_port: port,
            helper_version: "0.1.0".into(),
            created_at: 0,
            child: tokio::sync::Mutex::new(None),
            action_lock: lock,
        }),
    );
    automation
        .device_sessions
        .write()
        .await
        .insert("test-device".into(), "session".into());
    let manager = JobManager::new(AdbExecutor::new(adb), Database::in_memory().unwrap())
        .with_device_locks(automation.device_startup_locks.clone())
        .with_automation(automation);
    for (action, status) in [("click", "completed"), ("assert", "failed")] {
        let job=manager.create_job(serde_json::from_value(json!({"operationId":format!("automation.{action}"),"deviceId":"test-device","parameters":{"selector":"{\"resourceId\":\"com.example:id/button\"}"}})).unwrap()).await.unwrap();
        let result = completed(&manager, &job.id).await;
        assert_eq!(result.status.as_str(), status);
        assert!(result.stdout.contains(action));
    }
    server.abort();
}

#[tokio::test]
async fn pulls_and_bugreports_become_real_browser_artifacts() {
    let dir = TempDir::new().unwrap();
    let db = Database::in_memory().unwrap();
    let artifacts = ArtifactStore::new(dir.path());
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
    let manager =
        JobManager::new(AdbExecutor::new(fake), db.clone()).with_artifacts(artifacts.clone());
    for (operation, params, name) in [
        (
            "file.pull",
            json!({"remote":"/sdcard/a file.txt"}),
            "a file.txt",
        ),
        ("diagnostics.bugreport", json!({}), "bugreport.zip"),
    ] {
        let job = manager
            .create_job(
                serde_json::from_value(
                    json!({"operationId":operation,"deviceId":"emulator-5554","parameters":params}),
                )
                .unwrap(),
            )
            .await
            .unwrap();
        let result = completed(&manager, &job.id).await;
        assert_eq!(result.status.as_str(), "completed", "{:?}", result.error);
        assert_eq!(result.artifact_ids.len(), 1);
        let meta = db.get_artifact(&result.artifact_ids[0]).unwrap().unwrap();
        assert_eq!(meta.name, name);
        assert!(meta.size > 0);
        assert!(!artifacts.read_artifact(&meta.id).await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn failed_capture_does_not_publish_empty_artifact() {
    let dir = TempDir::new().unwrap();
    let adb = dir.path().join("adb");
    fs::write(&adb, FAKE_ADB).unwrap();
    fs::set_permissions(&adb, Permissions::from_mode(0o755)).unwrap();
    let db = Database::in_memory().unwrap();
    let manager = JobManager::new(AdbExecutor::new(adb), db.clone())
        .with_artifacts(ArtifactStore::new(dir.path()));
    let job=manager.create_job(serde_json::from_value(json!({"operationId":"file.pull","deviceId":"test","parameters":{"remote":"/sdcard/test"}})).unwrap()).await.unwrap();
    let result = completed(&manager, &job.id).await;
    assert_eq!(result.status.as_str(), "failed");
    assert!(result.artifact_ids.is_empty());
    assert!(db.list_artifacts().unwrap().is_empty());
}

#[tokio::test]
async fn cancelling_a_workflow_stops_following_steps_and_records_the_outcome() {
    let dir = TempDir::new().unwrap();
    let db = Database::in_memory().unwrap();
    let fake = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
    let manager = JobManager::new(AdbExecutor::new(fake), db.clone())
        .with_artifacts(ArtifactStore::new(dir.path()));
    let runner = WorkflowRunner::new(manager, db.clone());
    let workflow:andrui_core::models::Workflow=serde_json::from_value(json!({"id":"cancel-test","name":"Cancellation","steps":[{"operationId":"shell.exec","parameters":{"command":"sleep 20"}},{"operationId":"shell.exec","parameters":{"command":"echo should-not-run"}}]})).unwrap();
    db.insert_workflow(&workflow).unwrap();
    let task_runner = runner.clone();
    let task = tokio::spawn(async move {
        task_runner
            .run_recorded("cancel-test", &["emulator-5554".into()], false)
            .await
    });
    let run_id = loop {
        let ids: Vec<String> = db.read_value("experience.workflow-runs").unwrap();
        if let Some(id) = ids.first() {
            break id.clone();
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    };
    runner.cancel(&run_id).await.unwrap();
    tokio::time::timeout(std::time::Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    let report: Value = db.read_value(&format!("experience.run.{run_id}")).unwrap();
    assert_eq!(report["status"], "cancelled");
    assert_ne!(report["steps"][1]["status"], "completed");
}

#[tokio::test]
async fn coordinate_input_cannot_bypass_semantic_approval() {
    let h = harness().await;
    let (status, approval) = h.post("/api/v1/approvals",json!({"requester":"mcp","operationId":"input.tap","deviceId":"test","parameters":{"x":10,"y":20}})).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(approval["status"], "pending");
    assert_eq!(job_count(&h).await, 0);
    let (status, _) = h.post("/api/v1/approvals",json!({"requester":"mcp","operationId":"logcat.dump","deviceId":"test","parameters":{"filter":"-c"}})).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(job_count(&h).await, 0);
}

#[tokio::test]
async fn full_auto_mode_runs_all_mcp_operations_without_approval() {
    let h = harness().await;
    let (status, saved) = send(
        &h.router,
        Method::PUT,
        "/api/v1/ai/policy",
        Some(&h.token),
        Some(json!({
            "paused": false,
            "readOnly": false,
            "autoApprove": true,
            "deviceIds": [],
            "packages": [],
            "operationPrefixes": []
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(saved["autoApprove"], true);

    let (status, approval) = h
        .post(
            "/api/v1/approvals",
            json!({
                "requester": "mcp",
                "operationId": "package.uninstall",
                "deviceId": "test",
                "parameters": { "package": "com.example" }
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(approval["status"], "not_required");
    assert!(approval["jobId"].as_str().is_some());
    assert_eq!(job_count(&h).await, 1);

    let (status, _) = h.post("/api/v1/ai/stop", json!({})).await;
    assert_eq!(status, StatusCode::OK);
    let (status, policy) = send(&h.router, Method::GET, "/api/v1/ai/policy", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(policy["paused"], true);
    assert_eq!(policy["autoApprove"], false);
}

#[tokio::test]
async fn non_approval_mcp_requests_are_recorded_in_execution_queue() {
    let h = harness().await;
    let (status, recorded) = h
        .post(
            "/api/v1/approvals/record",
            json!({
                "requester": "mcp",
                "operationId": "android_list_devices",
                "operationLabel": "List Devices",
                "parameters": {},
                "display": "mcp android_list_devices"
            }),
        )
        .await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(recorded["status"], "not_required");

    let (status, list) = send(&h.router, Method::GET, "/api/v1/approvals", None, None).await;
    assert_eq!(status, StatusCode::OK);
    assert!(list
        .as_array()
        .unwrap()
        .iter()
        .any(|item| item["operationId"] == "android_list_devices" && item["status"] == "not_required"));
}
