import React, { useState, useEffect, useRef } from 'react';
import {
  FileText,
  Download,
  Copy,
  BookmarkPlus,
  Check,
  ArrowDown,
  Terminal,
} from 'lucide-react';

export interface LogFilterPreset {
  id: string;
  name: string;
  buffer: string;
  minLevel: string;
  tagFilter: string;
  pidFilter: string;
  searchRegex: string;
}

const DEFAULT_PRESETS: LogFilterPreset[] = [
  {
    id: 'crashes',
    name: 'Fatal Crashes',
    buffer: 'crash',
    minLevel: 'E',
    tagFilter: '',
    pidFilter: '',
    searchRegex: 'FATAL|Fatal signal|ANR',
  },
  {
    id: 'errors',
    name: 'Errors & Warnings',
    buffer: 'main',
    minLevel: 'W',
    tagFilter: '',
    pidFilter: '',
    searchRegex: '',
  },
  {
    id: 'activity-mgr',
    name: 'ActivityManager',
    buffer: 'system',
    minLevel: 'I',
    tagFilter: 'ActivityManager',
    pidFilter: '',
    searchRegex: '',
  },
  {
    id: 'all-verbose',
    name: 'All Buffers (V+)',
    buffer: 'all',
    minLevel: 'V',
    tagFilter: '',
    pidFilter: '',
    searchRegex: '',
  },
];

interface LogcatWorkbenchProps {
  logs: string;
  isRunning: boolean;
  deviceId: string | null;
  currentFilter: {
    buffer: string;
    minLevel: string;
    tagFilter: string;
    pidFilter: string;
    searchRegex: string;
  };
  onApplyFilter: (preset: {
    buffer: string;
    minLevel: string;
    tagFilter: string;
    pidFilter: string;
    searchRegex: string;
  }) => void;
}

function getLineColor(line: string): string {
  // Common logcat patterns:
  // "01-01 12:00:00.000  1234  5678 E Tag: message"
  // "E/Tag(1234): message"
  // "[ 123.456] E/Tag: message"
  if (/\b[EF]\b/.test(line.slice(0, 45)) || /\b[EF]\//.test(line.slice(0, 30)) || line.includes('FATAL EXCEPTION')) {
    return 'var(--color-danger, #f87171)';
  }
  if (/\bW\b/.test(line.slice(0, 45)) || /\bW\//.test(line.slice(0, 30))) {
    return 'var(--color-warning, #fbbf24)';
  }
  if (/\bI\b/.test(line.slice(0, 45)) || /\bI\//.test(line.slice(0, 30))) {
    return 'var(--color-success, #34d399)';
  }
  if (/\bD\b/.test(line.slice(0, 45)) || /\bD\//.test(line.slice(0, 30))) {
    return 'var(--color-info, #60a5fa)';
  }
  return 'var(--text-dim, #94a3b8)';
}

export const LogcatWorkbench: React.FC<LogcatWorkbenchProps> = ({
  logs,
  isRunning,
  deviceId,
  currentFilter,
  onApplyFilter,
}) => {
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [presets, setPresets] = useState<LogFilterPreset[]>(() => {
    try {
      const stored = localStorage.getItem('andrui:logcat_presets');
      if (stored) {
        return [...DEFAULT_PRESETS, ...JSON.parse(stored)];
      }
    } catch {
      // ignore JSON parse error
    }
    return DEFAULT_PRESETS;
  });

  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    }
  }, [logs, autoScroll]);

  const handleCopyLogs = async () => {
    if (!logs) return;
    try {
      await navigator.clipboard.writeText(logs);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback ignore
    }
  };

  const handleExportLogs = () => {
    if (!logs) return;
    const blob = new Blob([logs], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `logcat-${deviceId || 'device'}-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSaveCurrentFilter = () => {
    const name = window.prompt('Enter a name for this logcat filter preset:');
    if (!name || !name.trim()) return;

    const newPreset: LogFilterPreset = {
      id: `custom-${Date.now()}`,
      name: name.trim(),
      buffer: currentFilter.buffer,
      minLevel: currentFilter.minLevel,
      tagFilter: currentFilter.tagFilter,
      pidFilter: currentFilter.pidFilter,
      searchRegex: currentFilter.searchRegex,
    };

    const customOnly = presets.filter((p) => p.id.startsWith('custom-'));
    const updated = [...DEFAULT_PRESETS, ...customOnly, newPreset];
    setPresets(updated);
    try {
      localStorage.setItem('andrui:logcat_presets', JSON.stringify([...customOnly, newPreset]));
    } catch {
      // ignore storage error
    }
  };

  const lines = logs.split('\n');
  const lineCount = logs ? lines.length : 0;

  return (
    <div className="workspace-panel logcat-workbench" data-testid="logcat-workbench" style={{ flex: 1, minHeight: '480px' }}>
      {/* Workbench Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap pb-2 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Terminal size={16} className="text-emerald" />
          <h2 className="panel-title">Interactive Logcat Workbench</h2>
          {isRunning ? (
            <span className="badge badge-online text-xs font-mono">Live Follow</span>
          ) : lineCount > 0 ? (
            <span className="badge badge-neutral text-xs font-mono">{lineCount} lines</span>
          ) : (
            <span className="badge badge-neutral text-xs font-mono">Idle</span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs text-dim">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
            />
            <ArrowDown size={12} />
            <span>Auto-scroll</span>
          </label>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleCopyLogs}
            disabled={!logs}
            title="Copy logs to clipboard"
          >
            {copied ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <button
            type="button"
            className="btn btn-secondary btn-sm"
            onClick={handleExportLogs}
            disabled={!logs}
            title="Export logs to file"
          >
            <Download size={12} />
            <span>Export (.txt)</span>
          </button>
        </div>
      </div>

      {/* Preset Pills */}
      <div className="chip-row pt-1">
        <span className="chip-row-label">Saved Filters:</span>
        {presets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="chip-button mono"
            onClick={() => onApplyFilter(preset)}
            title={`Buffer: ${preset.buffer}, MinLevel: ${preset.minLevel}${preset.tagFilter ? `, Tag: ${preset.tagFilter}` : ''}${preset.searchRegex ? `, Regex: ${preset.searchRegex}` : ''}`}
          >
            {preset.name}
          </button>
        ))}

        <button
          type="button"
          className="chip-button active"
          onClick={handleSaveCurrentFilter}
          title="Save current buffer, level, tag, PID, and regex as preset"
        >
          <BookmarkPlus size={12} />
          <span>Save Current</span>
        </button>
      </div>

      {/* Terminal Output Container */}
      <div
        ref={scrollRef}
        style={{
          backgroundColor: '#0a0d14',
          border: '1px solid var(--border-card)',
          borderRadius: '6px',
          padding: '12px',
          height: '420px',
          flexShrink: 0,
          overflowY: 'auto',
          fontFamily: 'var(--font-mono, monospace)',
          fontSize: '11px',
          lineHeight: '1.45',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-all',
        }}
        data-testid="logcat-stream-view"
      >
        {logs ? (
          lines.map((line, idx) => {
            if (!line) return null;
            const color = getLineColor(line);
            return (
              <div key={idx} style={{ color }}>
                {line}
              </div>
            );
          })
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-dim">
            <FileText size={32} className="mb-2 opacity-40" />
            <p className="text-xs">No active log stream captured yet.</p>
            <p className="text-xs text-muted mt-0.5">
              Click &quot;Stream Live Logs&quot; or &quot;Dump Buffer (-d)&quot; above to capture real-time output.
            </p>
          </div>
        )}
      </div>
    </div>
  );
};
