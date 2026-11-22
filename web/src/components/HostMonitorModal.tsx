import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  ArrowDown,
  ArrowUp,
  Battery,
  Check,
  Cpu,
  Download,
  HardDrive,
  Maximize2,
  Microchip,
  Minimize2,
  Network,
  Palette,
  Pause,
  Play,
  Search,
  Server,
  Sun,
  Thermometer,
  X,
} from 'lucide-react';
import { api } from '../api/client.js';
import { AVAILABLE_THEMES } from '../context/WorkstationContext.js';
import { HostProcessEntry, HostTelemetry, ThemeId } from '../types/api.js';

interface HostMonitorModalProps {
  open: boolean;
  onClose: () => void;
  standalone?: boolean;
}

type SortKey = 'cpu' | 'mem' | 'pid' | 'name';

interface HistoryPoint {
  cpu: number;
  ram: number;
}

const MAX_HISTORY = 40;

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let idx = 0;
  let val = bytes;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 ? val.toFixed(0) : val >= 10 ? val.toFixed(1) : val.toFixed(2)} ${units[idx]}`;
}

function formatKb(kb: number): string {
  return formatBytes(kb * 1024);
}

function formatRate(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '0 B/s';
  return `${formatBytes(bytesPerSec)}/s`;
}

export function formatUptime(secs: number): string {
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${secs % 60}s`;
}

function gaugeColor(pct: number, defaultColor: string): string {
  if (pct >= 90) return 'var(--color-danger)';
  if (pct >= 75) return 'var(--color-warning)';
  return defaultColor;
}

const RadialGauge: React.FC<{
  percent: number;
  color: string;
  label: string;
  sublabel: string;
}> = ({ percent, color, label, sublabel }) => {
  const clamped = Math.max(0, Math.min(100, percent));
  const radius = 36;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffset = circumference - (clamped / 100) * circumference;
  const activeColor = gaugeColor(clamped, color);

  return (
    <div className="hm-gauge-wrap">
      <svg viewBox="0 0 92 92" className="hm-gauge-svg" aria-hidden="true">
        <circle
          cx="46"
          cy="46"
          r={radius}
          fill="none"
          stroke="var(--hm-track)"
          strokeWidth="7"
        />
        <circle
          cx="46"
          cy="46"
          r={radius}
          fill="none"
          stroke={activeColor}
          strokeWidth="7"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={strokeDashoffset}
          transform="rotate(-90 46 46)"
          style={{
            transition: 'stroke-dashoffset 320ms ease, stroke 320ms ease',
          }}
        />
      </svg>
      <div className="hm-gauge-center">
        <span className="hm-gauge-value">{clamped.toFixed(1)}%</span>
        <span className="hm-gauge-label">{label}</span>
        <span className="hm-gauge-sub">{sublabel}</span>
      </div>
    </div>
  );
};

const DualSparkline: React.FC<{ history: HistoryPoint[] }> = ({ history }) => {
  const width = 320;
  const height = 74;
  const points = history.length > 1 ? history : [{ cpu: 0, ram: 0 }, { cpu: 0, ram: 0 }];

  const buildPath = (key: 'cpu' | 'ram') =>
    points
      .map((pt, idx) => {
        const x = (idx / Math.max(1, points.length - 1)) * width;
        const y = height - (Math.max(0, Math.min(100, pt[key])) / 100) * (height - 10) - 5;
        return `${idx === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');

  const cpuPath = buildPath('cpu');
  const ramPath = buildPath('ram');
  const cpuArea = `${cpuPath} L${width},${height} L0,${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="hm-sparkline-svg" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="hmCpuGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--emerald-accent)" stopOpacity="0.32" />
          <stop offset="100%" stopColor="var(--emerald-accent)" stopOpacity="0.0" />
        </linearGradient>
      </defs>
      <line x1="0" y1={height * 0.25} x2={width} y2={height * 0.25} stroke="var(--hm-grid-line)" strokeDasharray="3 3" />
      <line x1="0" y1={height * 0.5} x2={width} y2={height * 0.5} stroke="var(--hm-grid-line)" strokeDasharray="3 3" />
      <line x1="0" y1={height * 0.75} x2={width} y2={height * 0.75} stroke="var(--hm-grid-line)" strokeDasharray="3 3" />
      <path d={cpuArea} fill="url(#hmCpuGrad)" />
      <path d={ramPath} fill="none" stroke="var(--color-purple)" strokeWidth="1.8" strokeLinejoin="round" />
      <path d={cpuPath} fill="none" stroke="var(--emerald-accent)" strokeWidth="2.2" strokeLinejoin="round" />
    </svg>
  );
};

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

const KNOWN_PORTS_KEY = 'andrui_host_ports';
const DEFAULT_HOST_PORTS = ['19801', '19811', '8080'];
const THEME_STORAGE_KEY = 'andrui_theme';

function isValidThemeId(value: string | null): value is ThemeId {
  return value != null && AVAILABLE_THEMES.some((t) => t.id === value);
}

function readActiveTheme(): ThemeId {
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (isValidThemeId(attr)) return attr;
  }
  try {
    const stored = window.localStorage?.getItem(THEME_STORAGE_KEY) ?? null;
    if (isValidThemeId(stored)) return stored;
  } catch {
    // Ignore storage errors
  }
  return 'emerald';
}

function recordWorkingPort(port: string) {
  if (!port) return;
  try {
    const raw = localStorage.getItem(KNOWN_PORTS_KEY);
    const list: string[] = raw ? JSON.parse(raw) : [];
    const next = [port, ...list.filter((p) => p !== port)].slice(0, 6);
    localStorage.setItem(KNOWN_PORTS_KEY, JSON.stringify(next));
  } catch {
    // Ignore storage errors
  }
}

function getCandidatePorts(currentPort: string): string[] {
  let saved: string[] = [];
  try {
    const raw = localStorage.getItem(KNOWN_PORTS_KEY);
    if (raw) saved = JSON.parse(raw);
  } catch {
    // Ignore storage errors
  }
  return Array.from(new Set([...saved, ...DEFAULT_HOST_PORTS])).filter((p) => p && p !== currentPort);
}

function probeHostPort(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = window.setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      resolve(false);
    }, 1500);
    img.onload = () => {
      window.clearTimeout(timer);
      resolve(true);
    };
    img.onerror = () => {
      window.clearTimeout(timer);
      resolve(false);
    };
    img.src = `http://127.0.0.1:${port}/logos/andrui-terminal-32x32.png?probe=${Date.now()}`;
  });
}

export const HostMonitorModal: React.FC<HostMonitorModalProps> = ({ open, onClose, standalone = false }) => {
  const [telemetry, setTelemetry] = useState<HostTelemetry | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [intervalMs, setIntervalMs] = useState<number>(1500);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState<SortKey>('cpu');
  const [onlyRunning, setOnlyRunning] = useState(false);
  const [expandedPid, setExpandedPid] = useState<number | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showAllCores, setShowAllCores] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [probingPorts, setProbingPorts] = useState(false);
  const [altPort, setAltPort] = useState<string | null>(null);
  const [keepAwake, setKeepAwake] = useState(true);
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const [theme, setTheme] = useState<ThemeId>(readActiveTheme);
  const [themeMenuOpen, setThemeMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const themeWrapRef = useRef<HTMLDivElement>(null);
  const probingRef = useRef(false);
  const failCountRef = useRef(0);

  useEffect(() => {
    if (!open) {
      setThemeMenuOpen(false);
      return;
    }
    const active = readActiveTheme();
    setTheme(active);
    document.documentElement.setAttribute('data-theme', active);
  }, [open]);

  const applyTheme = useCallback((next: ThemeId) => {
    setTheme(next);
    setThemeMenuOpen(false);
    document.documentElement.setAttribute('data-theme', next);
    try {
      window.localStorage?.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Ignore storage errors
    }
  }, []);

  useEffect(() => {
    if (!themeMenuOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      if (themeWrapRef.current && !themeWrapRef.current.contains(e.target as Node)) {
        setThemeMenuOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setThemeMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [themeMenuOpen]);

  const fetchSample = useCallback(async () => {
    try {
      const data = await api.getHostTelemetry();
      setTelemetry(data);
      setError(null);
      setAltPort(null);
      failCountRef.current = 0;
      if (window.location.port) {
        recordWorkingPort(window.location.port);
      }
      setHistory((prev) => {
        const next = [...prev, { cpu: data.cpu.usagePercent, ram: data.memory.usagePercent }];
        return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
      });
    } catch (err) {
      failCountRef.current += 1;
      setError(err instanceof Error ? err.message : 'Failed to load host telemetry');
      // Probe once per outage and only offer the other port; never navigate on our own.
      if (
        standalone &&
        failCountRef.current === 3 &&
        !probingRef.current &&
        window.location.hostname === '127.0.0.1'
      ) {
        probingRef.current = true;
        setProbingPorts(true);
        for (const port of getCandidatePorts(window.location.port)) {
          if (await probeHostPort(port)) {
            setAltPort(port);
            break;
          }
        }
        probingRef.current = false;
        setProbingPorts(false);
      }
    }
  }, [standalone]);

  useEffect(() => {
    if (!open || !keepAwake) {
      setWakeLockActive(false);
      return;
    }
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void }> };
    };
    if (!nav.wakeLock) return;
    let sentinel: { release: () => Promise<void>; addEventListener?: (t: string, cb: () => void) => void } | null = null;
    let disposed = false;

    const acquire = async () => {
      try {
        sentinel = await nav.wakeLock!.request('screen');
        if (disposed) {
          await sentinel.release();
          return;
        }
        setWakeLockActive(true);
        sentinel.addEventListener?.('release', () => {
          if (!disposed) setWakeLockActive(false);
        });
      } catch {
        setWakeLockActive(false);
      }
    };

    const onVisibility = () => {
      if (document.visibilityState === 'visible' && !disposed) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      disposed = true;
      document.removeEventListener('visibilitychange', onVisibility);
      setWakeLockActive(false);
      void sentinel?.release().catch(() => {});
    };
  }, [open, keepAwake]);

  useEffect(() => {
    const onBeforeInstall = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setInstallPrompt(null);
    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleInstallPwa = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    await installPrompt.userChoice;
    setInstallPrompt(null);
  };

  useEffect(() => {
    if (!open) return;
    fetchSample();
    if (paused) return;
    const timer = window.setInterval(fetchSample, intervalMs);
    return () => window.clearInterval(timer);
  }, [open, paused, intervalMs, fetchSample]);

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  useEffect(() => {
    if (!open || standalone) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement && !themeMenuOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, standalone, onClose, themeMenuOpen]);

  const toggleFullscreen = async () => {
    try {
      if (!document.fullscreenElement) {
        const target = rootRef.current ?? document.documentElement;
        await target.requestFullscreen?.();
      } else {
        await document.exitFullscreen?.();
      }
    } catch {
      // Mobile browsers may block programmatic fullscreen; CSS 100dvh overlay remains full-screen.
    }
  };

  const netTotals = useMemo(() => {
    if (!telemetry) return { rxRate: 0, txRate: 0, primary: '—' };
    let rxRate = 0;
    let txRate = 0;
    let primary = telemetry.network[0]?.interface ?? '—';
    let bestBytes = -1;
    for (const n of telemetry.network) {
      rxRate += n.rxBytesPerSec;
      txRate += n.txBytesPerSec;
      const sum = n.rxBytes + n.txBytes;
      if (sum > bestBytes) {
        bestBytes = sum;
        primary = n.interface;
      }
    }
    return { rxRate, txRate, primary };
  }, [telemetry]);

  const filteredProcesses = useMemo(() => {
    if (!telemetry) return [];
    const q = search.trim().toLowerCase();
    const list = telemetry.processes.filter((p) => {
      if (onlyRunning && p.state !== 'R') return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        p.cmdline.toLowerCase().includes(q) ||
        String(p.pid).includes(q)
      );
    });
    const sorted = [...list];
    sorted.sort((a: HostProcessEntry, b: HostProcessEntry) => {
      switch (sortBy) {
        case 'mem':
          return b.rssKb - a.rssKb || b.cpuPercent - a.cpuPercent;
        case 'pid':
          return a.pid - b.pid;
        case 'name':
          return a.name.localeCompare(b.name);
        case 'cpu':
        default:
          return b.cpuPercent - a.cpuPercent || b.rssKb - a.rssKb;
      }
    });
    return sorted;
  }, [telemetry, search, sortBy, onlyRunning]);

  if (!open) return null;

  const swapPct =
    telemetry && telemetry.memory.swapTotalKb > 0
      ? (telemetry.memory.swapUsedKb / telemetry.memory.swapTotalKb) * 100
      : 0;
  const visibleCores = showAllCores
    ? telemetry?.cpu.perCorePercent ?? []
    : (telemetry?.cpu.perCorePercent ?? []).slice(0, 16);

  return (
    <div
      ref={rootRef}
      className="hm-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Host Resource and Process Monitor"
      data-testid="host-monitor-overlay"
    >
      <div className="hm-backdrop-grid" aria-hidden="true" />

      <header className="hm-topbar">
        <div className="hm-identity">
          <div className="hm-logo-orb" aria-hidden="true">
            <Activity size={18} />
          </div>
          <div className="hm-identity-text">
            <div className="hm-title-row">
              <span className="hm-title">{telemetry?.hostname ?? 'HOST TELEMETRY'}</span>
              <span className={`hm-live-pill ${paused ? 'is-paused' : error ? 'is-offline' : ''}`}>
                <span className="hm-live-dot" />
                {paused ? 'PAUSED' : error ? 'OFFLINE' : `LIVE ${(intervalMs / 1000).toFixed(1)}s`}
              </span>
            </div>
            <div className="hm-subtitle">
              <span>{telemetry ? `${telemetry.arch} · ${telemetry.kernel}` : 'Connecting to host…'}</span>
              {telemetry && <span>UP {formatUptime(telemetry.uptimeSecs)}</span>}
            </div>
          </div>
        </div>

        <div className="hm-controls">
          <div className="hm-rate-group" role="group" aria-label="Refresh interval">
            {[1000, 1500, 3000].map((ms) => (
              <button
                key={ms}
                type="button"
                className={`hm-rate-btn ${intervalMs === ms ? 'active' : ''}`}
                onClick={() => setIntervalMs(ms)}
              >
                {ms === 1000 ? '1s' : ms === 1500 ? '1.5s' : '3s'}
              </button>
            ))}
          </div>
          <div className="hm-theme-wrap" ref={themeWrapRef}>
            <button
              type="button"
              className={`hm-icon-btn ${themeMenuOpen ? 'is-active' : ''}`}
              onClick={() => setThemeMenuOpen((v) => !v)}
              title="Change theme"
              aria-label="Change theme"
              aria-haspopup="menu"
              aria-expanded={themeMenuOpen}
            >
              <Palette size={16} />
            </button>
            {themeMenuOpen && (
              <div className="hm-theme-menu" role="menu" aria-label="Theme selection">
                {(['dark', 'light'] as const).map((variant) => (
                  <div key={variant} className="hm-theme-section">
                    <div className="hm-theme-section-title">
                      {variant === 'dark' ? 'Dark' : 'Light'}
                    </div>
                    {AVAILABLE_THEMES.filter((t) => t.variant === variant).map((opt) => {
                      const active = theme === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          role="menuitemradio"
                          aria-checked={active}
                          className={`hm-theme-option ${active ? 'is-active' : ''}`}
                          onClick={() => applyTheme(opt.id)}
                        >
                          <span
                            className="hm-theme-swatch"
                            style={{ backgroundColor: opt.bg }}
                            aria-hidden="true"
                          >
                            <i style={{ backgroundColor: opt.accent }} />
                          </span>
                          <span className="hm-theme-name">{opt.name.replace(/\s*\((Dark|Light)\)$/, '')}</span>
                          {active && <Check size={13} className="hm-theme-check" aria-hidden="true" />}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </div>
            )}
          </div>
          <button
            type="button"
            className="hm-icon-btn"
            onClick={() => setKeepAwake((k) => !k)}
            title={
              keepAwake
                ? wakeLockActive
                  ? 'Screen wake lock active (click to allow sleep)'
                  : 'Keep screen on enabled'
                : 'Allow screen sleep (click to keep screen on)'
            }
            aria-label="Toggle keep screen on"
            style={keepAwake && wakeLockActive ? { borderColor: 'var(--color-success)', color: 'var(--color-success)' } : undefined}
          >
            <Sun size={16} />
          </button>
          <button
            type="button"
            className="hm-icon-btn"
            onClick={() => setPaused((p) => !p)}
            title={paused ? 'Resume live updates' : 'Pause live updates'}
            aria-label={paused ? 'Resume live updates' : 'Pause live updates'}
          >
            {paused ? <Play size={16} /> : <Pause size={16} />}
          </button>
          {installPrompt && (
            <button
              type="button"
              className="hm-rate-btn active flex items-center gap-1"
              onClick={() => void handleInstallPwa()}
              title="Install Host Monitor as a PWA"
            >
              <Download size={14} />
              <span>Install</span>
            </button>
          )}
          <button
            type="button"
            className="hm-icon-btn"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit browser fullscreen' : 'Enter browser fullscreen'}
            aria-label={isFullscreen ? 'Exit browser fullscreen' : 'Enter browser fullscreen'}
          >
            {isFullscreen ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
          {!standalone && (
            <button
              type="button"
              className="hm-icon-btn hm-close-btn"
              onClick={() => {
                if (document.fullscreenElement) {
                  document.exitFullscreen?.().catch(() => {});
                }
                onClose();
              }}
              title="Close Host Monitor"
              aria-label="Close Host Monitor"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </header>

      <div className="hm-body">
        {error && (
          <div className="hm-error-banner" role="alert">
            <span>
              {probingPorts
                ? 'Searching for active host service on local ports…'
                : altPort
                  ? `Telemetry link degraded: ${error}. Host service found on port ${altPort}.`
                  : `Telemetry link degraded: ${error}`}
            </span>
            {altPort && (
              <button
                type="button"
                className="hm-rate-btn"
                onClick={() => window.location.replace(`http://127.0.0.1:${altPort}/?view=host`)}
              >
                Switch
              </button>
            )}
            <button type="button" className="hm-rate-btn active" onClick={fetchSample}>
              Retry
            </button>
          </div>
        )}

        {/* Primary Telemetry Cards */}
        <section className="hm-hero-grid" aria-label="Primary host metrics">
          <div className="hm-card hm-card-glow-cyan">
            <div className="hm-card-head">
              <span className="hm-card-title">
                <Cpu size={15} /> CPU COMPUTE
              </span>
              <span className="hm-card-meta">
                {telemetry ? `${telemetry.cpu.cores}C` : '—'}
                {telemetry?.cpu.frequencyMhz ? ` · ${(telemetry.cpu.frequencyMhz / 1000).toFixed(2)} GHz` : ''}
              </span>
            </div>
            <div className="hm-gauge-row">
              <RadialGauge
                percent={telemetry?.cpu.usagePercent ?? 0}
                color="var(--emerald-accent)"
                label="CPU"
                sublabel={telemetry ? `LOAD ${telemetry.cpu.loadAvg[0].toFixed(2)}` : '—'}
              />
              <div className="hm-metric-stack">
                <div className="hm-stat-line">
                  <span>1m / 5m / 15m</span>
                  <strong>
                    {telemetry
                      ? `${telemetry.cpu.loadAvg[0].toFixed(2)} · ${telemetry.cpu.loadAvg[1].toFixed(2)} · ${telemetry.cpu.loadAvg[2].toFixed(2)}`
                      : '—'}
                  </strong>
                </div>
                <div className="hm-stat-line">
                  <span>Active Tasks</span>
                  <strong>
                    {telemetry ? `${telemetry.processSummary.running} / ${telemetry.processSummary.total}` : '—'}
                  </strong>
                </div>
                <div className="hm-stat-line hm-model-line" title={telemetry?.cpu.model}>
                  <span>Chip</span>
                  <strong>{telemetry?.cpu.model ?? '—'}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="hm-card hm-card-glow-violet">
            <div className="hm-card-head">
              <span className="hm-card-title">
                <Server size={15} /> MEMORY FABRIC
              </span>
              <span className="hm-card-meta">
                {telemetry ? formatKb(telemetry.memory.totalKb) : '—'}
              </span>
            </div>
            <div className="hm-gauge-row">
              <RadialGauge
                percent={telemetry?.memory.usagePercent ?? 0}
                color="var(--color-purple)"
                label="RAM"
                sublabel={telemetry ? formatKb(telemetry.memory.usedKb) : '—'}
              />
              <div className="hm-metric-stack">
                <div className="hm-stat-line">
                  <span>Available</span>
                  <strong>{telemetry ? formatKb(telemetry.memory.availableKb) : '—'}</strong>
                </div>
                <div className="hm-stat-line">
                  <span>Cached / Buf</span>
                  <strong>
                    {telemetry
                      ? `${formatKb(telemetry.memory.cachedKb)} / ${formatKb(telemetry.memory.buffersKb)}`
                      : '—'}
                  </strong>
                </div>
                <div className="hm-swap-block">
                  <div className="hm-stat-line">
                    <span>Swap</span>
                    <strong>
                      {telemetry && telemetry.memory.swapTotalKb > 0
                        ? `${formatKb(telemetry.memory.swapUsedKb)} / ${formatKb(telemetry.memory.swapTotalKb)}`
                        : 'None'}
                    </strong>
                  </div>
                  <div className="hm-mini-bar">
                    <div className="hm-mini-bar-fill hm-fill-violet" style={{ width: `${Math.min(100, swapPct)}%` }} />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="hm-card hm-card-glow-emerald">
            <div className="hm-card-head">
              <span className="hm-card-title">
                <Network size={15} /> NETWORK I/O
              </span>
              <span className="hm-card-meta">{netTotals.primary}</span>
            </div>
            <div className="hm-net-grid">
              <div className="hm-net-box">
                <span className="hm-net-dir hm-rx">
                  <ArrowDown size={14} /> RX
                </span>
                <strong className="hm-net-rate">{formatRate(netTotals.rxRate)}</strong>
                <span className="hm-net-total">
                  Total {formatBytes(telemetry?.network.reduce((s, n) => s + n.rxBytes, 0) ?? 0)}
                </span>
              </div>
              <div className="hm-net-box">
                <span className="hm-net-dir hm-tx">
                  <ArrowUp size={14} /> TX
                </span>
                <strong className="hm-net-rate">{formatRate(netTotals.txRate)}</strong>
                <span className="hm-net-total">
                  Total {formatBytes(telemetry?.network.reduce((s, n) => s + n.txBytes, 0) ?? 0)}
                </span>
              </div>
            </div>
          </div>

          <div className="hm-card">
            <div className="hm-card-head">
              <span className="hm-card-title">
                <HardDrive size={15} /> STORAGE VOLUMES
              </span>
              <span className="hm-card-meta">{telemetry?.disks.length ?? 0} mounts</span>
            </div>
            <div className="hm-disk-list">
              {(telemetry?.disks ?? []).slice(0, 3).map((disk) => (
                <div key={disk.mountPoint} className="hm-disk-item">
                  <div className="hm-disk-row">
                    <span className="hm-disk-mount">{disk.mountPoint}</span>
                    <span className="hm-disk-nums">
                      {formatBytes(disk.usedBytes)} / {formatBytes(disk.totalBytes)} ({disk.usagePercent.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="hm-mini-bar">
                    <div
                      className="hm-mini-bar-fill"
                      style={{
                        width: `${Math.min(100, disk.usagePercent)}%`,
                        background: gaugeColor(disk.usagePercent, 'var(--color-success)'),
                      }}
                    />
                  </div>
                </div>
              ))}
              {telemetry && telemetry.disks.length === 0 && (
                <span className="hm-empty-hint">No physical mounts reported</span>
              )}
            </div>
          </div>
        </section>

        {(telemetry?.gpus.length ?? 0) > 0 && (
          <section className="hm-gpu-grid" aria-label="Host GPUs">
            {telemetry!.gpus.map((gpu) => {
              const hasVram = gpu.memoryUsedBytes != null && gpu.memoryTotalBytes != null && gpu.memoryTotalBytes > 0;
              const vramPct = hasVram ? (gpu.memoryUsedBytes! / gpu.memoryTotalBytes!) * 100 : 0;
              return (
                <div key={gpu.pciSlot} className="hm-card hm-card-glow-amber">
                  <div className="hm-card-head">
                    <span className="hm-card-title">
                      <Microchip size={15} /> GPU
                    </span>
                    <span className="hm-card-meta">
                      {gpu.driver}
                      {gpu.frequencyMhz ? ` · ${gpu.frequencyMhz.toFixed(0)} MHz` : ''}
                    </span>
                  </div>
                  <div className="hm-gauge-row">
                    <RadialGauge
                      percent={gpu.usagePercent ?? 0}
                      color="var(--color-warning)"
                      label="GPU"
                      sublabel={gpu.suspended ? 'SLEEPING' : gpu.usagePercent == null ? 'N/A' : 'BUSY'}
                    />
                    <div className="hm-metric-stack">
                      <div className="hm-stat-line hm-model-line" title={gpu.name}>
                        <span>Chip</span>
                        <strong>{gpu.name}</strong>
                      </div>
                      <div className="hm-stat-line">
                        <span>Temp</span>
                        <strong>{gpu.tempC != null ? `${gpu.tempC.toFixed(0)}°C` : '—'}</strong>
                      </div>
                      <div className="hm-swap-block">
                        <div className="hm-stat-line">
                          <span>VRAM</span>
                          <strong>
                            {hasVram
                              ? `${formatBytes(gpu.memoryUsedBytes!)} / ${formatBytes(gpu.memoryTotalBytes!)}`
                              : gpu.suspended
                                ? 'Sleeping'
                                : 'Shared'}
                          </strong>
                        </div>
                        {hasVram && (
                          <div className="hm-mini-bar">
                            <div
                              className="hm-mini-bar-fill"
                              style={{ width: `${Math.min(100, vramPct)}%`, background: gaugeColor(vramPct, 'var(--color-warning)') }}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </section>
        )}

        {/* Live Waveform + Core Matrix */}
        <section className="hm-mid-grid">
          <div className="hm-card">
            <div className="hm-card-head">
              <span className="hm-card-title">TELEMETRY WAVEFORM</span>
              <div className="hm-legend">
                <span className="hm-legend-item">
                  <i style={{ background: 'var(--emerald-accent)' }} /> CPU
                </span>
                <span className="hm-legend-item">
                  <i style={{ background: 'var(--color-purple)' }} /> RAM
                </span>
              </div>
            </div>
            <DualSparkline history={history} />
          </div>

          <div className="hm-card">
            <div className="hm-card-head">
              <span className="hm-card-title">CORE MATRIX</span>
              {(telemetry?.cpu.perCorePercent.length ?? 0) > 16 && (
                <button
                  type="button"
                  className="hm-link-btn"
                  onClick={() => setShowAllCores((v) => !v)}
                >
                  {showAllCores ? 'Show 16' : `Show all ${telemetry?.cpu.perCorePercent.length}`}
                </button>
              )}
            </div>
            <div className="hm-core-grid">
              {visibleCores.map((pct, idx) => (
                <div key={idx} className="hm-core-cell" title={`Core ${idx}: ${pct.toFixed(1)}%`}>
                  <div className="hm-core-bar-bg">
                    <div
                      className="hm-core-bar-fill"
                      style={{
                        height: `${Math.max(4, Math.min(100, pct))}%`,
                        background: gaugeColor(pct, 'var(--emerald-accent)'),
                      }}
                    />
                  </div>
                  <span className="hm-core-idx">C{idx}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Thermals & Battery Strip */}
        {((telemetry?.thermals.length ?? 0) > 0 || telemetry?.battery) && (
          <section className="hm-sensor-strip" aria-label="Thermals and power">
            {telemetry?.battery && (
              <div className="hm-sensor-pill">
                <Battery size={14} />
                <span>BAT</span>
                <strong>
                  {telemetry.battery.capacityPercent}% · {telemetry.battery.status}
                </strong>
              </div>
            )}
            {(telemetry?.thermals ?? []).map((t, i) => (
              <div key={`${t.label}-${i}`} className="hm-sensor-pill">
                <Thermometer size={14} />
                <span>{t.label}</span>
                <strong style={{ color: t.tempC >= 80 ? 'var(--color-danger)' : t.tempC >= 65 ? 'var(--color-warning)' : 'var(--color-success)' }}>
                  {t.tempC.toFixed(1)}°C
                </strong>
              </div>
            ))}
          </section>
        )}

        {/* Process Monitor */}
        <section className="hm-card hm-proc-card" aria-label="Host processes">
          <div className="hm-proc-header">
            <div className="hm-card-head" style={{ marginBottom: 0 }}>
              <span className="hm-card-title">PROCESS MATRIX</span>
              <span className="hm-card-meta">
                {telemetry
                  ? `${filteredProcesses.length} shown · ${telemetry.processSummary.total} total · ${telemetry.processSummary.threads} threads`
                  : '—'}
              </span>
            </div>

            <div className="hm-proc-toolbar">
              <label className="hm-search-box">
                <Search size={14} />
                <input
                  type="search"
                  placeholder="Filter PID, process, cmd..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  aria-label="Filter host processes"
                />
              </label>

              <div className="hm-sort-pills">
                {(['cpu', 'mem', 'pid', 'name'] as SortKey[]).map((key) => (
                  <button
                    key={key}
                    type="button"
                    className={`hm-sort-pill ${sortBy === key ? 'active' : ''}`}
                    onClick={() => setSortBy(key)}
                  >
                    {key.toUpperCase()}
                  </button>
                ))}
                <button
                  type="button"
                  className={`hm-sort-pill ${onlyRunning ? 'active' : ''}`}
                  onClick={() => setOnlyRunning((v) => !v)}
                >
                  RUN
                </button>
              </div>
            </div>
          </div>

          <div className="hm-proc-list">
            {filteredProcesses.map((proc) => {
              const isExpanded = expandedPid === proc.pid;
              return (
                <div
                  key={proc.pid}
                  className={`hm-proc-row ${isExpanded ? 'is-expanded' : ''}`}
                  onClick={() => setExpandedPid(isExpanded ? null : proc.pid)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setExpandedPid(isExpanded ? null : proc.pid);
                    }
                  }}
                >
                  <div className="hm-proc-main">
                    <div className="hm-proc-left">
                      <span
                        className={`hm-proc-state ${proc.state === 'R' ? 'is-running' : ''}`}
                        title={`State: ${proc.state}`}
                      >
                        {proc.state}
                      </span>
                      <div className="hm-proc-names">
                        <div className="hm-proc-name-line">
                          <span className="hm-proc-name">{proc.name}</span>
                          <span className="hm-proc-pid">#{proc.pid}</span>
                        </div>
                        <span className="hm-proc-cmd">{proc.cmdline}</span>
                      </div>
                    </div>

                    <div className="hm-proc-metrics">
                      <div className="hm-proc-cpu-col">
                        <span
                          className="hm-proc-cpu-val"
                          style={{ color: gaugeColor(proc.cpuPercent, 'var(--emerald-accent)') }}
                        >
                          {proc.cpuPercent.toFixed(1)}%
                        </span>
                        <div className="hm-proc-cpu-bar">
                          <div
                            style={{
                              width: `${Math.min(100, proc.cpuPercent)}%`,
                              background: gaugeColor(proc.cpuPercent, 'var(--emerald-accent)'),
                            }}
                          />
                        </div>
                      </div>
                      <span className="hm-proc-mem">{formatKb(proc.rssKb)}</span>
                    </div>
                  </div>

                  {isExpanded && (
                    <div className="hm-proc-detail">
                      <div>
                        <span>PPID</span>
                        <strong>{proc.ppid}</strong>
                      </div>
                      <div>
                        <span>UID</span>
                        <strong>{proc.uid}</strong>
                      </div>
                      <div>
                        <span>THREADS</span>
                        <strong>{proc.threads}</strong>
                      </div>
                      <div>
                        <span>RSS</span>
                        <strong>{formatKb(proc.rssKb)}</strong>
                      </div>
                      <div className="hm-proc-fullcmd">
                        <span>CMD</span>
                        <code>{proc.cmdline}</code>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
            {filteredProcesses.length === 0 && (
              <div className="hm-empty-hint" style={{ padding: '20px 0', textAlign: 'center' }}>
                No matching host processes.
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
