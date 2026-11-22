//! On-device inspection services that go beyond the read-only stats probes:
//! package signing certificates and APK hashes, app-private SQLite databases,
//! and process memory summaries. These coordinate several ADB round trips and,
//! unlike `stats`, may pull binary payloads to the host for local analysis.

pub mod apk;
pub mod database;
pub mod firebase;
pub mod memory;

use sha2::{Digest, Sha256};

use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};

/// Validate an Android package identifier the same way the stats scope does,
/// before it is ever passed to adb.
pub fn valid_package(package: &str) -> bool {
    !package.is_empty()
        && package.len() <= 255
        && package.split('.').all(|part| {
            let mut chars = part.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

fn require_package(package: &str) -> ApiResult<()> {
    if valid_package(package) {
        Ok(())
    } else {
        Err(ApiError::bad_request(
            "INVALID_PACKAGE",
            "A valid package identifier is required",
        ))
    }
}

fn require_device(device_id: &str) -> ApiResult<()> {
    if device_id.is_empty() || device_id.chars().any(|c| c.is_whitespace() || c == '\0') {
        Err(ApiError::bad_request(
            "INVALID_DEVICE",
            "A device serial is required",
        ))
    } else {
        Ok(())
    }
}

/// One APK file belonging to a package (base or split), with its hash.
#[derive(Debug, Clone, serde::Serialize)]
pub struct ApkFile {
    pub path: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: usize,
}

/// Full signing report for a package.
#[derive(Debug, Clone, serde::Serialize)]
pub struct PackageSigning {
    pub package: String,
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub apks: Vec<ApkFile>,
    pub signing: apk::ApkSigning,
}

const MAX_APK_BYTES: usize = 512 * 1024 * 1024;

/// Resolve the APK paths for a package via `pm path`.
pub async fn package_apk_paths(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> ApiResult<Vec<String>> {
    let args = vec![
        "-s".to_string(),
        device_id.to_string(),
        "shell".to_string(),
        "pm".to_string(),
        "path".to_string(),
        package.to_string(),
    ];
    let out = executor
        .execute(&args, Some(std::time::Duration::from_secs(20)), None)
        .await?;
    let paths: Vec<String> = out
        .stdout
        .lines()
        .filter_map(|l| l.trim().strip_prefix("package:"))
        .map(|p| p.trim().to_string())
        .filter(|p| p.starts_with('/'))
        .collect();
    if paths.is_empty() {
        return Err(ApiError::not_found(
            "PACKAGE_NOT_FOUND",
            format!("No APK paths reported for '{package}' (not installed for this user?)"),
        ));
    }
    Ok(paths)
}

/// Pull one APK's raw bytes via `exec-out cat`, which streams unmodified binary.
pub(crate) async fn pull_apk_bytes(
    executor: &AdbExecutor,
    device_id: &str,
    path: &str,
) -> ApiResult<Vec<u8>> {
    // The device path comes from `pm path`, never user text; still reject shell
    // metacharacters defensively before it reaches `exec-out`.
    if path.contains(['\'', '"', '\n', '\0', ';', '&', '|', '`', '$', '(', ')']) {
        return Err(ApiError::bad_request(
            "INVALID_PATH",
            "Unsupported APK path",
        ));
    }
    let args = vec![
        "-s".to_string(),
        device_id.to_string(),
        "exec-out".to_string(),
        "cat".to_string(),
        path.to_string(),
    ];
    let out = executor
        .execute_bytes(
            &args,
            None,
            std::time::Duration::from_secs(120),
            MAX_APK_BYTES,
        )
        .await?;
    if out.exit_code != 0 || out.stdout.is_empty() {
        return Err(ApiError::bad_request(
            "APK_READ_FAILED",
            format!(
                "Could not read {path}: {}",
                out.stderr.trim().lines().next().unwrap_or("empty output")
            ),
        ));
    }
    Ok(out.stdout)
}

fn sha256_hex(data: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(data);
    h.finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>()
}

/// Inspect a package's APKs: pull each one, hash it, and parse the signing
/// certificates from the base APK.
pub async fn inspect_package_signing(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> ApiResult<PackageSigning> {
    require_device(device_id)?;
    require_package(package)?;
    let paths = package_apk_paths(executor, device_id, package).await?;

    let mut apks = Vec::new();
    let mut signing = apk::ApkSigning::default();
    // The base APK carries the signing block; prefer a path ending in base.apk.
    let base_first = {
        let mut p = paths.clone();
        p.sort_by_key(|path| !path.ends_with("base.apk"));
        p
    };
    for (idx, path) in base_first.iter().enumerate() {
        let bytes = pull_apk_bytes(executor, device_id, path).await?;
        if idx == 0 {
            signing = apk::inspect_apk(&bytes);
        }
        apks.push(ApkFile {
            sha256: sha256_hex(&bytes),
            size_bytes: bytes.len(),
            path: path.clone(),
        });
    }

    Ok(PackageSigning {
        package: package.to_string(),
        device_id: device_id.to_string(),
        apks,
        signing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn package_validation_matches_stats_rules() {
        assert!(valid_package("com.example.app"));
        assert!(!valid_package("com.app;id"));
        assert!(!valid_package(""));
    }

    #[test]
    fn helper_apk_signature_is_parsed() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../helper-apk/build/andrui-helper.apk");
        if !path.exists() {
            eprintln!("skipping: helper APK not built at {path:?}");
            return;
        }
        let bytes = std::fs::read(&path).unwrap();
        let signing = apk::inspect_apk(&bytes);
        assert!(
            !signing.certificates.is_empty(),
            "expected at least one signing certificate, warnings={:?}",
            signing.warnings
        );
        let cert = &signing.certificates[0];
        assert_eq!(cert.sha256.split(':').count(), 32, "SHA-256 is 32 bytes");
        assert_eq!(cert.sha1.split(':').count(), 20, "SHA-1 is 20 bytes");
    }
}
