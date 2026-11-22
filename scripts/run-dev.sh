#!/usr/bin/env bash
# run-dev.sh - Run AndruiTerminal from the source tree (not the installed package).
# Uses port 19811 and .runtime/ for data so it can run next to the installed service (19801).
#   andrui-terminal serve --bind 127.0.0.1:19811 --adb /path/to/adb --data-dir PATH --web-dir web/dist
#
# This script does NOT install system software. It verifies local prerequisites and runs the server.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Defaults
BIND="${ANDRUI_BIND:-127.0.0.1:19811}"
DATA_DIR="${ANDRUI_DATA_DIR:-${WORKSPACE_ROOT}/.runtime/data}"
WEB_DIR="${ANDRUI_WEB_DIR:-${WORKSPACE_ROOT}/web/dist}"
ADB_PATH="${ANDRUI_ADB_PATH:-}"
BINARY="${ANDRUI_BINARY:-}"
HELPER_APK="${ANDRUI_HELPER_APK:-}"
BUILD_HELPER=1
BUILD_CARGO="${ANDRUI_BUILD:-0}"

# Parse command line overrides
while [[ $# -gt 0 ]]; do
  case "$1" in
    --build)
      BUILD_CARGO=1
      shift
      ;;
    --bind)
      BIND="$2"
      shift 2
      ;;
    --adb)
      ADB_PATH="$2"
      shift 2
      ;;
    --data-dir)
      DATA_DIR="$2"
      shift 2
      ;;
    --web-dir)
      WEB_DIR="$2"
      shift 2
      ;;
    --binary)
      BINARY="$2"
      shift 2
      ;;
    --helper-apk)
      HELPER_APK="$2"
      shift 2
      ;;
    --no-helper)
      BUILD_HELPER=0
      shift
      ;;
    -h|--help)
      echo "Usage: $0 [options]"
      echo "Options:"
      echo "  --build             Build backend (cargo) and frontend (web) before starting"
      echo "  --bind ADDR:PORT    Bind address (default: 127.0.0.1:19811)"
      echo "  --adb PATH          Path to adb executable (default: system adb; fixtures require explicit --adb)"
      echo "  --data-dir PATH     Application data directory (default: .runtime/data)"
      echo "  --web-dir PATH      Frontend static distribution directory (default: web/dist)"
      echo "  --binary PATH       Path to andrui-terminal binary"
      echo "  --helper-apk PATH   Use this automation helper APK instead of building helper-apk/"
      echo "  --no-helper         Do not build or configure the automation helper APK"
      exit 0
      ;;
    *)
      break
      ;;
  esac
done

# Build backend and frontend if requested
if [[ "$BUILD_CARGO" == 1 ]]; then
  echo "Building andrui-terminal binary (cargo build --bin andrui-terminal)..."
  (cd "${WORKSPACE_ROOT}" && cargo build --bin andrui-terminal)
  echo "Building web frontend (npm run build)..."
  (cd "${WORKSPACE_ROOT}/web" && npm run build)
fi

# Locate binary
if [[ -z "$BINARY" ]]; then
  RELEASE_BIN="${WORKSPACE_ROOT}/target/release/andrui-terminal"
  DEBUG_BIN="${WORKSPACE_ROOT}/target/debug/andrui-terminal"
  if [[ -x "$RELEASE_BIN" && -x "$DEBUG_BIN" ]]; then
    if [[ "$RELEASE_BIN" -nt "$DEBUG_BIN" ]]; then
      BINARY="$RELEASE_BIN"
    else
      BINARY="$DEBUG_BIN"
    fi
  elif [[ -x "$RELEASE_BIN" ]]; then
    BINARY="$RELEASE_BIN"
  elif [[ -x "$DEBUG_BIN" ]]; then
    BINARY="$DEBUG_BIN"
  elif command -v andrui-terminal >/dev/null 2>&1; then
    BINARY="$(command -v andrui-terminal)"
  else
    echo "ERROR: andrui-terminal binary not found." >&2
    echo "Build the binary using Cargo: cargo build --bin andrui-terminal (or run with --build)" >&2
    exit 1
  fi
fi

# Locate ADB
if [[ -z "$ADB_PATH" ]]; then
  if command -v adb >/dev/null 2>&1; then
    ADB_PATH="$(command -v adb)"
  else
    echo "ERROR: ADB not found. Configure --adb explicitly; test fixtures are never selected automatically." >&2
    exit 1
  fi
fi

# Check frontend directory
if [[ ! -d "$WEB_DIR" ]]; then
  echo "WARNING: Frontend distribution directory not found at: $WEB_DIR" >&2
  echo "Static web assets may not be served until built: (cd web && npm run build)" >&2
fi

# Automation helper APK: build helper-apk/ when its sources changed, and use it by default.
# Rebuilding only when stale keeps the APK hash stable, so the installed helper is not flagged as outdated.
if [[ "$BUILD_HELPER" == 1 && -z "$HELPER_APK" ]]; then
  HELPER_DIR="${WORKSPACE_ROOT}/helper-apk"
  HELPER_APK="${HELPER_DIR}/build/andrui-helper.apk"
  if [[ ! -f "$HELPER_APK" ]] || [[ -n "$(find "${HELPER_DIR}/src" "${HELPER_DIR}/AndroidManifest.xml" "${HELPER_DIR}/build.py" -newer "$HELPER_APK" -print -quit)" ]]; then
    echo "Building automation helper APK..."
    if ! python3 "${HELPER_DIR}/build.py"; then
      echo "ERROR: automation helper build failed. It needs a JDK and an Android SDK (ANDROID_HOME or ANDROID_SDK_ROOT)." >&2
      echo "Fix the build, pass --helper-apk PATH, or start without the helper using --no-helper." >&2
      exit 1
    fi
  fi
fi
if [[ -n "$HELPER_APK" && ! -f "$HELPER_APK" ]]; then
  echo "ERROR: helper APK not found at: $HELPER_APK" >&2
  exit 1
fi

# Ensure data directory exists
mkdir -p "$DATA_DIR"

echo "Starting AndruiTerminal (development):"
echo "  Binary:   $BINARY"
echo "  Bind:     $BIND"
echo "  ADB:      $ADB_PATH"
echo "  Data Dir: $DATA_DIR"
echo "  Web Dir:  $WEB_DIR"
echo "  Helper:   ${HELPER_APK:-disabled}"

exec "$BINARY" serve \
  --bind "$BIND" \
  --adb "$ADB_PATH" \
  --data-dir "$DATA_DIR" \
  --web-dir "$WEB_DIR" \
  ${HELPER_APK:+--helper-apk "$HELPER_APK"} \
  "$@"
