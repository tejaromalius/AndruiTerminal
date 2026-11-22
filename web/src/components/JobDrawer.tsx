import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { ApprovalsPanel } from './ApprovalsPanel.js';
import type { Job } from '../types/api.js';
import {
  X,
  Maximize2,
  Minimize2,
  Terminal,
  Download,
  Clock,
  Copy,
  Ban,
  FileCode,
  Search,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';

type StatusFilter = 'all' | 'active' | 'failed' | 'done';

const STATUS_FILTERS: { id: StatusFilter; label: string; match: (s: Job['status']) => boolean }[] = [
  { id: 'all', label: 'All', match: () => true },
  { id: 'active', label: 'Active', match: (s) => s === 'running' || s === 'queued' },
  { id: 'failed', label: 'Failed', match: (s) => s === 'failed' || s === 'cancelled' },
  { id: 'done', label: 'Completed', match: (s) => s === 'completed' },
];

const STATUS_LABEL: Record<Job['status'], string> = {
  completed: 'Completed',
  running: 'Running',
  queued: 'Queued',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const formatDuration = (job: Job): string | null => {
  if (!job.startedAt) return null;
  const end = job.finishedAt ? Date.parse(job.finishedAt) : Date.now();
  const ms = Math.max(0, end - Date.parse(job.startedAt));
  if (ms < 1000) return `${ms} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)} s`;
  return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
};

// Terminal colour/cursor escape sequences (e.g. from `top`) are noise in a <pre>.
const stripAnsi = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b[()][A-Za-z0-9]|\x1b[=>]/g, '');

const PANEL_HEIGHT_KEY = 'andrui_job_drawer_height';
const DEFAULT_PANEL_HEIGHT = 320;
const MIN_PANEL_HEIGHT = 140;

const formatWhen = (iso: string): string => {
  const date = new Date(iso);
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  if (date.toDateString() === new Date().toDateString()) return time;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time}`;
};

export const JobDrawer: React.FC = () => {
  const {
    jobs,
    totalJobs,
    loadMoreJobs,
    isLoadingMoreJobs,
    hasMoreJobs,
    selectedJobId,
    setSelectedJobId,
    selectedJob,
    isJobDrawerOpen,
    setIsJobDrawerOpen,
    cancelJob,
    refreshJobs,
    operations,
    devices,
  } = useWorkstation();

  const [isExpanded, setIsExpanded] = useState(false);
  const [fullJob, setFullJob] = useState<Job | null>(null);
  const [shouldRender, setShouldRender] = useState(isJobDrawerOpen);
  const [isClosing, setIsClosing] = useState(false);

  useEffect(() => {
    if (isJobDrawerOpen) {
      setShouldRender(true);
      setIsClosing(false);
      return;
    }
    if (!shouldRender) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) {
      setShouldRender(false);
      setIsClosing(false);
      return;
    }
    setIsClosing(true);
    const timer = window.setTimeout(() => {
      setShouldRender(false);
      setIsClosing(false);
    }, 240);
    return () => window.clearTimeout(timer);
  }, [isJobDrawerOpen, shouldRender]);

  useEffect(() => {
    if (!selectedJobId || !isJobDrawerOpen) {
      setFullJob(null);
      return;
    }
    let cancelled = false;
    api.getJob(selectedJobId).then((j) => {
      if (!cancelled && j) {
        setFullJob(j);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [selectedJobId, isJobDrawerOpen]);

  const activeJob = (fullJob && fullJob.id === selectedJobId) ? fullJob : selectedJob;
  // Height of the docked panel in px, set by dragging its top edge; remembered per browser.
  const [panelSizing, setPanelSizing] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
      return { height: saved >= MIN_PANEL_HEIGHT ? saved : DEFAULT_PANEL_HEIGHT, customized: saved >= MIN_PANEL_HEIGHT };
    } catch {
      return { height: DEFAULT_PANEL_HEIGHT, customized: false };
    }
  });
  const [isResizing, setIsResizing] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [activeTab, setActiveTab] = useState<'stdout' | 'stderr' | 'artifacts'>('stdout');
  const [copied, setCopied] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const stdoutRef = useRef<HTMLPreElement>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const findInputRef = useRef<HTMLInputElement>(null);
  const [findQuery, setFindQuery] = useState('');
  const [findIndex, setFindIndex] = useState(0);

  const labelFor = useMemo(() => {
    const labels = new Map(operations.map((op) => [op.id, op.label]));
    return (operationId: string) => labels.get(operationId) || operationId;
  }, [operations]);

  const deviceNameFor = useMemo(() => {
    const names = new Map(devices.map((d) => [d.id, d.model?.replace(/_/g, ' ')]));
    return (deviceId?: string) => (deviceId ? names.get(deviceId) || deviceId : 'Host');
  }, [devices]);

  const statusFiltered = useMemo(() => {
    const filter = STATUS_FILTERS.find((f) => f.id === statusFilter)!;
    return jobs.filter((job) => filter.match(job.status));
  }, [jobs, statusFilter]);

  const visibleJobs = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return statusFiltered;
    return statusFiltered.filter((job) => {
      const haystack = [
        labelFor(job.operationId),
        job.operationId,
        job.deviceId,
        deviceNameFor(job.deviceId),
        job.status,
        job.id,
        job.error,
        job.stdout,
        job.stderr,
      ].join('\n').toLowerCase();
      return terms.every((t) => haystack.includes(t));
    });
  }, [statusFiltered, query, labelFor, deviceNameFor]);

  const counts = useMemo(
    () => ({
      all: Math.max(totalJobs, jobs.length),
      active: jobs.filter((j) => j.status === 'running' || j.status === 'queued').length,
      failed: jobs.filter((j) => j.status === 'failed' || j.status === 'cancelled').length,
      done: jobs.filter((j) => j.status === 'completed').length,
    }),
    [jobs, totalJobs]
  );

  // Show the newest matching job instead of an empty detail pane.
  useEffect(() => {
    if (!isJobDrawerOpen || visibleJobs.length === 0) return;
    if (!selectedJobId || !visibleJobs.some((j) => j.id === selectedJobId)) {
      setSelectedJobId(visibleJobs[0].id);
    }
  }, [isJobDrawerOpen, visibleJobs, selectedJobId, setSelectedJobId]);

  const shownJob = activeJob && visibleJobs.some((j) => j.id === activeJob.id) ? activeJob : null;

  // Open a failed job on its errors when it produced no output.
  const selectedHasOnlyErrors = !!shownJob && !shownJob.stdout && !!(shownJob.stderr || shownJob.error);
  useEffect(() => {
    setActiveTab(selectedHasOnlyErrors ? 'stderr' : 'stdout');
  }, [shownJob?.id, selectedHasOnlyErrors]);

  // Find in the visible output stream (case-insensitive, capped for very large logs).
  const outputText = !shownJob || activeTab === 'artifacts'
    ? ''
    : stripAnsi(activeTab === 'stdout' ? shownJob.stdout : shownJob.stderr || shownJob.error || '');
  const findMatches = useMemo(() => {
    const needle = findQuery.toLowerCase();
    if (!needle) return [];
    const haystack = outputText.toLowerCase();
    const found: number[] = [];
    for (let i = haystack.indexOf(needle); i !== -1 && found.length < 10000; i = haystack.indexOf(needle, i + needle.length)) {
      found.push(i);
    }
    return found;
  }, [outputText, findQuery]);

  useEffect(() => setFindIndex(0), [findQuery, shownJob?.id, activeTab]);

  useEffect(() => {
    outputRef.current?.querySelector('mark.job-find-active')?.scrollIntoView({ block: 'center' });
  }, [findIndex, findMatches]);

  const stepFind = (delta: number) => {
    if (findMatches.length === 0) return;
    setFindIndex((i) => (i + delta + findMatches.length) % findMatches.length);
  };

  const renderOutput = (text: string) => {
    if (findMatches.length === 0) return text;
    const parts: React.ReactNode[] = [];
    let last = 0;
    findMatches.forEach((start, i) => {
      parts.push(text.slice(last, start));
      parts.push(
        <mark key={start} className={i === findIndex ? 'job-find-match job-find-active' : 'job-find-match'}>
          {text.slice(start, start + findQuery.length)}
        </mark>
      );
      last = start + findQuery.length;
    });
    parts.push(text.slice(last));
    return parts;
  };

  // Auto-scroll on stdout changes
  useEffect(() => {
    if (stdoutRef.current && activeTab === 'stdout') {
      stdoutRef.current.scrollTop = stdoutRef.current.scrollHeight;
    }
  }, [shownJob?.stdout, activeTab]);

  // Connect SSE for active running job
  useEffect(() => {
    if (!shownJob || (shownJob.status !== 'running' && shownJob.status !== 'queued')) {
      return;
    }

    let eventSource: EventSource | null = null;
    try {
      eventSource = new EventSource(api.getJobEventsUrl(shownJob.id));

      eventSource.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          // If status completed or failed, refresh jobs list
          if (payload.type === 'status' || payload.type === 'exit') {
            refreshJobs();
            if (shownJob?.id) {
              api.getJob(shownJob.id).then((j) => { if (j) setFullJob(j); }).catch(() => {});
            }
          } else if (payload.type === 'stdout' && payload.data) {
            setFullJob((prev) => {
              if (!prev || prev.id !== shownJob.id) return prev;
              const text = typeof payload.data === 'string' ? payload.data : String(payload.data);
              return { ...prev, stdout: (prev.stdout || '') + text };
            });
          } else if (payload.type === 'stderr' && payload.data) {
            setFullJob((prev) => {
              if (!prev || prev.id !== shownJob.id) return prev;
              const text = typeof payload.data === 'string' ? payload.data : String(payload.data);
              return { ...prev, stderr: (prev.stderr || '') + text };
            });
          }
        } catch {
          // ignore
        }
      };

      eventSource.onerror = () => {
        eventSource?.close();
      };
    } catch (err) {
      console.warn('SSE failed, falling back to polling:', err);
    }

    return () => {
      if (eventSource) eventSource.close();
    };
  }, [shownJob?.id, shownJob?.status, refreshJobs]);

  // Handle Escape key to minimize or close drawer
  useEffect(() => {
    if (!isJobDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isExpanded) {
          setIsExpanded(false);
        } else {
          setIsJobDrawerOpen(false);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isJobDrawerOpen, isExpanded, setIsJobDrawerOpen]);

  const effectiveHeight = jobs.length === 0 && !panelSizing.customized ? 170 : panelSizing.height;

  // Let the page reserve room below its content for the docked panel.
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--job-drawer-height', `${effectiveHeight}px`);
    return () => { root.removeProperty('--job-drawer-height'); };
  }, [effectiveHeight]);

  const maxPanelHeight = () => panelRef.current?.parentElement?.clientHeight || window.innerHeight;

  const resizeTo = (height: number) => {
    const max = maxPanelHeight();
    // Dragging all the way up is the same as Expand.
    if (height >= max - 8) {
      setIsExpanded(true);
      return;
    }
    const next = Math.round(Math.max(MIN_PANEL_HEIGHT, height));
    setIsExpanded(false);
    setPanelSizing({ height: next, customized: true });
    try { localStorage.setItem(PANEL_HEIGHT_KEY, String(next)); } catch { /* storage unavailable */ }
  };

  const handleResizeStart = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const startHeight = panelRef.current!.getBoundingClientRect().height;
    const startY = e.clientY;
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    setIsResizing(true);
    const onMove = (ev: PointerEvent) => resizeTo(startHeight + startY - ev.clientY);
    const onUp = () => {
      setIsResizing(false);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  };

  if (!shouldRender) return null;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const index = visibleJobs.findIndex((j) => j.id === selectedJobId);
    const next = visibleJobs[Math.min(visibleJobs.length - 1, Math.max(0, index + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) setSelectedJobId(next.id);
  };

  const stderrText = shownJob ? shownJob.stderr || shownJob.error || '' : '';

  return (
    <div
      ref={panelRef}
      className={`job-drawer-container ${isResizing ? 'resizing' : ''} ${isClosing ? 'closing' : ''}`}
      style={{ height: isExpanded ? '100%' : `${effectiveHeight}px` }}
      onAnimationEnd={(e) => {
        if (isClosing && e.target === panelRef.current) {
          setShouldRender(false);
          setIsClosing(false);
        }
      }}
      onKeyDown={(e) => {
        // Ctrl/Cmd+F inside the panel searches the output instead of the page.
        if ((e.ctrlKey || e.metaKey) && e.key === 'f' && activeTab !== 'artifacts') {
          e.preventDefault();
          findInputRef.current?.focus();
          findInputRef.current?.select();
        }
      }}
    >
      {/* Top Bar */}
      <div
        className="job-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize jobs panel"
        title="Drag to resize · double-click to expand or restore"
        tabIndex={0}
        onPointerDown={handleResizeStart}
        onDoubleClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          const current = isExpanded ? maxPanelHeight() : effectiveHeight;
          resizeTo(current + (e.key === 'ArrowUp' ? 40 : -40));
        }}
      />
      <div className="job-toolbar">
        <div className="job-toolbar-title" onPointerDown={handleResizeStart}
          title="Drag to resize jobs panel">
          <Terminal size={14} className="text-emerald" />
          <span>Jobs</span>
          <span className="text-dim">{totalJobs > 0 ? totalJobs : jobs.length}</span>
        </div>

        {jobs.length > 0 && (
          <>
            <label className="job-search">
              <Search size={13} className="text-dim" />
              <input
                type="search"
                className="input"
                placeholder="Search jobs, devices, output…"
                aria-label="Search jobs"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div className="job-filters" role="group" aria-label="Filter by status">
              {STATUS_FILTERS.map((f) => (
                <button
                  key={f.id}
                  className={`job-filter ${statusFilter === f.id ? 'active' : ''}`}
                  aria-pressed={statusFilter === f.id}
                  onClick={() => setStatusFilter(f.id)}
                >
                  {f.label}
                  <span className="job-filter-count">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="job-toolbar-actions">
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? 'Collapse' : 'Expand'}
          >
            {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setIsJobDrawerOpen(false)}
            title="Close Drawer"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <ApprovalsPanel deviceName={deviceNameFor} />

      {jobs.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center p-4 bg-main text-center">
          <Clock size={24} className="text-dim mb-1 opacity-70" />
          <div className="text-xs font-semibold text-main">No jobs executed yet</div>
          <p className="text-xs text-dim mt-1">
            Trigger an operation from the catalog or run a shell command to stream live output and inspect artifacts here.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left: Job History List */}
          <div
            className="job-list"
            role="listbox"
            aria-label="Jobs"
            tabIndex={0}
            onKeyDown={handleListKeyDown}
            onScroll={(e) => {
              const el = e.currentTarget;
              if (
                el.scrollHeight - el.scrollTop - el.clientHeight < 60 &&
                hasMoreJobs &&
                !isLoadingMoreJobs
              ) {
                loadMoreJobs();
              }
            }}
          >
            {visibleJobs.length === 0 ? (
              <div className="job-list-empty">
                No jobs match{query ? <> “{query}”</> : ' this filter'}.
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => { setQuery(''); setStatusFilter('all'); }}
                >
                  Clear filters
                </button>
                {hasMoreJobs && (
                  <button
                    className="btn btn-secondary btn-sm mt-2"
                    disabled={isLoadingMoreJobs}
                    onClick={() => loadMoreJobs()}
                  >
                    {isLoadingMoreJobs ? 'Loading older jobs…' : `Check older jobs (${totalJobs - jobs.length} remaining)`}
                  </button>
                )}
              </div>
            ) : (
              <>
                {visibleJobs.map((job) => {
                  const duration = formatDuration(job);
                  return (
                    <div
                      key={job.id}
                      role="option"
                      aria-selected={job.id === selectedJobId}
                      className={`job-row ${job.id === selectedJobId ? 'selected' : ''}`}
                      onClick={() => setSelectedJobId(job.id)}
                    >
                      <span className={`job-status-dot status-${job.status}`} title={STATUS_LABEL[job.status]} />
                      <div className="job-row-main">
                        <div className="job-row-title">{labelFor(job.operationId)}</div>
                        <div className="job-row-meta" title={job.deviceId}>
                          {deviceNameFor(job.deviceId)} · <span className="font-mono">{job.operationId}</span>
                        </div>
                      </div>
                      <div className="job-row-side">
                        <span>{formatWhen(job.createdAt)}</span>
                        <span className={job.status === 'failed' ? 'text-danger' : ''}>
                          {job.status === 'completed' ? duration : STATUS_LABEL[job.status]}
                        </span>
                      </div>
                    </div>
                  );
                })}
                {hasMoreJobs && (
                  <div style={{ padding: '8px', borderTop: '1px solid var(--border-subtle)', textAlign: 'center' }}>
                    <button
                      className="btn btn-ghost btn-sm text-xs w-full text-dim"
                      disabled={isLoadingMoreJobs}
                      onClick={() => loadMoreJobs()}
                    >
                      {isLoadingMoreJobs
                        ? 'Loading older jobs…'
                        : `Load older jobs (${Math.max(0, totalJobs - jobs.length)} remaining)`}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Right: Selected Job Output Detail */}
          <div className="flex-1 flex flex-col overflow-hidden bg-main">
            {shownJob ? (
              <>
                <div className="job-detail-header">
                  <div className="job-detail-heading">
                    <div className="job-detail-title">
                      <span>{labelFor(shownJob.operationId)}</span>
                      <span className={`badge badge-${shownJob.status}`}>{STATUS_LABEL[shownJob.status]}</span>
                      {shownJob.exitCode !== undefined && (
                        <span className={`badge ${shownJob.exitCode === 0 ? 'badge-success' : 'badge-danger'}`}>
                          exit {shownJob.exitCode}
                        </span>
                      )}
                    </div>
                    <div className="job-detail-meta">
                      <span className="font-mono">{shownJob.operationId}</span>
                      <span title={shownJob.deviceId}>{deviceNameFor(shownJob.deviceId)}</span>
                      <span>{formatWhen(shownJob.createdAt)}</span>
                      {formatDuration(shownJob) && <span>took {formatDuration(shownJob)}</span>}
                      <span className="font-mono" title={shownJob.id}>#{shownJob.id.slice(0, 8)}</span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {(shownJob.status === 'running' || shownJob.status === 'queued') && (
                      <button className="btn btn-danger btn-sm" onClick={() => cancelJob(shownJob.id)}>
                        <Ban size={13} />
                        <span>Cancel</span>
                      </button>
                    )}
                    <div className="job-tabs" role="tablist">
                      <button role="tab" aria-selected={activeTab === 'stdout'}
                        className={activeTab === 'stdout' ? 'active' : ''} onClick={() => setActiveTab('stdout')}>
                        Output
                      </button>
                      <button role="tab" aria-selected={activeTab === 'stderr'}
                        className={`${activeTab === 'stderr' ? 'active' : ''} ${stderrText ? 'has-errors' : ''}`}
                        onClick={() => setActiveTab('stderr')}>
                        Errors{stderrText ? ' •' : ''}
                      </button>
                      <button role="tab" aria-selected={activeTab === 'artifacts'}
                        className={activeTab === 'artifacts' ? 'active' : ''} onClick={() => setActiveTab('artifacts')}>
                        Artifacts {shownJob.artifactIds?.length || 0}
                      </button>
                    </div>
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() =>
                        handleCopy(
                          activeTab === 'stdout'
                            ? shownJob.stdout
                            : activeTab === 'stderr'
                            ? stderrText
                            : JSON.stringify(shownJob, null, 2)
                        )
                      }
                      title="Copy stream"
                    >
                      <Copy size={12} />
                      <span>{copied ? 'Copied' : 'Copy'}</span>
                    </button>
                  </div>
                </div>

                {activeTab !== 'artifacts' && (
                  <div className="job-find">
                    <label className="job-find-field">
                      <Search size={12} className="text-dim" />
                      <input
                        ref={findInputRef}
                        type="text"
                        className="input"
                        placeholder={`Find in ${activeTab === 'stdout' ? 'output' : 'errors'}…  (Ctrl+F)`}
                        aria-label="Find in output"
                        value={findQuery}
                        onChange={(e) => setFindQuery(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); stepFind(e.shiftKey ? -1 : 1); }
                          if (e.key === 'Escape' && findQuery) {
                            // Clear the search first; a second Escape closes the panel.
                            e.nativeEvent.stopPropagation();
                            setFindQuery('');
                          }
                        }}
                      />
                    </label>
                    {findQuery && (
                      <span className="job-find-count" aria-live="polite">
                        {findMatches.length === 0
                          ? 'No matches'
                          : `${findIndex + 1} of ${findMatches.length}${findMatches.length === 10000 ? '+' : ''}`}
                      </span>
                    )}
                    <button className="btn btn-ghost btn-sm" title="Previous match (Shift+Enter)" aria-label="Previous match"
                      disabled={findMatches.length === 0} onClick={() => stepFind(-1)}>
                      <ChevronUp size={14} />
                    </button>
                    <button className="btn btn-ghost btn-sm" title="Next match (Enter)" aria-label="Next match"
                      disabled={findMatches.length === 0} onClick={() => stepFind(1)}>
                      <ChevronDown size={14} />
                    </button>
                  </div>
                )}

                <div ref={outputRef} className="flex-1 overflow-auto" style={{ padding: '12px 14px' }}>
                  {activeTab === 'stdout' && (
                    <pre ref={stdoutRef} className="job-output">
                      {(outputText && renderOutput(outputText)) || (
                        <span className="text-dim italic">
                          {shownJob.status === 'running' ? 'Streaming output…' : 'No output'}
                        </span>
                      )}
                    </pre>
                  )}

                  {activeTab === 'stderr' && (
                    <pre className="job-output text-danger">
                      {(outputText && renderOutput(outputText)) || <span className="text-dim italic">No errors</span>}
                    </pre>
                  )}

                  {activeTab === 'artifacts' && (
                    <div>
                      {shownJob.artifactIds?.length === 0 ? (
                        <div className="empty-state" style={{ padding: '30px' }}>
                          <FileCode size={30} className="text-dim" />
                          <div className="text-xs text-dim">No artifacts generated for this job</div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {shownJob.artifactIds.map((artId) => (
                            <div key={artId} className="job-artifact">
                              <div className="flex items-center gap-2">
                                <FileCode size={16} className="text-emerald" />
                                <span className="font-mono text-xs font-semibold text-main">Artifact: {artId}</span>
                              </div>
                              <a href={api.getArtifactDownloadUrl(artId)} download className="btn btn-secondary btn-sm">
                                <Download size={13} />
                                <span>Download</span>
                              </a>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="empty-state h-full">
                <Terminal size={36} className="text-dim" />
                <div className="text-sm text-dim">No job selected</div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
