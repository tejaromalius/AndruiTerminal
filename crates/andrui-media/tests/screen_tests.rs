use andrui_media::{
    adb::{capture_screencap_png, is_valid_png},
    config::MediaConfig,
    error::MediaError,
    protocol::{
        parse_video_metadata, serialize_back_or_screen_on, serialize_inject_keycode,
        serialize_inject_scroll, serialize_inject_text, serialize_inject_touch,
        serialize_set_clipboard, serialize_set_display_power, VideoCodec, DEVICE_NAME_FIELD_LENGTH,
    },
    router, screen_router,
};
use axum::{
    body::{to_bytes, Body},
    http::{Request, StatusCode},
};
use bytes::{BufMut, BytesMut};
use std::path::PathBuf;
use tower::ServiceExt; // for oneshot

fn get_fake_adb_path() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    // Go up two levels: crates/andrui-media -> .. -> .. -> tests/fixtures/adb
    let p = manifest_dir.join("../../tests/fixtures/adb");
    p.canonicalize().unwrap_or(p)
}

fn get_test_data_dir() -> PathBuf {
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("../../tests/fixtures/data")
}

#[tokio::test]
async fn test_screencap_png_valid_device() {
    let adb = get_fake_adb_path();
    let res = capture_screencap_png(&adb, "RF8M10ABCDE").await;
    assert!(
        res.is_ok(),
        "Expected screencap to succeed on valid device: {:?}",
        res.err()
    );
    let bytes = res.unwrap();
    assert!(is_valid_png(&bytes));
    assert!(!bytes.is_empty());
}

#[tokio::test]
async fn test_screencap_png_device_offline() {
    let adb = get_fake_adb_path();
    let res = capture_screencap_png(&adb, "offline-device-01").await;
    assert!(res.is_err());
    match res.unwrap_err() {
        MediaError::DeviceOffline(_) => {}
        other => panic!("Expected DeviceOffline error, got: {:?}", other),
    }
}

#[tokio::test]
async fn test_screencap_png_device_not_found() {
    let adb = get_fake_adb_path();
    let res = capture_screencap_png(&adb, "nonexistent").await;
    assert!(res.is_err());
    match res.unwrap_err() {
        MediaError::NotFound(_) => {}
        other => panic!("Expected NotFound error, got: {:?}", other),
    }
}

#[tokio::test]
async fn test_screencap_png_empty_device_id() {
    let adb = get_fake_adb_path();
    let res = capture_screencap_png(&adb, "   ").await;
    assert!(res.is_err());
    match res.unwrap_err() {
        MediaError::BadRequest(_) => {}
        other => panic!("Expected BadRequest error, got: {:?}", other),
    }
}

#[tokio::test]
async fn test_capabilities_endpoint() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    let req = Request::builder()
        .uri("/api/v1/screen/capabilities")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert!(v["adbAvailable"].as_bool().unwrap());
    assert!(v["supportedVideoCodecs"].is_array());
    assert_eq!(v["supportedVideoCodecs"][0], "h264");
    assert_eq!(v["scrcpyServer"]["version"], "3.3.1");
}

#[tokio::test]
async fn test_capture_endpoint_json_dataurl() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    let req = Request::builder()
        .uri("/api/v1/screen/capture?deviceId=RF8M10ABCDE")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);

    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    let data_url = v["dataUrl"].as_str().expect("dataUrl must be a string");
    assert!(data_url.starts_with("data:image/png;base64,"));
}

#[tokio::test]
async fn test_screenshot_endpoint_raw_png() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    let req = Request::builder()
        .uri("/api/v1/screen/screenshot?deviceId=RF8M10ABCDE")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    assert_eq!(resp.headers().get("content-type").unwrap(), "image/png");

    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    assert!(is_valid_png(&body_bytes));
}

#[tokio::test]
async fn test_sessions_endpoint_validation_missing_device() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    let body = serde_json::json!({
        "deviceId": "",
        "videoCodec": "h264"
    });

    let req = Request::builder()
        .uri("/api/v1/screen/sessions")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(v["error"]["code"], "BAD_REQUEST");
}

#[tokio::test]
async fn test_sessions_endpoint_validation_invalid_codec() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    let body = serde_json::json!({
        "deviceId": "RF8M10ABCDE",
        "videoCodec": "vp9_unsupported"
    });

    let req = Request::builder()
        .uri("/api/v1/screen/sessions")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);

    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Unsupported video codec"));
}

#[tokio::test]
async fn test_protocol_metadata_parsing() {
    let mut buf = BytesMut::new();

    // 64 bytes device name
    let mut name = [0u8; DEVICE_NAME_FIELD_LENGTH];
    let sample_name = b"Pixel 8 Pro";
    name[..sample_name.len()].copy_from_slice(sample_name);
    buf.put_slice(&name);

    // 4 bytes codec: H264
    buf.put_u32(VideoCodec::H264.to_fourcc());
    // 4 bytes width: 1080
    buf.put_u32(1080);
    // 4 bytes height: 2400
    buf.put_u32(2400);

    let meta = parse_video_metadata(&mut buf).expect("Metadata parsing should succeed");
    assert_eq!(meta.device_name, "Pixel 8 Pro");
    assert_eq!(meta.codec, "h264");
    assert_eq!(meta.width, 1080);
    assert_eq!(meta.height, 2400);
    assert_eq!(buf.len(), 0);
}

#[tokio::test]
async fn test_protocol_control_messages_serialization() {
    // Inject Keycode
    let key_msg = serialize_inject_keycode(0, 3, 0, 0); // KEYCODE_HOME down
    assert_eq!(key_msg[0], 0); // InjectKeyCode type
    assert_eq!(key_msg[1], 0); // Action down
    assert_eq!(key_msg.len(), 14);

    // Inject Text
    let text_msg = serialize_inject_text("hello");
    assert_eq!(text_msg[0], 1); // InjectText type
    assert_eq!(text_msg.len(), 1 + 4 + 5);

    // Inject Touch
    let touch_msg = serialize_inject_touch(0, 1, 500, 800, 1080, 2400, 65535, 1, 1);
    assert_eq!(touch_msg[0], 2); // InjectTouch type
    assert_eq!(touch_msg.len(), 32);

    // Inject Scroll
    let scroll_msg = serialize_inject_scroll(500, 800, 1080, 2400, 0, -100, 0);
    assert_eq!(scroll_msg[0], 3); // InjectScroll type

    // Back or screen on
    let back_msg = serialize_back_or_screen_on(0);
    assert_eq!(back_msg[0], 4);

    // Set clipboard
    let clip_msg = serialize_set_clipboard(42, true, "paste text");
    assert_eq!(clip_msg[0], 9);

    // Set display power
    let power_msg = serialize_set_display_power(2);
    assert_eq!(power_msg[0], 10);
    assert_eq!(power_msg[1], 2);
}

#[tokio::test]
async fn test_delete_nonexistent_session() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    let req = Request::builder()
        .uri("/api/v1/screen/sessions/nonexistent-session-id")
        .method("DELETE")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn test_screen_router_prefix() {
    // Test that screen_router mounts without /api/v1/screen prefix
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = screen_router(config);

    let req = Request::builder()
        .uri("/capabilities")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn test_forward_mode_dummy_byte_and_fragmented_stream() {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();

    let server_task = tokio::spawn(async move {
        let (mut socket, _) = listener.accept().await.unwrap();
        // 1. Send single dummy byte
        socket.write_all(&[0x00]).await.unwrap();

        // 2. Send 64-byte device name fragmented into two slices
        let mut name = [0u8; 64];
        name[..5].copy_from_slice(b"Emu01");
        socket.write_all(&name[..30]).await.unwrap();
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        socket.write_all(&name[30..]).await.unwrap();

        // 3. Send codec header (h264, 1080x1920)
        let mut header = [0u8; 12];
        header[..4].copy_from_slice(&0x68323634u32.to_be_bytes());
        header[4..8].copy_from_slice(&1080u32.to_be_bytes());
        header[8..12].copy_from_slice(&1920u32.to_be_bytes());
        socket.write_all(&header).await.unwrap();
    });

    let client_task = tokio::spawn(async move {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();

        // Read dummy byte
        let mut dummy = [0u8; 1];
        stream.read_exact(&mut dummy).await.unwrap();
        assert_eq!(dummy[0], 0x00);

        // Read metadata
        let mut buf = BytesMut::new();
        let mut temp = [0u8; 1024];
        while buf.len() < 64 + 12 {
            let n = stream.read(&mut temp).await.unwrap();
            if n == 0 {
                break;
            }
            buf.put_slice(&temp[..n]);
        }
        let meta = parse_video_metadata(&mut buf).unwrap();
        assert_eq!(meta.device_name, "Emu01");
        assert_eq!(meta.codec, "h264");
        assert_eq!(meta.width, 1080);
        assert_eq!(meta.height, 1920);
    });

    let (s, c) = tokio::join!(server_task, client_task);
    s.unwrap();
    c.unwrap();
}

#[tokio::test]
async fn test_nofake_recording_endpoints_return_501() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    // Test POST /recordings
    let req = Request::builder()
        .uri("/api/v1/screen/sessions/test-session-123/recordings")
        .method("POST")
        .header("content-type", "application/json")
        .body(Body::from("{}"))
        .unwrap();

    let resp = app.clone().oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::NOT_IMPLEMENTED);
    let body_bytes = to_bytes(resp.into_body(), 1024 * 1024).await.unwrap();
    let v: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
    assert_eq!(v["error"]["code"], "NOT_IMPLEMENTED");
    assert!(v["error"]["message"]
        .as_str()
        .unwrap()
        .contains("Server-side session recording is unsupported"));

    // Test DELETE /recordings/current
    let req2 = Request::builder()
        .uri("/api/v1/screen/sessions/test-session-123/recordings/current")
        .method("DELETE")
        .body(Body::empty())
        .unwrap();

    let resp2 = app.oneshot(req2).await.unwrap();
    assert_eq!(resp2.status(), StatusCode::NOT_IMPLEMENTED);
    let body_bytes2 = to_bytes(resp2.into_body(), 1024 * 1024).await.unwrap();
    let v2: serde_json::Value = serde_json::from_slice(&body_bytes2).unwrap();
    assert_eq!(v2["error"]["code"], "NOT_IMPLEMENTED");
}

#[tokio::test]
async fn test_screenshot_malformed_newlines_in_device_id() {
    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb, data_dir, None);
    let app = router(config);

    // deviceId with CR and LF characters that previously caused HeaderValue::parse unwrap panic
    let req = Request::builder()
        .uri("/api/v1/screen/screenshot?deviceId=RF8M10ABCDE%0D%0AInjected-Header:%20malicious%0D%0A")
        .method("GET")
        .body(Body::empty())
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    // Must not panic! Should succeed or return clean error response with valid static Content-Disposition header
    assert_eq!(resp.status(), StatusCode::OK);
    let cd = resp
        .headers()
        .get("content-disposition")
        .expect("content-disposition header must be present");
    assert_eq!(cd, "inline; filename=\"device-screenshot.png\"");
}

#[tokio::test]
async fn test_metadata_retained_across_delayed_attach_and_fragmented_frames() {
    use bytes::Bytes;
    use tokio::sync::mpsc;

    // Simulate bounded lossless per-session mpsc channel
    let (tx, mut rx) = mpsc::channel::<Bytes>(512);

    // Frame fragmentation: Send metadata split across multiple irregular byte slices
    // scrcpy metadata: 64 bytes device name + 4 bytes codec + 4 bytes width + 4 bytes height
    let mut expected_name = [0u8; 64];
    expected_name[..10].copy_from_slice(b"Pixel8-Sim");

    let mut full_meta = BytesMut::new();
    full_meta.put_slice(&expected_name);
    full_meta.put_u32(VideoCodec::H264.to_fourcc()); // "h264"
    full_meta.put_u32(1080);
    full_meta.put_u32(2400);
    let full_meta_bytes = full_meta.freeze();

    // Pump pushes fragmented chunks into channel BEFORE subscriber starts reading (delayed attach)
    let chunk1 = full_meta_bytes.slice(0..15);
    let chunk2 = full_meta_bytes.slice(15..45);
    let chunk3 = full_meta_bytes.slice(45..70);
    let chunk4 = full_meta_bytes.slice(70..full_meta_bytes.len());

    tx.send(chunk1).await.unwrap();
    tx.send(chunk2).await.unwrap();
    tx.send(chunk3).await.unwrap();
    tx.send(chunk4).await.unwrap();

    // Also push a video packet frame chunk
    tx.send(Bytes::from_static(b"\x00\x00\x00\x01\x67\x42\x00\x1f"))
        .await
        .unwrap();

    // DELAY: Subscriber attaches after a delay
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;

    // Subscriber receives all chunks lossless and reassembles metadata
    let mut assembled = BytesMut::new();
    while assembled.len() < 64 + 12 {
        let chunk = rx
            .recv()
            .await
            .expect("channel should have enqueued chunks");
        assembled.put_slice(&chunk);
    }

    let meta =
        parse_video_metadata(&mut assembled).expect("Delayed attach must parse complete metadata");
    assert_eq!(meta.device_name, "Pixel8-Sim");
    assert_eq!(meta.codec, "h264");
    assert_eq!(meta.width, 1080);
    assert_eq!(meta.height, 2400);

    // Verify next packet is intact
    let remaining = rx.recv().await.expect("Follow-up frame must be preserved");
    assert_eq!(&remaining[..], b"\x00\x00\x00\x01\x67\x42\x00\x1f");
}

#[tokio::test]
async fn test_cleanup_all_sessions() {
    use andrui_media::{AppState, ScreenSession, SessionCapabilities};
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;
    use tokio::sync::{mpsc, Mutex, RwLock};

    let adb = get_fake_adb_path();
    let data_dir = get_test_data_dir();
    let config = MediaConfig::new(adb.clone(), data_dir, None);
    let sessions = Arc::new(RwLock::new(std::collections::HashMap::new()));
    let state = AppState {
        config: config.clone(),
        sessions: sessions.clone(),
    };

    // Insert two active mock sessions
    for i in 1..=2 {
        let (_v_tx, v_rx) = mpsc::channel(10);
        let (c_tx, c_rx) = mpsc::channel(10);
        let sess = Arc::new(ScreenSession {
            id: format!("sess-{}", i),
            device_id: "RF8M10ABCDE".to_string(),
            forward_port: 45000 + i,
            scid: 1000 + i as u32,
            capabilities: SessionCapabilities {
                video_codec: "h264".to_string(),
                audio: false,
                max_size: 1080,
                bit_rate: 8000000,
                max_fps: 60,
                display_id: 0,
            },
            video_rx: Mutex::new(Some(v_rx)),
            audio_rx: None,
            control_tx: c_tx,
            control_rx: Mutex::new(Some(c_rx)),
            child_process: Arc::new(Mutex::new(None)),
            adb_path: adb.clone(),
            abort_handles: Mutex::new(Vec::new()),
            is_stopped: AtomicBool::new(false),
        });
        sessions.write().await.insert(format!("sess-{}", i), sess);
    }

    assert_eq!(sessions.read().await.len(), 2);

    // Invoke cleanup_all_sessions
    state.cleanup_all_sessions().await;

    // Verify map is drained
    assert_eq!(sessions.read().await.len(), 0);
}

#[tokio::test]
async fn test_audio_packet_framing_and_metadata_fixtures() {
    use andrui_media::protocol::{
        parse_audio_metadata, parse_audio_packet, serialize_audio_packet, AudioCodec,
        AudioStreamMetadata,
    };

    // 1. Audio metadata FourCC tests
    let mut opus_buf = BytesMut::from(&0x6f707573u32.to_be_bytes()[..]); // "opus"
    let meta = parse_audio_metadata(&mut opus_buf).unwrap();
    assert_eq!(meta, AudioStreamMetadata::Success(AudioCodec::Opus));

    let mut aac_buf = BytesMut::from(&0x00616163u32.to_be_bytes()[..]); // "aac"
    let meta = parse_audio_metadata(&mut aac_buf).unwrap();
    assert_eq!(meta, AudioStreamMetadata::Success(AudioCodec::Aac));

    let mut dis_buf = BytesMut::from(&0x00000000u32.to_be_bytes()[..]);
    let meta = parse_audio_metadata(&mut dis_buf).unwrap();
    assert_eq!(meta, AudioStreamMetadata::Disabled);

    let mut err_buf = BytesMut::from(&0x00000001u32.to_be_bytes()[..]);
    let meta = parse_audio_metadata(&mut err_buf).unwrap();
    assert_eq!(meta, AudioStreamMetadata::Errored);

    // 2. Audio packet framing: Config packet
    let config_payload = [0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64]; // "OpusHead"
    let config_pkt = serialize_audio_packet(0, true, false, &config_payload);
    let mut parse_buf = BytesMut::from(&config_pkt[..]);
    let parsed = parse_audio_packet(&mut parse_buf).expect("Config packet should parse");
    assert!(parsed.is_config);
    assert!(!parsed.is_keyframe);
    assert_eq!(&parsed.data[..], &config_payload[..]);

    // 3. Audio packet framing: Keyframe data packet
    let data_payload = [0xf8, 0xff, 0xfe, 0x01, 0x02];
    let data_pkt = serialize_audio_packet(48000, false, true, &data_payload);
    let mut parse_buf2 = BytesMut::from(&data_pkt[..]);
    let parsed2 = parse_audio_packet(&mut parse_buf2).expect("Keyframe packet should parse");
    assert!(!parsed2.is_config);
    assert!(parsed2.is_keyframe);
    assert_eq!(parsed2.pts, 48000);
    assert_eq!(&parsed2.data[..], &data_payload[..]);
}
