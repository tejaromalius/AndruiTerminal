//! Helper APK installation status, confirmed install, and read-only functional checks.

use std::path::Path;
use std::time::Duration;

use axum::{
    extract::{Query, State},
    Json,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::adb::AdbExecutor;
use crate::error::ApiError;
use crate::session::stop_session_internal;
use crate::state::{AppState, AutomationSession};

pub const HELPER_PACKAGE: &str = "io.andrui.terminal.helper";

/// Helper capabilities the current host integration relies on.
const EXPECTED_CAPABILITIES: [&str; 3] =
    ["window-metadata", "secure-window-detection", "keep-alive"];

/// One step per line; the dashboard renders each line as a list item.
const POWER_GUIDANCE: &str =
    "Settings → Apps → AndruiTerminal Automation → Battery → Unrestricted\n\
Honor/Huawei: Battery → App launch → AndruiTerminal Automation → Manage manually (allow all)\n\
Xiaomi: Autostart on, and Battery saver → No restrictions\n\
Samsung: Battery → Never sleeping apps";

#[derive(Deserialize)]
pub struct DeviceQuery {
    #[serde(rename = "deviceId")]
    pub device_id: Option<String>,
}

impl DeviceQuery {
    fn resolved(&self) -> Result<&str, ApiError> {
        self.device_id
            .as_deref()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| {
                ApiError::bad_request("missing_device_id", "deviceId query parameter is required")
            })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostApkStatus {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperSessionInfo {
    pub id: String,
    pub helper_version: String,
    pub host_port: u16,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperStatus {
    pub device_id: String,
    pub package: &'static str,
    pub host_apk: HostApkStatus,
    pub installed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_code: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub installed_sha256: Option<String>,
    /// `None` when either hash could not be computed.
    pub up_to_date: Option<bool>,
    pub session: Option<HelperSessionInfo>,
}

#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum CheckStatus {
    Pass,
    Warn,
    Fail,
    Skip,
}

/// Overall result. `Incomplete` means nothing failed or warned, but some checks did not run.
#[derive(Serialize, Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum OverallStatus {
    Pass,
    Warn,
    Fail,
    Incomplete,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperCheck {
    pub id: &'static str,
    pub label: &'static str,
    pub status: CheckStatus,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub guidance: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperChecksResponse {
    pub device_id: String,
    pub overall: OverallStatus,
    pub checks: Vec<HelperCheck>,
    pub status: HelperStatus,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallHelperRequest {
    pub device_id: String,
    pub confirmed: Option<bool>,
}

fn check(
    id: &'static str,
    label: &'static str,
    status: CheckStatus,
    detail: impl Into<String>,
    guidance: Option<&str>,
) -> HelperCheck {
    HelperCheck {
        id,
        label,
        status,
        detail: detail.into(),
        guidance: guidance.map(str::to_string),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{:02x}", b))
        .collect()
}

async fn shell(state: &AppState, device_id: &str, command: &str) -> Result<String, ApiError> {
    AdbExecutor::run_adb(&state.config.adb_path, &["-s", device_id, "shell", command]).await
}

async fn host_apk_status(path: Option<&Path>) -> HostApkStatus {
    let Some(path) = path else {
        return HostApkStatus {
            available: false,
            path: None,
            sha256: None,
            reason: Some("Helper APK path is not configured.".into()),
        };
    };
    match tokio::fs::read(path).await {
        Ok(bytes) => HostApkStatus {
            available: true,
            path: Some(path.display().to_string()),
            sha256: Some(sha256_hex(&bytes)),
            reason: None,
        },
        Err(e) => HostApkStatus {
            available: false,
            path: Some(path.display().to_string()),
            sha256: None,
            reason: Some(format!("Helper APK cannot be read: {}", e)),
        },
    }
}

/// `pm path` output is interpolated into a device shell command, so only accept plain path characters.
fn safe_device_path(path: &str) -> bool {
    path.starts_with('/')
        && path
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "/._-~=+".contains(c))
}

fn parse_field<'a>(text: &'a str, key: &str) -> Option<&'a str> {
    text.split_whitespace().find_map(|t| t.strip_prefix(key))
}

pub async fn gather_status(state: &AppState, device_id: &str) -> Result<HelperStatus, ApiError> {
    let host_apk = host_apk_status(state.config.helper_apk.as_deref()).await;

    let packages = shell(
        state,
        device_id,
        &format!("pm list packages {}", HELPER_PACKAGE),
    )
    .await?;
    let installed = packages
        .lines()
        .any(|l| l.trim() == format!("package:{}", HELPER_PACKAGE));

    let mut status = HelperStatus {
        device_id: device_id.to_string(),
        package: HELPER_PACKAGE,
        host_apk,
        installed,
        installed_path: None,
        version_name: None,
        version_code: None,
        installed_sha256: None,
        up_to_date: None,
        session: state
            .get_device_session(device_id)
            .await
            .ok()
            .map(|s| HelperSessionInfo {
                id: s.id.clone(),
                helper_version: s.helper_version.clone(),
                host_port: s.host_port,
            }),
    };
    if !installed {
        status.up_to_date = Some(false);
        return Ok(status);
    }

    if let Ok(dump) = shell(
        state,
        device_id,
        &format!("dumpsys package {}", HELPER_PACKAGE),
    )
    .await
    {
        status.version_code = parse_field(&dump, "versionCode=").and_then(|v| v.parse().ok());
        status.version_name = parse_field(&dump, "versionName=").map(str::to_string);
    }
    if let Ok(out) = shell(state, device_id, &format!("pm path {}", HELPER_PACKAGE)).await {
        status.installed_path = out
            .lines()
            .find_map(|l| l.trim().strip_prefix("package:"))
            .filter(|p| safe_device_path(p))
            .map(str::to_string);
    }
    if let Some(path) = &status.installed_path {
        if let Ok(out) = shell(state, device_id, &format!("sha256sum {}", path)).await {
            status.installed_sha256 = out
                .split_whitespace()
                .next()
                .filter(|h| h.len() == 64)
                .map(str::to_string);
        }
    }
    if let (Some(host), Some(device)) = (&status.host_apk.sha256, &status.installed_sha256) {
        status.up_to_date = Some(host == device);
    }
    Ok(status)
}

pub async fn get_helper_status(
    State(state): State<AppState>,
    Query(query): Query<DeviceQuery>,
) -> Result<Json<HelperStatus>, ApiError> {
    let device_id = query.resolved()?;
    Ok(Json(gather_status(&state, device_id).await?))
}

pub async fn install_helper(
    State(state): State<AppState>,
    Json(payload): Json<InstallHelperRequest>,
) -> Result<Json<HelperStatus>, ApiError> {
    if payload.device_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "invalid_device_id",
            "deviceId must not be empty",
        ));
    }
    if !payload.confirmed.unwrap_or(false) {
        return Err(ApiError::bad_request(
            "confirmation_required",
            "Installing the helper APK modifies the device and requires confirmed=true",
        ));
    }
    let apk_path = state.config.helper_apk.clone().ok_or_else(|| {
        ApiError::service_unavailable(
            "helper_apk_unavailable",
            "Automation helper APK is not configured (start with --helper-apk)",
        )
    })?;
    let device_id = payload.device_id.as_str();
    {
        let lock = state.get_device_startup_lock(device_id).await;
        let _guard = lock.lock().await;
        // Reinstalling kills the running instrumentation, so end its session cleanly first.
        if let Ok(existing) = state.get_device_session(device_id).await {
            let _ = stop_session_internal(&state, &existing.id).await;
        }
        AdbExecutor::install_helper_apk(&state.config.adb_path, device_id, &apk_path).await?;
    }
    Ok(Json(gather_status(&state, device_id).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UninstallHelperRequest {
    pub device_id: String,
    pub confirmed: Option<bool>,
}

pub async fn uninstall_helper(
    State(state): State<AppState>,
    Json(payload): Json<UninstallHelperRequest>,
) -> Result<Json<HelperStatus>, ApiError> {
    if payload.device_id.trim().is_empty() {
        return Err(ApiError::bad_request(
            "invalid_device_id",
            "deviceId must not be empty",
        ));
    }
    if !payload.confirmed.unwrap_or(false) {
        return Err(ApiError::bad_request(
            "confirmation_required",
            "Uninstalling the helper APK modifies the device and requires confirmed=true",
        ));
    }
    let device_id = payload.device_id.as_str();
    {
        let lock = state.get_device_startup_lock(device_id).await;
        let _guard = lock.lock().await;
        if let Ok(existing) = state.get_device_session(device_id).await {
            let _ = stop_session_internal(&state, &existing.id).await;
        }
        AdbExecutor::uninstall_helper_apk(&state.config.adb_path, device_id).await?;
    }
    Ok(Json(gather_status(&state, device_id).await?))
}

/// Reads per-thread kernel wait channels through `run-as` (the helper is debuggable).
/// Threads parked in `__refrigerator` are frozen by the cgroup freezer.
async fn frozen_check(state: &AppState, device_id: &str) -> HelperCheck {
    const ID: &str = "not_frozen";
    const LABEL: &str = "Helper process is not frozen";
    let pid = match shell(state, device_id, &format!("pidof {}", HELPER_PACKAGE)).await {
        Ok(out) => out
            .split_whitespace()
            .next()
            .and_then(|p| p.parse::<u32>().ok()),
        Err(_) => None,
    };
    let Some(pid) = pid else {
        return check(
            ID,
            LABEL,
            CheckStatus::Fail,
            "Helper process is not running although a session is registered",
            Some("Stop and start the automation helper again."),
        );
    };
    let command = format!(
        "run-as {} sh -c 'for t in /proc/{}/task/*; do cat $t/wchan 2>/dev/null; echo; done'",
        HELPER_PACKAGE, pid
    );
    match shell(state, device_id, &command).await {
        Ok(out) => {
            let threads: Vec<&str> = out
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .collect();
            let frozen = threads
                .iter()
                .filter(|w| w.contains("refrigerator"))
                .count();
            if frozen > 0 {
                check(
                    ID,
                    LABEL,
                    CheckStatus::Fail,
                    format!(
                        "{} of {} helper threads are frozen by the system (pid {})",
                        frozen,
                        threads.len(),
                        pid
                    ),
                    Some(POWER_GUIDANCE),
                )
            } else {
                check(
                    ID,
                    LABEL,
                    CheckStatus::Pass,
                    format!("{} threads running (pid {})", threads.len(), pid),
                    None,
                )
            }
        }
        Err(e) => check(
            ID,
            LABEL,
            CheckStatus::Warn,
            format!("Could not read thread state via run-as: {}", e),
            None,
        ),
    }
}

async fn power_check(state: &AppState, device_id: &str) -> HelperCheck {
    const ID: &str = "power_save";
    const LABEL: &str = "Power saving does not restrict the helper";
    let whitelist = match shell(state, device_id, "dumpsys deviceidle whitelist").await {
        Ok(out) => out,
        Err(e) => {
            return check(
                ID,
                LABEL,
                CheckStatus::Warn,
                format!("Could not read battery optimization state: {}", e),
                Some(POWER_GUIDANCE),
            )
        }
    };
    let exempt = whitelist
        .lines()
        .any(|l| l.split(',').nth(1).map(str::trim) == Some(HELPER_PACKAGE));
    let bucket = shell(
        state,
        device_id,
        &format!("am get-standby-bucket {}", HELPER_PACKAGE),
    )
    .await
    .ok()
    .and_then(|o| o.trim().parse::<u32>().ok());
    let bucket_text = match bucket {
        Some(5) => "exempted",
        Some(10) => "active",
        Some(20) => "working set",
        Some(30) => "frequent",
        Some(40) => "rare",
        Some(45) => "restricted",
        Some(50) => "never",
        _ => "unknown",
    };
    let restricted = matches!(bucket, Some(45) | Some(50));
    let detail = format!(
        "Battery optimization: {}; standby bucket: {}.",
        if exempt { "exempt" } else { "on" },
        bucket_text
    );
    // A running helper is a foreground instrumentation process, so battery optimization alone
    // does not stop it; vendor freezing is caught by the frozen-process check instead.
    if restricted {
        check(
            ID,
            LABEL,
            CheckStatus::Warn,
            format!("{} Android restricts this app's background work.", detail),
            Some(POWER_GUIDANCE),
        )
    } else {
        check(ID, LABEL, CheckStatus::Pass, detail, None)
    }
}

async fn helper_get(
    state: &AppState,
    session: &AutomationSession,
    path: &str,
    timeout: Duration,
) -> Result<serde_json::Value, String> {
    let resp = state
        .http_client
        .get(session.helper_url(path))
        .header("X-Andrui-Token", &session.token)
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("no response within {} s", timeout.as_secs())
            } else {
                e.to_string()
            }
        })?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("invalid JSON: {}", e))?;
    if !status.is_success() {
        return Err(format!(
            "HTTP {}: {} {}",
            status.as_u16(),
            body["error"].as_str().unwrap_or(""),
            body["message"].as_str().unwrap_or("")
        ));
    }
    Ok(body)
}

async fn live_checks(state: &AppState, session: &AutomationSession, checks: &mut Vec<HelperCheck>) {
    match helper_get(state, session, "/health", Duration::from_secs(3)).await {
        Ok(health) => {
            let caps: Vec<&str> = health["capabilities"]
                .as_array()
                .map(|a| a.iter().filter_map(|v| v.as_str()).collect())
                .unwrap_or_default();
            let missing: Vec<&str> = EXPECTED_CAPABILITIES
                .iter()
                .copied()
                .filter(|c| !caps.contains(c))
                .collect();
            let detail = format!(
                "Helper {} (protocol {}, Android SDK {})",
                health["version"].as_str().unwrap_or("?"),
                health["protocolVersion"],
                health["sdk"]
            );
            if health["protocolVersion"] != 1 {
                checks.push(check(
                    "health",
                    "Helper responds",
                    CheckStatus::Fail,
                    format!("{}; unsupported protocol", detail),
                    None,
                ));
            } else if !missing.is_empty() {
                checks.push(check(
                    "health",
                    "Helper responds",
                    CheckStatus::Warn,
                    format!("{}; missing capabilities: {}", detail, missing.join(", ")),
                    Some("Install the current helper APK."),
                ));
            } else {
                checks.push(check(
                    "health",
                    "Helper responds",
                    CheckStatus::Pass,
                    detail,
                    None,
                ));
            }
        }
        Err(e) => {
            checks.push(check(
                "health",
                "Helper responds",
                CheckStatus::Fail,
                e,
                Some(POWER_GUIDANCE),
            ));
            for (id, label) in [
                ("hierarchy", "UI hierarchy with window metadata"),
                ("screenshot", "Screenshot capture"),
            ] {
                checks.push(check(
                    id,
                    label,
                    CheckStatus::Skip,
                    "Skipped: helper did not respond",
                    None,
                ));
            }
            return;
        }
    }

    match helper_get(state, session, "/hierarchy", Duration::from_secs(10)).await {
        Ok(body) => {
            let xml = body["xml"].as_str().unwrap_or("");
            let windows = xml.matches(" window-id=\"").count();
            let displays: std::collections::BTreeSet<&str> = xml
                .split(" display-id=\"")
                .skip(1)
                .filter_map(|s| s.split('"').next())
                .collect();
            if !xml.contains("<hierarchy") {
                checks.push(check(
                    "hierarchy",
                    "UI hierarchy with window metadata",
                    CheckStatus::Fail,
                    "Response has no hierarchy XML",
                    None,
                ));
            } else if windows == 0 {
                checks.push(check(
                    "hierarchy",
                    "UI hierarchy with window metadata",
                    CheckStatus::Warn,
                    "Hierarchy returned without window metadata",
                    Some("Install the current helper APK."),
                ));
            } else {
                checks.push(check(
                    "hierarchy",
                    "UI hierarchy with window metadata",
                    CheckStatus::Pass,
                    format!(
                        "{} window{} on {} display{}, {} nodes",
                        windows,
                        if windows == 1 { "" } else { "s" },
                        displays.len(),
                        if displays.len() == 1 { "" } else { "s" },
                        xml.matches("<node").count()
                    ),
                    None,
                ));
            }
        }
        Err(e) => checks.push(check(
            "hierarchy",
            "UI hierarchy with window metadata",
            CheckStatus::Fail,
            e,
            None,
        )),
    }

    match helper_get(state, session, "/screenshot", Duration::from_secs(15)).await {
        Ok(body) => {
            let size = body["base64"]
                .as_str()
                .map(|b| b.len() * 3 / 4)
                .unwrap_or(0);
            let secure = &body["secure"];
            if secure.is_null() {
                checks.push(check(
                    "screenshot",
                    "Screenshot capture",
                    CheckStatus::Warn,
                    format!(
                        "PNG captured (~{} KB); helper has no secure-window detection",
                        size / 1024
                    ),
                    Some("Install the current helper APK."),
                ));
            } else if secure["detection"] != "dumpsys" {
                checks.push(check(
                    "screenshot",
                    "Screenshot capture",
                    CheckStatus::Warn,
                    format!(
                        "PNG captured (~{} KB); secure-window detection unavailable: {}",
                        size / 1024,
                        secure["message"].as_str().unwrap_or("unknown reason")
                    ),
                    None,
                ));
            } else if secure["visibleSecureWindow"] == true {
                let titles: Vec<&str> = secure["windows"]
                    .as_array()
                    .map(|a| {
                        a.iter()
                            .filter(|w| w["visible"] == true)
                            .filter_map(|w| w["title"].as_str())
                            .collect()
                    })
                    .unwrap_or_default();
                checks.push(check(
                    "screenshot",
                    "Screenshot capture",
                    CheckStatus::Warn,
                    format!(
                        "PNG captured (~{} KB), but a FLAG_SECURE window is visible, so Android blanks its content: {}",
                        size / 1024,
                        titles.join(", ")
                    ),
                    Some("Expected for banking or credential screens; switch to another app to capture content."),
                ));
            } else {
                checks.push(check(
                    "screenshot",
                    "Screenshot capture",
                    CheckStatus::Pass,
                    format!(
                        "PNG captured (~{} KB); no visible secure window",
                        size / 1024
                    ),
                    None,
                ));
            }
        }
        Err(e) => checks.push(check(
            "screenshot",
            "Screenshot capture",
            CheckStatus::Fail,
            e,
            None,
        )),
    }
}

pub async fn run_helper_checks(
    State(state): State<AppState>,
    Query(query): Query<DeviceQuery>,
) -> Result<Json<HelperChecksResponse>, ApiError> {
    let device_id = query.resolved()?;
    let status = gather_status(&state, device_id).await?;
    let mut checks = Vec::new();

    checks.push(if status.host_apk.available {
        check("host_apk", "Host helper APK available", CheckStatus::Pass, status.host_apk.path.clone().unwrap_or_default(), None)
    } else {
        // Only blocks install/update; an installed helper keeps working, so that case is a warning.
        let (level, effect) = if status.installed {
            (CheckStatus::Warn, "Install and update are unavailable; the installed helper still works.")
        } else {
            (CheckStatus::Fail, "The helper cannot be installed.")
        };
        check(
            "host_apk",
            "Host helper APK available",
            level,
            format!("{} {}", status.host_apk.reason.clone().unwrap_or_default(), effect),
            Some("Start AndruiTerminal with ./scripts/run-dev.sh, which builds helper-apk/ and uses it by default."),
        )
    });

    if !status.installed {
        checks.push(check(
            "installed",
            "Helper installed on device",
            CheckStatus::Fail,
            "Package is not installed",
            Some("Use Install helper."),
        ));
        return Ok(Json(finish(device_id, checks, status)));
    }
    checks.push(check(
        "installed",
        "Helper installed on device",
        CheckStatus::Pass,
        format!(
            "Version {} (code {})",
            status.version_name.as_deref().unwrap_or("?"),
            status
                .version_code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "?".into())
        ),
        None,
    ));
    checks.push(match status.up_to_date {
        Some(true) => check(
            "up_to_date",
            "Installed helper matches host APK",
            CheckStatus::Pass,
            "SHA-256 matches",
            None,
        ),
        Some(false) => check(
            "up_to_date",
            "Installed helper matches host APK",
            CheckStatus::Warn,
            "Installed APK differs from the host APK",
            Some("Use Update helper to install the host build."),
        ),
        None => check(
            "up_to_date",
            "Installed helper matches host APK",
            CheckStatus::Skip,
            if status.host_apk.sha256.is_none() {
                "No host APK to compare against"
            } else {
                "Could not read the installed APK hash from the device"
            },
            None,
        ),
    });
    checks.push(power_check(&state, device_id).await);

    let session = state.get_device_session(device_id).await.ok();
    match session {
        None => {
            checks.push(check(
                "session",
                "Helper session running",
                CheckStatus::Skip,
                "No helper session is running, so the live checks below did not run",
                Some("Start the automation helper (Layout page), then run checks again."),
            ));
            for (id, label) in [
                ("not_frozen", "Helper process is not frozen"),
                ("health", "Helper responds"),
                ("hierarchy", "UI hierarchy with window metadata"),
                ("screenshot", "Screenshot capture"),
            ] {
                checks.push(check(
                    id,
                    label,
                    CheckStatus::Skip,
                    "Not run: no helper session",
                    None,
                ));
            }
        }
        Some(session) => {
            checks.push(check(
                "session",
                "Helper session running",
                CheckStatus::Pass,
                format!("Session {} on host port {}", session.id, session.host_port),
                None,
            ));
            let frozen = frozen_check(&state, device_id).await;
            let is_frozen = frozen.status == CheckStatus::Fail;
            checks.push(frozen);
            if is_frozen {
                for (id, label) in [
                    ("health", "Helper responds"),
                    ("hierarchy", "UI hierarchy with window metadata"),
                    ("screenshot", "Screenshot capture"),
                ] {
                    checks.push(check(
                        id,
                        label,
                        CheckStatus::Skip,
                        "Skipped: helper process is frozen or not running",
                        None,
                    ));
                }
            } else {
                live_checks(&state, &session, &mut checks).await;
            }
        }
    }
    Ok(Json(finish(device_id, checks, status)))
}

fn finish(device_id: &str, checks: Vec<HelperCheck>, status: HelperStatus) -> HelperChecksResponse {
    let any = |status: CheckStatus| checks.iter().any(|c| c.status == status);
    let overall = if any(CheckStatus::Fail) {
        OverallStatus::Fail
    } else if any(CheckStatus::Warn) {
        OverallStatus::Warn
    } else if any(CheckStatus::Skip) {
        OverallStatus::Incomplete
    } else {
        OverallStatus::Pass
    };
    HelperChecksResponse {
        device_id: device_id.to_string(),
        overall,
        checks,
        status,
    }
}
