use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use andrui_automation::{
    actions::ActionSelector,
    cleanup_all_sessions,
    matcher::match_template_zncc,
    ocr::parse_tesseract_tsv,
    router_with_state,
    state::{AppState, AutomationSession},
    ExtensionsConfig,
};
use axum::{
    body::{to_bytes, Body},
    http::{header, Request, StatusCode},
    routing::{get, post},
    Json, Router,
};
use image::GrayImage;
use serde_json::Value;
use tempfile::TempDir;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tower::ServiceExt;

/// Spawn a mock helper HTTP server that implements the protocol version 1 specification.
async fn spawn_mock_helper(token: String) -> (SocketAddr, Arc<AtomicUsize>, Arc<AtomicBool>) {
    let call_count = Arc::new(AtomicUsize::new(0));
    let stop_called = Arc::new(AtomicBool::new(false));

    let count_clone = call_count.clone();
    let stop_clone = stop_called.clone();
    let expected_token = token.clone();

    let app = Router::new()
        .route(
            "/health",
            get(|| async {
                Json(serde_json::json!({
                    "version": "0.1.0",
                    "protocolVersion": 1,
                    "sdk": 34,
                    "capabilities": ["hierarchy", "actions", "screenshot"]
                }))
            }),
        )
        .route(
            "/hierarchy",
            get({
                let token_exp = expected_token.clone();
                move |headers: axum::http::HeaderMap| {
                    let token_exp = token_exp.clone();
                    async move {
                        let auth = headers.get("x-andrui-token").and_then(|v| v.to_str().ok());
                        if auth != Some(&token_exp) {
                            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Unauthorized"})));
                        }
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "xml": "<hierarchy><node resource-id=\"test_view\" text=\"Hello\" clickable=\"true\" bounds=\"[0,0][1,1]\"/></hierarchy>",
                                "capturedAt": 1731090000000u64
                            })),
                        )
                    }
                }
            }),
        )
        .route(
            "/actions",
            post({
                let token_exp = expected_token.clone();
                let count = count_clone.clone();
                move |headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let token_exp = token_exp.clone();
                    let count = count.clone();
                    async move {
                        let auth = headers.get("x-andrui-token").and_then(|v| v.to_str().ok());
                        if auth != Some(&token_exp) {
                            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Unauthorized"})));
                        }

                        count.fetch_add(1, Ordering::SeqCst);
                        let action = body["action"].as_str().unwrap_or("");

                        // Mock timeout condition if requested
                        if body.get("timeoutMs") == Some(&Value::from(1001)) {
                            return (
                                StatusCode::REQUEST_TIMEOUT,
                                Json(serde_json::json!({
                                    "error": "element_timeout",
                                    "message": "Selector did not satisfy action within timeout"
                                })),
                            );
                        }

                        // Mock rejection if text is "fail"
                        if body.get("text") == Some(&Value::from("fail")) {
                            return (
                                StatusCode::BAD_REQUEST,
                                Json(serde_json::json!({
                                    "error": "operation_failed",
                                    "message": "Node rejected action"
                                })),
                            );
                        }

                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "success": true,
                                "action": action,
                                "target": {
                                    "resourceId": "io.andrui.terminal:id/button_ok",
                                    "text": "Submit",
                                    "bounds": "[10,20][100,60]"
                                }
                            })),
                        )
                    }
                }
            }),
        )
        .route(
            "/screenshot",
            get({
                let token_exp = expected_token.clone();
                move |headers: axum::http::HeaderMap| {
                    let token_exp = token_exp.clone();
                    async move {
                        let auth = headers.get("x-andrui-token").and_then(|v| v.to_str().ok());
                        if auth != Some(&token_exp) {
                            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Unauthorized"})));
                        }
                        // 1x1 valid PNG base64
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "contentType": "image/png",
                                "base64": "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
                            })),
                        )
                    }
                }
            }),
        )
        .route(
            "/stop",
            post({
                let token_exp = expected_token.clone();
                let stop_called = stop_clone.clone();
                move |headers: axum::http::HeaderMap| {
                    let token_exp = token_exp.clone();
                    let stop_called = stop_called.clone();
                    async move {
                        let auth = headers.get("x-andrui-token").and_then(|v| v.to_str().ok());
                        if auth != Some(&token_exp) {
                            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Unauthorized"})));
                        }
                        stop_called.store(true, Ordering::SeqCst);
                        (StatusCode::OK, Json(serde_json::json!({"stopped": true})))
                    }
                }
            }),
        );

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });

    (addr, call_count, stop_called)
}

fn create_test_state(temp_dir: &TempDir) -> AppState {
    let config = ExtensionsConfig {
        adb_path: std::path::PathBuf::from("/usr/bin/adb"),
        data_dir: temp_dir.path().to_path_buf(),
        helper_apk: None,
    };
    AppState::new(config)
}

#[tokio::test]
async fn test_selector_validation() {
    let empty_selector = ActionSelector {
        resource_id: None,
        text: None,
        description: None,
        class_name: None,
        xpath: None,
        ..Default::default()
    };
    assert!(empty_selector.validate().is_err());

    let empty_field_selector = ActionSelector {
        resource_id: Some("".to_string()),
        text: None,
        description: None,
        class_name: None,
        xpath: None,
        ..Default::default()
    };
    assert!(empty_field_selector.validate().is_err());

    let valid_selector = ActionSelector {
        resource_id: Some("button_submit".to_string()),
        text: None,
        description: None,
        class_name: None,
        xpath: None,
        ..Default::default()
    };
    assert!(valid_selector.validate().is_ok());

    let xpath_selector = ActionSelector {
        resource_id: None,
        text: None,
        description: None,
        class_name: None,
        xpath: Some("//node[@text='Click Me']".to_string()),
        ..Default::default()
    };
    assert!(xpath_selector.validate().is_ok());

    // Test new rich selectors
    let text_contains_selector = ActionSelector {
        text_contains: Some("Submit".to_string()),
        ..Default::default()
    };
    assert!(text_contains_selector.validate().is_ok());

    let regex_selector = ActionSelector {
        text_matches: Some("^[0-9]+$".to_string()),
        ..Default::default()
    };
    assert!(regex_selector.validate().is_ok());

    let state_filter_selector = ActionSelector {
        checked: Some(true),
        enabled: Some(true),
        index: Some(1),
        ..Default::default()
    };
    assert!(state_filter_selector.validate().is_ok());
}

#[tokio::test]
async fn test_token_forwarding_and_hierarchy_and_screenshot() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_token_12345678901234567890".to_string();
    let (addr, _count, _stop) = spawn_mock_helper(token.clone()).await;

    let session_id = "sess-01".to_string();
    let session = Arc::new(AutomationSession {
        id: session_id.clone(),
        device_id: "device-test-1".to_string(),
        token: token.clone(),
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut s = state.sessions.write().await;
        let mut d = state.device_sessions.write().await;
        s.insert(session_id.clone(), session);
        d.insert("device-test-1".to_string(), session_id.clone());
    }

    let app = router_with_state(state.clone());

    // 1. Hierarchy request - verifies token forwarding
    let req = Request::builder()
        .uri("/api/v1/automation/hierarchy?deviceId=device-test-1")
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert!(json["xml"].as_str().unwrap().contains("<hierarchy"));
    assert_eq!(json["snapshotOnly"], false);

    // 2. Screenshot request - verifies base64 decoding to raw PNG binary
    let req = Request::builder()
        .uri("/api/v1/automation/screenshot?deviceId=device-test-1")
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );

    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    // Verify valid PNG header magic: 89 50 4E 47 0D 0A 1A 0A
    assert_eq!(&body[0..8], b"\x89PNG\r\n\x1a\n");
}

#[tokio::test]
async fn test_compact_hierarchy_and_marked_screenshot() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);
    let token = "test_token_compact_1234567890123".to_string();
    let (addr, _count, _stop) = spawn_mock_helper(token.clone()).await;
    let session = Arc::new(AutomationSession {
        id: "sess-compact".to_string(),
        device_id: "device-compact".to_string(),
        token,
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });
    state
        .sessions
        .write()
        .await
        .insert("sess-compact".to_string(), session);
    state
        .device_sessions
        .write()
        .await
        .insert("device-compact".to_string(), "sess-compact".to_string());
    let app = router_with_state(state);
    let get = |uri: &str| {
        let req = Request::builder().uri(uri).body(Body::empty()).unwrap();
        app.clone().oneshot(req)
    };

    let resp = get("/api/v1/automation/hierarchy?deviceId=device-compact&format=compact")
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(json.get("xml").is_none());
    assert_eq!(json["nodes"][0]["text"], "Hello");
    assert_eq!(json["nodes"][0]["flags"][0], "click");
    assert_eq!(json["capturedAt"], 1731090000000u64);

    let resp = get("/api/v1/automation/hierarchy?deviceId=device-compact&format=yaml")
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let resp = get("/api/v1/automation/screenshot?deviceId=device-compact&marks=true&format=json")
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let json: Value =
        serde_json::from_slice(&to_bytes(resp.into_body(), usize::MAX).await.unwrap()).unwrap();
    use base64::prelude::*;
    let png = BASE64_STANDARD
        .decode(json["pngBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(&png[0..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(json["nodes"].as_array().unwrap().len(), 1);

    let resp = get("/api/v1/automation/screenshot?deviceId=device-compact&marks=true")
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("X-Andrui-Marks").unwrap(), "1");

    let resp = get("/api/v1/automation/screenshot?deviceId=device-compact&format=json")
        .await
        .unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn test_action_execution_and_recording_failed_actions_not_counted() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_token_actions_123456789012".to_string();
    let (addr, count, _stop) = spawn_mock_helper(token.clone()).await;

    let session_id = "sess-act".to_string();
    let device_id = "device-rec-1".to_string();
    let session = Arc::new(AutomationSession {
        id: session_id.clone(),
        device_id: device_id.clone(),
        token: token.clone(),
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut s = state.sessions.write().await;
        let mut d = state.device_sessions.write().await;
        s.insert(session_id.clone(), session);
        d.insert(device_id.clone(), session_id.clone());
    }

    let app = router_with_state(state.clone());

    // 1. Start Recording
    let start_rec_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/recordings/start")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": device_id,
                "name": "login_flow"
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(start_rec_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let rec_start: Value = serde_json::from_slice(&body).unwrap();
    let rec_id = rec_start["id"].as_str().unwrap().to_string();

    // 2. Execute Action 1: SUCCESSFUL click
    let act1_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": device_id,
                "action": "click",
                "selector": { "resourceId": "btn_login" }
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(act1_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // 3. Execute Action 2: FAILING action (text = "fail" triggers 400 from helper)
    let act2_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": device_id,
                "action": "setText",
                "selector": { "resourceId": "input_password" },
                "text": "fail"
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(act2_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    // 4. Execute Action 3: TIMEOUT action (timeoutMs = 1001 triggers 408 from helper)
    let act3_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": device_id,
                "action": "wait",
                "selector": { "text": "Welcome" },
                "timeoutMs": 1001
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(act3_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::REQUEST_TIMEOUT);

    // 5. Execute Action 4: SUCCESSFUL scroll
    let act4_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": device_id,
                "action": "scroll",
                "selector": { "className": "android.widget.ScrollView" },
                "direction": "forward"
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(act4_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Helper should have been called 4 times
    assert_eq!(count.load(Ordering::SeqCst), 4);

    // 6. Stop Recording and verify ONLY successful actions were counted
    let stop_rec_req = Request::builder()
        .method("POST")
        .uri(format!("/api/v1/automation/recordings/{}/stop", rec_id))
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(stop_rec_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let rec_detail: Value = serde_json::from_slice(&body).unwrap();
    let steps = rec_detail["steps"].as_array().unwrap();

    // Verify only the 2 successful actions are recorded!
    assert_eq!(
        steps.len(),
        2,
        "Failed/timed out actions must not be recorded"
    );
    assert_eq!(steps[0]["action"], "click");
    assert_eq!(steps[1]["action"], "scroll");

    // 7. Verify persistence in data_dir/automation
    let list_req = Request::builder()
        .uri("/api/v1/automation/recordings")
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(list_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let list_val: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(list_val.as_array().unwrap().len(), 1);
    assert_eq!(list_val[0]["id"], rec_id);
}

#[tokio::test]
async fn test_cleanup_and_session_deletion() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_cleanup_token_1234567890".to_string();
    let (addr, _count, stop_called) = spawn_mock_helper(token.clone()).await;

    let session_id = "sess-cleanup".to_string();
    let device_id = "device-cleanup".to_string();
    let session = Arc::new(AutomationSession {
        id: session_id.clone(),
        device_id: device_id.clone(),
        token: token.clone(),
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut s = state.sessions.write().await;
        let mut d = state.device_sessions.write().await;
        s.insert(session_id.clone(), session);
        d.insert(device_id.clone(), session_id.clone());
    }

    let app = router_with_state(state.clone());

    let del_req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/automation/sessions/{}", session_id))
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(del_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    // Helper POST /stop must have been invoked
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert!(stop_called.load(Ordering::SeqCst));

    // Session must no longer exist in state
    assert!(state.get_device_session(&device_id).await.is_err());
    // Test cleanup_all_sessions
    cleanup_all_sessions(&state).await;
    assert!(state.sessions.read().await.is_empty());
}

#[tokio::test]
async fn test_template_matching_exact_and_negative() {
    // 1. Create 80x80 synthetic image
    let mut img = GrayImage::new(80, 80);
    for y in 0..80 {
        for x in 0..80 {
            img.put_pixel(x, y, image::Luma([((x + y * 2) % 250) as u8]));
        }
    }

    // Embed distinct target patch at (25, 30) of size 15x15
    let mut tpl = GrayImage::new(15, 15);
    for ty in 0..15 {
        for tx in 0..15 {
            let val = ((tx * 12 + ty * 15) % 255) as u8;
            tpl.put_pixel(tx, ty, image::Luma([val]));
            img.put_pixel(25 + tx, 30 + ty, image::Luma([val]));
        }
    }

    // Run ZNCC match
    let matches = match_template_zncc(&img, &tpl, 0.95, 5);
    assert!(!matches.is_empty(), "Should find exact match");
    assert_eq!(matches[0].x, 25);
    assert_eq!(matches[0].y, 30);
    assert!(
        matches[0].score >= 0.99,
        "Score should be close to 1.0, got {}",
        matches[0].score
    );

    // Negative match: pattern not in image
    let mut inverted_tpl = GrayImage::new(15, 15);
    for ty in 0..15 {
        for tx in 0..15 {
            inverted_tpl.put_pixel(
                tx,
                ty,
                image::Luma([255 - ((tx * 12 + ty * 15) % 255) as u8]),
            );
        }
    }
    let neg_matches = match_template_zncc(&img, &inverted_tpl, 0.98, 5);
    assert!(
        neg_matches.is_empty(),
        "Negative match should yield no candidates"
    );
}

#[tokio::test]
async fn test_capabilities_and_tesseract_unavailable_handling() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);
    let app = router_with_state(state.clone());

    let req = Request::builder()
        .uri("/api/v1/automation/capabilities")
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let caps: Value = serde_json::from_slice(&body).unwrap();

    // Verify explicit structured capabilities
    assert_eq!(caps["helperApk"]["available"], false);
    assert!(caps["helperApk"]["reason"].as_str().is_some());
    assert_eq!(caps["templateMatching"]["available"], true);
}

#[tokio::test]
async fn test_tesseract_tsv_parsing() {
    let sample_tsv = "\
level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext
1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t
2\t1\t1\t0\t0\t0\t20\t30\t200\t50\t-1\t
3\t1\t1\t1\t0\t0\t20\t30\t200\t50\t-1\t
4\t1\t1\t1\t1\t0\t20\t30\t200\t50\t-1\t
5\t1\t1\t1\t1\t1\t20\t30\t80\t30\t96.5\tLogin
5\t1\t1\t1\t1\t2\t110\t30\t90\t30\t94.2\tButton
";

    let (full_text, regions) = parse_tesseract_tsv(sample_tsv);
    assert_eq!(full_text, "Login Button");
    assert_eq!(regions.len(), 2);
    assert_eq!(regions[0].text, "Login");
    assert_eq!(regions[0].left, 20);
    assert_eq!(regions[0].top, 30);
    assert_eq!(regions[0].confidence, 96.5);
    assert_eq!(regions[1].text, "Button");
    assert_eq!(regions[1].left, 110);
    assert_eq!(regions[1].width, 90);
}

fn create_multipart_body(boundary: &str, fields: &[(&str, Option<&str>, &[u8])]) -> Vec<u8> {
    let mut data = Vec::new();
    for (name, filename, bytes) in fields {
        data.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
        if let Some(fname) = filename {
            data.extend_from_slice(
                format!(
                    "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: application/octet-stream\r\n\r\n",
                    name, fname
                )
                .as_bytes(),
            );
        } else {
            data.extend_from_slice(
                format!("Content-Disposition: form-data; name=\"{}\"\r\n\r\n", name).as_bytes(),
            );
        }
        data.extend_from_slice(bytes);
        data.extend_from_slice(b"\r\n");
    }
    data.extend_from_slice(format!("--{}--\r\n", boundary).as_bytes());
    data
}

#[tokio::test]
async fn test_match_endpoint_multipart_validation() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);
    let app = router_with_state(state);

    let boundary = "---------------------------boundary123";

    // 1. Corrupted image bytes
    let body_corrupted = create_multipart_body(
        boundary,
        &[
            ("image", Some("img.png"), b"not_a_real_image_bytes"),
            ("template", Some("tpl.png"), b"not_a_real_template_bytes"),
        ],
    );

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_corrupted))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"]["code"], "invalid_image");

    // 2. Template larger than image
    // Generate valid 10x10 PNG and 20x20 PNG
    let mut small_img = GrayImage::new(10, 10);
    for x in 0..10 {
        for y in 0..10 {
            small_img.put_pixel(x, y, image::Luma([128]));
        }
    }
    let mut small_bytes = Vec::new();
    small_img
        .write_to(
            &mut std::io::Cursor::new(&mut small_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();

    let mut big_img = GrayImage::new(20, 20);
    for x in 0..20 {
        for y in 0..20 {
            big_img.put_pixel(x, y, image::Luma([128]));
        }
    }
    let mut big_bytes = Vec::new();
    big_img
        .write_to(
            &mut std::io::Cursor::new(&mut big_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();

    // Source is 10x10, template is 20x20 (invalid)
    let body_oversized = create_multipart_body(
        boundary,
        &[
            ("image", Some("img.png"), &small_bytes),
            ("template", Some("tpl.png"), &big_bytes),
        ],
    );

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_oversized))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"]["code"], "invalid_dimensions");

    // 3. Valid match via HTTP endpoint
    // Source 20x20 with embedded 10x10
    let body_valid = create_multipart_body(
        boundary,
        &[
            ("image", Some("img.png"), &big_bytes),
            ("template", Some("tpl.png"), &small_bytes),
            ("threshold", None, b"0.8"),
        ],
    );

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_valid))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    let matches = json["matches"].as_array().unwrap();
    assert!(!matches.is_empty());
}

#[tokio::test]
async fn test_ocr_endpoint_validation_and_unavailability() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);
    let app = router_with_state(state);

    let boundary = "---------------------------boundary456";

    // Request missing image field
    let body_no_img = create_multipart_body(boundary, &[("language", None, b"eng")]);

    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/ocr")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_no_img))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    // Since Tesseract is not installed on this test host, it either returns 503 (tesseract unavailable)
    // or 400 (missing image). Both are valid structured errors!
    let status = resp.status();
    assert!(
        status == StatusCode::SERVICE_UNAVAILABLE || status == StatusCode::BAD_REQUEST,
        "Expected 503 or 400, got {}",
        status
    );
}

#[tokio::test]
async fn test_replay_cancellation() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_replay_token_123456789012".to_string();
    let (addr, _count, _stop) = spawn_mock_helper(token.clone()).await;

    let device_id = "dev-replay";
    let session = Arc::new(AutomationSession {
        id: "sess-rep".to_string(),
        device_id: device_id.to_string(),
        token,
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut s = state.sessions.write().await;
        let mut d = state.device_sessions.write().await;
        s.insert("sess-rep".to_string(), session);
        d.insert(device_id.to_string(), "sess-rep".to_string());
    }

    // Create a persisted recording with multiple steps
    let rec_id = uuid::Uuid::new_v4().to_string();
    let rec_detail = serde_json::json!({
        "id": rec_id,
        "deviceId": device_id,
        "name": "flow",
        "startedAt": 1000u64,
        "steps": [
            {
                "action": "click",
                "selector": { "resourceId": "btn_1" },
                "timestamp": 1000u64,
                "durationMs": 50u64
            },
            {
                "action": "click",
                "selector": { "resourceId": "btn_2" },
                "timestamp": 1050u64,
                "durationMs": 50u64
            }
        ]
    });

    let auto_dir = temp_dir.path().join("automation");
    tokio::fs::create_dir_all(&auto_dir).await.unwrap();
    tokio::fs::write(
        auto_dir.join(format!("{}.json", rec_id)),
        serde_json::to_string(&rec_detail).unwrap(),
    )
    .await
    .unwrap();

    let app = router_with_state(state.clone());

    // 1. Start Replay
    let start_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/replay")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "recordingId": rec_id,
                "deviceId": device_id
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(start_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let rep_start: Value = serde_json::from_slice(&body).unwrap();
    let replay_id = rep_start["id"].as_str().unwrap().to_string();

    // 2. Cancel Replay
    let cancel_req = Request::builder()
        .method("DELETE")
        .uri(format!("/api/v1/automation/replays/{}", replay_id))
        .body(Body::empty())
        .unwrap();

    let resp = app.clone().oneshot(cancel_req).await.unwrap();
    // It should either return 200 (if still active) or 404 (if it already finished before cancellation)
    assert!(
        resp.status() == StatusCode::OK || resp.status() == StatusCode::NOT_FOUND,
        "Expected 200 or 404, got {}",
        resp.status()
    );
}

#[tokio::test]
async fn test_action_selector_omits_null_keys_and_preserves_device_id() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_selector_token_1234567890".to_string();
    let captured_body = Arc::new(tokio::sync::Mutex::new(None));
    let cap_clone = captured_body.clone();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let app_mock = Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "version": "0.1.0", "protocolVersion": 1 })) }),
        )
        .route(
            "/actions",
            post(
                move |_headers: axum::http::HeaderMap, Json(body): Json<Value>| {
                    let cap = cap_clone.clone();
                    async move {
                        let mut guard = cap.lock().await;
                        *guard = Some(body);
                        (
                            StatusCode::OK,
                            Json(serde_json::json!({
                                "success": true,
                                "action": "click"
                            })),
                        )
                    }
                },
            ),
        );

    tokio::spawn(async move {
        axum::serve(listener, app_mock).await.unwrap();
    });

    let opaque_device_id = "device:special-id_123";
    let session_id = "sess-selector-test";
    let session = Arc::new(AutomationSession {
        id: session_id.to_string(),
        device_id: opaque_device_id.to_string(),
        token: token.clone(),
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut dev_map = state.device_sessions.write().await;
        let mut sessions = state.sessions.write().await;
        dev_map.insert(opaque_device_id.to_string(), session_id.to_string());
        sessions.insert(session_id.to_string(), session);
    }

    let app = router_with_state(state.clone());

    // 1. Whitespace-only deviceId should be rejected
    let req_ws = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": "   ",
                "action": "click",
                "selector": { "text": "Click Me" }
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp_ws = app.clone().oneshot(req_ws).await.unwrap();
    assert_eq!(resp_ws.status(), StatusCode::BAD_REQUEST);

    // 2. Action with only 'text' in selector
    let req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": opaque_device_id,
                "action": "click",
                "selector": {
                    "text": "Sign In"
                }
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let captured = captured_body
        .lock()
        .await
        .clone()
        .expect("Helper should have received action");
    let selector = captured
        .get("selector")
        .and_then(|v| v.as_object())
        .expect("selector must be object");

    // Must contain supplied key
    assert_eq!(
        selector.get("text").and_then(|v| v.as_str()),
        Some("Sign In")
    );

    // Must NOT contain null keys
    assert!(
        selector.get("resourceId").is_none(),
        "resourceId must be omitted, not null"
    );
    assert!(
        selector.get("description").is_none(),
        "description must be omitted, not null"
    );
    assert!(
        selector.get("className").is_none(),
        "className must be omitted, not null"
    );
    assert!(
        selector.get("xpath").is_none(),
        "xpath must be omitted, not null"
    );
}

#[tokio::test]
async fn test_helper_install_uses_testonly_flag() {
    let temp_dir = TempDir::new().unwrap();
    let adb_script_path = temp_dir.path().join("fake_adb.sh");

    // Script verifies -t flag is present
    let script_content = r#"#!/bin/sh
for arg in "$@"; do
    if [ "$arg" = "-t" ]; then
        echo "Success"
        exit 0
    fi
done
echo "Failure [INSTALL_FAILED_TEST_ONLY]"
exit 1
"#;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&adb_script_path).unwrap();
        file.write_all(script_content.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }

    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&adb_script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let fake_apk = temp_dir.path().join("helper.apk");
    tokio::fs::write(&fake_apk, b"fake_apk_bytes")
        .await
        .unwrap();

    let result = andrui_automation::adb::AdbExecutor::install_helper_apk(
        &adb_script_path,
        "device-test",
        &fake_apk,
    )
    .await;
    assert!(
        result.is_ok(),
        "install_helper_apk must succeed by providing -t flag: {:?}",
        result
    );
}

#[tokio::test]
async fn test_forward_port_no_fallback_and_fails_clearly() {
    let temp_dir = TempDir::new().unwrap();
    let adb_script_path = temp_dir.path().join("fake_adb_forward_fail.sh");

    let script_content = r#"#!/bin/sh
echo "error: cannot bind listener" >&2
exit 1
"#;
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&adb_script_path).unwrap();
        file.write_all(script_content.as_bytes()).unwrap();
        file.sync_all().unwrap();
    }

    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&adb_script_path, std::fs::Permissions::from_mode(0o755)).unwrap();

    let res =
        andrui_automation::adb::AdbExecutor::forward_port(&adb_script_path, "device-1", 9008).await;
    assert!(
        res.is_err(),
        "forward_port must fail when tcp:0 fails without fallback"
    );
    match res.unwrap_err() {
        andrui_automation::error::ApiError::BadRequest { code, .. } => {
            assert_eq!(code, "adb_forward_failed");
        }
        other => panic!("Expected adb_forward_failed, got {:?}", other),
    }

    // Also test invalid port output (e.g. "not-a-port")
    let adb_invalid_port_path = temp_dir.path().join("fake_adb_invalid_port.sh");
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&adb_invalid_port_path).unwrap();
        file.write_all(b"#!/bin/sh\necho not-a-port\nexit 0\n")
            .unwrap();
        file.sync_all().unwrap();
    }
    std::fs::set_permissions(
        &adb_invalid_port_path,
        std::fs::Permissions::from_mode(0o755),
    )
    .unwrap();

    let res_invalid =
        andrui_automation::adb::AdbExecutor::forward_port(&adb_invalid_port_path, "device-1", 9008)
            .await;
    assert!(res_invalid.is_err());
    match res_invalid.unwrap_err() {
        andrui_automation::error::ApiError::BadRequest { code, .. } => {
            assert_eq!(code, "adb_forward_invalid_port");
        }
        other => panic!("Expected adb_forward_invalid_port, got {:?}", other),
    }
}

#[tokio::test]
async fn test_template_matching_budget_nonfinite_threshold_and_route_limits() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);
    let app = router_with_state(state);
    let boundary = "---------------------------boundaryTest4";

    // 1. Nonfinite threshold (NaN)
    let small_img = GrayImage::new(10, 10);
    let mut small_bytes = Vec::new();
    small_img
        .write_to(
            &mut std::io::Cursor::new(&mut small_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();

    let body_nan = create_multipart_body(
        boundary,
        &[
            ("image", Some("img.png"), &small_bytes),
            ("template", Some("tpl.png"), &small_bytes),
            ("threshold", None, b"NaN"),
        ],
    );

    let req_nan = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_nan))
        .unwrap();

    let resp_nan = app.clone().oneshot(req_nan).await.unwrap();
    assert_eq!(resp_nan.status(), StatusCode::BAD_REQUEST);
    let body = to_bytes(resp_nan.into_body(), usize::MAX).await.unwrap();
    let json: Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"]["code"], "invalid_threshold");

    // 2. Computation budget exceeded (> 50 million pixel comparisons)
    // 1000x1000 source, 500x500 template: (501 * 501) * 250,000 = 62.7 billion operations
    let big_src = GrayImage::new(1000, 1000);
    let mut big_src_bytes = Vec::new();
    big_src
        .write_to(
            &mut std::io::Cursor::new(&mut big_src_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();

    let big_tpl = GrayImage::new(500, 500);
    let mut big_tpl_bytes = Vec::new();
    big_tpl
        .write_to(
            &mut std::io::Cursor::new(&mut big_tpl_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();

    let body_budget = create_multipart_body(
        boundary,
        &[
            ("image", Some("img.png"), &big_src_bytes),
            ("template", Some("tpl.png"), &big_tpl_bytes),
        ],
    );

    let req_budget = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_budget))
        .unwrap();

    let resp_budget = app.clone().oneshot(req_budget).await.unwrap();
    assert_eq!(resp_budget.status(), StatusCode::BAD_REQUEST);
    let body_b = to_bytes(resp_budget.into_body(), usize::MAX).await.unwrap();
    let json_b: Value = serde_json::from_slice(&body_b).unwrap();
    assert_eq!(json_b["error"]["code"], "computation_budget_exceeded");

    // 3. Malformed multipart
    let req_malformed = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(b"--incomplete-boundary".to_vec()))
        .unwrap();

    let resp_malformed = app.clone().oneshot(req_malformed).await.unwrap();
    assert_eq!(resp_malformed.status(), StatusCode::BAD_REQUEST);
    let body_m = to_bytes(resp_malformed.into_body(), usize::MAX)
        .await
        .unwrap();
    let json_m: Value = serde_json::from_slice(&body_m).unwrap();
    assert_eq!(json_m["error"]["code"], "malformed_multipart");

    // 4. Large multipart payload > 2MiB accepted by route layer (3MB image)
    let large_img = GrayImage::new(900, 900);
    let mut large_bytes = Vec::new();
    large_img
        .write_to(
            &mut std::io::Cursor::new(&mut large_bytes),
            image::ImageFormat::Png,
        )
        .unwrap();
    let mut padded_bytes = large_bytes.clone();
    if padded_bytes.len() < 2_500_000 {
        padded_bytes.resize(2_500_000, 0);
    }
    let body_large = create_multipart_body(
        boundary,
        &[
            ("image", Some("img.png"), &padded_bytes),
            ("template", Some("tpl.png"), &small_bytes),
        ],
    );

    let req_large = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/match")
        .header(
            header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={}", boundary),
        )
        .body(Body::from(body_large))
        .unwrap();

    let resp_large = app.clone().oneshot(req_large).await.unwrap();
    assert_ne!(resp_large.status(), StatusCode::PAYLOAD_TOO_LARGE);
}

#[tokio::test]
async fn test_path_traversal_rejection_and_replay_no_fake_success() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);
    let app = router_with_state(state.clone());

    // 1. Path traversal in recording ID rejected with 400 invalid_id
    let req_get = Request::builder()
        .uri("/api/v1/automation/recordings/..%2F..%2Fetc%2Fpasswd")
        .body(Body::empty())
        .unwrap();
    let resp_get = app.clone().oneshot(req_get).await.unwrap();
    assert_eq!(resp_get.status(), StatusCode::BAD_REQUEST);

    let req_stop = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/recordings/..%2F..%2Fetc%2Fpasswd/stop")
        .body(Body::empty())
        .unwrap();
    let resp_stop = app.clone().oneshot(req_stop).await.unwrap();
    assert_eq!(resp_stop.status(), StatusCode::BAD_REQUEST);

    let req_rep = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/replay")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "recordingId": "../../etc/passwd",
                "deviceId": "dev1"
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp_rep = app.clone().oneshot(req_rep).await.unwrap();
    assert_eq!(resp_rep.status(), StatusCode::BAD_REQUEST);

    // 2. Replay no fake success when helper returns success: false
    let token = "test_replay_nofake_token_12345".to_string();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();

    let app_mock = Router::new()
        .route(
            "/health",
            get(|| async { Json(serde_json::json!({ "version": "0.1.0", "protocolVersion": 1 })) }),
        )
        .route(
            "/actions",
            post(|| async {
                // Helper returns HTTP 200 with success: false
                (
                    StatusCode::OK,
                    Json(serde_json::json!({ "success": false, "action": "click" })),
                )
            }),
        );

    tokio::spawn(async move {
        axum::serve(listener, app_mock).await.unwrap();
    });

    let rec_uuid = uuid::Uuid::new_v4().to_string();
    let dev_id = "device-nofake";
    let session = Arc::new(AutomationSession {
        id: "sess-nofake".to_string(),
        device_id: dev_id.to_string(),
        token: token.clone(),
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut dev_map = state.device_sessions.write().await;
        let mut sessions = state.sessions.write().await;
        dev_map.insert(dev_id.to_string(), "sess-nofake".to_string());
        sessions.insert("sess-nofake".to_string(), session);
    }

    let rec_detail = serde_json::json!({
        "id": rec_uuid,
        "deviceId": dev_id,
        "startedAt": 1000u64,
        "steps": [
            {
                "action": "click",
                "selector": { "resourceId": "btn_1" },
                "timestamp": 1000u64,
                "durationMs": 50u64
            }
        ]
    });

    let auto_dir = temp_dir.path().join("automation");
    tokio::fs::create_dir_all(&auto_dir).await.unwrap();
    tokio::fs::write(
        auto_dir.join(format!("{}.json", rec_uuid)),
        serde_json::to_string(&rec_detail).unwrap(),
    )
    .await
    .unwrap();

    let start_req = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/replay")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "recordingId": rec_uuid,
                "deviceId": dev_id
            }))
            .unwrap(),
        ))
        .unwrap();

    let resp = app.clone().oneshot(start_req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    let rep_start: Value = serde_json::from_slice(&body).unwrap();
    let replay_id = rep_start["id"].as_str().unwrap().to_string();

    // Subscribe to event stream and verify failure is emitted (not passed)
    let channel_opt = {
        let ch = state.replay_channels.read().await;
        ch.get(&replay_id).cloned()
    };
    if let Some(ch) = channel_opt {
        let mut rx = ch.subscribe();
        let mut saw_failed = false;
        while let Ok(msg) = tokio::time::timeout(Duration::from_millis(500), rx.recv()).await {
            if let Ok(evt_str) = msg {
                if evt_str.contains("\"failed\"") {
                    saw_failed = true;
                    break;
                }
            }
        }
        assert!(
            saw_failed,
            "Replay must emit failed status, never fake success"
        );
    }

    // 3. Verify cleanup_all_sessions cancels replays
    let (cancel_tx, cancel_rx) = tokio::sync::watch::channel(false);
    let rep2_id = uuid::Uuid::new_v4().to_string();
    {
        let mut replays = state.active_replays.write().await;
        replays.insert(rep2_id.clone(), Arc::new(cancel_tx));
    }
    cleanup_all_sessions(&state).await;
    assert!(
        *cancel_rx.borrow(),
        "cleanup_all_sessions must cancel persistent replays"
    );
}

#[tokio::test]
async fn test_session_action_lock_serializes_actions() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_action_lock_token".to_string();
    let (addr, count, _stop) = spawn_mock_helper(token.clone()).await;

    let dev_id = "device-lock-test";
    let session = Arc::new(AutomationSession {
        id: "sess-lock".to_string(),
        device_id: dev_id.to_string(),
        token,
        host_port: addr.port(),
        helper_version: "0.1.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut dev_map = state.device_sessions.write().await;
        let mut sessions = state.sessions.write().await;
        dev_map.insert(dev_id.to_string(), "sess-lock".to_string());
        sessions.insert("sess-lock".to_string(), session.clone());
    }

    let app = router_with_state(state);

    // Hold the session action lock manually
    let lock_guard = session.action_lock.lock().await;

    // Dispatch execute_action in background task
    let app_clone = app.clone();
    let handle = tokio::spawn(async move {
        let req = Request::builder()
            .method("POST")
            .uri("/api/v1/automation/actions")
            .header(header::CONTENT_TYPE, "application/json")
            .body(Body::from(
                serde_json::to_vec(&serde_json::json!({
                    "deviceId": dev_id,
                    "action": "click",
                    "selector": { "text": "Submit" }
                }))
                .unwrap(),
            ))
            .unwrap();

        app_clone.oneshot(req).await.unwrap()
    });

    // Verify it is blocked because action_lock is held
    tokio::time::sleep(Duration::from_millis(50)).await;
    assert_eq!(
        count.load(Ordering::SeqCst),
        0,
        "Action must be blocked waiting on action_lock"
    );

    // Release lock
    drop(lock_guard);

    // Now it should complete
    let resp = handle.await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(count.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn test_new_actions_clear_text_press_key_swipe() {
    let temp_dir = TempDir::new().unwrap();
    let state = create_test_state(&temp_dir);

    let token = "test_token_new_actions_123456789".to_string();
    let (addr, count, _stop) = spawn_mock_helper(token.clone()).await;

    let dev_id = "device-new-actions";
    let session = Arc::new(AutomationSession {
        id: "sess-new-act".to_string(),
        device_id: dev_id.to_string(),
        token,
        host_port: addr.port(),
        helper_version: "0.2.0".to_string(),
        created_at: 1000,
        child: Mutex::new(None),
        action_lock: Arc::new(tokio::sync::Mutex::new(())),
    });

    {
        let mut dev_map = state.device_sessions.write().await;
        let mut sessions = state.sessions.write().await;
        dev_map.insert(dev_id.to_string(), "sess-new-act".to_string());
        sessions.insert("sess-new-act".to_string(), session);
    }

    let app = router_with_state(state);

    // 1. pressKey missing key parameter should fail validation
    let req1 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "pressKey"
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp1 = app.clone().oneshot(req1).await.unwrap();
    assert_eq!(resp1.status(), StatusCode::BAD_REQUEST);

    // 2. pressKey with key name succeeds
    let req2 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "pressKey",
                "key": "BACK"
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp2 = app.clone().oneshot(req2).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::OK);

    // 3. clearText missing selector fails
    let req3 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "clearText"
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp3 = app.clone().oneshot(req3).await.unwrap();
    assert_eq!(resp3.status(), StatusCode::BAD_REQUEST);

    // 4. clearText with valid selector succeeds
    let req4 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "clearText",
                "selector": { "resourceId": "io.andrui.terminal:id/input_user" }
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp4 = app.clone().oneshot(req4).await.unwrap();
    assert_eq!(resp4.status(), StatusCode::OK);

    // 5. swipe without coordinates or selector fails
    let req5 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "swipe"
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp5 = app.clone().oneshot(req5).await.unwrap();
    assert_eq!(resp5.status(), StatusCode::BAD_REQUEST);

    // 6. swipe with coordinates succeeds
    let req6 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "swipe",
                "startX": 100.0,
                "startY": 500.0,
                "endX": 100.0,
                "endY": 100.0,
                "durationMs": 250
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp6 = app.clone().oneshot(req6).await.unwrap();
    assert_eq!(resp6.status(), StatusCode::OK);

    // 7. swipe on selector with direction succeeds
    let req7 = Request::builder()
        .method("POST")
        .uri("/api/v1/automation/actions")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from(
            serde_json::to_vec(&serde_json::json!({
                "deviceId": dev_id,
                "action": "swipe",
                "selector": { "className": "android.widget.ScrollView" },
                "direction": "up"
            }))
            .unwrap(),
        ))
        .unwrap();
    let resp7 = app.clone().oneshot(req7).await.unwrap();
    assert_eq!(resp7.status(), StatusCode::OK);

    assert_eq!(count.load(Ordering::SeqCst), 4);
}

#[tokio::test]
async fn test_screenshot_adb_fallback_and_marks_without_session() {
    use base64::prelude::*;
    use std::os::unix::fs::PermissionsExt;

    let temp_dir = TempDir::new().unwrap();
    let png_path = temp_dir.path().join("screen.png");
    let png_bytes = BASE64_STANDARD
        .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
        .unwrap();
    std::fs::write(&png_path, &png_bytes).unwrap();

    let adb_script = temp_dir.path().join("mock-adb.sh");
    let script_body = format!(
        r#"#!/bin/sh
if [ "$3" = "exec-out" ] && [ "$4" = "screencap" ]; then
  cat "{}"
  exit 0
fi
if [ "$3" = "exec-out" ] && [ "$4" = "uiautomator" ]; then
  printf '<?xml version="1.0" encoding="UTF-8"?><hierarchy rotation="0"><node text="OK" class="android.widget.Button" clickable="true" bounds="[0,0][1,1]"/></hierarchy>'
  exit 0
fi
exit 1
"#,
        png_path.display()
    );
    std::fs::write(&adb_script, script_body).unwrap();
    std::fs::set_permissions(&adb_script, std::fs::Permissions::from_mode(0o755)).unwrap();

    let mut state = create_test_state(&temp_dir);
    state.config = andrui_automation::config::ExtensionsConfig {
        adb_path: adb_script,
        data_dir: state.config.data_dir.clone(),
        helper_apk: state.config.helper_apk.clone(),
    };
    let app = router_with_state(state);

    // 1. Plain screenshot without active session falls back to adb screencap
    let req = Request::builder()
        .uri("/api/v1/automation/screenshot?deviceId=adb-dev-1")
        .body(Body::empty())
        .unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(
        resp.headers().get(header::CONTENT_TYPE).unwrap(),
        "image/png"
    );
    let body = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    assert_eq!(&body[0..8], b"\x89PNG\r\n\x1a\n");

    // 2. Marked screenshot without active session uses adb screencap + uiautomator dump fallback
    let req_marks = Request::builder()
        .uri("/api/v1/automation/screenshot?deviceId=adb-dev-1&marks=true&format=json")
        .body(Body::empty())
        .unwrap();
    let resp_marks = app.clone().oneshot(req_marks).await.unwrap();
    assert_eq!(resp_marks.status(), StatusCode::OK);
    let json: Value =
        serde_json::from_slice(&to_bytes(resp_marks.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    let marked_png = BASE64_STANDARD
        .decode(json["pngBase64"].as_str().unwrap())
        .unwrap();
    assert_eq!(&marked_png[0..8], b"\x89PNG\r\n\x1a\n");
    assert_eq!(json["nodes"].as_array().unwrap().len(), 1);
    assert_eq!(json["nodes"][0]["text"], "OK");

    // 3. Explicit fallback=false still returns 404 session_not_found
    let req_no_fallback = Request::builder()
        .uri("/api/v1/automation/screenshot?deviceId=adb-dev-1&fallback=false")
        .body(Body::empty())
        .unwrap();
    let resp_no_fallback = app.oneshot(req_no_fallback).await.unwrap();
    assert_eq!(resp_no_fallback.status(), StatusCode::NOT_FOUND);
}
