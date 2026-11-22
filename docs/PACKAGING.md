# Packaging and releases

AndruiTerminal ships as a Debian package built with cargo-deb. It installs a per-user systemd
service that serves the UI and `/api/v1` on `http://127.0.0.1:19801`.

## Building
```bash
cargo install cargo-deb      # once, user-level
./scripts/build-deb.sh       # builds web/, helper APK (if stale), release binary, then the .deb
```
Output: `target/debian/andrui-terminal_<version>-1_<arch>.deb`. Packaging metadata lives in
`[package.metadata.deb]` of `crates/andrui-terminal/Cargo.toml`. The build also generates
`THIRD-PARTY-LICENSES` with `scripts/third-party-licenses.py`.

## Installing and running
```bash
sudo apt install ./target/debian/andrui-terminal_<version>-1_amd64.deb   # path printed by build-deb.sh
systemctl --user enable --now andrui-terminal
journalctl --user -u andrui-terminal -f    # logs
```
Then open `http://127.0.0.1:19801`. After installing an upgrade, run
`systemctl --user restart andrui-terminal`.

The unit is a *user* service: `systemctl --user list-unit-files andrui-terminal.service` shows it
even while stopped; plain `systemctl` (system manager) does not.

## Versioning and releases
The one version number is `[workspace.package] version` in the root `Cargo.toml`. All crates
inherit it, the web build embeds it (read by `web/vite.config.ts`), and cargo-deb uses it for the
package. It is reported by `andrui-terminal --version`, `GET /api/v1/health` and the sidebar. When an
open browser tab was built for a different version than the running server (e.g. after an upgrade),
the UI shows a reload banner.

To release:
```bash
./scripts/bump-version.sh 1.1.0   # Cargo.toml, Cargo.lock, web/package.json(+lock)
./scripts/build-deb.sh
```
The Android helper APK is versioned separately in `helper-apk/AndroidManifest.xml`.

## Dependencies (resolved by apt)
| Package | Purpose |
|---|---|
| `adb` | Distro AOSP build of ADB; all device operations |
| `tesseract-ocr` | OCR (pulls in English); add `tesseract-ocr-<lang>` for more languages |
| `android-sdk-platform-tools-common` | udev rules for Android USB devices |
| `$auto` (libc etc.) | Shared libraries detected from the binary |

## Installed paths
| Component | Path |
|---|---|
| Binary | `/usr/bin/andrui-terminal` |
| Web assets | `/usr/share/andrui-terminal/web/` |
| Pinned scrcpy server | `/usr/share/andrui-terminal/scrcpy-server-v3.3.1` |
| Automation helper APK | `/usr/share/andrui-terminal/andrui-helper.apk` |
| systemd user unit | `/usr/lib/systemd/user/andrui-terminal.service` (source: `packaging/`) |
| Copyright, scrcpy license/notice, `THIRD-PARTY-LICENSES` | `/usr/share/doc/andrui-terminal/` |
| Persistent data (per user) | `~/.local/share/andrui-terminal/` (SQLite `andrui.db`, artifacts) |
