use std::time::Duration;

use crate::error::{ApiError, ApiResult};
use crate::jobs::manager::JobManager;
use crate::models::{Assertion, CreateJobRequest, Job, JobStatus};
use crate::storage::db::Database;

#[derive(Clone)]
pub struct WorkflowRunner {
    job_manager: JobManager,
    db: Database,
    active: std::sync::Arc<
        tokio::sync::Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>,
    >,
}

impl WorkflowRunner {
    pub fn new(job_manager: JobManager, db: Database) -> Self {
        Self {
            job_manager,
            db,
            active: Default::default(),
        }
    }

    pub async fn cancel(&self, id: &str) -> ApiResult<()> {
        let active = self.active.lock().await;
        let token = active.get(id).ok_or_else(|| {
            ApiError::conflict("RUN_NOT_ACTIVE", "This workflow run is no longer active")
        })?;
        token.cancel();
        Ok(())
    }

    pub async fn run_recorded(
        &self,
        workflow_id: &str,
        device_ids: &[String],
        confirmed: bool,
    ) -> ApiResult<(Vec<String>, String)> {
        let workflow = self
            .db
            .get_workflow(workflow_id)?
            .ok_or_else(|| ApiError::not_found("WORKFLOW_NOT_FOUND", "Workflow not found"))?;
        crate::experience::validate_workflow(&crate::models::CreateWorkflowRequest {
            name: workflow.name.clone(),
            steps: workflow.steps.clone(),
        })?;
        if device_ids.is_empty()
            || device_ids.len() > 32
            || device_ids.iter().any(|d| d.trim().is_empty())
            || device_ids
                .iter()
                .collect::<std::collections::HashSet<_>>()
                .len()
                != device_ids.len()
        {
            return Err(ApiError::bad_request(
                "INVALID_TARGETS",
                "Select 1-32 distinct explicit devices",
            ));
        }
        if workflow.steps.iter().any(|step| {
            crate::operations::catalog::get_operation_catalog()
                .iter()
                .any(|op| op.id == step.operation_id && op.destructive)
        }) && !confirmed
        {
            return Err(ApiError::bad_request(
                "CONFIRMATION_REQUIRED",
                "Confirm destructive workflow steps for these devices",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let token = tokio_util::sync::CancellationToken::new();
        let mut report = super::reports::RunReport {
            id: id.clone(),
            workflow,
            device_ids: device_ids.to_vec(),
            created_at: chrono::Utc::now().to_rfc3339(),
            finished_at: None,
            status: "running".into(),
            steps: vec![],
            error: None,
        };
        self.db
            .write_value(&format!("experience.run.{id}"), &report)?;
        self.db
            .prepend_report("experience.workflow-runs", &id, "experience.run.")?;
        self.active.lock().await.insert(id.clone(), token.clone());
        let result = self
            .run_inner(workflow_id, device_ids, confirmed, token.clone(), Some(&id))
            .await;
        self.active.lock().await.remove(&id);
        let jobs = self.db.jobs_for_requester(&id)?;
        let mut jobs = jobs;
        jobs.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        report.steps = super::reports::results(&report.workflow, device_ids, &jobs);
        report.error = result.as_ref().err().map(ToString::to_string);
        report.status = if token.is_cancelled() {
            "cancelled"
        } else if report.error.is_some() || report.steps.iter().any(|s| s.status != "completed") {
            "failed"
        } else {
            "completed"
        }
        .into();
        report.finished_at = Some(chrono::Utc::now().to_rfc3339());
        self.db
            .write_value(&format!("experience.run.{id}"), &report)?;
        self.job_manager
            .publish_global_event(serde_json::json!({"type":"workflow_finished","data":report}));
        Ok((jobs.iter().map(|j| j.id.clone()).collect(), id))
    }

    pub fn evaluate_assertion(assertion: &Assertion, job: &Job) -> bool {
        match assertion.kind.as_str() {
            "exit_code_zero" => job.exit_code == Some(0),
            "exit_code_equals" => {
                let target = assertion
                    .value
                    .as_ref()
                    .and_then(|v| v.as_i64())
                    .map(|v| v as i32);
                target.is_some() && job.exit_code == target
            }
            "stdout_contains" => {
                if let Some(target) = assertion.value.as_ref().and_then(|v| v.as_str()) {
                    job.stdout.contains(target)
                } else {
                    false
                }
            }
            "stderr_empty" => job.stderr.trim().is_empty(),
            _ => false,
        }
    }

    pub async fn run_workflow(
        &self,
        workflow_id: &str,
        device_ids: &[String],
        confirmed: bool,
    ) -> ApiResult<Vec<String>> {
        self.run_inner(
            workflow_id,
            device_ids,
            confirmed,
            tokio_util::sync::CancellationToken::new(),
            None,
        )
        .await
    }

    async fn run_inner(
        &self,
        workflow_id: &str,
        device_ids: &[String],
        confirmed: bool,
        token: tokio_util::sync::CancellationToken,
        run_id: Option<&str>,
    ) -> ApiResult<Vec<String>> {
        let workflow = self
            .db
            .get_workflow(workflow_id)?
            .ok_or_else(|| ApiError::not_found("WORKFLOW_NOT_FOUND", "Workflow not found"))?;

        if device_ids.is_empty() || device_ids.len() > 32 {
            return Err(ApiError::bad_request(
                "INVALID_TARGETS",
                "Select between 1 and 32 devices",
            ));
        }
        let catalog = crate::operations::catalog::get_operation_catalog();
        for step in &workflow.steps {
            let op = catalog
                .iter()
                .find(|op| op.id == step.operation_id)
                .ok_or_else(|| ApiError::bad_request("UNKNOWN_OPERATION", &step.operation_id))?;
            if op.destructive && !confirmed {
                return Err(ApiError::bad_request("CONFIRMATION_REQUIRED", "This workflow contains destructive steps; confirm execution for the selected devices"));
            }
            if let Some(assertion) = &step.assertion {
                if !matches!(
                    assertion.kind.as_str(),
                    "exit_code_zero" | "exit_code_equals" | "stdout_contains" | "stderr_empty"
                ) {
                    return Err(ApiError::bad_request("UNKNOWN_ASSERTION", &assertion.kind));
                }
            }
        }
        let runs = device_ids.iter().map(|device_id| {
            let workflow = &workflow;
            let token = token.clone();
            async move {
                let mut job_ids = Vec::new();
                for step in &workflow.steps {
                    if token.is_cancelled() {
                        break;
                    }
                    let job = self
                        .job_manager
                        .create_job(CreateJobRequest {
                            operation_id: step.operation_id.clone(),
                            device_id: Some(device_id.clone()),
                            parameters: step.parameters.clone(),
                            confirmed: Some(confirmed),
                            source: Some("workflow".to_string()),
                            requester: Some(run_id.unwrap_or(&workflow.name).to_string()),
                        })
                        .await?;

                    let current_job_id = job.id.clone();
                    job_ids.push(current_job_id.clone());

                    // Poll job completion for sequencing
                    let max_wait = Duration::from_millis(step.timeout_ms.unwrap_or(60_000));
                    let poll_interval = Duration::from_millis(100);
                    let start = std::time::Instant::now();

                    let mut completed_job = job;
                    while start.elapsed() < max_wait {
                        if token.is_cancelled() {
                            self.job_manager.cancel_job(&current_job_id).await?;
                            break;
                        }
                        if let Ok(updated) = self.job_manager.get_job(&current_job_id).await {
                            if matches!(
                                updated.status,
                                JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
                            ) {
                                completed_job = updated;
                                break;
                            }
                        }
                        tokio::time::sleep(poll_interval).await;
                    }

                    if !matches!(
                        completed_job.status,
                        JobStatus::Completed | JobStatus::Failed | JobStatus::Cancelled
                    ) {
                        self.job_manager.cancel_job(&current_job_id).await?;
                        break;
                    }
                    // If step has an assertion, verify it before continuing
                    if let Some(ref assertion) = step.assertion {
                        if !Self::evaluate_assertion(assertion, &completed_job) {
                            tracing::warn!(
                                "Workflow step assertion failed for job {} (kind: {})",
                                current_job_id,
                                assertion.kind
                            );
                            break; // Stop execution on this device
                        }
                    }

                    if completed_job.status != JobStatus::Completed {
                        tracing::warn!(
                            "Workflow step failed for job {}, stopping further steps for device {}",
                            current_job_id,
                            device_id
                        );
                        break;
                    }
                }
                Ok::<_, ApiError>(job_ids)
            }
        });
        let results = futures_util::future::join_all(runs).await;
        let mut job_ids = Vec::new();
        for result in results {
            job_ids.extend(result?);
        }
        Ok(job_ids)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_assertion_evaluation() {
        let job = Job {
            id: "1".to_string(),
            operation_id: "test".to_string(),
            device_id: None,
            status: JobStatus::Completed,
            stdout: "Success: package installed".to_string(),
            stderr: "".to_string(),
            exit_code: Some(0),
            created_at: "".to_string(),
            started_at: None,
            finished_at: None,
            artifact_ids: vec![],
            error: None,
            source: "workflow".to_string(),
            requester: Some("test_workflow".to_string()),
        };

        let assert_zero = Assertion {
            kind: "exit_code_zero".to_string(),
            value: None,
        };
        assert!(WorkflowRunner::evaluate_assertion(&assert_zero, &job));

        let assert_stdout = Assertion {
            kind: "stdout_contains".to_string(),
            value: Some(serde_json::json!("Success")),
        };
        assert!(WorkflowRunner::evaluate_assertion(&assert_stdout, &job));

        let assert_stderr = Assertion {
            kind: "stderr_empty".to_string(),
            value: None,
        };
        assert!(WorkflowRunner::evaluate_assertion(&assert_stderr, &job));
    }
}
