use axum::{
    body::Body,
    extract::{Query, State},
    http::{header, Response, StatusCode},
    response::IntoResponse,
    Json,
};
use base64::prelude::*;
use serde::Deserialize;

use crate::error::ApiError;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct ScreenshotQuery {
    #[serde(rename = "deviceId")]
    pub device_id_camel: Option<String>,
    pub device_id: Option<String>,
    /// Draw numbered Set-of-Marks boxes on compact-hierarchy nodes.
    pub marks: Option<bool>,
    /// `png` (default) or, with marks, `json` → `{pngBase64, nodes, capturedAt}`.
    pub format: Option<String>,
}

#[derive(Deserialize)]
struct HelperScreenshotResponse {
    #[serde(rename = "contentType")]
    _content_type: Option<String>,
    base64: String,
    /// FLAG_SECURE report; absent from helpers older than protocol feature `secure-window-detection`.
    secure: Option<serde_json::Value>,
}

/// `X-Andrui-Secure-Window` / `X-Andrui-Secure-Detection` header values for a helper secure report.
fn secure_headers(secure: Option<&serde_json::Value>) -> (&'static str, &'static str) {
    match secure {
        None => ("unknown", "unsupported"),
        Some(s) if s["detection"] != "dumpsys" => ("unknown", "unavailable"),
        Some(s) if s["visibleSecureWindow"] == true => ("true", "dumpsys"),
        Some(_) => ("false", "dumpsys"),
    }
}

pub async fn get_screenshot(
    State(state): State<AppState>,
    Query(query): Query<ScreenshotQuery>,
) -> Result<Response<Body>, ApiError> {
    let device_id = query
        .device_id_camel
        .as_deref()
        .or(query.device_id.as_deref())
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| {
            ApiError::bad_request("missing_device_id", "deviceId query parameter is required")
        })?;

    let as_json = match query.format.as_deref() {
        None | Some("png") => false,
        Some("json") if query.marks == Some(true) => true,
        Some(other) => {
            return Err(ApiError::bad_request(
                "invalid_format",
                format!("Unsupported format '{other}'; use png, or json with marks=true"),
            ))
        }
    };

    let (mut image_bytes, secure) = capture_png(&state, device_id).await?;
    let (secure_window, secure_detection) = secure_headers(secure.as_ref());

    let mut marks_count = None;
    if query.marks == Some(true) {
        // Captured right after the screenshot; the two are not atomic.
        let hierarchy = crate::hierarchy::fetch_hierarchy(&state, device_id, false).await?;
        let compact = crate::hierarchy::compact_response(hierarchy)?;
        image_bytes = crate::marks::draw_marks(&image_bytes, &compact.nodes)
            .map_err(|e| ApiError::internal("marks_render_failed", e))?;
        if as_json {
            return Ok(Json(serde_json::json!({
                "pngBase64": BASE64_STANDARD.encode(&image_bytes),
                "nodes": compact.nodes,
                "capturedAt": compact.captured_at,
                "secureWindow": secure_window,
            }))
            .into_response());
        }
        marks_count = Some(compact.nodes.len());
    }

    let mut response = Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "image/png")
        .header("X-Andrui-Secure-Window", secure_window)
        .header("X-Andrui-Secure-Detection", secure_detection)
        .header(header::CONTENT_LENGTH, image_bytes.len().to_string());
    if let Some(count) = marks_count {
        response = response.header("X-Andrui-Marks", count.to_string());
    }
    response.body(Body::from(image_bytes)).map_err(|e| {
        ApiError::internal(
            "response_build_error",
            format!("Failed to build response: {}", e),
        )
    })
}

/// PNG bytes from the helper session plus its FLAG_SECURE report.
async fn capture_png(
    state: &AppState,
    device_id: &str,
) -> Result<(Vec<u8>, Option<serde_json::Value>), ApiError> {
    let session = state.get_device_session(device_id).await?;

    let url = session.helper_url("/screenshot");
    let resp = state
        .http_client
        .get(&url)
        .header("X-Andrui-Token", &session.token)
        .send()
        .await
        .map_err(|e| {
            ApiError::internal(
                "helper_request_failed",
                format!("Failed to request screenshot from helper: {}", e),
            )
        })?;

    if !resp.status().is_success() {
        let msg = resp.text().await.unwrap_or_default();
        let parsed: serde_json::Value = serde_json::from_str(&msg).unwrap_or_default();
        let detail = parsed["message"].as_str().unwrap_or(&msg);
        return Err(match parsed["error"].as_str() {
            Some("secure_window_blocked") => ApiError::conflict("secure_window_blocked", detail),
            Some("screenshot_unavailable") => {
                ApiError::service_unavailable("screenshot_unavailable", detail)
            }
            _ => ApiError::bad_request(
                "screenshot_failed",
                format!("Helper failed to capture screenshot: {}", msg),
            ),
        });
    }

    let helper_data: HelperScreenshotResponse = resp.json().await.map_err(|e| {
        ApiError::internal(
            "helper_response_invalid",
            format!("Failed to parse helper screenshot JSON: {}", e),
        )
    })?;

    let image_bytes = BASE64_STANDARD
        .decode(helper_data.base64.trim())
        .map_err(|e| {
            ApiError::internal(
                "screenshot_decode_failed",
                format!("Failed to decode base64 screenshot bytes: {}", e),
            )
        })?;

    Ok((image_bytes, helper_data.secure))
}
