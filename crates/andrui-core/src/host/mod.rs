use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::CString;
use std::fs;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostTelemetry {
    pub collected_at: u64,
    pub hostname: String,
    pub kernel: String,
    pub arch: String,
    pub uptime_secs: u64,
    pub cpu: HostCpuTelemetry,
    pub memory: HostMemoryTelemetry,
    pub disks: Vec<HostDiskTelemetry>,
    pub network: Vec<HostNetTelemetry>,
    pub thermals: Vec<HostThermalTelemetry>,
    pub battery: Option<HostBatteryTelemetry>,
    pub gpus: Vec<HostGpuTelemetry>,
    pub process_summary: HostProcessSummary,
    pub processes: Vec<HostProcessEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostGpuTelemetry {
    pub name: String,
    pub driver: String,
    pub pci_slot: String,
    /// Runtime-suspended GPUs are reported without querying them, so polling never wakes them.
    pub suspended: bool,
    pub usage_percent: Option<f64>,
    pub memory_used_bytes: Option<u64>,
    pub memory_total_bytes: Option<u64>,
    pub temp_c: Option<f64>,
    pub frequency_mhz: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostCpuTelemetry {
    pub model: String,
    pub cores: usize,
    pub usage_percent: f64,
    pub per_core_percent: Vec<f64>,
    pub load_avg: [f64; 3],
    pub frequency_mhz: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostMemoryTelemetry {
    pub total_kb: u64,
    pub available_kb: u64,
    pub used_kb: u64,
    pub cached_kb: u64,
    pub buffers_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
    pub usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDiskTelemetry {
    pub mount_point: String,
    pub device: String,
    pub fs_type: String,
    pub total_bytes: u64,
    pub used_bytes: u64,
    pub available_bytes: u64,
    pub usage_percent: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostNetTelemetry {
    pub interface: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_bytes_per_sec: f64,
    pub tx_bytes_per_sec: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostThermalTelemetry {
    pub label: String,
    pub temp_c: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostBatteryTelemetry {
    pub capacity_percent: u8,
    pub status: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProcessSummary {
    pub total: usize,
    pub running: usize,
    pub sleeping: usize,
    pub threads: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostProcessEntry {
    pub pid: u32,
    pub ppid: u32,
    pub uid: u32,
    pub name: String,
    pub cmdline: String,
    pub state: String,
    pub cpu_percent: f64,
    pub rss_kb: u64,
    pub threads: u32,
}

#[derive(Clone, Copy)]
struct CpuTicks {
    total: u64,
    idle: u64,
}

struct PrevSnapshot {
    taken_at: Instant,
    total_cpu: CpuTicks,
    per_core: Vec<CpuTicks>,
    net_bytes: HashMap<String, (u64, u64)>,
    proc_ticks: HashMap<u32, u64>,
    drm_engines: DrmEngineSample,
}

/// DRM fdinfo engine busy time, keyed by (pci slot, client id, engine).
#[derive(Default)]
struct DrmEngineSample {
    busy_ns: HashMap<(String, String, String), u64>,
    capacity: HashMap<(String, String), u64>,
}

static PREV_SNAPSHOT: OnceLock<Mutex<Option<PrevSnapshot>>> = OnceLock::new();

fn snapshot_lock() -> &'static Mutex<Option<PrevSnapshot>> {
    PREV_SNAPSHOT.get_or_init(|| Mutex::new(None))
}

pub async fn collect_host_telemetry() -> HostTelemetry {
    let needs_warmup = {
        let guard = snapshot_lock().lock().unwrap_or_else(|e| e.into_inner());
        guard.is_none()
    };
    if needs_warmup {
        let _ = tokio::task::spawn_blocking(collect_sync).await;
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    tokio::task::spawn_blocking(collect_sync)
        .await
        .unwrap_or_else(|_| empty_telemetry())
}

fn empty_telemetry() -> HostTelemetry {
    HostTelemetry {
        collected_at: now_ms(),
        hostname: "unknown".to_string(),
        kernel: "unknown".to_string(),
        arch: std::env::consts::ARCH.to_string(),
        uptime_secs: 0,
        cpu: HostCpuTelemetry {
            model: "Unknown CPU".to_string(),
            cores: 1,
            usage_percent: 0.0,
            per_core_percent: vec![],
            load_avg: [0.0, 0.0, 0.0],
            frequency_mhz: None,
        },
        memory: HostMemoryTelemetry {
            total_kb: 0,
            available_kb: 0,
            used_kb: 0,
            cached_kb: 0,
            buffers_kb: 0,
            swap_total_kb: 0,
            swap_used_kb: 0,
            usage_percent: 0.0,
        },
        disks: vec![],
        network: vec![],
        thermals: vec![],
        battery: None,
        gpus: vec![],
        process_summary: HostProcessSummary {
            total: 0,
            running: 0,
            sleeping: 0,
            threads: 0,
        },
        processes: vec![],
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn collect_sync() -> HostTelemetry {
    let now = Instant::now();
    let hostname = read_trimmed("/proc/sys/kernel/hostname").unwrap_or_else(|| "localhost".into());
    let kernel = read_trimmed("/proc/sys/kernel/osrelease").unwrap_or_else(|| "linux".into());
    let uptime_secs = parse_uptime(&fs::read_to_string("/proc/uptime").unwrap_or_default());
    let load_avg = parse_loadavg(&fs::read_to_string("/proc/loadavg").unwrap_or_default());
    let (model, core_count_info, frequency_mhz) =
        parse_cpuinfo(&fs::read_to_string("/proc/cpuinfo").unwrap_or_default());

    let (total_cpu_ticks, per_core_ticks) =
        parse_proc_stat(&fs::read_to_string("/proc/stat").unwrap_or_default());
    let cores = per_core_ticks.len().max(core_count_info).max(1);

    let memory = parse_meminfo(&fs::read_to_string("/proc/meminfo").unwrap_or_default());
    let disks = collect_disks();
    let raw_net = parse_net_dev(&fs::read_to_string("/proc/net/dev").unwrap_or_default());
    let thermals = collect_thermals();
    let battery = collect_battery();
    let mut gpus = collect_gpus();
    let drm_engines = collect_drm_engines();
    let (raw_procs, proc_summary) = collect_processes();

    let mut guard = snapshot_lock().lock().unwrap_or_else(|e| e.into_inner());
    let prev = guard.as_ref();

    let (usage_percent, per_core_percent) = if let Some(prev) = prev {
        let total_pct = cpu_delta_pct(prev.total_cpu, total_cpu_ticks);
        let cores_pct = per_core_ticks
            .iter()
            .enumerate()
            .map(|(i, cur)| {
                prev.per_core
                    .get(i)
                    .map(|p| cpu_delta_pct(*p, *cur))
                    .unwrap_or(0.0)
            })
            .collect();
        (total_pct, cores_pct)
    } else {
        (0.0, vec![0.0; per_core_ticks.len()])
    };

    let elapsed_secs = prev
        .map(|p| now.duration_since(p.taken_at).as_secs_f64())
        .unwrap_or(0.0);

    let network: Vec<HostNetTelemetry> = raw_net
        .iter()
        .map(|(iface, rx, tx)| {
            let (rx_rate, tx_rate) = if let Some(prev) = prev {
                if elapsed_secs > 0.05 {
                    if let Some((prx, ptx)) = prev.net_bytes.get(iface) {
                        (
                            rx.saturating_sub(*prx) as f64 / elapsed_secs,
                            tx.saturating_sub(*ptx) as f64 / elapsed_secs,
                        )
                    } else {
                        (0.0, 0.0)
                    }
                } else {
                    (0.0, 0.0)
                }
            } else {
                (0.0, 0.0)
            };
            HostNetTelemetry {
                interface: iface.clone(),
                rx_bytes: *rx,
                tx_bytes: *tx,
                rx_bytes_per_sec: round1(rx_rate),
                tx_bytes_per_sec: round1(tx_rate),
            }
        })
        .collect();

    if let Some(prev) = prev {
        apply_drm_engine_usage(&mut gpus, &prev.drm_engines, &drm_engines, elapsed_secs);
    }

    let total_cpu_delta = prev
        .map(|p| total_cpu_ticks.total.saturating_sub(p.total_cpu.total))
        .unwrap_or(0);

    let mut processes: Vec<HostProcessEntry> = raw_procs
        .iter()
        .map(|p| {
            let cpu_percent = if total_cpu_delta > 0 {
                if let Some(prev_ticks) = prev.and_then(|s| s.proc_ticks.get(&p.pid)) {
                    let delta = p.cpu_ticks.saturating_sub(*prev_ticks);
                    round1((delta as f64 / total_cpu_delta as f64) * 100.0 * cores as f64)
                } else {
                    0.0
                }
            } else {
                0.0
            };
            HostProcessEntry {
                pid: p.pid,
                ppid: p.ppid,
                uid: p.uid,
                name: p.name.clone(),
                cmdline: p.cmdline.clone(),
                state: p.state.clone(),
                cpu_percent,
                rss_kb: p.rss_kb,
                threads: p.threads,
            }
        })
        .collect();

    processes.sort_by(|a, b| {
        b.cpu_percent
            .partial_cmp(&a.cpu_percent)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.rss_kb.cmp(&a.rss_kb))
    });
    processes.truncate(100);

    let mut next_net = HashMap::with_capacity(raw_net.len());
    for (iface, rx, tx) in raw_net {
        next_net.insert(iface, (rx, tx));
    }
    let mut next_procs = HashMap::with_capacity(raw_procs.len());
    for p in raw_procs {
        next_procs.insert(p.pid, p.cpu_ticks);
    }

    *guard = Some(PrevSnapshot {
        taken_at: now,
        total_cpu: total_cpu_ticks,
        per_core: per_core_ticks,
        net_bytes: next_net,
        proc_ticks: next_procs,
        drm_engines,
    });

    HostTelemetry {
        collected_at: now_ms(),
        hostname,
        kernel,
        arch: std::env::consts::ARCH.to_string(),
        uptime_secs,
        cpu: HostCpuTelemetry {
            model,
            cores,
            usage_percent,
            per_core_percent,
            load_avg,
            frequency_mhz,
        },
        memory,
        disks,
        network,
        thermals,
        battery,
        gpus,
        process_summary: proc_summary,
        processes,
    }
}

fn read_trimmed(path: &str) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn cpu_delta_pct(prev: CpuTicks, cur: CpuTicks) -> f64 {
    let total_d = cur.total.saturating_sub(prev.total);
    let idle_d = cur.idle.saturating_sub(prev.idle);
    if total_d == 0 {
        return 0.0;
    }
    let busy = total_d.saturating_sub(idle_d) as f64;
    round1((busy / total_d as f64) * 100.0).clamp(0.0, 100.0)
}

fn parse_uptime(content: &str) -> u64 {
    content
        .split_whitespace()
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .map(|v| v.max(0.0) as u64)
        .unwrap_or(0)
}

fn parse_loadavg(content: &str) -> [f64; 3] {
    let mut parts = content.split_whitespace();
    let l1 = parts
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let l5 = parts
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    let l15 = parts
        .next()
        .and_then(|v| v.parse::<f64>().ok())
        .unwrap_or(0.0);
    [
        round1(l1 * 10.0) / 10.0,
        round1(l5 * 10.0) / 10.0,
        round1(l15 * 10.0) / 10.0,
    ]
}

fn parse_cpuinfo(content: &str) -> (String, usize, Option<f64>) {
    let mut model = String::new();
    let mut cores = 0usize;
    let mut freq_sum = 0.0f64;
    let mut freq_count = 0usize;

    for line in content.lines() {
        if let Some((k, v)) = line.split_once(':') {
            let key = k.trim();
            let val = v.trim();
            match key {
                "processor" => cores += 1,
                "model name" | "Hardware" | "Processor" if model.is_empty() => {
                    model = val.to_string();
                }
                "cpu MHz" => {
                    if let Ok(f) = val.parse::<f64>() {
                        freq_sum += f;
                        freq_count += 1;
                    }
                }
                _ => {}
            }
        }
    }
    if model.is_empty() {
        model = format!("{} CPU", std::env::consts::ARCH);
    }
    let avg_freq = if freq_count > 0 {
        Some((freq_sum / freq_count as f64).round())
    } else {
        None
    };
    (model, cores, avg_freq)
}

fn parse_cpu_line(line: &str) -> Option<CpuTicks> {
    let mut parts = line.split_whitespace();
    let _label = parts.next()?;
    let nums: Vec<u64> = parts.filter_map(|p| p.parse::<u64>().ok()).collect();
    if nums.len() < 4 {
        return None;
    }
    let idle = nums[3] + nums.get(4).copied().unwrap_or(0);
    let total: u64 = nums.iter().sum();
    Some(CpuTicks { total, idle })
}

fn parse_proc_stat(content: &str) -> (CpuTicks, Vec<CpuTicks>) {
    let mut total = CpuTicks { total: 0, idle: 0 };
    let mut per_core = Vec::new();
    for line in content.lines() {
        if line.starts_with("cpu ") {
            if let Some(t) = parse_cpu_line(line) {
                total = t;
            }
        } else if line.starts_with("cpu") {
            if let Some(t) = parse_cpu_line(line) {
                per_core.push(t);
            }
        }
    }
    (total, per_core)
}

fn parse_meminfo(content: &str) -> HostMemoryTelemetry {
    let mut map: HashMap<&str, u64> = HashMap::new();
    for line in content.lines() {
        if let Some((k, rest)) = line.split_once(':') {
            if let Some(val_str) = rest.split_whitespace().next() {
                if let Ok(v) = val_str.parse::<u64>() {
                    map.insert(k.trim(), v);
                }
            }
        }
    }
    let total_kb = *map.get("MemTotal").unwrap_or(&0);
    let available_kb = map
        .get("MemAvailable")
        .copied()
        .unwrap_or_else(|| map.get("MemFree").copied().unwrap_or(0));
    let used_kb = total_kb.saturating_sub(available_kb);
    let cached_kb =
        map.get("Cached").copied().unwrap_or(0) + map.get("SReclaimable").copied().unwrap_or(0);
    let buffers_kb = map.get("Buffers").copied().unwrap_or(0);
    let swap_total_kb = map.get("SwapTotal").copied().unwrap_or(0);
    let swap_free_kb = map.get("SwapFree").copied().unwrap_or(0);
    let swap_used_kb = swap_total_kb.saturating_sub(swap_free_kb);
    let usage_percent = if total_kb > 0 {
        round1((used_kb as f64 / total_kb as f64) * 100.0)
    } else {
        0.0
    };

    HostMemoryTelemetry {
        total_kb,
        available_kb,
        used_kb,
        cached_kb,
        buffers_kb,
        swap_total_kb,
        swap_used_kb,
        usage_percent,
    }
}

fn collect_disks() -> Vec<HostDiskTelemetry> {
    let content = match fs::read_to_string("/proc/mounts") {
        Ok(c) => c,
        Err(_) => return vec![],
    };
    let mut seen_devices = HashMap::new();
    let mut disks = Vec::new();
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        let (Some(dev), Some(mount), Some(fs_type)) = (parts.next(), parts.next(), parts.next())
        else {
            continue;
        };
        if !matches!(
            fs_type,
            "ext4"
                | "ext3"
                | "ext2"
                | "btrfs"
                | "xfs"
                | "f2fs"
                | "zfs"
                | "vfat"
                | "exfat"
                | "ntfs"
                | "fuseblk"
        ) {
            continue;
        }
        if mount.starts_with("/snap/") || mount.starts_with("/var/lib/docker/") {
            continue;
        }
        if seen_devices.contains_key(dev) && mount != "/" {
            continue;
        }
        if let Some((total, avail)) = statvfs_bytes(mount) {
            if total == 0 {
                continue;
            }
            seen_devices.insert(dev.to_string(), ());
            let used = total.saturating_sub(avail);
            let usage_percent = round1((used as f64 / total as f64) * 100.0);
            disks.push(HostDiskTelemetry {
                mount_point: mount.to_string(),
                device: dev.to_string(),
                fs_type: fs_type.to_string(),
                total_bytes: total,
                used_bytes: used,
                available_bytes: avail,
                usage_percent,
            });
        }
    }
    disks.sort_by(|a, b| a.mount_point.cmp(&b.mount_point));
    disks.truncate(8);
    disks
}

fn statvfs_bytes(path: &str) -> Option<(u64, u64)> {
    let c_path = CString::new(path).ok()?;
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) };
    if rc != 0 {
        return None;
    }
    let frsize = if stat.f_frsize > 0 {
        stat.f_frsize as u64
    } else {
        stat.f_bsize as u64
    };
    let total = (stat.f_blocks as u64).saturating_mul(frsize);
    let avail = (stat.f_bavail as u64).saturating_mul(frsize);
    Some((total, avail))
}

fn parse_net_dev(content: &str) -> Vec<(String, u64, u64)> {
    let mut out = Vec::new();
    for line in content.lines().skip(2) {
        let Some((iface, rest)) = line.split_once(':') else {
            continue;
        };
        let iface = iface.trim();
        if iface == "lo" {
            continue;
        }
        let nums: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|p| p.parse::<u64>().ok())
            .collect();
        if nums.len() >= 9 {
            out.push((iface.to_string(), nums[0], nums[8]));
        }
    }
    out
}

fn collect_thermals() -> Vec<HostThermalTelemetry> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir("/sys/class/thermal") else {
        return out;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("thermal_zone") {
            continue;
        }
        let path = entry.path();
        let label = fs::read_to_string(path.join("type"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| name.to_string_lossy().to_string());
        if let Ok(temp_str) = fs::read_to_string(path.join("temp")) {
            if let Ok(milli) = temp_str.trim().parse::<i64>() {
                if milli > 0 && milli < 200_000 {
                    out.push(HostThermalTelemetry {
                        label,
                        temp_c: round1(milli as f64 / 1000.0),
                    });
                }
            }
        }
    }
    out.sort_by(|a, b| a.label.cmp(&b.label));
    out.truncate(8);
    out
}

fn collect_battery() -> Option<HostBatteryTelemetry> {
    let entries = fs::read_dir("/sys/class/power_supply").ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("BAT") {
            continue;
        }
        let path = entry.path();
        let capacity = fs::read_to_string(path.join("capacity"))
            .ok()
            .and_then(|s| s.trim().parse::<u8>().ok())?;
        let status = fs::read_to_string(path.join("status"))
            .map(|s| s.trim().to_string())
            .unwrap_or_else(|_| "Unknown".to_string());
        return Some(HostBatteryTelemetry {
            capacity_percent: capacity.min(100),
            status,
        });
    }
    None
}

fn read_path_trimmed(path: &Path) -> Option<String> {
    fs::read_to_string(path)
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

fn read_path_u64(path: &Path) -> Option<u64> {
    read_path_trimmed(path)?.parse().ok()
}

fn collect_gpus() -> Vec<HostGpuTelemetry> {
    let mut gpus = Vec::new();
    let Ok(entries) = fs::read_dir("/sys/class/drm") else {
        return gpus;
    };
    for entry in entries.flatten() {
        let file_name = entry.file_name().to_string_lossy().into_owned();
        // Only primary nodes (card0), not connectors (card0-eDP-1) or render nodes.
        let Some(index) = file_name.strip_prefix("card") else {
            continue;
        };
        if index.is_empty() || !index.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let card = entry.path();
        let dev = card.join("device");
        let Some(pci_slot) = fs::canonicalize(&dev)
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
        else {
            continue;
        };
        let driver = fs::read_link(dev.join("driver"))
            .ok()
            .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
            .unwrap_or_else(|| "unknown".to_string());
        let name = match read_path_trimmed(&dev.join("vendor")).as_deref() {
            Some("0x10de") => "NVIDIA GPU",
            Some("0x8086") => "Intel GPU",
            Some("0x1002") => "AMD GPU",
            _ => "GPU",
        }
        .to_string();
        let suspended =
            read_path_trimmed(&dev.join("power/runtime_status")).as_deref() == Some("suspended");

        let mut gpu = HostGpuTelemetry {
            name,
            driver,
            pci_slot,
            suspended,
            usage_percent: None,
            memory_used_bytes: None,
            memory_total_bytes: None,
            temp_c: None,
            frequency_mhz: None,
        };
        if !suspended {
            // amdgpu exposes these directly; other drivers simply lack the files.
            gpu.usage_percent =
                read_path_u64(&dev.join("gpu_busy_percent")).map(|v| v.min(100) as f64);
            gpu.memory_used_bytes = read_path_u64(&dev.join("mem_info_vram_used"));
            gpu.memory_total_bytes = read_path_u64(&dev.join("mem_info_vram_total"));
            gpu.frequency_mhz = read_path_u64(&card.join("gt_act_freq_mhz")).map(|v| v as f64);
            gpu.temp_c = fs::read_dir(dev.join("hwmon")).ok().and_then(|dirs| {
                dirs.flatten().find_map(|d| {
                    read_path_u64(&d.path().join("temp1_input")).map(|m| round1(m as f64 / 1000.0))
                })
            });
        }
        gpus.push(gpu);
    }
    gpus.sort_by(|a, b| a.pci_slot.cmp(&b.pci_slot));

    if gpus.iter().any(|g| g.driver == "nvidia" && !g.suspended) {
        let output = run_with_timeout(
            "nvidia-smi",
            &[
                "--query-gpu=pci.bus_id,name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            Duration::from_secs(2),
        );
        for sample in parse_nvidia_smi(&output.unwrap_or_default()) {
            if let Some(gpu) = gpus.iter_mut().find(|g| {
                g.driver == "nvidia"
                    && !g.suspended
                    && pci_bus_suffix(&g.pci_slot) == pci_bus_suffix(&sample.bus_id)
            }) {
                gpu.name = sample.name;
                gpu.usage_percent = sample.usage_percent;
                gpu.memory_used_bytes = sample.memory_used_bytes;
                gpu.memory_total_bytes = sample.memory_total_bytes;
                gpu.temp_c = sample.temp_c;
            }
        }
    }
    gpus
}

/// PCI address without the domain, which sysfs prints with 4 digits and nvidia-smi with 8.
fn pci_bus_suffix(addr: &str) -> String {
    let lower = addr.trim().to_ascii_lowercase();
    match lower.split_once(':') {
        Some((_, rest)) => rest.to_string(),
        None => lower,
    }
}

struct NvidiaSample {
    bus_id: String,
    name: String,
    usage_percent: Option<f64>,
    memory_used_bytes: Option<u64>,
    memory_total_bytes: Option<u64>,
    temp_c: Option<f64>,
}

fn parse_nvidia_smi(content: &str) -> Vec<NvidiaSample> {
    let mib = |v: &str| v.parse::<u64>().ok().map(|m| m * 1024 * 1024);
    content
        .lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split(',').map(str::trim).collect();
            if cols.len() < 6 {
                return None;
            }
            Some(NvidiaSample {
                bus_id: cols[0].to_string(),
                name: cols[1].to_string(),
                usage_percent: cols[2].parse::<f64>().ok().map(|v| v.clamp(0.0, 100.0)),
                memory_used_bytes: mib(cols[3]),
                memory_total_bytes: mib(cols[4]),
                temp_c: cols[5].parse::<f64>().ok(),
            })
        })
        .collect()
}

fn run_with_timeout(program: &str, args: &[&str], timeout: Duration) -> Option<String> {
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => {
                let mut out = String::new();
                child.stdout.take()?.read_to_string(&mut out).ok()?;
                return Some(out);
            }
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            Ok(None) | Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(Some(_)) => return None,
        }
    }
}

/// Reads DRM client fdinfo from every readable process (i915, xe, amdgpu, msm, panfrost, ...).
fn collect_drm_engines() -> DrmEngineSample {
    let mut sample = DrmEngineSample::default();
    let Ok(procs) = fs::read_dir("/proc") else {
        return sample;
    };
    for proc_entry in procs.flatten() {
        if proc_entry
            .file_name()
            .to_string_lossy()
            .parse::<u32>()
            .is_err()
        {
            continue;
        }
        let pdir = proc_entry.path();
        let Ok(fds) = fs::read_dir(pdir.join("fd")) else {
            continue;
        };
        for fd in fds.flatten() {
            let is_dri = fs::read_link(fd.path())
                .map(|t| t.starts_with("/dev/dri/"))
                .unwrap_or(false);
            if !is_dri {
                continue;
            }
            if let Ok(info) = fs::read_to_string(pdir.join("fdinfo").join(fd.file_name())) {
                parse_drm_fdinfo(&info, &mut sample);
            }
        }
    }
    sample
}

fn parse_drm_fdinfo(content: &str, sample: &mut DrmEngineSample) {
    let mut pdev = None;
    let mut client = None;
    let mut engines = Vec::new();
    let mut capacities = Vec::new();
    for line in content.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        if key == "drm-pdev" {
            pdev = Some(value.to_string());
        } else if key == "drm-client-id" {
            client = Some(value.to_string());
        } else if let Some(engine) = key.strip_prefix("drm-engine-capacity-") {
            if let Ok(cap) = value.parse::<u64>() {
                capacities.push((engine.to_string(), cap));
            }
        } else if let Some(engine) = key.strip_prefix("drm-engine-") {
            if let Some(Ok(ns)) = value.strip_suffix("ns").map(|v| v.trim().parse::<u64>()) {
                engines.push((engine.to_string(), ns));
            }
        }
    }
    let (Some(pdev), Some(client)) = (pdev, client) else {
        return;
    };
    // Several fds can share one client id; they report the same counters.
    for (engine, ns) in engines {
        sample
            .busy_ns
            .insert((pdev.clone(), client.clone(), engine), ns);
    }
    for (engine, cap) in capacities {
        sample.capacity.insert((pdev.clone(), engine), cap.max(1));
    }
}

/// Fills usage for GPUs without a direct source as the busiest engine's share of wall time.
fn apply_drm_engine_usage(
    gpus: &mut [HostGpuTelemetry],
    prev: &DrmEngineSample,
    cur: &DrmEngineSample,
    elapsed_secs: f64,
) {
    if elapsed_secs <= 0.05 {
        return;
    }
    let mut deltas: HashMap<(&str, &str), u64> = HashMap::new();
    for (key, ns) in &cur.busy_ns {
        let delta = prev
            .busy_ns
            .get(key)
            .map(|p| ns.saturating_sub(*p))
            .unwrap_or(0);
        *deltas.entry((key.0.as_str(), key.2.as_str())).or_default() += delta;
    }
    for gpu in gpus
        .iter_mut()
        .filter(|g| g.usage_percent.is_none() && !g.suspended)
    {
        let busiest = deltas
            .iter()
            .filter(|((pdev, _), _)| *pdev == gpu.pci_slot)
            .map(|((pdev, engine), delta)| {
                let cap = cur
                    .capacity
                    .get(&(pdev.to_string(), engine.to_string()))
                    .copied()
                    .unwrap_or(1);
                *delta as f64 / (elapsed_secs * 1e9 * cap as f64) * 100.0
            })
            .reduce(f64::max);
        gpu.usage_percent = busiest.map(|pct| round1(pct.clamp(0.0, 100.0)));
    }
}

struct RawProc {
    pid: u32,
    ppid: u32,
    uid: u32,
    name: String,
    cmdline: String,
    state: String,
    cpu_ticks: u64,
    rss_kb: u64,
    threads: u32,
}

fn collect_processes() -> (Vec<RawProc>, HostProcessSummary) {
    let mut procs = Vec::new();
    let mut summary = HostProcessSummary {
        total: 0,
        running: 0,
        sleeping: 0,
        threads: 0,
    };

    let Ok(entries) = fs::read_dir("/proc") else {
        return (procs, summary);
    };

    let page_kb = 4u64;

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let Ok(pid) = fname.to_string_lossy().parse::<u32>() else {
            continue;
        };
        let pdir = entry.path();
        let Ok(stat) = fs::read_to_string(pdir.join("stat")) else {
            continue;
        };
        // Format: pid (comm) state ppid ...
        let Some(open_paren) = stat.find('(') else {
            continue;
        };
        let Some(close_paren) = stat.rfind(')') else {
            continue;
        };
        if close_paren <= open_paren {
            continue;
        }
        let name = stat[open_paren + 1..close_paren].to_string();
        let rest: Vec<&str> = stat[close_paren + 2..].split_whitespace().collect();
        if rest.len() < 22 {
            continue;
        }
        let state = rest[0].to_string();
        let ppid = rest[1].parse::<u32>().unwrap_or(0);
        let utime = rest[11].parse::<u64>().unwrap_or(0);
        let stime = rest[12].parse::<u64>().unwrap_or(0);
        let threads = rest[17].parse::<u32>().unwrap_or(1);
        let rss_pages = rest[21].parse::<u64>().unwrap_or(0);

        summary.total += 1;
        summary.threads += threads as usize;
        if state == "R" {
            summary.running += 1;
        } else {
            summary.sleeping += 1;
        }

        let cmdline = fs::read(pdir.join("cmdline"))
            .map(|bytes| {
                bytes
                    .split(|&b| b == 0)
                    .filter(|s| !s.is_empty())
                    .map(|s| String::from_utf8_lossy(s).into_owned())
                    .collect::<Vec<_>>()
                    .join(" ")
            })
            .unwrap_or_default();

        let uid = fs::read_to_string(pdir.join("status"))
            .ok()
            .and_then(|s| {
                s.lines().find_map(|l| {
                    l.strip_prefix("Uid:")
                        .and_then(|v| v.split_whitespace().next())
                        .and_then(|u| u.parse::<u32>().ok())
                })
            })
            .unwrap_or(0);

        procs.push(RawProc {
            pid,
            ppid,
            uid,
            name: name.clone(),
            cmdline: if cmdline.is_empty() {
                format!("[{}]", name)
            } else {
                cmdline
            },
            state,
            cpu_ticks: utime.saturating_add(stime),
            rss_kb: rss_pages.saturating_mul(page_kb),
            threads,
        });
    }

    (procs, summary)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_meminfo_correctly() {
        let sample = "\
MemTotal:       16384000 kB
MemFree:         2000000 kB
MemAvailable:    8192000 kB
Buffers:          512000 kB
Cached:          4096000 kB
SReclaimable:     256000 kB
SwapTotal:       4096000 kB
SwapFree:        3072000 kB
";
        let mem = parse_meminfo(sample);
        assert_eq!(mem.total_kb, 16384000);
        assert_eq!(mem.available_kb, 8192000);
        assert_eq!(mem.used_kb, 8192000);
        assert_eq!(mem.usage_percent, 50.0);
        assert_eq!(mem.swap_total_kb, 4096000);
        assert_eq!(mem.swap_used_kb, 1024000);
    }

    #[test]
    fn parses_proc_stat_and_delta() {
        let s1 = "cpu  100 0 50 850 0 0 0 0 0 0\ncpu0 50 0 25 425 0 0 0 0 0 0\n";
        let s2 = "cpu  150 0 100 950 0 0 0 0 0 0\ncpu0 75 0 50 475 0 0 0 0 0 0\n";
        let (t1, c1) = parse_proc_stat(s1);
        let (t2, c2) = parse_proc_stat(s2);
        assert_eq!(c1.len(), 1);
        assert_eq!(c2.len(), 1);
        assert_eq!(cpu_delta_pct(t1, t2), 50.0);
        assert_eq!(cpu_delta_pct(c1[0], c2[0]), 50.0);
    }

    #[test]
    fn parses_net_dev_skipping_loopback() {
        let sample = "\
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0
  eth0:   50000     100    0    0    0     0          0         0    25000      50    0    0    0     0       0          0
";
        let net = parse_net_dev(sample);
        assert_eq!(net.len(), 1);
        assert_eq!(net[0].0, "eth0");
        assert_eq!(net[0].1, 50000);
        assert_eq!(net[0].2, 25000);
    }

    #[test]
    fn parses_nvidia_smi_and_matches_bus_ids() {
        let out = "00000000:01:00.0, NVIDIA GeForce RTX 3060 Laptop GPU, 7, 4786, 6144, 54\n\
                   00000000:02:00.0, Other, [N/A], [N/A], 1024, [N/A]\n";
        let samples = parse_nvidia_smi(out);
        assert_eq!(samples.len(), 2);
        assert_eq!(samples[0].name, "NVIDIA GeForce RTX 3060 Laptop GPU");
        assert_eq!(samples[0].usage_percent, Some(7.0));
        assert_eq!(samples[0].memory_used_bytes, Some(4786 * 1024 * 1024));
        assert_eq!(samples[0].temp_c, Some(54.0));
        assert_eq!(samples[1].usage_percent, None);
        assert_eq!(samples[1].memory_used_bytes, None);
        assert_eq!(
            pci_bus_suffix(&samples[0].bus_id),
            pci_bus_suffix("0000:01:00.0")
        );
    }

    #[test]
    fn computes_drm_engine_usage_from_fdinfo_deltas() {
        let fdinfo = |render_ns: u64, video_ns: u64| {
            format!(
                "drm-driver:\ti915\ndrm-client-id:\t36\ndrm-pdev:\t0000:00:02.0\n\
                 drm-total-system0:\t557836 KiB\ndrm-engine-render:\t{render_ns} ns\n\
                 drm-engine-video:\t{video_ns} ns\ndrm-engine-capacity-video:\t2\n"
            )
        };
        let mut prev = DrmEngineSample::default();
        parse_drm_fdinfo(&fdinfo(1_000_000_000, 0), &mut prev);
        let mut cur = DrmEngineSample::default();
        parse_drm_fdinfo(&fdinfo(1_250_000_000, 800_000_000), &mut cur);
        assert_eq!(
            cur.capacity.get(&("0000:00:02.0".into(), "video".into())),
            Some(&2)
        );

        let gpu = |slot: &str| HostGpuTelemetry {
            name: "Intel GPU".into(),
            driver: "i915".into(),
            pci_slot: slot.into(),
            suspended: false,
            usage_percent: None,
            memory_used_bytes: None,
            memory_total_bytes: None,
            temp_c: None,
            frequency_mhz: None,
        };
        let mut gpus = vec![gpu("0000:00:02.0"), gpu("0000:01:00.0")];
        apply_drm_engine_usage(&mut gpus, &prev, &cur, 1.0);
        // Video: 0.8s busy over 2 instances = 40%; render: 25%. Busiest engine wins.
        assert_eq!(gpus[0].usage_percent, Some(40.0));
        assert_eq!(gpus[1].usage_percent, None);
    }
}
