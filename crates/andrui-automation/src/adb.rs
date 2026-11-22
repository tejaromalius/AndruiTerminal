use std::path::Path;
use std::process::Stdio;
use std::time::Duration;
use tokio::process::{Child, Command};

use crate::error::ApiError;

pub struct AdbExecutor;

impl AdbExecutor {
    /// Execute a command with bounded execution time, bounded stdout/stderr draining, and kill_on_drop.
    pub async fn run_command_bounded(
        mut cmd: Command,
        timeout: Duration,
        max_stdout: usize,
        max_stderr: usize,
    ) -> Result<std::process::Output, ApiError> {
        cmd.kill_on_drop(true);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());

        let mut child = {
            let mut attempts = 0;
            loop {
                match cmd.spawn() {
                    Ok(c) => break c,
                    Err(e) if e.raw_os_error() == Some(26) && attempts < 10 => {
                        attempts += 1;
                        tokio::time::sleep(Duration::from_millis(10)).await;
                    }
                    Err(e) => {
                        return Err(ApiError::internal(
                            "adb_execution_failed",
                            format!("Failed to spawn ADB command: {}", e),
                        ));
                    }
                }
            }
        };

        let stdout_pipe = child.stdout.take();
        let stderr_pipe = child.stderr.take();

        let stdout_fut = async move {
            let mut buf = Vec::new();
            if let Some(mut stream) = stdout_pipe {
                use tokio::io::AsyncReadExt;
                let mut reader = (&mut stream).take(max_stdout as u64);
                let _ = reader.read_to_end(&mut buf).await;
                let mut sink = tokio::io::sink();
                let _ = tokio::io::copy(&mut stream, &mut sink).await;
            }
            buf
        };

        let stderr_fut = async move {
            let mut buf = Vec::new();
            if let Some(mut stream) = stderr_pipe {
                use tokio::io::AsyncReadExt;
                let mut reader = (&mut stream).take(max_stderr as u64);
                let _ = reader.read_to_end(&mut buf).await;
                let mut sink = tokio::io::sink();
                let _ = tokio::io::copy(&mut stream, &mut sink).await;
            }
            buf
        };

        let wait_fut = async {
            let (stdout_res, stderr_res, status_res) =
                tokio::join!(stdout_fut, stderr_fut, child.wait());
            let status = status_res.map_err(|e| {
                ApiError::internal(
                    "adb_wait_failed",
                    format!("Failed to wait for ADB command: {}", e),
                )
            })?;
            Ok::<_, ApiError>(std::process::Output {
                status,
                stdout: stdout_res,
                stderr: stderr_res,
            })
        };

        match tokio::time::timeout(timeout, wait_fut).await {
            Ok(res) => res,
            Err(_) => {
                let _ = child.kill().await;
                Err(ApiError::timeout(
                    "adb_timeout",
                    format!("ADB command timed out after {:?}", timeout),
                ))
            }
        }
    }

    /// Safely execute an ADB command with arguments array without using a shell.
    /// Bound to 10 seconds timeout and 1MB stdout/stderr limits by default.
    pub async fn run_adb(adb_path: &Path, args: &[&str]) -> Result<String, ApiError> {
        Self::run_adb_with_timeout(adb_path, args, Duration::from_secs(10), 1024 * 1024).await
    }

    /// Safely execute an ADB command with explicit timeout and stdout bound.
    pub async fn run_adb_with_timeout(
        adb_path: &Path,
        args: &[&str],
        timeout: Duration,
        max_stdout: usize,
    ) -> Result<String, ApiError> {
        let mut cmd = Command::new(adb_path);
        cmd.args(args);
        let output = Self::run_command_bounded(cmd, timeout, max_stdout, 1024 * 1024).await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ApiError::bad_request(
                "adb_command_failed",
                format!(
                    "adb command failed (status: {}): {}",
                    output.status,
                    stderr.trim()
                ),
            ));
        }

        Ok(String::from_utf8_lossy(&output.stdout).to_string())
    }

    /// Install helper APK on the specified device using `adb -s <device_id> install -r -t <apk_path>`.
    /// Timeout bounded to 120 seconds.
    pub async fn install_helper_apk(
        adb_path: &Path,
        device_id: &str,
        apk_path: &Path,
    ) -> Result<(), ApiError> {
        if !apk_path.exists() {
            return Err(ApiError::service_unavailable(
                "helper_apk_missing",
                format!("Helper APK not found at {:?}", apk_path),
            ));
        }

        let apk_str = apk_path.to_str().ok_or_else(|| {
            ApiError::bad_request("invalid_path", "Helper APK path contains invalid UTF-8")
        })?;

        let mut cmd = Command::new(adb_path);
        // Manifest is testOnly=true so adb install requires -t
        cmd.args(["-s", device_id, "install", "-r", "-t", apk_str]);

        let output =
            Self::run_command_bounded(cmd, Duration::from_secs(120), 1024 * 1024, 1024 * 1024)
                .await
                .map_err(|e| {
                    if let ApiError::Timeout { .. } = e {
                        e
                    } else {
                        ApiError::internal(
                            "adb_install_failed",
                            format!("Failed to invoke adb install: {}", e),
                        )
                    }
                })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() || stdout.contains("Failure") || stderr.contains("Failure") {
            let msg = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else {
                stdout.trim().to_string()
            };
            return Err(ApiError::bad_request(
                "helper_install_failed",
                format!(
                    "Helper APK installation failed on device {}: {}",
                    device_id, msg
                ),
            ));
        }

        Ok(())
    }

    /// Uninstall helper APK from the specified device using `adb -s <device_id> uninstall <package>`.
    /// Timeout bounded to 60 seconds.
    pub async fn uninstall_helper_apk(adb_path: &Path, device_id: &str) -> Result<(), ApiError> {
        let mut cmd = Command::new(adb_path);
        cmd.args(["-s", device_id, "uninstall", crate::helper::HELPER_PACKAGE]);

        let output =
            Self::run_command_bounded(cmd, Duration::from_secs(60), 1024 * 1024, 1024 * 1024)
                .await
                .map_err(|e| {
                    if let ApiError::Timeout { .. } = e {
                        e
                    } else {
                        ApiError::internal(
                            "adb_uninstall_failed",
                            format!("Failed to invoke adb uninstall: {}", e),
                        )
                    }
                })?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        if !output.status.success() && !stdout.contains("Success") {
            let msg = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else {
                stdout.trim().to_string()
            };
            return Err(ApiError::bad_request(
                "helper_uninstall_failed",
                format!(
                    "Helper APK uninstallation failed on device {}: {}",
                    device_id, msg
                ),
            ));
        }

        Ok(())
    }

    /// Establish ADB forward tcp:0 -> tcp:<device_port>.
    /// Bounded to 10 seconds timeout. Must return a valid port, failing clearly otherwise (no unowned port rebind fallback).
    pub async fn forward_port(
        adb_path: &Path,
        device_id: &str,
        device_port: u16,
    ) -> Result<u16, ApiError> {
        let dev_target = format!("tcp:{}", device_port);
        let mut cmd = Command::new(adb_path);
        cmd.args(["-s", device_id, "forward", "tcp:0", &dev_target]);

        let output =
            Self::run_command_bounded(cmd, Duration::from_secs(10), 64 * 1024, 64 * 1024).await?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            return Err(ApiError::bad_request(
                "adb_forward_failed",
                format!(
                    "Failed to forward port for device '{}': {}",
                    device_id,
                    stderr.trim()
                ),
            ));
        }

        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let port = stdout.parse::<u16>().map_err(|_| {
            ApiError::bad_request(
                "adb_forward_invalid_port",
                format!(
                    "ADB forward tcp:0 did not return a valid port, got '{}'",
                    stdout
                ),
            )
        })?;

        if port == 0 {
            return Err(ApiError::bad_request(
                "adb_forward_invalid_port",
                "ADB forward tcp:0 returned port 0",
            ));
        }

        Ok(port)
    }

    /// Remove ADB forward tcp:<host_port>.
    /// Bounded to 10 seconds timeout.
    pub async fn remove_forward(
        adb_path: &Path,
        device_id: &str,
        host_port: u16,
    ) -> Result<(), ApiError> {
        let target = format!("tcp:{}", host_port);
        let _ = Self::run_adb_with_timeout(
            adb_path,
            &["-s", device_id, "forward", "--remove", &target],
            Duration::from_secs(10),
            64 * 1024,
        )
        .await;
        Ok(())
    }

    /// Spawn instrumentation process in background with kill_on_drop and null stderr to avoid pipe deadlocks.
    pub fn spawn_instrumentation(
        adb_path: &Path,
        device_id: &str,
        port: u16,
        token: &str,
    ) -> Result<Child, ApiError> {
        let port_str = port.to_string();
        let mut cmd = Command::new(adb_path);
        cmd.kill_on_drop(true);
        cmd.args([
            "-s",
            device_id,
            "shell",
            "am",
            "instrument",
            "-w",
            "-e",
            "port",
            &port_str,
            "-e",
            "token",
            token,
            "io.andrui.terminal.helper/.AutomationInstrumentation",
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| {
            ApiError::internal(
                "instrumentation_spawn_failed",
                format!("Failed to spawn am instrument: {}", e),
            )
        })
    }

    /// Dump UI hierarchy via `adb uiautomator dump` as snapshot-only fallback.
    /// Bounded to 30 seconds timeout and 16MB bounded stdout drain.
    pub async fn dump_hierarchy_fallback(
        adb_path: &Path,
        device_id: &str,
    ) -> Result<String, ApiError> {
        let timeout = Duration::from_secs(30);
        let max_xml_size = 16 * 1024 * 1024;

        // Try direct exec-out dump /dev/tty
        let mut direct_cmd = Command::new(adb_path);
        direct_cmd.args([
            "-s",
            device_id,
            "exec-out",
            "uiautomator",
            "dump",
            "/dev/tty",
        ]);

        let direct_out =
            Self::run_command_bounded(direct_cmd, timeout, max_xml_size, 1024 * 1024).await;

        if let Ok(out) = direct_out {
            if out.status.success() {
                let content = String::from_utf8_lossy(&out.stdout).to_string();
                if content.contains("<hierarchy") {
                    return Ok(content);
                }
            }
        }

        // File-based fallback dump
        let tmp_xml = "/data/local/tmp/window_dump.xml";
        let _ = Self::run_adb_with_timeout(
            adb_path,
            &["-s", device_id, "shell", "uiautomator", "dump", tmp_xml],
            timeout,
            1024 * 1024,
        )
        .await?;

        let dump = Self::run_adb_with_timeout(
            adb_path,
            &["-s", device_id, "exec-out", "cat", tmp_xml],
            timeout,
            max_xml_size,
        )
        .await?;

        // Cleanup tmp file (10 seconds timeout)
        let _ = Self::run_adb_with_timeout(
            adb_path,
            &["-s", device_id, "shell", "rm", "-f", tmp_xml],
            Duration::from_secs(10),
            64 * 1024,
        )
        .await;

        if !dump.contains("<hierarchy") {
            return Err(ApiError::bad_request(
                "uiautomator_dump_empty",
                "uiautomator dump did not produce valid hierarchy XML",
            ));
        }

        Ok(dump)
    }
}
