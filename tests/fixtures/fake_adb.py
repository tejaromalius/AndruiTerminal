#!/usr/bin/env python3
"""
deterministic fake adb executable fixture for AndruiTerminal tests.
Simulates Android Debug Bridge (version 34.0.4) behavior deterministically
without requiring real Android devices, USB access, or system ADB installation.
"""

import sys
import os
import time
import signal
import json
import re
from pathlib import Path

# Base directories
FIXTURES_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.environ.get("FAKE_ADB_DATA_DIR", FIXTURES_DIR / "data"))

DEFAULT_VERSION_TEXT = """Android Debug Bridge version 1.0.41
Version 34.0.4-10411341
Installed as /usr/lib/android-sdk/platform-tools/adb
Running on Linux 6.6.0-x86_64
"""

# 1x1 RGBA valid PNG bytes
DEFAULT_PNG_BYTES = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\rIDATx\x9cc\xf8\xcf\xc0\xf0\x1f\x00\x05\x00\x01\xff\x89\x99=\x1d\x00\x00\x00\x00IEND\xaeB`\x82'

DEVICES_FULL = [
    {"id": "emulator-5554", "state": "device", "model": "sdk_gphone64_x86_64", "product": "sdk_gphone64_x86_64", "device": "emu64xa", "transport_id": "1"},
    {"id": "RF8M10ABCDE", "state": "device", "usb": "1-1", "model": "SM_G9600", "product": "starqltezc", "device": "starqlte", "transport_id": "2"},
    {"id": "192.168.1.100:5555", "state": "device", "model": "Pixel_4", "product": "coral", "device": "coral", "transport_id": "3"},
    {"id": "offline-device-01", "state": "offline", "transport_id": "4"},
    {"id": "unauth-device-02", "state": "unauthorized", "transport_id": "5"},
    {"id": "recovery-device-03", "state": "recovery", "transport_id": "6"},
    {"id": "sideload-device-04", "state": "sideload", "transport_id": "7"},
    {"id": "bootloader-device-05", "state": "bootloader", "transport_id": "8"},
    {"id": "auth-device-06", "state": "authorizing", "transport_id": "9"},
    {"id": "conn-device-07", "state": "connecting", "transport_id": "10"},
]

DEFAULT_PROPERTIES = {
    "init.svc.adbd": "running",
    "net.bt.name": "Android",
    "ro.board.platform": "sm8550",
    "ro.boot.hardware": "qcom",
    "ro.boot.serialno": "RF8M10ABCDE",
    "ro.build.date": "Thu Nov 02 12:00:00 UTC 2023",
    "ro.build.display.id": "UP1A.231105.003",
    "ro.build.id": "UP1A.231105.003",
    "ro.build.type": "userdebug",
    "ro.build.user": "android-build",
    "ro.build.version.incremental": "10411341",
    "ro.build.version.release": "14",
    "ro.build.version.sdk": "34",
    "ro.build.version.security_patch": "2023-11-01",
    "ro.crypto.state": "encrypted",
    "ro.debuggable": "1",
    "ro.product.brand": "google",
    "ro.product.cpu.abi": "arm64-v8a",
    "ro.product.device": "husky",
    "ro.product.manufacturer": "Google",
    "ro.product.model": "Pixel 8 Pro",
    "ro.product.name": "husky",
    "ro.serialno": "RF8M10ABCDE",
}

DEFAULT_PACKAGES = [
    "com.android.settings",
    "com.android.systemui",
    "com.google.android.gms",
    "com.google.android.gsf",
    "com.android.providers.media",
    "com.android.shell",
    "com.android.vending",
    "org.andrui.helper",
]

DEFAULT_LOGCAT = [
    "11-08 22:20:01.100  1000  1050  1050 I ActivityManager: Start proc 12345:org.andrui.helper/u0a120 for service {org.andrui.helper/org.andrui.helper.Service}",
    "11-08 22:20:01.150  1000  1050  1050 D PackageManager: Application package org.andrui.helper installed successfully",
    "11-08 22:20:01.200 12345 12345 12345 I AndruiHelper: Companion helper service initialized, listening for automation intents",
    "11-08 22:20:02.000  1000  1100  1100 D WindowManager: Focus moved to Window{d83765 u0 org.andrui.helper}",
    "11-08 22:20:02.500  1000  1050  1050 I ActivityManager: Displayed org.andrui.helper/.MainActivity: +450ms",
    "11-08 22:20:03.100 12345 12345 12345 D AndruiHelper: Heartbeat tick, active sessions: 1",
]


def build_sqlite_fixture() -> bytes:
    """Build a small, deterministic SQLite database and return its raw bytes."""
    import sqlite3
    import tempfile

    fd, path = tempfile.mkstemp(suffix=".db")
    os.close(fd)
    try:
        conn = sqlite3.connect(path)
        conn.executescript(
            "CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT, score INTEGER);"
            "INSERT INTO users(name, score) VALUES ('alice', 10), ('bob', 20);"
        )
        conn.commit()
        conn.close()
        with open(path, "rb") as handle:
            return handle.read()
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass


def load_file_or_default(filename: str, default_str: str) -> str:
    path = DATA_DIR / filename
    if path.is_file():
        try:
            return path.read_text(encoding="utf-8")
        except Exception:
            pass
    return default_str


def load_png_bytes() -> bytes:
    path = DATA_DIR / "sample.png"
    if path.is_file():
        try:
            return path.read_bytes()
        except Exception:
            pass
    return DEFAULT_PNG_BYTES


def get_devices_list():
    state_file = os.environ.get("FAKE_ADB_STATE_FILE")
    if state_file and Path(state_file).is_file():
        try:
            with open(state_file, "r", encoding="utf-8") as f:
                data = json.load(f)
                if isinstance(data, list):
                    return data
                if isinstance(data, dict) and "devices" in data:
                    return data["devices"]
        except Exception:
            pass

    matrix_file = DATA_DIR / "devices_matrix.json"
    if matrix_file.is_file():
        try:
            with open(matrix_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass

    scenario = os.environ.get("FAKE_ADB_SCENARIO", "full_states")
    if scenario == "empty":
        return []
    elif scenario == "single":
        return [DEVICES_FULL[0]]
    elif scenario == "offline":
        return [{"id": "offline-device-01", "state": "offline", "transport_id": "4"}]
    elif scenario == "unauthorized":
        return [{"id": "unauth-device-02", "state": "unauthorized", "transport_id": "5"}]
    return DEVICES_FULL


def handle_hang(duration_sec=None):
    if duration_sec is None:
        hang_sec_str = os.environ.get("FAKE_ADB_HANG_SECONDS")
        if hang_sec_str:
            try:
                duration_sec = float(hang_sec_str)
            except ValueError:
                duration_sec = None

    if duration_sec is not None and duration_sec > 0:
        time.sleep(duration_sec)
    else:
        # Sleep indefinitely until interrupted/cancelled
        try:
            while True:
                time.sleep(1)
        except (KeyboardInterrupt, SystemExit):
            sys.exit(130)


def format_devices(long_format: bool) -> str:
    devices = get_devices_list()
    lines = ["List of devices attached"]
    for dev in devices:
        dev_id = dev.get("id", dev.get("serial", "unknown"))
        state = dev.get("state", "device")
        if not long_format:
            lines.append(f"{dev_id}\t{state}")
        else:
            parts = [f"{dev_id:<22}", state]
            if "usb" in dev:
                parts.append(f"usb:{dev['usb']}")
            if "product" in dev:
                parts.append(f"product:{dev['product']}")
            if "model" in dev:
                parts.append(f"model:{dev['model']}")
            if "device" in dev:
                parts.append(f"device:{dev['device']}")
            transport_id = dev.get("transportId", dev.get("transport_id", "1"))
            parts.append(f"transport_id:{transport_id}")
            lines.append(" ".join(parts))
    lines.append("")
    return "\n".join(lines)


def main():
    # Handle global environment overrides
    if os.environ.get("FAKE_ADB_HANG") in ("1", "true", "yes"):
        handle_hang()

    if os.environ.get("FAKE_ADB_FORCE_ERROR"):
        err_msg = os.environ["FAKE_ADB_FORCE_ERROR"]
        exit_code = int(os.environ.get("FAKE_ADB_FORCE_EXIT_CODE", "1"))
        sys.stderr.write(err_msg + "\n")
        sys.stderr.flush()
        sys.exit(exit_code)

    # Parse arguments
    args = sys.argv[1:]
    if not args:
        # Bare 'adb' without arguments outputs help
        help_text = load_file_or_default("help_34_0_4.txt", DEFAULT_VERSION_TEXT)
        sys.stdout.write(help_text)
        sys.stdout.flush()
        sys.exit(1)

    target_serial = os.environ.get("ANDROID_SERIAL")
    target_transport_id = None
    target_usb = False
    target_emulator = False

    # Extract global flags before the subcommand
    idx = 0
    subcommand = None
    subcommand_args = []

    while idx < len(args):
        arg = args[idx]
        if arg in ("-s", "--serial") and idx + 1 < len(args):
            target_serial = args[idx + 1]
            idx += 2
        elif arg.startswith("-s="):
            target_serial = arg.split("=", 1)[1]
            idx += 1
        elif arg in ("-t", "--transport-id") and idx + 1 < len(args):
            target_transport_id = args[idx + 1]
            idx += 2
        elif arg == "-d":
            target_usb = True
            idx += 1
        elif arg == "-e":
            target_emulator = True
            idx += 1
        elif arg in ("-H", "-P", "-L") and idx + 1 < len(args):
            idx += 2
        elif arg.startswith("-"):
            # Other potential global flags like -a
            idx += 1
        else:
            subcommand = arg
            subcommand_args = args[idx + 1:]
            break

    if not subcommand:
        # E.g. adb -s xyz (no command)
        sys.exit(0)

    # Global scenario override
    scenario = os.environ.get("FAKE_ADB_SCENARIO", "full_states")
    if scenario == "hang":
        handle_hang()

    # Target serial validation
    if target_serial:
        if target_serial == "nonexistent":
            sys.stderr.write(f"error: device '{target_serial}' not found\n")
            sys.stderr.flush()
            sys.exit(1)
        elif target_serial.startswith("hang-device") or target_serial == "hang":
            handle_hang()
        elif target_serial == "offline-device-01":
            if subcommand not in ("devices", "version", "help", "start-server", "kill-server", "reconnect"):
                sys.stderr.write("error: device offline\n")
                sys.stderr.flush()
                sys.exit(1)
        elif target_serial == "unauth-device-02":
            if subcommand not in ("devices", "version", "help", "start-server", "kill-server", "reconnect"):
                sys.stderr.write("error: device unauthorized. Please check the confirmation dialog on your device.\n")
                sys.stderr.flush()
                sys.exit(1)

    # Subcommand routing
    if subcommand in ("version", "--version", "-v"):
        ver_text = load_file_or_default("version_34_0_4.txt", DEFAULT_VERSION_TEXT)
        sys.stdout.write(ver_text)
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand in ("help", "--help", "-h"):
        help_text = load_file_or_default("help_34_0_4.txt", DEFAULT_VERSION_TEXT)
        sys.stdout.write(help_text)
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "devices":
        long_format = "-l" in subcommand_args
        sys.stdout.write(format_devices(long_format))
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "get-state":
        if target_serial == "offline-device-01":
            sys.stdout.write("offline\n")
        elif target_serial == "bootloader-device-05":
            sys.stdout.write("bootloader\n")
        else:
            sys.stdout.write("device\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "get-serialno":
        sys.stdout.write((target_serial or "RF8M10ABCDE") + "\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "get-devpath":
        sys.stdout.write("usb:1-1\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "getprop":
        # Direct adb getprop or adb shell getprop
        if subcommand_args:
            key = subcommand_args[0].strip()
            val = DEFAULT_PROPERTIES.get(key, "")
            sys.stdout.write(f"{val}\n")
        else:
            prop_lines = [f"[{k}]: [{v}]" for k, v in DEFAULT_PROPERTIES.items()]
            sys.stdout.write("\n".join(prop_lines) + "\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "shell":
        # adb shell [command...]
        if not subcommand_args:
            # Interactive shell invocation
            sys.stdout.write("andrui:/ $ \n")
            sys.stdout.flush()
            sys.exit(0)

        # Skip shell flags like -T, -t, -x, -n
        cmd_args = [a for a in subcommand_args if not a.startswith("-")]
        if not cmd_args:
            sys.stdout.write("andrui fixture PTY ready\n")
            sys.stdout.flush()
            for line in sys.stdin:
                command = line.strip()
                if command == "exit": sys.exit(0)
                if command == "fixture-size":
                    size = os.get_terminal_size()
                    sys.stdout.write(f"fixture-size={size.columns}x{size.lines}\n")
                else: sys.stdout.write(f"fixture-input={command}\n")
                sys.stdout.flush()
            sys.exit(0)

        cmd_str = " ".join(cmd_args).strip()

        # Fixed read-only dashboard probes; never execute the supplied script.
        if "@@andrui-section:" in cmd_str:
            samples = {
                "size": "Physical size: 1080x2400",
                "density": "Physical density: 420",
                "uptime": "3660.00 7200.00",
                "buildType": "userdebug",
                "bootCompleted": "1",
                "root": "uid=2000(shell) gid=2000(shell)",
                "verifiedBoot": "green",
                "bootloaderLocked": "1",
                "proxy": "127.0.0.1:8080",
                "processes": "PID USER NAME RSS VSZ\n1 root init 100 200\n25 u0_a1 com.example 1024 4096",
                "details": "Packages:\n  Package [com.example] (123):\n    requested permissions:\n      android.permission.CAMERA\n    User 0:\n      runtime permissions:\n        android.permission.CAMERA: granted=false, flags=[]",
                "appops": "CAMERA: foreground; time=1m\nRUN_IN_BACKGROUND: ignore",
                "launcher": "priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\ncom.example/.MainActivity",
                "paths": "package:/data/app/~~a==/com.example-b==/base.apk\npackage:/data/app/~~a==/com.example-b==/split_config.arm64_v8a.apk",
                "packageList": "package:/system/app/Settings/Settings.apk=com.android.settings\npackage:/data/app/~~a==/com.example-b==/base.apk=com.example\npackage:/system/priv-app/Shell/Shell.apk=com.android.shell",
                "packageUids": "package:com.android.settings uid:1000\npackage:com.example uid:10123\npackage:com.android.shell uid:2000",
                "packageVersions": "package:com.android.settings versionCode:34\npackage:com.example versionCode:231\npackage:com.android.shell versionCode:34",
                "packageInstallers": "package:com.android.settings  installer=null\npackage:com.example  installer=com.android.vending\npackage:com.android.shell  installer=null",
                "systemPackages": "package:com.android.settings\npackage:com.android.shell",
                "disabledPackages": "package:com.android.shell",
                "runningProcesses": "NAME\ninit\ncom.example\ncom.android.settings:remote",
                "resumed": "  topResumedActivity=ActivityRecord{1a2b3c u0 com.example/.MainActivity t12}",
            }
            for key in re.findall(r"echo '@@andrui-section:([^']+)'", cmd_str):
                output = samples.get(key, "Fixture does not provide this measurement")
                code = 0 if key in samples else 1
                print(f"@@andrui-section:{key}\n{output}\n@@andrui-rc:{code}")
            sys.exit(0)

        # Handle hang/sleep
        if cmd_str.startswith("hang") or cmd_str == "sleep" or "sleep 99" in cmd_str:
            handle_hang()
        elif cmd_str.startswith("sleep "):
            parts = cmd_str.split()
            try:
                sec = float(parts[1])
                handle_hang(sec)
            except Exception:
                handle_hang(1)
            sys.exit(0)

        # Handle exit <code>
        if cmd_str.startswith("exit "):
            try:
                code = int(cmd_str.split()[1])
                sys.exit(code)
            except ValueError:
                sys.exit(1)

        # Handle failure commands
        if cmd_str in ("false", "fail", "exit 1") or cmd_str.startswith("false ") or cmd_str.startswith("fail "):
            sys.stderr.write(f"bash: {cmd_str}: command failed with status 1\n")
            sys.stderr.flush()
            sys.exit(1)

        # Handle getprop in shell
        if cmd_str.startswith("getprop"):
            sub_parts = cmd_str.split()
            if len(sub_parts) > 1:
                key = sub_parts[1].strip()
                val = DEFAULT_PROPERTIES.get(key, "")
                sys.stdout.write(f"{val}\n")
            else:
                prop_lines = [f"[{k}]: [{v}]" for k, v in DEFAULT_PROPERTIES.items()]
                sys.stdout.write("\n".join(prop_lines) + "\n")
            sys.stdout.flush()
            sys.exit(0)

        # run-as <pkg> <cmd...> for a debuggable app (database inspection).
        if cmd_str.startswith("run-as "):
            ra = cmd_str.split()
            inner = ra[2:] if len(ra) > 2 else []
            inner_str = " ".join(inner)
            if inner_str == "id":
                sys.stdout.write("uid=10234(u0_a234) gid=10234(u0_a234) groups=10234\n")
                sys.exit(0)
            if inner and inner[0] == "ls" and "databases" in inner:
                sys.stdout.write(
                    "total 48\n"
                    "-rw-rw---- 1 u0_a234 u0_a234 24576 2024-05-01 10:00 app.db\n"
                    "-rw-rw---- 1 u0_a234 u0_a234 0 2024-05-01 10:00 app.db-wal\n"
                )
                sys.exit(0)
            if inner_str.startswith("sh -c"):
                # rm of sidecars and other maintenance no-ops.
                sys.exit(0)
            sys.stdout.write("\n")
            sys.exit(0)

        # su 0 ... is unavailable on this (non-root) fixture device.
        if cmd_str.startswith("su 0") or cmd_str.startswith("su -c"):
            sys.stderr.write("/system/bin/sh: su: inaccessible or not found\n")
            sys.exit(127)

        # am force-stop <pkg>
        if cmd_str.startswith("am force-stop"):
            sys.exit(0)

        # am dumpheap [-n] <pkg> <path> (heap dump request; completes async)
        if cmd_str.startswith("am dumpheap"):
            sys.exit(0)

        # stat -c %s <path>: report a stable size for heap-dump polling.
        if cmd_str.startswith("stat") and ".hprof" in cmd_str:
            sys.stdout.write("512\n")
            sys.exit(0)

        # Handle pm path <package> (used by package signing inspection)
        if cmd_str.startswith("pm path"):
            parts = cmd_str.split()
            pkg = parts[2] if len(parts) > 2 else "com.example"
            base = f"/data/app/~~fixture==/{pkg}-fixture==/base.apk"
            sys.stdout.write(f"package:{base}\n")
            sys.stdout.flush()
            sys.exit(0)

        # Handle pm list packages
        if "pm list packages" in cmd_str:
            lines = [f"package:{pkg}" for pkg in DEFAULT_PACKAGES]
            sys.stdout.write("\n".join(lines) + "\n")
            sys.stdout.flush()
            sys.exit(0)

        # Handle screencap -p
        if "screencap -p" in cmd_str:
            png_bytes = load_png_bytes()
            sys.stdout.buffer.write(png_bytes)
            sys.stdout.buffer.flush()
            sys.exit(0)

        # Handle echo
        if cmd_str.startswith("echo "):
            echo_val = cmd_str[5:].strip().strip("\"'")
            sys.stdout.write(f"{echo_val}\n")
            sys.stdout.flush()
            sys.exit(0)

        # Handle dumpsys meminfo <pkg> for memory inspection.
        if cmd_str.startswith("dumpsys meminfo"):
            sys.stdout.write(
                "Applications Memory Usage (in Kilobytes):\n\n"
                "** MEMINFO in pid 4567 [com.example.app] **\n"
                "                   Pss  Private  Private\n"
                "                 Total    Dirty    Clean\n"
                "  Native Heap     2048     2000        0\n\n"
                " App Summary\n"
                "                       Pss(KB)                        Rss(KB)\n"
                "           Java Heap:     4096                           8000\n"
                "         Native Heap:     2048                           3000\n"
                "                Code:     1500                           6000\n"
                "               Stack:       64                             80\n"
                "            Graphics:     3000                           3000\n"
                "       Private Other:      512\n"
                "              System:     1234\n"
                "            TOTAL PSS:    12454            TOTAL RSS:    28080\n"
            )
            sys.stdout.flush()
            sys.exit(0)

        # Handle dumpsys
        if cmd_str.startswith("dumpsys"):
            sys.stdout.write(f"DUMP OF SERVICE {cmd_str}:\n  Current state: normal\n  Status: active\n")
            sys.stdout.flush()
            sys.exit(0)

        # Handle ls
        if cmd_str.startswith("ls"):
            sys.stdout.write("data\nsystem\nsdcard\nstorage\nvendor\n")
            sys.stdout.flush()
            sys.exit(0)

        # Handle cat
        if cmd_str.startswith("cat "):
            sys.stdout.write("file content dummy\n")
            sys.stdout.flush()
            sys.exit(0)

        # Generic command response
        sys.stdout.write(f"{cmd_str}\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "exec-out":
        # Binary execution streaming (e.g. exec-out screencap -p)
        cmd_str = " ".join(subcommand_args).strip()
        if "screencap" in cmd_str:
            png_bytes = load_png_bytes()
            sys.stdout.buffer.write(png_bytes)
            sys.stdout.buffer.flush()
            sys.exit(0)
        elif subcommand_args[:1] == ["run-as"] and "cat" in subcommand_args:
            # run-as <pkg> cat <path>: serve sandbox files for DB inspection.
            path = subcommand_args[-1]
            if path.endswith("app.db"):
                sys.stdout.buffer.write(build_sqlite_fixture())
            elif path.endswith("-wal") or path.endswith("-shm"):
                # Present but empty sidecar.
                pass
            else:
                sys.stderr.write(f"cat: {path}: No such file or directory\n")
                sys.stdout.buffer.flush()
                sys.exit(1)
            sys.stdout.buffer.flush()
            sys.exit(0)
        elif subcommand_args[:1] == ["cat"] and len(subcommand_args) >= 2:
            # Serve the real signed helper APK for any .apk path so signature
            # inspection has a genuine archive to parse; other files get text.
            target = subcommand_args[1]
            if target.endswith(".apk"):
                apk = FIXTURES_DIR / "../../helper-apk/build/andrui-helper.apk"
                try:
                    sys.stdout.buffer.write(apk.resolve().read_bytes())
                except Exception:
                    sys.stderr.write(f"cat: {target}: No such file or directory\n")
                    sys.exit(1)
            else:
                sys.stdout.buffer.write(b"binary file content\n")
            sys.stdout.buffer.flush()
            sys.exit(0)
        else:
            sys.stdout.write(f"exec-out: {cmd_str}\n")
            sys.stdout.flush()
            sys.exit(0)

    elif subcommand in ("install", "install-multiple", "install-multi-package"):
        # Check if any path contains fail or invalid
        args_str = " ".join(subcommand_args)
        if "fail" in args_str.lower() or "invalid" in args_str.lower():
            sys.stderr.write("Failure [INSTALL_FAILED_INVALID_APK: Failed to parse package]\n")
            sys.stderr.flush()
            sys.exit(1)
        elif "already_exists" in args_str.lower():
            sys.stderr.write("Failure [INSTALL_FAILED_ALREADY_EXISTS: Attempt to re-install without -r]\n")
            sys.stderr.flush()
            sys.exit(1)
        else:
            sys.stdout.write("Performing Streamed Install\nSuccess\n")
            sys.stdout.flush()
            sys.exit(0)

    elif subcommand == "uninstall":
        sys.stdout.write("Success\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "logcat":
        # Support logcat [-d] [-b buffer] [-v format]
        is_dump = "-d" in subcommand_args
        lines = DEFAULT_LOGCAT
        for line in lines:
            sys.stdout.write(line + "\n")
        sys.stdout.flush()

        if not is_dump:
            # If not dump, stream a few lines or hang/wait
            if os.environ.get("FAKE_ADB_LOGCAT_STREAM") == "1":
                try:
                    for i in range(5):
                        time.sleep(0.5)
                        sys.stdout.write(f"11-08 22:20:04.{i}00  1000  1050  1050 D StreamingLog: Message {i}\n")
                        sys.stdout.flush()
                except (KeyboardInterrupt, SystemExit):
                    pass
        sys.exit(0)

    elif subcommand == "forward":
        # adb forward ...
        if "--list" in subcommand_args:
            sys.stdout.write("emulator-5554 tcp:8000 tcp:8000\n")
            sys.stdout.flush()
            sys.exit(0)
        elif "--remove" in subcommand_args or "--remove-all" in subcommand_args:
            sys.exit(0)
        elif len(subcommand_args) >= 2:
            # e.g. tcp:8080 tcp:8080
            sys.exit(0)
        else:
            sys.exit(0)

    elif subcommand == "reverse":
        if "--list" in subcommand_args:
            sys.stdout.write("emulator-5554 tcp:8080 tcp:8080\n")
            sys.stdout.flush()
            sys.exit(0)
        else:
            sys.exit(0)

    elif subcommand == "push":
        # adb push src dest
        sys.stdout.write("1 file pushed, 0 skipped. 10.5 MB/s (1024 bytes in 0.000s)\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "pull":
        # adb pull remote local
        if len(subcommand_args) >= 2:
            dest = Path(subcommand_args[1])
            if dest.is_dir():
                dest = dest / "pulled_file"
            try:
                dest.write_text("pulled content", encoding="utf-8")
            except Exception:
                pass
        sys.stdout.write("1 file pulled, 0 skipped. 10.5 MB/s (1024 bytes in 0.000s)\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand in ("start-server", "kill-server"):
        if subcommand == "start-server":
            sys.stdout.write("* daemon not running; starting now at tcp:5037\n* daemon started successfully\n")
        else:
            sys.stdout.write("* daemon killed\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "connect":
        host = subcommand_args[0] if subcommand_args else "127.0.0.1:5555"
        sys.stdout.write(f"connected to {host}\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "disconnect":
        host = subcommand_args[0] if subcommand_args else "127.0.0.1:5555"
        sys.stdout.write(f"disconnected {host}\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "pair":
        host = subcommand_args[0] if subcommand_args else "127.0.0.1:5555"
        sys.stdout.write(f"Successfully paired to {host} [guid: fake-guid-1234]\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "reboot":
        sys.exit(0)

    elif subcommand in ("root", "unroot"):
        if subcommand == "root":
            sys.stdout.write("restarting adbd as root\n")
        else:
            sys.stdout.write("adbd not running as root\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand == "remount":
        sys.stdout.write("remount succeeded\n")
        sys.stdout.flush()
        sys.exit(0)

    elif subcommand.startswith("wait-for"):
        sys.exit(0)

    elif subcommand == "bugreport":
        dest_path = subcommand_args[0] if subcommand_args else "bugreport.zip"
        p = Path(dest_path)
        try:
            p.write_bytes(b"PK\x03\x04dummy bugreport zip content")
        except Exception:
            pass
        sys.stdout.write(f"Bugreport written to {dest_path}\n")
        sys.stdout.flush()
        sys.exit(0)

    else:
        # Unknown subcommand
        sys.stderr.write(f"adb: unknown command {subcommand}\n")
        sys.stderr.flush()
        sys.exit(1)


if __name__ == "__main__":
    main()
