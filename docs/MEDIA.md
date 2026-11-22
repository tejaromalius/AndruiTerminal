# Screen & Media Extension Specification (`andrui-media`)

## Overview & Architecture

The `andrui-media` extension provides real-time Android screen mirroring, low-latency pointer/keyboard interaction, high-resolution framebuffer capture, and in-browser display recording for AndruiTerminal.

The extension consists of:
1. **Host Companion Rust Crate (`crates/andrui-media`)**:
   - Axum 0.8 & Tokio standalone service with an isolated `[workspace]`.
   - Exposes public integration API:
     ```rust
     pub struct MediaConfig {
         pub adb_path: PathBuf,
         pub data_dir: PathBuf,
         pub scrcpy_server: Option<PathBuf>,
     }
     pub fn router(config: MediaConfig) -> axum::Router;
     pub fn router_with_state(state: AppState) -> axum::Router;
     pub async fn cleanup_all_sessions(sessions: &SessionStore);
     ```
   - Routes full `/api/v1/screen/...` interfaces.
   - Manages ADB subprocesses with `kill_on_drop`, bounded stdout/stderr draining, dynamic forward port allocation via `adb forward tcp:0`, scrcpy server SHA-256 validation, bounded lossless per-session mpsc streaming, and single-consumer WebSocket attach (HTTP 409 Conflict on duplicate attach).
2. **Frontend Mirroring Client (`web/src/lib/media` & `web/src/pages/ScreenPage.tsx`)**:
   - WebCodecs hardware video decoding and WebGL rendering via `@yume-chan/scrcpy` and `@yume-chan/scrcpy-decoder-webcodecs` with fallback to `BitmapVideoFrameRenderer`.
   - WebCodecs `AudioDecoder` and Web Audio `AudioContext` playback for scrcpy 3.3.1 Opus audio, exposing `recordedAudioTrack` for canvas recording. Explicit unsupported audio detection with disabled options.
   - Pinned scrcpy server 3.3.1 protocol compatibility.
   - Bidirectional control protocol (touch, drag, wheel scroll, key events, text entry, clipboard sync, screen power).
   - In-browser display recording via `canvas.captureStream()` and `MediaRecorder` with byte and duration bounding, auto-stop, and URL revocation.
   - Standalone screenshot capture fallback preserving device snapshot capability with static Content-Disposition headers.

---

## API Contract (`/api/v1/screen`)

All JSON routes use `/api/v1/screen`. Success returns the JSON resource directly; errors strictly adhere to the contract schema `{ error: { code: string, message: string, details?: unknown } }`.

### 1. `GET /api/v1/screen/capabilities`
Returns host dependencies, ADB status, and scrcpy server availability.
- **Response**:
  ```json
  {
    "adbAvailable": true,
    "adbVersion": "Android Debug Bridge version 1.0.41 ...",
    "scrcpyServer": {
      "available": true,
      "version": "3.3.1",
      "path": "/path/to/scrcpy-server-v3.3.1"
    },
    "supportedVideoCodecs": ["h264", "h265", "av1"],
    "supportedAudioCodecs": ["opus", "aac", "raw"],
    "maxFpsDefault": 60,
    "defaultVideoBitrate": 8000000
  }
  ```

### 2. `GET /api/v1/screen/capture?deviceId=<id>`
Captures device framebuffer using binary-safe `adb exec-out screencap -p` (with fallback to `shell screencap -p`) and returns a Base64 data URL. Preserves opaque device IDs without trimming.
- **Response**:
  ```json
  {
    "dataUrl": "data:image/png;base64,iVBORw0KGgoAAA..."
  }
  ```

### 3. `GET /api/v1/screen/screenshot?deviceId=<id>`
Returns raw binary PNG bytes directly with `Content-Type: image/png` and static `Content-Disposition: inline; filename="device-screenshot.png"` (preventing header injection or unwrap panics on arbitrary device IDs).
- Bounded execution time (12s timeout) and size limit (max 50MB) with strict PNG magic header validation (`89 50 4E 47 0D 0A 1A 0A`).

### 4. `POST /api/v1/screen/sessions`
Launches a new scrcpy 3.3.1 server on the target device and initializes streaming channels.
- **Request Body**:
  ```json
  {
    "deviceId": "RF8M10ABCDE",
    "videoCodec": "h264",
    "audio": false,
    "maxSize": 1920,
    "bitRate": 8000000,
    "maxFps": 60,
    "displayId": 0,
    "stayAwake": true
  }
  ```
- **Response (201 Created)**:
  ```json
  {
    "id": "e9b5f492-3c87-43c1-a8e0-1768c076f8e2",
    "videoUrl": "/api/v1/screen/sessions/e9b5f492-3c87-43c1-a8e0-1768c076f8e2/video",
    "audioUrl": null,
    "controlUrl": "/api/v1/screen/sessions/e9b5f492-3c87-43c1-a8e0-1768c076f8e2/control",
    "capabilities": {
      "videoCodec": "h264",
      "audio": false,
      "maxSize": 1920,
      "bitRate": 8000000,
      "maxFps": 60,
      "displayId": 0
    }
  }
  ```

### 5. `DELETE /api/v1/screen/sessions/:id`
Closes the specified session, kills the child `app_process` on the Android device, removes the owned ADB forward rule, and closes WebSocket/TCP streams.

### 6. `POST /api/v1/screen/sessions/:id/recordings` & `DELETE /api/v1/screen/sessions/:id/recordings/current`
Returns explicit `501 Not Implemented` with message clarifying that recording is handled directly in-browser using canvas capture stream. Mock server successes are strictly removed.

### 7. WebSocket Endpoints
- `GET /api/v1/screen/sessions/:id/video`:
  Single-consumer attach (HTTP 409 Conflict if already attached). Bounded lossless per-session mpsc preserves metadata across delayed attach and fragmented frames without mid-packet drops. Backpressure lag closes the session explicitly to prevent bitstream corruption. Disconnecting the WebSocket cleans up the session and removes forward rules.
- `GET /api/v1/screen/sessions/:id/audio`:
  Single-consumer attach. Streams raw Opus audio frames when audio is requested and device supports Android 11+ audio capture.
- `GET /api/v1/screen/sessions/:id/control`:
  Single-consumer attach. Bidirectional WebSocket carrying serialized binary scrcpy control messages and device clipboard updates.

---

## Scrcpy Forward-Mode Protocol Sequence & Provenance

1. **Server Jar Provenance & Integrity**:
   - Upstream URL: `https://github.com/Genymobile/scrcpy/releases/download/v3.3.1/scrcpy-server-v3.3.1`
   - Pinned SHA-256: `a0f70b20aa4998fbf658c94118cd6c8dab6abbb0647a3bdab344d70bc1ebcbb8`
   - License: Apache License 2.0 (Copyright (C) 2018-2024 Genymobile, Romain Vimont). See `crates/andrui-media/LICENSE` and `crates/andrui-media/NOTICE`.
   - The server binary is cryptographically verified against the pinned SHA-256 before launch.
2. **Abstract Unix Socket Allocation**:
   Generates a randomized 31-bit integer `scid` formatted as 8 hex digits (`scid_hex`). The Android server creates abstract Unix domain socket `localabstract:scrcpy_<scid_hex>`.
3. **Dynamic Port Forwarding**:
   Executes `adb forward tcp:0 localabstract:scrcpy_<scid_hex>`, parses the allocated TCP port from stdout, and fails on invalid output.
4. **Subprocess Execution**:
   Spawns `app_process` with `kill_on_drop(true)` and drains stdout/stderr in background tasks to avoid kernel pipe buffer deadlocks.
5. **Handshake Ordering Sequence**:
   - Connects Socket 1 (Video).
   - Reads and asserts dummy byte `0x00`.
   - Connects Socket 2 (Audio) if audio is enabled.
   - Connects Socket 3 (Control).
   - Full cleanup of all established resources upon any partial failure.
6. **Cleanup on Termination & Host Shutdown**:
   Exposes `pub async fn cleanup_all_sessions(sessions: &SessionStore)` and `AppState::cleanup_all_sessions` to stop processes, sockets, and forwards.

---

## Frontend Mirror & Interaction Implementation

### 1. Video Pipeline
- Uses `@yume-chan/scrcpy` (`ScrcpyOptions3_3_1`) to consume stream metadata (`deviceName`, `codec`, `width`, `height`).
- Video frames are parsed via `options.createMediaStreamTransformer()` and decoded using `WebCodecsVideoDecoder`.
- Rendered onto an interactive `<canvas>` using `WebGLVideoFrameRenderer` with automatic fallback to `BitmapVideoFrameRenderer`.
- Explicit codec `isConfigSupported` validation.

### 2. Audio Pipeline
- Connects to session `audioUrl` over WebSocket and parses 4-byte audio metadata header.
- Decodes Opus packets using browser `AudioDecoder`.
- Plays audio through Web Audio `AudioContext` with continuous scheduling.
- Connects audio to a `MediaStreamAudioDestinationNode` and exposes `recordedAudioTrack` for browser recording.
- Explicit unsupported audio detection disables options in the UI without silent degradation.

### 3. In-Browser Screen Recording
- Implemented via `ScreenCanvasRecorder` using `canvas.captureStream(fps)` and browser `MediaRecorder`.
- Bounded recording by total bytes (250MB limit) and duration (5 minutes) with automatic auto-stop and error callbacks.
- Stopping recording halts only canvas video tracks, preserving the shared audio track. Object URLs are tracked and revoked during cleanup.

### 4. CSRF Authentication Integration
- Session creation and mutation routes use the centralized `api.getSession()` CSRF token from `web/src/api/client.ts`, eliminating redundant `/session` calls that invalidate cookies.

---

## Verification Evidence

### Rust Suite (`crates/andrui-media`)
```text
running 19 tests
test test_audio_packet_framing_and_metadata_fixtures ... ok
test test_protocol_control_messages_serialization ... ok
test test_protocol_metadata_parsing ... ok
test test_delete_nonexistent_session ... ok
test test_nofake_recording_endpoints_return_501 ... ok
test test_screencap_png_empty_device_id ... ok
test test_sessions_endpoint_validation_missing_device ... ok
test test_sessions_endpoint_validation_invalid_codec ... ok
test test_forward_mode_dummy_byte_and_fragmented_stream ... ok
test test_screencap_png_device_not_found ... ok
test test_screencap_png_valid_device ... ok
test test_screencap_png_device_offline ... ok
test test_screenshot_endpoint_raw_png ... ok
test test_screenshot_malformed_newlines_in_device_id ... ok
test test_screen_router_prefix ... ok
test test_capture_endpoint_json_dataurl ... ok
test test_capabilities_endpoint ... ok
test test_metadata_retained_across_delayed_attach_and_fragmented_frames ... ok
test test_cleanup_all_sessions ... ok

test result: ok. 19 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s
```
- `cargo fmt --manifest-path crates/andrui-media/Cargo.toml -- --check`: Passed (clean formatting)
- `cargo clippy --manifest-path crates/andrui-media/Cargo.toml --all-targets -- -D warnings`: Passed (0 warnings)
- `cargo test --manifest-path crates/andrui-media/Cargo.toml`: 19 passed

### Frontend Suite (`web`)
```text
 Test Files  4 passed (4)
      Tests  20 passed (20)
   Duration  976ms
```
- `npm run typecheck --prefix web`: Passed (clean TypeScript compilation)
- `npm run build --prefix web`: Passed (production Vite bundle)
- `npm test --prefix web`: 20 tests passed across 4 test suites

---

## Remaining Boundaries & Limitations

1. **Live Physical Hardware Verification**:
   All unit and integration tests were executed against simulated streams and deterministic fake ADB fixtures. Physical USB link latency, physical display refresh timing, and physical hardware encoder rate-control require real physical Android devices.
2. **Android OS Version Dependency for Audio**:
   Android audio capture via scrcpy requires Android 11+ (API 30+). On Android 10 or earlier, the scrcpy server automatically disables audio streaming or reports audio capture errors.
3. **Browser WebCodecs & Web Audio Support**:
   Hardware video decoding depends on browser `VideoDecoder` support (Chrome 94+, Edge 94+, Safari 16.4+, Firefox 130+ behind flags). Audio decoding requires `AudioDecoder` and Web Audio API. Environments lacking WebCodecs fall back to snapshot capture.
