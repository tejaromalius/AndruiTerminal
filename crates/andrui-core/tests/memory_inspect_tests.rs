use andrui_core::adb::executor::AdbExecutor;
use andrui_core::inspect::memory;

fn fixture_adb() -> AdbExecutor {
    let adb = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
    AdbExecutor::new(adb)
}

#[tokio::test]
async fn memory_report_parses_dumpsys() {
    let r = memory::memory_report(&fixture_adb(), "RF8M10ABCDE", "com.example.app")
        .await
        .unwrap();
    assert!(r.available);
    assert_eq!(r.summary.pid, Some(4567));
    assert_eq!(r.summary.total_pss_kb, Some(12454));
    assert_eq!(r.summary.graphics_kb, Some(3000));
}

#[tokio::test]
async fn heapdump_requires_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let artifacts = andrui_core::storage::artifacts::ArtifactStore::new(dir.path());
    let db = andrui_core::storage::db::Database::in_memory().unwrap();
    let err = memory::capture_heap_dump(
        &fixture_adb(),
        &artifacts,
        &db,
        "RF8M10ABCDE",
        "com.example.app",
        false,
        false,
    )
    .await
    .unwrap_err();
    assert!(err.to_string().contains("confirmation"));
}

#[tokio::test]
async fn heapdump_captures_artifact_when_confirmed() {
    let dir = tempfile::tempdir().unwrap();
    let artifacts = andrui_core::storage::artifacts::ArtifactStore::new(dir.path());
    artifacts.init().await.unwrap();
    let db = andrui_core::storage::db::Database::in_memory().unwrap();
    let r = memory::capture_heap_dump(
        &fixture_adb(),
        &artifacts,
        &db,
        "RF8M10ABCDE",
        "com.example.app",
        false,
        true,
    )
    .await
    .unwrap();
    assert!(!r.artifact_id.is_empty());
    assert!(r.size_bytes > 0);
    assert!(!r.native);
}
