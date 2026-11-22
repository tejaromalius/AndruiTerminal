import { ProcessInspector } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState, useEffect } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { DashboardLayoutMode, TelemetryPoint } from '../types/api.js';
import { TabKpiGrid, TabKpiItem } from '../components/TabKpiGrid.js';
import {
  CpuChart,
  MemoryChart,
  BatteryChart,
  FpsChart,
  NetworkChart,
  InlineSparkline,
} from '../components/DiagnosticsCharts.js';
import { useDeviceStats } from '../lib/useDeviceStats.js';
import { buildTelemetry, formatRate, TelemetryDetails } from '../lib/deviceStats.js';
import {
  Activity,
  Cpu,
  Battery,
  HardDrive,
  Gauge,
  Play,
  Pause,
  Download,
  AlertCircle,
  Flame,
  Zap,
  LayoutGrid,
  Columns,
  Rows,
  RefreshCw,
  RotateCcw,
  ArrowDown,
  ArrowUp,
  Layers,
  Radio,
} from 'lucide-react';

export const DiagnosticsPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('diagnostics', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    openOperationModal,
    runOperation,
  } = useWorkstation();

  // Dashboard layout and telemetry polling state
  const [layoutMode, setLayoutMode] = useState<DashboardLayoutMode>(() => {
    return (localStorage.getItem('andrui_diag_layout') as DashboardLayoutMode) || 'grid';
  });
  const [heroMetric, setHeroMetric] = useState<'cpu' | 'memory' | 'battery' | 'fps' | 'network'>('cpu');
  const [pollIntervalMs, setPollIntervalMs] = useState<number>(2000); // 0 = paused
  const [telemetryHistory, setTelemetryHistory] = useState<TelemetryPoint[]>([]);
  const [details, setDetails] = useState<TelemetryDetails | null>(null);

  // Dumpsys State
  const [activeDumpsysService, setActiveDumpsysService] = useState('meminfo');
  const [dumpsysOutput, setDumpsysOutput] = useState<string | null>(null);
  const [dumpsysLoading, setDumpsysLoading] = useState(false);

  // Sync layout mode preference
  const handleSetLayoutMode = (mode: DashboardLayoutMode) => {
    setLayoutMode(mode);
    localStorage.setItem('andrui_diag_layout', mode);
  };
  // Grid KPI cards open their metric as the hero chart.
  const focusMetric = (metric: typeof heroMetric) => () => { setHeroMetric(metric); handleSetLayoutMode('split'); };

  // Live telemetry from GET /stats?scope=telemetry (read-only, not recorded as jobs)
  const telemetry = useDeviceStats('telemetry', selectedDeviceId, pollIntervalMs, { enabled: activeTab !== 'operations' });

  useEffect(() => {
    setTelemetryHistory([]);
    setDetails(null);
  }, [selectedDeviceId]);

  useEffect(() => {
    if (!telemetry.stats) return;
    const next = buildTelemetry(telemetry.stats, telemetry.previous);
    setTelemetryHistory((prev) => [...prev.slice(-29), next.point]);
    setDetails(next.details);
  }, [telemetry.stats, telemetry.previous]);

  const handleSampleNow = () => telemetry.refresh();

  const handleResetTelemetry = () => {
    setTelemetryHistory([]);
  };

  const dumpsysServices = [
    { id: 'meminfo', label: 'Memory (meminfo)', icon: HardDrive },
    { id: 'cpuinfo', label: 'CPU (cpuinfo)', icon: Cpu },
    { id: 'battery', label: 'Battery (battery)', icon: Battery },
    { id: 'gfxinfo', label: 'Graphics & FPS', icon: Gauge },
    { id: 'diskstats', label: 'Disk Stats', icon: HardDrive },
    { id: 'netstats', label: 'Network Stats', icon: Activity },
  ];

  const handleQueryDumpsys = async (service: string) => {
    if (!selectedDeviceId) return;
    setActiveDumpsysService(service);
    setDumpsysLoading(true);
    setDumpsysOutput(null);

    try {
      const op = findOperation('diagnostics.dumpsys');
      if (!op) throw new Error('Dumpsys is unavailable');
      const pending = await runOperation(op.id, { service });
      const job = await api.waitForJob(pending.id);
      setDumpsysOutput(
        job.exitCode === 0
          ? job.stdout || 'Command returned no output'
          : job.stderr || job.error || 'Dumpsys failed'
      );
    } catch (error) {
      setDumpsysOutput(error instanceof Error ? error.message : String(error));
    } finally {
      setDumpsysLoading(false);
    }
  };

  const latestPoint = telemetryHistory[telemetryHistory.length - 1];
  const live = Boolean(selectedDeviceId && pollIntervalMs > 0 && !telemetry.error);
  const cpuSeries = telemetryHistory.flatMap((d) => (d.cpu ? [d.cpu.total] : []));
  // Shown in place of values until the device has answered.
  const waitingText = !selectedDeviceId ? 'No device selected' : !telemetry.stats ? (telemetry.error ? 'Telemetry read failed' : 'Reading device…') : null;
  const waiting = waitingText ? '—' : null;
  const chartEmpty = waitingText ?? 'Collecting samples…';
  const detail = (
    id: string,
    label: string,
    value: string | number | null,
    subtext: string,
    icon: TabKpiItem['icon'],
    color: string,
    needsTwoSamples = false
  ): TabKpiItem => ({
    id,
    label,
    value: waiting ?? (value === null ? (needsTwoSamples && !telemetry.previous ? 'Measuring…' : 'Unavailable') : value),
    subtext: waitingText ?? subtext,
    icon,
    color,
  });

  return (
    <div className="workspace-page">
      <PageHeader
        title="Performance & System Diagnostics"
        description="Real-time hardware telemetry timelines, dumpsys metrics, Perfetto traces, and Android runtime diagnostics"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      <PageTabs page="diagnostics" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <div
            style={{
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '14px 16px',
              display: 'flex',
              flexDirection: 'column',
              gap: '14px',
            }}
          >
            <div className="flex flex-wrap items-center justify-between gap-3">
              {/* Left Title & Live Indicator */}
              <div className="flex items-center gap-2">
                <Activity size={18} className="text-emerald" />
                <h2 className="panel-title">Hardware Performance Dashboard</h2>
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: live ? 'var(--color-success)' : 'var(--text-dim)',
                    boxShadow: live ? '0 0 0 3px color-mix(in srgb, var(--color-success) 18%, transparent)' : 'none',
                    display: 'inline-block',
                  }}
                  title={!selectedDeviceId ? 'No device selected' : pollIntervalMs > 0 ? 'Live device telemetry' : 'Polling paused'}
                />
                <span className="text-xs font-mono text-dim">
                  {pollIntervalMs > 0 ? `${pollIntervalMs / 1000}s interval` : 'Paused'}
                </span>
                {telemetry.error && selectedDeviceId && (
                  <span className="badge badge-danger text-[10px] font-mono">Read failed</span>
                )}
              </div>

              {/* Right Toolbar Controls: Interval, Theme Switcher, Layout Selector */}
              <div className="flex flex-wrap items-center gap-2">
                {/* Quick Polling Rate Toggle */}
                <div className="segmented">
                  {[
                    { label: '1s', val: 1000 },
                    { label: '2s', val: 2000 },
                    { label: '5s', val: 5000 },
                  ].map((rate) => (
                    <button
                      key={rate.label}
                      type="button"
                      onClick={() => setPollIntervalMs(rate.val)}
                      className={`segmented-item ${pollIntervalMs === rate.val ? 'active' : ''}`}
                      aria-pressed={pollIntervalMs === rate.val}
                    >
                      {rate.label}
                    </button>
                  ))}
                  <button
                    type="button"
                    onClick={() => setPollIntervalMs((prev) => (prev > 0 ? 0 : 2000))}
                    className={`segmented-item ${pollIntervalMs === 0 ? 'active warning' : ''}`}
                    aria-pressed={pollIntervalMs === 0}
                    title={pollIntervalMs === 0 ? 'Resume Polling' : 'Pause Polling'}
                  >
                    {pollIntervalMs === 0 ? <Play size={13} /> : <Pause size={13} />}
                  </button>
                </div>

                {/* Snapshot & Reset Buttons */}
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleSampleNow}
                  title="Sample new telemetry data point now"
                >
                  <RefreshCw size={12} />
                  <span className="hidden sm:inline">Sample</span>
                </button>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  onClick={handleResetTelemetry}
                  title="Reset telemetry timeline series"
                >
                  <RotateCcw size={12} />
                </button>

                {/* Dashboard Layout Selector (Grid / Split / Compact) */}
                <div data-testid="dashboard-layout-selector" className="segmented">
                  <button
                    type="button"
                    data-testid="layout-grid-btn"
                    onClick={() => handleSetLayoutMode('grid')}
                    className={`segmented-item ${layoutMode === 'grid' ? 'active' : ''}`}
                    aria-pressed={layoutMode === 'grid'}
                    title="Grid Layout (2x2 Multi-card)"
                  >
                    <LayoutGrid size={13} />
                    <span className="hidden md:inline">Grid</span>
                  </button>
                  <button
                    type="button"
                    data-testid="layout-split-btn"
                    onClick={() => handleSetLayoutMode('split')}
                    className={`segmented-item ${layoutMode === 'split' ? 'active' : ''}`}
                    aria-pressed={layoutMode === 'split'}
                    title="Hero / Split View (Full width chart + secondary tabs)"
                  >
                    <Columns size={13} />
                    <span className="hidden md:inline">Split</span>
                  </button>
                  <button
                    type="button"
                    data-testid="layout-compact-btn"
                    onClick={() => handleSetLayoutMode('compact')}
                    className={`segmented-item ${layoutMode === 'compact' ? 'active' : ''}`}
                    aria-pressed={layoutMode === 'compact'}
                    title="Compact Telemetry Strip"
                  >
                    <Rows size={13} />
                    <span className="hidden md:inline">Compact</span>
                  </button>
                </div>
              </div>
            </div>

            {/* Informational State Banners */}
            {!selectedDeviceId && (
              <div className="alert alert-neutral text-xs">
                <AlertCircle size={14} />
                <span>Select a device in the top bar to stream live hardware telemetry.</span>
              </div>
            )}
            {selectedDeviceId && telemetry.error && (
              <div className="alert alert-danger text-xs">
                <AlertCircle size={14} />
                <span>Telemetry read failed: {telemetry.error}</span>
              </div>
            )}

            {/* --- LAYOUT MODE: GRID --- */}
            {layoutMode === 'grid' && (
              <div className="flex flex-col gap-3">
                <TabKpiGrid
                  items={[
                    {
                      id: 'diag-cpu-load',
                      label: 'CPU Load',
                      value: latestPoint?.cpu ? `${latestPoint.cpu.total}%` : waiting ?? 'Measuring…',
                      subtext: latestPoint?.cpu ? `User ${latestPoint.cpu.user}% · System ${latestPoint.cpu.system}%` : waitingText ?? 'Needs two samples',
                      icon: Cpu,
                      badge: latestPoint?.cpu && latestPoint.cpu.total > 75 ? 'Heavy' : undefined,
                      badgeType: 'warning',
                      color: 'var(--emerald-accent)',
                      sparkline: telemetryHistory.flatMap((d) => (d.cpu ? [d.cpu.total] : [])),
                      onClick: focusMetric('cpu'),
                      sparklineMin: 0,
                      sparklineMax: 100,
                    },
                    {
                      id: 'diag-ram-headroom',
                      label: 'RAM Available',
                      value: details?.memory?.availableMb != null ? `${(details.memory.availableMb / 1024).toFixed(1)} GB` : waiting ?? 'Unavailable',
                      subtext: latestPoint?.memory ? `Used ${(latestPoint.memory.usedMb / 1024).toFixed(1)} of ${(latestPoint.memory.totalMb / 1024).toFixed(1)} GB` : waitingText ?? '/proc/meminfo not readable',
                      icon: HardDrive,
                      color: 'var(--color-info)',
                      sparkline: telemetryHistory.flatMap((d) => (d.memory ? [d.memory.usedMb] : [])),
                      onClick: focusMetric('memory'),
                      sparklineMin: 0,
                      sparklineMax: latestPoint?.memory?.totalMb,
                    },
                    {
                      id: 'diag-battery-state',
                      label: 'Battery',
                      value: latestPoint?.battery ? `${latestPoint.battery.level}%` : waiting ?? 'Unavailable',
                      subtext: latestPoint?.battery
                        ? [latestPoint.battery.tempC !== null ? `${latestPoint.battery.tempC}°C` : null, latestPoint.battery.voltageMv !== null ? `${(latestPoint.battery.voltageMv / 1000).toFixed(2)} V` : null, latestPoint.battery.status].filter(Boolean).join(' · ')
                        : waitingText ?? 'dumpsys battery not reported',
                      icon: Battery,
                      badge: latestPoint?.battery?.tempC != null && latestPoint.battery.tempC > 40 ? 'Warm' : undefined,
                      badgeType: 'warning',
                      color: 'var(--color-warning)',
                      sparkline: telemetryHistory.flatMap((d) => (d.battery ? [d.battery.level] : [])),
                      onClick: focusMetric('battery'),
                      sparklineMin: 0,
                      sparklineMax: 100,
                    },
                    {
                      id: 'diag-frame-perf',
                      label: 'Frame Rate',
                      value: latestPoint?.fps ? `${Math.round(latestPoint.fps.fps)} fps` : waiting ?? (details?.frames ? 'Measuring…' : 'Unavailable'),
                      subtext: latestPoint?.fps
                        ? `${latestPoint.fps.packageName}${details?.refreshHz ? ` · display ${details.refreshHz} Hz` : ''}`
                        : waitingText ?? 'Focused app reports no frame stats',
                      icon: Gauge,
                      color: 'var(--color-success)',
                      sparkline: telemetryHistory.flatMap((d) => (d.fps ? [d.fps.fps] : [])),
                      onClick: focusMetric('fps'),
                      sparklineMin: 0,
                    },
                  ]}
                />
                <div data-testid="dashboard-view-grid" className="chart-grid grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  <CpuChart emptyText={chartEmpty} data={telemetryHistory} height={125} />
                  <MemoryChart emptyText={chartEmpty} data={telemetryHistory} height={125} />
                  <BatteryChart emptyText={chartEmpty} data={telemetryHistory} height={125} />
                  <FpsChart emptyText={chartEmpty} data={telemetryHistory} height={125} />
                  <NetworkChart emptyText={chartEmpty} data={telemetryHistory} height={125} />
                </div>
              </div>
            )}

            {/* --- LAYOUT MODE: SPLIT / HERO --- */}
            {layoutMode === 'split' && (
              <div data-testid="dashboard-view-split" className="flex flex-col gap-3">
                {/* Hero Metric Tabs */}
                <div className="flex items-center gap-1 border-b border-subtle pb-2 overflow-x-auto">
                  <span className="text-xs font-mono text-dim mr-2 uppercase tracking-wider">Hero Metric:</span>
                  {[
                    { id: 'cpu', label: 'CPU Utilization', icon: Cpu },
                    { id: 'memory', label: 'RAM Memory', icon: HardDrive },
                    { id: 'battery', label: 'Battery & Temp', icon: Battery },
                    { id: 'fps', label: 'Graphics & FPS', icon: Gauge },
                    { id: 'network', label: 'Network Throughput', icon: Activity },
                  ].map((tab) => {
                    const Icon = tab.icon;
                    const isSelected = heroMetric === tab.id;
                    return (
                      <button
                        key={tab.id}
                        data-testid={`hero-tab-${tab.id}`}
                        type="button"
                        onClick={() => setHeroMetric(tab.id as typeof heroMetric)}
                        className="px-3 py-1.5 text-xs font-medium rounded flex items-center gap-1.5 transition-colors"
                        style={{
                          backgroundColor: isSelected ? 'var(--emerald-surface)' : 'var(--bg-card)',
                          color: isSelected ? 'var(--emerald-accent)' : 'var(--text-dim)',
                          border: isSelected ? '1px solid var(--emerald-border)' : '1px solid var(--border-card)',
                        }}
                      >
                        <Icon size={13} />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Hero Focused Chart (Expanded Height) */}
                <div className="w-full">
                  {heroMetric === 'cpu' && <CpuChart emptyText={chartEmpty} data={telemetryHistory} height={200} />}
                  {heroMetric === 'memory' && <MemoryChart emptyText={chartEmpty} data={telemetryHistory} height={200} />}
                  {heroMetric === 'battery' && <BatteryChart emptyText={chartEmpty} data={telemetryHistory} height={200} />}
                  {heroMetric === 'fps' && <FpsChart emptyText={chartEmpty} data={telemetryHistory} height={200} />}
                  {heroMetric === 'network' && <NetworkChart emptyText={chartEmpty} data={telemetryHistory} height={200} />}
                </div>

                {/* Subsystem KPIs for Active Hero Metric */}
                {heroMetric === 'cpu' && (
                  <TabKpiGrid
                    items={[
                      detail('cpu-context-switches', 'Context Switches', details?.ctxtPerSec != null ? `${details.ctxtPerSec.toLocaleString()} /s` : null, 'From /proc/stat ctxt', Cpu, 'var(--emerald-accent)', true),
                      detail('cpu-runqueue-depth', 'Runnable Tasks', details?.procsRunning ?? null, 'procs_running in /proc/stat', Play, 'var(--color-info)'),
                      detail('cpu-cluster-split', 'Core Topology', details?.cores ? `${details.cores} cores` : null, details?.topology ?? 'Max frequency not readable', Zap, 'var(--color-success)'),
                      detail('cpu-governor', 'CPU Governor', details?.governor ?? null, 'cpu0 scaling_governor', Activity, 'var(--color-purple)'),
                    ]}
                  />
                )}

                {heroMetric === 'memory' && (
                  <TabKpiGrid
                    items={[
                      detail('mem-available', 'Available', details?.memory?.availableMb != null ? `${details.memory.availableMb} MB` : null, 'MemAvailable in /proc/meminfo', HardDrive, 'var(--emerald-accent)'),
                      detail('mem-swap', 'Swap / zRAM Used', details?.memory?.swapTotalMb ? `${details.memory.swapUsedMb} MB` : details?.memory?.swapTotalMb === 0 ? 'No swap' : null, details?.memory?.swapTotalMb ? `of ${details.memory.swapTotalMb} MB` : 'SwapTotal in /proc/meminfo', Activity, 'var(--color-info)'),
                      detail('mem-dirty-pages', 'Dirty Pages', details?.memory?.dirtyMb != null ? `${details.memory.dirtyMb} MB` : null, 'Waiting for write-back', RefreshCw, 'var(--color-warning)'),
                      detail('mem-kernel', 'Kernel Memory', details?.memory?.kernelMb != null ? `${details.memory.kernelMb} MB` : null, 'Slab + page tables + kernel stacks', Layers, 'var(--color-purple)'),
                    ]}
                  />
                )}

                {heroMetric === 'battery' && (
                  <TabKpiGrid
                    items={[
                      detail('bat-current-draw', 'Battery Current', details?.currentMa != null ? `${details.currentMa} mA` : null, 'current_now as reported by the kernel (sign varies by vendor)', Battery, 'var(--color-warning)'),
                      detail('bat-charge-counter', 'Remaining Charge', details?.battery?.chargeCounterMah != null ? `${details.battery.chargeCounterMah.toLocaleString()} mAh` : null, `Charge counter · ${details?.battery?.powerSource ?? 'power source unknown'}`, Zap, 'var(--emerald-accent)'),
                      detail('bat-health', 'Battery Health', details?.battery?.health ?? null, details?.battery?.technology ? `Technology: ${details.battery.technology}` : 'dumpsys battery', Activity, 'var(--color-success)'),
                      detail('bat-thermal-status', 'Thermal Status', details?.thermal ?? null, 'Platform thermal throttling level', Flame, 'var(--color-purple)'),
                    ]}
                  />
                )}

                {heroMetric === 'fps' && (
                  <TabKpiGrid
                    items={[
                      detail('fps-p90-latency', '90th %ile Frame Time', details?.frames?.p90Ms != null ? `${details.frames.p90Ms} ms` : null, details?.frames ? `${details.frames.packageName} (since app stats reset)` : 'Focused app reports no frame stats', Gauge, 'var(--color-success)'),
                      detail('fps-jank-rate', 'Janky Frames', details?.frames && details.frames.totalFrames > 0 ? `${((details.frames.jankyFrames / details.frames.totalFrames) * 100).toFixed(1)}%` : null, details?.frames ? `${details.frames.jankyFrames.toLocaleString()} of ${details.frames.totalFrames.toLocaleString()} frames` : 'dumpsys gfxinfo', Activity, 'var(--color-info)'),
                      detail('fps-refresh-rate', 'Display Refresh', details?.refreshHz ? `${details.refreshHz} Hz` : null, 'SurfaceFlinger vsync period', Layers, 'var(--emerald-accent)'),
                      detail('fps-focused-app', 'Measured App', details?.frames?.packageName ?? null, 'Window with input focus', RefreshCw, 'var(--color-purple)'),
                    ]}
                  />
                )}

                {heroMetric === 'network' && (
                  <TabKpiGrid
                    items={[
                      detail('net-established-conns', 'TCP Connections', details?.tcp ? details.tcp.established : null, 'ESTABLISHED in /proc/net/tcp{,6}', Activity, 'var(--emerald-accent)'),
                      detail('net-time-wait', 'TIME_WAIT Sockets', details?.tcp ? details.tcp.timeWait : null, 'Closed, awaiting kernel timeout', Radio, 'var(--color-info)'),
                      detail('net-retransmit-rate', 'TCP Retransmits', details?.retransPct != null ? `${details.retransPct}%` : null, 'Of segments sent since last sample', ArrowUp, 'var(--color-success)', true),
                      detail('net-interfaces', 'Interfaces Up', details?.interfaces ? details.interfaces.filter((i) => i.up).length : null, details?.interfaces ? details.interfaces.filter((i) => i.up).map((i) => `${i.name}${i.mtu ? ` (MTU ${i.mtu})` : ''}`).join(', ') || 'None up' : '/sys/class/net', ArrowDown, 'var(--color-purple)'),
                    ]}
                  />
                )}

                {/* Secondary Charts Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-2">
                  {heroMetric !== 'cpu' && <CpuChart emptyText={chartEmpty} data={telemetryHistory} height={90} />}
                  {heroMetric !== 'memory' && <MemoryChart emptyText={chartEmpty} data={telemetryHistory} height={90} />}
                  {heroMetric !== 'battery' && <BatteryChart emptyText={chartEmpty} data={telemetryHistory} height={90} />}
                  {heroMetric !== 'fps' && <FpsChart emptyText={chartEmpty} data={telemetryHistory} height={90} />}
                  {heroMetric !== 'network' && <NetworkChart emptyText={chartEmpty} data={telemetryHistory} height={90} />}
                </div>
              </div>
            )}

            {/* --- LAYOUT MODE: COMPACT TELEMETRY STRIP --- */}
            {layoutMode === 'compact' && (
              <div data-testid="dashboard-view-compact" className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
                {/* CPU Compact Strip */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-card)',
                    borderRadius: '6px',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-dim">
                      <Cpu size={13} className="text-emerald" />
                      <strong className="text-main font-medium">CPU</strong>
                    </span>
                    <span className={`badge ${latestPoint?.cpu ? 'badge-primary' : 'badge-neutral'} text-[10px] font-mono`}>
                      {latestPoint?.cpu ? `${latestPoint.cpu.total}%` : '--'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <InlineSparkline
                      values={telemetryHistory.flatMap((d) => (d.cpu ? [d.cpu.total] : []))}
                      color="var(--emerald-accent)"
                      fillColor="var(--emerald-surface)"
                      width={90}
                      height={22}
                      min={0}
                      max={100}
                    />
                    <span className="text-[10px] font-mono text-dim">
                      {cpuSeries.length > 0 ? `Avg ${Math.round(cpuSeries.reduce((a, b) => a + b, 0) / cpuSeries.length)}%` : '--'}
                    </span>
                  </div>
                </div>

                {/* RAM Compact Strip */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-card)',
                    borderRadius: '6px',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-dim">
                      <HardDrive size={13} className="text-info" />
                      <strong className="text-main font-medium">RAM</strong>
                    </span>
                    <span className={`badge ${latestPoint?.memory ? 'badge-info' : 'badge-neutral'} text-[10px] font-mono`}>
                      {latestPoint?.memory ? `${Math.round((latestPoint.memory.usedMb / latestPoint.memory.totalMb) * 100)}%` : '--'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <InlineSparkline
                      values={telemetryHistory.flatMap((d) => (d.memory ? [d.memory.usedMb] : []))}
                      color="var(--color-info)"
                      fillColor="color-mix(in srgb, var(--color-info) 15%, transparent)"
                      width={90}
                      height={22}
                      min={0}
                      max={latestPoint?.memory?.totalMb}
                    />
                    <span className="text-[10px] font-mono text-dim">
                      {latestPoint?.memory ? `${(latestPoint.memory.usedMb / 1024).toFixed(1)} GB` : '-- GB'}
                    </span>
                  </div>
                </div>

                {/* Battery Compact Strip */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-card)',
                    borderRadius: '6px',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-dim">
                      <Battery size={13} className="text-warning" />
                      <strong className="text-main font-medium">Battery</strong>
                    </span>
                    <span className={`badge ${latestPoint?.battery ? 'badge-warning' : 'badge-neutral'} text-[10px] font-mono`}>
                      {latestPoint?.battery ? `${latestPoint.battery.level}%` : '--'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <InlineSparkline
                      values={telemetryHistory.flatMap((d) => (d.battery ? [d.battery.level] : []))}
                      color="var(--color-warning)"
                      fillColor="color-mix(in srgb, var(--color-warning) 15%, transparent)"
                      width={90}
                      height={22}
                      min={0}
                      max={100}
                    />
                    <span className="text-[10px] font-mono text-dim flex items-center gap-1">
                      <Flame size={10} className="text-danger" />
                      {latestPoint?.battery?.tempC != null ? `${latestPoint.battery.tempC}°C` : '--°C'}
                    </span>
                  </div>
                </div>

                {/* FPS Compact Strip */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-card)',
                    borderRadius: '6px',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-dim">
                      <Gauge size={13} className="text-success" />
                      <strong className="text-main font-medium">Framerate</strong>
                    </span>
                    <span className={`badge ${latestPoint?.fps ? 'badge-online' : 'badge-neutral'} text-[10px] font-mono`}>
                      {latestPoint?.fps ? `${Math.round(latestPoint.fps.fps)} fps` : '--'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <InlineSparkline
                      values={telemetryHistory.flatMap((d) => (d.fps ? [d.fps.fps] : []))}
                      color="var(--color-success)"
                      fillColor="color-mix(in srgb, var(--color-success) 15%, transparent)"
                      width={90}
                      height={22}
                      min={0}
                    />
                    <span className="text-[10px] font-mono text-dim">
                      {latestPoint?.fps?.p90FrameMs != null ? `p90 ${latestPoint.fps.p90FrameMs} ms` : '-- ms'}
                    </span>
                  </div>
                </div>

                {/* Network Compact Strip */}
                <div
                  style={{
                    backgroundColor: 'var(--bg-card)',
                    border: '1px solid var(--border-card)',
                    borderRadius: '6px',
                    padding: '10px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '6px',
                  }}
                >
                  <div className="flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs text-dim">
                      <Activity size={13} className="text-purple" />
                      <strong className="text-main font-medium">Network</strong>
                    </span>
                    <span className="text-[10px] font-mono text-emerald flex items-center gap-0.5">
                      <ArrowDown size={10} />
                      {latestPoint?.network ? formatRate(latestPoint.network.rxKb * 1024) : '--'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between pt-1">
                    <InlineSparkline
                      values={telemetryHistory.flatMap((d) => (d.network ? [d.network.rxKb] : []))}
                      color="var(--color-purple)"
                      fillColor="color-mix(in srgb, var(--color-purple) 15%, transparent)"
                      width={90}
                      height={22}
                      min={0}
                    />
                    <span className="text-[10px] font-mono text-purple flex items-center gap-0.5">
                      <ArrowUp size={10} />
                      {latestPoint?.network ? formatRate(latestPoint.network.txKb * 1024) : '--'}
                    </span>
                  </div>
                </div>
              </div>
            )}
          </div>
          <ProcessInspector deviceId={selectedDeviceId} enabled={activeTab !== 'operations'} />
          <div className="workspace-panel">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Activity size={16} className="text-emerald" />
                <h2 className="panel-title">Dumpsys Service Inspector</h2>
              </div>
              <span className="text-xs text-dim font-mono">Real-time system state</span>
            </div>

            {/* Service buttons */}
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
              {dumpsysServices.map((s) => {
                const Icon = s.icon;
                const isSelected = activeDumpsysService === s.id;
                return (
                  <button
                    key={s.id}
                    className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => handleQueryDumpsys(s.id)}
                    disabled={dumpsysLoading || !selectedDeviceId}
                  >
                    <Icon size={13} />
                    <span>{s.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Dumpsys Output Container */}
            {dumpsysOutput && (
              <div
                className="font-mono text-xs text-emerald"
                style={{
                  backgroundColor: 'var(--terminal-bg)',
                  padding: '12px',
                  borderRadius: '6px',
                  border: '1px solid var(--border-card)',
                  maxHeight: '300px',
                  overflowY: 'auto',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {dumpsysOutput}
              </div>
            )}
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {/* Perfetto / Atrace */}
            <div
              style={{
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div>
                <div className="flex items-center gap-2">
                  <Zap size={15} className="text-info" />
                  <h2 className="panel-title">Perfetto / Atrace</h2>
                </div>
                <p className="text-xs text-dim mt-1">
                  Capture kernel sched, gfx, and app trace buffers into Perfetto PB format
                </p>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const op = findOperation('diagnostics.perfetto');
                  if (op) openOperationModal(op, { duration: 10 });
                }}
                disabled={!selectedDeviceId || !findOperation('diagnostics.perfetto')}
              >
                <Play size={12} />
                <span>Record Trace</span>
              </button>
            </div>

            {/* Heap & ART Profiles */}
            <div
              style={{
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div>
                <div className="flex items-center gap-2">
                  <HardDrive size={15} className="text-warning" />
                  <h2 className="panel-title">Heap & Bitmap Dumps</h2>
                </div>
                <p className="text-xs text-dim mt-1">
                  Dump HPROF memory snapshot, ART profiles, and graphic bitmap memory
                </p>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const op = findOperation('diagnostics.heap_dump');
                  if (op) openOperationModal(op);
                }}
                disabled={!selectedDeviceId || !findOperation('diagnostics.heap_dump')}
              >
                <Download size={12} />
                <span>Dump HPROF</span>
              </button>
            </div>

            {/* Android 17 Memory Limiter */}
            <div
              style={{
                backgroundColor: 'var(--bg-panel)',
                border: '1px solid var(--border-subtle)',
                borderRadius: '8px',
                padding: '14px',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                gap: '8px',
              }}
            >
              <div>
                <div className="flex items-center gap-2">
                  <Flame size={15} className="text-danger" />
                  <h2 className="panel-title">Android 17 Limiter</h2>
                </div>
                <p className="text-xs text-dim mt-1">
                  Test app behavior under strict page size / memory limiter constraints (D23/D24)
                </p>
              </div>
              <button
                className="btn btn-secondary btn-sm"
                onClick={() => {
                  const op = findOperation('diagnostics.memory_limiter');
                  if (op) openOperationModal(op);
                }}
                disabled={!selectedDeviceId || !findOperation('diagnostics.memory_limiter')}
              >
                <span>Configure</span>
              </button>
            </div>
          </div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Diagnostics"
            coveragePrefix="D"
            title="Diagnostics & Metric Operations"
            description="CPU/RAM monitoring, JDWP debugging tracks, bugreport exports, and dumpsys services"
          />
        </>
      }]} />
    </div>
  );
};
