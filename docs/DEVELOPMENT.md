# Development

## Repository layout
| Path | Contents |
|---|---|
| `crates/andrui-core` | Server, router, ADB execution, jobs, storage, discovery |
| `crates/andrui-terminal` | `andrui-terminal` binary and `.deb` metadata |
| `crates/andrui-automation` | Automation helper control, OCR, template matching, recordings |
| `crates/andrui-media` | scrcpy screen sessions (pinned server in `assets/`) |
| `web/` | React/TypeScript UI (Vite) |
| `helper-apk/` | Android UiAutomation helper APK (`build.py`, needs a JDK + Android SDK) |
| `integrations/claude/` | Claude Code skill bundled into the binary and installed from the AI Integration page |
| `packaging/` | systemd user unit |
| `scripts/` | Build, release, dev-run and license tooling |
| `tests/fixtures/` | Fake ADB executable and sample data |
| `tests/smoke/` | API and browser smoke tests, fake ADB environment |
| `design/brand/` | Logo sources, all PNG sizes, preview page, generator |

## Running from source
```bash
cargo build --bin andrui-terminal
(cd web && npm ci && npm run build)
./scripts/run-dev.sh
```
`run-dev.sh` serves on `http://127.0.0.1:19811` with data in `.runtime/data`, so it can run next to
the installed service (19801). Pass `--build` to build both the Rust backend (`cargo`) and frontend (`web/dist`) before starting. It builds the automation helper when its sources are newer than the
APK; use `--helper-apk PATH` for another APK or `--no-helper` to start without it. For UI work,
`cd web && npm run dev` serves on port 3000 and proxies `/api` to `run-dev.sh`.

The binary itself:
```bash
andrui-terminal serve --bind 127.0.0.1:19811 --adb /usr/bin/adb --data-dir .runtime/data --web-dir web/dist \
  [--scrcpy-server PATH] [--helper-apk PATH]
```

## Checks
```bash
cargo fmt --check && cargo clippy --workspace --all-targets && cargo test --workspace
(cd web && npm run typecheck && npm test && npm run build)
python3 scripts/check-coverage.py        # FEATURE_COVERAGE.md: 164 IDs, evidence, catalog mapping
```

## Fake ADB fixture
Deterministic testing without hardware or system ADB. Fake ADB is never selected automatically.

- Executable: `tests/fixtures/fake_adb.py` (symlink `tests/fixtures/adb`)
- Sample data in `tests/fixtures/data/`: ADB 34.0.4 `version`/`help` output, device lists in all
  states (`devices`, `devices -l`, JSON matrix), `getprop`, package list, logcat, a 1x1 PNG and a
  minimal APK.

Scenarios: all device states (`device`, `offline`, `unauthorized`, `recovery`, `sideload`,
`bootloader`, `authorizing`, `connecting`); targeting errors (`-s nonexistent`,
`-s offline-device-01`, `-s unauth-device-02` exit 1 with ADB's messages); install success, or
`Failure [INSTALL_FAILED_INVALID_APK]` when the APK name contains `invalid`/`fail`; binary
`exec-out screencap -p`; hangs via `FAKE_ADB_HANG=1` or `shell sleep <seconds>` for cancellation.

```bash
source tests/smoke/fake-adb-env.sh   # puts fake adb first in PATH
adb devices -l
```

## Smoke tests
`tests/smoke/api-smoke.py` uses temporary directories and fake ADB without touching host configuration.
```bash
python3 tests/smoke/api-smoke.py --skip-api                                # fixture checks only
python3 tests/smoke/api-smoke.py --binary ./target/debug/andrui-terminal   # start and test a server
python3 tests/smoke/api-smoke.py --base-url http://127.0.0.1:19811         # test a running server
```
It checks the fake ADB scenarios above, then `/health`, `/session`, `/operations`, `/devices`, job
success/failure/cancellation with CSRF, and the artifact upload/list/download/delete cycle. No mock
HTTP server is substituted; `--skip-api` validates the fixture only.

Browser smoke test (Chromium via Playwright; set `ANDRUI_CHROMIUM` to a Chromium/Chrome executable
if Playwright's browser is not installed), after `cd web && npm ci` and both builds:
```bash
node tests/smoke/browser-smoke.mjs
```

## Workspaces and Operations navigation

The primary sidebar sits on the right. Each parent menu item opens its complete working page; Operations is its only accordion child when a catalog exists. AI Integration and Settings have no child menu. All working sections, including the automation tools, render together. KPI summaries are deduplicated when sections share the same measurements. Layout's operation catalog is separate from its working page, like the other catalogs.

`PageTabs` retains the workspace and Operations panels after their first visit, preserving drafts, selected uploads, terminal/canvas instances, and active streams while switching between them. Leaving a parent page retains that page's existing cleanup behavior. Parent navigation and page shortcuts select `workspace`; old working-sub-tab selections normalize to that workspace. Operations remains keyboard accessible even while the parent workspace is selected.

Read-only metric hooks accept `enabled` for visibility gating and `manual` for explicit package inspection. Device/package changes discard previous samples and late responses. New stats fixtures and parser/polling tests run without Android hardware. Browser smoke coverage checks every main workspace and Operations catalog at desktop, tablet, and phone widths; it rejects duplicate KPI labels and extra child tabs, and exercises process/package widgets through the real API with fake ADB.

## Jobs panel sizing

The docked Jobs panel resizes by dragging its top edge or Jobs title, including when the list is empty. The focused resize handle also accepts Up/Down arrows. Expansion/restoration works with empty and populated lists, and an explicitly chosen height is remembered across reloads. Without a saved height, an empty panel remains compact. Browser smoke tests exercise real pointer dragging, saved heights, and sidebar clearance using fake ADB.


## AI/device enhancement verification

See [UX_AI_DEVICE_ENHANCEMENTS.md](UX_AI_DEVICE_ENHANCEMENTS.md). After rebuilding the server and frontend, run:

```sh
node tests/smoke/enhancements-smoke.mjs
```

Set `ANDRUI_CHROMIUM` to an existing Chromium executable if needed. This test starts a temporary real server with fake ADB and local model/WebDriver fixtures, checks AI evidence consent, profiles/TV input, JSON/JUnit CLI results, exported Appium protocol, binary artifacts, timeline and stop behavior, then cleans up owned processes and temporary data. It does not install dependencies, alter account setup or control physical devices.

## UI layout review

After rebuilding the frontend and debug server, run the reproducible Chromium review:

```sh
node tests/smoke/ui-layout-smoke.mjs
```

Set `ANDRUI_CHROMIUM` to an existing Chrome/Chromium executable when needed. Screenshots, contact sheets and `audit.json` go to `/tmp/andrui-ui-review` by default; override with `ANDRUI_UI_OUTPUT`. The test uses private temporary application storage, fake ADB, and a local model fixture. It seeds device profiles, a report and a workflow, visits all 14 workspaces at 1440, 768 and 390 pixels, reviews light mode at desktop width, captures lower sections and expanded widgets, and rejects page errors and horizontal workspace overflow. It checks device roster placement, profile draft retention, configuration tiling, checkbox layout, mobile navigation dismissal and stacked assistant steps. Screenshot inspection remains necessary to judge visual quality.

Executed 2026-11-17: frontend typecheck and production build passed; 119 frontend tests passed; browser smoke passed 134 workspace checks; AI/device enhancement acceptance passed all seven groups; layout review produced 78 screenshots with no page errors or horizontal workspace overflow. Desktop, phone, light-mode and lower-section contact sheets were visually inspected. Existing bundle-size and React test `act` warnings remain. Physical-device behavior and Firefox were not exercised during this UI change.
