//! App-private SQLite database inspection and editing.
//!
//! Databases inside an app's sandbox (`/data/data/<pkg>/databases/`) are only
//! reachable when the app is debuggable (via `run-as`) or on a rooted/userdebug
//! build (via `su`). This module probes which access path is available, pulls a
//! database (with its `-wal`/`-shm` sidecars) to a host snapshot, and runs
//! queries and edits against that local copy with rusqlite. Writing changes
//! back to the device is a separate, explicitly confirmed catalog job
//! (`database.push`) and never happens implicitly here.

use std::path::{Path, PathBuf};
use std::time::Duration;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::{require_device, require_package};
use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};

const MAX_DB_BYTES: usize = 512 * 1024 * 1024;
const SQLITE_MAGIC: &[u8] = b"SQLite format 3\0";

/// How an app's private data can be reached on a given device.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AccessMode {
    /// Debuggable app: commands run via `run-as <pkg>`.
    RunAs,
    /// Rooted/userdebug build: commands run via `su 0`.
    Root,
}

impl AccessMode {
    fn as_str(self) -> &'static str {
        match self {
            AccessMode::RunAs => "run-as",
            AccessMode::Root => "root",
        }
    }
}

/// Result of probing how (or whether) an app's sandbox can be reached.
#[derive(Debug, Clone, Serialize)]
pub struct AccessProbe {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub package: String,
    pub mode: Option<AccessMode>,
    pub debuggable: bool,
    #[serde(rename = "rootAvailable")]
    pub root_available: bool,
    pub reason: Option<String>,
}

/// A database file discovered in the app sandbox.
#[derive(Debug, Clone, Serialize)]
pub struct DatabaseEntry {
    pub name: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: Option<u64>,
    /// True when the file begins with the SQLite magic header.
    pub sqlite: bool,
    /// True for a non-SQLite header that looks encrypted (e.g. SQLCipher).
    pub encrypted: bool,
}

/// Metadata persisted alongside a pulled database snapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotMeta {
    pub id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub package: String,
    #[serde(rename = "databaseName")]
    pub database_name: String,
    pub mode: AccessMode,
    #[serde(rename = "sha256")]
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "hadWal")]
    pub had_wal: bool,
    #[serde(rename = "createdAt")]
    pub created_at: String,
}

/// A resolved device path for a database file inside the sandbox.
fn db_relative_path(name: &str) -> ApiResult<String> {
    // Names come from `ls databases/`; keep them confined to that directory.
    if name.is_empty()
        || name.len() > 255
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        || name.starts_with('.')
    {
        return Err(ApiError::bad_request(
            "INVALID_DATABASE",
            "Unsupported database file name",
        ));
    }
    Ok(format!("databases/{name}"))
}

/// Build the argv that runs `inner` (a program and its args) as the app/root.
fn wrap_access(
    device_id: &str,
    mode: AccessMode,
    binary: &str,
    inner: &[&str],
    package: &str,
) -> Vec<String> {
    let mut args = vec!["-s".to_string(), device_id.to_string(), binary.to_string()];
    match mode {
        AccessMode::RunAs => {
            args.push("run-as".to_string());
            args.push(package.to_string());
        }
        AccessMode::Root => {
            args.push("su".to_string());
            args.push("0".to_string());
        }
    }
    args.extend(inner.iter().map(|s| s.to_string()));
    args
}

/// Probe whether the app is debuggable (run-as) and/or root is available.
pub async fn probe_access(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> ApiResult<AccessProbe> {
    require_device(device_id)?;
    require_package(package)?;
    let timeout = Some(Duration::from_secs(15));

    // run-as succeeds only for a debuggable, installed app.
    let run_as = executor
        .execute(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "run-as".into(),
                package.into(),
                "id".into(),
            ],
            timeout,
            None,
        )
        .await?;
    let debuggable = run_as.exit_code == 0 && run_as.stdout.contains("uid=");

    // `su 0 id` returns uid=0 on a rooted/userdebug build.
    let root = executor
        .execute(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "su".into(),
                "0".into(),
                "id".into(),
            ],
            timeout,
            None,
        )
        .await?;
    let root_available = root.exit_code == 0 && root.stdout.contains("uid=0");

    let mode = if debuggable {
        Some(AccessMode::RunAs)
    } else if root_available {
        Some(AccessMode::Root)
    } else {
        None
    };
    let reason = if mode.is_none() {
        Some(format!(
            "App '{package}' is not debuggable and root is unavailable; its private databases cannot be read over ADB. run-as: {}",
            run_as.stderr.trim().lines().next().unwrap_or("denied")
        ))
    } else {
        None
    };

    Ok(AccessProbe {
        device_id: device_id.to_string(),
        package: package.to_string(),
        mode,
        debuggable,
        root_available,
        reason,
    })
}

/// List the database files in an app's `databases/` directory.
pub async fn list_databases(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> ApiResult<(AccessMode, Vec<DatabaseEntry>)> {
    let probe = probe_access(executor, device_id, package).await?;
    let mode = probe.mode.ok_or_else(|| {
        ApiError::bad_request(
            "ACCESS_UNAVAILABLE",
            probe
                .reason
                .unwrap_or_else(|| "App sandbox not accessible".into()),
        )
    })?;

    // List names and sizes: `ls -l databases` (run-as chdirs to the app home).
    let target = match mode {
        AccessMode::RunAs => "databases",
        AccessMode::Root => return list_databases_root(executor, device_id, package, mode).await,
    };
    let args = wrap_access(device_id, mode, "shell", &["ls", "-l", target], package);
    let out = executor
        .execute(&args, Some(Duration::from_secs(20)), None)
        .await?;
    if out.exit_code != 0 {
        // No databases directory is not an error; report an empty list.
        if out.stderr.contains("No such file") {
            return Ok((mode, Vec::new()));
        }
        return Err(ApiError::bad_request(
            "DB_LIST_FAILED",
            out.stderr
                .trim()
                .lines()
                .next()
                .unwrap_or("listing failed")
                .to_string(),
        ));
    }
    let names = parse_ls_names(&out.stdout);
    let mut entries = Vec::new();
    for (name, size) in names {
        let (sqlite, encrypted) = probe_header(executor, device_id, package, mode, &name).await;
        entries.push(DatabaseEntry {
            name,
            size_bytes: size,
            sqlite,
            encrypted,
        });
    }
    Ok((mode, entries))
}

async fn list_databases_root(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
    mode: AccessMode,
) -> ApiResult<(AccessMode, Vec<DatabaseEntry>)> {
    let dir = format!("/data/data/{package}/databases");
    let args = wrap_access(device_id, mode, "shell", &["ls", "-l", &dir], package);
    let out = executor
        .execute(&args, Some(Duration::from_secs(20)), None)
        .await?;
    if out.exit_code != 0 {
        if out.stderr.contains("No such file") {
            return Ok((mode, Vec::new()));
        }
        return Err(ApiError::bad_request(
            "DB_LIST_FAILED",
            out.stderr
                .trim()
                .lines()
                .next()
                .unwrap_or("listing failed")
                .to_string(),
        ));
    }
    let names = parse_ls_names(&out.stdout);
    let mut entries = Vec::new();
    for (name, size) in names {
        let (sqlite, encrypted) = probe_header(executor, device_id, package, mode, &name).await;
        entries.push(DatabaseEntry {
            name,
            size_bytes: size,
            sqlite,
            encrypted,
        });
    }
    Ok((mode, entries))
}

/// Read the first 16 bytes of a database file to classify it.
async fn probe_header(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
    mode: AccessMode,
    name: &str,
) -> (bool, bool) {
    let rel = match db_relative_path(name) {
        Ok(r) => r,
        Err(_) => return (false, false),
    };
    let path = match mode {
        AccessMode::RunAs => rel,
        AccessMode::Root => format!("/data/data/{package}/{rel}"),
    };
    let args = wrap_access(device_id, mode, "exec-out", &["cat", &path], package);
    match executor
        .execute_prefix(&args, 64, Duration::from_secs(20))
        .await
    {
        Ok(head) => {
            let sqlite = head.starts_with(SQLITE_MAGIC);
            // Non-empty, non-SQLite header with high-entropy bytes => likely encrypted.
            let encrypted = !sqlite && head.len() >= 16 && head.iter().any(|&b| b > 0x7f);
            (sqlite, encrypted)
        }
        _ => (false, false),
    }
}

/// Parse `ls -l` output into (name, size) pairs, skipping directories.
fn parse_ls_names(stdout: &str) -> Vec<(String, Option<u64>)> {
    let mut out = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with("total ") {
            continue;
        }
        if line.starts_with('d') {
            continue; // directory
        }
        // -rw-rw---- 1 u0_a1 u0_a1 20480 2024-01-01 12:00 app.db
        let cols: Vec<&str> = line.split_whitespace().collect();
        if cols.len() >= 8 && cols[0].len() >= 10 {
            let size = cols[4].parse::<u64>().ok();
            let name = cols[7..].join(" ");
            if !name.is_empty() {
                out.push((name, size));
            }
        } else if cols.len() == 1 {
            // Bare `ls` fallback (names only).
            out.push((cols[0].to_string(), None));
        }
    }
    out
}

/// Stored snapshots of pulled databases, kept under the application data dir.
#[derive(Clone)]
pub struct DbSnapshotStore {
    root: PathBuf,
}

impl DbSnapshotStore {
    pub fn new(data_dir: impl AsRef<Path>) -> Self {
        Self {
            root: data_dir.as_ref().join("db-snapshots"),
        }
    }

    fn dir(&self, id: &str) -> ApiResult<PathBuf> {
        if Uuid::parse_str(id).is_err() {
            return Err(ApiError::bad_request("INVALID_ID", "Invalid snapshot id"));
        }
        Ok(self.root.join(id))
    }

    /// Path to the main database file of a snapshot.
    pub fn db_path(&self, id: &str) -> ApiResult<PathBuf> {
        Ok(self.dir(id)?.join("main.db"))
    }

    pub async fn meta(&self, id: &str) -> ApiResult<SnapshotMeta> {
        let path = self.dir(id)?.join("meta.json");
        let text = tokio::fs::read_to_string(&path)
            .await
            .map_err(|_| ApiError::not_found("SNAPSHOT_NOT_FOUND", "Snapshot not found"))?;
        serde_json::from_str(&text)
            .map_err(|e| ApiError::internal("SNAPSHOT_CORRUPT", e.to_string()))
    }

    pub async fn list(&self) -> ApiResult<Vec<SnapshotMeta>> {
        let mut metas = Vec::new();
        let mut rd = match tokio::fs::read_dir(&self.root).await {
            Ok(rd) => rd,
            Err(_) => return Ok(metas),
        };
        while let Ok(Some(entry)) = rd.next_entry().await {
            if let Ok(text) = tokio::fs::read_to_string(entry.path().join("meta.json")).await {
                if let Ok(meta) = serde_json::from_str::<SnapshotMeta>(&text) {
                    metas.push(meta);
                }
            }
        }
        metas.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        Ok(metas)
    }

    pub async fn delete(&self, id: &str) -> ApiResult<()> {
        let dir = self.dir(id)?;
        tokio::fs::remove_dir_all(&dir)
            .await
            .map_err(|_| ApiError::not_found("SNAPSHOT_NOT_FOUND", "Snapshot not found"))?;
        Ok(())
    }
}

/// Pull a database (and WAL/SHM sidecars) to a new host snapshot.
pub async fn take_snapshot(
    executor: &AdbExecutor,
    store: &DbSnapshotStore,
    device_id: &str,
    package: &str,
    database: &str,
) -> ApiResult<SnapshotMeta> {
    require_device(device_id)?;
    require_package(package)?;
    let rel = db_relative_path(database)?;
    let probe = probe_access(executor, device_id, package).await?;
    let mode = probe.mode.ok_or_else(|| {
        ApiError::bad_request(
            "ACCESS_UNAVAILABLE",
            probe
                .reason
                .unwrap_or_else(|| "App sandbox not accessible".into()),
        )
    })?;

    let base = pull_file(executor, device_id, package, mode, &rel).await?;
    if !base.starts_with(SQLITE_MAGIC) {
        return Err(ApiError::bad_request(
            "NOT_SQLITE",
            "File is not an unencrypted SQLite database (SQLCipher/encrypted stores are unsupported)",
        ));
    }
    // WAL and SHM may be absent; a missing sidecar is not an error.
    let wal = pull_file(executor, device_id, package, mode, &format!("{rel}-wal"))
        .await
        .ok();
    let shm = pull_file(executor, device_id, package, mode, &format!("{rel}-shm"))
        .await
        .ok();

    let id = Uuid::new_v4().to_string();
    let dir = store.dir(&id)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| ApiError::internal("SNAPSHOT_WRITE_FAILED", e.to_string()))?;
    tokio::fs::write(dir.join("main.db"), &base)
        .await
        .map_err(|e| ApiError::internal("SNAPSHOT_WRITE_FAILED", e.to_string()))?;
    let had_wal = wal.as_ref().is_some_and(|w| !w.is_empty());
    if let Some(w) = &wal {
        let _ = tokio::fs::write(dir.join("main.db-wal"), w).await;
    }
    if let Some(s) = &shm {
        let _ = tokio::fs::write(dir.join("main.db-shm"), s).await;
    }

    let meta = SnapshotMeta {
        id: id.clone(),
        device_id: device_id.to_string(),
        package: package.to_string(),
        database_name: database.to_string(),
        mode,
        sha256: super::sha256_hex(&base),
        size_bytes: base.len() as u64,
        had_wal,
        created_at: chrono::Utc::now().to_rfc3339(),
    };
    tokio::fs::write(
        dir.join("meta.json"),
        serde_json::to_vec_pretty(&meta).unwrap(),
    )
    .await
    .map_err(|e| ApiError::internal("SNAPSHOT_WRITE_FAILED", e.to_string()))?;
    Ok(meta)
}

/// Pull one file from the sandbox via `exec-out`, as app or root.
async fn pull_file(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
    mode: AccessMode,
    rel: &str,
) -> ApiResult<Vec<u8>> {
    let path = match mode {
        AccessMode::RunAs => rel.to_string(),
        AccessMode::Root => format!("/data/data/{package}/{rel}"),
    };
    let args = wrap_access(device_id, mode, "exec-out", &["cat", &path], package);
    let out = executor
        .execute_bytes(&args, None, Duration::from_secs(120), MAX_DB_BYTES)
        .await?;
    if out.exit_code != 0 || out.stdout.is_empty() {
        return Err(ApiError::bad_request(
            "DB_READ_FAILED",
            format!(
                "Could not read {rel}: {}",
                out.stderr.trim().lines().next().unwrap_or("empty")
            ),
        ));
    }
    Ok(out.stdout)
}

/// Outcome of writing a snapshot back to the device.
#[derive(Debug, Clone, Serialize)]
pub struct PushResult {
    #[serde(rename = "snapshotId")]
    pub snapshot_id: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub package: String,
    #[serde(rename = "databaseName")]
    pub database_name: String,
    pub mode: &'static str,
    #[serde(rename = "bytesWritten")]
    pub bytes_written: u64,
    #[serde(rename = "backupArtifactId")]
    pub backup_artifact_id: String,
    #[serde(rename = "appForceStopped")]
    pub app_force_stopped: bool,
}

/// Write an edited snapshot back to the device database.
///
/// This is the only device-mutating operation in this module and requires
/// explicit confirmation. It force-stops the app, verifies the on-device
/// database has not changed since the snapshot (otherwise aborts), saves a
/// backup artifact of the current device database, checkpoints the host WAL,
/// then writes the bytes back and removes the stale `-wal`/`-shm` sidecars.
#[allow(clippy::too_many_arguments)]
pub async fn push_snapshot(
    executor: &AdbExecutor,
    store: &DbSnapshotStore,
    artifacts: &crate::storage::artifacts::ArtifactStore,
    db: &crate::storage::db::Database,
    snapshot_id: &str,
    confirmed: bool,
) -> ApiResult<PushResult> {
    if !confirmed {
        return Err(ApiError::bad_request_with_details(
            "CONFIRMATION_REQUIRED",
            "Writing a database back to the device is destructive and requires confirmation",
            serde_json::json!({ "destructive": true, "snapshotId": snapshot_id }),
        ));
    }
    let meta = store.meta(snapshot_id).await?;
    let rel = db_relative_path(&meta.database_name)?;

    // Fold any host-side WAL into the main database file before reading it back.
    let host_path = store.db_path(snapshot_id)?;
    {
        let conn = Connection::open(&host_path).map_err(sql_err)?;
        let _: String = conn
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |r| r.get(2))
            .or_else(|_| Ok::<String, rusqlite::Error>(String::new()))
            .map_err(sql_err)?;
    }
    let host_bytes = tokio::fs::read(&host_path)
        .await
        .map_err(|e| ApiError::internal("SNAPSHOT_READ_FAILED", e.to_string()))?;

    // Verify the on-device database still matches the snapshot we edited.
    let current = pull_file(executor, &meta.device_id, &meta.package, meta.mode, &rel).await?;
    if super::sha256_hex(&current) != meta.sha256 {
        return Err(ApiError::conflict(
            "DEVICE_CHANGED",
            "The on-device database changed since this snapshot was taken; re-snapshot before pushing",
        ));
    }

    // Save the current device database as a restorable backup.
    let backup = artifacts
        .save_artifact(
            &format!("{}-{}-backup.db", meta.package, meta.database_name),
            "application/vnd.sqlite3",
            &current,
        )
        .await?;
    db.insert_artifact(&backup)?;

    // Stop the app so it is not holding the database open with its own WAL.
    let force_stop = executor
        .execute(
            &[
                "-s".into(),
                meta.device_id.clone(),
                "shell".into(),
                "am".into(),
                "force-stop".into(),
                meta.package.clone(),
            ],
            Some(Duration::from_secs(20)),
            None,
        )
        .await?;

    // Write the bytes back through a non-PTY binary stdin pipe.
    let dest = match meta.mode {
        AccessMode::RunAs => rel.clone(),
        AccessMode::Root => format!("/data/data/{}/{}", meta.package, rel),
    };
    let write_cmd = format!("cat > {}", shell_single_quote(&dest));
    let write_args = wrap_access(
        &meta.device_id,
        meta.mode,
        "exec-in",
        &["sh", "-c", &write_cmd],
        &meta.package,
    );
    // exec-in streams our stdin unmodified to the device command; `cat >` emits
    // nothing on success, so a tiny output cap is enough.
    let write = executor
        .execute_bytes(
            &write_args,
            Some(host_bytes.clone()),
            Duration::from_secs(120),
            4096,
        )
        .await?;
    if write.exit_code != 0 {
        return Err(ApiError::bad_request(
            "DB_PUSH_FAILED",
            format!(
                "Write-back failed (backup saved as artifact {}): {}",
                backup.id,
                write
                    .stderr
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("unknown error")
            ),
        ));
    }

    // Remove stale sidecars so the app reopens against the new file cleanly.
    let rm_cmd = format!(
        "rm -f {} {}",
        shell_single_quote(&format!("{dest}-wal")),
        shell_single_quote(&format!("{dest}-shm"))
    );
    let rm_args = wrap_access(
        &meta.device_id,
        meta.mode,
        "shell",
        &["sh", "-c", &rm_cmd],
        &meta.package,
    );
    let _ = executor
        .execute(&rm_args, Some(Duration::from_secs(20)), None)
        .await;

    Ok(PushResult {
        snapshot_id: snapshot_id.to_string(),
        device_id: meta.device_id,
        package: meta.package,
        database_name: meta.database_name,
        mode: meta.mode.as_str(),
        bytes_written: host_bytes.len() as u64,
        backup_artifact_id: backup.id,
        app_force_stopped: force_stop.exit_code == 0,
    })
}

/// Single-quote a device path for safe embedding in `sh -c`.
fn shell_single_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\"'\"'"))
}

// --- Host-side query and edit against the snapshot copy ---

/// A query or statement result.
#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<serde_json::Value>>,
    #[serde(rename = "rowsAffected")]
    pub rows_affected: Option<usize>,
    pub truncated: bool,
}

fn value_to_json(v: rusqlite::types::ValueRef<'_>) -> serde_json::Value {
    use base64::Engine;
    use rusqlite::types::ValueRef;
    match v {
        ValueRef::Null => serde_json::Value::Null,
        ValueRef::Integer(i) => serde_json::Value::from(i),
        ValueRef::Real(f) => serde_json::Value::from(f),
        ValueRef::Text(t) => serde_json::Value::from(String::from_utf8_lossy(t).into_owned()),
        ValueRef::Blob(b) => serde_json::json!({
            "$blob": base64::engine::general_purpose::STANDARD.encode(b),
            "len": b.len(),
        }),
    }
}

/// List tables and their columns from a snapshot (read-only).
pub fn schema(db_path: &Path) -> ApiResult<serde_json::Value> {
    let conn = open_readonly(db_path)?;
    let mut tables = Vec::new();
    {
        let mut stmt = conn
            .prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name")
            .map_err(sql_err)?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(sql_err)?;
        for row in rows {
            let (name, kind) = row.map_err(sql_err)?;
            let cols = table_columns(&conn, &name)?;
            tables.push(serde_json::json!({"name": name, "type": kind, "columns": cols}));
        }
    }
    Ok(serde_json::json!({ "tables": tables }))
}

fn table_columns(conn: &Connection, table: &str) -> ApiResult<Vec<serde_json::Value>> {
    // table_info takes a bound parameter to avoid any identifier injection.
    let mut stmt = conn
        .prepare("SELECT name, type, \"notnull\", pk FROM pragma_table_info(?1)")
        .map_err(sql_err)?;
    let rows = stmt
        .query_map([table], |r| {
            Ok(serde_json::json!({
                "name": r.get::<_, String>(0)?,
                "type": r.get::<_, String>(1)?,
                "notNull": r.get::<_, i64>(2)? != 0,
                "pk": r.get::<_, i64>(3)?,
            }))
        })
        .map_err(sql_err)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(sql_err)
}

/// Run a read-only query against a snapshot, capping the rows returned.
pub fn query(db_path: &Path, sql: &str, max_rows: usize) -> ApiResult<QueryResult> {
    let conn = open_readonly(db_path)?;
    conn.pragma_update(None, "query_only", true)
        .map_err(sql_err)?;
    run_select(&conn, sql, max_rows)
}

fn run_select(conn: &Connection, sql: &str, max_rows: usize) -> ApiResult<QueryResult> {
    let mut stmt = conn.prepare(sql).map_err(sql_err)?;
    let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
    let col_count = stmt.column_count();
    let mut rows = Vec::new();
    let mut truncated = false;
    let mut query_rows = stmt.query([]).map_err(sql_err)?;
    while let Some(row) = query_rows.next().map_err(sql_err)? {
        if rows.len() >= max_rows {
            truncated = true;
            break;
        }
        let mut record = Vec::with_capacity(col_count);
        for i in 0..col_count {
            record.push(value_to_json(row.get_ref(i).map_err(sql_err)?));
        }
        rows.push(record);
    }
    Ok(QueryResult {
        columns,
        rows,
        rows_affected: None,
        truncated,
    })
}

/// Execute an edit statement (INSERT/UPDATE/DELETE/DDL) against the snapshot
/// copy only. This never touches the device; see `database.push` for write-back.
pub fn execute(db_path: &Path, sql: &str) -> ApiResult<QueryResult> {
    let conn = Connection::open(db_path).map_err(sql_err)?;
    let trimmed = sql.trim_start().to_ascii_uppercase();
    if trimmed.starts_with("SELECT") || trimmed.starts_with("WITH") || trimmed.starts_with("PRAGMA")
    {
        return run_select(&conn, sql, 10_000);
    }
    let affected = conn.execute(sql, []).map_err(sql_err)?;
    Ok(QueryResult {
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected: Some(affected),
        truncated: false,
    })
}

fn open_readonly(db_path: &Path) -> ApiResult<Connection> {
    Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| ApiError::bad_request("DB_OPEN_FAILED", e.to_string()))
}

fn sql_err(e: rusqlite::Error) -> ApiError {
    ApiError::bad_request("SQL_ERROR", e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ls_parsing_extracts_names_and_sizes() {
        let out = "total 40\n-rw-rw---- 1 u0_a1 u0_a1 20480 2024-01-01 12:00 app.db\n-rw-rw---- 1 u0_a1 u0_a1 32768 2024-01-01 12:00 app.db-wal\ndrwxrwx--x 2 u0_a1 u0_a1 4096 2024-01-01 12:00 subdir\n";
        let names = parse_ls_names(out);
        assert_eq!(names.len(), 2);
        assert_eq!(names[0], ("app.db".to_string(), Some(20480)));
        assert_eq!(names[1].0, "app.db-wal");
    }

    #[test]
    fn db_name_validation_blocks_traversal() {
        assert!(db_relative_path("app.db").is_ok());
        assert!(db_relative_path("../secret").is_err());
        assert!(db_relative_path("a/b").is_err());
        assert!(db_relative_path(".hidden").is_err());
    }

    #[test]
    fn query_and_edit_round_trip_on_host_copy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("main.db");
        {
            let c = Connection::open(&path).unwrap();
            c.execute_batch(
                "CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT, blob BLOB);
                 INSERT INTO t(name, blob) VALUES ('a', x'0102'), ('b', NULL);",
            )
            .unwrap();
        }
        let schema = schema(&path).unwrap();
        assert_eq!(schema["tables"][0]["name"], "t");

        let res = query(&path, "SELECT id, name, blob FROM t ORDER BY id", 10).unwrap();
        assert_eq!(res.columns, vec!["id", "name", "blob"]);
        assert_eq!(res.rows.len(), 2);
        assert_eq!(res.rows[0][1], serde_json::json!("a"));
        assert_eq!(res.rows[0][2]["len"], 2);
        assert_eq!(res.rows[1][2], serde_json::Value::Null);

        // Read-only query must reject writes.
        assert!(query(&path, "DELETE FROM t", 10).is_err());

        // Edit on the host copy succeeds.
        let edit = execute(&path, "UPDATE t SET name='z' WHERE id=1").unwrap();
        assert_eq!(edit.rows_affected, Some(1));
        let after = query(&path, "SELECT name FROM t WHERE id=1", 10).unwrap();
        assert_eq!(after.rows[0][0], serde_json::json!("z"));
    }

    #[test]
    fn query_respects_row_cap() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("main.db");
        let c = Connection::open(&path).unwrap();
        c.execute_batch("CREATE TABLE t(n);").unwrap();
        for i in 0..50 {
            c.execute("INSERT INTO t(n) VALUES (?1)", [i]).unwrap();
        }
        drop(c);
        let res = query(&path, "SELECT n FROM t", 10).unwrap();
        assert_eq!(res.rows.len(), 10);
        assert!(res.truncated);
    }
}
