use rusqlite::{params, Connection};
use std::path::Path;
use std::sync::{Arc, Mutex};

use crate::error::{ApiError, ApiResult};
use crate::models::{Artifact, Job, JobStatus, Settings, Workflow, WorkflowStep};

#[derive(Clone)]
pub struct Database {
    conn: Arc<Mutex<Connection>>,
}

impl Database {
    pub fn new(path: impl AsRef<Path>) -> ApiResult<Self> {
        let conn = Connection::open(path).map_err(|e| {
            ApiError::internal(
                "DB_OPEN_FAILED",
                format!("Failed to open SQLite database: {}", e),
            )
        })?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_tables()?;
        db.conn.lock().unwrap().execute("UPDATE jobs SET status='failed', error='Host process restarted before completion', finished_at=?1 WHERE status IN ('queued','running')", [chrono::Utc::now().to_rfc3339()]).map_err(|e| ApiError::internal("DB_RECOVERY_FAILED", e.to_string()))?;
        db.recover_workflow_runs()?;
        Ok(db)
    }

    pub fn in_memory() -> ApiResult<Self> {
        let conn = Connection::open_in_memory().map_err(|e| {
            ApiError::internal(
                "DB_OPEN_FAILED",
                format!("Failed to open in-memory SQLite: {}", e),
            )
        })?;

        let db = Self {
            conn: Arc::new(Mutex::new(conn)),
        };
        db.init_tables()?;
        Ok(db)
    }

    fn init_tables(&self) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE IF NOT EXISTS jobs (
                id TEXT PRIMARY KEY,
                operation_id TEXT NOT NULL,
                device_id TEXT,
                status TEXT NOT NULL,
                stdout TEXT NOT NULL,
                stderr TEXT NOT NULL,
                exit_code INTEGER,
                created_at TEXT NOT NULL,
                started_at TEXT,
                finished_at TEXT,
                artifact_ids TEXT NOT NULL,
                error TEXT,
                source TEXT NOT NULL DEFAULT 'gui',
                requester TEXT
            );

            CREATE TABLE IF NOT EXISTS artifacts (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                size INTEGER NOT NULL,
                content_type TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                steps_json TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            "#,
        )
        .map_err(|e| {
            ApiError::internal(
                "DB_MIGRATION_FAILED",
                format!("Failed to initialize database tables: {}", e),
            )
        })?;

        // Safely migrate existing databases if columns do not exist yet
        let _ = conn.execute(
            "ALTER TABLE jobs ADD COLUMN source TEXT NOT NULL DEFAULT 'gui'",
            [],
        );
        let _ = conn.execute("ALTER TABLE jobs ADD COLUMN requester TEXT", []);

        Ok(())
    }

    // --- Jobs CRUD ---

    pub fn insert_job(&self, job: &Job) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        let artifact_ids_json =
            serde_json::to_string(&job.artifact_ids).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            r#"
            INSERT INTO jobs (
                id, operation_id, device_id, status, stdout, stderr, exit_code,
                created_at, started_at, finished_at, artifact_ids, error, source, requester
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
            "#,
            params![
                job.id,
                job.operation_id,
                job.device_id,
                job.status.as_str(),
                job.stdout,
                job.stderr,
                job.exit_code,
                job.created_at,
                job.started_at,
                job.finished_at,
                artifact_ids_json,
                job.error,
                job.source,
                job.requester,
            ],
        )
        .map_err(|e| ApiError::internal("DB_ERROR", format!("Failed to insert job: {}", e)))?;

        Ok(())
    }

    pub fn update_job(&self, job: &Job) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        let artifact_ids_json =
            serde_json::to_string(&job.artifact_ids).unwrap_or_else(|_| "[]".to_string());
        conn.execute(
            r#"
            UPDATE jobs SET
                status = ?2,
                stdout = ?3,
                stderr = ?4,
                exit_code = ?5,
                started_at = ?6,
                finished_at = ?7,
                artifact_ids = ?8,
                error = ?9
            WHERE id = ?1
            "#,
            params![
                job.id,
                job.status.as_str(),
                job.stdout,
                job.stderr,
                job.exit_code,
                job.started_at,
                job.finished_at,
                artifact_ids_json,
                job.error,
            ],
        )
        .map_err(|e| ApiError::internal("DB_ERROR", format!("Failed to update job: {}", e)))?;

        Ok(())
    }

    pub fn get_job(&self, id: &str) -> ApiResult<Option<Job>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, operation_id, device_id, status, stdout, stderr, exit_code,
                       created_at, started_at, finished_at, artifact_ids, error,
                       source, requester
                FROM jobs WHERE id = ?1
                "#,
            )
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?
        {
            let status_str: String = row.get(3).unwrap_or_default();
            let status = match status_str.as_str() {
                "queued" => JobStatus::Queued,
                "running" => JobStatus::Running,
                "completed" => JobStatus::Completed,
                "failed" => JobStatus::Failed,
                "cancelled" => JobStatus::Cancelled,
                _ => JobStatus::Failed,
            };
            let artifact_ids_json: String = row.get(10).unwrap_or_else(|_| "[]".to_string());
            let artifact_ids: Vec<String> =
                serde_json::from_str(&artifact_ids_json).unwrap_or_default();

            Ok(Some(Job {
                id: row.get(0).unwrap_or_default(),
                operation_id: row.get(1).unwrap_or_default(),
                device_id: row.get(2).ok(),
                status,
                stdout: row.get(4).unwrap_or_default(),
                stderr: row.get(5).unwrap_or_default(),
                exit_code: row.get(6).ok(),
                created_at: row.get(7).unwrap_or_default(),
                started_at: row.get(8).ok(),
                finished_at: row.get(9).ok(),
                artifact_ids,
                error: row.get(11).ok(),
                source: row.get(12).unwrap_or_else(|_| "gui".to_string()),
                requester: row.get(13).ok(),
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_jobs(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        full_output: bool,
    ) -> ApiResult<Vec<Job>> {
        let conn = self.conn.lock().unwrap();
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let offset = offset.unwrap_or(0);

        let query = if full_output {
            r#"
            SELECT id, operation_id, device_id, status, stdout, stderr, exit_code,
                   created_at, started_at, finished_at, artifact_ids, error,
                   source, requester
            FROM jobs ORDER BY created_at DESC LIMIT ?1 OFFSET ?2
            "#
        } else {
            r#"
            SELECT id, operation_id, device_id, status,
                   substr(stdout, 1, 1024), substr(stderr, 1, 1024), exit_code,
                   created_at, started_at, finished_at, artifact_ids, error,
                   source, requester
            FROM jobs ORDER BY created_at DESC LIMIT ?1 OFFSET ?2
            "#
        };

        let mut stmt = conn
            .prepare(query)
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let rows = stmt
            .query_map([limit, offset], |row| {
                let status_str: String = row.get(3).unwrap_or_default();
                let status = match status_str.as_str() {
                    "queued" => JobStatus::Queued,
                    "running" => JobStatus::Running,
                    "completed" => JobStatus::Completed,
                    "failed" => JobStatus::Failed,
                    "cancelled" => JobStatus::Cancelled,
                    _ => JobStatus::Failed,
                };
                let artifact_ids_json: String = row.get(10).unwrap_or_else(|_| "[]".to_string());
                let artifact_ids: Vec<String> =
                    serde_json::from_str(&artifact_ids_json).unwrap_or_default();

                Ok(Job {
                    id: row.get(0).unwrap_or_default(),
                    operation_id: row.get(1).unwrap_or_default(),
                    device_id: row.get(2).ok(),
                    status,
                    stdout: row.get(4).unwrap_or_default(),
                    stderr: row.get(5).unwrap_or_default(),
                    exit_code: row.get(6).ok(),
                    created_at: row.get(7).unwrap_or_default(),
                    started_at: row.get(8).ok(),
                    finished_at: row.get(9).ok(),
                    artifact_ids,
                    error: row.get(11).ok(),
                    source: row.get(12).unwrap_or_else(|_| "gui".to_string()),
                    requester: row.get(13).ok(),
                })
            })
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut jobs = Vec::new();
        for job in rows.flatten() {
            jobs.push(job);
        }
        Ok(jobs)
    }

    pub fn count_jobs(&self) -> ApiResult<u64> {
        let conn = self.conn.lock().unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM jobs", [], |row| row.get(0))
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;
        Ok(count as u64)
    }

    pub fn list_audit_log(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        source: Option<&str>,
        device_id: Option<&str>,
    ) -> ApiResult<Vec<Job>> {
        let conn = self.conn.lock().unwrap();
        let limit = limit.unwrap_or(50).clamp(1, 200);
        let offset = offset.unwrap_or(0);

        let mut conditions = Vec::new();
        let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();

        if let Some(src) = source {
            conditions.push(format!("source = ?{}", params_vec.len() + 1));
            params_vec.push(Box::new(src.to_string()));
        }
        if let Some(dev) = device_id {
            conditions.push(format!("device_id = ?{}", params_vec.len() + 1));
            params_vec.push(Box::new(dev.to_string()));
        }

        let where_clause = if conditions.is_empty() {
            String::new()
        } else {
            format!("WHERE {}", conditions.join(" AND "))
        };

        let sql = format!(
            r#"
            SELECT id, operation_id, device_id, status,
                   substr(stdout, 1, 1024), substr(stderr, 1, 1024), exit_code,
                   created_at, started_at, finished_at, artifact_ids, error,
                   source, requester
            FROM jobs {where_clause} ORDER BY created_at DESC LIMIT ?{} OFFSET ?{}
            "#,
            params_vec.len() + 1,
            params_vec.len() + 2
        );
        params_vec.push(Box::new(limit));
        params_vec.push(Box::new(offset));

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let params_slice: Vec<&dyn rusqlite::ToSql> =
            params_vec.iter().map(|b| b.as_ref()).collect();
        let rows = stmt
            .query_map(params_slice.as_slice(), |row| {
                let status_str: String = row.get(3).unwrap_or_default();
                let status = match status_str.as_str() {
                    "queued" => JobStatus::Queued,
                    "running" => JobStatus::Running,
                    "completed" => JobStatus::Completed,
                    "failed" => JobStatus::Failed,
                    "cancelled" => JobStatus::Cancelled,
                    _ => JobStatus::Failed,
                };
                let artifact_ids_json: String = row.get(10).unwrap_or_else(|_| "[]".to_string());
                let artifact_ids: Vec<String> =
                    serde_json::from_str(&artifact_ids_json).unwrap_or_default();

                Ok(Job {
                    id: row.get(0).unwrap_or_default(),
                    operation_id: row.get(1).unwrap_or_default(),
                    device_id: row.get(2).ok(),
                    status,
                    stdout: row.get(4).unwrap_or_default(),
                    stderr: row.get(5).unwrap_or_default(),
                    exit_code: row.get(6).ok(),
                    created_at: row.get(7).unwrap_or_default(),
                    started_at: row.get(8).ok(),
                    finished_at: row.get(9).ok(),
                    artifact_ids,
                    error: row.get(11).ok(),
                    source: row.get(12).unwrap_or_else(|_| "gui".to_string()),
                    requester: row.get(13).ok(),
                })
            })
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut jobs = Vec::new();
        for job in rows.flatten() {
            jobs.push(job);
        }
        Ok(jobs)
    }

    // --- Artifacts CRUD ---

    pub fn insert_artifact(&self, artifact: &Artifact) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        conn.execute(
            r#"
            INSERT INTO artifacts (id, name, size, content_type, created_at)
            VALUES (?1, ?2, ?3, ?4, ?5)
            "#,
            params![
                artifact.id,
                artifact.name,
                artifact.size,
                artifact.content_type,
                artifact.created_at,
            ],
        )
        .map_err(|e| ApiError::internal("DB_ERROR", format!("Failed to insert artifact: {}", e)))?;

        Ok(())
    }

    pub fn get_artifact(&self, id: &str) -> ApiResult<Option<Artifact>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, name, size, content_type, created_at
                FROM artifacts WHERE id = ?1
                "#,
            )
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?
        {
            Ok(Some(Artifact {
                id: row.get(0).unwrap_or_default(),
                name: row.get(1).unwrap_or_default(),
                size: row.get(2).unwrap_or_default(),
                content_type: row.get(3).unwrap_or_default(),
                created_at: row.get(4).unwrap_or_default(),
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_artifacts(&self) -> ApiResult<Vec<Artifact>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                r#"
                SELECT id, name, size, content_type, created_at
                FROM artifacts ORDER BY created_at DESC
                "#,
            )
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                Ok(Artifact {
                    id: row.get(0).unwrap_or_default(),
                    name: row.get(1).unwrap_or_default(),
                    size: row.get(2).unwrap_or_default(),
                    content_type: row.get(3).unwrap_or_default(),
                    created_at: row.get(4).unwrap_or_default(),
                })
            })
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut artifacts = Vec::new();
        for art in rows.flatten() {
            artifacts.push(art);
        }
        Ok(artifacts)
    }

    pub fn delete_artifact(&self, id: &str) -> ApiResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count = conn
            .execute("DELETE FROM artifacts WHERE id = ?1", params![id])
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        Ok(count > 0)
    }

    // --- Workflows CRUD ---

    pub fn insert_workflow(&self, workflow: &Workflow) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        let steps_json = serde_json::to_string(&workflow.steps)
            .map_err(|e| ApiError::internal("SERIALIZATION_ERROR", e.to_string()))?;

        conn.execute(
            r#"
            INSERT INTO workflows (id, name, steps_json)
            VALUES (?1, ?2, ?3)
            "#,
            params![workflow.id, workflow.name, steps_json],
        )
        .map_err(|e| ApiError::internal("DB_ERROR", format!("Failed to insert workflow: {}", e)))?;

        Ok(())
    }

    pub fn update_workflow(&self, workflow: &Workflow) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        let steps_json = serde_json::to_string(&workflow.steps)
            .map_err(|e| ApiError::internal("SERIALIZATION_ERROR", e.to_string()))?;

        let count = conn
            .execute(
                r#"
                UPDATE workflows SET name = ?2, steps_json = ?3
                WHERE id = ?1
                "#,
                params![workflow.id, workflow.name, steps_json],
            )
            .map_err(|e| {
                ApiError::internal("DB_ERROR", format!("Failed to update workflow: {}", e))
            })?;

        if count == 0 {
            return Err(ApiError::not_found(
                "WORKFLOW_NOT_FOUND",
                "Workflow not found",
            ));
        }
        Ok(())
    }

    pub fn get_workflow(&self, id: &str) -> ApiResult<Option<Workflow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, steps_json FROM workflows WHERE id = ?1")
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut rows = stmt
            .query(params![id])
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        if let Some(row) = rows
            .next()
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?
        {
            let steps_json: String = row.get(2).unwrap_or_else(|_| "[]".to_string());
            let steps: Vec<WorkflowStep> = serde_json::from_str(&steps_json).unwrap_or_default();

            Ok(Some(Workflow {
                id: row.get(0).unwrap_or_default(),
                name: row.get(1).unwrap_or_default(),
                steps,
            }))
        } else {
            Ok(None)
        }
    }

    pub fn list_workflows(&self) -> ApiResult<Vec<Workflow>> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT id, name, steps_json FROM workflows ORDER BY name ASC")
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                let steps_json: String = row.get(2).unwrap_or_else(|_| "[]".to_string());
                let steps: Vec<WorkflowStep> =
                    serde_json::from_str(&steps_json).unwrap_or_default();
                Ok(Workflow {
                    id: row.get(0).unwrap_or_default(),
                    name: row.get(1).unwrap_or_default(),
                    steps,
                })
            })
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut workflows = Vec::new();
        for wf in rows.flatten() {
            workflows.push(wf);
        }
        Ok(workflows)
    }

    pub fn delete_workflow(&self, id: &str) -> ApiResult<bool> {
        let conn = self.conn.lock().unwrap();
        let count = conn
            .execute("DELETE FROM workflows WHERE id = ?1", params![id])
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        Ok(count > 0)
    }

    // --- Settings CRUD ---

    pub fn get_settings(&self) -> ApiResult<Settings> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn
            .prepare("SELECT key, value FROM settings WHERE key IN ('adbPath','dataDir','defaultTimeoutMs','allowUnsupportedFlags')")
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let rows = stmt
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;

        let mut settings = Settings::default();
        for pair in rows.flatten() {
            match pair.0.as_str() {
                "adbPath" => settings.adb_path = pair.1,
                "dataDir" => settings.data_dir = pair.1,
                "defaultTimeoutMs" => {
                    if let Ok(val) = pair.1.parse() {
                        settings.default_timeout_ms = val;
                    }
                }
                "allowUnsupportedFlags" => {
                    if let Ok(val) = pair.1.parse() {
                        settings.allow_unsupported_flags = val;
                    }
                }
                _ => {}
            }
        }
        Ok(settings)
    }

    pub fn save_settings(&self, settings: &Settings) -> ApiResult<()> {
        let conn = self.conn.lock().unwrap();
        let entries = vec![
            ("adbPath", settings.adb_path.clone()),
            ("dataDir", settings.data_dir.clone()),
            ("defaultTimeoutMs", settings.default_timeout_ms.to_string()),
            (
                "allowUnsupportedFlags",
                settings.allow_unsupported_flags.to_string(),
            ),
        ];

        for (k, v) in entries {
            conn.execute(
                "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = ?2",
                params![k, v],
            )
            .map_err(|e| ApiError::internal("DB_ERROR", e.to_string()))?;
        }

        Ok(())
    }
}

impl Database {
    pub fn read_value<T: serde::de::DeserializeOwned + Default>(&self, key: &str) -> ApiResult<T> {
        use rusqlite::OptionalExtension;
        let text: Option<String> = self
            .conn
            .lock()
            .unwrap()
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| ApiError::internal("DB_READ_FAILED", e.to_string()))?;
        text.map(|s| {
            serde_json::from_str(&s)
                .map_err(|e| ApiError::internal("DB_DATA_INVALID", e.to_string()))
        })
        .unwrap_or_else(|| Ok(T::default()))
    }

    pub fn write_value<T: serde::Serialize>(&self, key: &str, value: &T) -> ApiResult<()> {
        let text = serde_json::to_string(value)
            .map_err(|e| ApiError::internal("DB_DATA_INVALID", e.to_string()))?;
        self.conn.lock().unwrap().execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, text])
            .map_err(|e| ApiError::internal("DB_WRITE_FAILED", e.to_string()))?;
        Ok(())
    }
}

impl Database {
    pub fn jobs_for_requester(&self, requester: &str) -> ApiResult<Vec<Job>> {
        let ids: Vec<String> = {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn
                .prepare("SELECT id FROM jobs WHERE requester=?1 ORDER BY created_at")
                .map_err(|e| ApiError::internal("DB_READ_FAILED", e.to_string()))?;
            let rows = stmt
                .query_map([requester], |row| row.get(0))
                .map_err(|e| ApiError::internal("DB_READ_FAILED", e.to_string()))?;
            rows.collect::<Result<_, _>>()
                .map_err(|e| ApiError::internal("DB_READ_FAILED", e.to_string()))?
        };
        let mut jobs = Vec::new();
        for id in ids {
            if let Some(job) = self.get_job(&id)? {
                jobs.push(job);
            }
        }
        Ok(jobs)
    }
}

impl Database {
    /// Keep index changes atomic across concurrent assistant and workflow requests.
    pub fn prepend_report(&self, key: &str, id: &str, prefix: &str) -> ApiResult<()> {
        use rusqlite::OptionalExtension;
        let mut conn = self.conn.lock().unwrap();
        let tx = conn
            .transaction()
            .map_err(|e| ApiError::internal("DB_WRITE_FAILED", e.to_string()))?;
        let previous: Option<String> = tx
            .query_row("SELECT value FROM settings WHERE key=?1", [key], |row| {
                row.get(0)
            })
            .optional()
            .map_err(|e| ApiError::internal("DB_READ_FAILED", e.to_string()))?;
        let mut ids: Vec<String> = previous
            .map(|s| serde_json::from_str(&s))
            .transpose()
            .map_err(|e| ApiError::internal("DB_DATA_INVALID", e.to_string()))?
            .unwrap_or_default();
        ids.retain(|old| old != id);
        ids.insert(0, id.into());
        if ids.len() > 200 {
            for old in ids.drain(200..) {
                tx.execute(
                    "DELETE FROM settings WHERE key=?1",
                    [format!("{prefix}{old}")],
                )
                .map_err(|e| ApiError::internal("DB_WRITE_FAILED", e.to_string()))?;
            }
        }
        let value = serde_json::to_string(&ids)
            .map_err(|e| ApiError::internal("DB_DATA_INVALID", e.to_string()))?;
        tx.execute("INSERT INTO settings(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",params![key,value]).map_err(|e|ApiError::internal("DB_WRITE_FAILED",e.to_string()))?;
        tx.commit()
            .map_err(|e| ApiError::internal("DB_WRITE_FAILED", e.to_string()))
    }

    fn recover_workflow_runs(&self) -> ApiResult<()> {
        let ids: Vec<String> = self.read_value("experience.workflow-runs")?;
        for id in ids {
            let mut report: serde_json::Value = self.read_value(&format!("experience.run.{id}"))?;
            if report["status"] == "running" {
                report["status"] = serde_json::json!("failed");
                report["error"]=serde_json::json!("Server restarted before the workflow finished; inspect the device before rerunning");
                report["finishedAt"] = serde_json::json!(chrono::Utc::now().to_rfc3339());
                self.write_value(&format!("experience.run.{id}"), &report)?;
            }
        }
        Ok(())
    }
}
