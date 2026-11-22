# AI and device experience enhancements

Implemented locally on 2026-11-17. These additions do not establish complete ADB parity or physical-device compatibility.

## AI assistance

AI Integration now configures an optional OpenAI-compatible HTTP gateway. HTTP is accepted only on loopback; remote endpoints require HTTPS. Redirects and environment proxies are disabled. Secrets are read from a named server environment variable and are not stored in the database or browser. No model runtime or weights are installed.

Connection tests enumerate models. Separate text, tool-call and image-input probes exercise the selected model and report API response acceptance, not reasoning accuracy. Probes never execute a model-requested tool.

Contextual assistant panels are available on Overview, Logs, Diagnostics, Shell, Automation and AI Integration. Evidence collection uses fixed read-only probes for explicit devices and optionally recent crash logs. Users can edit/redact the JSON and must consent before each submission, including conversation history. The browser sends the displayed provider configuration; a changed destination is rejected until reviewed again. Device changes discard evidence, replies and conversation context. Model answers cannot execute commands. Workflow proposals must validate against the real operation catalog, then be separately saved and run.

Reports persist the request, reviewed evidence, answer, provider/model, timing and reported token usage. Report indexes retain the latest 200 records. API keys are excluded. Users should remove sensitive data before sharing evidence; reports retain what was submitted locally.

## Agent controls

MCP device inspection additionally exposes screen, system, process and package scopes. Device-bound MCP observations honor the configured device scope. Implicit resources require exactly one connected ready device; multiple devices require `android://<deviceId>/<resource>`. Logcat resource reads wait for completion and report failure or timeout rather than returning an early empty buffer.

Semantic `automation.*` operations use the existing catalog, jobs and workflow machinery. MCP operations outside an explicit read-only allowlist use approvals, including semantic mutations, coordinate input and installations; `wait` and `assert` are observations. Approvals persist in SQLite. Unresolved approvals expire after restart, preventing automatic replay. Agent permissions support pausing, read-only catalog operations, explicit device IDs, operation prefixes and package mutations. Package scopes refuse shell and global UI input, whose effects cannot be confined to a package.

Stop agent persists a pause, denies pending requests and signals cancellation to active MCP jobs. An action already delivered to a device may still complete. The policy applies to supported MCP/approval paths; it is not an OS sandbox. Direct local API calls, interactive shell, mirroring input and `/automation/actions` remain user interfaces outside that agent policy. Any process running as the same user can obtain an API session. Generic MCP client configuration is displayed without modifying other clients' settings; compatibility must be tested with each client.

## Devices and captures

Profiles store names, types, tags, notes and explicitly linked transport IDs. The header displays profile names. Saved wireless endpoints have a deliberate reconnect action. A selected device that disappears is retained as a disconnected target; the browser does not silently select a different device.

The connection doctor explains ADB authorization, offline, bootloader, recovery and sideload states. Phone, tablet, foldable, TV, watch and emulator profiles provide relevant guidance. TV profiles expose real D-pad, navigation, media and text commands. The gallery requests up to eight helper screenshots sequentially on demand and shows per-device failures. Wear profiles include navigation/stem keys and rotary scroll controls that remain disabled until the device advertises support. Gallery previews optionally mask watch captures as round. TV/watch/foldable vendor behavior, rotary fidelity, posture detection and special display behavior remain hardware-dependent; a profile label does not establish support.

File pulls without a host destination and bugreports without an output path produce managed downloadable artifacts. Empty optional output fields behave the same way. Preview destinations use `<browser-download>` placeholders; actual unique storage paths are allocated at execution. Native screenshot jobs capture PNG bytes without passing them through a text accumulator. Failed/empty captures do not become successful downloads. Directory archives are not implemented by the single-file browser download action.

Common tasks link to installation and recording or capture a screenshot/bugreport. Applications can save an install-launch-screenshot workflow using the chosen APK and explicit activity. The device timeline correlates jobs, artifacts, manually captured diagnostic snapshots and assistant reports containing that device's evidence. It is not an always-on telemetry recorder.

## Workflows, CI and Appium

Saved workflows can combine catalog commands, semantic UI actions, waits/assertions and binary-safe screenshot steps. Semantic steps need an already started helper session. Workflow runs persist per-device step outcomes, assertions, job IDs and artifacts. Failed assertions fail the run even when the command exited zero. Cancellation prevents subsequent steps; interrupted runs are marked failed after server restart. JSON and JUnit exports are available in Automation.

```sh
andrui-terminal workflow WORKFLOW_ID --devices SERIAL_A,SERIAL_B --server http://127.0.0.1:19801 --junit > results.xml
```

CLI output is the report; logging goes to stderr. Failed/cancelled runs exit nonzero. `--confirmed` is required for destructive workflow steps and should be used only after review. The CLI uses the existing authenticated local server and does not execute ADB independently.

Appium export generates a Python standard-library WebDriver client for semantic click, setText, clearText, wait and assert steps using one resourceId, exact text, description, className or XPath criterion. Unsupported steps or output assertions are rejected. Run the reviewed export against an existing local Appium UiAutomator2 server:

```sh
python3 andrui-appium.py --device SERIAL --server http://127.0.0.1:4723
```

Appium executes independently of AndruiTerminal's approvals. AndruiTerminal does not install/start Appium or its driver. Export protocol behavior is tested with a local WebDriver fixture; real Appium/device acceptance remains separate. References: [UiAutomator2 capabilities](https://appium.github.io/appium-uiautomator2-driver/latest/reference/capabilities/).

## Emulator lifecycle

AVD discovery searches the existing SDK specified by ANDROID_SDK_ROOT/ANDROID_HOME, the conventional user SDK directory and PATH. Discovery uses `emulator -list-avds`; launch accepts only a returned name and fixed arguments. At most four owned emulator processes run concurrently. Output retains the last 32 KiB. Stop controls affect only processes launched by this server; owned processes are terminated on shutdown. Process running is distinct from Android boot readiness.

Emulator console commands (`emu.command`) run from the Devices operation catalog; there is no dedicated GPS/network/battery simulation panel. Snapshot list/save/load actions use the explicitly selected emulator's console; restoration requires confirmation. No SDK/image creation, download or system installation occurs. Reference: [Android Emulator command line](https://developer.android.com/studio/run/emulator-commandline).

## Verification

- Rust API tests: `crates/andrui-core/tests/approval_tests.rs` covers policy/stop, profiles, model HTTP responses/consent, real helper protocol execution, semantic assertions, captures and workflow cancellation/results.
- Unit tests cover approval restart persistence, implicit MCP targeting, emulator process ownership, provider validation and JUnit escaping.
- Frontend tests: `web/src/test/ai-assistant.test.tsx`, `targeting.test.tsx` and the existing page/API tests.
- `tests/smoke/enhancements-smoke.mjs` uses the real server/browser, fake ADB and local model/WebDriver protocol fixtures. No external model account or physical device is required.
- Existing API/browser smoke checks remain applicable. Executed counts and limitations are recorded in FEATURE_COVERAGE.md.

Hardware-dependent acceptance, live model quality, real Appium installation, live AVD boot/snapshots and .deb installation are not established by fixture tests. iOS, arbitrary Bluetooth/serial peripherals and smart-home protocols remain separate integrations. The embedded assistant currently proposes work; autonomous model tool loops, automatic UI repair and full vendor/device compatibility are not implemented.
