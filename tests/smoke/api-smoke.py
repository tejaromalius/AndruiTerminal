#!/usr/bin/env python3
"""
api-smoke.py - Comprehensive smoke test for AndruiTerminal deployment and fake ADB fixture.

Validates:
1. Fake ADB fixture: version, help, devices full states, getprop, shell, install,
   forward, logging, error handling, binary streaming, and hang/cancellation simulation.
2. Contract HTTP API: /health, /session (CSRF token), /operations, /devices,
   job execution, job failure, job cancellation (/jobs/:id/cancel), and artifacts
   lifecycle (upload, list, download, delete) using temporary directories.
"""

import sys
import os
import time
import json
import shutil
import tempfile
import subprocess
import urllib.request
import urllib.error
import urllib.parse
import http.cookiejar
import socket
from pathlib import Path

# Paths
WORKSPACE_ROOT = Path(__file__).resolve().parent.parent.parent
FIXTURES_DIR = WORKSPACE_ROOT / "tests" / "fixtures"
FAKE_ADB_BIN = FIXTURES_DIR / "fake_adb.py"
DATA_DIR = FIXTURES_DIR / "data"

TEST_PASSED = 0
TEST_FAILED = 0


def log_step(name: str):
    print(f"\n===> [TEST] {name}")


def assert_true(cond: bool, msg: str):
    global TEST_PASSED, TEST_FAILED
    if cond:
        print(f"  [PASS] {msg}")
        TEST_PASSED += 1
    else:
        print(f"  [FAIL] {msg}")
        TEST_FAILED += 1
        raise AssertionError(msg)


# ==============================================================================
# 1. Fake ADB Fixture Verification
# ==============================================================================
def test_fake_adb_fixture(env_overrides=None):
    log_step("Verifying Fake ADB Fixture Functional Scenarios")

    env = os.environ.copy()
    if env_overrides:
        env.update(env_overrides)
    env["FAKE_ADB_DATA_DIR"] = str(DATA_DIR)

    # 1. Version
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "version"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0, "fake adb version exits with code 0")
    assert_true("Version 34.0.4" in res.stdout, "fake adb version matches 34.0.4")

    # 2. Help
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "help"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0, "fake adb help exits with code 0")
    assert_true("Android Debug Bridge" in res.stdout, "fake adb help contains ADB header")

    # 3. Devices Full States
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "devices"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0, "fake adb devices exits with code 0")
    assert_true("List of devices attached" in res.stdout, "devices output contains header")
    for st in ["device", "offline", "unauthorized", "recovery", "sideload", "bootloader", "authorizing", "connecting"]:
        assert_true(st in res.stdout, f"devices output includes state '{st}'")

    # 4. Devices Long Format (-l)
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "devices", "-l"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0, "fake adb devices -l exits with code 0")
    assert_true("transport_id:" in res.stdout, "devices -l includes transport IDs")
    assert_true("model:" in res.stdout, "devices -l includes model metadata")

    # 5. Getprop (full and specific)
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "shell", "getprop", "ro.product.model"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0, "fake adb shell getprop ro.product.model exits with code 0")
    assert_true("Pixel 8 Pro" in res.stdout or len(res.stdout.strip()) > 0, "getprop returns device model")

    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "shell", "getprop"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0, "fake adb shell getprop (all) exits with code 0")
    assert_true("[ro.build.version.sdk]: [34]" in res.stdout, "getprop includes SDK 34")

    # 6. Shell execution and exit codes
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "shell", "echo", "AndruiTerminal"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0 and "AndruiTerminal" in res.stdout, "shell echo returns expected string")

    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "shell", "exit", "42"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 42, "shell exit 42 preserves exact exit code 42")

    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "shell", "false"], capture_output=True, text=True, env=env)
    assert_true(res.returncode != 0, "shell false returns non-zero exit code")

    # 7. Package Install (success and failure scenarios)
    sample_apk = DATA_DIR / "sample.apk"
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "install", str(sample_apk)], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0 and "Success" in res.stdout, "valid apk install succeeds")

    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "install", "invalid_package.apk"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 1 and "Failure" in res.stderr, "invalid apk install fails with Failure in stderr")

    # 8. Port Forwarding
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "forward", "--list"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0 and "tcp:" in res.stdout, "forward --list returns active forwards")

    # 9. Logging (logcat dump)
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "logcat", "-d"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 0 and "ActivityManager" in res.stdout, "logcat -d returns log entries")

    # 10. Binary streaming (exec-out screencap)
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "exec-out", "screencap", "-p"], capture_output=True, env=env)
    assert_true(res.returncode == 0, "exec-out screencap exits with 0")
    assert_true(res.stdout[:8] == b"\x89PNG\r\n\x1a\n", "exec-out screencap produces valid PNG magic bytes")

    # 11. Error scenarios (device targeting)
    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "-s", "nonexistent", "shell", "echo", "test"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 1 and "error: device 'nonexistent' not found" in res.stderr, "targeting nonexistent device produces error")

    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "-s", "offline-device-01", "shell", "echo", "test"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 1 and "error: device offline" in res.stderr, "targeting offline device produces offline error")

    res = subprocess.run([sys.executable, str(FAKE_ADB_BIN), "-s", "unauth-device-02", "shell", "echo", "test"], capture_output=True, text=True, env=env)
    assert_true(res.returncode == 1 and "error: device unauthorized" in res.stderr, "targeting unauthorized device produces unauthorized error")

    # 12. Hang and Cancellation scenario
    hang_env = env.copy()
    hang_env["FAKE_ADB_HANG"] = "1"
    t_start = time.time()
    proc = subprocess.Popen([sys.executable, str(FAKE_ADB_BIN), "shell", "hang"], env=hang_env, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    time.sleep(0.3)
    assert_true(proc.poll() is None, "fake adb hangs when FAKE_ADB_HANG=1 is set")
    proc.terminate()
    try:
        proc.wait(timeout=2.0)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    t_elapsed = time.time() - t_start
    assert_true(t_elapsed >= 0.25, f"hang scenario duration sustained until cancelled ({t_elapsed:.2f}s)")


def test_http_api_endpoints(base_url: str):
    log_step(f"Verifying HTTP API Contract Endpoints against {base_url}")

    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def req(path: str, method="GET", data=None, headers=None):
        url = f"{base_url.rstrip('/')}{path}"
        req_headers = {"User-Agent": "AndruiTerminal-SmokeTest", "Origin": base_url.rstrip("/")}
        if headers:
            req_headers.update(headers)
        body_bytes = None
        if data is not None:
            if isinstance(data, (dict, list)):
                body_bytes = json.dumps(data).encode("utf-8")
                req_headers["Content-Type"] = "application/json"
            elif isinstance(data, bytes):
                body_bytes = data
            elif isinstance(data, str):
                body_bytes = data.encode("utf-8")

        req_obj = urllib.request.Request(url, data=body_bytes, headers=req_headers, method=method)
        try:
            with opener.open(req_obj, timeout=10) as resp:
                status = resp.status
                content = resp.read()
                return status, content
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    # 1. /health
    st, body = req("/api/v1/health")
    if st == 404:
        st, body = req("/health")
    assert_true(st == 200, "GET /health returned HTTP 200")
    health_data = json.loads(body.decode("utf-8"))
    assert_true(health_data.get("status") == "ok", "/health status is 'ok'")

    # 2. /session (CSRF token extraction)
    st, body = req("/api/v1/session")
    if st == 404:
        st, body = req("/session")
    assert_true(st == 200, "GET /session returned HTTP 200")
    session_data = json.loads(body.decode("utf-8"))
    csrf_token = session_data.get("csrfToken")
    assert_true(bool(csrf_token), "Retrieved a CSRF token")

    auth_headers = {"X-CSRF-Token": csrf_token}

    # 3. /operations
    st, body = req("/api/v1/operations")
    if st == 404:
        st, body = req("/operations")
    assert_true(st == 200, "GET /operations returned HTTP 200")
    ops = json.loads(body.decode("utf-8"))
    assert_true(isinstance(ops, list) and len(ops) > 0, "GET /operations returned non-empty list")

    # 4. /devices
    st, body = req("/api/v1/devices")
    if st == 404:
        st, body = req("/devices")
    assert_true(st == 200, "GET /devices returned HTTP 200")
    devs = json.loads(body.decode("utf-8"))
    assert_true(isinstance(devs, list), "GET /devices returned device list")
    states = [d.get("state") for d in devs if isinstance(d, dict)]
    assert_true("device" in states, "GET /devices contains at least one online device")

    # 5. Job Execution (Success Scenario)
    job_payload = {
        "operationId": "shell.exec",
        "deviceId": "RF8M10ABCDE",
        "parameters": {"command": "echo Andrui"},
        "confirmed": True,
    }
    st, body = req("/api/v1/jobs", method="POST", data=job_payload, headers=auth_headers)
    assert_true(st in (200, 201, 202), f"POST /jobs returned HTTP {st}")
    job_data = json.loads(body.decode("utf-8"))
    job_id = job_data["id"]
    assert_true(bool(job_id), f"Created job id: {job_id}")

    def wait_job(jid):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            status, payload = req(f"/api/v1/jobs/{jid}")
            assert status == 200, payload
            job = json.loads(payload)
            if job['status'] in ('completed', 'failed', 'cancelled'):
                return job
            time.sleep(0.05)
        raise AssertionError('Job did not finish: ' + jid)

    job_status = wait_job(job_id)
    assert_true(job_status['status'] == 'completed', 'Echo job completed')
    assert_true('Andrui' in job_status['stdout'], 'Actual subprocess stdout captured')
    assert_true(job_status.get('exitCode') == 0, 'Successful exit code preserved')

    # 6. Job Execution (Failure Scenario)
    fail_payload = {
        "operationId": "shell.exec",
        "deviceId": "RF8M10ABCDE",
        "parameters": {"command": "false"},
        "confirmed": True,
    }
    st, body = req("/api/v1/jobs", method="POST", data=fail_payload, headers=auth_headers)
    assert_true(st in (200, 201, 202), f"POST /jobs for failing command returned HTTP {st}")
    fail_job = json.loads(body.decode("utf-8"))
    fail_result = wait_job(fail_job['id'])
    assert_true(fail_result['status'] == 'failed', 'Nonzero process fails the job')
    assert_true(fail_result.get('exitCode', 0) != 0, 'Nonzero exit status is preserved')
    assert_true(bool(fail_result['stderr']), 'Failure stderr captured')

    # 7. Job Cancellation Scenario
    hang_payload = {
        "operationId": "shell.exec",
        "deviceId": "RF8M10ABCDE",
        "parameters": {"command": "sleep 99"},
        "confirmed": True,
    }
    st, body = req("/api/v1/jobs", method="POST", data=hang_payload, headers=auth_headers)
    hang_job = json.loads(body.decode("utf-8"))
    hang_jid = hang_job["id"]

    # Cancel the hanging job
    st, body = req(f"/api/v1/jobs/{hang_jid}/cancel", method="POST", headers=auth_headers)
    assert_true(st == 200, f"POST /jobs/{hang_jid}/cancel returned HTTP 200")
    cancel_data = wait_job(hang_jid)
    assert_true(cancel_data.get("status") == "cancelled", "Cancelled job has status 'cancelled'")

    # 8. Artifacts lifecycle (Upload, List, Download, Delete)
    test_artifact_payload = b"Sample Binary Artifact Payload 123456"
    art_headers = auth_headers.copy()
    boundary = 'andrui-smoke-boundary'
    art_headers["Content-Type"] = "multipart/form-data; boundary=" + boundary
    multipart = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="sample.bin"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()
                 + test_artifact_payload + f'\r\n--{boundary}--\r\n'.encode())
    st, body = req("/api/v1/artifacts", method="POST", data=multipart, headers=art_headers)
    assert_true(st in (200, 201), f"POST /artifacts returned HTTP {st}")
    art_data = json.loads(body.decode("utf-8"))
    art_id = art_data["id"]
    assert_true(bool(art_id), f"Created artifact id: {art_id}")

    # List artifacts
    st, body = req("/api/v1/artifacts")
    assert_true(st == 200, "GET /artifacts returned HTTP 200")
    artifacts_list = json.loads(body.decode("utf-8"))
    assert_true(any(a["id"] == art_id for a in artifacts_list), f"Artifact {art_id} found in GET /artifacts list")

    # Download artifact
    st, body = req(f"/api/v1/artifacts/{art_id}")
    assert_true(st == 200, f"GET /artifacts/{art_id} returned HTTP 200")
    assert_true(body == test_artifact_payload, "Downloaded artifact content matches uploaded binary bytes exactly")

    # Delete artifact
    st, body = req(f"/api/v1/artifacts/{art_id}", method="DELETE", headers=auth_headers)
    assert_true(st == 200, f"DELETE /artifacts/{art_id} returned HTTP 200")


# ==============================================================================
# Main Runner
# ==============================================================================
def main():
    import argparse

    parser = argparse.ArgumentParser(description="AndruiTerminal Smoke Test Runner")
    parser.add_argument("--base-url", default=None, help="Existing server URL to test against")
    parser.add_argument("--binary", default=None, help="Path to andrui-terminal binary to spawn")
    parser.add_argument("--skip-api", action="store_true", help="Skip HTTP API tests and run only fake ADB checks")
    args = parser.parse_args()

    # Step 1: Run fake ADB fixture checks
    test_fake_adb_fixture()

    if args.skip_api:
        print(f"\nAll fake ADB tests passed: {TEST_PASSED} passed, {TEST_FAILED} failed.")
        sys.exit(0)

    # Step 2: HTTP API tests
    if args.base_url:
        test_http_api_endpoints(args.base_url)
    elif args.binary and os.path.exists(args.binary):
        # Spawn the real binary using temporary directories
        temp_dir = tempfile.mkdtemp(prefix="andrui-smoke-")
        try:
            data_dir = os.path.join(temp_dir, "data")
            web_dir = os.path.join(temp_dir, "dist")
            os.makedirs(data_dir, exist_ok=True)
            os.makedirs(web_dir, exist_ok=True)
            with socket.socket() as reservation:
                reservation.bind(('127.0.0.1', 0))
                port = reservation.getsockname()[1]
            bind_addr = f"127.0.0.1:{port}"

            env = os.environ.copy()
            env["PATH"] = f"{FIXTURES_DIR}:{env.get('PATH', '')}"
            proc = subprocess.Popen(
                [args.binary, "serve", "--bind", bind_addr, "--adb", str(FAKE_ADB_BIN), "--data-dir", data_dir, "--web-dir", web_dir],
                env=env,
            )
            try:
                deadline = time.monotonic() + 15
                while time.monotonic() < deadline:
                    if proc.poll() is not None:
                        raise AssertionError('Backend exited during startup')
                    try:
                        with urllib.request.urlopen(f'http://{bind_addr}/api/v1/health', timeout=1) as response:
                            if response.status == 200: break
                    except (OSError, urllib.error.URLError):
                        time.sleep(0.1)
                else:
                    raise AssertionError('Backend did not become ready')
                test_http_api_endpoints(f"http://{bind_addr}")
            finally:
                proc.terminate()
                proc.wait()
        finally:
            shutil.rmtree(temp_dir, ignore_errors=True)
    else:
        parser.error('Specify --binary or --base-url to verify the real Rust backend, or --skip-api for fixture-only checks. No mock HTTP server is accepted.')

    print("\n" + "=" * 60)
    print(f"SMOKE TEST SUMMARY: {TEST_PASSED} checks passed, {TEST_FAILED} checks failed.")
    print("=" * 60)
    if TEST_FAILED > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
