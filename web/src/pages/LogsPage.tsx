import { JobAssessment } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid } from '../components/TabKpiGrid.js';
import { LogcatWorkbench } from '../components/LogcatWorkbench.js';
import { useDeviceStats, statsPendingReason } from '../lib/useDeviceStats.js';
import { firstLine, formatBytes, parseCount, parseLogBuffers, parseLogLevels } from '../lib/deviceStats.js';
import {
  FileText,
  Play,
  Pause,
  Trash2,
  Download,
  Filter,
  Search,
  AlertCircle,
  RefreshCw,
} from 'lucide-react';

export const LogsPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('logs', 'workspace');
  const {
    selectedDeviceId,
    jobs,
    findOperation,
    openOperationModal,
    runOperation,
    cancelJob,
  } = useWorkstation();

  const [buffer, setBuffer] = useState('main');
  const [minLevel, setMinLevel] = useState('I');
  const [tagFilter, setTagFilter] = useState('');
  const [pidFilter, setPidFilter] = useState('');
  const [searchRegex, setSearchRegex] = useState('');
  const [activeLogJobId, setActiveLogJobId] = useState<string | null>(null);

  const logStats = useDeviceStats('logs', selectedDeviceId, 15000, { enabled: activeTab !== 'operations' });
  const pending = statsPendingReason(selectedDeviceId, logStats);
  const sec = logStats.stats?.sections;
  const buffers = parseLogBuffers(sec?.buffers?.output ?? null);
  const mainBuffer = buffers?.find((b) => b.name === 'main') ?? buffers?.[0] ?? null;
  const crashes = parseCount(sec, 'crashes');
  const anrs = parseCount(sec, 'anrs');
  const levels = parseLogLevels(sec?.levels?.output ?? null);
  const logJob = activeLogJobId ? jobs.find((j) => j.id === activeLogJobId) ?? null : null;
  // One toggle: Stop while the capture job runs, Stream otherwise.
  const logRunning = logJob?.status === 'queued' || logJob?.status === 'running';

  const handleStartLogcat = async (continuous: boolean) => {
    if (!selectedDeviceId) return;

    const op = findOperation('logcat.dump');
    if (!op) return;
    const job = await runOperation(op.id, {
      buffer, filter: `${tagFilter || '*'}:${minLevel}`, pid: pidFilter ? Number(pidFilter) : undefined,
      regex: searchRegex || undefined, dumpOnly: !continuous,
    });
    setActiveLogJobId(job.id);
  };
  const handleClearBuffer = () => {
    const op = findOperation('logcat.clear');
    if (op) openOperationModal(op, { buffer });
  };

  const handleApplyPreset = (preset: {
    buffer: string;
    minLevel: string;
    tagFilter: string;
    pidFilter: string;
    searchRegex: string;
  }) => {
    setBuffer(preset.buffer);
    setMinLevel(preset.minLevel);
    setTagFilter(preset.tagFilter);
    setPidFilter(preset.pidFilter);
    setSearchRegex(preset.searchRegex);
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="Logs & Diagnostics Stream"
        description="Buffer filtering, non-clearing logcat, priority levels, log rotation, and bugreports"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      <PageTabs page="logs" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <TabKpiGrid
            items={[
              {
                id: 'log-capture',
                label: 'Lines Captured',
                value: !selectedDeviceId ? '—' : logJob ? logJob.stdout.split('\n').filter(Boolean).length : 0,
                subtext: !selectedDeviceId ? 'No device selected' : logJob ? `Logcat job ${logJob.status}` : 'No logcat job started on this page',
                icon: FileText,
                badge: logJob?.status === 'running' ? 'Streaming' : undefined,
                badgeType: 'online',
                color: 'var(--emerald-accent)',
              },
              {
                id: 'log-buffer-usage',
                label: 'Buffer Utilization',
                value: pending ? '—' : mainBuffer ? `${Math.round((mainBuffer.usedBytes / mainBuffer.sizeBytes) * 100)}%` : 'Unavailable',
                subtext: pending ?? (mainBuffer ? `${mainBuffer.name}: ${formatBytes(mainBuffer.usedBytes)} of ${formatBytes(mainBuffer.sizeBytes)} (logcat -g)` : firstLine(sec?.buffers)),
                icon: RefreshCw,
                color: 'var(--color-info)',
              },
              {
                id: 'log-crash-events',
                label: 'Crashes & ANRs',
                value: pending ? '—' : crashes !== null && anrs !== null ? crashes + anrs : 'Unavailable',
                subtext: pending ?? `${crashes ?? '?'} crashes · ${anrs ?? '?'} ANRs in current buffers`,
                icon: AlertCircle,
                badge: (crashes ?? 0) + (anrs ?? 0) > 0 ? 'Review' : undefined,
                badgeType: 'danger',
                color: 'var(--color-danger)',
                onClick: () => handleApplyPreset({ buffer: 'all', minLevel: 'E', tagFilter: '', pidFilter: '', searchRegex: 'FATAL EXCEPTION|ANR in' }),
              },
              {
                id: 'log-priority-split',
                label: 'Priority Split',
                value: pending ? '—' : levels ? `${(levels.E ?? 0) + (levels.F ?? 0)} errors` : 'Unavailable',
                subtext: pending ?? (levels ? `W ${levels.W ?? 0} · I ${levels.I ?? 0} · D ${levels.D ?? 0} · V ${levels.V ?? 0} (main + system)` : firstLine(sec?.levels)),
                icon: Filter,
                color: 'var(--color-purple)',
                onClick: () => setMinLevel('E'),
              },
            ]}
          />
          <div className="workspace-panel">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FileText size={16} className="text-emerald" />
                <h2 className="panel-title">Logcat Stream Config</h2>
              </div>

              <div className="flex items-center gap-2">
                {logRunning && activeLogJobId ? (
                  <button className="btn btn-secondary btn-sm" onClick={() => cancelJob(activeLogJobId)}>
                    <Pause size={12} />
                    <span>Stop Streaming</span>
                  </button>
                ) : (
                  <button
                    className="btn btn-primary btn-sm"
                    onClick={() => handleStartLogcat(true)}
                    disabled={!selectedDeviceId}
                  >
                    <Play size={12} />
                    <span>Stream Live Logs</span>
                  </button>
                )}

                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => handleStartLogcat(false)}
                  disabled={!selectedDeviceId}
                >
                  <Download size={12} />
                  <span>Dump Buffer (-d)</span>
                </button>

                <button
                  className="btn btn-danger btn-sm"
                  onClick={handleClearBuffer}
                  disabled={!selectedDeviceId}
                  title="Clear ring buffer"
                >
                  <Trash2 size={12} />
                  <span>Clear</span>
                </button>
              </div>
            </div>

            {/* Filter Controls Grid */}
            <div className="grid grid-cols-4 gap-3">
              {/* Buffer Selection */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-dim font-medium">Log Buffer (-b)</label>
                <select
                  className="select text-xs font-mono"
                  value={buffer}
                  onChange={(e) => setBuffer(e.target.value)}
                >
                  <option value="main">main (Default apps)</option>
                  <option value="system">system (System server)</option>
                  <option value="crash">crash (Fatal crashes)</option>
                  <option value="radio">radio (Telephony & RF)</option>
                  <option value="events">events (Binary events)</option>
                  <option value="all">all (All buffers)</option>
                </select>
              </div>

              {/* Priority Level */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-dim font-medium">Minimum Priority</label>
                <select
                  className="select text-xs font-mono"
                  value={minLevel}
                  onChange={(e) => setMinLevel(e.target.value)}
                >
                  <option value="V">Verbose (V+)</option>
                  <option value="D">Debug (D+)</option>
                  <option value="I">Info (I+)</option>
                  <option value="W">Warning (W+)</option>
                  <option value="E">Error (E+)</option>
                  <option value="F">Fatal (F only)</option>
                </select>
              </div>

              {/* Tag Filter */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-dim font-medium">Tag Filter</label>
                <input
                  type="text"
                  className="input text-xs font-mono"
                  placeholder="e.g. ActivityManager, MyApp"
                  value={tagFilter}
                  onChange={(e) => setTagFilter(e.target.value)}
                />
              </div>

              {/* PID Filter */}
              <div className="flex flex-col gap-1">
                <label className="text-xs text-dim font-medium">PID Filter (--pid)</label>
                <input
                  type="number"
                  className="input text-xs font-mono"
                  placeholder="e.g. 1420"
                  value={pidFilter}
                  onChange={(e) => setPidFilter(e.target.value)}
                />
              </div>
            </div>

            {/* Search / Regex */}
            <div className="flex items-center gap-2">
              <Search size={14} className="text-dim" />
              <input
                type="text"
                className="input text-xs font-mono flex-1"
                placeholder="Regex / message grep pattern (e.g. Exception|NullPointer)..."
                value={searchRegex}
                onChange={(e) => setSearchRegex(e.target.value)}
              />
            </div>
          </div>
          <LogcatWorkbench
            logs={logJob?.stdout || ''}
            isRunning={logJob?.status === 'running'}
            deviceId={selectedDeviceId}
            currentFilter={{ buffer, minLevel, tagFilter, pidFilter, searchRegex }}
            onApplyFilter={handleApplyPreset}
          />
          <JobAssessment prefixes={['diagnostics.bugreport']} />
          <div
            style={{
              backgroundColor: 'var(--bg-panel)',
              border: '1px solid var(--border-subtle)',
              borderRadius: '8px',
              padding: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}
          >
            <div>
              <h2 className="panel-title">Full System Bugreport (ZIP)</h2>
              <p className="text-xs text-dim mt-0.5">
                Generates complete adb bugreport archive with logs, dumpsys, and kernel tombstone state
              </p>
            </div>

            <button
              className="btn btn-secondary btn-sm"
              onClick={() => {
                const op = findOperation('D11') || findOperation('bugreport');
                if (op) openOperationModal(op);
              }}
              disabled={!selectedDeviceId}
            >
              <Download size={13} />
              <span>Generate Bugreport</span>
            </button>
          </div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Diagnostics"
            coveragePrefix="D"
            title="Diagnostics & Log Operations"
            description="Non-clearing logcat, bugreports, logd pruning, WebView debugging, and dumpsys"
          />
        </>
      }]} />
    </div>
  );
};
