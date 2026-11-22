use axum::{extract::State, Json};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::error::ApiError;
use crate::state::{AppState, RecordedStep};

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActionSelector {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub class_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub xpath: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_contains: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_starts_with: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text_matches: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc_contains: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub desc_matches: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id_matches: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checked: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub focused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub index: Option<usize>,
}

impl ActionSelector {
    pub fn validate(&self) -> Result<(), ApiError> {
        let mut count = 0;
        let str_fields = [
            ("resourceId", &self.resource_id),
            ("text", &self.text),
            ("description", &self.description),
            ("className", &self.class_name),
            ("xpath", &self.xpath),
            ("textContains", &self.text_contains),
            ("textStartsWith", &self.text_starts_with),
            ("textMatches", &self.text_matches),
            ("descContains", &self.desc_contains),
            ("descMatches", &self.desc_matches),
            ("resourceIdMatches", &self.resource_id_matches),
        ];

        for (name, val) in str_fields {
            if let Some(s) = val {
                if s.is_empty() {
                    return Err(ApiError::bad_request(
                        "invalid_selector",
                        format!("{} must not be empty", name),
                    ));
                }
                count += 1;
            }
        }

        if self.checked.is_some() {
            count += 1;
        }
        if self.enabled.is_some() {
            count += 1;
        }
        if self.selected.is_some() {
            count += 1;
        }
        if self.focused.is_some() {
            count += 1;
        }

        if count == 0 {
            return Err(ApiError::bad_request(
                "invalid_selector",
                "A non-empty selector with at least one criteria (resourceId, text, description, className, xpath, or filter) is required",
            ));
        }

        Ok(())
    }
}

#[derive(Deserialize, Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExecuteActionRequest {
    pub device_id: String,
    pub action: String,
    #[serde(default)]
    pub selector: Option<ActionSelector>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub direction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub condition: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub key_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_x: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start_y: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_x: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end_y: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionTarget {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resource_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bounds: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ActionResult {
    pub success: bool,
    pub action: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target: Option<ActionTarget>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub matched: Option<bool>,
}

pub async fn execute_action(
    State(state): State<AppState>,
    Json(payload): Json<ExecuteActionRequest>,
) -> Result<Json<ActionResult>, ApiError> {
    // 1. Validate device ID
    if payload.device_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "missing_device_id",
            "deviceId must not be empty",
        ));
    }

    // 2. Validate action name
    let valid_actions = [
        "click",
        "longClick",
        "setText",
        "clearText",
        "scroll",
        "swipe",
        "pressKey",
        "wait",
        "assert",
    ];
    if !valid_actions.contains(&payload.action.as_str()) {
        return Err(ApiError::bad_request(
            "unsupported_action",
            format!(
                "Action '{}' is not supported. Supported actions: click, longClick, setText, clearText, scroll, swipe, pressKey, wait, assert",
                payload.action
            ),
        ));
    }

    // 3. Validate action-specific parameters and selector presence
    match payload.action.as_str() {
        "pressKey" => {
            if payload.key.is_none() && payload.key_code.is_none() {
                return Err(ApiError::bad_request(
                    "missing_key",
                    "pressKey requires 'key' or 'keyCode' parameter",
                ));
            }
        }
        "swipe" => {
            let has_coords = payload.start_x.is_some()
                && payload.start_y.is_some()
                && payload.end_x.is_some()
                && payload.end_y.is_some();
            if !has_coords {
                let sel = payload.selector.as_ref().ok_or_else(|| {
                    ApiError::bad_request(
                        "invalid_swipe",
                        "swipe requires either explicit coordinates (startX, startY, endX, endY) or a target selector",
                    )
                })?;
                sel.validate()?;
            }
        }
        "setText" => {
            if payload.text.is_none() {
                return Err(ApiError::bad_request(
                    "missing_text",
                    "setText action requires a non-null text parameter",
                ));
            }
            let sel = payload.selector.as_ref().ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_selector",
                    "A non-empty selector is required for setText",
                )
            })?;
            sel.validate()?;
        }
        _ => {
            let sel = payload.selector.as_ref().ok_or_else(|| {
                ApiError::bad_request(
                    "invalid_selector",
                    format!("A non-empty selector is required for {}", payload.action),
                )
            })?;
            sel.validate()?;
        }
    }

    // 4. Check session
    let session = state.get_device_session(&payload.device_id).await?;

    // Lock session action to serialize replay and live semantic mutations
    let _action_guard = session.action_lock.lock().await;

    // 5. Build request to helper
    let timeout_ms = payload.timeout_ms.unwrap_or(10000).clamp(0, 30000);
    let mut helper_body = serde_json::json!({
        "action": payload.action,
        "timeoutMs": timeout_ms
    });

    if let Some(s) = &payload.selector {
        let selector_val = serde_json::to_value(s).map_err(|e| {
            ApiError::internal(
                "selector_serialization_error",
                format!("Failed to serialize selector: {}", e),
            )
        })?;
        helper_body["selector"] = selector_val;
    }

    if let Some(t) = &payload.text {
        helper_body["text"] = serde_json::Value::String(t.clone());
    }
    if let Some(d) = &payload.direction {
        helper_body["direction"] = serde_json::Value::String(d.clone());
    }
    if let Some(c) = &payload.condition {
        helper_body["condition"] = serde_json::Value::String(c.clone());
    }
    if let Some(k) = &payload.key {
        helper_body["key"] = serde_json::Value::String(k.clone());
    }
    if let Some(kc) = payload.key_code {
        helper_body["keyCode"] = serde_json::json!(kc);
    }
    if let Some(sx) = payload.start_x {
        helper_body["startX"] = serde_json::json!(sx);
    }
    if let Some(sy) = payload.start_y {
        helper_body["startY"] = serde_json::json!(sy);
    }
    if let Some(ex) = payload.end_x {
        helper_body["endX"] = serde_json::json!(ex);
    }
    if let Some(ey) = payload.end_y {
        helper_body["endY"] = serde_json::json!(ey);
    }
    if let Some(dur) = payload.duration_ms {
        helper_body["durationMs"] = serde_json::json!(dur);
    }

    let url = session.helper_url("/actions");
    let start_instant = std::time::Instant::now();

    let resp = state
        .http_client
        .post(&url)
        .header("X-Andrui-Token", &session.token)
        .json(&helper_body)
        .timeout(Duration::from_millis(timeout_ms + 5000))
        .send()
        .await
        .map_err(|e| {
            ApiError::internal(
                "helper_communication_error",
                format!("Failed to communicate with helper: {}", e),
            )
        })?;

    let status = resp.status();
    let duration_ms = start_instant.elapsed().as_millis() as u64;

    if status.as_u16() == 408 {
        let err_json: serde_json::Value = resp.json().await.unwrap_or_default();
        let msg = err_json["message"]
            .as_str()
            .or_else(|| err_json["error"].as_str())
            .unwrap_or("Action timed out waiting for element");
        return Err(ApiError::timeout("element_timeout", msg));
    }

    if !status.is_success() {
        let err_json: serde_json::Value = resp.json().await.unwrap_or_default();
        let msg = err_json["message"]
            .as_str()
            .or_else(|| err_json["error"].as_str())
            .unwrap_or("Helper rejected action execution");
        return match status.as_u16() {
            403 => Err(ApiError::forbidden("forbidden", msg)),
            404 => Err(ApiError::not_found("not_found", msg)),
            _ => Err(ApiError::bad_request("operation_failed", msg)),
        };
    }

    let action_res: ActionResult = resp.json().await.map_err(|e| {
        ApiError::internal(
            "helper_invalid_response",
            format!("Failed to parse helper response: {}", e),
        )
    })?;

    // Only record if action was successful! Bounded to 1000 steps maximum.
    const MAX_RECORDED_STEPS: usize = 1000;
    if action_res.success {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);

        let selector_val = serde_json::to_value(&payload.selector).unwrap_or_default();
        let step = RecordedStep {
            action: payload.action.clone(),
            selector: selector_val,
            text: payload.text.clone(),
            direction: payload.direction.clone(),
            condition: payload.condition.clone(),
            timestamp: now,
            duration_ms,
        };

        let mut recordings = state.recordings.write().await;
        for rec in recordings.values_mut() {
            if rec.device_id == payload.device_id && rec.steps.len() < MAX_RECORDED_STEPS {
                rec.steps.push(step.clone());
            }
        }
    }

    Ok(Json(action_res))
}
