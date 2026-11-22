use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::error::ApiResult;
use crate::models::{
    CreateShellRequest, CreateShellResponse, ShellInputMessage, ShellOutputMessage,
};

#[derive(Clone)]
pub struct ShellSessionConfig {
    pub id: String,
    pub device_id: String,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone)]
pub struct ShellManager {
    adb_path: PathBuf,
    pending_sessions: Arc<Mutex<HashMap<String, ShellSessionConfig>>>,
}

impl ShellManager {
    pub fn new(adb_path: PathBuf) -> Self {
        Self {
            adb_path,
            pending_sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn create_session(&self, req: CreateShellRequest) -> ApiResult<CreateShellResponse> {
        if req.device_id.trim().is_empty() {
            return Err(crate::error::ApiError::bad_request(
                "DEVICE_REQUIRED",
                "Select a device",
            ));
        }
        if self.pending_sessions.lock().unwrap().len() >= 128 {
            return Err(crate::error::ApiError::bad_request(
                "SESSION_LIMIT",
                "Too many pending shell sessions",
            ));
        }
        let id = Uuid::new_v4().to_string();
        let config = ShellSessionConfig {
            id: id.clone(),
            device_id: req.device_id,
            cols: req.cols.unwrap_or(80),
            rows: req.rows.unwrap_or(24),
        };

        let mut sessions = self.pending_sessions.lock().unwrap();
        sessions.insert(id.clone(), config);

        Ok(CreateShellResponse { id })
    }

    pub fn take_session(&self, id: &str) -> Option<ShellSessionConfig> {
        let mut sessions = self.pending_sessions.lock().unwrap();
        sessions.remove(id)
    }

    pub async fn handle_websocket(&self, id: String, mut socket: WebSocket) {
        let config = match self.take_session(&id) {
            Some(cfg) => cfg,
            None => {
                let err_msg = ShellOutputMessage::Error {
                    data: serde_json::json!("Shell session not found or already attached"),
                };
                if let Ok(text) = serde_json::to_string(&err_msg) {
                    let _ = socket.send(Message::Text(text.into())).await;
                }
                let _ = socket.close().await;
                return;
            }
        };

        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::{Read, Write};
        let setup = (|| -> Result<_, String> {
            let pair = native_pty_system()
                .openpty(PtySize {
                    rows: config.rows.max(1),
                    cols: config.cols.max(1),
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            let mut cmd = CommandBuilder::new(&self.adb_path);
            cmd.args(["-s", &config.device_id, "shell", "-t"]);
            cmd.env("TERM", "xterm-256color");
            let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
            let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
            let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
            drop(pair.slave);
            Ok((pair.master, reader, writer, child))
        })();
        let (master, mut reader, mut writer, mut child) = match setup {
            Ok(parts) => parts,
            Err(error) => {
                let _ = socket
                    .send(Message::Text(
                        serde_json::json!({"type":"error","data":error})
                            .to_string()
                            .into(),
                    ))
                    .await;
                return;
            }
        };
        let (output_tx, mut output_rx) = mpsc::channel::<String>(32);
        let (input_tx, mut input_rx) = mpsc::channel::<ShellInputMessage>(32);
        let read_task = tokio::task::spawn_blocking(move || {
            let mut buffer = [0u8; 8192];
            let mut pending = Vec::new();
            loop {
                let n = match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                pending.extend_from_slice(&buffer[..n]);
                // Keep incomplete UTF-8 codepoints for the next PTY chunk.
                let keep = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) if e.error_len().is_none() => e.valid_up_to(),
                    Err(_) => pending.len(),
                };
                let text = String::from_utf8_lossy(&pending[..keep]).into_owned();
                pending.drain(..keep);
                if !text.is_empty() && output_tx.blocking_send(text).is_err() {
                    return;
                }
            }
            if !pending.is_empty() {
                let _ = output_tx.blocking_send(String::from_utf8_lossy(&pending).into_owned());
            }
        });
        let write_task = tokio::task::spawn_blocking(move || {
            while let Some(input) = input_rx.blocking_recv() {
                match input {
                    ShellInputMessage::Input { data } => {
                        if writer
                            .write_all(data.as_bytes())
                            .and_then(|_| writer.flush())
                            .is_err()
                        {
                            break;
                        }
                    }
                    ShellInputMessage::Resize { cols, rows } => {
                        let _ = master.resize(PtySize {
                            cols: cols.max(1),
                            rows: rows.max(1),
                            pixel_width: 0,
                            pixel_height: 0,
                        });
                    }
                    ShellInputMessage::Close => break,
                }
            }
        });
        let mut poll = tokio::time::interval(std::time::Duration::from_millis(50));
        loop {
            tokio::select! {
                out = output_rx.recv() => {
                    match out {
                        Some(text) => { if socket.send(Message::Text(serde_json::json!({"type":"stdout", "data":text}).to_string().into())).await.is_err() { break; } }
                        None => { let status = child.wait().ok().map(|s| s.exit_code() as i32).unwrap_or(-1); let _ = socket.send(Message::Text(serde_json::json!({"type":"exit", "data":status}).to_string().into())).await; break; }
                    }
                }
                message = socket.next() => {
                    match message {
                        Some(Ok(Message::Text(text))) => {
                            if let Ok(input) = serde_json::from_str::<ShellInputMessage>(&text) {
                                if matches!(input, ShellInputMessage::Close) { break; }
                                if input_tx.send(input).await.is_err() { break; }
                            }
                        }
                        Some(Ok(Message::Ping(data))) => { let _ = socket.send(Message::Pong(data)).await; }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    }
                }
                _ = poll.tick() => { if let Ok(Some(status)) = child.try_wait() {
                    // Drain queued output before reporting the exit.
                    while let Ok(text) = output_rx.try_recv() { let _ = socket.send(Message::Text(serde_json::json!({"type":"stdout", "data":text}).to_string().into())).await; }
                    let _ = socket.send(Message::Text(serde_json::json!({"type":"exit", "data":status.exit_code()}).to_string().into())).await;
                    break;
                } }
            }
        }
        let _ = child.kill();
        drop(input_tx);
        drop(output_rx);
        let _ = socket.close().await;
        // Closing the child/slave and the bounded input channel releases both workers.
        let _ = tokio::time::timeout(std::time::Duration::from_secs(2), async {
            let _ = tokio::join!(read_task, write_task);
        })
        .await;
    }
}
