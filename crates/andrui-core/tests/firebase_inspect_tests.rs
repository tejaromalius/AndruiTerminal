use andrui_core::adb::executor::AdbExecutor;
use andrui_core::inspect::firebase;

fn fixture_adb() -> AdbExecutor {
    let adb = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
    AdbExecutor::new(adb)
}

#[tokio::test]
async fn local_report_runs_against_fake_device() {
    let helper = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../helper-apk/build/andrui-helper.apk");
    if !helper.exists() {
        eprintln!("skipping: helper APK not built");
        return;
    }
    let r = firebase::local_report(&fixture_adb(), "RF8M10ABCDE", "com.example.app")
        .await
        .unwrap();
    assert_eq!(r.package, "com.example.app");
    // Helper APK has no Firebase, but the report structure is always populated.
    assert!(r
        .emulator_ports
        .iter()
        .any(|p| p.service == "firestore" && p.port == 8080));
    assert!(r.log_tags.contains(&"FA"));
}

#[tokio::test]
async fn debug_toggle_requires_confirmation() {
    let err = firebase::set_debug_logging(
        &fixture_adb(),
        "RF8M10ABCDE",
        "com.example.app",
        true,
        false,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("confirmation"));
}

#[tokio::test]
async fn debug_toggle_runs_setprops_when_confirmed() {
    let r =
        firebase::set_debug_logging(&fixture_adb(), "RF8M10ABCDE", "com.example.app", true, true)
            .await
            .unwrap();
    assert!(r.enabled);
    assert!(r
        .commands
        .iter()
        .any(|c| c.contains("debug.firebase.analytics.app com.example.app")));
    assert!(r.commands.iter().any(|c| c.contains("log.tag.FA VERBOSE")));
}

#[tokio::test]
async fn emulator_reverse_sets_all_ports() {
    let ports = firebase::setup_emulator_reverse(&fixture_adb(), "RF8M10ABCDE", true)
        .await
        .unwrap();
    assert_eq!(ports.len(), 6);
}

#[tokio::test]
async fn fcm_send_requires_confirmation() {
    let req: firebase::FcmSendRequest = serde_json::from_value(serde_json::json!({
        "serviceAccountEnv": "DOES_NOT_EXIST_ENV",
        "projectId": "demo",
        "token": "abc",
        "title": "t",
        "body": "b",
        "confirmed": false
    }))
    .unwrap();
    let err = firebase::fcm_send(&req).await.unwrap_err();
    assert!(err.to_string().contains("confirmation"));
}
