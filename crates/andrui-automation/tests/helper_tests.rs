//! Helper status, install, checks, and screenshot secure-report integration tests (fake adb + mock helper).

use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;

use andrui_automation::{
    router_with_state,
    state::{AppState, AutomationSession},
    ExtensionsConfig,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
    routing::get,
    Json, Router,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower::ServiceExt;

const TOKEN: &str = "test_token_12345678901234567890";
const PNG_1X1: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";

/// Writes a fake adb that answers the read-only helper status/check commands.
fn write_fake_adb(dir: &TempDir, apk_sha: &str, wchan: &str) -> PathBuf {
    let path = dir.path().join("fake_adb.sh");
    let script = format!(
        r#"#!/bin/sh
# args: -s <device> <subcommand> [command]
if [ "$3" = "install" ] || [ "$3" = "uninstall" ]; then echo "Success"; exit 0; fi
case "$4" in
  "pm list packages io.andrui.terminal.helper") echo "package:io.andrui.terminal.helper" ;;
  "dumpsys package io.andrui.terminal.helper") printf '    versionCode=2 minSdk=23 targetSdk=34\n    versionName=0.2.0\n' ;;
  "pm path io.andrui.terminal.helper") echo "package:/data/app/~~abc==/io.andrui.terminal.helper-x_y==/base.apk" ;;
  sha256sum*) echo "{sha}  /data/app/base.apk" ;;
  "dumpsys deviceidle whitelist") printf 'system,com.android.shell,2000\nuser,io.andrui.terminal.helper,10428\n' ;;
  "am get-standby-bucket io.andrui.terminal.helper") echo 10 ;;
  "pidof io.andrui.terminal.helper") echo 4242 ;;
  run-as*) printf '{wchan}' ;;
  *) echo "unexpected: $4" >&2; exit 1 ;;
esac
"#,
        sha = apk_sha,
        wchan = wchan
    );
    let tmp = dir.path().join("fake_adb.tmp");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).unwrap();
        file.write_all(script.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(&tmp, &path).unwrap();
    path
}

async fn spawn_helper(screenshot: Value, screenshot_status: StatusCode) -> SocketAddr {
    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(json!({
                    "version": "0.2.0", "protocolVersion": 1, "sdk": 36,
                    "capabilities": ["hierarchy", "screenshot", "window-metadata", "secure-window-detection", "keep-alive"]
                }))
            }),
        )
        .route(
            "/hierarchy",
            get(|| async {
                Json(json!({
                    "xml": "<hierarchy><node display-id=\"0\" window-id=\"5\" window-type=\"application\"><node/></node><node display-id=\"0\" window-id=\"6\" window-type=\"system\"/></hierarchy>",
                    "capturedAt": 1
                }))
            }),
        )
        .route(
            "/screenshot",
            get(move || {
                let body = screenshot.clone();
                async move { (screenshot_status, Json(body)) }
            }),
        );
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

async fn state_with(
    dir: &TempDir,
    adb: PathBuf,
    apk: PathBuf,
    helper: Option<SocketAddr>,
) -> AppState {
    let state = AppState::new(ExtensionsConfig {
        adb_path: adb,
        data_dir: dir.path().to_path_buf(),
        helper_apk: Some(apk),
    });
    if let Some(addr) = helper {
        let session = Arc::new(AutomationSession {
            id: "sess-1".into(),
            device_id: "dev1".into(),
            token: TOKEN.into(),
            host_port: addr.port(),
            helper_version: "0.2.0".into(),
            created_at: 1,
            child: Mutex::new(None),
            action_lock: Arc::new(Mutex::new(())),
        });
        state
            .sessions
            .write()
            .await
            .insert("sess-1".into(), session);
        state
            .device_sessions
            .write()
            .await
            .insert("dev1".into(), "sess-1".into());
    }
    state
}

fn write_apk(dir: &TempDir) -> (PathBuf, String) {
    let apk = dir.path().join("helper.apk");
    std::fs::write(&apk, b"fake_apk_bytes").unwrap();
    let sha = Sha256::digest(b"fake_apk_bytes")
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect();
    (apk, sha)
}

async fn get_json(state: AppState, uri: &str) -> (StatusCode, Value) {
    let resp = router_with_state(state)
        .oneshot(Request::builder().uri(uri).body(Body::empty()).unwrap())
        .await
        .unwrap();
    let status = resp.status();
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    (status, serde_json::from_slice(&body).unwrap())
}

fn status_of<'a>(checks: &'a Value, id: &str) -> &'a str {
    checks["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == id)
        .unwrap_or_else(|| panic!("missing check {}", id))["status"]
        .as_str()
        .unwrap()
}

#[tokio::test]
async fn status_reports_install_version_and_hash_match() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "do_epoll_wait\n");
    let state = state_with(&dir, adb, apk, None).await;

    let (status, body) = get_json(state, "/api/v1/automation/helper/status?deviceId=dev1").await;
    assert_eq!(status, StatusCode::OK, "{}", body);
    assert_eq!(body["installed"], true);
    assert_eq!(body["versionCode"], 2);
    assert_eq!(body["versionName"], "0.2.0");
    assert_eq!(body["installedSha256"], sha);
    assert_eq!(body["upToDate"], true);
    assert!(body["session"].is_null());
}

#[tokio::test]
async fn status_detects_outdated_install() {
    let dir = TempDir::new().unwrap();
    let (apk, _) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &"0".repeat(64), "do_epoll_wait\n");
    let state = state_with(&dir, adb, apk, None).await;

    let (_, body) = get_json(state, "/api/v1/automation/helper/status?deviceId=dev1").await;
    assert_eq!(body["upToDate"], false);
}

#[tokio::test]
async fn checks_pass_live_and_flag_visible_secure_window() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "do_epoll_wait\\nfutex_wait_queue\\n");
    let helper = spawn_helper(
        json!({"contentType": "image/png", "base64": PNG_1X1,
               "secure": {"detection": "dumpsys", "visibleSecureWindow": true,
                          "windows": [{"title": "bank/.Home", "visible": true}]}}),
        StatusCode::OK,
    )
    .await;
    let state = state_with(&dir, adb, apk, Some(helper)).await;

    let (status, body) = get_json(state, "/api/v1/automation/helper/checks?deviceId=dev1").await;
    assert_eq!(status, StatusCode::OK, "{}", body);
    for id in [
        "host_apk",
        "installed",
        "up_to_date",
        "power_save",
        "session",
        "not_frozen",
        "health",
        "hierarchy",
    ] {
        assert_eq!(status_of(&body, id), "pass", "check {} in {}", id, body);
    }
    assert_eq!(status_of(&body, "screenshot"), "warn");
    assert_eq!(body["overall"], "warn");
    let shot = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "screenshot")
        .unwrap();
    assert!(shot["detail"].as_str().unwrap().contains("bank/.Home"));
}

#[tokio::test]
async fn checks_fail_and_skip_live_checks_when_frozen() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(
        &dir,
        &sha,
        "__refrigerator\\n__refrigerator\\nbinder_thread_read\\n",
    );
    let helper = spawn_helper(json!({}), StatusCode::OK).await;
    let state = state_with(&dir, adb, apk, Some(helper)).await;

    let (_, body) = get_json(state, "/api/v1/automation/helper/checks?deviceId=dev1").await;
    assert_eq!(status_of(&body, "not_frozen"), "fail");
    let frozen = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "not_frozen")
        .unwrap();
    assert!(frozen["detail"].as_str().unwrap().contains("2 of 3"));
    assert!(frozen["guidance"].as_str().unwrap().contains("App launch"));
    for id in ["health", "hierarchy", "screenshot"] {
        assert_eq!(status_of(&body, id), "skip");
    }
    assert_eq!(body["overall"], "fail");
}

#[tokio::test]
async fn checks_without_session_skip_live_checks() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "");
    let state = state_with(&dir, adb, apk, None).await;

    let (_, body) = get_json(state, "/api/v1/automation/helper/checks?deviceId=dev1").await;
    assert_eq!(status_of(&body, "session"), "skip");
    for id in ["not_frozen", "health", "hierarchy", "screenshot"] {
        assert_eq!(status_of(&body, id), "skip");
    }
    // Nothing failed or warned, but live checks did not run: neither a warning nor a pass.
    assert_eq!(body["overall"], "incomplete");
}

/// Rewrites the fake adb's power-state answers: whitelist line and standby bucket atomically.
fn set_power_state(adb: &PathBuf, whitelist: &str, bucket: u32) {
    let script = std::fs::read_to_string(adb)
        .unwrap()
        .replace(
            "'system,com.android.shell,2000\\nuser,io.andrui.terminal.helper,10428\\n'",
            &format!("'{}'", whitelist),
        )
        .replace("echo 10 ;;", &format!("echo {} ;;", bucket));
    let tmp = adb.with_file_name(format!("fake_adb_{}.tmp", bucket));
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&tmp).unwrap();
        file.write_all(script.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o755)).unwrap();
    std::fs::rename(&tmp, adb).unwrap();
}

#[tokio::test]
async fn power_save_passes_when_not_exempt_and_warns_only_when_restricted() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "");

    // Battery optimization on (helper not in the whitelist), bucket active: informational pass.
    set_power_state(&adb, "system,com.android.shell,2000\\n", 10);
    let state = state_with(&dir, adb.clone(), apk.clone(), None).await;
    let (_, body) = get_json(state, "/api/v1/automation/helper/checks?deviceId=dev1").await;
    assert_eq!(status_of(&body, "power_save"), "pass", "{}", body);
    let power = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "power_save")
        .unwrap();
    assert!(power["detail"]
        .as_str()
        .unwrap()
        .contains("Battery optimization: on"));
    assert!(power.get("guidance").is_none());

    // Restricted standby bucket: warning with guidance.
    set_power_state(&adb, "system,com.android.shell,2000\\n", 45);
    let state = state_with(&dir, adb, apk, None).await;
    let (_, body) = get_json(state, "/api/v1/automation/helper/checks?deviceId=dev1").await;
    assert_eq!(status_of(&body, "power_save"), "warn");
    assert_eq!(body["overall"], "warn");
}

#[tokio::test]
async fn install_requires_confirmation_then_installs() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "");
    let state = state_with(&dir, adb, apk, None).await;
    let post = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/automation/helper/install")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    let resp = router_with_state(state.clone())
        .oneshot(post(json!({"deviceId": "dev1"})))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "confirmation_required");

    let resp = router_with_state(state)
        .oneshot(post(json!({"deviceId": "dev1", "confirmed": true})))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["installed"], true);
    assert_eq!(body["upToDate"], true);
}

#[tokio::test]
async fn uninstall_requires_confirmation_then_uninstalls() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "");
    let state = state_with(&dir, adb, apk, None).await;
    let post = |body: Value| {
        Request::builder()
            .method("POST")
            .uri("/api/v1/automation/helper/uninstall")
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };

    let resp = router_with_state(state.clone())
        .oneshot(post(json!({"deviceId": "dev1"})))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "confirmation_required");

    let resp = router_with_state(state)
        .oneshot(post(json!({"deviceId": "dev1", "confirmed": true})))
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn screenshot_exposes_secure_headers_and_typed_errors() {
    let dir = TempDir::new().unwrap();
    let (apk, sha) = write_apk(&dir);
    let adb = write_fake_adb(&dir, &sha, "");

    let helper = spawn_helper(
        json!({"contentType": "image/png", "base64": PNG_1X1,
               "secure": {"detection": "dumpsys", "visibleSecureWindow": true, "windows": []}}),
        StatusCode::OK,
    )
    .await;
    let state = state_with(&dir, adb.clone(), apk.clone(), Some(helper)).await;
    let resp = router_with_state(state)
        .oneshot(
            Request::builder()
                .uri("/api/v1/automation/screenshot?deviceId=dev1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers()["x-andrui-secure-window"], "true");
    assert_eq!(resp.headers()["x-andrui-secure-detection"], "dumpsys");

    let helper = spawn_helper(
        json!({"error": "secure_window_blocked", "message": "Screenshot unavailable while a FLAG_SECURE window is visible"}),
        StatusCode::BAD_REQUEST,
    )
    .await;
    let state = state_with(&dir, adb, apk, Some(helper)).await;
    let (status, body) = get_json(state, "/api/v1/automation/screenshot?deviceId=dev1").await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["error"]["code"], "secure_window_blocked");
}

#[tokio::test]
async fn missing_host_apk_only_warns_when_helper_is_installed() {
    let dir = TempDir::new().unwrap();
    let adb = write_fake_adb(&dir, &"0".repeat(64), "");
    let state = AppState::new(ExtensionsConfig {
        adb_path: adb,
        data_dir: dir.path().to_path_buf(),
        helper_apk: None,
    });

    let (_, body) = get_json(state, "/api/v1/automation/helper/checks?deviceId=dev1").await;
    assert_eq!(status_of(&body, "host_apk"), "warn");
    assert_eq!(status_of(&body, "up_to_date"), "skip");
    let up = body["checks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["id"] == "up_to_date")
        .unwrap();
    assert_eq!(up["detail"], "No host APK to compare against");
    assert_eq!(body["overall"], "warn");
}
