import { selectPageTab } from './PageTabs.js';
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { AlertTriangle, LoaderCircle, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import type { Approval, Artifact, Job, Operation, PageId } from '../types/api.js';

const PAGE_COVERAGE: Partial<Record<PageId, string>> = {
  overview: 'C', apps: 'P', files: 'F', shell: 'E', logs: 'D', screen: 'V',
  network: 'N', diagnostics: 'D', permissions: 'P', recovery: 'X',
};

export function operationsForPage(page: PageId, operations: Operation[]): Operation[] {
  const prefix = PAGE_COVERAGE[page];
  return operations.filter(op => prefix
    ? op.coverageIds.some(id => id.startsWith(prefix))
    : (page === 'layout' || page === 'automation') && op.category.toLowerCase() === 'automation');
}

type Indicator = { count: number | null; description: string; attention: string; running: number };
type Toast = {
  id: string;
  message: string;
  tone: 'success' | 'warning' | 'danger' | 'running';
  page?: PageId;
  jobId?: string;
  openArtifactDrawer?: boolean;
  rolling?: boolean;
  onAllow?: () => Promise<void> | void;
  onReject?: () => Promise<void> | void;
};
const ActivityContext = createContext<((page: PageId) => Indicator) | null>(null);

const ToastItem: React.FC<{ toast: Toast; dismiss: (id: string) => void; open: () => void }> = ({ toast, dismiss, open }) => {
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    // Attention requests and active/rolling jobs remain visible until finished or dismissed.
    if (toast.rolling || toast.tone === 'running' || toast.tone === 'danger' || toast.tone === 'warning') return;
    const timer = setTimeout(() => dismiss(toast.id), 6000);
    return () => clearTimeout(timer);
  }, [toast, dismiss]);

  const handleAllow = async () => {
    if (busy || !toast.onAllow) return;
    setBusy(true);
    try {
      await toast.onAllow();
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (busy || !toast.onReject) return;
    setBusy(true);
    try {
      await toast.onReject();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`workstation-toast toast-${toast.tone}`} role={toast.tone === 'danger' ? 'alert' : 'status'}>
      {toast.rolling && <LoaderCircle size={14} className="animate-spin text-emerald flex-shrink-0" />}
      <span>{toast.message}</span>
      {toast.onAllow && (
        <button
          className="btn btn-ghost btn-sm text-emerald"
          disabled={busy}
          onClick={handleAllow}
          title="Allow request"
        >
          Allow
        </button>
      )}
      {toast.onReject && (
        <button
          className="btn btn-ghost btn-sm text-danger"
          disabled={busy}
          onClick={handleReject}
          title="Reject request"
        >
          Reject
        </button>
      )}
      {(toast.page || toast.jobId || toast.openArtifactDrawer) && <button className="btn btn-ghost btn-sm" onClick={open}>View</button>}
      <button className="btn btn-ghost btn-sm" aria-label="Dismiss notification" title="Close" onClick={() => dismiss(toast.id)}><X size={14} /></button>
    </div>
  );
};

export const WorkstationActivity: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { devices, devicesError, devicesLoading, operations, operationsError, operationsLoading,
    capabilities, jobs, isWsConnected, setActivePage, setSelectedJobId, setIsJobDrawerOpen,
    setIsArtifactDrawerOpen, setIsMobileNavOpen } = useWorkstation();
  const [approvals, setApprovals] = useState<Approval[] | null>(null);
  const [approvalError, setApprovalError] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const previousJobs = useRef(new Map<string, Job['status']>());
  const activeWorkingJobs = useRef(new Set<string>());
  const seenArtifacts = useRef(new Set<string>());
  const previousDevices = useRef(new Map<string, string>());
  const previousPending = useRef(new Set<string>());
  const connectionSeen = useRef(false);
  const previousConnection = useRef(false);
  const notify = useCallback((toast: Toast) => {
    setToasts(prev => [...prev.filter(item => item.id !== toast.id), toast].slice(-4));
  }, []);
  const dismiss = useCallback((id: string) => setToasts(prev => prev.filter(item => item.id !== id)), []);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const current = ++revision;
      try {
        const list = await api.getApprovals();
        if (!disposed && current === revision) { setApprovals(list); setApprovalError(false); }
      } catch {
        if (!disposed && current === revision) setApprovalError(true);
      }
    };
    const changed = (event: Event) => {
      const approval = (event as CustomEvent<Approval>).detail;
      if (approval?.id) {
        // Invalidate an older snapshot that could overwrite this live update.
        revision++;
        setApprovals(prev => [approval, ...(prev || []).filter(item => item.id !== approval.id)]);
      } else refresh();
    };
    refresh();
    const interval = setInterval(refresh, 10000);
    window.addEventListener('andrui:approval', changed);
    return () => { disposed = true; clearInterval(interval); window.removeEventListener('andrui:approval', changed); };
  }, []);

  const handleApprovalAction = useCallback(async (id: string, allow: boolean) => {
    try {
      const updated = await (allow ? api.approveApproval(id) : api.denyApproval(id));
      window.dispatchEvent(new CustomEvent('andrui:approval', { detail: updated }));
      setApprovals(prev => prev ? [updated, ...prev.filter(item => item.id !== updated.id)] : [updated]);
    } catch (e) {
      notify({ id: 'approval-action-error', message: `Could not ${allow ? 'allow' : 'reject'} request: ${e instanceof Error ? e.message : String(e)}`, tone: 'danger', page: 'ai' });
    }
  }, [notify]);

  useEffect(() => {
    const pending = approvals?.filter(item => item.status === 'pending') || [];
    const hasNew = pending.some(item => !previousPending.current.has(item.id));
    const countChanged = pending.length !== previousPending.current.size;
    if (pending.length > 0 && (hasNew || countChanged)) {
      const targetId = pending[0].id;
      notify({
        id: 'approvals',
        message: `${pending.length} agent request${pending.length === 1 ? '' : 's'} waiting for approval. Your phone is holding its breath.`,
        tone: 'warning',
        page: 'ai',
        onAllow: () => handleApprovalAction(targetId, true),
        onReject: () => handleApprovalAction(targetId, false),
      });
    }
    if (!pending.length) dismiss('approvals');
    previousPending.current = new Set(pending.map(item => item.id));
  }, [approvals, notify, dismiss, handleApprovalAction]);

  useEffect(() => {
    for (const job of jobs) {
      const previous = previousJobs.current.get(job.id);
      const isWorking = job.status === 'running' || job.status === 'queued';
      const isTerminal = ['completed', 'failed', 'cancelled'].includes(job.status);
      const label = operations.find((op) => op.id === job.operationId)?.label || job.operationId;

      if (isWorking) {
        if (!activeWorkingJobs.current.has(job.id)) {
          activeWorkingJobs.current.add(job.id);
          notify({
            id: `job-working-${job.id}`,
            message: `${label}: running${job.deviceId ? ` · ${job.deviceId}` : ''}`,
            tone: 'running',
            rolling: true,
            jobId: job.id,
          });
        }
      } else if (isTerminal) {
        const wasWorking =
          activeWorkingJobs.current.has(job.id) || previous === 'running' || previous === 'queued';
        if (wasWorking) {
          dismiss(`job-working-${job.id}`);
          activeWorkingJobs.current.delete(job.id);
          const statusText = job.status === 'completed' ? 'finished' : job.status;
          notify({
            id: `job-finished-${job.id}`,
            message: `${label}: ${statusText}${job.deviceId ? ` · ${job.deviceId}` : ''}`,
            tone: job.status === 'completed' ? 'success' : job.status === 'failed' ? 'danger' : 'warning',
            jobId: job.id,
          });
          if (job.status === 'completed' && job.artifactIds?.length) {
            for (const artifactId of job.artifactIds) {
              if (seenArtifacts.current.has(artifactId)) continue;
              seenArtifacts.current.add(artifactId);
              notify({
                id: `artifact-${artifactId}`,
                message: `Artifact added from ${label}`,
                tone: 'success',
                openArtifactDrawer: true,
              });
            }
          }
        }
      }
      previousJobs.current.set(job.id, job.status);
    }
  }, [jobs, operations, notify, dismiss]);

  useEffect(() => {
    const onArtifact = (event: Event) => {
      const artifact = (event as CustomEvent<Artifact>).detail;
      if (!artifact?.id || seenArtifacts.current.has(artifact.id)) return;
      seenArtifacts.current.add(artifact.id);
      notify({
        id: `artifact-${artifact.id}`,
        message: `Artifact added: ${artifact.name}`,
        tone: 'success',
        openArtifactDrawer: true,
      });
    };
    window.addEventListener('andrui:artifact', onArtifact);
    return () => window.removeEventListener('andrui:artifact', onArtifact);
  }, [notify]);

  useEffect(() => {
    if (devicesLoading || devicesError) return;
    const next = new Map(devices.map(device => [device.id, device.state]));
    for (const device of devices) {
      const previous = previousDevices.current.get(device.id);
      if (previous && previous !== device.state) notify({ id: `device-${device.id}`, message: `${device.model || device.id}: ${device.state}`,
        tone: device.state === 'device' ? 'success' : 'warning', page: 'overview' });
    }
    for (const id of previousDevices.current.keys()) {
      if (!next.has(id)) notify({ id: `device-${id}`, message: `${id}: disconnected`, tone: 'warning', page: 'overview' });
    }
    previousDevices.current = next;
  }, [devices, devicesLoading, devicesError, notify]);

  useEffect(() => {
    if (previousConnection.current === isWsConnected) return;
    if (isWsConnected) {
      if (connectionSeen.current) notify({ id: 'connection', message: 'Live connection restored', tone: 'success', page: 'settings' });
      connectionSeen.current = true;
    } else if (connectionSeen.current) notify({ id: 'connection', message: 'Live connection lost. Reconnecting…', tone: 'warning', page: 'settings' });
    previousConnection.current = isWsConnected;
  }, [isWsConnected, notify]);

  useEffect(() => {
    if (devicesError) notify({ id: 'devices-error', message: `Device list: ${devicesError}`, tone: 'danger', page: 'overview' });
    else dismiss('devices-error');
  }, [devicesError, notify, dismiss]);
  useEffect(() => {
    if (operationsError) notify({ id: 'operations-error', message: `Operation catalog: ${operationsError}`, tone: 'danger', page: 'settings' });
    else dismiss('operations-error');
  }, [operationsError, notify, dismiss]);
  useEffect(() => {
    if (approvalError) notify({ id: 'approval-error', message: 'Could not refresh agent approvals', tone: 'danger', page: 'ai' });
    else dismiss('approval-error');
  }, [approvalError, notify, dismiss]);

  const indicator = (page: PageId): Indicator => {
    const ops = operationsForPage(page, operations);
    const ids = new Set(ops.map(op => op.id));
    const pageJobs = jobs.filter(job => ids.has(job.operationId));
    const running = pageJobs.filter(job => job.status === 'running' || job.status === 'queued').length;
    const failed = pageJobs.filter(job => job.status === 'failed').length;
    const unavailable = ops.filter(op => !op.available).length;
    const issues = [failed ? `${failed} failed jobs in recent history` : '', unavailable ? `${unavailable} unavailable operations` : '', operationsError || ''].filter(Boolean);
    if (page === 'overview') {
      const blocked = devices.filter(device => device.state !== 'device').length;
      return { count: (devicesLoading || devicesError) && !devices.length ? null : devices.length, description: 'Connected devices', running,
        attention: [devicesError, blocked ? `${blocked} devices not ready` : '', ...issues].filter(Boolean).join('; ') };
    }
    if (page === 'ai') {
      const count = approvals?.filter(item => item.status === 'pending').length ?? null;
      return { count, description: 'Pending agent approvals', running: 0,
        attention: approvalError ? 'Approval status unavailable' : count ? `${count} requests waiting for your approval` : '' };
    }
    if (page === 'settings') {
      const unavailableCaps = capabilities?.capabilities.filter(cap => !cap.available).length || 0;
      return { count: capabilities ? capabilities.capabilities.filter(cap => cap.available).length : null,
        description: 'Available capabilities', running: 0,
        attention: [!isWsConnected ? 'Live connection unavailable' : '', unavailableCaps ? `${unavailableCaps} unavailable capabilities` : '', operationsError].filter(Boolean).join('; ') };
    }
    return { count: (operationsLoading || operationsError) && !operations.length ? null : ops.filter(op => op.available).length,
      description: 'Available operations', running, attention: issues.join('; ') };
  };

  return (
    <ActivityContext.Provider value={indicator}>
      {children}
      <div className="workstation-toasts" role="region" aria-label="Notifications">
        {toasts.map(toast => <ToastItem key={toast.id} toast={toast} dismiss={dismiss} open={() => {
          if (toast.page) { selectPageTab(toast.page, 'workspace'); setActivePage(toast.page); setIsMobileNavOpen(false); }
          if (toast.jobId) { setSelectedJobId(toast.jobId); setIsJobDrawerOpen(true); }
          if (toast.openArtifactDrawer) { setIsArtifactDrawerOpen?.(true); }
          dismiss(toast.id);
        }} />)}
      </div>
    </ActivityContext.Provider>
  );
};

export const SidebarIndicator: React.FC<{ page: PageId }> = ({ page }) => {
  const getIndicator = useContext(ActivityContext);
  if (!getIndicator) return null;
  const { count, description, attention, running } = getIndicator(page);
  return <span className="nav-indicators" id={`nav-status-${page}`} role="img"
    aria-label={`${count ?? 'Unknown'} ${description.toLowerCase()}. ${attention}${running ? `; ${running} running or queued jobs` : ''}`}>
    {running > 0 && <span className="nav-running" title={`${running} running or queued jobs`} aria-label={`${running} running or queued jobs`}><LoaderCircle size={12} />{running}</span>}
    {attention && <span className="text-warning" title={attention} aria-label={attention}><AlertTriangle size={13} /></span>}
    <span className="nav-count" title={description} aria-label={`${count ?? 'Unknown'} ${description.toLowerCase()}`}>{count ?? '—'}</span>
  </span>;
};
