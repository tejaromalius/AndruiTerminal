use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionState {
    pub name: String,
    pub granted: bool,
    #[serde(rename = "type")]
    pub perm_type: String, // "runtime" | "install" | "requested"
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DumpPackageInfo {
    pub package: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_code: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_sdk: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_sdk: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_id: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub code_path: Option<String>,
    pub permissions: Vec<PermissionState>,
}

/// Parses the output of `dumpsys package <pkg>` into structured JSON.
pub fn parse_dumpsys_package(stdout: &str) -> Option<Value> {
    if !stdout.contains("Package [") && !stdout.contains("Packages:") {
        return None;
    }

    let mut package = String::new();
    let mut version_code = None;
    let mut version_name = None;
    let mut min_sdk = None;
    let mut target_sdk = None;
    let mut user_id = None;
    let mut code_path = None;
    let mut permissions: Vec<PermissionState> = Vec::new();

    let mut current_section = "";

    for line in stdout.lines() {
        let trimmed = line.trim();

        if let Some(rest) = trimmed.strip_prefix("Package [") {
            if let Some((pkg, _)) = rest.split_once(']') {
                package = pkg.to_string();
            }
        } else if trimmed.starts_with("userId=") {
            if let Some(id_str) = trimmed.strip_prefix("userId=") {
                user_id = id_str
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<u32>().ok());
            }
        } else if trimmed.starts_with("codePath=") {
            code_path = trimmed.strip_prefix("codePath=").map(|s| s.to_string());
        } else if trimmed.contains("versionCode=") {
            // E.g.: versionCode=102030 minSdk=26 targetSdk=34
            for token in trimmed.split_whitespace() {
                if let Some(v) = token.strip_prefix("versionCode=") {
                    version_code = v.parse::<u64>().ok();
                } else if let Some(v) = token.strip_prefix("minSdk=") {
                    min_sdk = v.parse::<u32>().ok();
                } else if let Some(v) = token.strip_prefix("targetSdk=") {
                    target_sdk = v.parse::<u32>().ok();
                }
            }
        } else if trimmed.starts_with("versionName=") {
            version_name = trimmed.strip_prefix("versionName=").map(|s| s.to_string());
        } else if trimmed.eq_ignore_ascii_case("requested permissions:") {
            current_section = "requested";
        } else if trimmed.eq_ignore_ascii_case("install permissions:") {
            current_section = "install";
        } else if trimmed.eq_ignore_ascii_case("runtime permissions:") {
            current_section = "runtime";
        } else if trimmed.ends_with(':') && !trimmed.contains("permissions") {
            current_section = "";
        } else if !current_section.is_empty() {
            // Lines in permission sections:
            // "android.permission.INTERNET: granted=true"
            // or "android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SET ]"
            // or just "android.permission.CAMERA"
            if trimmed.starts_with("android.permission.") || trimmed.contains(".permission.") {
                let (name, granted) = if let Some((perm, rest)) = trimmed.split_once(':') {
                    let is_granted = rest.contains("granted=true");
                    (perm.trim(), is_granted)
                } else {
                    (trimmed, false)
                };

                if let Some(existing) = permissions.iter_mut().find(|p| p.name == name) {
                    if current_section == "install" || current_section == "runtime" {
                        existing.granted = granted;
                        existing.perm_type = current_section.to_string();
                    }
                } else {
                    permissions.push(PermissionState {
                        name: name.to_string(),
                        granted,
                        perm_type: current_section.to_string(),
                    });
                }
            }
        }
    }

    if package.is_empty() && permissions.is_empty() {
        return None;
    }

    let info = DumpPackageInfo {
        package,
        version_code,
        version_name,
        min_sdk,
        target_sdk,
        user_id,
        code_path,
        permissions,
    };

    serde_json::to_value(info).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_dumpsys_package() {
        let sample = r#"
Activity Resolver Table:
  Non-Data Actions:
Packages:
  Package [com.example.test] (5a2b1c):
    userId=10123
    pkg=Package{8e3f1a com.example.test}
    codePath=/data/app/com.example.test
    resourcePath=/data/app/com.example.test
    legacyNativeLibraryDir=/data/app/com.example.test/lib
    primaryCpuAbi=arm64-v8a
    versionCode=42 minSdk=28 targetSdk=34
    versionName=1.2.3
    requested permissions:
      android.permission.INTERNET
      android.permission.CAMERA
    install permissions:
      android.permission.INTERNET: granted=true
    runtime permissions:
      android.permission.CAMERA: granted=false, flags=[ USER_SET ]
"#;

        let parsed = parse_dumpsys_package(sample).expect("should parse");
        assert_eq!(parsed["package"], "com.example.test");
        assert_eq!(parsed["userId"], 10123);
        assert_eq!(parsed["versionCode"], 42);
        assert_eq!(parsed["versionName"], "1.2.3");
        assert_eq!(parsed["minSdk"], 28);
        assert_eq!(parsed["targetSdk"], 34);
        assert_eq!(parsed["codePath"], "/data/app/com.example.test");

        let perms = parsed["permissions"].as_array().expect("must be array");
        assert_eq!(perms.len(), 2);
        assert_eq!(perms[0]["name"], "android.permission.INTERNET");
        assert_eq!(perms[0]["granted"], true);
        assert_eq!(perms[1]["name"], "android.permission.CAMERA");
        assert_eq!(perms[1]["granted"], false);
    }
}
