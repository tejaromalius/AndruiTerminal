//! Own only emulator processes started here; never terminate an external emulator.
use crate::{
    error::{ApiError, ApiResult},
    server::state::AppState,
};
use axum::{
    extract::{Path, State},
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, path::PathBuf, process::Stdio, sync::Arc, time::Duration};
use tokio::{
    io::AsyncReadExt,
    process::{Child, Command},
    sync::Mutex,
};

#[derive(Clone, Default)]
pub struct EmulatorManager {
    binary: Option<PathBuf>,
    sessions: Arc<Mutex<HashMap<String, OwnedEmulator>>>,
}
struct OwnedEmulator {
    child: Child,
    log: Arc<Mutex<Vec<u8>>>,
    started_at: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorStatus {
    pub available: bool,
    pub reason: Option<String>,
    pub avds: Vec<String>,
    pub sessions: Vec<EmulatorSession>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmulatorSession {
    pub name: String,
    pub pid: Option<u32>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub log: String,
    pub started_at: String,
}
#[derive(Deserialize)]
pub struct LaunchRequest {
    pub name: String,
}
#[derive(Deserialize)]
pub struct StopRequest {
    #[serde(default)]
    pub confirmed: bool,
}

impl EmulatorManager {
    pub fn discover() -> Self {
        let mut candidates = Vec::new();
        for name in ["ANDROID_SDK_ROOT", "ANDROID_HOME"] {
            if let Some(root) = std::env::var_os(name) {
                candidates.push(PathBuf::from(root).join("emulator/emulator"));
            }
        }
        if let Some(home) = std::env::var_os("HOME") {
            candidates.push(PathBuf::from(home).join("Android/Sdk/emulator/emulator"));
        }
        if let Some(paths) = std::env::var_os("PATH") {
            candidates.extend(std::env::split_paths(&paths).map(|p| p.join("emulator")));
        }
        Self {
            binary: candidates.into_iter().find(|p| p.is_file()),
            ..Default::default()
        }
    }
    pub fn with_binary(binary: PathBuf) -> Self {
        Self {
            binary: Some(binary),
            ..Default::default()
        }
    }
    async fn avds(&self) -> ApiResult<Vec<String>> {
        let binary = self.binary.as_ref().ok_or_else(|| ApiError::bad_request("EMULATOR_UNAVAILABLE","Android SDK emulator not found; configure ANDROID_SDK_ROOT or ANDROID_HOME before starting the server"))?;
        let mut child = Command::new(binary)
            .arg("-list-avds")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ApiError::bad_request("EMULATOR_UNAVAILABLE", e.to_string()))?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| ApiError::internal("EMULATOR_OUTPUT", "Missing emulator output"))?
            .take(65537);
        let mut bytes = Vec::new();
        let status = tokio::time::timeout(Duration::from_secs(10), async {
            stdout.read_to_end(&mut bytes).await?;
            child.wait().await
        })
        .await
        .map_err(|_| ApiError::bad_request("EMULATOR_TIMEOUT", "Emulator discovery timed out"))?
        .map_err(|e| ApiError::bad_request("EMULATOR_FAILED", e.to_string()))?;
        if !status.success() || bytes.len() > 65536 {
            return Err(ApiError::bad_request(
                "EMULATOR_FAILED",
                "Emulator discovery failed or returned too much output",
            ));
        }
        Ok(String::from_utf8_lossy(&bytes)
            .lines()
            .map(str::trim)
            .filter(|n| !n.is_empty())
            .map(str::to_owned)
            .collect())
    }
    pub async fn status(&self) -> ApiResult<EmulatorStatus> {
        let (avds, reason) = match self.avds().await {
            Ok(avds) => (avds, None),
            Err(error) => (Vec::new(), Some(error.to_string())),
        };
        let mut sessions = Vec::new();
        let mut owned = self.sessions.lock().await;
        for (name, session) in owned.iter_mut() {
            let exit = session
                .child
                .try_wait()
                .map_err(|e| ApiError::internal("EMULATOR_STATUS", e.to_string()))?;
            sessions.push(EmulatorSession {
                name: name.clone(),
                pid: session.child.id(),
                status: if exit.is_some() { "exited" } else { "running" }.into(),
                exit_code: exit.and_then(|s| s.code()),
                log: String::from_utf8_lossy(&session.log.lock().await).into_owned(),
                started_at: session.started_at.clone(),
            });
        }
        Ok(EmulatorStatus {
            available: reason.is_none(),
            reason,
            avds,
            sessions,
        })
    }
    pub async fn launch(&self, name: &str) -> ApiResult<()> {
        if name.is_empty()
            || name.len() > 200
            || !name
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "_.-".contains(c))
            || !self.avds().await?.iter().any(|n| n == name)
        {
            return Err(ApiError::bad_request(
                "INVALID_AVD",
                "Select an AVD returned by discovery",
            ));
        }
        let mut sessions = self.sessions.lock().await;
        if let Some(session) = sessions.get_mut(name) {
            if session
                .child
                .try_wait()
                .map_err(|e| ApiError::internal("EMULATOR_STATUS", e.to_string()))?
                .is_none()
            {
                return Err(ApiError::conflict(
                    "EMULATOR_RUNNING",
                    "This AVD is already running here",
                ));
            }
        }
        if sessions
            .values_mut()
            .filter_map(|s| s.child.try_wait().ok())
            .filter(Option::is_none)
            .count()
            >= 4
        {
            return Err(ApiError::bad_request(
                "EMULATOR_LIMIT",
                "At most four owned emulators may run at once",
            ));
        }
        let mut child = Command::new(self.binary.as_ref().unwrap())
            .args(["-avd", name, "-no-snapshot-save"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| ApiError::bad_request("EMULATOR_LAUNCH_FAILED", e.to_string()))?;
        let log = Arc::new(Mutex::new(Vec::new()));
        async fn drain(mut stream: impl tokio::io::AsyncRead + Unpin, log: Arc<Mutex<Vec<u8>>>) {
            let mut chunk = [0u8; 4096];
            while let Ok(size) = stream.read(&mut chunk).await {
                if size == 0 {
                    break;
                }
                let mut bytes = log.lock().await;
                bytes.extend_from_slice(&chunk[..size]);
                let excess = bytes.len().saturating_sub(32768);
                bytes.drain(..excess);
            }
        }
        if let Some(stdout) = child.stdout.take() {
            tokio::spawn(drain(stdout, log.clone()));
        }
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(drain(stderr, log.clone()));
        }
        sessions.insert(
            name.into(),
            OwnedEmulator {
                child,
                log,
                started_at: chrono::Utc::now().to_rfc3339(),
            },
        );
        Ok(())
    }
    pub async fn stop(&self, name: &str) -> ApiResult<()> {
        let mut sessions = self.sessions.lock().await;
        let session = sessions.get_mut(name).ok_or_else(|| {
            ApiError::not_found(
                "EMULATOR_NOT_OWNED",
                "Only emulators launched here can be stopped here",
            )
        })?;
        if session
            .child
            .try_wait()
            .map_err(|e| ApiError::internal("EMULATOR_STATUS", e.to_string()))?
            .is_none()
        {
            session
                .child
                .kill()
                .await
                .map_err(|e| ApiError::internal("EMULATOR_STOP_FAILED", e.to_string()))?;
        }
        Ok(())
    }
    pub async fn cleanup(&self) {
        let names: Vec<_> = self.sessions.lock().await.keys().cloned().collect();
        for name in names {
            let _ = self.stop(&name).await;
        }
    }
}
pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/emulators", get(status).post(launch))
        .route("/emulators/{name}/stop", post(stop))
}
async fn status(State(s): State<AppState>) -> ApiResult<Json<EmulatorStatus>> {
    Ok(Json(s.emulators.status().await?))
}
async fn launch(
    State(s): State<AppState>,
    Json(req): Json<LaunchRequest>,
) -> ApiResult<Json<EmulatorStatus>> {
    s.emulators.launch(&req.name).await?;
    Ok(Json(s.emulators.status().await?))
}
async fn stop(
    State(s): State<AppState>,
    Path(name): Path<String>,
    Json(req): Json<StopRequest>,
) -> ApiResult<Json<EmulatorStatus>> {
    if !req.confirmed {
        return Err(ApiError::bad_request(
            "CONFIRMATION_REQUIRED",
            "Confirm stopping this owned emulator",
        ));
    }
    s.emulators.stop(&name).await?;
    Ok(Json(s.emulators.status().await?))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn missing_sdk_is_actionable_and_never_claims_success() {
        let manager = EmulatorManager::default();
        let status = manager.status().await.unwrap();
        assert!(!status.available);
        assert!(status.reason.unwrap().contains("ANDROID_SDK_ROOT"));
        assert!(manager.launch("test").await.is_err());
        assert!(manager.stop("external").await.is_err());
    }
    #[tokio::test]
    async fn owned_process_lifecycle_uses_only_discovered_avds() {
        use std::os::unix::fs::PermissionsExt;
        let directory = tempfile::tempdir().unwrap();
        let binary = directory.path().join("emulator");
        std::fs::write(&binary,"#!/usr/bin/env python3\nimport sys,time\nif '-list-avds' in sys.argv:\n print('Test_AVD')\nelse:\n print('Starting test emulator',flush=True)\n time.sleep(60)\n").unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let manager = EmulatorManager::with_binary(binary);
        assert_eq!(manager.status().await.unwrap().avds, vec!["Test_AVD"]);
        assert!(manager.launch("unknown").await.is_err());
        manager.launch("Test_AVD").await.unwrap();
        assert!(manager.launch("Test_AVD").await.is_err());
        assert_eq!(
            manager.status().await.unwrap().sessions[0].status,
            "running"
        );
        manager.stop("Test_AVD").await.unwrap();
        assert_eq!(manager.status().await.unwrap().sessions[0].status, "exited");
    }
}
