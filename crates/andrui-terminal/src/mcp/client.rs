//! HTTP client for the running `andrui-terminal serve` API.

use std::time::Duration;

use reqwest::{header, Method, RequestBuilder, Response};
use serde_json::Value;
use tokio::sync::Mutex;

/// A tool failure; its text is returned to the agent with `isError: true`.
#[derive(Debug)]
pub struct ToolError(pub String);

impl<T: Into<String>> From<T> for ToolError {
    fn from(message: T) -> Self {
        Self(message.into())
    }
}

pub type ToolResult<T> = Result<T, ToolError>;

pub struct ApiClient {
    server: String,
    http: reqwest::Client,
    token: Mutex<Option<String>>,
}

/// Validates an ID used as a URL path segment (job/approval IDs come from agent input).
pub fn id_segment(value: &str) -> ToolResult<&str> {
    if !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        Ok(value)
    } else {
        Err(ToolError(format!("Invalid id '{value}'")))
    }
}

impl ApiClient {
    pub fn new(server: &str) -> Result<Self, String> {
        Self::with_timeout(server, Duration::from_secs(90))
    }

    pub fn with_timeout(server: &str, timeout: Duration) -> Result<Self, String> {
        let url = reqwest::Url::parse(server).map_err(|e| e.to_string())?;
        let local = url.host_str().is_some_and(|host| {
            host == "localhost"
                || host == "[::1]"
                || host == "::1"
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        });
        if url.scheme() != "http"
            || !local
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(
                "The AndruiTerminal server must be an HTTP loopback URL without credentials".into(),
            );
        }
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(timeout)
            .build()
            .map_err(|e| e.to_string())?;
        Ok(Self {
            server: server.trim_end_matches('/').to_string(),
            http,
            token: Mutex::new(None),
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.server, path)
    }

    fn unreachable(&self, error: reqwest::Error) -> ToolError {
        ToolError(format!(
            "AndruiTerminal server not reachable at {} ({error}). Start it with \
             `systemctl --user start andrui-terminal` or pass --server.",
            self.server
        ))
    }

    async fn error_from(response: Response) -> ToolError {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        ToolError(format!("HTTP {status}: {body}"))
    }

    async fn session_token(&self, refresh: bool) -> ToolResult<String> {
        let mut token = self.token.lock().await;
        if let (Some(value), false) = (token.as_ref(), refresh) {
            return Ok(value.clone());
        }
        let response = self
            .http
            .get(self.url("/session"))
            .send()
            .await
            .map_err(|e| self.unreachable(e))?;
        if !response.status().is_success() {
            return Err(Self::error_from(response).await);
        }
        let body: Value = response.json().await.map_err(|e| e.to_string())?;
        let value = body["csrfToken"]
            .as_str()
            .ok_or("Session response has no csrfToken")?
            .to_string();
        *token = Some(value.clone());
        Ok(value)
    }

    /// Sends a request with the session cookie and CSRF token; refreshes the session once
    /// when the server rejects it (e.g. after a restart).
    async fn send(&self, build: impl Fn() -> RequestBuilder) -> ToolResult<Response> {
        for attempt in 0..2 {
            let token = self.session_token(attempt > 0).await?;
            let response = build()
                .header("X-CSRF-Token", &token)
                .header(header::COOKIE, format!("andrui_session={token}"))
                .send()
                .await
                .map_err(|e| self.unreachable(e))?;
            if response.status() == reqwest::StatusCode::FORBIDDEN && attempt == 0 {
                continue;
            }
            if !response.status().is_success() {
                return Err(Self::error_from(response).await);
            }
            return Ok(response);
        }
        unreachable!("loop returns on the second attempt")
    }

    fn request(&self, method: Method, path: &str, query: &[(&str, String)]) -> RequestBuilder {
        self.http.request(method, self.url(path)).query(query)
    }

    pub async fn ensure_device_allowed(&self, device_id: &str) -> ToolResult<()> {
        let policy = self.get_json("/ai/policy", &[]).await?;
        let allowed = policy["deviceIds"]
            .as_array()
            .ok_or("Invalid agent policy response")?;
        if !allowed.is_empty() && !allowed.iter().any(|id| id.as_str() == Some(device_id)) {
            return Err(ToolError(
                "Device is outside the agent's permitted devices".into(),
            ));
        }
        Ok(())
    }

    pub async fn get_json(&self, path: &str, query: &[(&str, String)]) -> ToolResult<Value> {
        let response = self.send(|| self.request(Method::GET, path, query)).await?;
        response.json().await.map_err(|e| e.to_string().into())
    }

    pub async fn get_bytes(&self, path: &str, query: &[(&str, String)]) -> ToolResult<Vec<u8>> {
        let response = self.send(|| self.request(Method::GET, path, query)).await?;
        Ok(response.bytes().await.map_err(|e| e.to_string())?.to_vec())
    }

    pub async fn post_json(&self, path: &str, body: &Value) -> ToolResult<Value> {
        let response = self
            .send(|| self.request(Method::POST, path, &[]).json(body))
            .await?;
        response.json().await.map_err(|e| e.to_string().into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_id_segments() {
        assert!(id_segment("3f2b8c1e-0000-4000-8000-000000000000").is_ok());
        for bad in ["", "..", "a/b", "a?b", "%2e%2e", &"a".repeat(65)] {
            assert!(id_segment(bad).is_err(), "{bad}");
        }
    }
}
