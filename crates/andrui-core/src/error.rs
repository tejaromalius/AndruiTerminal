use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorDetail {
    pub code: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<serde_json::Value>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ErrorEnvelope {
    pub error: ErrorDetail,
}

#[derive(Debug, thiserror::Error)]
pub enum ApiError {
    #[error("Bad Request: {message}")]
    BadRequest {
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
    #[error("Unauthorized: {message}")]
    Unauthorized { code: String, message: String },
    #[error("Forbidden: {message}")]
    Forbidden { code: String, message: String },
    #[error("Not Found: {message}")]
    NotFound { code: String, message: String },
    #[error("Conflict: {message}")]
    Conflict { code: String, message: String },
    #[error("Internal error: {message}")]
    Internal {
        code: String,
        message: String,
        details: Option<serde_json::Value>,
    },
}

impl ApiError {
    pub fn bad_request(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::BadRequest {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    pub fn bad_request_with_details(
        code: impl Into<String>,
        message: impl Into<String>,
        details: serde_json::Value,
    ) -> Self {
        Self::BadRequest {
            code: code.into(),
            message: message.into(),
            details: Some(details),
        }
    }

    pub fn unauthorized(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Unauthorized {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn forbidden(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Forbidden {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn not_found(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::NotFound {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn conflict(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Conflict {
            code: code.into(),
            message: message.into(),
        }
    }

    pub fn internal(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self::Internal {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let (status, code, message, details) = match self {
            Self::BadRequest {
                code,
                message,
                details,
            } => (StatusCode::BAD_REQUEST, code, message, details),
            Self::Unauthorized { code, message } => (StatusCode::UNAUTHORIZED, code, message, None),
            Self::Forbidden { code, message } => (StatusCode::FORBIDDEN, code, message, None),
            Self::NotFound { code, message } => (StatusCode::NOT_FOUND, code, message, None),
            Self::Conflict { code, message } => (StatusCode::CONFLICT, code, message, None),
            Self::Internal {
                code,
                message,
                details,
            } => (StatusCode::INTERNAL_SERVER_ERROR, code, message, details),
        };

        let body = ErrorEnvelope {
            error: ErrorDetail {
                code,
                message,
                details,
            },
        };

        (status, Json(body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiError>;
