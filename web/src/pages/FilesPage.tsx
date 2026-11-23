import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState, useEffect, useCallback } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { FileEntry } from '../types/api.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid, TabKpiItem } from '../components/TabKpiGrid.js';
import { WorkbenchEmpty, WorkbenchItem, WorkbenchList } from '../components/WorkbenchList.js';
import { CopyButton } from '../components/AppDetail.js';
import { FileEntryPreview } from '../components/FileEntryPreview.js';
import { useDeviceStats, statsPendingReason } from '../lib/useDeviceStats.js';
import { DiskUsage, firstLine, formatBytes, parseDf } from '../lib/deviceStats.js';
import {
  Folder,
  File,
  ArrowUp,
  RefreshCw,
  Upload,
  Download,
  Trash2,
  FolderPlus,
  Edit2,
  AlertCircle,
  FileCode,
  Shield,
  Layers,
  ChevronRight,
  FolderOpen,
  Star,
  HardDrive,
} from 'lucide-react';

type EntryFilter = 'all' | 'dirs' | 'files';
const ENTRY_FILTERS = [{ id: 'all', label: 'All' }, { id: 'dirs', label: 'Folders' }, { id: 'files', label: 'Files' }];
const RECENT_LIMIT = 6;

// Per-device pinned and recently opened folders (browser storage, like the app picker).
interface FolderMemory { pinned: string[]; recent: string[] }
const folderKey = (deviceId: string) => `andrui_files_${deviceId}`;
function loadFolders(deviceId: string | null): FolderMemory {
  if (!deviceId) return { pinned: [], recent: [] };
  try {
    const raw = JSON.parse(localStorage.getItem(folderKey(deviceId)) ?? '{}');
    return { pinned: Array.isArray(raw.pinned) ? raw.pinned : [], recent: Array.isArray(raw.recent) ? raw.recent : [] };
  } catch { return { pinned: [], recent: [] }; }
}
function saveFolders(deviceId: string, value: FolderMemory) {
  try { localStorage.setItem(folderKey(deviceId), JSON.stringify(value)); } catch { /* keep in memory */ }
}
const folderItem = (path: string): WorkbenchItem => ({ id: path, title: path.split('/').filter(Boolean).pop() || '/', subtitle: path, icon: <Folder size={15} className="text-warning" /> });

export const FilesPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('files', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    openOperationModal,
    runOperation,
  } = useWorkstation();

  const [currentPath, setCurrentPath] = useState('/sdcard');
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedPath, setSelectedPath] = useState('');
  const [filter, setFilter] = useState<EntryFilter>('all');
  const [dragging, setDragging] = useState(false);
  const [folders, setFoldersState] = useState<FolderMemory>(() => loadFolders(selectedDeviceId));
  useEffect(() => { setFoldersState(loadFolders(selectedDeviceId)); setSelectedPath(''); }, [selectedDeviceId]);
  const setFolders = (update: (current: FolderMemory) => FolderMemory) => setFoldersState((current) => {
    const next = update(current);
    if (selectedDeviceId) saveFolders(selectedDeviceId, next);
    return next;
  });
  const togglePin = (path: string) => setFolders((f) => ({ ...f, pinned: f.pinned.includes(path) ? f.pinned.filter((x) => x !== path) : [...f.pinned, path] }));

  // Load directory entries from real API
  const loadDirectory = useCallback(
    async (path: string) => {
      if (!selectedDeviceId) return;
      setLoading(true);
      setError(null);
      try {
        const res = await api.getFiles(selectedDeviceId, path);
        const opened = res.path || path;
        setEntries(res.entries || []);
        setCurrentPath(opened);
        setSelectedPath('');
        setFolders((f) => ({ ...f, recent: [opened, ...f.recent.filter((x) => x !== opened)].slice(0, RECENT_LIMIT) }));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to list directory');
      } finally {
        setLoading(false);
      }
    },
    [selectedDeviceId]
  );

  useEffect(() => {
    if (selectedDeviceId) {
      loadDirectory(currentPath);
    }
  }, [selectedDeviceId, loadDirectory]);

  // Address bar: breadcrumbs, or a text field while typing a path.
  const [editingPath, setEditingPath] = useState(false);
  const [pathDraft, setPathDraft] = useState('');
  const startEditingPath = () => { setPathDraft(currentPath); setEditingPath(true); };
  const crumbs = [{ label: '/', path: '/' }, ...currentPath.split('/').filter(Boolean).map((part, i, parts) => ({ label: part, path: '/' + parts.slice(0, i + 1).join('/') }))];

  // Navigate up one directory level
  const handleNavigateUp = () => {
    if (currentPath === '/' || currentPath === '') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const upPath = '/' + parts.join('/');
    loadDirectory(upPath);
  };

  const handleUploadFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) void uploadFile(file);
  };

  const uploadFile = async (file: File) => {
    if (!selectedDeviceId) return;
    try {
      const op = findOperation('file.push');
      if (!op) throw new Error('File push is unavailable in the operation catalog');
      const remote = `${currentPath.replace(/\/$/, '')}/${file.name}`;
      if (op.destructive && !window.confirm(`Upload ${file.name} to ${remote} on ${selectedDeviceId}? Any existing file at this destination will be overwritten.`)) return;
      setLoading(true);
      setError(null);
      const artifact = await api.uploadArtifact(file);
      const job = await runOperation(op.id, { local: artifact.id, remote }, op.destructive);
      await api.waitForSuccessfulJob(job.id);
      await loadDirectory(currentPath);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setLoading(false);
    }
  };

  const handleDownloadFile = async (entry: FileEntry) => {
    setLoading(true); setError(null);
    try {
      const job = await runOperation('file.pull', { remote: entry.path }, false, { showDrawer: true });
      const result = await api.waitForSuccessfulJob(job.id);
      if (!result.artifactIds.length) throw new Error('No downloadable artifact was produced');
      for (const id of result.artifactIds) {
        const link = document.createElement('a'); link.href = api.getArtifactDownloadUrl(id); link.download = entry.name; document.body.appendChild(link); link.click(); link.remove();
      }
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  const handleDeleteEntry = (entry: FileEntry) => {
    const op = findOperation('file.rm');
    if (op) openOperationModal(op, { path: entry.path, recursive: entry.directory });
    else setError('File removal is unavailable in the operation catalog');
  };

  const handleMkdir = () => {
    const op = findOperation('file.mkdir');
    if (op) openOperationModal(op, { path: `${currentPath.replace(/\/$/, '')}/NewFolder` });
    else setError('Directory creation is unavailable in the operation catalog');
  };

  const storage = useDeviceStats('files', selectedDeviceId, 30000, { enabled: activeTab !== 'operations' });
  const storagePending = statsPendingReason(selectedDeviceId, storage);
  const dataDisk = parseDf(storage.stats?.sections.data?.output ?? null);
  const sdcardDisk = parseDf(storage.stats?.sections.sdcard?.output ?? null);
  const diskItem = (id: string, label: string, path: string, disk: DiskUsage | null, icon: typeof Folder, color: string, browse: string): TabKpiItem => {
    const pct = disk && disk.totalBytes > 0 ? Math.round((disk.usedBytes / disk.totalBytes) * 100) : null;
    return {
      id,
      label,
      value: storagePending ? '—' : disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.totalBytes)}` : 'Unavailable',
      subtext: storagePending ?? (disk ? `${pct}% used · ${formatBytes(disk.availBytes)} free (${path})` : firstLine(storage.stats?.sections[path === '/data' ? 'data' : 'sdcard'])),
      icon,
      badge: pct !== null && pct >= 90 ? 'Almost full' : undefined,
      badgeType: 'warning',
      color,
      onClick: selectedDeviceId ? () => loadDirectory(browse) : undefined,
    };
  };

  const formatSize = (bytes?: number) => {
    if (bytes === undefined || bytes === null) return '-';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const entryItems: WorkbenchItem[] | null = selectedDeviceId ? entries.map((entry) => ({
    id: entry.path,
    title: entry.name,
    subtitle: [entry.directory ? null : formatSize(entry.size), entry.mode, entry.modified].filter(Boolean).join(' · ') || undefined,
    icon: entry.directory ? <Folder size={15} className="text-warning" /> : <File size={15} className="text-dim" />,
    tags: [entry.directory ? 'dirs' : 'files'],
    pinnable: entry.directory,
  })) : null;
  const selectedEntry = entries.find((e) => e.path === selectedPath) ?? null;
  const openEntry = (path: string) => {
    const entry = entries.find((e) => e.path === path);
    if (!entry || entry.directory) loadDirectory(path);
    else void handleDownloadFile(entry);
  };
  // From the folder preview: open a sub-folder, or open the folder and select the file.
  const openChild = async (child: FileEntry) => {
    if (child.directory) { await loadDirectory(child.path); return; }
    await loadDirectory(child.path.slice(0, child.path.lastIndexOf('/')) || '/');
    setSelectedPath(child.path);
  };
  // Pinned and recent folders live outside the listing: picking one opens it.
  const pickEntry = (path: string) => {
    if (entries.some((e) => e.path === path)) setSelectedPath(path);
    else loadDirectory(path);
  };
  const onDrop = (e: React.DragEvent) => {
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    e.preventDefault();
    void uploadFile(file);
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="Files & Data Management"
        description="Browse remote filesystems, recursive push/pull, file permissions, and app-private run-as data"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      {error && (
        <div className="alert alert-danger">
          <AlertCircle size={16} />
          <span>{error}</span>
        </div>
      )}

      <PageTabs page="files" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <TabKpiGrid
            items={[
              diskItem('files-data-partition', 'Data Partition', '/data', dataDisk, Folder, 'var(--emerald-accent)', '/data'),
              diskItem('files-shared-storage', 'Shared Storage', '/sdcard', sdcardDisk, Layers, 'var(--color-info)', '/sdcard'),
              {
                id: 'files-entry-count',
                label: 'Folder Entries',
                value: !selectedDeviceId ? '—' : loading ? '…' : error ? 'Unavailable' : entries.length,
                subtext: !selectedDeviceId
                  ? 'No device selected'
                  : error
                    ? 'Folder could not be listed'
                    : `${entries.filter((e) => e.directory).length} folders · ${entries.filter((e) => !e.directory).length} files`,
                icon: File,
                color: 'var(--color-success)',
                onClick: () => setFilter('all'),
              },
              {
                id: 'files-folder-size',
                label: 'Files in Folder',
                value: !selectedDeviceId ? '—' : loading ? '…' : error ? 'Unavailable' : formatBytes(entries.filter((e) => !e.directory).reduce((sum, e) => sum + (e.size ?? 0), 0)),
                subtext: selectedDeviceId ? `Direct files in ${currentPath} (not recursive)` : 'No device selected',
                icon: FileCode,
                color: 'var(--color-purple)',
                onClick: () => setFilter('files'),
              },
            ]}
          />
          <div className="workspace-panel files-pathbar">
            <div className="files-pathbar-row">
              <div className="files-nav">
                <button className="btn btn-secondary btn-sm" onClick={handleNavigateUp} disabled={loading || currentPath === '/' || !selectedDeviceId} title="Go Up" aria-label="Go Up">
                  <ArrowUp size={13} />
                </button>
                <button className="btn btn-secondary btn-sm" onClick={() => loadDirectory(currentPath)} disabled={loading || !selectedDeviceId} title="Reload directory" aria-label="Reload directory">
                  <RefreshCw size={13} className={loading ? 'animate-spin' : undefined} />
                </button>
              </div>
              {editingPath ? (
                <input
                  type="text"
                  className="input font-mono text-xs files-address"
                  aria-label="Directory path"
                  autoFocus
                  value={pathDraft}
                  onChange={(e) => setPathDraft(e.target.value)}
                  onBlur={() => setEditingPath(false)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') { setEditingPath(false); loadDirectory(pathDraft.trim() || '/'); }
                    if (e.key === 'Escape') setEditingPath(false);
                  }}
                />
              ) : (
                <div className="files-address files-crumbs" onClick={(e) => { if (e.target === e.currentTarget) startEditingPath(); }}>
                  <HardDrive size={13} className="text-dim" aria-hidden="true" />
                  {crumbs.map((crumb, i) => (
                    <React.Fragment key={crumb.path}>
                      {i > 0 && <ChevronRight size={12} className="files-crumb-sep" aria-hidden="true" />}
                      <button type="button" className={`files-crumb ${i === crumbs.length - 1 ? 'current' : ''}`} disabled={!selectedDeviceId || loading}
                        aria-label={`Go to ${crumb.path}`} onClick={() => loadDirectory(crumb.path)}>{crumb.label}</button>
                    </React.Fragment>
                  ))}
                  <button type="button" className="btn btn-ghost btn-xs files-address-edit" onClick={startEditingPath} title="Type a path" aria-label="Edit path">
                    <Edit2 size={12} />
                  </button>
                </div>
              )}
              <button type="button" className={`btn btn-ghost btn-sm app-pin ${folders.pinned.includes(currentPath) ? 'app-pin-on' : ''}`} disabled={!selectedDeviceId}
                onClick={() => togglePin(currentPath)} aria-label={folders.pinned.includes(currentPath) ? `Unpin ${currentPath}` : `Pin ${currentPath}`} title="Pin this folder">
                <Star size={13} />
              </button>
              <div className="files-pathbar-actions">
                <label className={`btn btn-primary btn-sm ${loading || !selectedDeviceId ? 'disabled' : 'cursor-pointer'}`}>
                  <Upload size={13} />
                  <span>Upload to Here</span>
                  <input
                    type="file"
                    style={{ display: 'none' }}
                    onChange={handleUploadFile}
                    disabled={loading || !selectedDeviceId}
                  />
                </label>
                <button className="btn btn-secondary btn-sm" onClick={handleMkdir} disabled={!selectedDeviceId}>
                  <FolderPlus size={13} />
                  <span>New Folder</span>
                </button>
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => {
                    const op = findOperation('file.run_as');
                    if (op) openOperationModal(op);
                  }}
                  disabled={!selectedDeviceId}
                  title="App Private Data via run-as"
                >
                  <Shield size={13} />
                  <span>Run-As Private</span>
                </button>
              </div>
            </div>

            <div className="chip-row files-jump">
              <span className="chip-row-label">Jump to</span>
              {['/sdcard', '/data/local/tmp', '/sdcard/Download', '/system', '/data'].map((path) => (
                <button
                  key={path}
                  type="button"
                  className={`chip-button mono ${currentPath === path ? 'active' : ''}`}
                  onClick={() => loadDirectory(path)}
                  disabled={!selectedDeviceId}
                >
                  {path}
                </button>
              ))}
            </div>
          </div>

          <div
            className={`app-workbench ${dragging ? 'app-workbench-drop' : ''}`}
            onDragOver={(e) => { if (selectedDeviceId && [...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); setDragging(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={onDrop}
          >
            <WorkbenchList
              items={entryItems}
              label="Folder entries"
              placeholder="Filter entries…"
              filters={ENTRY_FILTERS}
              filter={filter}
              onFilter={(f) => setFilter(f as EntryFilter)}
              selected={selectedPath}
              onSelect={pickEntry}
              onOpen={openEntry}
              pinned={folders.pinned.map(folderItem)}
              recent={folders.recent.filter((p) => p !== currentPath).map(folderItem)}
              isPinned={(path) => folders.pinned.includes(path)}
              onTogglePin={(item) => togglePin(item.id)}
              status={
                !selectedDeviceId ? <div className="text-xs text-dim">Select a device to view files</div>
                  : loading ? <div className="text-xs text-dim">Reading directory entries...</div>
                    : entries.length === 0 ? <div className="text-xs text-dim">Directory is empty or inaccessible</div>
                      : null
              }
            />
            {selectedEntry ? (
              <div className="workspace-panel app-detail files-detail">
                <div className="app-detail-head">
                  <div className="app-detail-title">
                    {selectedEntry.directory ? <Folder size={16} className="text-warning" /> : <File size={16} className="text-dim" />}
                    <h2 className="panel-title font-mono" title={selectedEntry.path}>{selectedEntry.name}</h2>
                    <CopyButton value={selectedEntry.path} label="path" />
                  </div>
                  <dl className="app-detail-factsheet">
                    <div><dt>Type</dt><dd>{selectedEntry.directory ? 'Folder' : 'File'}</dd></div>
                    <div><dt>Size</dt><dd className="font-mono">{selectedEntry.directory ? '—' : formatSize(selectedEntry.size)}</dd></div>
                    <div><dt>Permissions</dt><dd className="font-mono">{selectedEntry.mode || '—'}</dd></div>
                    <div><dt>Modified</dt><dd className="font-mono">{selectedEntry.modified || '—'}</dd></div>
                    <div className="app-detail-fact-wide"><dt>Path</dt><dd className="font-mono">{selectedEntry.path}<CopyButton value={selectedEntry.path} label="full path" /></dd></div>
                  </dl>
                  <div className="app-detail-ops" role="group" aria-label="Entry operations">
                    {selectedEntry.directory ? (
                      <>
                        <button type="button" className="btn btn-primary btn-xs" onClick={() => loadDirectory(selectedEntry.path)} disabled={loading}><FolderOpen size={12} /><span>Open folder</span></button>
                        <button type="button" className="btn btn-secondary btn-xs" onClick={() => togglePin(selectedEntry.path)}><Star size={12} /><span>{folders.pinned.includes(selectedEntry.path) ? 'Unpin folder' : 'Pin folder'}</span></button>
                      </>
                    ) : (
                      <button type="button" className="btn btn-primary btn-xs" onClick={() => handleDownloadFile(selectedEntry)} disabled={loading} title="Pull / Download File"><Download size={12} /><span>Pull / Download</span></button>
                    )}
                    <span className="app-detail-ops-danger">
                      <button type="button" className="btn btn-danger btn-xs" onClick={() => handleDeleteEntry(selectedEntry)} title="Delete"><Trash2 size={12} /><span>Delete</span></button>
                    </span>
                  </div>
                </div>
                {selectedDeviceId && <FileEntryPreview deviceId={selectedDeviceId} entry={selectedEntry} onOpenChild={openChild} />}
              </div>
            ) : (
              <WorkbenchEmpty icon={<Folder size={24} className="text-dim" />} openHint="open folder / pull file">
                Pick an entry, double-click a folder to open it, or drop a file here to upload it to {currentPath}.
              </WorkbenchEmpty>
            )}
          </div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Files"
            coveragePrefix="F"
            title="File & Sync Operations"
            description="Sync partitions, dry-run transfers, recursive push/pull, permissions and ownership"
          />
        </>
      }]} />
    </div>
  );
};
