import React from 'react';
import { TelemetryPoint } from '../types/api.js';
import {
  Cpu,
  HardDrive,
  Battery,
  Gauge,
  Activity,
  ArrowDown,
  ArrowUp,
  Flame,
} from 'lucide-react';

interface ChartBaseProps {
  data: TelemetryPoint[];
  height?: number;
  className?: string;
  /** Shown over the chart while it has no samples. */
  emptyText?: string;
}

type WithMetric<K extends keyof TelemetryPoint> = TelemetryPoint & { [P in K]: NonNullable<TelemetryPoint[P]> };
const withMetric = <K extends keyof TelemetryPoint>(samples: TelemetryPoint[], key: K) =>
  samples.filter((d): d is WithMetric<K> => d[key] !== null);

const EmptyOverlay: React.FC<{ text: string }> = ({ text }) => (
  <div
    style={{
      position: 'absolute',
      inset: 0,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '8px',
      textAlign: 'center',
      backgroundColor: 'color-mix(in srgb, var(--bg-panel) 85%, transparent)',
      borderRadius: '6px',
      border: '1px dashed var(--border-card)',
      zIndex: 2,
    }}
  >
    <span className="text-xs font-mono text-dim">{text}</span>
  </div>
);

export function buildSvgPathData(
  values: number[],
  min: number,
  max: number,
  width = 300,
  height = 100,
  padding = 6
) {
  if (values.length === 0) {
    return { polyline: '', polygon: '', lastY: height / 2, points: [] };
  }

  const range = max - min || 1;
  const effectiveHeight = height - padding * 2;
  const stepX = values.length > 1 ? (width - padding * 2) / (values.length - 1) : 0;

  const points = values.map((val, idx) => {
    const clamped = Math.max(min, Math.min(max, val));
    const normalized = (clamped - min) / range;
    const x = padding + idx * stepX;
    const y = height - padding - normalized * effectiveHeight;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  });

  const polyline = points.map((p) => `${p.x},${p.y}`).join(' ');
  const baselineY = height - padding;
  const firstX = points[0].x;
  const lastX = points[points.length - 1].x;
  const polygon = `${firstX},${baselineY} ${polyline} ${lastX},${baselineY}`;

  return {
    polyline,
    polygon,
    lastY: points[points.length - 1].y,
    points,
  };
}

/**
 * Lightweight inline sparkline for compact layout mode
 */
export const InlineSparkline: React.FC<{
  values: number[];
  color?: string;
  fillColor?: string;
  width?: number;
  height?: number;
  min?: number;
  max?: number;
}> = ({
  values,
  color = 'var(--emerald-accent)',
  fillColor = 'var(--emerald-surface)',
  width = 80,
  height = 24,
  min,
  max,
}) => {
  const computedMin = min !== undefined ? min : Math.min(...values, 0);
  const computedMax = max !== undefined ? max : Math.max(...values, 100);
  const { polyline, polygon } = buildSvgPathData(values, computedMin, computedMax, width, height, 2);

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      style={{ overflow: 'visible', display: 'inline-block' }}
    >
      <polygon points={polygon} fill={fillColor} />
      <polyline
        points={polyline}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
};

/**
 * CPU Utilization History Chart
 */
export const CpuChart: React.FC<ChartBaseProps> = ({ data: samples, height = 120, emptyText = 'No samples yet' }) => {
  const data = withMetric(samples, 'cpu');
  const currentPoint = data[data.length - 1];
  const cpuValues = data.map((d) => d.cpu.total);
  const currentTotal = currentPoint ? Math.round(currentPoint.cpu.total) : 0;
  const currentUsr = currentPoint ? Math.round(currentPoint.cpu.user) : 0;
  const currentSys = currentPoint ? Math.round(currentPoint.cpu.system) : 0;
  const avg = cpuValues.length ? Math.round(cpuValues.reduce((a, b) => a + b, 0) / cpuValues.length) : 0;
  const peak = cpuValues.length ? Math.round(Math.max(...cpuValues)) : 0;

  const svgData = buildSvgPathData(cpuValues, 0, 100, 400, height, 8);

  return (
    <div
      data-testid="chart-cpu"
      style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu size={16} className="text-emerald" />
          <span className="text-sm font-semibold text-main">CPU Utilization</span>
          {currentPoint ? (
            <span className="badge badge-primary text-xs font-mono">{currentTotal}%</span>
          ) : (
            <span className="badge badge-neutral text-xs font-mono">Offline</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs font-mono text-dim">
          <span>Avg: <strong className="text-main">{data.length ? `${avg}%` : '--'}</strong></span>
          <span>Peak: <strong className="text-main">{data.length ? `${peak}%` : '--'}</strong></span>
        </div>
      </div>

      <div style={{ position: 'relative', width: '100%', height }}>
        {data.length === 0 && <EmptyOverlay text={samples.length > 1 ? 'Not reported by this device' : emptyText} />}
        <svg
          viewBox={`0 0 400 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', display: 'block' }}
        >
          <defs>
            <linearGradient id="cpuGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--emerald-accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--emerald-accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Grid reference lines */}
          <line x1="8" y1={height * 0.25} x2="392" y2={height * 0.25} stroke="var(--border-subtle)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <line x1="8" y1={height * 0.50} x2="392" y2={height * 0.50} stroke="var(--border-subtle)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <line x1="8" y1={height * 0.75} x2="392" y2={height * 0.75} stroke="var(--border-subtle)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />

          {/* Shaded Area */}
          <polygon points={svgData.polygon} fill="url(#cpuGradient)" />

          {/* Stroke Line */}
          <polyline
            points={svgData.polyline}
            fill="none"
            stroke="var(--emerald-accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <div className="flex items-center justify-between text-xs font-mono text-dim border-t border-subtle pt-2">
        <div className="flex items-center gap-3">
          <span>User: <span className="text-main font-semibold">{data.length ? `${currentUsr}%` : '--'}</span></span>
          <span>System: <span className="text-main font-semibold">{data.length ? `${currentSys}%` : '--'}</span></span>
        </div>
        <span className="text-[11px] text-muted">Range: 0-100%</span>
      </div>
    </div>
  );
};

/**
 * RAM Memory Breakdown & Allocation Chart
 */
export const MemoryChart: React.FC<ChartBaseProps> = ({ data: samples, height = 120, emptyText = 'No samples yet' }) => {
  const data = withMetric(samples, 'memory');
  const current = data[data.length - 1];
  const usedMb = current ? current.memory.usedMb : 0;
  const cachedMb = current ? current.memory.cachedMb : 0;
  const freeMb = current ? current.memory.freeMb : 0;
  const totalMb = current ? current.memory.totalMb : 0;

  const usedPct = Math.round((usedMb / (totalMb || 1)) * 100);
  const cachedPct = Math.round((cachedMb / (totalMb || 1)) * 100);
  const freePct = Math.max(0, 100 - usedPct - cachedPct);

  const usedSeries = data.map((d) => d.memory.usedMb);
  const svgData = buildSvgPathData(usedSeries, 0, totalMb, 400, height, 8);

  return (
    <div
      data-testid="chart-memory"
      style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <HardDrive size={16} className="text-info" />
          <span className="text-sm font-semibold text-main">RAM Memory Usage</span>
          {current ? (
            <span className="badge badge-info text-xs font-mono">{usedPct}% Used</span>
          ) : (
            <span className="badge badge-neutral text-xs font-mono">Offline</span>
          )}
        </div>
        <div className="text-xs font-mono text-dim">
          {current ? (
            <>
              <strong className="text-main">{(usedMb / 1024).toFixed(1)} GB</strong> / {(totalMb / 1024).toFixed(1)} GB
            </>
          ) : (
            '-- / --'
          )}
        </div>
      </div>

      <div style={{ position: 'relative', width: '100%', height }}>
        {data.length === 0 && <EmptyOverlay text={samples.length > 1 ? 'Not reported by this device' : emptyText} />}
        <svg
          viewBox={`0 0 400 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', display: 'block' }}
        >
          <defs>
            <linearGradient id="memGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-info)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--color-info)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          <line x1="8" y1={height * 0.50} x2="392" y2={height * 0.50} stroke="var(--border-subtle)" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />
          <polygon points={svgData.polygon} fill="url(#memGradient)" />
          <polyline
            points={svgData.polyline}
            fill="none"
            stroke="var(--color-info)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      {/* Stacked bar ratio */}
      <div
        style={{
          height: '8px',
          width: '100%',
          backgroundColor: 'var(--bg-card)',
          borderRadius: '4px',
          overflow: 'hidden',
          display: 'flex',
        }}
      >
        <div style={{ width: `${current ? usedPct : 0}%`, backgroundColor: 'var(--emerald-accent)', transition: 'width 0.3s ease' }} title={`Used: ${usedPct}%`} />
        <div style={{ width: `${current ? cachedPct : 0}%`, backgroundColor: 'var(--color-info)', transition: 'width 0.3s ease' }} title={`Cached: ${cachedPct}%`} />
        <div style={{ width: `${current ? freePct : 100}%`, backgroundColor: 'var(--bg-card-hover)' }} title={`Free: ${freePct}%`} />
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs font-mono text-dim border-t border-subtle pt-2 text-center">
        <div>Used: <span className="text-main font-semibold">{usedMb} MB</span></div>
        <div>Cached: <span className="text-info font-semibold">{cachedMb} MB</span></div>
        <div>Free: <span className="text-main font-semibold">{freeMb} MB</span></div>
      </div>
    </div>
  );
};

/**
 * Battery & Thermals Telemetry Chart
 */
export const BatteryChart: React.FC<ChartBaseProps> = ({ data: samples, height = 120, emptyText = 'No samples yet' }) => {
  const data = withMetric(samples, 'battery');
  const current = data[data.length - 1];
  const level = current?.battery.level ?? null;
  const temp = current?.battery.tempC ?? null;
  const voltage = current?.battery.voltageMv ?? null;
  const status = current?.battery.status ?? null;

  const levelSeries = data.map((d) => d.battery.level);
  const tempSeries = data.map((d) => d.battery.tempC).filter((t): t is number => t !== null);

  const levelSvg = buildSvgPathData(levelSeries, 0, 100, 400, height, 8);
  const tempSvg = buildSvgPathData(tempSeries, 20, 50, 400, height, 8);

  return (
    <div
      data-testid="chart-battery"
      style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Battery size={16} className="text-warning" />
          <span className="text-sm font-semibold text-main">Battery & Thermals</span>
          {current ? (
            <span className="badge badge-warning text-xs font-mono">{level}%</span>
          ) : (
            <span className="badge badge-neutral text-xs font-mono">Offline</span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          {current ? (
            <>
              <span className="badge badge-outline text-[11px]">{status}</span>
              <span className="text-dim flex items-center gap-1">
                <Flame size={12} className="text-danger" />
                <strong className="text-main">{temp === null ? '--' : `${temp}°C`}</strong>
              </span>
            </>
          ) : (
            <span className="text-dim">-- / --</span>
          )}
        </div>
      </div>

      <div style={{ position: 'relative', width: '100%', height }}>
        {data.length === 0 && <EmptyOverlay text={samples.length > 1 ? 'Not reported by this device' : emptyText} />}
        <svg
          viewBox={`0 0 400 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', display: 'block' }}
        >
          <defs>
            <linearGradient id="batGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-warning)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-warning)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          <polygon points={levelSvg.polygon} fill="url(#batGradient)" />
          {/* Battery level line */}
          <polyline
            points={levelSvg.polyline}
            fill="none"
            stroke="var(--color-warning)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Temperature trend line */}
          <polyline
            points={tempSvg.polyline}
            fill="none"
            stroke="var(--color-danger)"
            strokeWidth="1.5"
            strokeDasharray="4 2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <div className="flex items-center justify-between text-xs font-mono text-dim border-t border-subtle pt-2">
        <div className="flex items-center gap-3">
          <span>Voltage: <span className="text-main font-semibold">{voltage === null ? '--' : `${(voltage / 1000).toFixed(2)}V`}</span></span>
          <span className="flex items-center gap-1">
            <span style={{ width: 8, height: 2, backgroundColor: 'var(--color-warning)' }} /> Charge
            <span style={{ width: 8, height: 2, backgroundColor: 'var(--color-danger)', marginLeft: 6 }} /> Temp
          </span>
        </div>
        <span>Battery temp: <strong className={temp !== null && temp > 40 ? 'text-danger' : 'text-main'}>{temp === null ? '--' : temp > 40 ? 'Warm' : 'Normal'}</strong></span>
      </div>
    </div>
  );
};

/**
 * Graphics, FPS Stability & Render Latency Chart
 */
export const FpsChart: React.FC<ChartBaseProps> = ({ data: samples, height = 120, emptyText = 'No samples yet' }) => {
  const data = withMetric(samples, 'fps');
  const current = data[data.length - 1];
  const fps = current ? Math.round(current.fps.fps) : null;
  const p90 = current?.fps.p90FrameMs ?? null;
  const janks = data.reduce((acc, d) => acc + d.fps.jankCount, 0);

  const fpsSeries = data.map((d) => d.fps.fps);
  const maxFps = Math.max(120, ...fpsSeries);
  const svgData = buildSvgPathData(fpsSeries, 0, maxFps, 400, height, 8);

  const line60Y = height - 8 - (60 / maxFps) * (height - 16);
  const line120Y = height - 8 - (120 / maxFps) * (height - 16);

  return (
    <div
      data-testid="chart-fps"
      style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Gauge size={16} className="text-success" />
          <span className="text-sm font-semibold text-main">Graphics & Frame Rate</span>
          {current ? (
            <span className="badge badge-online text-xs font-mono">{fps} FPS</span>
          ) : (
            <span className="badge badge-neutral text-xs font-mono">Offline</span>
          )}
        </div>
        <div className="text-xs font-mono text-dim">
          p90 frame: <strong className="text-main">{p90 === null ? '--' : `${p90} ms`}</strong>
        </div>
      </div>

      <div style={{ position: 'relative', width: '100%', height }}>
        {data.length === 0 && <EmptyOverlay text={samples.length > 1 ? 'Not reported by this device' : emptyText} />}
        <svg
          viewBox={`0 0 400 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', display: 'block' }}
        >
          <defs>
            <linearGradient id="fpsGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-success)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-success)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Reference thresholds */}
          <line
            x1="8"
            y1={line60Y}
            x2="392"
            y2={line60Y}
            stroke="var(--border-focus)"
            strokeDasharray="4 4"
            opacity="0.5"
            vectorEffect="non-scaling-stroke"
          />
          <line
            x1="8"
            y1={line120Y}
            x2="392"
            y2={line120Y}
            stroke="var(--color-info)"
            strokeDasharray="4 4"
            opacity="0.35"
            vectorEffect="non-scaling-stroke"
          />

          <polygon points={svgData.polygon} fill="url(#fpsGradient)" />
          <polyline
            points={svgData.polyline}
            fill="none"
            stroke="var(--color-success)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Crisp HTML threshold indicator labels (non-distorted) */}
        <div
          style={{
            position: 'absolute',
            top: `${(line60Y / height) * 100}%`,
            right: 8,
            transform: 'translateY(-100%)',
            pointerEvents: 'none',
          }}
          className="text-[10px] font-mono text-dim tracking-tight select-none opacity-80"
        >
          60 fps
        </div>
        <div
          style={{
            position: 'absolute',
            top: `${(line120Y / height) * 100}%`,
            right: 8,
            transform: 'translateY(-100%)',
            pointerEvents: 'none',
          }}
          className="text-[10px] font-mono text-dim tracking-tight select-none opacity-70"
        >
          120 fps
        </div>
      </div>

      <div className="flex items-center justify-between text-xs font-mono text-dim border-t border-subtle pt-2">
        <div className="flex items-center gap-2">
          <span>Jank count: <strong className={janks > 0 ? 'text-warning' : 'text-success'}>{janks}</strong></span>
        </div>
        <span className="text-[11px] text-muted truncate" style={{ maxWidth: '60%' }}>{current ? current.fps.packageName : 'Focused app'}</span>
      </div>
    </div>
  );
};

/**
 * Network I/O Throughput Chart (Rx / Tx KB/s)
 */
export const NetworkChart: React.FC<ChartBaseProps> = ({ data: samples, height = 120, emptyText = 'No samples yet' }) => {
  const data = withMetric(samples, 'network');
  const current = data[data.length - 1];
  const rxKb = current ? Math.round(current.network.rxKb) : 0;
  const txKb = current ? Math.round(current.network.txKb) : 0;

  const rxSeries = data.map((d) => d.network.rxKb);
  const txSeries = data.map((d) => d.network.txKb);

  const maxNetwork = Math.max(100, ...rxSeries, ...txSeries);
  const rxSvg = buildSvgPathData(rxSeries, 0, maxNetwork, 400, height, 8);
  const txSvg = buildSvgPathData(txSeries, 0, maxNetwork, 400, height, 8);

  return (
    <div
      data-testid="chart-network"
      style={{
        backgroundColor: 'var(--bg-panel)',
        border: '1px solid var(--border-subtle)',
        borderRadius: '8px',
        padding: '14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity size={16} className="text-purple" />
          <span className="text-sm font-semibold text-main whitespace-nowrap">Network Throughput</span>
        </div>
        <div className="flex items-center gap-3 text-xs font-mono whitespace-nowrap">
          <span className="flex items-center gap-1 text-emerald">
            <ArrowDown size={12} />
            <span>{data.length ? `${rxKb} KB/s` : '--'}</span>
          </span>
          <span className="flex items-center gap-1 text-purple">
            <ArrowUp size={12} />
            <span>{data.length ? `${txKb} KB/s` : '--'}</span>
          </span>
        </div>
      </div>

      <div style={{ position: 'relative', width: '100%', height }}>
        {data.length === 0 && <EmptyOverlay text={samples.length > 1 ? 'Not reported by this device' : emptyText} />}
        <svg
          viewBox={`0 0 400 ${height}`}
          preserveAspectRatio="none"
          style={{ width: '100%', height: '100%', display: 'block' }}
        >
          <defs>
            <linearGradient id="rxGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--emerald-accent)" stopOpacity="0.30" />
              <stop offset="100%" stopColor="var(--emerald-accent)" stopOpacity="0.02" />
            </linearGradient>
            <linearGradient id="txGradient" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-purple)" stopOpacity="0.25" />
              <stop offset="100%" stopColor="var(--color-purple)" stopOpacity="0.02" />
            </linearGradient>
          </defs>

          {/* Rx Area */}
          <polygon points={rxSvg.polygon} fill="url(#rxGradient)" />
          <polyline
            points={rxSvg.polyline}
            fill="none"
            stroke="var(--emerald-accent)"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Tx Polyline */}
          <polyline
            points={txSvg.polyline}
            fill="none"
            stroke="var(--color-purple)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>

      <div className="flex items-center justify-between text-xs font-mono text-dim border-t border-subtle pt-2">
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span style={{ width: 8, height: 2, backgroundColor: 'var(--emerald-accent)' }} /> Rx (Down)
          </span>
          <span className="flex items-center gap-1">
            <span style={{ width: 8, height: 2, backgroundColor: 'var(--color-purple)' }} /> Tx (Up)
          </span>
        </div>
        <span>Max: <strong className="text-main">{Math.round(maxNetwork)} KB/s</strong></span>
      </div>
    </div>
  );
};
