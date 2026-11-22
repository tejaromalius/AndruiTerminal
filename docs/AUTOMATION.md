# AndruiTerminal Automation Subsystem

The automation backend extension (`andrui-automation`) provides semantic Android UI automation, accessibility event streaming, action recording/replay, host OCR, and normalized template matching for AndruiTerminal.

## Architecture and Execution Model

- **Host-native architecture**: Runs entirely in the host server process.
- **No host shell execution**: All ADB, helper instrumentation, and Tesseract invocations execute host binaries using direct argument arrays (`tokio::process::Command`), preventing shell injection and escaping vulnerabilities.
- **Opaque device targeting**: Device identifiers are treated as opaque strings and strictly passed via `-s <deviceId>`.
- **Host loopback security (SSRF prevention)**: Helper communication connects strictly to local loopback ports (`127.0.0.1:<forwarded_port>`) allocated by ADB forwarding. No user-supplied URLs or network addresses are accepted.
- **Mutual authentication**: Every active session generates a cryptographically secure random token ($\ge 24$ characters) passed to the instrumentation helper on startup and enforced on every subsequent HTTP request via `X-Andrui-Token`.
- **Subprocess bounds and safety**: All ADB subprocesses are bounded with explicit timeouts (install 120s, forward/cleanup 10s, hierarchy 30s), `kill_on_drop`, and bounded stdout/stderr draining. Long-running instrumentation uses null stderr to prevent pipe buffer deadlocks.
- **Proxy bypass**: Internal HTTP client enforces `no_proxy()` for private forwarded loopback helper URLs.
- **Crate**: `crates/andrui-automation/`, a workspace member mounted by `andrui-core` (Axum 0.8, Tokio 1).

---

## Integration API

The extension provides a clean public interface for the root companion server:

```rust
use std::path::PathBuf;

pub struct ExtensionsConfig {
    pub adb_path: PathBuf,
    pub data_dir: PathBuf,
    pub helper_apk: Option<PathBuf>,
}

pub fn router(config: ExtensionsConfig) -> axum::Router;
pub async fn cleanup_all_sessions(state: &AppState);
```

- **Router mounting**: All paths in the router are already rooted at `/api/v1/automation/...`, allowing the root application server to mount or merge the router directly:
  ```rust
  let app = root_router.merge(andrui_automation::router(config));
  ```
- **Companion shutdown**: Companion shutdown hooks can call `cleanup_all_sessions(&state).await` to stop all active instrumentation processes and remove ADB port forwards.

---

## Endpoints Specification

### 1. Capabilities
- **`GET /api/v1/automation/capabilities`**
  - Evaluates system capabilities on the host without fabricating success:
    - `helperApk`: Checks if the helper APK is configured and present on host disk.
    - `tesseract`: Checks if `tesseract` binary is present in host `PATH` and reports its version. If missing, reports `available: false` with an actionable reason.
    - `templateMatching`: Built-in normalized cross correlation (ZNCC) matching.
    - `capabilities`: Explicit list of supported feature flags.

### 2. Helper Session Lifecycle
- **`POST /api/v1/automation/sessions`**
  - **Body**: `{ "deviceId": string, "confirmed": true, "helperApk"?: string }`
  - **Process**:
    1. Rejects requests where `confirmed != true` (device modifications require explicit confirmation).
    2. Validates device ID (opaque string preserved without `.trim()` rewriting, rejecting empty or whitespace-only).
    3. Serializes session startup per device via mutex to prevent concurrent installation/startup races. Consistent lock order (`device_sessions` then `sessions`) eliminates lock inversion deadlocks.
    4. Installs the pinned helper APK via `adb -s <deviceId> install -r -t <apkPath>` (with `-t` for testOnly manifest, bounded to 120s timeout).
    5. Allocates host port forwarding via `adb -s <deviceId> forward tcp:0 tcp:9008` (requires valid port allocated by ADB; no fallback to unowned local port rebind; bounded to 10s timeout).
    6. Generates a random session token ($\ge 24$ chars).
    7. Spawns `am instrument -w -e port 9008 -e token <token> io.andrui.terminal.helper/.AutomationInstrumentation` with `kill_on_drop(true)` and null stderr.
    8. Polls `http://127.0.0.1:<port>/health` with `X-Andrui-Token` until `protocolVersion == 1` responds or timeout (15s).
    9. Registers session in server state with dedicated `action_lock`.
  - **Returns**: `{ "id": string, "deviceId": string, "helperVersion": string }`.

- **`GET /api/v1/automation/sessions`**
  - Lists all currently active automation sessions.

- **`GET /api/v1/automation/sessions/{id}`**
  - Inspects active session details (id, deviceId, helperVersion, hostPort, createdAt).

- **`DELETE /api/v1/automation/sessions/{id}`**
  - Stops owned instrumentation and port forwarding:
    1. Sends `POST http://127.0.0.1:<port>/stop` with `X-Andrui-Token`.
    2. Terminates the background `am instrument` child process.
    3. Removes port forward: `adb -s <deviceId> forward --remove tcp:<port>`.
    4. Clears session state.

### 2a. Helper Installation and Checks
The Overview page's **Automation helper** panel uses these routes for the selected ready device.

- **`GET /api/v1/automation/helper/status?deviceId=`**
  - Read-only. Returns `{ deviceId, package, hostApk: { available, path?, sha256?, reason? }, installed, installedPath?, versionName?, versionCode?, installedSha256?, upToDate: boolean|null, session: { id, helperVersion, hostPort } | null }`.
  - `upToDate` compares the SHA-256 of the configured host APK with the installed `base.apk` (`pm path` + device `sha256sum`); `null` when either hash is unavailable.
- **`POST /api/v1/automation/helper/install`**
  - **Body**: `{ "deviceId": string, "confirmed": true }`; rejects without confirmation (`confirmation_required`).
  - Holds the per-device lock shared with core jobs, stops an existing helper session (reinstalling kills its instrumentation), runs `adb install -r -t` with the configured APK, and returns the new status.
- **`POST /api/v1/automation/helper/uninstall`**
  - **Body**: `{ "deviceId": string, "confirmed": true }`; rejects without confirmation (`confirmation_required`).
  - Holds the per-device lock shared with core jobs, stops an existing helper session, runs `adb uninstall io.andrui.terminal.helper`, and returns the new status.
- **`GET /api/v1/automation/helper/checks?deviceId=`**
  - Read-only; changes no device settings. Returns `{ deviceId, overall, checks: [{ id, label, status: pass|warn|fail|skip, detail, guidance? }], status }`. `overall` is `fail` if any check fails, else `warn` if any warns, else `incomplete` if any check did not run (`skip`), else `pass`. `pass` therefore means the live checks actually ran.
  - Checks, in order:
    1. `host_apk`: configured APK readable on the host. Missing is a failure only when the helper is not installed; otherwise a warning (install/update unavailable, installed helper still works). `run-dev.sh` builds and configures the APK by default.
    2. `installed`: package present; reports version.
    3. `up_to_date`: SHA-256 match (warn when different; skipped with the reason when there is no host APK or the device hash cannot be read). The helper version (0.3.0, code 3) also distinguishes this build from 0.2.0.
    4. `power_save`: reports battery-optimization exemption (`dumpsys deviceidle whitelist`) and the app standby bucket (`am get-standby-bucket`). Passes either way, because a running helper is a foreground instrumentation process (on the Android 16 test device every live check passed with battery optimization on); warns with manual guidance only for the `restricted`/`never` buckets. Vendor freezers (e.g. Honor/Huawei "App launch") are not visible here; `not_frozen` detects them.
    5. `session`: running helper session. Without one, it and checks 6–9 are reported as `skip` ("not run"), giving `overall: incomplete`.
    6. `not_frozen`: reads per-thread kernel wait channels via `run-as` (the helper is debuggable). Any thread in `__refrigerator` means the system froze the helper; fails with power guidance and skips the remaining live checks.
    7. `health`: `/health` within 3 s, protocol 1, and the capabilities `window-metadata`, `secure-window-detection`, `keep-alive`.
    8. `hierarchy`: XML contains window metadata; reports window/display/node counts.
    9. `screenshot`: PNG captured; warns when the helper reports a visible FLAG_SECURE window (Android blanks it) or secure detection is unavailable.

### 3. Hierarchy Inspection
- **`GET /api/v1/automation/hierarchy?deviceId=&fallback=`**
  - **Default (live semantic helper)**:
    - Requires active session for `deviceId`.
    - Queries helper `GET /hierarchy`.
    - Returns `{ "xml": string, "capturedAt": number, "snapshotOnly": false, "source": "helper_accessibility" }`.
    - Each window's root node carries `display-id`, `window-id`, `window-type` (`application`, `input-method`, `system`, `accessibility-overlay`, `split-screen-divider`, `magnification-overlay`, `undefined`), `window-layer`, `window-active`, `window-focused` and (API 24+) `window-title`. API 30+ includes all displays. Select inside one window with XPath, e.g. `//node[@window-type='input-method']//node`.
  - **Fallback mode (`fallback=true`)**:
    - Intended only when explicitly requested and no helper session is present.
    - Executes `adb -s <deviceId> exec-out uiautomator dump /dev/tty` (or shell dump).
    - Returns `{ "xml": string, "capturedAt": number, "snapshotOnly": true, "source": "uiautomator_dump", "warning": "Snapshot-only fallback does not support semantic actions or live events" }`.
  - **Compact format (`format=compact`; default `xml`)**, for agents and token budgets. Works with both sources.
    - Returns `{ "nodes": CompactNode[], "capturedAt", "snapshotOnly", "source", "warning"? }` instead of `xml`.
    - Keeps visible nodes with non-zero bounds that are interactive (clickable, long-clickable, scrollable, checkable, `EditText`) or have `text`/`content-desc`. Structural containers are dropped.
    - `CompactNode = { id, class (short name), text?, desc?, hint?, resourceId?, bounds: [l,t,r,b], center: [x,y], flags: ("click"|"longClick"|"scroll"|"check"|"edit"|"checked"|"focused"|"selected"|"password"|"disabled")[], windowType? }`. Text is capped at 200 characters.
    - `id` is the node's position in this snapshot only. Act with the selector fields (`resourceId`, `text`, `description`, `className`) or `input.tap` at `center`.
    - On the Settings fixture (`tests/fixtures/data/hierarchy_settings.xml`, 78 nodes), 31 nodes are kept and the JSON is 15.6% of the XML size.
    - Unknown `format` → HTTP 400 `invalid_format`.

### 4. Semantic Actions
- **`POST /api/v1/automation/actions`**
  - **Body**:
    ```json
    {
      "deviceId": "emulator-5554",
      "action": "click | longClick | setText | scroll | wait | assert",
      "selector": {
        "resourceId": "io.andrui.terminal:id/btn_login",
        "text": "Sign In",
        "description": "Login button",
        "className": "android.widget.Button",
        "xpath": "//node[@text='Sign In']"
      },
      "text": "optional input text (required for setText)",
      "direction": "forward | backward (for scroll)",
      "condition": "exists | absent (for wait/assert)",
      "timeoutMs": 10000
    }
    ```
  - **Validation**:
    - Rejects empty selectors or selectors containing empty string values.
    - Serializes `ActionSelector` omitting absent keys (`skip_serializing_if`), ensuring Java helper receives only supplied keys.
    - Acquires session `action_lock` to serialize execution with active replays and other live actions.
    - Enforces required `text` for `setText`.
    - Bounds `timeoutMs` to $[0, 30000]$ ms.
  - **Outcome**:
    - Calls helper `POST /actions`.
    - Success (HTTP 200): Returns `{ "success": true, "action": string, "target"?: { ... }, "matched"?: bool }`.
    - Timeout (HTTP 408): Returns `{ "error": { "code": "element_timeout", "message": "..." } }`.
    - Rejected (HTTP 400): Returns `{ "error": { "code": "operation_failed", "message": "..." } }`.
  - **Recorder hook**: When a recording is active for `deviceId`, successful actions are automatically appended to the recording session (bounded to 1000 steps maximum) with duration and timestamp. Failed or timed-out actions are never recorded.

### 5. Accessibility Events Stream
- **`GET /api/v1/automation/events?deviceId=` (WebSocket)**
  - Streams accessibility event batches (`TYPE_VIEW_CLICKED`, `TYPE_WINDOW_STATE_CHANGED`, etc.) from helper `GET /events?since=N`.
  - **Sequence gap detection**: If the helper's bounded 512-ring buffer overflows between polling cycles, emits a `sequence_gap` message alerting the client that events were dropped and hierarchy should be refetched.

### 6. Screen Capture
- **`GET /api/v1/automation/screenshot?deviceId=`**
  - Requests screenshot from helper `GET /screenshot`.
  - Decodes helper base64 data to raw binary PNG bytes.
  - Serves image with `Content-Type: image/png` and the helper's FLAG_SECURE report as headers:
    - `X-Andrui-Secure-Window`: `true` (a visible secure window; Android blanks its content), `false`, or `unknown`.
    - `X-Andrui-Secure-Detection`: `dumpsys`, `unavailable` (helper query failed), or `unsupported` (older helper).
  - Helper errors are typed: `secure_window_blocked` → HTTP 409, `screenshot_unavailable` → HTTP 503, others → HTTP 400 `screenshot_failed`.
- **`GET /api/v1/automation/screenshot?deviceId=&marks=true[&format=json]`** (Set-of-Marks)
  - Also reads the helper hierarchy, and outlines each compact node with a numbered label (its compact `id`) drawn with a built-in bitmap font.
  - Default response is the marked PNG with `X-Andrui-Marks: <node count>`. `format=json` returns `{ "pngBase64", "nodes": CompactNode[], "capturedAt", "secureWindow" }`. `format=json` without `marks=true` → HTTP 400.
  - Needs a helper session (no fallback). The screenshot and hierarchy are captured one after the other, not atomically, so a screen change in between can misplace marks. Boxes assume hierarchy bounds and screenshot pixels share one coordinate space. **Unverified on hardware.**

### 7. Host OCR
- **`POST /api/v1/automation/ocr` (Multipart)**
  - **Fields**: `image` (binary file) and optional `language` (e.g. "eng").
  - Checks host `tesseract` availability; returns HTTP 503 if unavailable.
  - Writes image to scoped temporary file (`tempfile::NamedTempFile`).
  - Runs `tesseract <temp_img> <temp_out> -l <lang> tsv` with a 15-second timeout.
  - Parses TSV word boxes (level 5), calculating bounding boxes (`left`, `top`, `width`, `height`), confidence scores, and full text.
  - Automatically cleans up all temporary files on completion, error, or drop.

### 8. Normalized Template Matching
- **`POST /api/v1/automation/match` (Multipart)**
  - **Route limits**: Configured with explicit 25 MiB route limit (`DefaultBodyLimit::max`) to support documented 20 MB images without default 2 MiB multipart truncation.
  - **Fields**: `image` (source), `template` (needle), optional `threshold` (default 0.8), optional `maxMatches` (default 10).
  - **Validation**:
    - Rejects malformed multipart streams with HTTP 400.
    - Rejects nonfinite `threshold` (`NaN`, `inf`) and values outside $[0.0, 1.0]$.
    - Validates decoded image dimensions ($\le 8192 \times 8192$, template $\le$ source) and memory allocation via `ImageReader` limits.
    - Enforces a pixel-comparison computation budget ($\le 50,000,000$ operations), rejecting excessive workloads with HTTP 400.
  - **Computation**:
    - Offloads CPU-intensive matching work to Tokio `spawn_blocking`.
    - Computes Zero-mean Normalized Cross Correlation (ZNCC):
      $$\text{ZNCC} = \frac{\sum (T - \mu_T)(I - \mu_I)}{N \cdot \sigma_T \cdot \sigma_I}$$
    - Utilizes 2D integral images for $O(1)$ patch variance and sum calculations.
    - Manages candidates in a bounded Top-K min-heap to prevent unbounded memory growth.
    - Applies Non-Maximum Suppression (NMS) to eliminate overlapping bounding boxes.
  - Returns `{ "matches": [ { "x": number, "y": number, "width": number, "height": number, "score": number } ] }`.

### 9. Action Recording and Replay
- **Security & Path Traversal Prevention**: All recording and replay identifiers are strictly validated as valid UUIDs before filesystem or path joins.
- **`POST /api/v1/automation/recordings/start`**:
  - `{ "deviceId": string, "name"?: string }`
  - Starts recording session with bounded storage (max 1000 steps).
- **`POST /api/v1/automation/recordings/{id}/stop`**:
  - Stops recording session.
  - Persists recording JSON in `<data_dir>/automation/{id}.json`.
  - Returns complete step sequence. Only actions that completed successfully are retained.
- **`GET /api/v1/automation/recordings`**:
  - Lists all persisted recordings in storage.
- **`GET /api/v1/automation/recordings/{id}`**:
  - Retrieves a specific recording by ID.
- **`POST /api/v1/automation/replay`**:
  - `{ "recordingId": string, "deviceId": string }`
  - Loads recording and executes semantic steps sequentially against the device's helper session.
  - Locks session `action_lock` during execution to serialize live mutations and replay.
  - Verifies `ActionResult.success` on each step to eliminate fake success.
  - Stops execution on step failure.
- **`DELETE /api/v1/automation/replays/{id}`**:
  - Cancels active replay worker.
- **`GET /api/v1/automation/replays/{id}/events` (WebSocket)**:
  - Streams step execution progress (`started`, `passed`, `failed`, `cancelled`, `completed`) to browser clients.
- **Companion shutdown**: `cleanup_all_sessions` explicitly cancels active replays in addition to closing device sessions.

---

## Core Workflow Integration Guide

When orchestrating automation steps in central workflows:

1. **Selector Specification**:
   Use exact selectors where possible. XPath is supported when hierarchical disambiguation is required:
   ```json
   { "resourceId": "com.example.app:id/submit_button" }
   { "text": "Continue", "className": "android.widget.Button" }
   { "xpath": "//node[@text='Settings']/following-sibling::node[1]" }
   ```

2. **Actions & Waits**:
   - For UI transitions, execute an explicit `wait` action before interacting with subsequent elements:
     ```json
     { "action": "wait", "selector": { "resourceId": "welcome_screen" }, "timeoutMs": 5000 }
     ```
   - For negative assertions (asserting a spinner or dialog dismissed), use `condition: "absent"`:
     ```json
     { "action": "assert", "selector": { "resourceId": "loading_spinner" }, "condition": "absent" }
     ```

3. **Assertions**:
   - `assert` returns HTTP 200 with `{ "success": true, "matched": true }` when condition holds.
   - If condition fails before timeout, returns HTTP 408 Request Timeout.

---

## Limitations and Operational Constraints

1. **Protected Views and SurfaceView**:
   Android `UiAutomation` cannot inspect hardware-overlay `SurfaceView` internals. For those, use `/screenshot` combined with `/match` or `/ocr`. Windows with `FLAG_SECURE` (banking, credential screens) are blanked in screenshots; on a physical Android 16 device the helper returned a ~99.9% black frame rather than an error. `X-Andrui-Secure-Window: true` identifies this case, so OCR/matching results on such frames are not meaningful.
2. **Host Tesseract Requirement**:
   `/ocr` depends on `tesseract` being installed in the host server's PATH (the .deb depends on `tesseract-ocr`). When absent, the capability is flagged as unavailable and `/ocr` returns HTTP 503.
3. **Single Instrumentation Session per Device**:
   Android permits only one active `UiAutomation` connection per device. Starting a new session for a device will gracefully terminate any prior session owned on that device.
4. **Vendor Power Management**:
   Some vendor builds freeze the helper process even while it runs as an active foreground instrumentation (observed on Honor MagicOS 10: all main threads in `__refrigerator`, connections queued but never accepted). AOSP battery-optimization state does not reveal this. The `not_frozen` helper check detects it; the fix is a manual device setting (for Honor: Battery → App launch → AndruiTerminal Automation → Manage manually, allow all).
5. **Screen-off Timing**:
   While the device dozes, helper timers (e.g. the 2 s keep-alive idle close) can run late because the CPU sleeps; one observation was 7.3 s.
