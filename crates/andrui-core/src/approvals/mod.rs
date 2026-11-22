//! Approval queue for operations submitted by agents (e.g. the MCP subcommand).
//!
//! Destructive operations and arbitrary device shell commands wait here until the user
//! approves them in the browser UI. Other operations run immediately and are recorded as
//! `not_required`. This guards agents that use the MCP tools; any local process with a
//! session can still call the job API directly (single-user threat model).

use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};

use crate::error::{ApiError, ApiResult};
use crate::models::{CommandPreview, Operation};

pub mod notify;

const PENDING_TTL: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING: usize = 100;
const MAX_ENTRIES: usize = 200;

/// Read-only operations an agent may run without the user's approval.
pub fn is_agent_observation(operation: &str) -> bool {
    matches!(
        operation,
        "device.list"
            | "logcat.dump"
            | "logcat.stats"
            | "automation.wait"
            | "automation.assert"
            | "screen.screencap"
            | "diagnostics.getprop"
            | "diagnostics.settings_get"
            | "diagnostics.cpu"
            | "diagnostics.meminfo"
            | "diagnostics.gfxinfo"
            | "package.list"
            | "package.path"
            | "users.list"
    )
}

pub fn requires_agent_approval(op: &Operation) -> bool {
    op.destructive || !is_agent_observation(&op.id)
}

/// How much an agent request can change the device.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    /// Runs without approval.
    Low,
    /// Device operation outside the read-only allowlist; needs approval.
    Medium,
    /// Destructive catalog operation; needs approval.
    High,
}

pub fn severity(op: &Operation) -> Severity {
    if op.destructive {
        Severity::High
    } else if requires_agent_approval(op) {
        Severity::Medium
    } else {
        Severity::Low
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalStatus {
    Pending,
    Approved,
    Denied,
    Expired,
    Failed,
    NotRequired,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approval {
    pub id: String,
    pub operation_id: String,
    pub operation_label: String,
    pub destructive: bool,
    pub severity: Severity,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_id: Option<String>,
    pub parameters: serde_json::Map<String, serde_json::Value>,
    pub preview: CommandPreview,
    pub requester: String,
    pub status: ApprovalStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub job_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    pub created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resolved_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateApprovalRequest {
    pub operation_id: String,
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
    pub requester: String,
}

struct Entry {
    approval: Approval,
    created: Instant,
}

/// In-memory store; pending approvals are dropped on restart.
#[derive(Clone, Default)]
pub struct ApprovalStore {
    entries: Arc<Mutex<Vec<Entry>>>,
    db: Option<crate::storage::db::Database>,
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn expire(entries: &mut [Entry], ttl: Duration) {
    for entry in entries.iter_mut() {
        if entry.approval.status == ApprovalStatus::Pending && entry.created.elapsed() >= ttl {
            entry.approval.status = ApprovalStatus::Expired;
            entry.approval.resolved_at = Some(now());
        }
    }
}

impl ApprovalStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn persistent(db: crate::storage::db::Database) -> ApiResult<Self> {
        let saved: Vec<Approval> = db.read_value("experience.approvals")?;
        let entries = saved
            .into_iter()
            .map(|mut approval| {
                if approval.status == ApprovalStatus::Pending
                    || (approval.status == ApprovalStatus::Approved && approval.job_id.is_none())
                {
                    approval.status = ApprovalStatus::Expired;
                    approval.resolved_at = Some(now());
                    approval.error = Some("Server restarted; submit a new request".into());
                }
                Entry {
                    approval,
                    created: Instant::now(),
                }
            })
            .collect();
        let store = Self {
            entries: Arc::new(Mutex::new(entries)),
            db: Some(db),
        };
        store.with_entries(|_| ())?;
        Ok(store)
    }

    fn with_entries<T>(&self, f: impl FnOnce(&mut Vec<Entry>) -> T) -> ApiResult<T> {
        let mut entries = self.entries.lock().unwrap();
        expire(&mut entries, PENDING_TTL);
        let result = f(&mut entries);
        if let Some(db) = &self.db {
            db.write_value(
                "experience.approvals",
                &entries.iter().map(|e| &e.approval).collect::<Vec<_>>(),
            )?;
        }
        Ok(result)
    }

    pub fn insert(&self, approval: Approval) -> ApiResult<Approval> {
        self.with_entries(|entries| {
            let pending = entries
                .iter()
                .filter(|e| e.approval.status == ApprovalStatus::Pending)
                .count();
            if approval.status == ApprovalStatus::Pending && pending >= MAX_PENDING {
                return Err(ApiError::bad_request(
                    "APPROVAL_LIMIT",
                    format!("At most {MAX_PENDING} pending approvals are supported"),
                ));
            }
            entries.push(Entry {
                approval: approval.clone(),
                created: Instant::now(),
            });
            while entries.len() > MAX_ENTRIES {
                match entries
                    .iter()
                    .position(|e| e.approval.status != ApprovalStatus::Pending)
                {
                    Some(index) => {
                        entries.remove(index);
                    }
                    None => break,
                }
            }
            Ok(approval)
        })?
    }

    /// Newest first.
    pub fn list(&self) -> ApiResult<Vec<Approval>> {
        self.with_entries(|entries| entries.iter().rev().map(|e| e.approval.clone()).collect())
    }

    pub fn get(&self, id: &str) -> ApiResult<Approval> {
        self.with_entries(|entries| {
            entries
                .iter()
                .find(|e| e.approval.id == id)
                .map(|e| e.approval.clone())
                .ok_or_else(|| ApiError::not_found("APPROVAL_NOT_FOUND", "Approval not found"))
        })?
    }

    /// Moves a pending approval to `status`. Fails with 409 when it is no longer pending,
    /// so an approval can be claimed only once.
    pub fn resolve(&self, id: &str, status: ApprovalStatus) -> ApiResult<Approval> {
        self.with_entries(|entries| {
            let entry = entries
                .iter_mut()
                .find(|e| e.approval.id == id)
                .ok_or_else(|| ApiError::not_found("APPROVAL_NOT_FOUND", "Approval not found"))?;
            if entry.approval.status != ApprovalStatus::Pending {
                return Err(ApiError::conflict(
                    "APPROVAL_NOT_PENDING",
                    format!(
                        "Approval is {}",
                        serde_json::to_value(entry.approval.status)
                            .ok()
                            .and_then(|v| v.as_str().map(str::to_string))
                            .unwrap_or_default()
                    ),
                ));
            }
            entry.approval.status = status;
            entry.approval.resolved_at = Some(now());
            Ok(entry.approval.clone())
        })?
    }

    /// Records the outcome of starting the job for an approved request.
    pub fn record_job(
        &self,
        id: &str,
        result: Result<String, String>,
    ) -> ApiResult<Option<Approval>> {
        self.with_entries(|entries| {
            let entry = entries.iter_mut().find(|e| e.approval.id == id)?;
            match result {
                Ok(job_id) => entry.approval.job_id = Some(job_id),
                Err(error) => {
                    entry.approval.status = ApprovalStatus::Failed;
                    entry.approval.error = Some(error);
                }
            }
            Some(entry.approval.clone())
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approval(id: &str, status: ApprovalStatus) -> Approval {
        Approval {
            id: id.to_string(),
            operation_id: "shell.exec".to_string(),
            operation_label: "Shell".to_string(),
            destructive: false,
            severity: Severity::Medium,
            device_id: Some("dev".to_string()),
            parameters: Default::default(),
            preview: CommandPreview {
                program: "adb".to_string(),
                args: vec![],
                display: "adb".to_string(),
            },
            requester: "test".to_string(),
            status,
            job_id: None,
            error: None,
            created_at: now(),
            resolved_at: None,
        }
    }

    #[test]
    fn approval_can_be_claimed_once() {
        let store = ApprovalStore::new();
        store
            .insert(approval("a", ApprovalStatus::Pending))
            .unwrap();
        let claimed = store.resolve("a", ApprovalStatus::Approved).unwrap();
        assert_eq!(claimed.status, ApprovalStatus::Approved);
        assert!(claimed.resolved_at.is_some());
        assert!(matches!(
            store.resolve("a", ApprovalStatus::Approved),
            Err(ApiError::Conflict { .. })
        ));
        assert!(matches!(
            store.resolve("a", ApprovalStatus::Denied),
            Err(ApiError::Conflict { .. })
        ));
        assert!(matches!(
            store.resolve("missing", ApprovalStatus::Denied),
            Err(ApiError::NotFound { .. })
        ));
    }

    #[test]
    fn record_job_sets_job_or_failure() {
        let store = ApprovalStore::new();
        store
            .insert(approval("a", ApprovalStatus::Pending))
            .unwrap();
        store
            .insert(approval("b", ApprovalStatus::Pending))
            .unwrap();
        store.resolve("a", ApprovalStatus::Approved).unwrap();
        store.resolve("b", ApprovalStatus::Approved).unwrap();
        let a = store
            .record_job("a", Ok("job-1".to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(a.job_id.as_deref(), Some("job-1"));
        let b = store
            .record_job("b", Err("boom".to_string()))
            .unwrap()
            .unwrap();
        assert_eq!(b.status, ApprovalStatus::Failed);
        assert_eq!(b.error.as_deref(), Some("boom"));
    }

    #[test]
    fn pending_approvals_expire() {
        let mut entries = vec![Entry {
            approval: approval("a", ApprovalStatus::Pending),
            created: Instant::now(),
        }];
        expire(&mut entries, Duration::ZERO);
        assert_eq!(entries[0].approval.status, ApprovalStatus::Expired);
        assert!(entries[0].approval.resolved_at.is_some());
    }

    #[test]
    fn pending_limit_and_resolved_eviction() {
        let store = ApprovalStore::new();
        for i in 0..MAX_PENDING {
            store
                .insert(approval(&format!("p{i}"), ApprovalStatus::Pending))
                .unwrap();
        }
        assert!(store
            .insert(approval("over", ApprovalStatus::Pending))
            .is_err());
        for i in 0..(MAX_ENTRIES + 10) {
            store
                .insert(approval(&format!("r{i}"), ApprovalStatus::NotRequired))
                .unwrap();
        }
        let list = store.list().unwrap();
        assert_eq!(list.len(), MAX_ENTRIES);
        assert_eq!(
            list.iter()
                .filter(|a| a.status == ApprovalStatus::Pending)
                .count(),
            MAX_PENDING
        );
        assert_eq!(list[0].id, format!("r{}", MAX_ENTRIES + 9));
    }

    #[test]
    fn policy_covers_destructive_and_shell() {
        let mut op = crate::operations::get_operation_catalog()
            .into_iter()
            .find(|o| o.id == "shell.exec")
            .unwrap();
        assert!(requires_agent_approval(&op));
        assert_eq!(severity(&op), Severity::Medium);
        op.id = "device.list".to_string();
        op.destructive = false;
        assert!(!requires_agent_approval(&op));
        assert_eq!(severity(&op), Severity::Low);
        op.destructive = true;
        assert!(requires_agent_approval(&op));
        assert_eq!(severity(&op), Severity::High);
    }
    #[test]
    fn persistence_retains_decisions_and_expires_unresolved_requests_on_restart() {
        let directory = tempfile::tempdir().unwrap();
        let db = crate::storage::db::Database::new(directory.path().join("test.db")).unwrap();
        let store = ApprovalStore::persistent(db.clone()).unwrap();
        store
            .insert(approval("pending", ApprovalStatus::Pending))
            .unwrap();
        store
            .insert(approval("denied", ApprovalStatus::Pending))
            .unwrap();
        store.resolve("denied", ApprovalStatus::Denied).unwrap();
        drop(store);
        let restored = ApprovalStore::persistent(db).unwrap();
        assert_eq!(
            restored.get("pending").unwrap().status,
            ApprovalStatus::Expired
        );
        assert_eq!(
            restored.get("denied").unwrap().status,
            ApprovalStatus::Denied
        );
        assert!(restored
            .resolve("pending", ApprovalStatus::Approved)
            .is_err());
    }
}
