# Feature coverage

This ledger is the source of truth for scope: 164 capability IDs, checked by `scripts/check-coverage.py`. Planned is not implemented. Device restrictions are not missing product implementations.

| ID | Capability | State | Owner/module | Evidence |
|---|---|---|---|---|
| C01 | `devices` | Partial | Rust core + catalog forms | `device.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L7)) |
| C02 | `devices -l` | Partial | Rust core + catalog forms | `device.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L7)) |
| C03 | USB/emulator transport discovery | Partial | Rust core + catalog forms | `device.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L7)) |
| C04 | Device-change tracking | Not implemented | Unassigned | No dedicated adapter identified |
| C05 | Explicit serial targeting, `-s` equivalent | Partial | Rust command builder | `add_device_targeting`; fake-ADB targeting and job/browser checks |
| C06 | `-d`, `-e`, `-t`; `transport-id` | Not implemented | Unassigned | No dedicated adapter identified |
| C07 | `connect HOST[:PORT]` | Partial | Rust core + catalog forms | `device.connect` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L21)) |
| C08 | `disconnect HOST[:PORT]` | Partial | Rust core + catalog forms | `device.disconnect` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L53)) |
| C09 | Bare `disconnect` for all TCP devices | Partial | Rust core + catalog forms | `device.disconnect` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L53)) |
| C10 | `pair HOST:PORT CODE` | Partial | Rust core + catalog forms | `device.pair` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L87)) |
| C11 | `mdns check`, `mdns services` | Partial | Rust core + catalog forms | `device.mdns.check` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L128)); `device.mdns.services` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L141)); built-in mDNS browser `GET /api/v1/discovery` ([discovery](../crates/andrui-core/src/adb/discovery.rs)) with connect/pair from the Overview discovery radar. Debian's adb 34.0.4 has no mDNS, so the adb operations return nothing there |
| C12 | TLS wireless transport and auto-connect | Partial | Delegated to official ADB | Wireless pair/connect adapters delegate TLS/auto-connect behavior to configured ADB; no QR/saved auto-connect UI |
| C13 | QR pairing workflow | Not implemented | Unassigned | No dedicated adapter identified |
| C14 | `tcpip PORT` | Partial | Rust core + catalog forms | `device.tcpip` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L154)) |
| C15 | `usb` | Partial | Rust core + catalog forms | `device.usb` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L175)) |
| C16 | `reconnect`, `reconnect device`, `reconnect offline` | Partial | Rust core + catalog forms | `device.reconnect` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L188)) |
| C17 | `attach`, `detach` | Partial | Rust core + catalog forms | `device.attach` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L222)); `device.detach` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L243)) |
| C18 | `-H`, `-P`, `-L`, `-a` | Not implemented | Unassigned | No dedicated adapter identified |
| C19 | `--one-device` | Not implemented | Unassigned | No dedicated adapter identified |
| C20 | `start-server` / automatic startup | Partial | Rust core + catalog forms | `server.start` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L264)) |
| C21 | `kill-server` / restart | Partial | Rust core + catalog forms | `server.kill` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L277)) |
| C22 | `server nodaemon`, internal launch options | Not implemented | Unassigned | No dedicated adapter identified |
| C23 | `server-status` | Partial | Rust core + catalog forms | `server.status` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L290)) |
| C24 | `features`, `host-features` | Partial | Rust core + catalog forms | `server.features` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L303)); `server.host_features` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L316)) |
| C25 | `keygen`, `pubkey` | Partial | Rust core + catalog forms | `server.keygen` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L329)); `server.pubkey` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L351)) |
| C26 | Ordinary RSA authorization | Partial | Delegated to official ADB/adbd | RSA authorization remains the official ADB/device authorization workflow; unauthorized devices are shown |
| C27 | ADB tracing/backend/environment controls | Not implemented | Unassigned | No dedicated adapter identified |
| C28 | Wi-Fi 2.0 behavior with Android 17/ADB 37 | Not implemented | Unassigned | No dedicated adapter identified |
| E01 | Interactive `shell` | Partial | Rust PTY + browser xterm | `crates/andrui-core/src/shell/manager.rs`; native/container Chromium input and actual 120x40 PTY resize |
| E02 | One-shot command execution | Partial | Rust core + catalog forms | `shell.exec` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L373)) |
| E03 | Shell v2 stdout/stderr/exit handling | Partial | Rust core + catalog forms | `shell.exec` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L373)) |
| E04 | Shell protocol stream framing | Partial | Delegated to official ADB | Official client handles shell framing; application relays PTY/text output, no direct protocol API |
| E05 | `shell -e`, `-n`, `-T`, `-t`/`-tt`, `-x` | Partial | Rust core + catalog forms | `shell.exec` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L373)) |
| E06 | `exec-in`, `exec-out` | Partial | Rust core + catalog forms | `exec.out` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L415)); `exec.in` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L436)) |
| E07 | `abb` / direct Binder service access | Not implemented | Unassigned | No dedicated adapter identified |
| E08 | `wait-for[-TRANSPORT]-STATE` | Partial | Rust core + catalog forms | `device.wait_for` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L458)) |
| E09 | `get-state` | Partial | Rust core + catalog forms | `device.get_state` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L528)) |
| E10 | `get-serialno` equivalent | Partial | Rust core + catalog forms | `device.get_serialno` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L541)) |
| E11 | `get-devpath` | Partial | Rust core + catalog forms | `device.get_devpath` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L554)) |
| E12 | `track-devices` raw/long/protobuf output | Not implemented | Unassigned | No dedicated adapter identified |
| E13 | Host scripting and batch orchestration | Partial | Core workflows | `crates/andrui-core/src/workflows/runner.rs`; saved operation steps, assertions and concurrent per-device runs; full scripting remains incomplete |
| E14 | `--exit-on-write-error` | Not implemented | Unassigned | No dedicated adapter identified |
| E15 | `raw SERVICE` | Partial | Rust core + catalog forms | `shell.raw` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L394)) |
| E16 | `emu COMMAND` | Partial | Rust core + catalog forms | `emu.command` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L567)) |
| E17 | `help`, `version` exposure | Partial | Rust core + catalog forms | `adb.version` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L590)); `adb.help` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L603)) |
| E18 | Host transport wire protocol | Partial | Delegated to official ADB | Host transport wire protocol belongs to configured official ADB; no custom low-level wire API |
| F01 | File `push` | Partial | Rust core + catalog forms | `file.push` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L617)) |
| F02 | File `pull` | Partial | Rust core + catalog forms | `file.pull` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L704)) |
| F03 | Recursive directory push/pull | Partial | Rust core + catalog forms | `file.push` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L617)); `file.pull` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L704)) |
| F04 | Multiple local upload inputs | Partial | Rust core + catalog forms | `file.push` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L617)) |
| F05 | Multiple independent remote pull operands | Partial | Rust core + catalog forms | `file.pull` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L704)) |
| F06 | `push --sync` | Partial | Rust core + catalog forms | `file.push` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L617)) |
| F07 | `push -n`; dry-run transfer | Partial | Rust core + catalog forms | `file.push` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L617)) |
| F08 | `push/pull -z`, `-Z` | Partial | Rust core + catalog forms | `file.push` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L617)); `file.pull` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L704)) |
| F09 | `pull -a` | Partial | Rust core + catalog forms | `file.pull` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L704)) |
| F10 | Source-mode/mtime fidelity on upload | Partial | Delegated to official ADB | `file.push` uses official sync behavior; no independent metadata-fidelity hardware acceptance |
| F11 | Quiet/progress option parity, `-q` | Not implemented | Unassigned | No dedicated adapter identified |
| F12 | `sync` from `ANDROID_PRODUCT_OUT` | Partial | Rust core + catalog forms | `file.sync` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L782)) |
| F13 | Sync stat/list services | Partial | Rust core + catalog forms | `file.stat` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1015)) |
| F14 | Modern stat/list/send/recv protocol variants | Partial | Delegated to official ADB | Official push/pull/sync negotiates sync protocol variants; application does not expose all low-level variants |
| F15 | Reliable large-file metadata | Partial | Rust core + catalog forms | `file.stat` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1015)) |
| F16 | Sync `ls` equivalent | Partial | Remote filesystem browser | `crates/andrui-core/src/files/service.rs`; Android ls listing including spaces/symlinks, not low-level sync ls |
| F17 | `rm`, `mkdir` via shell | Partial | Rust core + catalog forms | `file.mkdir` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L848)); `file.rm` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L869)) |
| F18 | `mv`/rename via shell | Partial | Rust core + catalog forms | `file.mv` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L901)) |
| F19 | App-private file operations through `run-as` | Partial | Rust core + catalog forms | `file.run_as` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1036)) |
| F20 | File previews | Not implemented | Unassigned | No dedicated adapter identified |
| F21 | Permission/ownership editing | Partial | Rust core + catalog forms | `file.chmod` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L933)); `file.chown` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L974)) |
| F22 | Transfer cancel/retry/resume controls | Not implemented | Unassigned | No dedicated adapter identified |
| P01 | Single APK install/reinstall | Partial | Rust core + catalog forms | `package.install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1070)) |
| P02 | `install -r` replacement behavior | Partial | Rust core + catalog forms | `package.install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1070)) |
| P03 | Install `-t`, `-d`, `-g`, `--abi`, `--instant` | Partial | Rust core + catalog forms | `package.install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1070)) |
| P04 | Installer/user/location options | Partial | Rust core + catalog forms | `package.install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1070)) |
| P05 | `install-multiple`; split APKs and `-p` | Partial | Rust core + catalog forms | `package.install_multiple` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1181)) |
| P06 | `install-multi-package` | Partial | Rust core + catalog forms | `package.install_multi_package` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1223)) |
| P07 | `--streaming` / `--no-streaming` | Partial | Rust core + catalog forms | `package.install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1070)) |
| P08 | `--incremental`, `--no-incremental`, `--wait` | Partial | Rust core + catalog forms | `package.install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1070)) |
| P09 | Fast-deploy/agent options | Not implemented | Unassigned | No dedicated adapter identified |
| P10 | APEX/staged/session installation | Not implemented | Unassigned | No dedicated adapter identified |
| P11 | `uninstall PACKAGE` | Partial | Rust core + catalog forms | `package.uninstall` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1244)) |
| P12 | Uninstall `-k`, `--user`, `--versionCode` | Partial | Rust core + catalog forms | `package.uninstall` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1244)) |
| P13 | Package list and third-party filter | Partial | Rust core + catalog forms | `package.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1294)) |
| P14 | Full package query options | Partial | Rust core + catalog forms | `package.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1294)) |
| P15 | Package metadata | Not implemented | Unassigned | No dedicated adapter identified |
| P16 | `pm path`; APK export | Partial | Rust core + catalog forms | `package.path` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1362)) |
| P17 | Launcher activity start | Partial | Rust core + catalog forms | `activity.start` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1543)) |
| P18 | General `am start` and intent arguments | Partial | Rust core + catalog forms | `activity.start` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1543)) |
| P19 | `am force-stop` | Partial | Rust core + catalog forms | `activity.force_stop` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1629)) |
| P20 | `am kill`, `kill-all`, arbitrary PID signal | Partial | Rust core + catalog forms | `activity.kill` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1650)); `activity.kill_all` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1682)) |
| P21 | `pm clear` | Partial | Rust core + catalog forms | `package.clear` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1383)) |
| P22 | `pm enable`, `disable-user` | Partial | Rust core + catalog forms | `package.enable` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1415)); `package.disable` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1447)) |
| P23 | Component/user/suspend/hide state controls | Partial | Rust core + catalog forms | `package.enable` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1415)); `package.disable` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1447)); `package.suspend` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1479)); `package.unsuspend` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1511)) |
| P24 | Service start/stop and broadcasts | Partial | Rust core + catalog forms | `service.start` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1695)); `service.stop` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1736)); `broadcast.send` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1768)) |
| P25 | Instrumented test execution | Partial | Rust core + catalog forms | `instrumentation.run` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1800)) |
| P26 | Debug-app configuration | Partial | Rust core + catalog forms | `debug.set_app` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1841)); `debug.clear_app` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1882)) |
| P27 | Permissions and AppOps management | Partial | Rust core + catalog forms | `permission.grant` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1895)); `permission.revoke` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1936)); `appops.set` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L1977)) |
| P28 | App Links management | Partial | Rust core + catalog forms | `applinks.get` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2044)); `applinks.verify` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2065)) |
| P29 | Users/profiles | Partial | Rust core + catalog forms | `users.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2097)); `users.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2110)); `users.remove` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2131)) |
| P30 | Package features/libraries/permissions/instrumentation inventory | Not implemented | Unassigned | No dedicated adapter identified |
| P31 | Install-location, trim-cache and system-update controls | Not implemented | Unassigned | No dedicated adapter identified |
| P32 | Device Policy Manager | Partial | Rust core + catalog forms | `dpm.set_device_owner` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2152)) |
| D01 | Live logcat | Partial | Rust core + catalog forms | `logcat.dump` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2174)) |
| D02 | Priority/tag/package filtering and export | Partial | Rust core + catalog forms | `logcat.dump` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2174)) |
| D03 | Preserve pre-existing logs | Partial | Rust core + catalog forms | `logcat.clear` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2280)) |
| D04 | `logcat -b` buffer selection | Partial | Rust core + catalog forms | `logcat.dump` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2174)); `logcat.clear` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2280)) |
| D05 | `-d`, `-t`, `-T`, `-L`, `--wrap` | Partial | Rust core + catalog forms | `logcat.dump` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2174)) |
| D06 | `--pid`, `--uid`, regex/filter-spec controls | Not implemented | Unassigned | No dedicated adapter identified |
| D07 | `-v`, modifiers, binary/protobuf export | Partial | Rust core + catalog forms | `logcat.dump` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2174)) |
| D08 | Log file rotation and persistent collection | Not implemented | Unassigned | No dedicated adapter identified |
| D09 | Logd buffer/pruning/statistics controls | Partial | Rust core + catalog forms | `logcat.stats` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2301)) |
| D10 | Pause/resume without loss | Not implemented | Unassigned | No dedicated adapter identified |
| D11 | `bugreport [PATH]` | Partial | Rust core + catalog forms | `diagnostics.bugreport` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2314)) |
| D12 | `jdwp`, `track-jdwp` | Partial | Rust core + catalog forms | `diagnostics.jdwp` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2335)) |
| D13 | `track-app` and protobuf forms | Not implemented | Unassigned | No dedicated adapter identified |
| D14 | `jdwp:PID` forwarding | Not implemented | Unassigned | No dedicated adapter identified |
| D15 | WebView debugging | Not implemented | Unassigned | No dedicated adapter identified |
| D16 | `dumpsys` diagnostic access | Partial | Rust core + catalog forms | `diagnostics.dumpsys` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2348)) |
| D17 | CPU/RAM/process monitoring | Partial | Rust core + catalog forms | `diagnostics.cpu` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2369)); `diagnostics.meminfo` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2390)); per-app memory summary via `inspect::memory::memory_report` ([module](../crates/andrui-core/src/inspect/memory.rs)) |
| D18 | FPS monitoring | Partial | Rust core + catalog forms | `diagnostics.gfxinfo` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2411)) |
| D19 | Profiles, heaps, bitmap dumps and ART profiles | Partial | Rust core inspect | Heap dumps (`am dumpheap`) as artifacts via `inspect::memory::capture_heap_dump` ([module](../crates/andrui-core/src/inspect/memory.rs)); `memory_inspect_tests`. Profiles/bitmap/ART still unimplemented. Raw process-memory read/search intentionally out of scope. |
| D20 | Perfetto/atrace, detailed memory/battery/network diagnostics | Partial | Rust core + catalog forms | `diagnostics.batterystats` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2432)); `diagnostics.netstats` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2445)) |
| D21 | System properties/settings | Partial | Rust core + catalog forms | `diagnostics.getprop` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2458)); `diagnostics.setprop` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2479)); `diagnostics.settings_get` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2511)); `diagnostics.settings_put` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2556)) |
| D22 | Network inspection/management | Partial | Rust core + catalog forms | `diagnostics.net_interfaces` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2610)); `diagnostics.net_routes` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2623)) |
| D23 | Android 17 memory-limiter controls | Not implemented | Unassigned | No dedicated adapter identified |
| D24 | Android 17 app-link launch diagnostics | Not implemented | Unassigned | No dedicated adapter identified |
| V01 | PNG screenshot | Partial | Rust core + catalog forms | `screen.screencap` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2637)) |
| V02 | Screenshot save/copy and mirror snapshot | Partial | Screen UI/media capture | Binary screenshot API and browser data-URL download; snapshot capture verified in Rust/browser fixtures |
| V03 | `screencap` display/all-display/raw output controls | Partial | Rust core + catalog forms | `screen.screencap` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2637)) |
| V04 | Display recording | Partial | Rust core + catalog forms | `screen.screenrecord` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2650)) |
| V05 | Exact `screenrecord` workflow/options | Partial | Rust core + catalog forms | `screen.screenrecord` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2650)) |
| V06 | Real-time video mirror | Partial | scrcpy 3.3.1 media extension | `crates/andrui-media` and `web/src/lib/media`; lossless bounded relays and decoded browser video; real hardware unverified |
| V07 | Audio forwarding/playback | Partial | scrcpy audio/Web Audio | Opus audio protocol/WebCodecs/AudioContext playback and recorder audio track; physical capture/playback unverified |
| V08 | General codec/display/encoder selection | Partial | Media session options | H264/H265/AV1, display/size/FPS/bitrate server parameters; browser codec support gated; full encoder/advanced flags incomplete |
| V09 | `input keyevent` | Partial | Rust core + catalog forms | `input.keyevent` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2700)) |
| V10 | Tap/drag/swipe-like manual interaction | Partial | Rust core + catalog forms | `input.tap` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2721)); `input.swipe` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2753)); `input.draganddrop` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2812)) |
| V11 | Text entry | Partial | Rust core + catalog forms | `input.text` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2871)) |
| V12 | Scroll and modifier keys | Partial | Screen control serializer | Pointer scrolling, key injection and modifier controls; hardware behavior unverified |
| V13 | Full `input` command parameter surface | Partial | Input catalog + Wear controls | `input.rotary` validates finite axis values; Wear UI probes advertised rotary support. Remaining input surface and hardware acceptance are incomplete. |
| V14 | Programmatic multi-touch/gesture sequences | Not implemented | Unassigned | No dedicated adapter identified |
| V15 | Clipboard synchronization | Partial | Bidirectional clipboard | scrcpy serializer and bounded fragmented device-message parser; clipboard framing regression tests |
| V16 | Screen power and stay-awake | Partial | Rust core + catalog forms | `power.wake` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2892)); `power.sleep` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2905)) |
| V17 | Raw framebuffer service | Not implemented | Unassigned | No dedicated adapter identified |
| N01 | `forward LOCAL REMOTE` | Partial | Rust core + catalog forms | `forward.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2919)) |
| N02 | `forward --list` | Partial | Rust core + catalog forms | `forward.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2961)) |
| N03 | `reverse REMOTE LOCAL`, `--list` | Partial | Rust core + catalog forms | `reverse.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3008)); `reverse.list` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3049)) |
| N04 | `forward/reverse --remove`, `--remove-all` | Partial | Rust core + catalog forms | `forward.remove` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2974)); `forward.remove_all` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2995)); `reverse.remove` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3062)); `reverse.remove_all` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3083)) |
| N05 | `--no-rebind` | Partial | Rust core + catalog forms | `forward.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2919)); `reverse.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3008)) |
| N06 | TCP and named socket endpoints | Partial | Rust core + catalog forms | `forward.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L2919)); `reverse.create` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3008)) |
| N07 | `tcp:0` allocated-port handling | Partial | Core forwarding + helper | `forward.create` exposes allocated port stdout; helper session allocates/parses tcp:0 owned mapping |
| N08 | `jdwp`, `vsock`, `dev`, `dev-raw`, `acceptfd` endpoints | Partial | Delegated endpoint strings | Forward/reverse adapters pass endpoint strings; support depends on configured ADB and endpoint type, no acceptfd lifecycle wrapper |
| N09 | Internal forward/reverse reuse | Partial | Automation helper forwarding | Helper owns and cleans its forwarding; no complete shared forwarding reuse policy |
| X01 | `root` | Partial | Rust core + catalog forms | `system.root` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3097)) |
| X02 | `unroot` | Partial | Rust core + catalog forms | `system.unroot` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3112)) |
| X03 | `remount [-R]` | Partial | Rust core + catalog forms | `system.remount` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3125)) |
| X04 | `disable-verity`, `enable-verity` | Partial | Rust core + catalog forms | `system.disable_verity` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3146)); `system.enable_verity` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3159)) |
| X05 | Reboot system/recovery/bootloader | Partial | Rust core + catalog forms | `system.reboot` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3172)) |
| X06 | Other reboot targets and transport-level reboot service | Partial | Rust core + catalog forms | `system.reboot` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3172)) |
| X07 | `sideload OTAPACKAGE` | Partial | Rust core + catalog forms | `system.sideload` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3218)) |
| X08 | `rescue getprop`, `rescue install`, `rescue wipe userdata` | Partial | Rust core + catalog forms | `system.rescue_getprop` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3239)); `system.rescue_install` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3260)); `system.rescue_wipe` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3281)) |
| X09 | Deprecated `backup`, `restore` | Partial | Rust core + catalog forms | `system.backup` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3294)); `system.restore` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3346)) |
| X10 | `cmd testharness enable` | Partial | Rust core + catalog forms | `system.testharness` ([catalog](../crates/andrui-core/src/operations/catalog.rs#L3367)) |
| X11 | SQLite/database inspection | Partial | Rust core inspect | `inspect::database` ([module](../crates/andrui-core/src/inspect/database.rs)): access probe, list, host snapshot with WAL, read-only query, host-copy edit, and confirmed device write-back; browsed in the UI as tables with paged rows, a row editor and SQL (`DatabaseBrowser`); `database_inspect_tests`. Device write-back unverified on hardware. |
| X12 | Device backup-manager control | Not implemented | Unassigned | No dedicated adapter identified |
| X13 | Trade-in-mode diagnostics | Not implemented | Unassigned | No dedicated adapter identified |
| X14 | Incremental `inc-server` and internal client plumbing | Not implemented | Unassigned | No dedicated adapter identified |

## Interpretation

Partial means a dedicated command adapter exists, with incomplete option/device acceptance coverage. It does not establish complete parity for the comparison row. Host support is probed for selected version-specific commands; Android utility availability, permissions and hardware support remain conditional. Generic shell execution is not counted for otherwise missing adapters. No completion percentage is asserted.

## Automation acceptance

| Capability | Current evidence | Remaining verification |
|---|---|---|
| Hierarchy, selectors, click/long-click/text/scroll/wait/assert | `helper-apk/` compiles/signature verifies; `crates/andrui-automation/` mock-helper integration tests; helper install, session start, `/health` and `/hierarchy` exercised on one physical device (Honor DNP-NX9, Android 16 / API 36) | Semantic actions (click/text/scroll/swipe/key) and accessibility fidelity on physical hardware; other vendors and API levels |
| Helper installation and checks | `/automation/helper/{status,install,checks}`; Overview page panel; fake-ADB/mock-helper Rust tests and frontend tests; confirmed install, SHA-256 match and all live checks run on the Android 16 device | Frozen-process detection observed manually (`__refrigerator`), not yet through the checks endpoint on a frozen device |
| Window/display metadata, FLAG_SECURE report, keep-alive | Helper window attributes, `dumpsys`-based secure-window report, typed screenshot errors and `X-Andrui-Secure-*` headers, HTTP/1.1 keep-alive; verified on the Android 16 device (secure banking window detected; screenshot blanked, not failed) | Multiple displays; Android < 11 window listing; `dumpsys` format on other vendors/versions; `secure_window_blocked` path (not produced on the test device) |
| Accessibility events | Helper sequenced ring buffer; Rust WebSocket relay and UI reader | Physical-device event fidelity |
| OCR | Actual Tesseract process adapter, multipart UI, TSV parser and unavailable-dependency tests | Tesseract not installed/discoverable; no real OCR execution |
| Template matching | Bounded actual ZNCC/NMS implementation and exact/negative image tests; browser form | Real screenshots and visual false-positive evaluation |
| Action recording/replay | Successful semantic actions recorded, persisted, cancellation/events; API tests and browser controls | Physical-device replay and timing fidelity |
| Workflows | Catalog commands, semantic helper actions, waits/assertions and screenshot artifacts; concurrent device runs; persisted step reports/cancellation; JSON/JUnit/CLI and supported Appium export; API/helper/browser fixtures | Physical-device sequencing, vendor behavior, real Appium and large coordinated device sets |
| Shared mutation coordination | Core job locks shared with helper startup/actions/replay | Mirroring control and free interactive shell are separate interactive channels |
| Screen/media | Integrated pinned server/client; 19 Rust media tests and browser capture checks; video/audio/control/recording implemented | Live codecs/audio/control/recording hardware acceptance; host recording API explicitly 501 |

## Known incomplete core surfaces

The unmapped rows above remain required scope. Mapped rows also lack full command/flag parity: global ADB environment/server options; transport selectors beyond serial; binary exec-in/out jobs; PTY escape/shell-v2 option forms; installer sessions/staged/APEX/incremental acceptance; full intent extras; full logcat/logd options; JDWP/WebView transports; profiles/heaps/ART/Perfetto tools; framebuffer/advanced display controls; database inspection; backups/trade-in/administrative commands. File pulls and bugreports with omitted destinations now produce browser artifacts; explicitly supplied host paths retain their existing behavior. The UI is a working initial workstation, not the entire final specification.

## Status

### AI assistance, device profiles and integration workflows — 2026-11-17

Added contextual evidence-reviewed HTTP model assistance, provider/model probes, validated workflow proposals, saved reports, persistent scoped MCP approvals and stop controls. Semantic actions now run through the operation/job/workflow catalog; alternate coordinate input also requires agent approval. MCP observations expose the newer inspection scopes, require unambiguous targeting and wait for completed log captures. Explicit browser targets survive disconnects and initial-load races.

Added device profiles/aliases and saved endpoint reconnection, connection guidance, TV/Wear controls (rotary enabled only after a device support probe), optional round watch previews, a manual device gallery and a correlated device timeline with diagnostic snapshots. Added managed pull/bugreport/PNG artifacts, install-launch-capture workflow creation, owned AVD discovery/launch/stop and emulator checkpoint controls. Workflow run reports include per-device assertions and cancellation outcomes, JSON/JUnit/CLI output and a supported semantic Appium export. Details and boundaries: [UX_AI_DEVICE_ENHANCEMENTS.md](UX_AI_DEVICE_ENHANCEMENTS.md).

Executed verification: Rust formatting and workspace Clippy passed; **139 Rust tests** passed. Frontend typecheck, **119 tests** and production build passed. Existing real-server API smoke passed **62 checks**. The new real-browser/server enhancement acceptance passed profile aliases and TV input, reviewed model requests and generated workflow saving, JSON/JUnit CLI success/failure, exported Python against a WebDriver protocol fixture, file/bugreport/PNG downloads, timeline and agent stop behavior. Both model and device behavior used local fixtures. A local amd64 `.deb` was built with the standard release/license generators and cargo-deb; dpkg-deb metadata and inclusion of the current frontend were checked. The package was not installed or published.

Final Chromium acceptance passed **134 workspace/Operations checks across 14 views**, empty and populated Jobs dragging (290/410 px), saved height/expansion, 120x40 PTY resize, screenshots and WebSocket jobs, with no page errors. The resize check waits for the drawer opening animation before computing raw pointer coordinates; its geometry/persistence assertions remain unchanged. The frontend retains the bundle-size warning and React test `act` warnings. Real model quality, physical TV/Wear/foldable input, live SDK emulator boot/snapshots, real Appium/device operation and package installation remain unverified. No destructive commands or helper installations were executed on physical devices. The ledger retains all 164 comparison IDs; V13 is Partial for the rotary adapter, not complete input-command parity.

### Jobs panel resize fix — 2026-11-11

Removed the empty-list guards that hid the Jobs resize handle and prevented expansion. Dragging the top edge or Jobs title now resizes the panel without a jump; keyboard resizing uses the actual visible height, and customized heights persist across reloads. The default empty state remains compact until resized.

Verification: `npm --prefix web test` passed 103 tests, including empty-panel resize/expand/restore/persistence in `web/src/test/job-drawer.test.tsx`; `npm --prefix web run build` passed. Updated `tests/smoke/browser-smoke.mjs` verified actual pointer dragging to 290px with no jobs and 410px via the title with jobs, empty-panel expansion/restoration, saved height after reload, and no sidebar overlap. All 134 workspace/Operations browser checks also passed, with no page errors. Browser execution used fake ADB; no hardware checks were repeated. Existing build-size and test-environment warnings remain.

### Unified parent workspaces and Operations-only menus — 2026-11-11

All working sub-tabs are merged into their parent pages. The right sidebar exposes only Operations beneath pages with a catalog; AI Integration and Settings have no children. Parent clicks and page shortcuts return to the merged workspace. Layout's catalog is again a separate Operations child. Automation renders all five tools together in one retained instance. Workspace drafts, uploads, terminal/viewer instances, and active streams remain mounted while Operations is open.

Duplicate system-status, installation-result, and MCP/skill summaries were removed. Applications keeps permission assessment in the APK Toolkit and retains a distinct AppOps inspector without repeated permission KPI cards. Existing forms and operation catalogs remain available.

Executed verification: `npm --prefix web run typecheck`, `npm --prefix web test` (102 tests), and `npm --prefix web run build` passed. Chromium passed 134 workspace/Operations checks across 14 views at 320, 390, 768, 1024, and 1440 pixels, rejecting extra child tabs and duplicate KPI labels. It also verified AppOps-only application summaries, all automation tools visible together, retained file selections/drafts, live PTY preservation and 120x40 resize, screenshot preservation, API jobs, and WebSocket events. No browser page errors occurred. The coverage audit retains all 164 identifiers without errors. Checks used fake ADB; hardware behavior was not reverified. Existing bundle-size and test-environment warnings remain.

### Right sidebar and combined workspaces — 2026-11-11

The primary menu now sits on the right and opens section navigation as an accordion beneath the active menu item. The mobile menu opens from the right; the docked Jobs panel fits beside the desktop menu. Screen combines mirror/capture, input/clipboard, and stream settings. Layout combines hierarchy/actions, helper/protocol information, and Operations. Network combines forwarding, reverse tunnels, and proxy/traffic controls; Screen and Network retain separate Operations sections. Existing forms, controls, KPI data, and session lifecycles are preserved.

Verification for this revision: `npm --prefix web run typecheck`, `npm --prefix web test` (102 tests), and `npm --prefix web run build` passed. Updated Chromium smoke coverage passed 244 section/layout checks across all 14 views at 320, 390, 768, 1024, and 1440 pixels, including accordion collapse/expansion, combined controls, retained terminal/viewer instances, and an open Jobs drawer; no page errors. The feature-coverage audit still reports 164 identifiers and no errors. Tests used fake ADB; no hardware checks were repeated. The existing bundle-size and test-environment warnings remain.

### Sub-tab and assessment update — 2026-11-11

All 14 main views now group their existing workflows into task-focused sub-tabs, with compact KPIs, status widgets, and responsive work areas. Tab selection persists for the browser session; visited panels remain mounted while switching sub-tabs. Read-only stats now include display, boot, proxy, process-memory, and explicit package permission/AppOps inspection. These additions do not establish new command parity for the requirement rows above.

Acceptance evidence: `web/src/test/page-tabs.test.tsx`, `inspection-stats.test.ts`, and `stats-polling.test.tsx`; fake-ADB collector tests in `crates/andrui-core/src/stats/mod.rs`; and `tests/smoke/browser-smoke.mjs` covering all sub-tabs, responsive layout, retained PTY/viewer instances, and process/package widgets against the real API.

Executed checks: frontend typecheck and production build; 101 frontend tests; Rust formatting, workspace Clippy, and 118 Rust tests; 62 API smoke checks; 274 Chromium sub-tab/layout checks across 14 pages at 320, 390, 768, 1024, and 1440 pixels, including an open Jobs drawer. Coverage audit retains all 164 identifiers with no errors. Browser and API verification used fake ADB and temporary application storage. Physical-device metrics, live scrcpy/audio/recording continuity, and recovery behavior were not exercised in this update. Existing Vite bundle-size and frontend test-environment warnings remain.

### Earlier delivery verification

Updated 2026-11-10 (version 1.0.0).

**Delivered:** Rust/Axum server, React/TypeScript UI with 13 pages, SQLite persistence, serial device
targeting, typed ADB command catalog with previews and forms, background jobs (stdout/stderr/status/
cancellation), artifacts, file listing, PTY shell, operation workflows, built-in mDNS device
discovery, automation helper (hierarchy/actions/events, OCR and template matching, recording/replay),
and screen mirroring (pinned scrcpy server, browser video/audio/control, screenshots, bounded browser
recording). Distribution is a `.deb` with a systemd user service (`docs/PACKAGING.md`).

**Verified:** `cargo fmt`/clippy clean and 71 Rust tests; TypeScript check, 66 frontend tests and
production build; fake-ADB API smoke suite; Chromium checks of all pages, jobs, WebSocket events,
terminal input/resize and screen mirroring against a physical device. The `.deb` was built,
installed with apt, and the user service ran under systemd. Helper install, session start and live
checks were exercised on one physical Android 16 device (Honor DNP-NX9).

**Limitations:** Catalog mappings are not complete feature coverage; no full-parity percentage is
claimed. Semantic automation steps are not yet unified with core workflows. Semantic actions on
hardware, codec/audio/input fidelity across devices, privileged/recovery operations and wireless
pairing remain unverified. Host recording-to-artifact routes return 501 (browser recording downloads
work). Firefox with hardware video decoding may decode no frames; the UI reports it instead of
showing a blank screen. The production bundle triggers Vite's chunk-size warning.


### UI refinement verification — 2026-11-17

The device workbench now leads with connection summaries and the device roster. Profile editing is disclosed on demand; common tasks use action tiles; gallery, timeline, AVD and AI widgets share consistent headers and spacing. AI configuration tiles model settings, permissions and saved reports, and the expanded assistant separates evidence review from the request. Responsive layouts stack these widgets on smaller screens. Selecting a workspace dismisses mobile navigation.

Verification: frontend typecheck and production build passed; 119 frontend tests passed; Chromium browser smoke passed 134 workspace checks; all seven AI/device acceptance groups passed. The new `tests/smoke/ui-layout-smoke.mjs` captured 78 screenshots spanning all 14 workspaces at 1440/768/390 pixels, desktop light mode, lower sections and expanded widgets, with no page errors or horizontal workspace overflow. Contact sheets and expanded assistant/device views were visually inspected. All device execution used fake ADB; physical-device behavior and Firefox remain unverified in this UI pass. This changes presentation and navigation, not command coverage. Existing Vite bundle-size and React test `act` warnings remain.
