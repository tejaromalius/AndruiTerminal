use crate::error::MediaError;
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{io::AsyncReadExt, process::Command};
use tracing::{debug, warn};

const PNG_MAGIC: [u8; 8] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const MAX_SCREENSHOT_BYTES: usize = 50 * 1024 * 1024; // 50MB bound
const ADB_TIMEOUT: Duration = Duration::from_secs(12);

/// Validates that the provided bytes begin with the standard 8-byte PNG signature.
pub fn is_valid_png(data: &[u8]) -> bool {
    data.len() >= 8 && data[..8] == PNG_MAGIC
}

/// Strip carriage returns (\r\n -> \n) if shell corrupted binary PNG stream
fn fix_crlf_png(data: &[u8]) -> Vec<u8> {
    if is_valid_png(data) {
        return data.to_vec();
    }
    // Check if corrupted by \r\n replacement
    let mut fixed = Vec::with_capacity(data.len());
    let mut i = 0;
    while i < data.len() {
        if data[i] == b'\r' && i + 1 < data.len() && data[i + 1] == b'\n' {
            fixed.push(b'\n');
            i += 2;
        } else {
            fixed.push(data[i]);
            i += 1;
        }
    }
    fixed
}

/// Binary-safe capture of device display as PNG bytes
pub async fn capture_screencap_png(
    adb_path: &Path,
    device_id: &str,
) -> Result<Vec<u8>, MediaError> {
    if device_id.trim().is_empty() {
        return Err(MediaError::BadRequest(
            "deviceId cannot be empty".to_string(),
        ));
    }

    // First attempt: exec-out screencap -p (pure binary stream, no pty translation)
    let res = tokio::time::timeout(ADB_TIMEOUT, async {
        let mut child = Command::new(adb_path)
            .args(["-s", device_id, "exec-out", "screencap", "-p"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MediaError::Internal(format!("Failed to spawn adb: {}", e)))?;

        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        let mut out_bytes = Vec::new();
        let mut err_bytes = Vec::new();

        let (stdout_res, stderr_res) = tokio::join!(
            async {
                let mut buf = [0u8; 16384];
                loop {
                    let n = stdout
                        .read(&mut buf)
                        .await
                        .map_err(|e| MediaError::Internal(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    if out_bytes.len() + n > MAX_SCREENSHOT_BYTES {
                        return Err(MediaError::InvalidData(
                            "Screenshot exceeds maximum size limit (50MB)".to_string(),
                        ));
                    }
                    out_bytes.extend_from_slice(&buf[..n]);
                }
                Ok::<_, MediaError>(())
            },
            async {
                let mut buf = [0u8; 4096];
                loop {
                    let n = stderr
                        .read(&mut buf)
                        .await
                        .map_err(|e| MediaError::Internal(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    if err_bytes.len() < 65536 {
                        let take = n.min(65536 - err_bytes.len());
                        err_bytes.extend_from_slice(&buf[..take]);
                    }
                }
                Ok::<_, MediaError>(())
            }
        );
        stdout_res?;
        stderr_res?;

        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, out_bytes, err_bytes))
    })
    .await
    .map_err(|_| MediaError::Timeout("Timed out capturing screen via exec-out".to_string()))??;

    let (status, stdout_bytes, stderr_bytes) = res;
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).to_string();

    if status.success() && is_valid_png(&stdout_bytes) {
        return Ok(stdout_bytes);
    }

    if stderr_str.contains("device offline") {
        return Err(MediaError::DeviceOffline(stderr_str));
    }
    if stderr_str.contains("not found") {
        return Err(MediaError::NotFound(format!(
            "Device '{}' not found",
            device_id
        )));
    }

    debug!("exec-out screencap failed or returned non-PNG, trying fallback shell screencap -p");

    // Fallback attempt: shell screencap -p
    let fallback_res = tokio::time::timeout(ADB_TIMEOUT, async {
        let mut child = Command::new(adb_path)
            .args(["-s", device_id, "shell", "screencap", "-p"])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MediaError::Internal(format!("Failed to spawn adb: {}", e)))?;

        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");

        let mut out_bytes = Vec::new();
        let mut err_bytes = Vec::new();

        let (stdout_res, stderr_res) = tokio::join!(
            async {
                let mut buf = [0u8; 16384];
                loop {
                    let n = stdout
                        .read(&mut buf)
                        .await
                        .map_err(|e| MediaError::Internal(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    if out_bytes.len() + n > MAX_SCREENSHOT_BYTES {
                        return Err(MediaError::InvalidData(
                            "Screenshot exceeds maximum size limit".to_string(),
                        ));
                    }
                    out_bytes.extend_from_slice(&buf[..n]);
                }
                Ok::<_, MediaError>(())
            },
            async {
                let mut buf = [0u8; 4096];
                loop {
                    let n = stderr
                        .read(&mut buf)
                        .await
                        .map_err(|e| MediaError::Internal(e.to_string()))?;
                    if n == 0 {
                        break;
                    }
                    if err_bytes.len() < 65536 {
                        let take = n.min(65536 - err_bytes.len());
                        err_bytes.extend_from_slice(&buf[..take]);
                    }
                }
                Ok::<_, MediaError>(())
            }
        );
        stdout_res?;
        stderr_res?;

        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, out_bytes, err_bytes))
    })
    .await
    .map_err(|_| MediaError::Timeout("Timed out capturing screen via shell".to_string()))??;

    let (fb_status, fb_stdout, fb_stderr) = fallback_res;
    let fb_err = String::from_utf8_lossy(&fb_stderr).to_string();

    if !fb_status.success() {
        return Err(MediaError::CommandFailed {
            code: fb_status.code(),
            stderr: if fb_err.is_empty() {
                stderr_str
            } else {
                fb_err
            },
        });
    }

    if is_valid_png(&fb_stdout) {
        return Ok(fb_stdout);
    }

    // Try fixing CRLF corruption
    let fixed = fix_crlf_png(&fb_stdout);
    if is_valid_png(&fixed) {
        return Ok(fixed);
    }

    Err(MediaError::InvalidData(
        "Device returned invalid image data (not a valid PNG header)".to_string(),
    ))
}

/// Push a file to target device
pub async fn adb_push(
    adb_path: &Path,
    device_id: &str,
    local_path: &Path,
    remote_path: &str,
) -> Result<(), MediaError> {
    if device_id.trim().is_empty() {
        return Err(MediaError::BadRequest(
            "deviceId cannot be empty".to_string(),
        ));
    }
    let local_path_str = local_path.to_str().unwrap_or_default();
    let fut = async {
        let mut child = Command::new(adb_path)
            .args(["-s", device_id, "push", local_path_str, remote_path])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MediaError::Internal(format!("Failed to execute adb push: {}", e)))?;

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = stdout.take(8192).read_to_end(&mut out).await;
        let _ = stderr.take(8192).read_to_end(&mut err).await;
        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, err))
    };

    let (status, err) = tokio::time::timeout(Duration::from_secs(15), fut)
        .await
        .map_err(|_| MediaError::Timeout("Timed out pushing file via adb".to_string()))??;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&err).to_string();
        return Err(MediaError::CommandFailed {
            code: status.code(),
            stderr,
        });
    }
    Ok(())
}

/// Establish an ADB forward rule using tcp:0 to let ADB dynamically allocate an ephemeral port,
/// parse the allocated port from stdout, and fail explicitly on invalid output.
pub async fn adb_forward_tcp0(
    adb_path: &Path,
    device_id: &str,
    remote_abstract_socket: &str,
) -> Result<u16, MediaError> {
    if device_id.trim().is_empty() {
        return Err(MediaError::BadRequest(
            "deviceId cannot be empty".to_string(),
        ));
    }

    let fut = async {
        let mut child = Command::new(adb_path)
            .args([
                "-s",
                device_id,
                "forward",
                "tcp:0",
                &format!("localabstract:{}", remote_abstract_socket),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MediaError::Internal(format!("Failed to execute adb forward: {}", e)))?;

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = stdout.take(4096).read_to_end(&mut out).await;
        let _ = stderr.take(4096).read_to_end(&mut err).await;
        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, out, err))
    };

    let (status, stdout_bytes, stderr_bytes) = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .map_err(|_| MediaError::Timeout("Timed out establishing adb forward".to_string()))??;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
        return Err(MediaError::CommandFailed {
            code: status.code(),
            stderr,
        });
    }

    let stdout_str = String::from_utf8_lossy(&stdout_bytes);
    let port_str = stdout_str.trim();
    let port = port_str.parse::<u16>().map_err(|_| {
        MediaError::InvalidData(format!(
            "Invalid allocated port from adb forward tcp:0: '{}'",
            stdout_str
        ))
    })?;

    if port == 0 {
        return Err(MediaError::InvalidData(
            "Allocated port was 0 from adb forward".to_string(),
        ));
    }

    Ok(port)
}

/// Set up ADB forward rule for explicit port
pub async fn adb_forward(
    adb_path: &Path,
    device_id: &str,
    local_port: u16,
    remote_abstract_socket: &str,
) -> Result<(), MediaError> {
    if device_id.trim().is_empty() {
        return Err(MediaError::BadRequest(
            "deviceId cannot be empty".to_string(),
        ));
    }

    let fut = async {
        let mut child = Command::new(adb_path)
            .args([
                "-s",
                device_id,
                "forward",
                &format!("tcp:{}", local_port),
                &format!("localabstract:{}", remote_abstract_socket),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MediaError::Internal(format!("Failed to execute adb forward: {}", e)))?;

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = stdout.take(4096).read_to_end(&mut out).await;
        let _ = stderr.take(4096).read_to_end(&mut err).await;
        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, err))
    };

    let (status, stderr_bytes) = tokio::time::timeout(Duration::from_secs(10), fut)
        .await
        .map_err(|_| MediaError::Timeout("Timed out establishing adb forward".to_string()))??;

    if !status.success() {
        let stderr = String::from_utf8_lossy(&stderr_bytes).to_string();
        return Err(MediaError::CommandFailed {
            code: status.code(),
            stderr,
        });
    }
    Ok(())
}

/// Remove ADB forward rule
pub async fn adb_remove_forward(
    adb_path: &Path,
    device_id: &str,
    local_port: u16,
) -> Result<(), MediaError> {
    if device_id.trim().is_empty() {
        return Err(MediaError::BadRequest(
            "deviceId cannot be empty".to_string(),
        ));
    }

    let fut = async {
        let mut child = Command::new(adb_path)
            .args([
                "-s",
                device_id,
                "forward",
                "--remove",
                &format!("tcp:{}", local_port),
            ])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| {
                MediaError::Internal(format!("Failed to execute adb forward --remove: {}", e))
            })?;

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = stdout.take(4096).read_to_end(&mut out).await;
        let _ = stderr.take(4096).read_to_end(&mut err).await;
        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, err))
    };

    match tokio::time::timeout(Duration::from_secs(5), fut).await {
        Ok(Ok((status, err))) => {
            if !status.success() {
                warn!(
                    "Failed to remove adb forward tcp:{}: {}",
                    local_port,
                    String::from_utf8_lossy(&err)
                );
            }
        }
        Ok(Err(e)) => warn!("Error removing adb forward tcp:{}: {}", local_port, e),
        Err(_) => warn!("Timed out removing adb forward tcp:{}", local_port),
    }
    Ok(())
}

/// Query ADB version
pub async fn adb_version(adb_path: &Path) -> Result<String, MediaError> {
    let fut = async {
        let mut child = Command::new(adb_path)
            .arg("version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| MediaError::Internal(format!("Failed to get adb version: {}", e)))?;

        let stdout = child.stdout.take().expect("stdout");
        let stderr = child.stderr.take().expect("stderr");

        let mut out = Vec::new();
        let mut err = Vec::new();
        let _ = stdout.take(8192).read_to_end(&mut out).await;
        let _ = stderr.take(8192).read_to_end(&mut err).await;
        let status = child
            .wait()
            .await
            .map_err(|e| MediaError::Internal(e.to_string()))?;
        Ok::<_, MediaError>((status, out, err))
    };

    let (status, out, err) = tokio::time::timeout(Duration::from_secs(5), fut)
        .await
        .map_err(|_| MediaError::Timeout("Timed out querying adb version".to_string()))??;

    if !status.success() {
        return Err(MediaError::CommandFailed {
            code: status.code(),
            stderr: String::from_utf8_lossy(&err).to_string(),
        });
    }

    Ok(String::from_utf8_lossy(&out).trim().to_string())
}
