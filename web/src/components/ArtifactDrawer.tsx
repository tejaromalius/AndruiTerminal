import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Download, Maximize2, Minimize2, RefreshCw, Trash2, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import type { Artifact } from '../types/api.js';

const PANEL_HEIGHT_KEY = 'andrui_artifact_drawer_height';
const DEFAULT_PANEL_HEIGHT = 320;
const MIN_PANEL_HEIGHT = 180;

/** Fired after something stores a host artifact outside a job (heap dumps, snapshots, uploads). */
export const ARTIFACTS_CHANGED_EVENT = 'andrui:artifacts-changed';

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/** Docked bottom panel listing every host artifact with download and delete. */
export const ArtifactDrawer: React.FC = () => {
  const { isArtifactDrawerOpen, setIsArtifactDrawerOpen, jobs } = useWorkstation();
  const [isExpanded, setIsExpanded] = useState(false);
  const [shouldRender, setShouldRender] = useState(isArtifactDrawerOpen);
  const [isClosing, setIsClosing] = useState(false);
  const [isResizing, setIsResizing] = useState(false);
  const [artifacts, setArtifacts] = useState<Artifact[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [panelHeight, setPanelHeight] = useState(() => {
    try {
      const saved = Number(localStorage.getItem(PANEL_HEIGHT_KEY));
      return saved >= MIN_PANEL_HEIGHT ? saved : DEFAULT_PANEL_HEIGHT;
    } catch {
      return DEFAULT_PANEL_HEIGHT;
    }
  });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const list = await api.getArtifacts();
      setArtifacts([...list].sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  // Slide open / close animation matching JobDrawer
  useEffect(() => {
    if (isArtifactDrawerOpen) {
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
  }, [isArtifactDrawerOpen, shouldRender]);

  // Reload when opened, when a job produces artifacts, or when another view stores one.
  const jobArtifactCount = jobs.reduce((n, j) => n + (j.artifactIds?.length ?? 0), 0);
  useEffect(() => {
    if (isArtifactDrawerOpen) void load();
  }, [isArtifactDrawerOpen, jobArtifactCount, load]);
  useEffect(() => {
    const reload = () => { if (isArtifactDrawerOpen) void load(); };
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, reload);
    return () => window.removeEventListener(ARTIFACTS_CHANGED_EVENT, reload);
  }, [isArtifactDrawerOpen, load]);

  // Escape collapses or closes the drawer
  useEffect(() => {
    if (!isArtifactDrawerOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (isExpanded) setIsExpanded(false);
      else setIsArtifactDrawerOpen(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isArtifactDrawerOpen, isExpanded, setIsArtifactDrawerOpen]);

  // Publish height CSS variable so MainContent reserves bottom padding
  useEffect(() => {
    const root = document.documentElement.style;
    root.setProperty('--artifact-drawer-height', `${panelHeight}px`);
    return () => { root.removeProperty('--artifact-drawer-height'); };
  }, [panelHeight]);

  const maxPanelHeight = () => panelRef.current?.parentElement?.clientHeight || window.innerHeight;

  const resizeTo = (height: number) => {
    if (height >= maxPanelHeight() - 8) {
      setIsExpanded(true);
      return;
    }
    const next = Math.round(Math.max(MIN_PANEL_HEIGHT, height));
    setIsExpanded(false);
    setPanelHeight(next);
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

  const remove = async (artifact: Artifact) => {
    if (!window.confirm(`Delete ${artifact.name} (${formatBytes(artifact.size)}) from the host? This cannot be undone.`)) return;
    setDeleting(artifact.id);
    setError('');
    try {
      await api.deleteArtifact(artifact.id);
      setArtifacts((prev) => prev?.filter((a) => a.id !== artifact.id) ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeleting(null);
    }
  };

  if (!shouldRender) return null;

  const q = filter.trim().toLowerCase();
  const shown = (artifacts ?? []).filter((a) => !q || a.name.toLowerCase().includes(q) || a.id.includes(q) || a.contentType.toLowerCase().includes(q));
  const totalBytes = (artifacts ?? []).reduce((n, a) => n + a.size, 0);

  return (
    <div
      ref={panelRef}
      className={`job-drawer-container artifact-drawer-container ${isResizing ? 'resizing' : ''} ${isClosing ? 'closing' : ''}`}
      style={{ height: isExpanded ? '100%' : `${panelHeight}px` }}
      role="region"
      aria-label="Artifacts panel"
      onAnimationEnd={(e) => {
        if (isClosing && e.target === panelRef.current) {
          setShouldRender(false);
          setIsClosing(false);
        }
      }}
    >
      <div
        className="job-resize-handle"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize artifacts panel"
        title="Drag to resize · double-click to expand or restore"
        tabIndex={0}
        onPointerDown={handleResizeStart}
        onDoubleClick={() => setIsExpanded(!isExpanded)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
          e.preventDefault();
          resizeTo((isExpanded ? maxPanelHeight() : panelHeight) + (e.key === 'ArrowUp' ? 40 : -40));
        }}
      />

      <div className="job-toolbar">
        <div className="job-toolbar-title" onPointerDown={handleResizeStart} title="Drag to resize artifacts panel">
          <Archive size={14} className="text-emerald" />
          <span>Artifacts</span>
          {artifacts && <span className="text-muted">{artifacts.length} · {formatBytes(totalBytes)}</span>}
        </div>
        <input
          type="search"
          className="input input-xs text-xs font-mono artifact-filter"
          placeholder="Filter artifacts"
          aria-label="Filter artifacts"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <div className="job-toolbar-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()} disabled={loading} title="Reload artifacts" aria-label="Reload artifacts">
            <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIsExpanded(!isExpanded)} title={isExpanded ? 'Collapse' : 'Expand'}>
            {isExpanded ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setIsArtifactDrawerOpen(false)} title="Close Artifacts" aria-label="Close Artifacts">
            <X size={14} />
          </button>
        </div>
      </div>

      <div className="artifact-drawer-body">
        {error && <p className="text-xs text-warning" role="alert">{error}</p>}
        {artifacts === null && !error && <p className="text-xs text-dim">Loading artifacts…</p>}
        {artifacts && artifacts.length === 0 && <p className="text-xs text-dim">No artifacts yet. Screenshots, pulled files, bug reports, heap dumps and uploads appear here.</p>}
        {artifacts && artifacts.length > 0 && shown.length === 0 && <p className="text-xs text-dim">No artifact matches “{filter}”.</p>}
        {shown.length > 0 && (
          <table className="data-table artifact-table">
            <thead>
              <tr><th>Name</th><th>Type</th><th>Size</th><th>Created</th><th aria-label="Actions" /></tr>
            </thead>
            <tbody>
              {shown.map((a) => (
                <tr key={a.id}>
                  <td className="font-mono" title={a.id}><span className="artifact-name">{a.name}</span><span className="artifact-id text-dim">{a.id}</span></td>
                  <td className="text-dim">{a.contentType}</td>
                  <td className="font-mono">{formatBytes(a.size)}</td>
                  <td className="text-dim">{new Date(a.createdAt).toLocaleString()}</td>
                  <td>
                    <div className="artifact-actions">
                      <a className="btn btn-secondary btn-xs" href={api.getArtifactDownloadUrl(a.id)} download={a.name}>
                        <Download size={12} /><span>Download</span>
                      </a>
                      <button type="button" className="btn btn-ghost btn-xs" disabled={deleting === a.id} onClick={() => void remove(a)} aria-label={`Delete ${a.name}`} title="Delete from host">
                        <Trash2 size={12} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};
