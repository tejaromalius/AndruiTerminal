use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};
use tokio_util::sync::CancellationToken;

use crate::error::{ApiError, ApiResult};

#[derive(Debug, Clone)]
pub struct AdbExecutor {
    adb_path: PathBuf,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExecutionOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BinaryOutput {
    pub stdout: Vec<u8>,
    pub stderr: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone)]
pub enum OutputChunk {
    Stdout(String),
    Stderr(String),
}

impl AdbExecutor {
    pub fn new(adb_path: impl AsRef<Path>) -> Self {
        Self {
            adb_path: adb_path.as_ref().to_path_buf(),
        }
    }

    pub fn adb_path(&self) -> &Path {
        &self.adb_path
    }

    pub fn set_adb_path(&mut self, adb_path: impl AsRef<Path>) {
        self.adb_path = adb_path.as_ref().to_path_buf();
    }

    /// Query the adb version output
    pub async fn get_version(&self) -> ApiResult<String> {
        let output = self.execute(&["version".to_string()], None, None).await?;
        if output.exit_code != 0 {
            return Err(ApiError::internal(
                "ADB_VERSION_FAILED",
                format!("Failed to query adb version: {}", output.stderr),
            ));
        }

        // e.g. "Android Debug Bridge version 1.0.41\nVersion 34.0.4-debian\n..."
        let version_line = output
            .stdout
            .lines()
            .find(|line| line.starts_with("Version "))
            .unwrap_or_else(|| output.stdout.lines().next().unwrap_or("unknown"));

        Ok(version_line.trim().to_string())
    }

    /// Execute an ADB command with arguments, collecting all stdout and stderr
    pub async fn execute(
        &self,
        args: &[String],
        timeout: Option<Duration>,
        cancel_token: Option<CancellationToken>,
    ) -> ApiResult<ExecutionOutput> {
        use std::sync::{Arc, Mutex};
        let stdout = Arc::new(Mutex::new(String::new()));
        let stderr = Arc::new(Mutex::new(String::new()));
        let out = stdout.clone();
        let err = stderr.clone();
        let exit_code = self
            .execute_streaming(
                args,
                timeout,
                cancel_token,
                move |s| out.lock().unwrap().push_str(&s),
                move |s| err.lock().unwrap().push_str(&s),
            )
            .await?;
        let stdout = stdout.lock().unwrap().clone();
        let stderr = stderr.lock().unwrap().clone();
        Ok(ExecutionOutput {
            stdout,
            stderr,
            exit_code,
        })
    }

    /// Execute an ADB command collecting raw stdout bytes (bounded by `max_bytes`),
    /// optionally writing `stdin` to the process (for `exec-in`).
    pub async fn execute_bytes(
        &self,
        args: &[String],
        stdin: Option<Vec<u8>>,
        timeout: Duration,
        max_bytes: usize,
    ) -> ApiResult<BinaryOutput> {
        use tokio::io::AsyncWriteExt;
        let mut cmd = Command::new(&self.adb_path);
        cmd.args(args)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            });
        let mut child = cmd.spawn().map_err(|e| {
            ApiError::internal(
                "PROCESS_SPAWN_FAILED",
                format!("Failed to spawn {:?}: {}", self.adb_path, e),
            )
        })?;
        let input = child.stdin.take();
        let mut stdout = child.stdout.take().expect("stdout piped");
        let mut stderr = child.stderr.take().expect("stderr piped");
        let run = async {
            let write = async {
                if let (Some(mut pipe), Some(data)) = (input, stdin) {
                    pipe.write_all(&data).await?;
                    pipe.shutdown().await?;
                }
                Ok::<_, std::io::Error>(())
            };
            let read_out = async {
                let mut out = Vec::new();
                let mut buf = [0u8; 65536];
                loop {
                    let n = stdout.read(&mut buf).await?;
                    if n == 0 {
                        return Ok(out);
                    }
                    if out.len() + n > max_bytes {
                        return Err(std::io::Error::other(format!(
                            "Output exceeded {max_bytes} bytes"
                        )));
                    }
                    out.extend_from_slice(&buf[..n]);
                }
            };
            let read_err = async {
                let mut err = Vec::new();
                stderr.read_to_end(&mut err).await?;
                Ok::<_, std::io::Error>(err)
            };
            let (w, out, err) = tokio::join!(write, read_out, read_err);
            w?;
            let status = child.wait().await?;
            Ok::<_, std::io::Error>((out?, err?, status))
        };
        let (stdout, stderr, status) = tokio::time::timeout(timeout, run)
            .await
            .map_err(|_| ApiError::internal("ADB_TIMEOUT", "Command timed out"))?
            .map_err(|e| ApiError::internal("OUTPUT_READ_FAILED", e.to_string()))?;
        Ok(BinaryOutput {
            stdout,
            stderr: String::from_utf8_lossy(&stderr).into_owned(),
            exit_code: status.code().unwrap_or(-1),
        })
    }

    /// Read at most `max_bytes` of stdout from a command, then stop and kill it.
    /// Used to sample a file header without transferring the whole file.
    pub async fn execute_prefix(
        &self,
        args: &[String],
        max_bytes: usize,
        timeout: Duration,
    ) -> ApiResult<Vec<u8>> {
        let mut cmd = Command::new(&self.adb_path);
        cmd.args(args)
            .kill_on_drop(true)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .stdin(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| {
            ApiError::internal("PROCESS_SPAWN_FAILED", format!("Failed to spawn adb: {e}"))
        })?;
        let mut stdout = child.stdout.take().expect("stdout piped");
        let read = async {
            let mut out = Vec::with_capacity(max_bytes);
            let mut buf = [0u8; 4096];
            while out.len() < max_bytes {
                let n = stdout
                    .read(&mut buf)
                    .await
                    .map_err(|e| ApiError::internal("OUTPUT_READ_FAILED", e.to_string()))?;
                if n == 0 {
                    break;
                }
                out.extend_from_slice(&buf[..n]);
            }
            out.truncate(max_bytes);
            Ok::<_, ApiError>(out)
        };
        let out = tokio::time::timeout(timeout, read)
            .await
            .map_err(|_| ApiError::internal("ADB_TIMEOUT", "Command timed out"))??;
        let _ = child.start_kill();
        Ok(out)
    }

    /// Execute an ADB command with arguments, streaming lines to stdout/stderr callbacks
    pub async fn execute_streaming<FOut, FErr>(
        &self,
        args: &[String],
        timeout: Option<Duration>,
        cancel_token: Option<CancellationToken>,
        on_stdout: FOut,
        on_stderr: FErr,
    ) -> ApiResult<i32>
    where
        FOut: Fn(String) + Send + Sync + 'static,
        FErr: Fn(String) + Send + Sync + 'static,
    {
        self.execute_streaming_program(
            &self.adb_path.to_string_lossy(),
            args,
            timeout,
            cancel_token,
            on_stdout,
            on_stderr,
        )
        .await
    }

    /// Execute an allowlisted host program (adb or fastboot) with arguments, streaming lines to stdout/stderr callbacks
    pub async fn execute_streaming_program<FOut, FErr>(
        &self,
        program: &str,
        args: &[String],
        timeout: Option<Duration>,
        cancel_token: Option<CancellationToken>,
        on_stdout: FOut,
        on_stderr: FErr,
    ) -> ApiResult<i32>
    where
        FOut: Fn(String) + Send + Sync + 'static,
        FErr: Fn(String) + Send + Sync + 'static,
    {
        let prog = if program == "fastboot" || program.ends_with("/fastboot") {
            let adb_parent = self.adb_path.parent();
            let adjacent_fastboot = adb_parent.map(|p| p.join("fastboot"));
            if let Some(ref adj) = adjacent_fastboot {
                if adj.exists() {
                    adj.clone()
                } else {
                    PathBuf::from("fastboot")
                }
            } else {
                PathBuf::from("fastboot")
            }
        } else {
            self.adb_path.clone()
        };

        let mut cmd = Command::new(&prog);
        cmd.args(args);
        cmd.kill_on_drop(true);
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
        cmd.stdin(Stdio::null());

        // ETXTBSY means exec never started (e.g. a freshly written fixture).
        // Retrying that spawn failure cannot repeat a device operation.
        let mut retries = 0;
        let mut child = loop {
            match cmd.spawn() {
                Ok(child) => break child,
                Err(error) if error.raw_os_error() == Some(26) && retries < 3 => {
                    retries += 1;
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                Err(error) => {
                    return Err(ApiError::internal(
                        "PROCESS_SPAWN_FAILED",
                        format!(
                            "Failed to spawn command {:?} with args {:?}: {}",
                            prog, args, error
                        ),
                    ));
                }
            }
        };

        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        async fn read_stream<R: tokio::io::AsyncRead + Unpin>(
            mut reader: R,
            emit: impl Fn(String),
        ) -> Result<(), String> {
            let mut buffer = [0u8; 8192];
            let mut total = 0usize;
            loop {
                let n = reader.read(&mut buffer).await.map_err(|e| e.to_string())?;
                if n == 0 {
                    return Ok(());
                }
                total += n;
                if total > 16 * 1024 * 1024 {
                    return Err(
                        "Output exceeded 16 MiB; use a bounded command or artifact capture".into(),
                    );
                }
                emit(String::from_utf8_lossy(&buffer[..n]).into_owned());
            }
        }
        let stdout_handle = tokio::spawn(async move {
            if let Some(stdout) = stdout {
                read_stream(stdout, on_stdout).await
            } else {
                Ok(())
            }
        });
        let stderr_handle = tokio::spawn(async move {
            if let Some(stderr) = stderr {
                read_stream(stderr, on_stderr).await
            } else {
                Ok(())
            }
        });

        let timeout_duration = timeout.unwrap_or(Duration::from_secs(3600));

        let exit_status = if let Some(token) = cancel_token {
            tokio::select! {
                status = child.wait() => {
                    status.map_err(|e| ApiError::internal("ADB_WAIT_FAILED", e.to_string()))?
                }
                _ = tokio::time::sleep(timeout_duration) => {
                    let _ = child.kill().await;
                    return Err(ApiError::internal("ADB_TIMEOUT", "Command timed out"));
                }
                _ = token.cancelled() => {
                    let _ = child.kill().await;
                    return Err(ApiError::internal("JOB_CANCELLED", "Command was cancelled"));
                }
            }
        } else {
            tokio::select! {
                status = child.wait() => {
                    status.map_err(|e| ApiError::internal("ADB_WAIT_FAILED", e.to_string()))?
                }
                _ = tokio::time::sleep(timeout_duration) => {
                    let _ = child.kill().await;
                    return Err(ApiError::internal("ADB_TIMEOUT", "Command timed out"));
                }
            }
        };

        let (out, err) = tokio::join!(stdout_handle, stderr_handle);
        out.map_err(|e| ApiError::internal("OUTPUT_READ_FAILED", e.to_string()))?
            .map_err(|e| ApiError::internal("OUTPUT_READ_FAILED", e))?;
        err.map_err(|e| ApiError::internal("OUTPUT_READ_FAILED", e.to_string()))?
            .map_err(|e| ApiError::internal("OUTPUT_READ_FAILED", e))?;
        Ok(exit_status.code().unwrap_or(-1))
    }
}
