//! Read-only device statistics for dashboard KPIs.
//!
//! Each scope maps to a fixed allowlist of non-mutating ADB queries. Results are
//! returned as raw command output and are never stored as jobs.

use std::collections::BTreeMap;
use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};

#[derive(Debug, Deserialize)]
pub struct StatsQuery {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub scope: String,
    pub package: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct StatSection {
    pub output: String,
    #[serde(rename = "exitCode")]
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
pub struct DeviceStats {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub scope: String,
    #[serde(rename = "collectedAt")]
    pub collected_at: i64,
    pub sections: BTreeMap<String, StatSection>,
}

enum Probe {
    /// Command run inside `adb shell`.
    Shell(&'static str),
    /// Host-side adb arguments placed after `-s <serial>`.
    Host(&'static [&'static str]),
}

const NET_DEV: &str = "cat /proc/net/dev";
const NET_TCP: &str = "cat /proc/net/tcp /proc/net/tcp6";

fn probes(scope: &str) -> Option<Vec<(&'static str, Probe)>> {
    use Probe::*;
    Some(match scope {
        "screen" => vec![
            ("size", Shell("wm size")),
            ("density", Shell("wm density")),
        ],
        "system" => vec![
            ("uptime", Shell("cat /proc/uptime")),
            ("buildType", Shell("getprop ro.build.type")),
            ("bootCompleted", Shell("getprop sys.boot_completed")),
            ("root", Shell("id")),
            ("verifiedBoot", Shell("getprop ro.boot.verifiedbootstate")),
            ("bootloaderLocked", Shell("getprop ro.boot.flash.locked")),
        ],
        "processes" => vec![("processes", Shell("ps -A -o PID,USER,NAME,RSS,VSZ"))],
        "package" => vec![],
        // Package picker: each listing is its own section so an unsupported flag
        // on an older Android degrades one column instead of the whole list.
        "packages" => vec![
            ("packageList", Shell("pm list packages -f")),
            ("packageUids", Shell("pm list packages -U")),
            ("packageVersions", Shell("pm list packages --show-versioncode")),
            ("packageInstallers", Shell("pm list packages -i")),
            ("systemPackages", Shell("pm list packages -s")),
            ("disabledPackages", Shell("pm list packages -d")),
            ("runningProcesses", Shell("ps -A -o NAME")),
        ],
        "foreground" => vec![(
            "resumed",
            Shell("dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity'"),
        )],
        "network" => vec![
            ("proxy", Shell("settings get global http_proxy")),
            ("addresses", Shell("ip -o addr show")),
            ("forwards", Host(&["forward", "--list"])),
            ("reverses", Host(&["reverse", "--list"])),
            ("netdev", Shell(NET_DEV)),
            ("tcp", Shell(NET_TCP)),
        ],
        "permissions" => vec![
            ("users", Shell("pm list users")),
            ("owners", Shell("dpm list-owners")),
            ("selinux", Shell("getenforce")),
            ("patch", Shell("getprop ro.build.version.security_patch")),
            ("root", Shell("id")),
            ("su", Shell("which su 2>/dev/null || echo 'not found'")),
            ("buildType", Shell("getprop ro.build.type")),
        ],
        "files" => vec![
            ("data", Shell("df -k /data")),
            ("sdcard", Shell("df -k /sdcard/")),
        ],
        "applications" => vec![
            ("all", Shell("pm list packages | wc -l")),
            ("system", Shell("pm list packages -s | wc -l")),
            ("thirdParty", Shell("pm list packages -3 | wc -l")),
            ("disabled", Shell("pm list packages -d | wc -l")),
            ("processes", Shell("ps -A | wc -l")),
        ],
        "logs" => vec![
            ("buffers", Shell("logcat -g")),
            (
                "crashes",
                Shell("logcat -d -b crash | grep -cE 'FATAL EXCEPTION|Fatal signal'"),
            ),
            ("anrs", Shell("logcat -d -b events | grep -c am_anr")),
            (
                "levels",
                Shell("logcat -d -b main,system -v brief | cut -c1 | sort | uniq -c"),
            ),
        ],
        // Device facts for agents (MCP android_device_info).
        "device" => vec![
            ("props", Shell("getprop")),
            ("battery", Shell("dumpsys battery")),
            ("meminfo", Shell("cat /proc/meminfo")),
            ("storage", Shell("df -k /data /sdcard/")),
            ("screenSize", Shell("wm size")),
            ("density", Shell("wm density")),
            ("ipAddr", Shell("ip addr")),
            ("uptime", Shell("uptime")),
            ("root", Shell("id")),
            ("su", Shell("which su 2>/dev/null || echo 'not found'")),
            ("buildType", Shell("getprop ro.build.type")),
        ],
        "shell" => vec![
            ("id", Shell("id")),
            ("toybox", Shell("toybox --version")),
            ("kernel", Shell("uname -r")),
        ],
        "telemetry" => vec![
            ("stat", Shell("cat /proc/stat")),
            ("meminfo", Shell("cat /proc/meminfo")),
            ("battery", Shell("dumpsys battery")),
            ("netdev", Shell(NET_DEV)),
            ("tcp", Shell(NET_TCP)),
            ("snmp", Shell("cat /proc/net/snmp")),
            (
                "governor",
                Shell("cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor"),
            ),
            (
                "cpufreq",
                Shell("cat /sys/devices/system/cpu/cpu*/cpufreq/cpuinfo_max_freq"),
            ),
            (
                "current",
                Shell("cat /sys/class/power_supply/battery/current_now"),
            ),
            (
                "thermal",
                Shell("dumpsys thermalservice | grep -m1 'Thermal Status'"),
            ),
            ("refresh", Shell("dumpsys SurfaceFlinger --latency")),
            // Frame counters of the focused app; FPS is derived from two samples.
            (
                "frames",
                Shell(
                    r#"p=$(dumpsys window windows | grep -m1 mCurrentFocus | sed -E 's/.* ([^ /{}]+)\/.*/\1/'); echo "package $p"; dumpsys gfxinfo "$p" | grep -E 'Total frames rendered|Janky frames|90th percentile'"#,
                ),
            ),
            (
                "interfaces",
                Shell("for i in /sys/class/net/*; do echo \"${i##*/} $(cat $i/mtu) $(cat $i/operstate)\"; done"),
            ),
        ],
        _ => return None,
    })
}

const SECTION_MARK: &str = "@@andrui-section:";
const RC_MARK: &str = "@@andrui-rc:";

/// Joins shell probes into one script so each refresh costs a single adb round trip.
fn build_script(shell: &[(&str, &str)]) -> String {
    shell
        .iter()
        .map(|(key, cmd)| {
            format!("echo '{SECTION_MARK}{key}'; {{ {cmd} ; }} 2>&1; echo \"{RC_MARK}$?\"")
        })
        .collect::<Vec<_>>()
        .join("; ")
}

fn parse_script_output(output: &str) -> BTreeMap<String, StatSection> {
    let mut sections = BTreeMap::new();
    let mut current: Option<(String, Vec<&str>)> = None;
    for line in output.lines() {
        let line = line.trim_end_matches('\r');
        if let Some(key) = line.strip_prefix(SECTION_MARK) {
            current = Some((key.to_string(), Vec::new()));
        } else if let Some(rc) = line.strip_prefix(RC_MARK) {
            if let Some((key, lines)) = current.take() {
                sections.insert(
                    key,
                    StatSection {
                        output: lines.join("\n"),
                        exit_code: rc.trim().parse().unwrap_or(-1),
                    },
                );
            }
        } else if let Some((_, lines)) = current.as_mut() {
            lines.push(line);
        }
    }
    sections
}

pub async fn collect(
    executor: &AdbExecutor,
    device_id: &str,
    scope: &str,
) -> ApiResult<DeviceStats> {
    collect_with_package(executor, device_id, scope, None).await
}

fn valid_package(package: &str) -> bool {
    !package.is_empty()
        && package.len() <= 255
        && package.split('.').all(|part| {
            let mut chars = part.chars();
            matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
                && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        })
}

pub async fn collect_with_package(
    executor: &AdbExecutor,
    device_id: &str,
    scope: &str,
    package: Option<&str>,
) -> ApiResult<DeviceStats> {
    if device_id.is_empty() || device_id.chars().any(|c| c.is_whitespace() || c == '\0') {
        return Err(ApiError::bad_request(
            "INVALID_DEVICE",
            "A device serial is required",
        ));
    }
    let probes = probes(scope).ok_or_else(|| {
        ApiError::bad_request("INVALID_SCOPE", format!("Unknown stats scope '{scope}'"))
    })?;
    let package_probes = if scope == "package" {
        let package = package.filter(|p| valid_package(p)).ok_or_else(|| {
            ApiError::bad_request("INVALID_PACKAGE", "A valid package identifier is required")
        })?;
        vec![
            ("details", format!("dumpsys package {package}")),
            ("appops", format!("cmd appops get {package}")),
            ("paths", format!("pm path {package}")),
            (
                "launcher",
                format!("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER {package}"),
            ),
        ]
    } else {
        Vec::new()
    };
    let timeout = Some(Duration::from_secs(20));
    let mut sections = BTreeMap::new();

    let mut shell: Vec<(&str, &str)> = probes
        .iter()
        .filter_map(|(key, probe)| match probe {
            Probe::Shell(cmd) => Some((*key, *cmd)),
            Probe::Host(_) => None,
        })
        .collect();
    shell.extend(package_probes.iter().map(|(key, cmd)| (*key, cmd.as_str())));
    if !shell.is_empty() {
        let args = vec![
            "-s".to_string(),
            device_id.to_string(),
            "shell".to_string(),
            build_script(&shell),
        ];
        let out = executor.execute(&args, timeout, None).await?;
        let parsed = parse_script_output(&out.stdout);
        if parsed.is_empty() {
            return Err(ApiError::bad_request(
                "STATS_FAILED",
                format!(
                    "Device did not answer: {}",
                    first_line(&out.stderr).unwrap_or("no output")
                ),
            ));
        }
        sections.extend(parsed);
    }

    for (key, probe) in &probes {
        if let Probe::Host(host_args) = probe {
            let mut args = vec!["-s".to_string(), device_id.to_string()];
            args.extend(host_args.iter().map(|a| a.to_string()));
            let out = executor.execute(&args, timeout, None).await?;
            let mut output = out.stdout;
            if out.exit_code != 0 {
                output.push_str(&out.stderr);
            }
            sections.insert(
                key.to_string(),
                StatSection {
                    output: output.trim_end().to_string(),
                    exit_code: out.exit_code,
                },
            );
        }
    }

    Ok(DeviceStats {
        device_id: device_id.to_string(),
        scope: scope.to_string(),
        collected_at: chrono::Utc::now().timestamp_millis(),
        sections,
    })
}

fn first_line(s: &str) -> Option<&str> {
    s.lines().map(str::trim).find(|l| !l.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_scope_is_read_only_allowlist() {
        for scope in [
            "screen",
            "system",
            "processes",
            "package",
            "packages",
            "foreground",
            "network",
            "permissions",
            "files",
            "applications",
            "logs",
            "device",
            "shell",
            "telemetry",
        ] {
            assert!(probes(scope).is_some(), "{scope}");
        }
        assert!(probes("rm -rf").is_none());
    }

    #[test]
    fn package_identifiers_cannot_inject_commands() {
        for package in ["android", "com.example_app", "org.example.app2"] {
            assert!(valid_package(package));
        }
        for package in [
            "",
            "com..app",
            "-x",
            "com.1app",
            "com.app;id",
            "$(id)",
            "com.app\n",
            "com.app`id`",
            "com.app'",
            "com.app/other",
        ] {
            assert!(!valid_package(package), "{package:?}");
        }
        assert!(!valid_package(&"a".repeat(256)));
    }

    #[tokio::test]
    async fn inspection_scopes_collect_from_fake_adb_with_targeting() {
        let adb = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/fixtures/adb");
        let executor = AdbExecutor::new(adb);
        for (scope, key, expected) in [
            ("screen", "size", "Physical size: 1080x2400"),
            ("system", "bootCompleted", "1"),
            ("processes", "processes", "PID USER NAME RSS VSZ"),
            ("package", "appops", "CAMERA: foreground"),
            ("package", "launcher", "priority=0"),
            ("package", "paths", "package:/data/app"),
            ("packages", "packageList", "package:/system/app"),
            ("foreground", "resumed", "  topResumedActivity"),
        ] {
            let result = collect_with_package(&executor, "RF8M10ABCDE", scope, Some("com.example"))
                .await
                .unwrap();
            assert_eq!(result.device_id, "RF8M10ABCDE");
            assert_eq!(result.scope, scope);
            assert_eq!(result.sections[key].exit_code, 0);
            assert!(result.sections[key].output.starts_with(expected));
        }
        assert!(collect(&executor, "nonexistent", "screen").await.is_err());
        let partial = collect(&executor, "RF8M10ABCDE", "permissions")
            .await
            .unwrap();
        assert_eq!(partial.sections["root"].exit_code, 0);
        assert_eq!(partial.sections["users"].exit_code, 1);
    }

    #[tokio::test]
    async fn invalid_package_is_rejected_before_spawning_adb() {
        let executor = AdbExecutor::new("/nonexistent/adb");
        for package in [None, Some("com.app;id"), Some("com..app")] {
            let error = collect_with_package(&executor, "device", "package", package)
                .await
                .unwrap_err();
            assert!(error.to_string().contains("valid package identifier"));
        }
    }

    #[test]
    fn script_round_trip_keeps_sections_and_exit_codes() {
        let script = build_script(&[("a", "getenforce"), ("b", "false")]);
        assert!(script.contains("echo '@@andrui-section:a'; { getenforce ; } 2>&1"));
        let output = "@@andrui-section:a\r\nEnforcing\r\n@@andrui-rc:0\r\n@@andrui-section:b\n@@andrui-rc:1\n";
        let sections = parse_script_output(output);
        assert_eq!(sections["a"].output, "Enforcing");
        assert_eq!(sections["a"].exit_code, 0);
        assert_eq!(sections["b"].output, "");
        assert_eq!(sections["b"].exit_code, 1);
    }
}
