//! Process memory inspection.
//!
//! Two non-invasive capabilities: a memory *usage* summary parsed from
//! `dumpsys meminfo <pkg>` (works for any app, no root), and a managed *heap
//! dump* (`am dumpheap`) pulled back as a downloadable artifact for offline
//! analysis in Android Studio or MAT. Heap dumps require a debuggable app or
//! root and may contain personal data, so they are explicitly confirmed.
//!
//! Raw process-memory reading/searching is intentionally out of scope.

use std::time::Duration;

use serde::Serialize;

use super::{require_device, require_package};
use crate::adb::executor::AdbExecutor;
use crate::error::{ApiError, ApiResult};

/// Parsed memory usage summary for a process, values in kibibytes.
#[derive(Debug, Clone, Serialize, Default, PartialEq, Eq)]
pub struct MemorySummary {
    pub pid: Option<u32>,
    #[serde(rename = "javaHeapKb")]
    pub java_heap_kb: Option<i64>,
    #[serde(rename = "nativeHeapKb")]
    pub native_heap_kb: Option<i64>,
    #[serde(rename = "codeKb")]
    pub code_kb: Option<i64>,
    #[serde(rename = "stackKb")]
    pub stack_kb: Option<i64>,
    #[serde(rename = "graphicsKb")]
    pub graphics_kb: Option<i64>,
    #[serde(rename = "privateOtherKb")]
    pub private_other_kb: Option<i64>,
    #[serde(rename = "systemKb")]
    pub system_kb: Option<i64>,
    #[serde(rename = "totalPssKb")]
    pub total_pss_kb: Option<i64>,
    #[serde(rename = "totalRssKb")]
    pub total_rss_kb: Option<i64>,
}

/// Full memory report: parsed summary plus the raw dumpsys text.
#[derive(Debug, Clone, Serialize)]
pub struct MemoryReport {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub package: String,
    pub summary: MemorySummary,
    #[serde(rename = "rawMeminfo")]
    pub raw_meminfo: String,
    /// `smaps_rollup` PSS, only present when the app is debuggable (run-as).
    #[serde(rename = "smapsRollup", skip_serializing_if = "Option::is_none")]
    pub smaps_rollup: Option<String>,
    pub available: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

/// Extract the leading integer after the first colon on a matching line.
fn summary_value(text: &str, label: &str) -> Option<i64> {
    for line in text.lines() {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix(label) {
            // Lines look like "Java Heap:     5678" (App Summary) and the first
            // number after the colon is the PSS value.
            let rest = rest.trim_start_matches(':').trim();
            if let Some(num) = rest.split_whitespace().next() {
                if let Ok(v) = num.replace(',', "").parse::<i64>() {
                    return Some(v);
                }
            }
        }
    }
    None
}

/// Parse `dumpsys meminfo <pkg>` output into a structured summary.
pub fn parse_meminfo(text: &str) -> MemorySummary {
    let pid = text
        .lines()
        .find_map(|l| l.split("in pid ").nth(1))
        .and_then(|rest| rest.split_whitespace().next())
        .and_then(|n| n.parse::<u32>().ok());

    // "TOTAL PSS:" and "TOTAL RSS:" sometimes appear on the same line; handle both.
    let total_rss = text.lines().find_map(|l| {
        l.split("TOTAL RSS:")
            .nth(1)
            .and_then(|r| r.split_whitespace().next())
            .and_then(|n| n.replace(',', "").parse::<i64>().ok())
    });

    MemorySummary {
        pid,
        java_heap_kb: summary_value(text, "Java Heap"),
        native_heap_kb: summary_value(text, "Native Heap"),
        code_kb: summary_value(text, "Code"),
        stack_kb: summary_value(text, "Stack"),
        graphics_kb: summary_value(text, "Graphics"),
        private_other_kb: summary_value(text, "Private Other"),
        system_kb: summary_value(text, "System"),
        total_pss_kb: summary_value(text, "TOTAL PSS").or_else(|| summary_value(text, "TOTAL")),
        total_rss_kb: total_rss,
    }
}

/// Collect a memory usage report for a package.
pub async fn memory_report(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> ApiResult<MemoryReport> {
    require_device(device_id)?;
    require_package(package)?;
    let out = executor
        .execute(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "dumpsys".into(),
                "meminfo".into(),
                package.into(),
            ],
            Some(Duration::from_secs(30)),
            None,
        )
        .await?;

    let raw = out.stdout;
    // dumpsys prints "No process found for: <pkg>" when the app is not running.
    if out.exit_code != 0 || raw.contains("No process found") || raw.trim().is_empty() {
        return Ok(MemoryReport {
            device_id: device_id.to_string(),
            package: package.to_string(),
            summary: MemorySummary::default(),
            raw_meminfo: raw,
            smaps_rollup: None,
            available: false,
            reason: Some(format!(
                "No running process for '{package}'; start the app before inspecting its memory"
            )),
        });
    }

    let summary = parse_meminfo(&raw);

    // smaps_rollup gives a kernel-side PSS breakdown, readable for the app's own
    // process via run-as when the app is debuggable.
    let smaps_rollup = read_smaps_rollup(executor, device_id, package).await;

    Ok(MemoryReport {
        device_id: device_id.to_string(),
        package: package.to_string(),
        summary,
        raw_meminfo: raw,
        smaps_rollup,
        available: true,
        reason: None,
    })
}

async fn read_smaps_rollup(
    executor: &AdbExecutor,
    device_id: &str,
    package: &str,
) -> Option<String> {
    // `run-as <pkg> cat /proc/self/smaps_rollup` reports the caller process,
    // which is the app's own uid domain; only works for a debuggable app.
    let out = executor
        .execute(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "run-as".into(),
                package.into(),
                "cat".into(),
                "/proc/self/smaps_rollup".into(),
            ],
            Some(Duration::from_secs(15)),
            None,
        )
        .await
        .ok()?;
    if out.exit_code == 0 && out.stdout.contains("Pss") {
        Some(out.stdout)
    } else {
        None
    }
}

/// Result of capturing a heap dump.
#[derive(Debug, Clone, Serialize)]
pub struct HeapDumpResult {
    #[serde(rename = "deviceId")]
    pub device_id: String,
    pub package: String,
    #[serde(rename = "artifactId")]
    pub artifact_id: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    pub native: bool,
}

/// Capture a managed heap dump of a running process and store it as an artifact.
///
/// Runs `am dumpheap [-n] <pkg> <tmp>` on the device, pulls the resulting
/// `.hprof`, and removes the device-side temporary file. Requires confirmation
/// because the dump may contain personal data from the app's memory.
pub async fn capture_heap_dump(
    executor: &AdbExecutor,
    artifacts: &crate::storage::artifacts::ArtifactStore,
    db: &crate::storage::db::Database,
    device_id: &str,
    package: &str,
    native: bool,
    confirmed: bool,
) -> ApiResult<HeapDumpResult> {
    require_device(device_id)?;
    require_package(package)?;
    if !confirmed {
        return Err(ApiError::bad_request_with_details(
            "CONFIRMATION_REQUIRED",
            "A heap dump may contain personal data and requires confirmation",
            serde_json::json!({ "package": package }),
        ));
    }
    // Device-side temp path in the shell-writable location.
    let remote = format!("/data/local/tmp/andrui-{}.hprof", uuid::Uuid::new_v4());
    let mut dump_args = vec![
        "-s".to_string(),
        device_id.to_string(),
        "shell".to_string(),
        "am".to_string(),
        "dumpheap".to_string(),
    ];
    if native {
        dump_args.push("-n".to_string());
    }
    dump_args.push(package.to_string());
    dump_args.push(remote.clone());
    let dump = executor
        .execute(&dump_args, Some(Duration::from_secs(120)), None)
        .await?;
    if dump.exit_code != 0 {
        return Err(ApiError::bad_request(
            "HEAPDUMP_FAILED",
            dump.stderr
                .trim()
                .lines()
                .next()
                .unwrap_or("am dumpheap failed")
                .to_string(),
        ));
    }
    // am dumpheap runs asynchronously; wait until the file stops growing.
    wait_for_stable(executor, device_id, &remote).await;

    let bytes = executor
        .execute_bytes(
            &[
                "-s".into(),
                device_id.into(),
                "exec-out".into(),
                "cat".into(),
                remote.clone(),
            ],
            None,
            Duration::from_secs(120),
            1024 * 1024 * 1024,
        )
        .await?;
    // Clean up the device-side file regardless of outcome.
    let _ = executor
        .execute(
            &[
                "-s".into(),
                device_id.into(),
                "shell".into(),
                "rm".into(),
                "-f".into(),
                remote.clone(),
            ],
            Some(Duration::from_secs(15)),
            None,
        )
        .await;

    if bytes.exit_code != 0 || bytes.stdout.is_empty() {
        return Err(ApiError::bad_request(
            "HEAPDUMP_EMPTY",
            "Heap dump produced no data",
        ));
    }
    let name = format!("{package}-{}.hprof", if native { "native" } else { "java" });
    let artifact = artifacts
        .save_artifact(&name, "application/octet-stream", &bytes.stdout)
        .await?;
    db.insert_artifact(&artifact)?;

    Ok(HeapDumpResult {
        device_id: device_id.to_string(),
        package: package.to_string(),
        artifact_id: artifact.id,
        size_bytes: artifact.size,
        native,
    })
}

/// Poll a device file's size until it stops changing (heap dump completion).
async fn wait_for_stable(executor: &AdbExecutor, device_id: &str, path: &str) {
    let mut last = -1i64;
    for _ in 0..30 {
        tokio::time::sleep(Duration::from_millis(400)).await;
        let out = executor
            .execute(
                &[
                    "-s".into(),
                    device_id.into(),
                    "shell".into(),
                    "stat".into(),
                    "-c".into(),
                    "%s".into(),
                    path.into(),
                ],
                Some(Duration::from_secs(10)),
                None,
            )
            .await;
        let size = out
            .ok()
            .and_then(|o| o.stdout.trim().parse::<i64>().ok())
            .unwrap_or(-1);
        if size > 0 && size == last {
            return;
        }
        last = size;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = r#"Applications Memory Usage (in Kilobytes):
Uptime: 1 Realtime: 2

** MEMINFO in pid 4567 [com.example.app] **
                   Pss  Private  Private
                 Total    Dirty    Clean
                ------   ------   ------
  Native Heap     2048     2000        0
  Dalvik Heap     4096     4000        0

 App Summary
                       Pss(KB)                        Rss(KB)
                        ------                         ------
           Java Heap:     4096                           8000
         Native Heap:     2048                           3000
                Code:     1500                           6000
               Stack:       64                             80
            Graphics:     3000                           3000
       Private Other:      512
              System:     1234
            TOTAL PSS:    12454            TOTAL RSS:    28080
"#;

    #[test]
    fn parses_app_summary_and_pid() {
        let s = parse_meminfo(SAMPLE);
        assert_eq!(s.pid, Some(4567));
        assert_eq!(s.java_heap_kb, Some(4096));
        assert_eq!(s.native_heap_kb, Some(2048));
        assert_eq!(s.code_kb, Some(1500));
        assert_eq!(s.stack_kb, Some(64));
        assert_eq!(s.graphics_kb, Some(3000));
        assert_eq!(s.private_other_kb, Some(512));
        assert_eq!(s.system_kb, Some(1234));
        assert_eq!(s.total_pss_kb, Some(12454));
        assert_eq!(s.total_rss_kb, Some(28080));
    }

    #[test]
    fn missing_fields_are_none_not_zero() {
        let s = parse_meminfo("garbage with no summary");
        assert_eq!(s.java_heap_kb, None);
        assert_eq!(s.total_pss_kb, None);
    }
}
