#!/usr/bin/env bash
# fake-adb-env.sh - Environment configuration for deterministic fake ADB testing
# Usage:
#   source tests/smoke/fake-adb-env.sh [scenario]
# Or:
#   ./tests/smoke/fake-adb-env.sh [scenario]

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

SCENARIO="${1:-${FAKE_ADB_SCENARIO:-full_states}}"
FIXTURES_BIN="${WORKSPACE_ROOT}/tests/fixtures"

export PATH="${FIXTURES_BIN}:${PATH}"
export ANDRUI_ADB_PATH="${FIXTURES_BIN}/adb"
export FAKE_ADB_SCENARIO="${SCENARIO}"
export FAKE_ADB_DATA_DIR="${WORKSPACE_ROOT}/tests/fixtures/data"

echo "Configured environment for Fake ADB:"
echo "  ADB Binary: $ANDRUI_ADB_PATH"
echo "  Scenario:   $FAKE_ADB_SCENARIO"
echo "  Data Dir:   $FAKE_ADB_DATA_DIR"
echo "Run 'adb version' or 'adb devices -l' to verify."
