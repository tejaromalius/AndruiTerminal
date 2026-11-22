---
name: andrui-terminal
description: Use for ANY task that touches an Android device, emulator or phone - adb, device info, getprop, logcat, APKs and packages, files on the device, shell commands, screenshots, UI automation, reboot or recovery. Routes all device access through the AndruiTerminal MCP tools (android_*) instead of adb, even when that means waiting for the user to approve a step.
---

# AndruiTerminal device access

AndruiTerminal is the user's local Android workstation. It mediates every device action, so the user can see each one and approve risky ones. Follow these rules for every Android device task.

## Hard rules

1. **Use only the `android_*` MCP tools to reach devices.** Never run `adb`, `fastboot`, `scrcpy`, or `curl`/HTTP calls against the AndruiTerminal API from Bash or any other shell tool. This applies even when a shell command looks faster, when MCP output is truncated, and when a step needs approval.
2. **Never route around an approval.** If a tool returns `"status": "pending"`, wait for the user. Do not retry the request, split it to dodge the gate, or look for another path that avoids approval.
3. **If the MCP tools are missing or the server is unreachable, stop and tell the user.** Suggest `systemctl --user start andrui-terminal`, or **Install MCP** on the AndruiTerminal *AI Integration* page. Do not fall back to adb.
4. **Plain adb only with explicit permission.** Use it only if the user says so in this conversation, and only for the task they named.

## What needs approval

- **Never needs approval:** `android_list_devices`, `android_device_info`, `android_list_operations`, `android_preview_operation`, `android_get_approval`, `android_get_job`, `android_cancel_job`, `android_get_logs`, `android_get_hierarchy`, `android_screenshot`.
- **Catalog operations that run immediately** (an allowlist, not every read): `device.list`, `logcat.dump`, `logcat.stats`, `screen.screencap`, `diagnostics.getprop`, `diagnostics.settings_get`, `diagnostics.cpu`, `diagnostics.meminfo`, `diagnostics.gfxinfo`, `package.list`, `package.path`, `users.list`, and the UI actions `wait` and `assert`.
- **Everything else waits for approval.** This includes read-only operations outside the allowlist (e.g. `diagnostics.dumpsys`, `diagnostics.batterystats`), all input operations (`input.tap`, `input.keyevent`, ...), the other UI actions, shell commands (`shell.exec`, `shell.raw`) and every destructive operation (marked High).

## Waiting for approval

When an operation needs approval, the tool returns an `approvalId`, and the request waits in AndruiTerminal under *AI Integration → Execution queue* (it also appears in the Jobs drawer).

When that happens:
1. Tell the user in one or two lines what you requested: the operation, the device and the `command`. Say it is waiting for their approval in AndruiTerminal.
2. Poll `android_get_approval` with `waitMs: 60000`. Repeat while the status is `pending`. Pending requests expire after 10 minutes.
3. Act on the outcome:
   - `approved`: the result contains the job output. Continue.
   - `denied`: stop that line of work and ask the user how to proceed.
   - `expired`: ask before submitting the request again.
   - `failed`: report the `error`.

## Jobs and policy refusals

- If a result still shows `status: "queued"` or `"running"` after `waitMs`, poll `android_get_job` with its `jobId` rather than submitting again.
- Stop a job you started that is no longer needed (long recordings, bugreports, continuous logcat) with `android_cancel_job`. Jobs the user started cannot be cancelled this way.
- An `AGENT_POLICY` error means the user's agent policy refused the request: agents are paused, the policy is read-only, the device is outside the permitted devices, or the operation or package is outside the permitted scope. Do not retry or rephrase the request to get around it; tell the user what was refused and why.

## Choosing tools

Prefer reads that need no approval, then catalog operations, and use shell commands last:

- **Device facts:** `android_device_info` (no approval). The default `device` scope covers getprop, battery, memory, storage, screen size and density, IP addresses and uptime. Narrow it with `sections` and `grep` instead of reading everything. Other scopes: `network`, `permissions`, `files`, `applications`, `logs`, `shell`, `telemetry`, `screen`, `system`, `processes`, and `package` (pass `package` with the package name).
- **Devices:** `android_list_devices` first, then pass the `id` as `deviceId`.
- **Catalog operations:** look up the right operation with `android_list_operations` (pass `operationId` to see its fields), check it with `android_preview_operation`, then run it with `android_run_operation`. Only the allowlisted operations above run immediately; expect the rest to wait for approval.
- **Logs:** `android_get_logs` with `lines`, `buffer` and `filter` (e.g. `*:E`).
- **Targeted / PID Logs:** Do NOT request `shell.exec`. Use `android_run_operation` with `operationId: "logcat.dump"` and pass parameters like `{"pid": <PID>, "lines": 200}` or `{"regex": "<pattern>"}` (runs immediately, no approval needed). If logs remain empty on vendor ROMs, ask the user if the OS or app build suppresses logcat.
- **Shell:** `android_run_operation` with `shell.exec` only when nothing above covers the need. It needs approval, so combine related commands into one request (one approval) rather than many.
- **Long output:** job output keeps the last 32 KB. Narrow the request (operation fields, `grep`, `lines`) rather than switching tools.
  - Never run `diagnostics.dumpsys` for `activity` without specifying a `package` or `top`.
  - Never run the catalog operation `screen.screencap` (dumps binary data to stdout). Use `android_screenshot` instead.

## UI automation

- `android_get_hierarchy` returns compact nodes. Node `id`s are valid for that snapshot only. Act with `android_ui_action` and a selector (`resourceId`, `text`, `description`, `className`), or tap a node's `center` with the `input.tap` operation (needs approval).
- `android_ui_action` actions: `click`, `longClick`, `setText` (`text`), `clearText`, `scroll` (`direction`), `swipe` (`startX`/`startY`/`endX`/`endY`, optional `durationMs`, or a selector), `pressKey` (`key` such as `BACK`/`HOME`/`ENTER`, or `keyCode`; no selector), `wait` and `assert` (`condition`: `exists`/`absent`). `wait` and `assert` run immediately; the others need approval.
- Always inspect the hierarchy before selecting nodes; never guess selectors. Icon and toolbar buttons typically use `description` (`content-desc`), not `text`.
- If no automation session is running, pass `fallback: true` to `android_get_hierarchy` to inspect the UI via snapshot uiautomator dump without waiting for the helper.
- `android_screenshot` with `marks: true` numbers the nodes on the image to match the hierarchy `id`s.
- Live actions (`android_ui_action`) and screenshots (`android_screenshot`) require an automation helper session. If none is running, ask the user to start one in AndruiTerminal (Overview → Automation helper, or the Layout page); you cannot start it yourself.
- If an action hits `helper_communication_error` or `element_timeout`, the screen may have slept or locked. Wake the device using `android_run_operation` with `operationId: "input.keyevent"` and `parameters: {"keycode": "224"}` (or `"82"` to unlock); this needs approval, so tell the user why you are asking. Then re-read the hierarchy. On vendor ROMs (Honor/Huawei), remind the user that the helper must be excluded from aggressive battery killers ("App launch").

## Reporting

When you report results, say which `android_*` tools you used. If a step waited for approval, say whether it was approved.
