# AI Integration Plan: AndruiTerminal

This document defines the architectural strategy, safety boundaries, and technical options for integrating AI agents and local assistant tooling into AndruiTerminal.

**2026-11-17 implementation update:** Contextual chat, evidence review/redaction, HTTP model configuration/probes, diagnostic reports, validated workflow proposals, scoped MCP policy, persistent approvals and unified semantic workflow jobs are implemented. See [current behavior and limits](UX_AI_DEVICE_ENHANCEMENTS.md). The options/phase diagrams below retain earlier design discussion; host agent CLI spawning and autonomous embedded tool loops remain deferred.

---

## 1. Architectural Reality & Security Boundaries

### 1.1 Non-Negotiable Constraints
- **Offline / Debian Package Integrity**: The backend is distributed as an independent, unprivileged Linux `.deb` package (`cargo-deb`) running as the logged-in user. Embedding multi-gigabyte neural network weights, Python runtimes (PyTorch), or fixed proprietary cloud dependencies directly into the Rust daemon is strictly out of scope.
- **Host Execution Isolation**: Under [ARCHITECTURE.md](ARCHITECTURE.md#L12-L13), host process execution is restricted to strictly allowlisted binaries (`adb`, `tesseract`, `scrcpy`). Explicit shell command execution is permitted solely against the connected Android device (`adb shell`), never as an unconstrained host shell.
- **Safety Boundaries for Destructive Actions**: Destructive ADB operations (`destructive: true` in [catalog.rs](../crates/andrui-core/src/operations/catalog.rs), such as wiping partitions, sideloading firmware, or factory resetting) strictly require explicit human confirmation (`confirmed: true`). AI agents must not autonomously bypass this confirmation gate.
- **Agent approval queue (implemented)**: `confirmed` is a request flag, so it cannot stop an agent that sets it itself. Agent requests go through `POST /api/v1/approvals` instead. Destructive operations and `shell.exec`/`shell.raw` (not marked destructive, but they can run anything on the device) wait as `pending` until the user approves them in the browser's job drawer. See [API.md](API.md#agent-approvals-limits) for its limits: it does not stop local processes that call the API directly, and supported MCP semantic mutations now enter the approval queue; direct user-facing API actions remain outside it.

### 1.2 Tool Definitions
- **`agy`**: Google Antigravity CLI (`agy`), a host agentic terminal assistant capable of autonomous coding and multi-tool orchestration.
- **`claude`**: Anthropic's Claude Code CLI (`claude`), an interactive local coding agent running on the host.
- **`codex`**: OpenAI's Codex CLI (`codex`), a local terminal coding agent comparable to `claude`. (The original Codex completion API is deprecated.)

---

## 2. Integration Options

### Option 1: In-App Chat Interface & Local Tool Integration

> **Deferred.** If the server spawned `agy`/`claude`, which bring their own host shell tools, it would conflict with [ARCHITECTURE.md](ARCHITECTURE.md)'s rule that the server never runs a host shell. When chat is designed, prefer an OpenAI-compatible HTTP gateway (e.g. Ollama) where the server runs the tool loop with the MCP tool set. External agents connect through MCP.

An embedded chat page (`/chat` or a slide-out drawer) inside the React web application ([web/src/](../web/src)) enabling the user to interact with local assistant tools and manage Android tasks.

#### Architecture
```
+--------------------------------------------------------------------------+
| Browser UI (React/TypeScript)                                           |
| - Chat Drawer / Chat Page (markdown, tool call inspection, approval UI)  |
+--------------------------------------------------------------------------+
                                    | WebSocket / HTTP (Same-Origin + CSRF)
                                    v
+--------------------------------------------------------------------------+
| Rust Backend (andrui-core / andrui-terminal)                             |
| - Agent Process Manager (spawns allowlisted CLI tools: agy, claude)      |
| - Local API Bridge: Exposes /api/v1 endpoints as stdio context to tools   |
| - LLM Client Gateway: Relays prompts to local Ollama / OpenAI-compatible |
+--------------------------------------------------------------------------+
         |                              |                          |
         v                              v                          v
  [ agy CLI ]                    [ claude CLI ]             [ Ollama / vLLM ]
  (Host PTY / Stdio)             (Host PTY / Stdio)         (HTTP API)
```

#### Integration Modes
1. **Interactive CLI Subprocess (PTY / Stdio Bridge)**:
   - For `agy` and `claude`, which are full terminal agents, the backend provides an allowlisted process runner (similar to device shell PTY in [crates/andrui-core/src/shell/manager.rs](../crates/andrui-core/src/shell/manager.rs)).
   - Spawns strictly `/usr/bin/agy` or `~/.local/bin/claude` with specific flags (e.g. `--output-format json` or PTY stream) authenticated via the user's host session.
   - PTY output streams over WebSocket to an xterm.js / styled chat component in the browser.
2. **Direct API / Local Inference Gateway**:
   - For codex/code-model completions, the backend or frontend connects directly to an OpenAI-compatible HTTP endpoint (e.g., `http://127.0.0.1:11434/v1` for Ollama).
   - Chat prompts include injected Android context (device state, top activity, last logcat error).

#### Security & Confirmation Gates
- Destructive commands detected from agent responses are displayed with a prominent warning modal and require explicit user clicking before `POST /api/v1/jobs` is issued with `confirmed: true`.

---

### Option 2: Model Context Protocol (MCP) Server

> **Implemented** as a thin stdio client of the running server (`andrui-terminal mcp --server http://127.0.0.1:19801`). A standalone process with its own `--adb`/`--data-dir` could not use the in-memory helper sessions or per-device locks of `serve`. Register it from the **AI Integration** page (Install MCP), or with `claude mcp add andrui -- andrui-terminal mcp`. The same page installs the `andrui-terminal` Claude Code skill, which tells Claude to use only these tools and to wait for approvals instead of falling back to `adb`. The skill is guidance; Claude Code does not enforce it. The page also shows integration status and the execution queue (pending approvals plus recent agent requests).

Exposes AndruiTerminal as an MCP tool provider, allowing external agents (`agy`, `claude`, Cursor, Claude Desktop) to control connected Android devices natively.

#### Architecture
- `mcp` subcommand in [crates/andrui-terminal/src/main.rs](../crates/andrui-terminal/src/main.rs), code in `crates/andrui-terminal/src/mcp/`:
  ```bash
  andrui-terminal mcp --server http://127.0.0.1:19801
  ```
- Implements MCP over `stdio` using newline-delimited JSON-RPC 2.0 (protocol versions 2025-06-18, 2025-03-26 and 2024-11-05). It handles requests one at a time and logs to stderr.

#### Exposed MCP Tools
| MCP Tool Name | Underlying API Route | Purpose |
|---|---|---|
| `android_list_devices` | `GET /api/v1/devices` | Enumerate connected devices and states |
| `android_device_info` | `GET /api/v1/stats` (default scope `device`) | Read-only device facts (getprop, battery, memory, storage, screen, IP, uptime) with `sections`/`grep` filters; no approval |
| `android_list_operations` | `GET /api/v1/operations` | Compact catalog list; full fields for one `operationId` |
| `android_preview_operation` | `POST /api/v1/operations/preview` | Exact command without running it |
| `android_run_operation` | `POST /api/v1/approvals` | Runs safe operations and waits for the job; destructive/shell operations return a pending approval |
| `android_get_approval` | `GET /api/v1/approvals/{id}` | Approval status, plus the job result once approved |
| `android_get_job` | `GET /api/v1/jobs/{id}` | Job status and tail-truncated output (32 KB stdout, 8 KB stderr) |
| `android_get_logs` | `POST /api/v1/approvals` (`logcat.dump`) | Recent logcat lines without clearing |
| `android_get_hierarchy` | `GET /api/v1/automation/hierarchy?format=compact` | Compact UI node list (`raw` for XML, `fallback` for uiautomator dump) |
| `android_screenshot` | `GET /api/v1/automation/screenshot[?marks=true&format=json]` | PNG image content, optionally with Set-of-Marks and node list |
| `android_ui_action` | `POST /api/v1/approvals` | `click`, `longClick`, `setText`, `scroll`, `wait`, `assert` (needs a helper session started in the UI; mutations require approval) |

---

### Option 3: Token-Efficient Perception Adapters

> **Implemented**: `format=compact` and `marks=true` are documented in [AUTOMATION.md](AUTOMATION.md). On the fixture the compact JSON is 15.6% of the XML. On-device behavior is unverified.

Android accessibility XML dumps from [hierarchy.rs](../crates/andrui-automation/src/hierarchy.rs) often exceed 50–100 KB, wasting LLM context window tokens and causing high latency.

#### Features
1. **Hierarchical Tree Pruner**:
   - Add a compact serialization parameter (`GET /api/v1/automation/hierarchy?format=compact`).
   - Strips non-interactive structural containers (`LinearLayout`, `FrameLayout`, `View` without click/scroll listeners).
   - Generates a flattened JSON array:
     ```json
     [
       { "id": 1, "type": "Button", "text": "Sign In", "bounds": [100, 200, 300, 280] },
       { "id": 2, "type": "EditText", "hint": "Password", "bounds": [100, 320, 500, 400] }
     ]
     ```
2. **Set-of-Marks (SoM) Visual Overlay**:
   - Computes bounding boxes of interactive elements and draws numbered visual markers onto the screenshot.
   - Allows Vision-Language Models (VLMs) like Claude 3.5 Sonnet or Gemini 2.0 to target UI elements by simple number index rather than hallucinating pixel coordinates.

---

### Option 4: In-App Feature Copilots

> **Implemented through contextual assistants and unified semantic catalog operations.** Model-generated workflows are validated, then separately saved and run by the user.

Targeted AI assistance embedded directly into existing workstation feature pages without disrupting workflows.

1. **Logcat / Crash Diagnosis Copilot** in [web/src/pages/LogsPage.tsx](../web/src/pages/LogsPage.tsx):
   - "Analyze Crash" button when a fatal exception or ANR appears in logcat.
   - Extracts the relevant stack trace and system state, prompting the model to identify the crash cause and propose fixes.
2. **Natural Language Automation Builder** in [web/src/pages/AutomationPage.tsx](../web/src/pages/AutomationPage.tsx):
   - User types: *"Open Settings, enable Airplane mode, wait 3 seconds, turn Airplane mode off"*.
   - Generates a valid JSON `Workflow` matching the [WorkflowStep](../crates/andrui-core/src/workflows/runner.rs) schema.
3. **Shell Query Assistant** in [web/src/pages/ShellPage.tsx](../web/src/pages/ShellPage.tsx):
   - Translates human queries (*"find all APKs modified today"*) into valid `adb shell find ...` commands with a safe preview before execution.

---

## 3. Implementation Phases

```
+-------------------------------------------------------------------------+
| Phase 1: MCP Server Subcommand (`andrui-terminal mcp`)                  |
| - Stdio JSON-RPC protocol                                               |
| - Connects directly to local `agy` and `claude`                         |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Phase 2: Perception Adapters (Compact Tree & Set-of-Marks)              |
| - Token pruning in andrui-automation                                    |
| - Numeric element tagging for visual models                             |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Phase 3: In-App Chat Interface & Local Tool Bridge                      |
| - React Chat UI in web/src/pages/ChatPage.tsx                           |
| - Backend runner for allowlisted host CLI tools (agy, claude)           |
| - BYO-Key / Local Ollama provider configuration in Settings             |
+-------------------------------------------------------------------------+
                                    |
                                    v
+-------------------------------------------------------------------------+
| Phase 4: Feature-Specific Copilots                                      |
| - Crash analyzer in LogsPage                                            |
| - Workflow synthesis in AutomationPage                                  |
+-------------------------------------------------------------------------+
```

---

## 4. Verification Matrix

| Milestone | Check | Success Criteria |
|---|---|---|
| **MCP Server** | `echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' \| andrui-terminal mcp` | Returns JSON schema with all available device and automation tools. |
| **Tool Execution** | Dispatch `android_list_devices` via MCP | Accurately returns device array matching `GET /api/v1/devices`. |
| **Compact Hierarchy** | `GET /api/v1/automation/hierarchy?format=compact` | Payload size reduced by $\ge 70\%$ compared to raw XML dump; all interactive elements retained. |
| **Chat CLI Bridge** | Launch `agy` or `claude` session via in-app chat | Process spawns with user privileges; stdio streams bidirectionally over authenticated WebSocket; exit cleans up child process. |
| **Safety Gate** | Request a destructive operation (`wipe_data`) via Chat or MCP | Rejects automatic execution; requires explicit user approval confirmation. |
