#!/usr/bin/env bash
# build-deb.sh - Build the AndruiTerminal .deb package with cargo-deb.
#
# Builds the frontend, the automation helper APK (only when stale) and the release
# binary, then packages them. Output: target/debian/andrui-terminal_<version>_<arch>.deb
#
# Needs: cargo-deb (cargo install cargo-deb), npm, and a JDK + Android SDK for the helper.
# This script does NOT install system software.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
cd "$WORKSPACE_ROOT"

if ! cargo deb --version >/dev/null 2>&1; then
  echo "ERROR: cargo-deb is not installed. Install it with: cargo install cargo-deb" >&2
  exit 1
fi

echo "Building frontend..."
(cd web && npm ci && npm run build)

# Rebuild the helper only when its sources changed, so its hash stays stable for installed devices.
HELPER_DIR="${WORKSPACE_ROOT}/helper-apk"
HELPER_APK="${HELPER_DIR}/build/andrui-helper.apk"
if [[ ! -f "$HELPER_APK" ]] || [[ -n "$(find "${HELPER_DIR}/src" "${HELPER_DIR}/AndroidManifest.xml" "${HELPER_DIR}/build.py" -newer "$HELPER_APK" -print -quit)" ]]; then
  echo "Building automation helper APK..."
  if ! python3 "${HELPER_DIR}/build.py"; then
    echo "ERROR: automation helper build failed. It needs a JDK and an Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT)." >&2
    exit 1
  fi
fi

echo "Building release binary..."
cargo build --locked --release --bin andrui-terminal

echo "Generating third-party license notices..."
TARGET_DIR="$(cargo metadata --format-version 1 --no-deps --locked | python3 -I -c 'import json,sys; print(json.load(sys.stdin)["target_directory"])')"
python3 -I "${SCRIPT_DIR}/third-party-licenses.py" "${TARGET_DIR}/release/THIRD-PARTY-LICENSES"

echo "Packaging..."
cargo deb -p andrui-terminal --no-build "$@"
