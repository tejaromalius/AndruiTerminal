use crate::{
    error::{ApiError, ApiResult},
    models::Operation,
};
use serde_json::{json, Map, Value};

pub fn catalog() -> Vec<Operation> {
    ["click", "longClick", "setText", "clearText", "scroll", "swipe", "pressKey", "wait", "assert"]
        .into_iter().map(|action| serde_json::from_value(json!({
            "id": format!("automation.{action}"), "label": format!("UI {action}"),
            "category": "Automation", "description": "Semantic action through the active automation helper. Selector is JSON. Requires a running helper session.",
            "fields": [
                {"name":"selector","label":"Selector (JSON)","type":"text","required":action != "pressKey" && action != "swipe","default":"{\"text\":\"Settings\"}"},
                {"name":"text","label":"Text (setText)","type":"string"},
                {"name":"direction","label":"Scroll direction","type":"select","default":"forward","options":[{"label":"Forward","value":"forward"},{"label":"Backward","value":"backward"}]},
                {"name":"condition","label":"Wait/assert condition","type":"select","default":"exists","options":[{"label":"Exists","value":"exists"},{"label":"Absent","value":"absent"}]},
                {"name":"key","label":"Key (pressKey)","type":"string"},
                {"name":"timeoutMs","label":"Timeout (ms)","type":"number","default":10000}
            ],
            "requiresDevice":true,"destructive":false,"streaming":false,"available":true,"coverageIds":[]
        })).expect("static semantic operation")).collect()
}

pub fn request(
    operation_id: &str,
    device_id: Option<&str>,
    params: &Map<String, Value>,
) -> ApiResult<andrui_automation::actions::ExecuteActionRequest> {
    let action = operation_id
        .strip_prefix("automation.")
        .filter(|a| catalog().iter().any(|o| o.id == format!("automation.{a}")))
        .ok_or_else(|| ApiError::bad_request("UNKNOWN_OPERATION", operation_id))?;
    let device = device_id.filter(|s| !s.trim().is_empty()).ok_or_else(|| {
        ApiError::bad_request("DEVICE_REQUIRED", "An explicit deviceId is required")
    })?;
    let mut body = params.clone();
    if let Some(Value::String(selector)) = body.get("selector") {
        let value = serde_json::from_str(selector).map_err(|_| {
            ApiError::bad_request("INVALID_SELECTOR", "Selector must be a JSON object")
        })?;
        body.insert("selector".into(), value);
    }
    body.insert("deviceId".into(), json!(device));
    body.insert("action".into(), json!(action));
    let request: andrui_automation::actions::ExecuteActionRequest =
        serde_json::from_value(Value::Object(body))
            .map_err(|e| ApiError::bad_request("INVALID_ACTION", e.to_string()))?;
    if !matches!(action, "pressKey" | "swipe") {
        request
            .selector
            .as_ref()
            .ok_or_else(|| ApiError::bad_request("INVALID_SELECTOR", "A selector is required"))?
            .validate()
            .map_err(|e| ApiError::bad_request("INVALID_SELECTOR", e.to_string()))?;
    }
    if action == "setText" && request.text.is_none() {
        return Err(ApiError::bad_request(
            "MISSING_TEXT",
            "setText requires text",
        ));
    }
    if action == "pressKey" && request.key.is_none() && request.key_code.is_none() {
        return Err(ApiError::bad_request(
            "MISSING_KEY",
            "pressKey requires key or keyCode",
        ));
    }
    Ok(request)
}
