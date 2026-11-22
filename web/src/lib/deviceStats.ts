// Parsers for GET /api/v1/stats sections. Every parser returns null when the
// device output cannot be read, so the UI can say "Unavailable" instead of guessing.
import type { StatSection } from '../api/client.js';
import type { TelemetryPoint } from '../types/api.js';

export type Sections = Record<string, StatSection>;

const out = (sections: Sections | undefined, key: string): string | null => {
  const section = sections?.[key];
  return section ? section.output : null;
};

const int = (value: string | undefined | null): number | null => {
  if (value === undefined || value === null) return null;
  const n = Number.parseInt(value.trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/** Output of `<cmd> | wc -l` or `grep -c`; grep exits 1 for zero matches but still prints 0. */
export function parseCount(sections: Sections | undefined, key: string): number | null {
  const text = out(sections, key);
  if (text === null) return null;
  return /^\s*\d+\s*$/.test(text) ? int(text) : null;
}

export function parseFirstLine(sections: Sections | undefined, key: string): string | null {
  const section = sections?.[key];
  if (!section || section.exitCode !== 0) return null;
  const line = section.output.split('\n').map((l) => l.trim()).find(Boolean);
  return line ?? null;
}

/** First output line of a section, used to show why a value is missing. */
export function firstLine(section: StatSection | undefined): string {
  const line = section?.output.split('\n').map((l) => l.trim()).find(Boolean);
  return line ? `Device said: ${line}` : 'Not reported by this device';
}

/** `adb forward --list` lists every device's forwards; keep this device's rows. */
export function parseForwards(text: string | null, serial: string): number | null {
  if (text === null) return null;
  return text.split('\n').filter((line) => line.trim().split(/\s+/)[0] === serial).length;
}

export interface PortRule { local: string; remote: string }

/** This device's rules from `adb forward --list` (`SERIAL LOCAL REMOTE`, host-wide). */
export function parseForwardRules(text: string | null, serial: string): PortRule[] | null {
  if (text === null) return null;
  return text.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f[0] === serial && f.length >= 3).map((f) => ({ local: f[1], remote: f[2] }));
}

/** Rules from `adb reverse --list` (`TRANSPORT REMOTE LOCAL`). */
export function parseReverseRules(section: StatSection | undefined): PortRule[] | null {
  if (!section || section.exitCode !== 0) return null;
  return section.output.split('\n').map((l) => l.trim().split(/\s+/)).filter((f) => f.length >= 3).map((f) => ({ remote: f[1], local: f[2] }));
}

export function parseLineCount(section: StatSection | undefined): number | null {
  if (!section || section.exitCode !== 0) return null;
  return section.output.split('\n').filter((l) => l.trim()).length;
}

export interface NetDev {
  rxBytes: number;
  txBytes: number;
}

/** Sum of /proc/net/dev byte counters over every interface except loopback. */
export function parseNetDev(text: string | null): NetDev | null {
  if (!text) return null;
  let rxBytes = 0;
  let txBytes = 0;
  let found = false;
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*([^:\s]+):\s*(.*)$/);
    if (!m || m[1] === 'lo') continue;
    const fields = m[2].trim().split(/\s+/).map(Number);
    if (fields.length < 9 || fields.some((f) => !Number.isFinite(f))) continue;
    rxBytes += fields[0];
    txBytes += fields[8];
    found = true;
  }
  return found ? { rxBytes, txBytes } : null;
}

export interface TcpStates {
  established: number;
  timeWait: number;
}

/** Socket states from /proc/net/tcp and tcp6 (01 = ESTABLISHED, 06 = TIME_WAIT). */
export function parseTcp(text: string | null): TcpStates | null {
  if (!text) return null;
  let established = 0;
  let timeWait = 0;
  let rows = 0;
  for (const line of text.split('\n')) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || !/^\d+:$/.test(cols[0])) continue;
    rows += 1;
    if (cols[3] === '01') established += 1;
    if (cols[3] === '06') timeWait += 1;
  }
  const hasHeader = /local_address/.test(text);
  return rows > 0 || hasHeader ? { established, timeWait } : null;
}

export interface CpuTimes {
  total: number;
  idle: number;
  user: number;
  system: number;
  cores: number;
  ctxt: number | null;
  procsRunning: number | null;
}

export function parseProcStat(text: string | null): CpuTimes | null {
  if (!text) return null;
  const agg = text.match(/^cpu\s+([\d\s]+)$/m);
  if (!agg) return null;
  const v = agg[1].trim().split(/\s+/).map(Number);
  if (v.length < 4) return null;
  const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = v;
  const ctxt = text.match(/^ctxt\s+(\d+)/m);
  const running = text.match(/^procs_running\s+(\d+)/m);
  return {
    total: user + nice + system + idle + iowait + irq + softirq + steal,
    idle: idle + iowait,
    user: user + nice,
    system: system + irq + softirq,
    cores: (text.match(/^cpu\d+\s/gm) || []).length,
    ctxt: ctxt ? Number(ctxt[1]) : null,
    procsRunning: running ? Number(running[1]) : null,
  };
}

export interface CpuUsage {
  total: number;
  user: number;
  system: number;
}

export function cpuUsage(prev: CpuTimes, next: CpuTimes): CpuUsage | null {
  const dt = next.total - prev.total;
  if (dt <= 0) return null;
  const pct = (n: number) => Math.max(0, Math.min(100, Math.round((n / dt) * 1000) / 10));
  return {
    total: pct(dt - (next.idle - prev.idle)),
    user: pct(next.user - prev.user),
    system: pct(next.system - prev.system),
  };
}

export interface MemInfo {
  totalMb: number;
  usedMb: number;
  cachedMb: number;
  freeMb: number;
  availableMb: number | null;
  swapUsedMb: number | null;
  swapTotalMb: number | null;
  dirtyMb: number | null;
  kernelMb: number | null;
}

export function parseMeminfo(text: string | null): MemInfo | null {
  if (!text) return null;
  const kb = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'));
    return m ? Number(m[1]) : null;
  };
  const total = kb('MemTotal');
  const free = kb('MemFree');
  if (total === null || free === null) return null;
  const cached = (kb('Cached') ?? 0) + (kb('Buffers') ?? 0);
  const mb = (n: number | null) => (n === null ? null : Math.round(n / 1024));
  const swapTotal = kb('SwapTotal');
  const swapFree = kb('SwapFree');
  const kernelParts = [kb('Slab'), kb('PageTables'), kb('KernelStack')].filter((n): n is number => n !== null);
  return {
    totalMb: Math.round(total / 1024),
    freeMb: Math.round(free / 1024),
    cachedMb: Math.round(cached / 1024),
    usedMb: Math.round(Math.max(0, total - free - cached) / 1024),
    availableMb: mb(kb('MemAvailable')),
    swapTotalMb: mb(swapTotal),
    swapUsedMb: swapTotal !== null && swapFree !== null ? mb(swapTotal - swapFree) : null,
    dirtyMb: mb(kb('Dirty')),
    kernelMb: kernelParts.length ? mb(kernelParts.reduce((a, b) => a + b, 0)) : null,
  };
}

export const BATTERY_STATUS: Record<number, string> = {
  1: 'Unknown',
  2: 'Charging',
  3: 'Discharging',
  4: 'Not charging',
  5: 'Full',
};
export const BATTERY_HEALTH: Record<number, string> = {
  1: 'Unknown',
  2: 'Good',
  3: 'Overheat',
  4: 'Dead',
  5: 'Over voltage',
  6: 'Failure',
  7: 'Cold',
};

export interface BatteryInfo {
  level: number;
  tempC: number | null;
  voltageMv: number | null;
  status: string;
  health: string | null;
  technology: string | null;
  chargeCounterMah: number | null;
  powerSource: string | null;
}

/** `dumpsys battery`. Fields are matched at line start so "Max charging voltage" is not read as voltage. */
export function parseBattery(text: string | null): BatteryInfo | null {
  if (!text) return null;
  const field = (name: string) => {
    const m = text.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : null;
  };
  const level = int(field('level'));
  if (level === null) return null;
  const temp = int(field('temperature'));
  const statusCode = int(field('status'));
  const healthCode = int(field('health'));
  const counter = int(field('Charge counter'));
  const sources = ['AC', 'USB', 'Wireless', 'Dock']
    .filter((s) => field(`${s} powered`) === 'true');
  return {
    level,
    tempC: temp === null ? null : temp / 10,
    voltageMv: int(field('voltage')),
    status: statusCode !== null ? BATTERY_STATUS[statusCode] ?? `Code ${statusCode}` : 'Unknown',
    health: healthCode !== null ? BATTERY_HEALTH[healthCode] ?? `Code ${healthCode}` : null,
    technology: field('technology'),
    chargeCounterMah: counter !== null && counter > 0 ? Math.round(counter / 1000) : null,
    powerSource: sources.length ? sources.join(' + ') : 'Battery',
  };
}

export const THERMAL_STATUS = ['None', 'Light', 'Moderate', 'Severe', 'Critical', 'Emergency', 'Shutdown'];

export function parseThermal(text: string | null): string | null {
  const m = text?.match(/Thermal Status:\s*(\d+)/);
  if (!m) return null;
  return THERMAL_STATUS[Number(m[1])] ?? `Level ${m[1]}`;
}

/** First line of `dumpsys SurfaceFlinger --latency` is the vsync period in ns. */
export function parseRefreshHz(text: string | null): number | null {
  const period = int(text?.split('\n')[0]);
  if (!period || period <= 0) return null;
  return Math.round(1e9 / period);
}

export interface FrameCounters {
  packageName: string;
  totalFrames: number;
  jankyFrames: number;
  p90Ms: number | null;
}

export function parseFrames(text: string | null): FrameCounters | null {
  if (!text) return null;
  const pkg = text.match(/^package ([\w.]+)$/m);
  const total = text.match(/Total frames rendered:\s*(\d+)/);
  const janky = text.match(/Janky frames:\s*(\d+)/);
  if (!pkg || !total || !janky) return null;
  const p90 = text.match(/90th percentile:\s*(\d+)ms/);
  return {
    packageName: pkg[1],
    totalFrames: Number(total[1]),
    jankyFrames: Number(janky[1]),
    p90Ms: p90 ? Number(p90[1]) : null,
  };
}

export interface TcpCounters {
  outSegs: number;
  retransSegs: number;
}

export function parseSnmpTcp(text: string | null): TcpCounters | null {
  if (!text) return null;
  const lines = text.split('\n').filter((l) => l.startsWith('Tcp:'));
  if (lines.length < 2) return null;
  const names = lines[0].trim().split(/\s+/);
  const values = lines[1].trim().split(/\s+/);
  const get = (name: string) => {
    const i = names.indexOf(name);
    return i >= 0 ? Number(values[i]) : NaN;
  };
  const outSegs = get('OutSegs');
  const retransSegs = get('RetransSegs');
  return Number.isFinite(outSegs) && Number.isFinite(retransSegs) ? { outSegs, retransSegs } : null;
}

/** Groups `cpuinfo_max_freq` (kHz, one line per core) into a topology string. */
export function parseCpuTopology(text: string | null): string | null {
  if (!text) return null;
  const freqs = text.split('\n').map((l) => int(l)).filter((n): n is number => n !== null && n > 0);
  if (!freqs.length) return null;
  const groups = new Map<number, number>();
  for (const f of freqs) groups.set(f, (groups.get(f) ?? 0) + 1);
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([khz, n]) => `${n}× ${(khz / 1e6).toFixed(2)} GHz`)
    .join(' + ');
}

export interface NetInterface {
  name: string;
  mtu: number | null;
  up: boolean;
}

export function parseInterfaces(text: string | null): NetInterface[] | null {
  if (!text) return null;
  const rows = text
    .split('\n')
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 3 && c[0] !== 'lo')
    .map(([name, mtu, state]) => ({ name, mtu: int(mtu), up: state === 'up' }));
  return rows.length ? rows : null;
}

export interface LogBuffer {
  name: string;
  sizeBytes: number;
  usedBytes: number;
}

const UNIT: Record<string, number> = { b: 1, kb: 1024, kib: 1024, mb: 1048576, mib: 1048576, gb: 1073741824, gib: 1073741824 };
const toBytes = (n: string, unit: string) => Number(n) * (UNIT[unit.toLowerCase()] ?? NaN);

/** `logcat -g` in both the older "256Kb (229Kb consumed)" and newer "256 KiB (163 KiB consumed)" forms. */
export function parseLogBuffers(text: string | null): LogBuffer[] | null {
  if (!text) return null;
  const rows: LogBuffer[] = [];
  const re = /^(\w+): ring buffer is ([\d.]+)\s*([KMG]?i?B|[KMG]?b)\s*\(([\d.]+)\s*([KMG]?i?B|[KMG]?b) consumed\)/gm;
  for (const m of text.matchAll(re)) {
    const sizeBytes = toBytes(m[2], m[3]);
    const usedBytes = toBytes(m[4], m[5]);
    if (Number.isFinite(sizeBytes) && Number.isFinite(usedBytes)) rows.push({ name: m[1], sizeBytes, usedBytes });
  }
  return rows.length ? rows : null;
}

/** `cut -c1 | sort | uniq -c` over brief-format logcat: counts per priority letter. */
export function parseLogLevels(text: string | null): Record<string, number> | null {
  if (!text) return null;
  const counts: Record<string, number> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+([VDIWEF])$/);
    if (m) counts[m[2]] = Number(m[1]);
  }
  return Object.keys(counts).length ? counts : null;
}

export interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  availBytes: number;
}

/** `df -k <path>`: second line holds 1K-blocks, Used and Available. */
export function parseDf(text: string | null): DiskUsage | null {
  if (!text) return null;
  const line = text.split('\n').find((l) => /^\S+\s+\d+\s+\d+\s+\d+/.test(l.trim()));
  if (!line) return null;
  const [, total, used, avail] = line.trim().split(/\s+/).map(Number);
  return { totalBytes: total * 1024, usedBytes: used * 1024, availBytes: avail * 1024 };
}

export function parseUsers(text: string | null): { total: number; running: number } | null {
  if (!text || !text.includes('UserInfo{')) return null;
  const rows = text.split('\n').filter((l) => l.includes('UserInfo{'));
  return { total: rows.length, running: rows.filter((l) => /\brunning\b/.test(l)).length };
}

/** `dpm list-owners`: "no owners" or one "admin=" row per device/profile owner. */
export function parseOwners(section: StatSection | undefined): string[] | null {
  if (!section || section.exitCode !== 0) return null;
  if (/no owners/i.test(section.output)) return [];
  return section.output
    .split('\n')
    .map((line) => ({ line, admin: line.match(/admin=([^,\s/]+)/) }))
    .filter((row) => row.admin)
    .map(({ line, admin }) => `${line.includes('DeviceOwner') ? 'Device' : 'Profile'} owner: ${admin![1]}`);
}

export function parseShellId(text: string | null): { uid: string; context: string | null } | null {
  const uid = text?.match(/uid=(\d+\(\w+\))/);
  if (!uid) return null;
  const ctx = text?.match(/context=(\S+)/);
  return { uid: uid[1], context: ctx ? ctx[1] : null };
}

export const formatBytes = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
};

export const formatRate = (bytesPerSec: number) => `${formatBytes(Math.max(0, Math.round(bytesPerSec)))}/s`;

export interface TelemetryDetails {
  ctxtPerSec: number | null;
  procsRunning: number | null;
  cores: number | null;
  topology: string | null;
  governor: string | null;
  memory: MemInfo | null;
  battery: BatteryInfo | null;
  currentMa: number | null;
  thermal: string | null;
  refreshHz: number | null;
  frames: FrameCounters | null;
  tcp: TcpStates | null;
  retransPct: number | null;
  interfaces: NetInterface[] | null;
}

type Sample = { collectedAt: number; sections: Sections };

/** Builds one chart point from the latest sample; rate metrics need the previous sample. */
export function buildTelemetry(cur: Sample, prev: Sample | null): { point: TelemetryPoint; details: TelemetryDetails } {
  const s = cur.sections;
  const p = prev?.sections;
  const dt = prev ? (cur.collectedAt - prev.collectedAt) / 1000 : 0;
  const text = (sec: Sections | undefined, key: string) => sec?.[key]?.output ?? null;

  const statNow = parseProcStat(text(s, 'stat'));
  const statPrev = parseProcStat(text(p, 'stat'));
  const cpu = statNow && statPrev ? cpuUsage(statPrev, statNow) : null;

  const mem = parseMeminfo(text(s, 'meminfo'));
  const battery = parseBattery(text(s, 'battery'));

  const netNow = parseNetDev(text(s, 'netdev'));
  const netPrev = parseNetDev(text(p, 'netdev'));
  const network =
    netNow && netPrev && dt > 0 && netNow.rxBytes >= netPrev.rxBytes && netNow.txBytes >= netPrev.txBytes
      ? {
          rxKb: Math.round((netNow.rxBytes - netPrev.rxBytes) / 1024 / dt),
          txKb: Math.round((netNow.txBytes - netPrev.txBytes) / 1024 / dt),
        }
      : null;

  const framesNow = parseFrames(text(s, 'frames'));
  const framesPrev = parseFrames(text(p, 'frames'));
  const fps =
    framesNow && framesPrev && dt > 0 && framesNow.packageName === framesPrev.packageName && framesNow.totalFrames >= framesPrev.totalFrames
      ? {
          fps: Math.round(((framesNow.totalFrames - framesPrev.totalFrames) / dt) * 10) / 10,
          p90FrameMs: framesNow.p90Ms,
          jankCount: Math.max(0, framesNow.jankyFrames - framesPrev.jankyFrames),
          packageName: framesNow.packageName,
        }
      : null;

  const snmpNow = parseSnmpTcp(text(s, 'snmp'));
  const snmpPrev = parseSnmpTcp(text(p, 'snmp'));
  const outDelta = snmpNow && snmpPrev ? snmpNow.outSegs - snmpPrev.outSegs : 0;
  const retransPct =
    snmpNow && snmpPrev && outDelta > 0
      ? Math.round(((snmpNow.retransSegs - snmpPrev.retransSegs) / outDelta) * 10000) / 100
      : null;

  // current_now is µA on most kernels; a few report mA directly.
  const rawCurrent = int(text(s, 'current'));
  const currentMa =
    rawCurrent === null || s.current?.exitCode !== 0 ? null : Math.abs(rawCurrent) > 20000 ? Math.round(rawCurrent / 1000) : rawCurrent;

  return {
    point: {
      timestamp: cur.collectedAt,
      cpu,
      memory: mem ? { usedMb: mem.usedMb, cachedMb: mem.cachedMb, freeMb: mem.freeMb, totalMb: mem.totalMb } : null,
      battery: battery
        ? { level: battery.level, tempC: battery.tempC, voltageMv: battery.voltageMv, status: battery.status }
        : null,
      fps,
      network,
    },
    details: {
      ctxtPerSec:
        statNow?.ctxt != null && statPrev?.ctxt != null && dt > 0 ? Math.round((statNow.ctxt - statPrev.ctxt) / dt) : null,
      procsRunning: statNow?.procsRunning ?? null,
      cores: statNow?.cores || null,
      topology: parseCpuTopology(text(s, 'cpufreq')),
      governor: parseFirstLine(s, 'governor'),
      memory: mem,
      battery,
      currentMa,
      thermal: parseThermal(text(s, 'thermal')),
      refreshHz: parseRefreshHz(text(s, 'refresh')),
      frames: framesNow,
      tcp: parseTcp(text(s, 'tcp')),
      retransPct,
      interfaces: parseInterfaces(text(s, 'interfaces')),
    },
  };
}
