use std::collections::HashMap;
use std::sync::Arc;
use tokio::process::Child;
use tokio::sync::{broadcast, watch, Mutex, RwLock};

use crate::config::ExtensionsConfig;
use crate::error::ApiError;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordedStep {
    pub action: String,
    pub selector: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    pub timestamp: u64,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingSession {
    pub id: String,
    pub device_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub started_at: u64,
    pub steps: Vec<RecordedStep>,
}

pub struct AutomationSession {
    pub id: String,
    pub device_id: String,
    pub token: String,
    pub host_port: u16,
    pub helper_version: String,
    pub created_at: u64,
    pub child: Mutex<Option<Child>>,
    pub action_lock: Arc<tokio::sync::Mutex<()>>,
}

impl AutomationSession {
    /// Safe helper URL generator - always binds strictly to host loopback.
    pub fn helper_url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{}", self.host_port, path)
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: ExtensionsConfig,
    pub http_client: reqwest::Client,
    pub sessions: Arc<RwLock<HashMap<String, Arc<AutomationSession>>>>,
    pub device_sessions: Arc<RwLock<HashMap<String, String>>>,
    pub device_startup_locks: Arc<tokio::sync::Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    pub recordings: Arc<RwLock<HashMap<String, RecordingSession>>>,
    pub active_replays: Arc<RwLock<HashMap<String, Arc<watch::Sender<bool>>>>>,
    pub replay_channels: Arc<RwLock<HashMap<String, broadcast::Sender<String>>>>,
}

impl AppState {
    pub fn new(config: ExtensionsConfig) -> Self {
        let http_client = reqwest::Client::builder()
            .no_proxy()
            .timeout(std::time::Duration::from_secs(35))
            .build()
            .expect("Failed to build reqwest client");

        Self {
            config,
            http_client,
            sessions: Arc::new(RwLock::new(HashMap::new())),
            device_sessions: Arc::new(RwLock::new(HashMap::new())),
            device_startup_locks: Arc::new(tokio::sync::Mutex::new(HashMap::new())),
            recordings: Arc::new(RwLock::new(HashMap::new())),
            active_replays: Arc::new(RwLock::new(HashMap::new())),
            replay_channels: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Per-device startup lock to serialize concurrent session creation per device.
    pub async fn get_device_startup_lock(&self, device_id: &str) -> Arc<tokio::sync::Mutex<()>> {
        let mut locks = self.device_startup_locks.lock().await;
        locks
            .entry(device_id.to_string())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
            .clone()
    }

    /// Retrieve active automation session for a specific device.
    pub async fn get_device_session(
        &self,
        device_id: &str,
    ) -> Result<Arc<AutomationSession>, ApiError> {
        let session_id = {
            let dev_map = self.device_sessions.read().await;
            dev_map.get(device_id).cloned().ok_or_else(|| {
                ApiError::not_found(
                    "session_not_found",
                    format!("No active automation session for device '{}'", device_id),
                )
            })?
        };

        let sessions = self.sessions.read().await;
        sessions.get(&session_id).cloned().ok_or_else(|| {
            ApiError::not_found(
                "session_not_found",
                format!("Automation session '{}' not found", session_id),
            )
        })
    }
}
