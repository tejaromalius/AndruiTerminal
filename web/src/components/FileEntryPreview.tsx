import React, { useEffect, useState } from 'react';
import { Eye, File, Folder, RefreshCw } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import { formatBytes } from '../lib/deviceStats.js';
import type { FileEntry } from '../types/api.js';

const TEXT = /\.(txt|log|md|json|xml|ya?ml|csv|tsv|ini|conf|cfg|prop|properties|sh|rc|html?|css|js|ts|kt|java|py|sql|gradle)$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** Largest file pulled for an inline preview. */
const PREVIEW_LIMIT = 2 * 1024 * 1024;
const TEXT_SHOWN = 64 * 1024;

/** Fills the detail pane: a folder's contents, or an on-demand preview of a text or image file. */
export const FileEntryPreview: React.FC<{ deviceId: string; entry: FileEntry; onOpenChild: (child: FileEntry) => void }> = ({ deviceId, entry, onOpenChild }) => {
  return entry.directory
    ? <FolderContents deviceId={deviceId} folder={entry} onOpenChild={onOpenChild} />
    : <FilePreview entry={entry} />;
};

const FolderContents: React.FC<{ deviceId: string; folder: FileEntry; onOpenChild: (child: FileEntry) => void }> = ({ deviceId, folder, onOpenChild }) => {
  const [children, setChildren] = useState<FileEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try { setChildren((await api.getFiles(deviceId, folder.path)).entries ?? []); }
    catch (e) { setChildren(null); setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setChildren(null); void load(); }, [deviceId, folder.path]);

  const sorted = [...(children ?? [])].sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
  const dirs = sorted.filter((c) => c.directory).length;
  const bytes = sorted.reduce((sum, c) => sum + (c.directory ? 0 : c.size ?? 0), 0);

  return (
    <section className="entry-preview" aria-label="Folder contents">
      <div className="entry-preview-head">
        <span className="inspect-card-title"><Folder size={14} />Contents</span>
        {children && <span className="text-xs text-dim">{dirs} folder{dirs === 1 ? '' : 's'} · {sorted.length - dirs} file{sorted.length - dirs === 1 ? '' : 's'} · {formatBytes(bytes)}</span>}
        <button type="button" className="btn btn-ghost btn-xs" onClick={() => void load()} disabled={loading} aria-label="Reload folder contents" title="Reload folder contents">
          <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} />
        </button>
      </div>
      {error && <div className="inspect-note inspect-note-error">{error}</div>}
      {!children && !error && <div className="inspect-empty">Reading {folder.path}…</div>}
      {children && children.length === 0 && <div className="inspect-empty">This folder is empty or not readable.</div>}
      {sorted.length > 0 && (
        <div className="entry-table-wrap">
          <table className="entry-table">
            <thead><tr><th>Name</th><th>Size</th><th>Permissions</th><th>Modified</th></tr></thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.path} onClick={() => onOpenChild(c)} title={c.directory ? `Open ${c.path}` : `Show ${c.path}`}>
                  <td><span className="entry-name">{c.directory ? <Folder size={13} className="text-warning" /> : <File size={13} className="text-dim" />}<span>{c.name}</span></span></td>
                  <td className="font-mono">{c.directory ? '—' : formatBytes(c.size ?? 0)}</td>
                  <td className="font-mono">{c.mode || '—'}</td>
                  <td className="font-mono">{c.modified || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};

const FilePreview: React.FC<{ entry: FileEntry }> = ({ entry }) => {
  const { runOperation } = useWorkstation();
  const [text, setText] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const kind = IMAGE.test(entry.name) ? 'image' : TEXT.test(entry.name) ? 'text' : null;
  const tooLarge = (entry.size ?? 0) > PREVIEW_LIMIT;

  useEffect(() => { setText(null); setImage(null); setError(null); }, [entry.path]);
  useEffect(() => () => { if (image) URL.revokeObjectURL(image); }, [image]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const job = await runOperation('file.pull', { remote: entry.path });
      const done = await api.waitForSuccessfulJob(job.id);
      const id = done.artifactIds[0];
      if (!id) throw new Error('The pull produced no artifact to preview');
      const res = await fetch(api.getArtifactDownloadUrl(id), { credentials: 'same-origin' });
      if (!res.ok) throw new Error(`Artifact download failed (${res.status})`);
      if (kind === 'image') setImage(URL.createObjectURL(await res.blob()));
      else setText((await res.text()).slice(0, TEXT_SHOWN));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setLoading(false); }
  };

  return (
    <section className="entry-preview" aria-label="File preview">
      <div className="entry-preview-head">
        <span className="inspect-card-title"><Eye size={14} />Preview</span>
        {kind && !tooLarge && (
          <button type="button" className="btn btn-secondary btn-xs" onClick={() => void load()} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : undefined} /><span>{text !== null || image ? 'Reload preview' : 'Load preview'}</span>
          </button>
        )}
      </div>
      {error && <div className="inspect-note inspect-note-error">{error}</div>}
      {image && <div className="entry-preview-image"><img src={image} alt={entry.name} /></div>}
      {text !== null && <pre className="inspection-output entry-preview-text">{text || '(empty file)'}{text.length >= TEXT_SHOWN ? '\n… preview truncated' : ''}</pre>}
      {text === null && !image && !error && (
        <div className="inspect-empty">
          {!kind ? 'No inline preview for this file type. Use Pull / Download to open it on this computer.'
            : tooLarge ? `Too large for an inline preview (over ${formatBytes(PREVIEW_LIMIT)}). Use Pull / Download instead.`
              : loading ? 'Pulling a copy to preview…' : 'Load preview pulls a copy of this file to the host (kept in Artifacts) and shows it here.'}
        </div>
      )}
    </section>
  );
};
