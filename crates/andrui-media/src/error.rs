use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorDetails {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ApiErrorResponse {
    pub error: ErrorDetails,
}

#[derive(Debug)]
pub enum MediaError {
    BadRequest(String),
    NotFound(String),
    Conflict(String),
    NotImplemented(String),
    DeviceOffline(String),
    ScrcpyServerNotFound(String),
    CommandFailed { code: Option<i32>, stderr: String },
    Timeout(String),
    InvalidData(String),
    Internal(String),
}

impl std::fmt::Display for MediaError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MediaError::BadRequest(msg) => write!(f, "Bad request: {}", msg),
            MediaError::NotFound(msg) => write!(f, "Not found: {}", msg),
            MediaError::Conflict(msg) => write!(f, "Conflict: {}", msg),
            MediaError::NotImplemented(msg) => write!(f, "Not implemented: {}", msg),
            MediaError::DeviceOffline(msg) => write!(f, "Device offline: {}", msg),
            MediaError::ScrcpyServerNotFound(msg) => write!(f, "Scrcpy server not found: {}", msg),
            MediaError::CommandFailed { code, stderr } => {
                write!(f, "Command failed (exit {:?}): {}", code, stderr)
            }
            MediaError::Timeout(msg) => write!(f, "Operation timed out: {}", msg),
            MediaError::InvalidData(msg) => write!(f, "Invalid data: {}", msg),
            MediaError::Internal(msg) => write!(f, "Internal error: {}", msg),
        }
    }
}

impl std::error::Error for MediaError {}

impl IntoResponse for MediaError {
    fn into_response(self) -> Response {
        let (status, code, message, details) = match self {
            MediaError::BadRequest(msg) => (StatusCode::BAD_REQUEST, "BAD_REQUEST", msg, None),
            MediaError::NotFound(msg) => (StatusCode::NOT_FOUND, "NOT_FOUND", msg, None),
            MediaError::Conflict(msg) => (StatusCode::CONFLICT, "CONFLICT", msg, None),
            MediaError::NotImplemented(msg) => {
                (StatusCode::NOT_IMPLEMENTED, "NOT_IMPLEMENTED", msg, None)
            }
            MediaError::DeviceOffline(msg) => {
                (StatusCode::SERVICE_UNAVAILABLE, "DEVICE_OFFLINE", msg, None)
            }
            MediaError::ScrcpyServerNotFound(msg) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "SCRCPY_SERVER_NOT_FOUND",
                msg,
                None,
            ),
            MediaError::CommandFailed { code, stderr } => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "COMMAND_FAILED",
                format!("ADB command failed: {}", stderr),
                Some(serde_json::json!({ "exitCode": code, "stderr": stderr })),
            ),
            MediaError::Timeout(msg) => (StatusCode::GATEWAY_TIMEOUT, "TIMEOUT", msg, None),
            MediaError::InvalidData(msg) => (StatusCode::BAD_REQUEST, "INVALID_DATA", msg, None),
            MediaError::Internal(msg) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL_ERROR",
                msg,
                None,
            ),
        };

        let body = Json(ApiErrorResponse {
            error: ErrorDetails {
                code: code.to_string(),
                message,
                details,
            },
        });

        (status, body).into_response()
    }
}
