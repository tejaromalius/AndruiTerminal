use crate::{
    adb::{adb_forward_tcp0, adb_push, adb_remove_forward},
    config::MediaConfig,
    error::MediaError,
    protocol::{VideoCodec, SCRCPY_VERSION},
};
use bytes::Bytes;
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpStream,
    process::{Child, Command},
    sync::{mpsc, RwLock},
    task::AbortHandle,
};
use tracing::{debug, info, warn};

const VIDEO_CHANNEL_CAPACITY: usize = 512;
const AUDIO_CHANNEL_CAPACITY: usize = 512;
const CONTROL_CHANNEL_CAPACITY: usize = 64;
const CONNECT_TIMEOUT: Duration = Duration::from_secs(6);
const SESSION_ATTACH_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionRequest {
    pub device_id: String,
    pub video_codec: Option<String>,
    pub audio: Option<bool>,
    pub max_size: Option<u32>,
    pub bit_rate: Option<u32>,
    pub max_fps: Option<u32>,
    pub display_id: Option<u32>,
    pub stay_awake: Option<bool>,
    pub tunnel_forward: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCapabilities {
    pub video_codec: String,
    pub audio: bool,
    pub max_size: u32,
    pub bit_rate: u32,
    pub max_fps: u32,
    pub display_id: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSessionResponse {
    pub id: String,
    pub video_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub audio_url: Option<String>,
    pub control_url: String,
    pub capabilities: SessionCapabilities,
}

pub struct ScreenSession {
    pub id: String,
    pub device_id: String,
    pub forward_port: u16,
    pub scid: u32,
    pub capabilities: SessionCapabilities,
    pub video_rx: tokio::sync::Mutex<Option<mpsc::Receiver<Bytes>>>,
    pub audio_rx: Option<tokio::sync::Mutex<Option<mpsc::Receiver<Bytes>>>>,
    pub control_tx: mpsc::Sender<Bytes>,
    pub control_rx: tokio::sync::Mutex<Option<mpsc::Receiver<Bytes>>>,
    pub child_process: Arc<tokio::sync::Mutex<Option<Child>>>,
    pub adb_path: PathBuf,
    pub abort_handles: tokio::sync::Mutex<Vec<AbortHandle>>,
    pub is_stopped: AtomicBool,
}

impl ScreenSession {
    pub async fn stop(&self) {
        if self.is_stopped.swap(true, Ordering::SeqCst) {
            return;
        }
        info!("Stopping session {} for device {}", self.id, self.device_id);

        // Abort stream tasks / pumps
        let mut handles = self.abort_handles.lock().await;
        for handle in handles.drain(..) {
            handle.abort();
        }

        // Kill child process if still alive
        let mut child_guard = self.child_process.lock().await;
        if let Some(mut child) = child_guard.take() {
            let _ = child.kill().await;
        }

        // Remove forward rule
        let _ = adb_remove_forward(&self.adb_path, &self.device_id, self.forward_port).await;
    }
}

pub type SessionStore = Arc<RwLock<HashMap<String, Arc<ScreenSession>>>>;

pub fn create_session_store() -> SessionStore {
    Arc::new(RwLock::new(HashMap::new()))
}

/// Connects to a socket with retries (waiting for scrcpy-server on Android to start listening)
async fn connect_with_retry(port: u16, timeout: Duration) -> Result<TcpStream, MediaError> {
    let start = tokio::time::Instant::now();
    loop {
        match TcpStream::connect(("127.0.0.1", port)).await {
            Ok(stream) => return Ok(stream),
            Err(e) => {
                if start.elapsed() >= timeout {
                    return Err(MediaError::Timeout(format!(
                        "Timed out waiting for scrcpy server socket on 127.0.0.1:{}: {}",
                        port, e
                    )));
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        }
    }
}

/// Connects the video socket and reads the 0x00 dummy byte, retrying both together.
/// adb forward accepts the TCP connection even before scrcpy-server listens on the
/// device, then closes it; an EOF here means "not ready yet", so reconnect.
async fn connect_and_read_dummy_byte(
    port: u16,
    timeout: Duration,
) -> Result<TcpStream, MediaError> {
    let start = tokio::time::Instant::now();
    loop {
        if let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)).await {
            let mut dummy_buf = [0u8; 1];
            match tokio::time::timeout(Duration::from_secs(5), stream.read_exact(&mut dummy_buf))
                .await
            {
                Ok(Ok(_)) if dummy_buf[0] == 0 => {
                    debug!("Scrcpy dummy byte verified: 0x00");
                    return Ok(stream);
                }
                Ok(Ok(_)) => {
                    return Err(MediaError::Internal(format!(
                        "Invalid scrcpy dummy byte: expected 0x00, got 0x{:02x}",
                        dummy_buf[0]
                    )))
                }
                Ok(Err(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::UnexpectedEof | std::io::ErrorKind::ConnectionReset
                    ) => {}
                Ok(Err(e)) => {
                    return Err(MediaError::Internal(format!(
                        "Failed to read dummy byte from scrcpy-server: {}",
                        e
                    )))
                }
                Err(_) => {
                    return Err(MediaError::Timeout(
                        "Timed out waiting for scrcpy dummy byte".to_string(),
                    ))
                }
            }
        }
        if start.elapsed() >= timeout {
            return Err(MediaError::Timeout(
                "scrcpy-server did not accept the video socket in time (it may have exited on the device)".to_string(),
            ));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Launch a new scrcpy session for the target device
pub async fn start_session(
    config: &MediaConfig,
    sessions: &SessionStore,
    req: CreateSessionRequest,
) -> Result<CreateSessionResponse, MediaError> {
    // Preserve opaque device ID without trimming value
    if req.device_id.trim().is_empty() {
        return Err(MediaError::BadRequest(
            "deviceId cannot be empty".to_string(),
        ));
    }
    let device_id = req.device_id;

    // 1. Locate and validate pinned scrcpy-server 3.3.1 jar matches pinned SHA-256
    let server_path = config.find_scrcpy_server().ok_or_else(|| {
        MediaError::ScrcpyServerNotFound(
            "scrcpy-server 3.3.1 jar matching pinned SHA-256 was not found in data_dir, assets, or config.".to_string(),
        )
    })?;

    // 2. Validate video codec
    let video_codec_str = req.video_codec.as_deref().unwrap_or("h264").to_lowercase();
    let video_codec = match video_codec_str.as_str() {
        "h264" => VideoCodec::H264,
        "h265" => VideoCodec::H265,
        "av1" => VideoCodec::Av1,
        other => {
            return Err(MediaError::BadRequest(format!(
                "Unsupported video codec '{}'. Supported: h264, h265, av1",
                other
            )))
        }
    };

    let audio_enabled = req.audio.unwrap_or(false);
    let max_size = req.max_size.unwrap_or(0);
    let bit_rate = req.bit_rate.unwrap_or(8_000_000);
    let max_fps = req.max_fps.unwrap_or(60);
    let display_id = req.display_id.unwrap_or(0);

    // 3. Generate session ID and scid (31-bit random integer formatted as 8 hex digits)
    let session_id = uuid::Uuid::new_v4().to_string();
    let scid: u32 = rand::thread_rng().gen::<u32>() & 0x7FFFFFFF;
    let scid_hex = format!("{:08x}", scid);
    let abstract_socket_name = format!("scrcpy_{}", scid_hex);

    // 4. Allocate dynamic host forward port via adb forward tcp:0 and parse allocated port
    let forward_port =
        match adb_forward_tcp0(&config.adb_path, &device_id, &abstract_socket_name).await {
            Ok(port) => port,
            Err(e) => return Err(e),
        };

    // 5. Push scrcpy-server jar to device (cleanup forward on failure)
    if let Err(e) = adb_push(
        &config.adb_path,
        &device_id,
        &server_path,
        "/data/local/tmp/scrcpy-server.jar",
    )
    .await
    {
        let _ = adb_remove_forward(&config.adb_path, &device_id, forward_port).await;
        return Err(e);
    }

    // 6. Spawn scrcpy server on device via app_process with kill_on_drop and drained output pipes
    let scid_arg = format!("scid={}", scid_hex);
    let video_codec_arg = format!("video_codec={}", video_codec.as_str());
    let audio_arg = format!("audio={}", audio_enabled);
    let max_size_arg = format!("max_size={}", max_size);
    let bit_rate_arg = format!("video_bit_rate={}", bit_rate);
    let max_fps_arg = format!("max_fps={}", max_fps);
    let display_id_arg = format!("display_id={}", display_id);

    let mut cmd_args: Vec<&str> = vec![
        "-s",
        &device_id,
        "shell",
        "CLASSPATH=/data/local/tmp/scrcpy-server.jar",
        "app_process",
        "/",
        "com.genymobile.scrcpy.Server",
        SCRCPY_VERSION,
        &scid_arg,
        "tunnel_forward=true",
        "control=true",
        "cleanup=true",
        &video_codec_arg,
        &audio_arg,
        &max_size_arg,
        &bit_rate_arg,
        &max_fps_arg,
        &display_id_arg,
    ];

    if req.stay_awake.unwrap_or(false) {
        cmd_args.push("stay_awake=true");
    }

    let mut child = match Command::new(&config.adb_path)
        .args(&cmd_args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => {
            let _ = adb_remove_forward(&config.adb_path, &device_id, forward_port).await;
            return Err(MediaError::Internal(format!(
                "Failed to spawn scrcpy-server process: {}",
                e
            )));
        }
    };

    // Drain child stdout and stderr in background tasks to prevent pipe deadlock
    let mut child_stdout = child.stdout.take().expect("stdout piped");
    let mut child_stderr = child.stderr.take().expect("stderr piped");
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        while let Ok(n) = child_stdout.read(&mut buf).await {
            if n == 0 {
                break;
            }
        }
    });
    tokio::spawn(async move {
        let mut buf = [0u8; 4096];
        while let Ok(n) = child_stderr.read(&mut buf).await {
            if n == 0 {
                break;
            }
        }
    });

    // 7. Handshake sequence matching scrcpy official source:
    // Sockets order:
    // a+b. Connect video socket and read the dummy byte (retried together) before other sockets.
    let mut video_stream = match connect_and_read_dummy_byte(forward_port, CONNECT_TIMEOUT).await {
        Ok(s) => s,
        Err(e) => {
            let _ = child.kill().await;
            let _ = adb_remove_forward(&config.adb_path, &device_id, forward_port).await;
            return Err(e);
        }
    };

    // c. Connect audio socket (if enabled)
    let audio_stream = if audio_enabled {
        match connect_with_retry(forward_port, CONNECT_TIMEOUT).await {
            Ok(s) => Some(s),
            Err(e) => {
                let _ = child.kill().await;
                let _ = adb_remove_forward(&config.adb_path, &device_id, forward_port).await;
                return Err(e);
            }
        }
    } else {
        None
    };

    // d. Connect control socket
    let control_stream = match connect_with_retry(forward_port, CONNECT_TIMEOUT).await {
        Ok(s) => s,
        Err(e) => {
            let _ = child.kill().await;
            let _ = adb_remove_forward(&config.adb_path, &device_id, forward_port).await;
            return Err(e);
        }
    };

    // 8. Setup bounded lossless channels per session
    let (video_tx, video_rx) = mpsc::channel::<Bytes>(VIDEO_CHANNEL_CAPACITY);
    let (audio_tx, audio_rx) = if audio_enabled {
        let (atx, arx) = mpsc::channel::<Bytes>(AUDIO_CHANNEL_CAPACITY);
        (Some(atx), Some(arx))
    } else {
        (None, None)
    };
    let (control_tx, mut control_rx_device) = mpsc::channel::<Bytes>(CONTROL_CHANNEL_CAPACITY);
    let (control_tx_device, control_rx) = mpsc::channel::<Bytes>(CONTROL_CHANNEL_CAPACITY);

    let mut abort_handles = Vec::new();
    let sessions_clone = sessions.clone();
    let session_id_clone = session_id.clone();

    // Video stream pump: reads from video_stream and sends lossless to video_tx
    // Under backpressure / lag: closes session explicitly to prevent bitstream corruption
    let v_sessions = sessions_clone.clone();
    let v_session_id = session_id_clone.clone();
    let video_pump = tokio::spawn(async move {
        let mut buf = vec![0u8; 32768];
        loop {
            match video_stream.read(&mut buf).await {
                Ok(0) => {
                    debug!("Video stream reached EOF");
                    break;
                }
                Ok(n) => {
                    let bytes = Bytes::copy_from_slice(&buf[..n]);
                    match video_tx.try_send(bytes) {
                        Ok(()) => {}
                        Err(mpsc::error::TrySendError::Full(_)) => {
                            warn!(
                                "Video queue lag in session {} - terminating session to prevent corruption",
                                v_session_id
                            );
                            let session = {
                                let mut map = v_sessions.write().await;
                                map.remove(&v_session_id)
                            };
                            if let Some(s) = session {
                                s.stop().await;
                            }
                            break;
                        }
                        Err(mpsc::error::TrySendError::Closed(_)) => {
                            debug!("Video channel closed");
                            break;
                        }
                    }
                }
                Err(e) => {
                    warn!("Error reading from video stream: {}", e);
                    break;
                }
            }
        }
    });
    abort_handles.push(video_pump.abort_handle());

    // Audio stream pump if active
    if let (Some(mut a_stream), Some(a_tx)) = (audio_stream, audio_tx) {
        let a_sessions = sessions_clone.clone();
        let a_session_id = session_id_clone.clone();
        let audio_pump = tokio::spawn(async move {
            let mut buf = vec![0u8; 8192];
            loop {
                match a_stream.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let bytes = Bytes::copy_from_slice(&buf[..n]);
                        match a_tx.try_send(bytes) {
                            Ok(()) => {}
                            Err(mpsc::error::TrySendError::Full(_)) => {
                                warn!(
                                    "Audio queue lag in session {} - terminating session",
                                    a_session_id
                                );
                                let session = {
                                    let mut map = a_sessions.write().await;
                                    map.remove(&a_session_id)
                                };
                                if let Some(s) = session {
                                    s.stop().await;
                                }
                                break;
                            }
                            Err(mpsc::error::TrySendError::Closed(_)) => break,
                        }
                    }
                    Err(_) => break,
                }
            }
        });
        abort_handles.push(audio_pump.abort_handle());
    }

    // Control stream pumps (bidirectional)
    let (mut control_reader, mut control_writer) = tokio::io::split(control_stream);

    // Device -> Browser control reader
    let control_read_task = tokio::spawn(async move {
        let mut buf = vec![0u8; 4096];
        loop {
            match control_reader.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    let bytes = Bytes::copy_from_slice(&buf[..n]);
                    if control_tx_device.send(bytes).await.is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    abort_handles.push(control_read_task.abort_handle());

    // Browser -> Device control writer
    let control_write_task = tokio::spawn(async move {
        while let Some(msg) = control_rx_device.recv().await {
            if control_writer.write_all(&msg).await.is_err() {
                break;
            }
        }
    });
    abort_handles.push(control_write_task.abort_handle());

    let capabilities = SessionCapabilities {
        video_codec: video_codec.as_str().to_string(),
        audio: audio_enabled,
        max_size,
        bit_rate,
        max_fps,
        display_id,
    };

    let session = Arc::new(ScreenSession {
        id: session_id.clone(),
        device_id,
        forward_port,
        scid,
        capabilities: capabilities.clone(),
        video_rx: tokio::sync::Mutex::new(Some(video_rx)),
        audio_rx: audio_rx.map(|rx| tokio::sync::Mutex::new(Some(rx))),
        control_tx,
        control_rx: tokio::sync::Mutex::new(Some(control_rx)),
        child_process: Arc::new(tokio::sync::Mutex::new(Some(child))),
        adb_path: config.adb_path.clone(),
        abort_handles: tokio::sync::Mutex::new(abort_handles),
        is_stopped: AtomicBool::new(false),
    });

    sessions
        .write()
        .await
        .insert(session_id.clone(), session.clone());

    // Strict session timeout: clean up session if no consumer attaches within timeout
    let timeout_sessions = sessions.clone();
    let timeout_id = session_id.clone();
    let timeout_session = Arc::downgrade(&session);
    tokio::spawn(async move {
        tokio::time::sleep(SESSION_ATTACH_TIMEOUT).await;
        if let Some(s) = timeout_session.upgrade() {
            let rx_guard = s.video_rx.lock().await;
            if rx_guard.is_some() {
                info!(
                    "Session {} timed out waiting for subscriber attach; stopping",
                    timeout_id
                );
                drop(rx_guard);
                let session = {
                    let mut map = timeout_sessions.write().await;
                    map.remove(&timeout_id)
                };
                if let Some(s) = session {
                    s.stop().await;
                }
            }
        }
    });

    let video_url = format!("/api/v1/screen/sessions/{}/video", session_id);
    let audio_url = if audio_enabled {
        Some(format!("/api/v1/screen/sessions/{}/audio", session_id))
    } else {
        None
    };
    let control_url = format!("/api/v1/screen/sessions/{}/control", session_id);

    Ok(CreateSessionResponse {
        id: session_id,
        video_url,
        audio_url,
        control_url,
        capabilities,
    })
}
