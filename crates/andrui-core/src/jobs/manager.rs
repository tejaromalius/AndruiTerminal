use chrono::Utc;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::adb::command_builder::build_adb_command;
use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};
use crate::models::{CreateJobRequest, Job, JobEvent, JobStatus};
use crate::storage::db::Database;

#[derive(Clone)]
pub struct JobManager {
    executor: AdbExecutor,
    automation: Option<andrui_automation::AppState>,
    artifacts: Option<crate::storage::artifacts::ArtifactStore>,
    db: Database,
    // Device mutation locks: per-device Mutex to serialize conflicting mutations
    device_locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    // Active job cancellation tokens
    cancel_tokens: Arc<Mutex<HashMap<String, CancellationToken>>>,
    // Per-job SSE broadcast channels
    job_channels: Arc<Mutex<HashMap<String, broadcast::Sender<JobEvent>>>>,
    // Global WebSocket events channel
    global_events: broadcast::Sender<serde_json::Value>,
    // Default timeout in milliseconds
    default_timeout_ms: Arc<Mutex<u64>>,
}

impl JobManager {
    pub fn new(executor: AdbExecutor, db: Database) -> Self {
        let (global_tx, _) = broadcast::channel(1024);
        Self {
            executor,
            automation: None,
            artifacts: None,
            db,
            device_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            cancel_tokens: Arc::new(Mutex::new(HashMap::new())),
            job_channels: Arc::new(Mutex::new(HashMap::new())),
            global_events: global_tx,
            default_timeout_ms: Arc::new(Mutex::new(30_000)),
        }
    }

    pub fn with_automation(mut self, state: andrui_automation::AppState) -> Self {
        self.automation = Some(state);
        self
    }

    pub fn with_device_locks(
        mut self,
        locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    ) -> Self {
        self.device_locks = locks;
        self
    }
    pub fn with_artifacts(mut self, artifacts: crate::storage::artifacts::ArtifactStore) -> Self {
        self.artifacts = Some(artifacts);
        self
    }
    pub async fn resolve_parameters(
        &self,
        params: &mut serde_json::Map<String, serde_json::Value>,
    ) -> ApiResult<()> {
        for key in ["apkPaths", "packages"] {
            if let Some(value) = params.get_mut(key) {
                if let Some(text) = value.as_str() {
                    *value = serde_json::from_str(text).map_err(|_| {
                        ApiError::bad_request(
                            "INVALID_ARRAY",
                            format!("{key} must be a JSON array of strings"),
                        )
                    })?;
                }
                if !value
                    .as_array()
                    .map(|a| {
                        !a.is_empty()
                            && a.iter()
                                .all(|v| v.as_str().map(|s| !s.is_empty()).unwrap_or(false))
                    })
                    .unwrap_or(false)
                {
                    return Err(ApiError::bad_request(
                        "INVALID_ARRAY",
                        format!("{key} must contain nonempty strings"),
                    ));
                }
            }
        }
        let Some(store) = &self.artifacts else {
            return Ok(());
        };
        for key in ["local", "apkPath", "file", "apkPaths"] {
            if let Some(value) = params.get_mut(key) {
                let values: Vec<&mut serde_json::Value> = if value.is_array() {
                    value.as_array_mut().unwrap().iter_mut().collect()
                } else {
                    vec![value]
                };
                for value in values {
                    if let Some(id) = value.as_str().filter(|s| Uuid::parse_str(s).is_ok()) {
                        if self.db.get_artifact(id)?.is_none() {
                            return Err(ApiError::not_found(
                                "ARTIFACT_NOT_FOUND",
                                "Artifact metadata not found",
                            ));
                        }
                        *value = serde_json::json!(store.path_for(id).await?.to_string_lossy());
                    }
                }
            }
        }
        Ok(())
    }

    pub fn set_default_timeout_ms(&self, timeout_ms: u64) {
        let mut t = self.default_timeout_ms.lock().unwrap();
        *t = timeout_ms;
    }

    pub fn subscribe_global_events(&self) -> broadcast::Receiver<serde_json::Value> {
        self.global_events.subscribe()
    }

    /// Broadcasts a non-job event (e.g. approvals) on the global `/events` channel.
    pub fn publish_global_event(&self, event: serde_json::Value) {
        let _ = self.global_events.send(event);
    }

    pub fn subscribe_job_events(&self, job_id: &str) -> Option<broadcast::Receiver<JobEvent>> {
        let channels = self.job_channels.lock().unwrap();
        channels.get(job_id).map(|tx| tx.subscribe())
    }

    async fn get_device_lock(&self, device_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.device_locks.lock().await;
        locks
            .entry(device_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    pub async fn create_job(&self, mut req: CreateJobRequest) -> ApiResult<Job> {
        let catalog = crate::operations::runtime_catalog(&self.executor).await;
        let op = catalog
            .iter()
            .find(|o| o.id == req.operation_id)
            .ok_or_else(|| {
                ApiError::bad_request(
                    "UNKNOWN_OPERATION",
                    format!("Operation '{}' not found in catalog", req.operation_id),
                )
            })?;

        if !op.available {
            return Err(ApiError::bad_request(
                "OPERATION_UNAVAILABLE",
                op.unavailable_reason
                    .as_deref()
                    .unwrap_or("Operation unavailable"),
            ));
        }
        if op.destructive && req.confirmed != Some(true) {
            return Err(ApiError::bad_request_with_details(
                "CONFIRMATION_REQUIRED",
                "Destructive operation requires explicit confirmation",
                serde_json::json!({
                    "operationId": op.id,
                    "deviceId": req.device_id,
                    "destructive": true
                }),
            ));
        }

        if op.requires_device && req.device_id.is_none() {
            return Err(ApiError::bad_request(
                "DEVICE_REQUIRED",
                format!(
                    "Operation '{}' requires a target deviceId",
                    req.operation_id
                ),
            ));
        }

        if req.operation_id.starts_with("automation.") {
            let state = self.automation.as_ref().ok_or_else(|| {
                ApiError::bad_request("HELPER_UNAVAILABLE", "Automation is unavailable")
            })?;
            state
                .get_device_session(req.device_id.as_deref().unwrap_or(""))
                .await
                .map_err(|e| ApiError::bad_request("HELPER_UNAVAILABLE", e.to_string()))?;
        }
        for (operation, field) in [("file.pull", "local"), ("diagnostics.bugreport", "path")] {
            if req.operation_id == operation
                && req
                    .parameters
                    .get(field)
                    .is_some_and(|v| v.is_null() || v.as_str().is_some_and(|s| s.trim().is_empty()))
            {
                req.parameters.remove(field);
            }
        }
        self.resolve_parameters(&mut req.parameters).await?;
        let output_name = match req.operation_id.as_str() {
            "file.pull" if !req.parameters.contains_key("local") => Some(
                req.parameters
                    .get("remote")
                    .and_then(|v| v.as_str())
                    .and_then(|p| std::path::Path::new(p).file_name())
                    .and_then(|n| n.to_str())
                    .unwrap_or("download.bin")
                    .to_string(),
            ),
            "diagnostics.bugreport" if !req.parameters.contains_key("path") => {
                Some("bugreport.zip".into())
            }
            _ => None,
        };
        let mut validation_parameters = req.parameters.clone();
        if output_name.is_some() {
            validation_parameters.insert(
                if req.operation_id == "file.pull" {
                    "local"
                } else {
                    "path"
                }
                .into(),
                serde_json::json!("<browser-download>"),
            );
        }
        build_adb_command(
            self.executor.adb_path().to_str().unwrap_or("adb"),
            &req.operation_id,
            req.device_id.as_deref(),
            &validation_parameters,
        )?;
        if req.source.as_deref() == Some("mcp") {
            crate::experience::check_policy(
                &self.db,
                &req.operation_id,
                req.device_id.as_deref(),
                &req.parameters,
            )?;
        }
        if self.cancel_tokens.lock().unwrap().len() >= 64 {
            return Err(ApiError::bad_request(
                "JOB_LIMIT",
                "At most 64 queued/running jobs are supported",
            ));
        }
        let output_artifact = if let Some(name) = output_name {
            let store = self.artifacts.as_ref().ok_or_else(|| {
                ApiError::bad_request("ARTIFACTS_UNAVAILABLE", "Artifact storage is unavailable")
            })?;
            let (id, name, file) = store.create_upload(&name).await?;
            drop(file);
            let path = store.path_for(&id).await?;
            req.parameters.insert(
                if req.operation_id == "file.pull" {
                    "local"
                } else {
                    "path"
                }
                .into(),
                serde_json::json!(path),
            );
            Some(crate::models::Artifact {
                id,
                name,
                size: 0,
                content_type: if req.operation_id == "diagnostics.bugreport" {
                    "application/zip"
                } else {
                    "application/octet-stream"
                }
                .into(),
                created_at: Utc::now().to_rfc3339(),
            })
        } else {
            None
        };
        // Test parameter compilation before spawning job
        let built_cmd = build_adb_command(
            self.executor.adb_path().to_str().unwrap_or("adb"),
            &req.operation_id,
            req.device_id.as_deref(),
            &req.parameters,
        )?;

        if req.source.as_deref() == Some("mcp") {
            crate::experience::check_policy(
                &self.db,
                &req.operation_id,
                req.device_id.as_deref(),
                &req.parameters,
            )?;
        }
        if self.cancel_tokens.lock().unwrap().len() >= 64 {
            return Err(ApiError::bad_request(
                "JOB_LIMIT",
                "At most 64 queued/running jobs are supported",
            ));
        }
        let job_id = Uuid::new_v4().to_string();
        let cancel_token = CancellationToken::new();

        let (job_tx, _) = broadcast::channel(1024);
        {
            let mut channels = self.job_channels.lock().unwrap();
            channels.insert(job_id.clone(), job_tx.clone());
            let mut tokens = self.cancel_tokens.lock().unwrap();
            tokens.insert(job_id.clone(), cancel_token.clone());
        }

        let source = req.source.unwrap_or_else(|| "gui".to_string());
        let requester = req.requester;

        let initial_job = Job {
            id: job_id.clone(),
            operation_id: req.operation_id.clone(),
            device_id: req.device_id.clone(),
            status: JobStatus::Queued,
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            created_at: Utc::now().to_rfc3339(),
            started_at: None,
            finished_at: None,
            artifact_ids: Vec::new(),
            error: None,
            source,
            requester,
        };

        self.db.insert_job(&initial_job)?;

        // Broadcast initial job state
        let _ = self.global_events.send(serde_json::json!({
            "type": "job_created",
            "data": &initial_job
        }));

        let manager = self.clone();
        let is_destructive = !op.id.starts_with("automation.")
            && op.requires_device
            && !op.id.starts_with("logcat.")
            && (!op.id.starts_with("diagnostics.")
                || matches!(
                    op.id.as_str(),
                    "diagnostics.setprop" | "diagnostics.settings_put"
                ))
            && !matches!(op.id.as_str(), "device.wait_for" | "diagnostics.jdwp");
        let device_id = req.device_id.clone();
        let timeout_ms = *self.default_timeout_ms.lock().unwrap();
        let job_to_run = initial_job.clone();

        tokio::spawn(async move {
            manager
                .run_job_task(
                    job_to_run,
                    built_cmd.program,
                    built_cmd.args,
                    device_id,
                    is_destructive,
                    timeout_ms,
                    cancel_token,
                    job_tx,
                    output_artifact,
                )
                .await;
        });

        Ok(initial_job)
    }

    #[allow(clippy::too_many_arguments)]
    async fn run_job_task(
        &self,
        mut job: Job,
        program: String,
        args: Vec<String>,
        device_id: Option<String>,
        is_destructive: bool,
        timeout_ms: u64,
        cancel_token: CancellationToken,
        job_tx: broadcast::Sender<JobEvent>,
        output_artifact: Option<crate::models::Artifact>,
    ) {
        // If operation is destructive and has a deviceId, hold the device mutation lock
        let _lock = if is_destructive {
            match device_id.as_ref() {
                Some(did) => Some(self.get_device_lock(did).await),
                None => None,
            }
        } else {
            None
        };
        let _guard = match _lock {
            Some(ref l) => {
                tokio::select! { guard = l.lock() => Some(guard), _ = cancel_token.cancelled() => None }
            }
            None => None,
        };

        if job.source == "mcp"
            && self
                .db
                .read_value::<crate::experience::AgentPolicy>("experience.policy")
                .is_ok_and(|p| p.paused)
        {
            cancel_token.cancel();
        }
        if cancel_token.is_cancelled() {
            job.status = JobStatus::Cancelled;
            job.finished_at = Some(Utc::now().to_rfc3339());
            let _ = self.db.update_job(&job);
            if let (Some(artifact), Some(store)) = (&output_artifact, &self.artifacts) {
                let _ = store.delete_artifact_file(&artifact.id).await;
            }
            self.publish_global_event(serde_json::json!({"type":"job_updated","data":job}));
            self.cancel_tokens.lock().unwrap().remove(&job.id);
            self.job_channels.lock().unwrap().remove(&job.id);
            return;
        }
        job.status = JobStatus::Running;
        job.started_at = Some(Utc::now().to_rfc3339());
        let _ = self.db.update_job(&job);

        let _ = job_tx.send(JobEvent {
            event_type: "status".to_string(),
            job_id: job.id.clone(),
            data: serde_json::json!({ "status": "running" }),
        });
        let _ = self.global_events.send(serde_json::json!({
            "type": "job_updated",
            "data": &job
        }));

        let stdout_acc = Arc::new(Mutex::new(String::new()));
        let stderr_acc = Arc::new(Mutex::new(String::new()));

        let progress_stop = CancellationToken::new();
        let progress_cancel = progress_stop.clone();
        let progress_stdout = stdout_acc.clone();
        let progress_stderr = stderr_acc.clone();
        let progress_db = self.db.clone();
        let progress_global = self.global_events.clone();
        let progress_id = job.id.clone();
        let progress_task = tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(500));
            loop {
                tokio::select! {
                    _ = progress_cancel.cancelled() => break,
                    _ = interval.tick() => {
                        if let Ok(Some(mut snapshot)) = progress_db.get_job(&progress_id) {
                            if snapshot.status != JobStatus::Running { break; }
                            snapshot.stdout = progress_stdout.lock().unwrap().clone();
                            snapshot.stderr = progress_stderr.lock().unwrap().clone();
                            let _ = progress_db.update_job(&snapshot);
                            let _ = progress_global.send(serde_json::json!({"type":"job_updated", "data":snapshot}));
                        }
                    }
                }
            }
        });

        let tx_out = job_tx.clone();
        let job_id_out = job.id.clone();
        let acc_out = stdout_acc.clone();
        let on_stdout = move |chunk: String| {
            acc_out.lock().unwrap().push_str(&chunk);
            let _ = tx_out.send(JobEvent {
                event_type: "stdout".to_string(),
                job_id: job_id_out.clone(),
                data: serde_json::json!(chunk),
            });
        };

        let tx_err = job_tx.clone();
        let job_id_err = job.id.clone();
        let acc_err = stderr_acc.clone();
        let on_stderr = move |chunk: String| {
            acc_err.lock().unwrap().push_str(&chunk);
            let _ = tx_err.send(JobEvent {
                event_type: "stderr".to_string(),
                job_id: job_id_err.clone(),
                data: serde_json::json!(chunk),
            });
        };

        let timeout = Duration::from_millis(timeout_ms);
        let result = if job.operation_id == "screen.screencap" {
            let execution = async {
                let store = self.artifacts.as_ref().ok_or_else(|| {
                    ApiError::bad_request(
                        "ARTIFACTS_UNAVAILABLE",
                        "Artifact storage is unavailable",
                    )
                })?;
                let bytes = andrui_media::adb::capture_screencap_png(
                    self.executor.adb_path(),
                    device_id.as_deref().unwrap_or(""),
                )
                .await
                .map_err(|e| ApiError::bad_request("SCREENSHOT_FAILED", e.to_string()))?;
                let artifact = store
                    .save_artifact("screenshot.png", "image/png", &bytes)
                    .await?;
                self.db.insert_artifact(&artifact)?;
                self.publish_global_event(serde_json::json!({
                    "type": "artifact_created",
                    "data": artifact
                }));
                on_stdout(
                    serde_json::json!({"artifactId":artifact.id,"size":artifact.size}).to_string(),
                );
                job.artifact_ids.push(artifact.id);
                Ok(0)
            };
            tokio::select! {
                result = execution => result,
                _ = cancel_token.cancelled() => Err(ApiError::bad_request("JOB_CANCELLED", "Capture cancelled")),
                _ = tokio::time::sleep(timeout) => Err(ApiError::bad_request("SCREENSHOT_TIMEOUT", "Capture timed out")),
            }
        } else if program == "automation-helper" {
            let execution = async {
                let state = self.automation.clone().ok_or_else(|| {
                    ApiError::bad_request("HELPER_UNAVAILABLE", "Automation is unavailable")
                })?;
                let payload = serde_json::from_str(&args[0])
                    .map_err(|e| ApiError::bad_request("INVALID_ACTION", e.to_string()))?;
                let axum::Json(result) = andrui_automation::actions::execute_action(
                    axum::extract::State(state),
                    axum::Json(payload),
                )
                .await
                .map_err(|e| ApiError::bad_request("ACTION_FAILED", e.to_string()))?;
                on_stdout(serde_json::to_string(&result).unwrap_or_default());
                if !result.success || result.matched == Some(false) {
                    return Err(ApiError::bad_request(
                        "ACTION_FAILED",
                        "UI action or assertion failed",
                    ));
                }
                Ok(0)
            };
            tokio::select! {
                result = execution => result,
                _ = cancel_token.cancelled() => Err(ApiError::bad_request("JOB_CANCELLED", "Action observation cancelled; an already delivered action may finish on the device")),
                _ = tokio::time::sleep(timeout) => Err(ApiError::bad_request("ACTION_TIMEOUT", "Action timed out")),
            }
        } else {
            self.executor
                .execute_streaming_program(
                    &program,
                    &args,
                    Some(timeout),
                    Some(cancel_token.clone()),
                    on_stdout,
                    on_stderr,
                )
                .await
        };

        progress_stop.cancel();
        let _ = progress_task.await;
        job.stdout = stdout_acc.lock().unwrap().clone();
        job.stderr = stderr_acc.lock().unwrap().clone();
        job.finished_at = Some(Utc::now().to_rfc3339());

        match result {
            Ok(code) => {
                job.exit_code = Some(code);
                if code == 0 {
                    if let Some(reason) =
                        detect_adb_transport_failure(&job.operation_id, &job.stdout, &job.stderr)
                    {
                        job.status = JobStatus::Failed;
                        job.error = Some(reason);
                    } else {
                        job.status = JobStatus::Completed;
                    }
                } else {
                    job.status = JobStatus::Failed;
                    job.error = Some(format!("Process exited with status code {}", code));
                }
            }
            Err(e) => {
                if cancel_token.is_cancelled() {
                    job.status = JobStatus::Cancelled;
                    job.error = Some("Operation was cancelled by user".to_string());
                } else {
                    job.status = JobStatus::Failed;
                    job.error = Some(e.to_string());
                }
            }
        }

        if let (Some(mut artifact), Some(store)) = (output_artifact, &self.artifacts) {
            if job.status == JobStatus::Completed {
                let saved = async {
                    let path = store.path_for(&artifact.id).await?;
                    let meta = tokio::fs::metadata(path)
                        .await
                        .map_err(|e| ApiError::internal("ARTIFACT_READ_FAILED", e.to_string()))?;
                    if !meta.is_file() || meta.len() == 0 {
                        return Err(ApiError::bad_request(
                            "EMPTY_ARTIFACT",
                            "The command produced no downloadable file",
                        ));
                    }
                    artifact.size = meta.len();
                    self.db.insert_artifact(&artifact)?;
                    self.publish_global_event(serde_json::json!({
                        "type": "artifact_created",
                        "data": artifact
                    }));
                    Ok::<_, ApiError>(())
                };
                match saved.await {
                    Ok(()) => job.artifact_ids.push(artifact.id.clone()),
                    Err(error) => {
                        job.status = JobStatus::Failed;
                        job.error = Some(error.to_string());
                        let _ = store.delete_artifact_file(&artifact.id).await;
                    }
                }
            } else {
                let _ = store.delete_artifact_file(&artifact.id).await;
            }
        }

        let _ = self.db.update_job(&job);

        let _ = job_tx.send(JobEvent {
            event_type: "status".to_string(),
            job_id: job.id.clone(),
            data: serde_json::json!({
                "status": job.status.as_str(),
                "exitCode": job.exit_code,
                "error": job.error
            }),
        });

        let _ = self.global_events.send(serde_json::json!({
            "type": "job_updated",
            "data": &job
        }));

        // Cleanup active tracking
        {
            let mut channels = self.job_channels.lock().unwrap();
            channels.remove(&job.id);
            let mut tokens = self.cancel_tokens.lock().unwrap();
            tokens.remove(&job.id);
        }
    }

    pub async fn get_job(&self, id: &str) -> ApiResult<Job> {
        self.db
            .get_job(id)?
            .ok_or_else(|| ApiError::not_found("JOB_NOT_FOUND", format!("Job '{}' not found", id)))
    }

    pub async fn list_jobs(
        &self,
        limit: Option<u32>,
        offset: Option<u32>,
        full_output: bool,
    ) -> ApiResult<Vec<Job>> {
        self.db.list_jobs(limit, offset, full_output)
    }

    pub async fn count_jobs(&self) -> ApiResult<u64> {
        self.db.count_jobs()
    }

    pub async fn cancel_agent_jobs(&self) -> ApiResult<Vec<String>> {
        let ids: Vec<String> = self.cancel_tokens.lock().unwrap().keys().cloned().collect();
        let mut cancelled = Vec::new();
        for id in ids {
            if self.db.get_job(&id)?.is_some_and(|job| job.source == "mcp") {
                self.cancel_job(&id).await?;
                cancelled.push(id);
            }
        }
        Ok(cancelled)
    }

    pub async fn cancel_job(&self, id: &str) -> ApiResult<Job> {
        let token = {
            let tokens = self.cancel_tokens.lock().unwrap();
            tokens.get(id).cloned()
        };

        if let Some(t) = token {
            t.cancel();
        }

        // Return current job status
        self.get_job(id).await
    }
}

/// `adb connect` and `adb pair` exit with status 0 even when the connection or pairing fails,
/// reporting the failure only in stdout/stderr.
fn detect_adb_transport_failure(operation_id: &str, stdout: &str, stderr: &str) -> Option<String> {
    let prefixes: &[&str] = match operation_id {
        "device.connect" => &[
            "failed to connect",
            "cannot connect",
            "unable to connect",
            "failed:",
        ],
        "device.pair" => &["failed:", "failed to ", "cannot ", "unable to "],
        _ => return None,
    };

    stdout
        .lines()
        .chain(stderr.lines())
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .find(|line| {
            let lower = line.to_ascii_lowercase();
            prefixes.iter().any(|prefix| lower.starts_with(prefix))
        })
        .map(str::to_string)
}

#[cfg(test)]
mod tests {
    use super::detect_adb_transport_failure;

    #[test]
    fn detects_adb_connect_failures() {
        assert_eq!(
            detect_adb_transport_failure(
                "device.connect",
                "failed to connect to '127.0.0.1:59999': Connection refused\n",
                "",
            ),
            Some("failed to connect to '127.0.0.1:59999': Connection refused".to_string())
        );
        assert_eq!(
            detect_adb_transport_failure(
                "device.connect",
                "cannot connect to 192.168.1.5:5555: Connection timed out\n",
                "",
            ),
            Some("cannot connect to 192.168.1.5:5555: Connection timed out".to_string())
        );
        assert_eq!(
            detect_adb_transport_failure("device.connect", "connected to 192.168.1.5:5555\n", ""),
            None
        );
        assert_eq!(
            detect_adb_transport_failure(
                "device.connect",
                "already connected to 192.168.1.5:5555\n",
                ""
            ),
            None
        );
    }

    #[test]
    fn detects_adb_pair_failures() {
        assert_eq!(
            detect_adb_transport_failure(
                "device.pair",
                "Failed: Unable to start pairing client.\n",
                "",
            ),
            Some("Failed: Unable to start pairing client.".to_string())
        );
        assert_eq!(
            detect_adb_transport_failure(
                "device.pair",
                "Successfully paired to 192.168.1.5:38291 [guid=adb-123]\n",
                "",
            ),
            None
        );
    }
}
