use axum::{
    body::Body,
    http::{header, Method, Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::json;
use std::{
    fs::{self, Permissions},
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    time::Duration,
};
use tempfile::TempDir;
use tokio_util::sync::CancellationToken;
use tower::ServiceExt;

use andrui_core::{
    adb::{device_tracker::DeviceTracker, executor::AdbExecutor},
    files::service::FileService,
    jobs::manager::JobManager,
    models::{CreateJobRequest, JobStatus},
    security::session::SessionStore,
    server::{router::create_router, state::AppState},
    shell::manager::ShellManager,
    storage::{artifacts::ArtifactStore, db::Database},
    workflows::runner::WorkflowRunner,
};

fn create_fake_adb(temp_dir: &TempDir) -> PathBuf {
    let script_path = temp_dir.path().join("fake_adb.sh");
    let script = r#"#!/usr/bin/env bash
cmd="$1"
shift

if [ "$cmd" = "help" ]; then
    echo "Android Debug Bridge shell install uninstall devices"
    exit 0
fi

if [ "$cmd" = "version" ]; then
    echo "Android Debug Bridge version 1.0.41"
    echo "Version 34.0.4-debian"
    exit 0
fi

if [ "$cmd" = "devices" ]; then
    echo "List of devices attached"
    echo "emulator-5554          device product:sdk_gphone64_x86_64 model:sdk_gphone64_x86_64 device:emu64x transport_id:1"
    echo "192.168.1.100:5555     offline transport_id:2"
    exit 0
fi

# Handle device targeting -s <dev>
if [ "$cmd" = "-s" ]; then
    dev="$1"
    shift
    cmd="$1"
    shift
fi

if [ "$cmd" = "shell" ]; then
    subcmd="$1"
    if [ "$subcmd" = "fail_cmd" ]; then
        echo "simulated error on stderr" >&2
        exit 42
    elif [ "$subcmd" = "slow_cmd" ]; then
        sleep 5
        echo "done slow"
        exit 0
    elif [ "$subcmd" = "ls" ]; then
        echo "total 8"
        echo "-rw-rw-r-- 1 u0_a100 u0_a100 1234 2024-01-01 12:00 sample.txt"
        exit 0
    else
        echo "shell output for: $subcmd"
        exit 0
    fi
fi

if [ "$cmd" = "install" ]; then
    echo "Success"
    exit 0
fi

if [ "$cmd" = "uninstall" ]; then
    echo "Success"
    exit 0
fi

# Default fallback
echo "fake adb ran cmd: $cmd $@"
exit 0
"#;

    fs::write(&script_path, script).expect("Failed to write fake adb script");
    fs::set_permissions(&script_path, Permissions::from_mode(0o755))
        .expect("Failed to make script executable");
    script_path
}

#[tokio::test]
async fn test_fake_adb_executor_output_and_nonzero_exit() {
    let temp_dir = TempDir::new().unwrap();
    let adb_path = create_fake_adb(&temp_dir);
    let executor = AdbExecutor::new(&adb_path);

    // 1. Test version query
    let ver = executor.get_version().await.unwrap();
    assert_eq!(ver, "Version 34.0.4-debian");

    // 2. Test successful execution
    let out = executor
        .execute(
            &["shell".to_string(), "hello".to_string()],
            Some(Duration::from_secs(5)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(out.exit_code, 0);
    assert!(out.stdout.contains("shell output for: hello"));
    assert!(out.stderr.is_empty());

    // 3. Test failure command with nonzero exit code and stderr
    let fail_out = executor
        .execute(
            &["shell".to_string(), "fail_cmd".to_string()],
            Some(Duration::from_secs(5)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(fail_out.exit_code, 42);
    assert!(fail_out.stderr.contains("simulated error on stderr"));

    // 4. Test timeout
    let timeout_res = executor
        .execute(
            &["shell".to_string(), "slow_cmd".to_string()],
            Some(Duration::from_millis(150)),
            None,
        )
        .await;
    assert!(timeout_res.is_err());

    // 5. Test cancellation
    let cancel_token = CancellationToken::new();
    let ct_clone = cancel_token.clone();
    tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        ct_clone.cancel();
    });

    let cancel_res = executor
        .execute(
            &["shell".to_string(), "slow_cmd".to_string()],
            Some(Duration::from_secs(10)),
            Some(cancel_token),
        )
        .await;
    assert!(cancel_res.is_err());
}

#[tokio::test]
async fn test_job_lifecycle_and_device_mutation_locks() {
    let temp_dir = TempDir::new().unwrap();
    let adb_path = create_fake_adb(&temp_dir);
    let db = Database::in_memory().unwrap();
    let executor = AdbExecutor::new(&adb_path);
    let manager = JobManager::new(executor, db);

    // 1. Destructive operation without confirmation must be rejected
    let mut req_destructive = CreateJobRequest {
        operation_id: "package.uninstall".to_string(),
        device_id: Some("emulator-5554".to_string()),
        parameters: {
            let mut m = serde_json::Map::new();
            m.insert("package".to_string(), json!("com.example.test"));
            m
        },
        confirmed: Some(false),
        source: None,
        requester: None,
    };
    let err = manager.create_job(req_destructive.clone()).await;
    assert!(err.is_err(), "Must reject unconfirmed destructive job");

    // 2. Destructive operation with confirmed: true proceeds
    req_destructive.confirmed = Some(true);
    let job = manager.create_job(req_destructive).await.unwrap();
    assert_eq!(job.status, JobStatus::Queued);

    // Wait for job to finish
    let mut finished_job = job;
    for _ in 0..50 {
        tokio::time::sleep(Duration::from_millis(50)).await;
        finished_job = manager.get_job(&finished_job.id).await.unwrap();
        if finished_job.status != JobStatus::Queued && finished_job.status != JobStatus::Running {
            break;
        }
    }
    assert_eq!(finished_job.status, JobStatus::Completed);
    assert_eq!(finished_job.exit_code, Some(0));
}

#[tokio::test]
async fn test_security_middleware_and_api_contract() {
    let temp_dir = TempDir::new().unwrap();
    let adb_path = create_fake_adb(&temp_dir);
    let db = Database::in_memory().unwrap();
    let executor = AdbExecutor::new(&adb_path);
    let device_tracker = DeviceTracker::new(executor.clone());
    let job_manager = JobManager::new(executor.clone(), db.clone());
    let artifact_store = ArtifactStore::new(temp_dir.path());
    let shell_manager = ShellManager::new(adb_path);
    let file_service = FileService::new(executor.clone());
    let workflow_runner = WorkflowRunner::new(job_manager.clone(), db.clone());
    let session_store = SessionStore::new();

    let state = AppState {
        emulators: andrui_core::emulators::EmulatorManager::default(),
        automation: None,
        media: None,
        mode: "native".to_string(),
        version: "0.1.0".to_string(),
        adb_executor: executor,
        device_tracker,
        discovery: andrui_core::adb::discovery::DeviceDiscovery::start(),
        job_manager,
        artifact_store,
        db_snapshots: andrui_core::inspect::database::DbSnapshotStore::new(temp_dir.path()),
        db,
        shell_manager,
        file_service,
        workflow_runner,
        session_store: session_store.clone(),
        approvals: andrui_core::approvals::ApprovalStore::new(),
        web_dir: None,
    };

    let router = create_router(state);

    // 1. GET /api/v1/health succeeds without session or csrf
    let req = Request::builder()
        .header(header::HOST, "localhost:8080")
        .uri("/api/v1/health")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let health_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(health_json["status"], "ok");

    // 2. GET /api/v1/session issues a csrfToken and sets cookie
    let req = Request::builder()
        .header(header::HOST, "localhost:8080")
        .uri("/api/v1/session")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let cookie_header = res
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap();
    assert!(cookie_header.contains("andrui_session="));
    let body = res.into_body().collect().await.unwrap().to_bytes();
    let session_json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let csrf_token = session_json["csrfToken"].as_str().unwrap().to_string();
    assert!(!csrf_token.is_empty());

    // 3. Mutating request (POST /api/v1/jobs) WITHOUT X-CSRF-Token is rejected with 403
    let req = Request::builder()
        .header(header::HOST, "localhost:8080")
        .method(Method::POST)
        .uri("/api/v1/jobs")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            json!({
                "operationId": "device.list"
            })
            .to_string(),
        ))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // 4. Mutating request WITH X-CSRF-Token succeeds
    let req = Request::builder()
        .header(header::HOST, "localhost:8080")
        .method(Method::POST)
        .uri("/api/v1/jobs")
        .header(header::CONTENT_TYPE, "application/json")
        .header("X-CSRF-Token", &csrf_token)
        .header(header::COOKIE, format!("andrui_session={}", csrf_token))
        .body(Body::from(
            json!({
                "operationId": "device.list"
            })
            .to_string(),
        ))
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::ACCEPTED);

    // 5. Untrusted external origin is rejected
    let req = Request::builder()
        .header(header::HOST, "localhost:8080")
        .uri("/api/v1/devices")
        .header(header::ORIGIN, "http://malicious-attacker.com")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::FORBIDDEN);

    // 6. Trusted origin succeeds
    let req = Request::builder()
        .header(header::HOST, "localhost:8080")
        .uri("/api/v1/devices")
        .header(header::ORIGIN, "http://localhost:8080")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_artifact_path_traversal_prevention() {
    let temp_dir = TempDir::new().unwrap();
    let store = ArtifactStore::new(temp_dir.path());
    store.init().await.unwrap();

    // 1. Normal save and read
    let art = store
        .save_artifact("test.txt", "text/plain", b"hello world")
        .await
        .unwrap();
    assert_eq!(art.name, "test.txt");
    assert_eq!(art.size, 11);

    let bytes = store.read_artifact(&art.id).await.unwrap();
    assert_eq!(bytes, b"hello world");

    // 2. Path traversal attack in ID must be rejected
    assert!(store.read_artifact("../../../etc/passwd").await.is_err());
    assert!(store
        .read_artifact("..\\..\\windows\\win.ini")
        .await
        .is_err());
    assert!(store.read_artifact("sub/folder").await.is_err());
    assert!(store.read_artifact("").await.is_err());
}

#[tokio::test]
async fn test_csrf_cookie_binding_and_websocket_origin() {
    use andrui_core::security::middleware::security_middleware;
    use axum::{middleware, routing::get, Router};
    let sessions = SessionStore::new();
    let token = sessions.create_session();
    let router = Router::new()
        .route("/test", get(|| async { "ok" }).post(|| async { "ok" }))
        .layer(middleware::from_fn(move |request, next| {
            security_middleware(sessions.clone(), request, next)
        }));
    for cookie in ["".to_string(), "andrui_session=wrong".to_string()] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/test")
                    .header(header::HOST, "localhost:8080")
                    .header("X-CSRF-Token", &token)
                    .header(header::COOKIE, cookie)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    for origin in ["http://localhost:9999", "http://localhost.evil", "null"] {
        let response = router
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/test")
                    .header(header::HOST, "localhost:8080")
                    .header(header::ORIGIN, origin)
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::FORBIDDEN);
    }
    let response = router
        .oneshot(
            Request::builder()
                .uri("/test")
                .header(header::HOST, "localhost:8080")
                .header(header::UPGRADE, "websocket")
                .header(header::COOKIE, format!("andrui_session={token}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn test_large_output_is_not_dropped() {
    let temp_dir = TempDir::new().unwrap();
    let script = temp_dir.path().join("burst-adb");
    fs::write(&script, "#!/usr/bin/env python3\nimport sys\nsys.stdout.write('x'*2000000)\nsys.stderr.write('y'*1500000)\nsys.exit(37)\n").unwrap();
    fs::set_permissions(&script, Permissions::from_mode(0o755)).unwrap();
    let output = AdbExecutor::new("/usr/bin/python3")
        .execute(
            &[script.to_string_lossy().into_owned()],
            Some(Duration::from_secs(5)),
            None,
        )
        .await
        .unwrap();
    assert_eq!(output.stdout, "x".repeat(2000000));
    assert_eq!(output.stderr, "y".repeat(1500000));
    assert_eq!(output.exit_code, 37);
}

#[test]
fn test_unknown_assertion_fails_closed() {
    use andrui_core::models::{Assertion, Job};
    let job: Job = serde_json::from_value(json!({"id":"test", "operationId":"shell.exec", "status":"completed", "stdout":"", "stderr":"", "createdAt":"now", "artifactIds":[]})).unwrap();
    assert!(!WorkflowRunner::evaluate_assertion(
        &Assertion {
            kind: "invented".into(),
            value: None
        },
        &job
    ));
    assert!(!WorkflowRunner::evaluate_assertion(
        &Assertion {
            kind: "exit_code_equals".into(),
            value: None
        },
        &job
    ));
}

#[tokio::test]
async fn test_queued_job_cancels_while_shared_device_lock_is_held() {
    use std::collections::HashMap;
    use std::sync::Arc;
    let temporary = TempDir::new().unwrap();
    let locks = Arc::new(tokio::sync::Mutex::new(HashMap::new()));
    let device_lock = Arc::new(tokio::sync::Mutex::new(()));
    locks
        .lock()
        .await
        .insert("dev1".to_string(), device_lock.clone());
    let _guard = device_lock.lock().await;
    let manager = JobManager::new(
        AdbExecutor::new(create_fake_adb(&temporary)),
        Database::in_memory().unwrap(),
    )
    .with_device_locks(locks);
    let job = manager
        .create_job(CreateJobRequest {
            operation_id: "shell.exec".into(),
            device_id: Some("dev1".into()),
            parameters: json!({"command":"hello"}).as_object().unwrap().clone(),
            confirmed: None,
            source: None,
            requester: None,
        })
        .await
        .unwrap();
    manager.cancel_job(&job.id).await.unwrap();
    tokio::time::timeout(Duration::from_secs(1), async {
        loop {
            let job = manager.get_job(&job.id).await.unwrap();
            if job.status == JobStatus::Cancelled {
                assert!(job.started_at.is_none());
                assert!(job.stdout.is_empty());
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("Queued cancellation must not wait for the held device lock");
}

#[tokio::test]
async fn test_run_native_server_rejects_non_loopback_bind() {
    use andrui_core::error::ApiError;
    use andrui_core::server::native::run_native_server;

    let temp_dir = TempDir::new().unwrap();
    let adb_path = create_fake_adb(&temp_dir);
    let executor = AdbExecutor::new(&adb_path);
    let db = Database::in_memory().unwrap();
    let job_manager = JobManager::new(executor.clone(), db.clone());
    let artifact_store = ArtifactStore::new(temp_dir.path());
    let shell_manager = ShellManager::new(adb_path);
    let file_service = FileService::new(executor.clone());
    let device_tracker = DeviceTracker::new(executor.clone());
    let workflow_runner = WorkflowRunner::new(job_manager.clone(), db.clone());
    let session_store = SessionStore::new();

    let state = AppState {
        emulators: andrui_core::emulators::EmulatorManager::default(),
        automation: None,
        media: None,
        mode: "native".to_string(),
        version: "0.1.0".to_string(),
        adb_executor: executor,
        device_tracker,
        discovery: andrui_core::adb::discovery::DeviceDiscovery::start(),
        job_manager,
        artifact_store,
        db_snapshots: andrui_core::inspect::database::DbSnapshotStore::new(temp_dir.path()),
        db,
        shell_manager,
        file_service,
        workflow_runner,
        session_store,
        approvals: andrui_core::approvals::ApprovalStore::new(),
        web_dir: None,
    };

    let non_loopback = "0.0.0.0:19801".parse::<std::net::SocketAddr>().unwrap();
    let res = run_native_server(non_loopback, state).await;
    assert!(res.is_err());
    match res.unwrap_err() {
        ApiError::BadRequest { code, .. } => assert_eq!(code, "NON_LOOPBACK_BIND_REJECTED"),
        other => panic!(
            "Expected BadRequest NON_LOOPBACK_BIND_REJECTED, got {:?}",
            other
        ),
    }
}

#[tokio::test]
async fn test_job_listing_pagination_and_output_truncation() {
    use andrui_core::models::Job;
    let temp_dir = TempDir::new().unwrap();
    let adb_path = create_fake_adb(&temp_dir);
    let executor = AdbExecutor::new(&adb_path);
    let db = Database::in_memory().unwrap();
    let job_manager = JobManager::new(executor.clone(), db.clone());
    let artifact_store = ArtifactStore::new(temp_dir.path());
    let shell_manager = ShellManager::new(adb_path);
    let file_service = FileService::new(executor.clone());
    let device_tracker = DeviceTracker::new(executor.clone());
    let workflow_runner = WorkflowRunner::new(job_manager.clone(), db.clone());
    let session_store = SessionStore::new();

    let state = AppState {
        emulators: andrui_core::emulators::EmulatorManager::default(),
        automation: None,
        media: None,
        mode: "native".to_string(),
        version: "0.1.0".to_string(),
        adb_executor: executor,
        device_tracker,
        discovery: andrui_core::adb::discovery::DeviceDiscovery::start(),
        job_manager,
        artifact_store,
        db_snapshots: andrui_core::inspect::database::DbSnapshotStore::new(temp_dir.path()),
        db: db.clone(),
        shell_manager,
        file_service,
        workflow_runner,
        session_store: session_store.clone(),
        approvals: andrui_core::approvals::ApprovalStore::new(),
        web_dir: None,
    };

    let router = create_router(state);

    // Insert 5 jobs with large output (2000 chars)
    let large_text = "x".repeat(2000);
    for i in 0..5 {
        let job = Job {
            id: format!("job-{}", i),
            operation_id: "shell.exec".to_string(),
            device_id: Some("dev1".to_string()),
            status: JobStatus::Completed,
            stdout: format!("{}-{}", i, large_text),
            stderr: String::new(),
            exit_code: Some(0),
            created_at: format!("2026-01-0{}T00:00:00Z", i + 1),
            started_at: None,
            finished_at: None,
            artifact_ids: vec![],
            error: None,
            source: "gui".to_string(),
            requester: None,
        };
        db.insert_job(&job).unwrap();
    }

    // 1. Default list pagination (limit=2)
    let req = Request::builder()
        .header(header::HOST, "127.0.0.1:8080")
        .uri("/api/v1/jobs?limit=2")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    assert_eq!(res.headers().get("X-Total-Count").unwrap(), "5");
    let body = axum::body::to_bytes(res.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let jobs: Vec<Job> = serde_json::from_slice(&body).unwrap();
    assert_eq!(jobs.len(), 2);
    // Ordered by created_at DESC (job-4, job-3)
    assert_eq!(jobs[0].id, "job-4");
    assert_eq!(jobs[1].id, "job-3");
    // stdout is truncated to 1024 bytes
    assert_eq!(jobs[0].stdout.len(), 1024);

    // 2. Offset pagination (offset=2, limit=2)
    let req = Request::builder()
        .header(header::HOST, "127.0.0.1:8080")
        .uri("/api/v1/jobs?limit=2&offset=2")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let jobs: Vec<Job> = serde_json::from_slice(&body).unwrap();
    assert_eq!(jobs.len(), 2);
    assert_eq!(jobs[0].id, "job-2");
    assert_eq!(jobs[1].id, "job-1");

    // 3. Full job details endpoint GET /jobs/{id} returns untruncated stdout (2002 chars)
    let req = Request::builder()
        .header(header::HOST, "127.0.0.1:8080")
        .uri("/api/v1/jobs/job-4")
        .body(Body::empty())
        .unwrap();
    let res = router.clone().oneshot(req).await.unwrap();
    assert_eq!(res.status(), StatusCode::OK);
    let body = axum::body::to_bytes(res.into_body(), 1024 * 1024)
        .await
        .unwrap();
    let job: Job = serde_json::from_slice(&body).unwrap();
    assert_eq!(job.id, "job-4");
    assert_eq!(job.stdout.len(), 2002);
}
