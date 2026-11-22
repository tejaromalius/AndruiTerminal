use super::runner::WorkflowRunner;
use crate::{
    error::{ApiError, ApiResult},
    models::{Job, JobStatus, Workflow},
    server::state::AppState,
};
use axum::{
    extract::{Path, State},
    http::header,
    routing::{get, post},
    Json, Router,
};
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub device_id: String,
    pub index: usize,
    pub operation_id: String,
    pub status: String,
    pub assertion_passed: Option<bool>,
    pub job: Option<Job>,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunReport {
    pub id: String,
    pub workflow: Workflow,
    pub device_ids: Vec<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
    pub status: String,
    pub steps: Vec<StepResult>,
    pub error: Option<String>,
}

pub fn routes() -> Router<AppState> {
    Router::new()
        .route("/workflow-runs", get(list))
        .route("/workflow-runs/{id}", get(report))
        .route("/workflow-runs/{id}/junit", get(junit))
        .route("/workflow-runs/{id}/cancel", post(cancel))
}
async fn list(State(s): State<AppState>) -> ApiResult<Json<Vec<RunReport>>> {
    let ids: Vec<String> = s.db.read_value("experience.workflow-runs")?;
    let mut reports = Vec::new();
    for id in ids {
        let report: Option<RunReport> = s.db.read_value(&format!("experience.run.{id}"))?;
        if let Some(r) = report {
            reports.push(r);
        }
    }
    Ok(Json(reports))
}
fn load(s: &AppState, id: &str) -> ApiResult<RunReport> {
    if uuid::Uuid::parse_str(id).is_err() {
        return Err(ApiError::bad_request(
            "INVALID_ID",
            "Invalid workflow run ID",
        ));
    }
    s.db.read_value::<Option<RunReport>>(&format!("experience.run.{id}"))?
        .ok_or_else(|| ApiError::not_found("RUN_NOT_FOUND", "Workflow run not found"))
}
async fn report(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<RunReport>> {
    Ok(Json(load(&s, &id)?))
}
async fn cancel(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<serde_json::Value>> {
    load(&s, &id)?;
    s.workflow_runner.cancel(&id).await?;
    Ok(Json(json!({"cancellationRequested":true})))
}
fn xml(text: &str) -> String {
    text.chars()
        .filter(|c| *c == '\n' || *c == '\r' || *c == '\t' || *c >= ' ')
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}
pub fn to_junit(report: &RunReport) -> String {
    let failed = report.steps.iter().filter(|s| s.status == "failed").count();
    let skipped = report
        .steps
        .iter()
        .filter(|s| s.status != "completed" && s.status != "failed")
        .count();
    let errors = usize::from(report.error.is_some());
    let mut text = format!("<?xml version=\"1.0\" encoding=\"UTF-8\"?><testsuite name=\"{}\" tests=\"{}\" failures=\"{}\" errors=\"{}\" skipped=\"{}\">",xml(&report.workflow.name),report.steps.len()+errors,failed,errors,skipped);
    if let Some(error) = &report.error {
        text.push_str(&format!(
            "<testcase name=\"Workflow execution\"><error message=\"{}\"/></testcase>",
            xml(error)
        ));
    }
    for step in &report.steps {
        text.push_str(&format!(
            "<testcase classname=\"{}\" name=\"{}: {}\">",
            xml(&step.device_id),
            step.index + 1,
            xml(&step.operation_id)
        ));
        if step.status == "failed" {
            text.push_str(&format!(
                "<failure message=\"{}\"/>",
                xml(step
                    .job
                    .as_ref()
                    .and_then(|j| j.error.as_deref())
                    .unwrap_or("Step or assertion failed"))
            ));
        } else if step.status != "completed" {
            text.push_str("<skipped/>");
        }
        if let Some(job) = &step.job {
            text.push_str(&format!(
                "<system-out>{}</system-out><system-err>{}</system-err>",
                xml(&job.stdout),
                xml(&job.stderr)
            ));
        }
        text.push_str("</testcase>");
    }
    text.push_str("</testsuite>");
    text
}
async fn junit(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<([(header::HeaderName, &'static str); 2], String)> {
    Ok((
        [
            (header::CONTENT_TYPE, "application/xml; charset=utf-8"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"andrui-results.xml\"",
            ),
        ],
        to_junit(&load(&s, &id)?),
    ))
}

pub fn results(workflow: &Workflow, device_ids: &[String], jobs: &[Job]) -> Vec<StepResult> {
    let mut steps = Vec::new();
    for device in device_ids {
        let jobs: Vec<_> = jobs
            .iter()
            .filter(|j| j.device_id.as_ref() == Some(device))
            .collect();
        let mut stopped = false;
        for (index, step) in workflow.steps.iter().enumerate() {
            let mut job = jobs.get(index).filter(|_| !stopped).map(|j| (*j).clone());
            let assertion = job.as_ref().and_then(|j| {
                step.assertion
                    .as_ref()
                    .map(|a| WorkflowRunner::evaluate_assertion(a, j))
            });
            let status = match job.as_ref() {
                Some(j) if j.status == JobStatus::Completed && assertion != Some(false) => {
                    "completed"
                }
                Some(j) if j.status == JobStatus::Cancelled => "cancelled",
                Some(_) => "failed",
                None => "skipped",
            };
            if status != "completed" {
                stopped = true;
            }
            if let Some(job) = &mut job {
                job.stdout = job.stdout.chars().take(32000).collect();
                job.stderr = job.stderr.chars().take(8000).collect();
            }
            steps.push(StepResult {
                device_id: device.clone(),
                index,
                operation_id: step.operation_id.clone(),
                status: status.into(),
                assertion_passed: assertion,
                job,
            });
        }
    }
    steps
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn junit_escapes_device_and_workflow_names() {
        let report = RunReport {
            id: "id".into(),
            workflow: Workflow {
                id: "w".into(),
                name: "A&B <test>".into(),
                steps: vec![],
            },
            device_ids: vec![],
            created_at: String::new(),
            finished_at: None,
            status: "failed".into(),
            steps: vec![StepResult {
                device_id: "d\"".into(),
                index: 0,
                operation_id: "a<b".into(),
                status: "failed".into(),
                assertion_passed: Some(false),
                job: None,
            }],
            error: None,
        };
        let value = to_junit(&report);
        assert!(value.contains("A&amp;B &lt;test&gt;"));
        assert!(value.contains("d&quot;"));
        assert!(value.contains("failures=\"1\""));
    }
}
