use andrui_core::adb::executor::AdbExecutor;
use andrui_core::inspect::database::{self, DbSnapshotStore};

fn fixture_adb() -> AdbExecutor {
    let adb = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
    AdbExecutor::new(adb)
}

#[tokio::test]
async fn access_probe_reports_runas_for_debuggable_app() {
    let probe = database::probe_access(&fixture_adb(), "RF8M10ABCDE", "com.example.app")
        .await
        .unwrap();
    assert!(probe.debuggable);
    assert!(!probe.root_available);
    assert_eq!(probe.mode, Some(database::AccessMode::RunAs));
}

#[tokio::test]
async fn list_finds_sqlite_database() {
    let (mode, dbs) = database::list_databases(&fixture_adb(), "RF8M10ABCDE", "com.example.app")
        .await
        .unwrap();
    assert_eq!(mode, database::AccessMode::RunAs);
    let app = dbs
        .iter()
        .find(|d| d.name == "app.db")
        .expect("app.db listed");
    assert!(app.sqlite, "app.db should be detected as SQLite");
    assert!(!app.encrypted);
}

#[tokio::test]
async fn snapshot_then_query_and_edit() {
    let dir = tempfile::tempdir().unwrap();
    let store = DbSnapshotStore::new(dir.path());
    let meta = database::take_snapshot(
        &fixture_adb(),
        &store,
        "RF8M10ABCDE",
        "com.example.app",
        "app.db",
    )
    .await
    .unwrap();
    assert_eq!(meta.database_name, "app.db");
    assert_eq!(meta.sha256.len(), 64);

    let path = store.db_path(&meta.id).unwrap();
    let schema = database::schema(&path).unwrap();
    let names: Vec<_> = schema["tables"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["name"].as_str().unwrap().to_string())
        .collect();
    assert!(names.contains(&"users".to_string()));

    let res = database::query(&path, "SELECT name, score FROM users ORDER BY score", 100).unwrap();
    assert_eq!(res.rows.len(), 2);
    assert_eq!(res.rows[0][0], serde_json::json!("alice"));

    // Read-only query rejects a write.
    assert!(database::query(&path, "DELETE FROM users", 100).is_err());

    // Editing the host copy works and does not touch the device.
    let edit = database::execute(&path, "UPDATE users SET score=99 WHERE name='alice'").unwrap();
    assert_eq!(edit.rows_affected, Some(1));
    let after = database::query(&path, "SELECT score FROM users WHERE name='alice'", 10).unwrap();
    assert_eq!(after.rows[0][0], serde_json::json!(99));

    // Listing and metadata survive a round trip.
    let listed = store.list().await.unwrap();
    assert_eq!(listed.len(), 1);
    assert_eq!(listed[0].id, meta.id);
}

#[tokio::test]
async fn push_requires_confirmation() {
    let dir = tempfile::tempdir().unwrap();
    let store = DbSnapshotStore::new(dir.path());
    let artifacts = andrui_core::storage::artifacts::ArtifactStore::new(dir.path());
    let db = andrui_core::storage::db::Database::in_memory().unwrap();
    let meta = database::take_snapshot(
        &fixture_adb(),
        &store,
        "RF8M10ABCDE",
        "com.example.app",
        "app.db",
    )
    .await
    .unwrap();
    let err = database::push_snapshot(&fixture_adb(), &store, &artifacts, &db, &meta.id, false)
        .await
        .unwrap_err();
    assert!(err.to_string().contains("confirmation"));
}
