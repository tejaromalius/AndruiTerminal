# Architecture and specification

## Product and acceptance
AndruiTerminal is an independent local single-user Linux-first Android workstation, with a Rust application server, React/TypeScript browser UI, and Debian (.deb) packaging with a per-user systemd service. All native ADB capabilities and developer/automation capabilities listed in FEATURE_COVERAGE.md are in scope. Preserve its 164 capability identifiers and the automation matrix. An action has to execute real behavior with meaningful parameters and observable outcomes; rendering a command preview, catalog entry, or generic terminal alone does not establish implementation. Capability restrictions and unverified hardware checks must remain visible and must not be reported as successful implementations.

## Architecture
Cargo workspace, Axum 0.8/Tokio Rust backend, SQLite persistence, argument-array subprocess execution, React/TypeScript/Vite/xterm.js frontend. The backend serves compiled frontend assets and /api/v1 HTTP and WebSocket interfaces. The server runs on the host as the logged-in user and uses locally configured official adb. It owns ADB, USB, pairing keys, emulator processes, media sessions, and host files. Do not expose raw ADB TCP ports or require root. The .deb depends on distro adb, tesseract-ocr and android-sdk-platform-tools-common (udev rules) rather than bundling them.

## Execution
Use the current configured ADB executable, inspect its version/help, and mark unsupported flags/actions unavailable. Do not replace system ADB (currently 34.0.4). Target selected serial/transport explicitly; report all device states. Run commands without a host shell; explicit Android shell input is a separate supported operation. Record stdout, stderr, exit code, running/completed/failed/cancelled states, timestamps, progress, and artifacts. Stream rather than buffer unbounded data. Support cancellation and timeouts. Serialize conflicting per-device mutations, allow independent device jobs and read monitors; never retry mutations automatically. Retain data in configured application storage with SQLite metadata. No actual device mutations during implementation tests.

## Browser API and security
See [API.md](API.md). Local access only; same-origin API requests, validated Host/Origin, session/CSRF protection for mutations and authenticated WebSocket handshakes. No multi-user account product. Host process execution is allowlisted; explicit shell commands are restricted to Android device shell, never implicit host shell. The Android SDK `emulator` is also allowlisted for fixed-argument AVD discovery/launch and lifecycle control of owned processes; no SDK installation or arbitrary arguments are accepted. The non-Android-toolchain entry is the Claude Code CLI (`claude`), run only by the AI Integration page after the user confirms, with fixed argument arrays (`--version`, `mcp add`/`mcp remove` of the `andrui` entry), never with user- or agent-supplied text. Uploaded artifact identifiers must not permit path traversal. Destructive UI actions display the target and operation and require deliberate confirmation.

## UI
Responsive dark technical workstation with persistent device selector, live state/capabilities, navigation, operation/job drawer, readable terminal and logs, keyboard-accessible controls, notifications and downloadable artifacts. Feature pages: Overview/Devices; Applications/Lifecycle; Files/Data; Shell; Logs; Screen/Media; Layout/Accessibility; Network/Mappings; Performance/Diagnostics; Users/Permissions/Policy; System/Recovery; Automation/Workflows; Settings/Capabilities. Domain-specific views and complete catalog-backed parameter forms must use the real API; unsupported operations explain the unmet condition. Show precise command previews plus stdout/stderr and exit status without implying command preview is execution.

## Capability groups
1. Devices: enumerate full states, transport metadata/IDs, USB/TCP selectors, pairing, saved endpoints, mDNS, reconnect/attach/detach, identity, waits, server lifecycle/status/features/keys/tracing.
2. Execution: one-shot and interactive shells with stdout/stderr/exit, PTY resize/input/close, exec-in/out binary streams, raw/ABB, tracking, emulator console and host emulator management.
3. Files: browse/stat, recursive and multi-source transfers, progress/cancel, sync/compression/dry-run/preserved metadata, build partition sync, rename/delete/mkdir/permissions/ownership, run-as private data, previews and database tools.
4. Packages: configurable standalone/split/atomic/staged/APEX/incremental installations, applicable fastdeploy compatibility, uninstall keep/user/version controls, queries and all-split export, launch intents/extras/options, force-stop/clear/enable/disable/component state, services/broadcasts/instrumentation/debug-app, users/profiles, grants/AppOps/App Links/device policy.
5. Logs/diagnostics: non-clearing logcat by default, buffer/filter/history/format/rotation/logd controls, persist/export, bugreports, JDWP/track-app/debug transport, WebView inspect, dumpsys/properties/settings/network, CPU/RAM/FPS/battery/process monitoring, traces/profiles/heaps/bitmap/ART capture and inspectable summaries.
6. Screen/media: pinned compatible scrcpy server/client, streamed video/audio/control, real input/clipboard/power, screenshot, recording, display/codec/encoder/options, native screencap/screenrecord and legacy framebuffer availability.
7. System/recovery: conditional root/unroot/remount/verity/reboot variants/sideload/rescue/legacy backup/restore/testharness/backup-manager/trade-in operations, specialized client services. Internal CLI plumbing may be classified as internal or non-applicable with rationale, never silently omitted.
8. Automation: public APIs, hierarchy/selectors/actions/waits/assertions, accessibility events, OCR/image matching, saved workflows and action recording/replay, per-device locks and coordinated multi-device execution/results. UI Automator instrumentation is a separate helper; low-level input is not semantic automation.

## Verification
Rust fmt/check/clippy/test, TypeScript checks/frontend build/tests, fake ADB integration tests including malformed/fragmented streams, binary output, stderr/nonzero status, cancellation, disconnect, unsupported flags, targeting, unusual filenames, installation sessions, metadata, and concurrency. Browser acceptance tests must verify real API integration. Package build/install and hardware checks require available infrastructure; state their limits explicitly. Dated results and limits are tracked in the Status section of FEATURE_COVERAGE.md. UI feature completion must link acceptance evidence in coverage. Never stage/commit/push/publish, install system software, or silently run recovery/destructive commands against real devices.

## Runtime and security model
One `andrui-terminal serve` process runs on the host as the logged-in user. It owns ADB, USB device access, pairing keys, emulator processes, media sessions and host files, and serves the browser UI and `/api/v1` on loopback.

```
+--------------------+       +------------------------------------------+
| Android Devices    | <===> | andrui-terminal serve (per-user process) |
| USB / TCP / Emus   |  ADB  | - system adb, tesseract, scrcpy server   |
+--------------------+       | - serves UI + /api/v1 HTTP/WebSocket     |
                             +---------------------+--------------------+
                                                   | 127.0.0.1:19801
                                                   v
                                          Web Browser (Local User)
```
1. **Runs as the user**: no root process or privileged helper. USB access comes from the distro udev rules (`android-sdk-platform-tools-common`).
2. **Loopback only**: the packaged service binds `127.0.0.1:19801`; the Host header must be a loopback name. ADB's server port 5037 is never exposed.
3. **CSRF and Origin**: mutating endpoints require the session cookie from `GET /api/v1/session` and the `X-CSRF-Token` header; WebSocket handshakes validate Origin and cookie.

## Host ADB 34.0.4
The target is the distro ADB 34.0.4 (`/usr/bin/adb`). The backend reads `adb version`/`help` and reports unsupported features through `GET /api/v1/capabilities`; it never replaces or upgrades system ADB.
- `devices -l` gives transport IDs, USB paths, models and products; `exec-out` streams binary output (e.g. `screencap -p`); `install-multiple` handles split APKs; `pair` supports wireless pairing.
- Debian's adb build has no mDNS support (`adb mdns services` returns nothing), so the server runs its own mDNS browser for wireless-debugging devices (`GET /api/v1/discovery`).
- `adb root` / `remount` only succeed on `userdebug`/`eng` builds and emulators; on retail builds the job fails with ADB's message.

## Screen mirroring and automation helper
Both run inside the host server process and share core session/CSRF protection, opaque device IDs and structured errors; helper versions are pinned and shown in capabilities. Rust owns `adb forward`, server launch and socket cleanup for scrcpy sessions; the browser decodes with WebCodecs. The automation helper is an Android instrumentation APK exposing a local-only HTTP endpoint forwarded over ADB, using UiAutomation for hierarchy, selectors, semantic actions, waits, screenshots and accessibility events. Coordinate-only input is not semantic automation. Host Rust manages explicit helper install/start/stop and version handshake with argument arrays; absence is an actionable unavailable capability.

An existing API route is not end-to-end support: helper build, protocol and browser tests are documented separately. Never run helper installs, input, recovery or destructive operations on real devices during verification without a designated test device. Production routes never return mock success.


## Optional AI gateway and device experience

See [UX_AI_DEVICE_ENHANCEMENTS.md](UX_AI_DEVICE_ENHANCEMENTS.md). Model inference uses an optional HTTP gateway after explicit evidence review; it does not spawn agent CLIs. Remote inference requires HTTPS. The assistant produces answers or validated workflow proposals and has no autonomous execution loop. Persistent profiles and reports use namespaced SQLite settings. Agent scopes and durable approvals guard supported MCP paths, not other processes running as the same user. SDK emulator processes are owned, bounded, observable and stopped on shutdown.

## Deep app inspection and the Firebase cloud exception
The `/inspect/...` routes (see [API.md](API.md)) inspect a single app: APK signing certificates and hashes, app-private SQLite databases, and process memory. Database and memory access depend on the app being debuggable (`run-as`) or the build being rooted; otherwise the capability reports itself unavailable rather than failing silently. Reads pull binary payloads to a host snapshot for local analysis; the only device mutations (database write-back, heap dump, Firebase debug props, emulator reverse) are explicitly confirmed, and database write-back saves a backup artifact and aborts if the on-device file changed since the snapshot. Raw process-memory reading/searching is intentionally out of scope.

Firebase has two tiers. The local tier (SDK inventory, config extraction, debug-logging toggles, emulator `adb reverse`) is ADB-only and stays within the local model. The cloud tier (FCM test send, Remote Config read) is the one documented exception to local-only operation: it reads a Google service-account key from a path named by an environment variable — the key is never stored, logged, or returned — mints a short-lived OAuth2 token, and makes outbound HTTPS calls to Google. These calls happen only on an explicitly confirmed request.
