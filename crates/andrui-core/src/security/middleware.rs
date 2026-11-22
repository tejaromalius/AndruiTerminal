use crate::security::session::SessionStore;
use axum::{
    extract::{ConnectInfo, Request},
    http::{header, Method, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use std::net::SocketAddr;

pub fn is_trusted_host(value: &str) -> bool {
    value
        .parse::<http::uri::Authority>()
        .ok()
        .map(|a| matches!(a.host(), "localhost" | "127.0.0.1" | "[::1]" | "::1"))
        .unwrap_or(false)
}
pub fn is_trusted_origin(value: &str) -> bool {
    value
        .parse::<http::Uri>()
        .ok()
        .map(|u| {
            matches!(u.scheme_str(), Some("http" | "https"))
                && u.authority()
                    .map(|a| is_trusted_host(a.as_str()))
                    .unwrap_or(false)
                && u.path() == "/"
                && u.query().is_none()
        })
        .unwrap_or(false)
}
fn reject(code: &str, message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Json(serde_json::json!({"error":{"code":code,"message":message}})),
    )
        .into_response()
}
pub async fn security_middleware(store: SessionStore, request: Request, next: Next) -> Response {
    if let Some(ConnectInfo(peer_addr)) = request.extensions().get::<ConnectInfo<SocketAddr>>() {
        if !peer_addr.ip().is_loopback() {
            return reject(
                "REMOTE_ACCESS_FORBIDDEN",
                "Only local loopback connections are permitted",
            );
        }
    }

    let h = request.headers();
    let host = h
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if !is_trusted_host(host) {
        return reject("UNTRUSTED_HOST", "A loopback Host header is required");
    }
    let origin = h.get(header::ORIGIN).and_then(|v| v.to_str().ok());
    if let Some(origin) = origin {
        let same = origin
            .parse::<http::Uri>()
            .ok()
            .and_then(|u| u.authority().cloned())
            .map(|a| a.as_str().eq_ignore_ascii_case(host))
            .unwrap_or(false);
        if !is_trusted_origin(origin) || !same {
            return reject(
                "UNTRUSTED_ORIGIN",
                "Origin must match this local application",
            );
        }
    }
    let mutating = matches!(
        *request.method(),
        Method::POST | Method::PUT | Method::DELETE | Method::PATCH
    );
    let ws = h
        .get(header::UPGRADE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.eq_ignore_ascii_case("websocket"))
        .unwrap_or(false);
    let cookie = h
        .get(header::COOKIE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| {
            v.split(';')
                .find_map(|part| part.trim().strip_prefix("andrui_session="))
        })
        .unwrap_or("");
    if ws && (origin.is_none() || !store.validate_token(cookie)) {
        return reject(
            "SESSION_REQUIRED",
            "WebSockets require a local session and matching Origin",
        );
    }
    if mutating {
        let token = h
            .get("X-CSRF-Token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        if token != cookie || !store.validate_token(token) {
            return reject(
                "CSRF_ERROR",
                "Matching session cookie and CSRF token are required",
            );
        }
    }
    next.run(request).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_lookalike_origins() {
        assert!(is_trusted_origin("http://localhost:8080"));
        assert!(is_trusted_origin("http://[::1]:8080"));
        for v in [
            "http://localhost.evil",
            "http://127.0.0.1.evil",
            "http://localhost@evil",
            "http://localhost/path",
            "null",
            "http://0.0.0.0",
        ] {
            assert!(!is_trusted_origin(v), "{v}");
        }
    }

    #[tokio::test]
    async fn rejects_non_loopback_peer_ip() {
        use axum::middleware;
        use axum::routing::get;
        use axum::Router;
        use tower::ServiceExt;

        let store = SessionStore::new();
        let s = store.clone();
        let app = Router::new()
            .route("/test", get(|| async { "ok" }))
            .layer(middleware::from_fn(move |req, next| {
                security_middleware(s.clone(), req, next)
            }));

        // Remote peer 192.168.1.50 with a spoofed loopback Host header must be rejected
        let mut req = http::Request::builder()
            .uri("/test")
            .header(header::HOST, "127.0.0.1:8080")
            .body(axum::body::Body::empty())
            .unwrap();
        req.extensions_mut().insert(ConnectInfo(
            "192.168.1.50:54321".parse::<SocketAddr>().unwrap(),
        ));

        let resp = app.clone().oneshot(req).await.unwrap();
        assert_eq!(resp.status(), StatusCode::FORBIDDEN);

        let body_bytes = axum::body::to_bytes(resp.into_body(), 1024).await.unwrap();
        let json: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap();
        assert_eq!(json["error"]["code"], "REMOTE_ACCESS_FORBIDDEN");

        // Loopback peer 127.0.0.1 with valid Host header passes
        let mut req_local = http::Request::builder()
            .uri("/test")
            .header(header::HOST, "127.0.0.1:8080")
            .body(axum::body::Body::empty())
            .unwrap();
        req_local.extensions_mut().insert(ConnectInfo(
            "127.0.0.1:54321".parse::<SocketAddr>().unwrap(),
        ));

        let resp_local = app.oneshot(req_local).await.unwrap();
        assert_eq!(resp_local.status(), StatusCode::OK);
    }
}
