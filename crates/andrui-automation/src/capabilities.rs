use axum::{extract::State, Json};
use serde::Serialize;
use tokio::process::Command;

use crate::state::AppState;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesResponse {
    pub helper_apk: HelperApkCapability,
    pub tesseract: TesseractCapability,
    pub template_matching: TemplateMatchingCapability,
    pub capabilities: Vec<CapabilityItem>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HelperApkCapability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TesseractCapability {
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateMatchingCapability {
    pub available: bool,
    pub method: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityItem {
    pub id: String,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub async fn get_capabilities(State(state): State<AppState>) -> Json<CapabilitiesResponse> {
    // Check Helper APK
    let helper_apk_cap = match &state.config.helper_apk {
        Some(path) => {
            if path.exists() {
                HelperApkCapability {
                    available: true,
                    path: Some(path.display().to_string()),
                    reason: None,
                }
            } else {
                HelperApkCapability {
                    available: false,
                    path: Some(path.display().to_string()),
                    reason: Some(format!("Helper APK file does not exist at {:?}", path)),
                }
            }
        }
        None => HelperApkCapability {
            available: false,
            path: None,
            reason: Some("Helper APK path not configured in ExtensionsConfig".to_string()),
        },
    };

    // Check Tesseract executable
    let tesseract_cap = match Command::new("tesseract").arg("--version").output().await {
        Ok(out) if out.status.success() => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            let first_line = stdout
                .lines()
                .next()
                .unwrap_or("unknown")
                .trim()
                .to_string();
            TesseractCapability {
                available: true,
                version: Some(first_line),
                reason: None,
            }
        }
        _ => TesseractCapability {
            available: false,
            version: None,
            reason: Some("Tesseract executable not found in host PATH".to_string()),
        },
    };

    let tm_cap = TemplateMatchingCapability {
        available: true,
        method: "normalized_cross_correlation".to_string(),
    };

    let capabilities = vec![
        CapabilityItem {
            id: "helper_session".to_string(),
            available: helper_apk_cap.available,
            reason: helper_apk_cap.reason.clone(),
        },
        CapabilityItem {
            id: "hierarchy".to_string(),
            available: true,
            reason: None,
        },
        CapabilityItem {
            id: "actions".to_string(),
            available: true,
            reason: None,
        },
        CapabilityItem {
            id: "events".to_string(),
            available: true,
            reason: None,
        },
        CapabilityItem {
            id: "screenshot".to_string(),
            available: true,
            reason: None,
        },
        CapabilityItem {
            id: "ocr".to_string(),
            available: tesseract_cap.available,
            reason: tesseract_cap.reason.clone(),
        },
        CapabilityItem {
            id: "match".to_string(),
            available: true,
            reason: None,
        },
        CapabilityItem {
            id: "recordings".to_string(),
            available: true,
            reason: None,
        },
        CapabilityItem {
            id: "replay".to_string(),
            available: true,
            reason: None,
        },
    ];

    Json(CapabilitiesResponse {
        helper_apk: helper_apk_cap,
        tesseract: tesseract_cap,
        template_matching: tm_cap,
        capabilities,
    })
}
