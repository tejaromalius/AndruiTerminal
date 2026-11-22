# Android automation helper

The development instrumentation APK uses Android UiAutomation and AccessibilityNodeInfo APIs. It provides real accessibility-based selection and actions; no coordinates are substituted for semantic selectors. Supported selectors are exact resourceId/text/description/className combinations or XPath over a fresh hierarchy. Snapshots include interactive windows. Node lookups are refreshed for every operation.

Build with an existing JDK and Android SDK:

```sh
python3 helper-apk/build.py
```

Defaults are API 34 and build-tools 34.0.0; use the script flags to select installed versions. The script installs nothing, creates only ignored build output, and uses its own development signing key. Minimum Android API is 23. This is a diagnostic helper, not a published application.

The Rust backend must explicitly install the APK, forward a device-local TCP port, and start `io.andrui.terminal.helper/.AutomationInstrumentation` with instrumentation arguments `port` and a cryptographically random `token` of at least 24 characters. Every helper request requires `X-Andrui-Token`. The manifest stays `debuggable`: the host's frozen-process check reads helper thread state through `run-as`, and reports a warning instead if that is unavailable. The server binds only device loopback and limits request sizes, workers, hierarchy size, and wait duration.

Protocol version 1:

- `GET /health`: helper version, Android SDK, capabilities (`hierarchy`, `selectors`, `xpath`, `actions`, `wait`, `assert`, `screenshot`, `accessibility-events`, `gestures`, `key-events`, `clear-text`, `rich-selectors`, `window-metadata`, `secure-window-detection`, `keep-alive`).
- `GET /hierarchy`: `{xml,capturedAt}`. Nodes include bounds, interactive state, accessibility flags (`selected`, `checkable`, `password`, `visible-to-user`), hint/error/pane text, and supported actions. Each window's root node also carries `display-id`, `window-id`, `window-type` (`application`, `input-method`, `system`, `accessibility-overlay`, `split-screen-divider`, `magnification-overlay`, `undefined`), `window-layer`, `window-active`, `window-focused` and, on API 24+, `window-title`. API 30+ includes windows on all displays; earlier versions report only display 0. Example: `//node[@window-type='input-method']//node`.
- `POST /actions`: `{action,selector?,text?,direction?,condition?,timeoutMs?,key?,keyCode?,startX?,startY?,endX?,endY?,durationMs?}`. Actions: click, longClick, setText, clearText, scroll, swipe, pressKey, wait, assert. Selectors support exact attributes, substring (`textContains`, `descContains`), prefix (`textStartsWith`), regex (`textMatches`, `descMatches`, `resourceIdMatches`), state flags (`checked`, `enabled`, `selected`, `focused`), and `index`. A rejected action or unmatched condition is an error.
- `GET /events?since=N`: `{events,sequence,dropped}` bounded accessibility event batch and sequence; reports dropped overflow count.
- `GET /screenshot`: `{contentType,base64,secure}` PNG screenshot. `secure` is `{detection,windows,visibleSecureWindow}` from a fixed internal `dumpsys window windows` query (`detection` is `unavailable` with a `message` if that fails). Android usually blanks FLAG_SECURE content instead of failing, so `visibleSecureWindow: true` means the image may hide content. If no image is returned, the error is `secure_window_blocked` when a visible secure window was detected, otherwise `screenshot_unavailable`; both include `secure`.
- `POST /stop`: close the instrumentation listener.

The backend relays events to browser WebSockets. Connections are HTTP/1.1 keep-alive: up to 100 requests per socket, closed after 2 seconds idle, on `Connection: close`, HTTP/1.0, or a 403. Accessibility events may be dropped when the bounded 512-event ring fills; the browser must refetch hierarchy after an event sequence gap. Protected surfaces and applications without useful accessibility nodes remain subject to Android restrictions. APK compilation/signature verification does not certify on-device operation. No device install or input action is performed by the build.
