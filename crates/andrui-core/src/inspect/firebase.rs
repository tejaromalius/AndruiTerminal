//! Firebase inspection and tooling.
//!
//! Local, ADB-only features: detect bundled Firebase SDKs and extract the
//! Firebase config baked into an APK, toggle Analytics/Crashlytics debug
//! logging on the device, and set up `adb reverse` ports for the Firebase Local
//! Emulator Suite.
//!
//! Cloud features (opt-in): send an FCM test message and read the Remote Config
//! template. These require a Google service-account key and make outbound HTTPS
//! calls to Google, which is the one place this app leaves the local-only model;
//! the key path is supplied through an environment variable and never stored.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::{require_device, require_package};
use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};

// --- Local: SDK inventory and config extraction from the APK ---

/// A Firebase/GMS library detected inside an APK.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct FirebaseSdk {
    pub artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
}

/// Firebase config values discovered in an APK's resources.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct FirebaseConfig {
    #[serde(rename = "appIds")]
    pub app_ids: Vec<String>,
    #[serde(rename = "apiKeys")]
    pub api_keys: Vec<String>,
    #[serde(rename = "projectIds")]
    pub project_ids: Vec<String>,
    #[serde(rename = "databaseUrls")]
    pub database_urls: Vec<String>,
    #[serde(rename = "storageBuckets")]
    pub storage_buckets: Vec<String>,
    #[serde(rename = "senderIds")]
    pub sender_ids: Vec<String>,
}

/// Combined local Firebase report for a package.
#[derive(Debug, Clone, Serialize)]
pub struct FirebaseReport {
    pub package: String,
    #[serde(rename = "usesFirebase")]
    pub uses_firebase: bool,
    pub sdks: Vec<FirebaseSdk>,
    pub config: FirebaseConfig,
    /// Logcat tags worth enabling for Firebase debugging.
    #[serde(rename = "logTags")]
    pub log_tags: Vec<&'static str>,
    /// Firebase Local Emulator Suite default ports.
    #[serde(rename = "emulatorPorts")]
    pub emulator_ports: Vec<EmulatorPort>,
}

#[derive(Debug, Clone, Serialize)]
pub struct EmulatorPort {
    pub service: &'static str,
    pub port: u16,
}

const EMULATOR_PORTS: &[EmulatorPort] = &[
    EmulatorPort {
        service: "auth",
        port: 9099,
    },
    EmulatorPort {
        service: "firestore",
        port: 8080,
    },
    EmulatorPort {
        service: "database",
        port: 9000,
    },
    EmulatorPort {
        service: "functions",
        port: 5001,
    },
    EmulatorPort {
        service: "storage",
        port: 9199,
    },
    EmulatorPort {
        service: "pubsub",
        port: 8085,
    },
];

const LOG_TAGS: &[&str] = &[
    "FA",
    "FA-SVC",
    "FirebaseCrashlytics",
    "FirebasePerformance",
    "FirebaseMessaging",
    "Firestore",
];

/// Detect bundled Firebase/GMS SDK versions from APK ZIP entries.
pub fn scan_sdks(apk: &[u8]) -> Vec<FirebaseSdk> {
    let mut sdks = Vec::new();
    for entry in apk::zip_entries(apk) {
        let name = entry.name.clone();
        let lower = name.to_lowercase();
        // AndroidX/Firebase version markers: META-INF/<group>_<artifact>.version
        let is_version_marker = lower.starts_with("meta-inf/")
            && lower.ends_with(".version")
            && (lower.contains("firebase") || lower.contains("com.google.android.gms"));
        // google-services bundles firebase-*.properties too.
        let is_properties = lower.contains("firebase") && lower.ends_with(".properties");
        if !(is_version_marker || is_properties) {
            continue;
        }
        let artifact = name
            .rsplit('/')
            .next()
            .unwrap_or(&name)
            .trim_end_matches(".version")
            .trim_end_matches(".properties")
            .to_string();
        let version = apk::read_zip_entry(apk, &entry).and_then(|b| {
            let text = String::from_utf8_lossy(&b);
            text.lines()
                .map(str::trim)
                .find(|l| !l.is_empty() && !l.starts_with('#'))
                .map(|l| l.rsplit('=').next().unwrap_or(l).trim().to_string())
        });
        if !sdks.iter().any(|s: &FirebaseSdk| s.artifact == artifact) {
            sdks.push(FirebaseSdk { artifact, version });
        }
    }
    sdks.sort_by(|a, b| a.artifact.cmp(&b.artifact));
    sdks
}

use super::apk;

/// Extract Firebase config values from APK bytes by scanning decoded string
/// data for the well-known value shapes. This is a heuristic over the resource
/// string pool rather than a full `resources.arsc` decode.
pub fn extract_config(apk_bytes: &[u8]) -> FirebaseConfig {
    // resources.arsc holds the config strings; fall back to the whole APK.
    let haystack = apk::zip_entries(apk_bytes)
        .iter()
        .find(|e| e.name == "resources.arsc")
        .and_then(|e| apk::read_zip_entry(apk_bytes, e))
        .unwrap_or_else(|| apk_bytes.to_vec());
    scan_config_bytes(&haystack)
}

fn scan_config_bytes(bytes: &[u8]) -> FirebaseConfig {
    // Build two latin1 views: raw, and NUL-stripped (collapses UTF-16LE to ASCII).
    let raw: String = bytes.iter().map(|&b| b as char).collect();
    let stripped: String = bytes
        .iter()
        .filter(|&&b| b != 0)
        .map(|&b| b as char)
        .collect();

    let mut config = FirebaseConfig::default();
    let add = |v: &mut Vec<String>, s: String| {
        if !v.contains(&s) {
            v.push(s);
        }
    };

    for text in [&raw, &stripped] {
        for cap in RE_APP_ID.find_iter(text) {
            let id = cap.as_str().to_string();
            // The second field of the app id is the GCM/project sender id.
            if let Some(sender) = id.split(':').nth(1) {
                add(&mut config.sender_ids, sender.to_string());
            }
            add(&mut config.app_ids, id);
        }
        for cap in RE_API_KEY.find_iter(text) {
            add(&mut config.api_keys, cap.as_str().to_string());
        }
        for cap in RE_DB_URL.find_iter(text) {
            let url = cap.as_str().to_string();
            if let Some(project) = project_from_host(&url) {
                add(&mut config.project_ids, project);
            }
            add(&mut config.database_urls, url);
        }
        for cap in RE_BUCKET.find_iter(text) {
            let bucket = cap.as_str().to_string();
            if let Some(project) = bucket.strip_suffix(".appspot.com") {
                add(&mut config.project_ids, project.to_string());
            }
            add(&mut config.storage_buckets, bucket);
        }
    }
    config
}

fn project_from_host(url: &str) -> Option<String> {
    let host = url.strip_prefix("https://")?;
    let sub = host.split('.').next()?;
    // Realtime DB hosts are "<project>-default-rtdb" or "<project>".
    Some(sub.trim_end_matches("-default-rtdb").to_string())
}

use regex::Regex;
use std::sync::LazyLock;

static RE_APP_ID: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[0-9]+:[0-9]+:(?:android|ios|web):[0-9a-fA-F]+").unwrap());
static RE_API_KEY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"AIza[0-9A-Za-z_\-]{35}").unwrap());
static RE_DB_URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"https://[a-z0-9\-]+\.(?:firebaseio\.com|firebasedatabase\.app)").unwrap()
});
static RE_BUCKET: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[a-z0-9][a-z0-9_.\-]+\.appspot\.com").unwrap());

/// Build the full local Firebase report for an installed package.
pub async fn local_report(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> ApiResult<FirebaseReport> {
    require_device(device_id)?;
    require_package(package)?;
    let paths = super::package_apk_paths(executor, device_id, package).await?;
    let base = paths
        .iter()
        .find(|p| p.ends_with("base.apk"))
        .cloned()
        .unwrap_or_else(|| paths[0].clone());
    let bytes = super::pull_apk_bytes(executor, device_id, &base).await?;

    let sdks = scan_sdks(&bytes);
    let config = extract_config(&bytes);
    let uses_firebase =
        !sdks.is_empty() || !config.app_ids.is_empty() || !config.api_keys.is_empty();

    Ok(FirebaseReport {
        package: package.to_string(),
        uses_firebase,
        sdks,
        config,
        log_tags: LOG_TAGS.to_vec(),
        emulator_ports: EMULATOR_PORTS
            .iter()
            .map(|p| EmulatorPort { ..*p })
            .collect(),
    })
}

// --- Device: debug logging toggles and emulator reverse ports ---

/// Result of toggling Firebase debug logging on the device.
#[derive(Debug, Clone, Serialize)]
pub struct DebugToggleResult {
    pub package: String,
    pub enabled: bool,
    pub commands: Vec<String>,
}

/// Enable or disable Firebase Analytics DebugView and verbose Firebase logging.
pub async fn set_debug_logging(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
    enable: bool,
    confirmed: bool,
) -> ApiResult<DebugToggleResult> {
    require_device(device_id)?;
    require_package(package)?;
    if !confirmed {
        return Err(ApiError::bad_request(
            "CONFIRMATION_REQUIRED",
            "Changing device debug properties requires confirmation",
        ));
    }
    // `debug.firebase.analytics.app` routes Analytics into DebugView; ".none."
    // clears it. Log tags raise Firebase verbosity. All reset on reboot.
    let analytics_value = if enable { package } else { ".none." };
    let level = if enable { "VERBOSE" } else { "INFO" };
    let mut commands = Vec::new();

    run_setprop(
        executor,
        device_id,
        "debug.firebase.analytics.app",
        analytics_value,
        &mut commands,
    )
    .await?;
    for tag in ["FA", "FA-SVC"] {
        run_setprop(
            executor,
            device_id,
            &format!("log.tag.{tag}"),
            level,
            &mut commands,
        )
        .await?;
    }

    Ok(DebugToggleResult {
        package: package.to_string(),
        enabled: enable,
        commands,
    })
}

async fn run_setprop(
    executor: &AdbExecutor,
    device_id: &str,
    key: &str,
    value: &str,
    commands: &mut Vec<String>,
) -> ApiResult<()> {
    commands.push(format!("setprop {key} {value}"));
    let out = executor
        .execute(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "setprop".into(),
                key.into(),
                value.into(),
            ],
            Some(Duration::from_secs(15)),
            None,
        )
        .await?;
    if out.exit_code != 0 {
        return Err(ApiError::bad_request(
            "SETPROP_FAILED",
            format!("setprop {key} failed: {}", out.stderr.trim()),
        ));
    }
    Ok(())
}

/// Set up `adb reverse` ports so the device reaches the host Firebase emulators.
pub async fn setup_emulator_reverse(
    executor: &AdbExecutor,
    device_id: &str,
    confirmed: bool,
) -> ApiResult<Vec<EmulatorPort>> {
    require_device(device_id)?;
    if !confirmed {
        return Err(ApiError::bad_request(
            "CONFIRMATION_REQUIRED",
            "Creating reverse port forwards requires confirmation",
        ));
    }
    for p in EMULATOR_PORTS {
        let spec = format!("tcp:{}", p.port);
        let out = executor
            .execute(
                &[
                    "-s".into(),
                    device_id.into(),
                    "reverse".into(),
                    spec.clone(),
                    spec.clone(),
                ],
                Some(Duration::from_secs(15)),
                None,
            )
            .await?;
        if out.exit_code != 0 {
            return Err(ApiError::bad_request(
                "REVERSE_FAILED",
                format!("adb reverse {spec} failed: {}", out.stderr.trim()),
            ));
        }
    }
    Ok(EMULATOR_PORTS
        .iter()
        .map(|p| EmulatorPort { ..*p })
        .collect())
}

// --- Cloud: service-account authenticated calls to Google ---

#[derive(Debug, Deserialize)]
struct ServiceAccount {
    client_email: String,
    private_key: String,
    #[serde(default = "default_token_uri")]
    token_uri: String,
    #[serde(default)]
    project_id: String,
}

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

/// Load a service account JSON from the file named by an environment variable.
///
/// The request supplies the *name* of the env var (e.g. `GOOGLE_APPLICATION_CREDENTIALS`);
/// its value is a path to the key file. The key material is never stored or logged.
fn load_service_account(env_var: &str) -> ApiResult<ServiceAccount> {
    if env_var.is_empty()
        || !env_var
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_')
    {
        return Err(ApiError::bad_request(
            "INVALID_ENV",
            "Service-account env var name must be alphanumeric/underscore",
        ));
    }
    let path = std::env::var(env_var).map_err(|_| {
        ApiError::bad_request(
            "CREDENTIALS_UNSET",
            format!("Environment variable {env_var} is not set to a key file path"),
        )
    })?;
    let data = std::fs::read(&path).map_err(|e| {
        ApiError::bad_request("CREDENTIALS_UNREADABLE", format!("Cannot read {path}: {e}"))
    })?;
    serde_json::from_slice(&data).map_err(|e| {
        ApiError::bad_request(
            "CREDENTIALS_INVALID",
            format!("Invalid service account JSON: {e}"),
        )
    })
}

fn b64url(data: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(data)
}

/// Build the signed-JWT input (header.claims) for a service account and scope.
fn jwt_signing_input(sa: &ServiceAccount, scope: &str, now: i64) -> String {
    let header = serde_json::json!({ "alg": "RS256", "typ": "JWT" });
    let claims = serde_json::json!({
        "iss": sa.client_email,
        "scope": scope,
        "aud": sa.token_uri,
        "iat": now,
        "exp": now + 3600,
    });
    format!(
        "{}.{}",
        b64url(serde_json::to_string(&header).unwrap().as_bytes()),
        b64url(serde_json::to_string(&claims).unwrap().as_bytes())
    )
}

/// Decode the PEM private key body to DER (PKCS#8).
fn pem_to_der(pem: &str) -> ApiResult<Vec<u8>> {
    use base64::Engine;
    let body: String = pem
        .lines()
        .filter(|l| !l.starts_with("-----"))
        .collect::<Vec<_>>()
        .join("");
    base64::engine::general_purpose::STANDARD
        .decode(body.trim())
        .map_err(|e| ApiError::bad_request("KEY_INVALID", format!("Bad private key: {e}")))
}

/// Sign the JWT and exchange it for a short-lived OAuth2 access token.
async fn fetch_access_token(sa: &ServiceAccount, scope: &str) -> ApiResult<String> {
    if !sa.token_uri.starts_with("https://") {
        return Err(ApiError::bad_request(
            "INSECURE_ENDPOINT",
            "token_uri must be HTTPS",
        ));
    }
    let now = chrono::Utc::now().timestamp();
    let signing_input = jwt_signing_input(sa, scope, now);

    let der = pem_to_der(&sa.private_key)?;
    let key_pair = ring::signature::RsaKeyPair::from_pkcs8(&der)
        .map_err(|e| ApiError::bad_request("KEY_INVALID", format!("RSA key parse failed: {e}")))?;
    let rng = ring::rand::SystemRandom::new();
    let mut sig = vec![0u8; key_pair.public().modulus_len()];
    key_pair
        .sign(
            &ring::signature::RSA_PKCS1_SHA256,
            &rng,
            signing_input.as_bytes(),
            &mut sig,
        )
        .map_err(|_| ApiError::internal("JWT_SIGN_FAILED", "Failed to sign JWT"))?;
    let assertion = format!("{signing_input}.{}", b64url(&sig));

    let client = reqwest::Client::new();
    let resp = client
        .post(&sa.token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &assertion),
        ])
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ApiError::bad_request("TOKEN_REQUEST_FAILED", e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| ApiError::bad_request("TOKEN_PARSE_FAILED", e.to_string()))?;
    if !status.is_success() {
        return Err(ApiError::bad_request(
            "TOKEN_DENIED",
            format!("Token endpoint returned {status}: {body}"),
        ));
    }
    body["access_token"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| ApiError::bad_request("TOKEN_MISSING", "No access_token in response"))
}

/// Request to send a test FCM message.
#[derive(Debug, Deserialize)]
pub struct FcmSendRequest {
    #[serde(rename = "serviceAccountEnv")]
    pub service_account_env: String,
    #[serde(rename = "projectId", default)]
    pub project_id: String,
    #[serde(default)]
    pub token: Option<String>,
    #[serde(default)]
    pub topic: Option<String>,
    pub title: String,
    pub body: String,
    #[serde(default)]
    pub data: Option<std::collections::BTreeMap<String, String>>,
    #[serde(default)]
    pub confirmed: bool,
}

/// Send a test message through the FCM HTTP v1 API.
pub async fn fcm_send(req: &FcmSendRequest) -> ApiResult<serde_json::Value> {
    if !req.confirmed {
        return Err(ApiError::bad_request(
            "CONFIRMATION_REQUIRED",
            "Sending an FCM message makes an outbound call to Google and requires confirmation",
        ));
    }
    let sa = load_service_account(&req.service_account_env)?;
    let project_id = if req.project_id.is_empty() {
        sa.project_id.clone()
    } else {
        req.project_id.clone()
    };
    if project_id.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PROJECT",
            "projectId is required",
        ));
    }
    let target = match (&req.token, &req.topic) {
        (Some(t), None) if !t.is_empty() => serde_json::json!({ "token": t }),
        (None, Some(topic)) if !topic.is_empty() => serde_json::json!({ "topic": topic }),
        _ => {
            return Err(ApiError::bad_request(
                "MISSING_TARGET",
                "Exactly one of token or topic is required",
            ))
        }
    };
    let mut message = serde_json::Map::new();
    message.insert(
        "notification".into(),
        serde_json::json!({ "title": req.title, "body": req.body }),
    );
    if let Some(data) = &req.data {
        message.insert("data".into(), serde_json::json!(data));
    }
    for (k, v) in target.as_object().unwrap() {
        message.insert(k.clone(), v.clone());
    }

    let token =
        fetch_access_token(&sa, "https://www.googleapis.com/auth/firebase.messaging").await?;
    let url = format!("https://fcm.googleapis.com/v1/projects/{project_id}/messages:send");
    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(token)
        .json(&serde_json::json!({ "message": message }))
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ApiError::bad_request("FCM_REQUEST_FAILED", e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(ApiError::bad_request(
            "FCM_SEND_FAILED",
            format!("FCM returned {status}: {body}"),
        ));
    }
    Ok(body)
}

/// Read the active Remote Config template for a project.
pub async fn remote_config_get(
    service_account_env: &str,
    project_id: &str,
) -> ApiResult<serde_json::Value> {
    let sa = load_service_account(service_account_env)?;
    let project = if project_id.is_empty() {
        sa.project_id.clone()
    } else {
        project_id.to_string()
    };
    if project.is_empty() {
        return Err(ApiError::bad_request(
            "MISSING_PROJECT",
            "projectId is required",
        ));
    }
    let token =
        fetch_access_token(&sa, "https://www.googleapis.com/auth/firebase.remoteconfig").await?;
    let url =
        format!("https://firebaseremoteconfig.googleapis.com/v1/projects/{project}/remoteConfig");
    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .bearer_auth(token)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| ApiError::bad_request("RC_REQUEST_FAILED", e.to_string()))?;
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or(serde_json::Value::Null);
    if !status.is_success() {
        return Err(ApiError::bad_request(
            "RC_FETCH_FAILED",
            format!("Remote Config returned {status}: {body}"),
        ));
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn config_scan_finds_firebase_values_in_utf16_and_utf8() {
        // Simulate a resources.arsc-style blob with UTF-16LE and UTF-8 strings.
        let mut bytes = Vec::new();
        let utf16 = |s: &str, out: &mut Vec<u8>| {
            for c in s.encode_utf16() {
                out.extend_from_slice(&c.to_le_bytes());
            }
        };
        utf16("1:1234567890:android:abcdef0123456789", &mut bytes);
        bytes.push(0);
        bytes.extend_from_slice(b"AIzaSyA1234567890123456789012345678901");
        bytes.push(0);
        utf16(
            "https://demo-project-default-rtdb.firebaseio.com",
            &mut bytes,
        );
        bytes.extend_from_slice(b"demo-project.appspot.com");

        let cfg = scan_config_bytes(&bytes);
        assert!(cfg.app_ids.iter().any(|a| a.contains(":android:")));
        assert!(cfg.api_keys.iter().any(|k| k.starts_with("AIza")));
        assert!(cfg.sender_ids.contains(&"1234567890".to_string()));
        assert!(cfg
            .database_urls
            .iter()
            .any(|u| u.contains("firebaseio.com")));
        assert!(cfg
            .storage_buckets
            .contains(&"demo-project.appspot.com".to_string()));
        assert!(cfg.project_ids.contains(&"demo-project".to_string()));
    }

    #[test]
    fn jwt_signing_input_is_two_base64url_segments() {
        let sa = ServiceAccount {
            client_email: "svc@example.iam.gserviceaccount.com".into(),
            private_key: String::new(),
            token_uri: default_token_uri(),
            project_id: "demo".into(),
        };
        let input = jwt_signing_input(&sa, "scope", 1_000_000);
        let parts: Vec<_> = input.split('.').collect();
        assert_eq!(parts.len(), 2);
        // Must be URL-safe base64 (no '+' '/' '=').
        assert!(!input.contains('+') && !input.contains('/') && !input.contains('='));
    }

    #[test]
    fn empty_apk_reports_no_firebase() {
        assert!(scan_sdks(b"not an apk").is_empty());
        assert_eq!(extract_config(b"not an apk"), FirebaseConfig::default());
    }

    #[test]
    fn service_account_env_name_is_validated() {
        assert!(load_service_account("bad name!").is_err());
    }
}
