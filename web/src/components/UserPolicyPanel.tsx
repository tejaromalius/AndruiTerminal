import React, { useEffect, useState } from 'react';
import { Globe, Lock, Play, Plus, RefreshCw, Terminal, Users } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import type { Job } from '../types/api.js';

interface UserRow { id: string; name: string; flags: string; running: boolean }

/** `pm list users` rows: `UserInfo{0:Owner:c13} running`. */
export function parseUserRows(text: string | null): UserRow[] {
  return (text ?? '').split('\n').flatMap((line) => {
    const m = line.match(/UserInfo\{(\d+):([^:}]*):([0-9a-fA-F]+)\}/);
    return m ? [{ id: m[1], name: m[2], flags: m[3], running: /\brunning\b/.test(line) }] : [];
  });
}

const LABELS: Record<string, string> = {
  'users.list': 'pm list users',
  'users.create': 'pm create-user',
  'applinks.get': 'pm get-app-links',
  'dpm.set_device_owner': 'dpm set-device-owner',
};

/** Users, app links and device policy with the output of the last action kept in the panel. */
export const UserPolicyPanel: React.FC<{
  deviceId: string | null;
  /** Package selected on the page; prefills the app links check. */
  packageName: string;
  /** `pm list users` from the page's collected stats. */
  usersText: string | null;
  /** Parsed `dpm list-owners`, null when unavailable. */
  owners: string[] | null;
  onRefresh: () => void;
  refreshing: boolean;
}> = ({ deviceId, packageName, usersText, owners, onRefresh, refreshing }) => {
  const { findOperation, openOperationModal, runOperation, jobs = [] } = useWorkstation();
  const [userName, setUserName] = useState('Work Profile');
  const [linksPkg, setLinksPkg] = useState(packageName);
  const [ownerComponent, setOwnerComponent] = useState('');
  // The job whose output is shown; `waiting` holds an operation sent to the confirmation dialog until its job appears.
  const [jobId, setJobId] = useState<string | null>(null);
  const [waiting, setWaiting] = useState<{ op: string; known: Set<string> } | null>(null);
  const [result, setResult] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { if (packageName) setLinksPkg(packageName); }, [packageName]);

  useEffect(() => {
    if (!waiting) return;
    const job = jobs.find((j) => j.operationId === waiting.op && !waiting.known.has(j.id));
    if (job) { setWaiting(null); setJobId(job.id); }
  }, [jobs, waiting]);

  useEffect(() => {
    if (!jobId) return;
    let cancelled = false;
    setResult(jobs.find((j) => j.id === jobId) ?? null);
    api.waitForJob(jobId).then((job) => { if (!cancelled) setResult(job); }, (e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobId]);

  const live = jobId ? jobs.find((j) => j.id === jobId) : null;
  const shown = result && (result.status !== 'queued' && result.status !== 'running') ? result : live ?? result;

  const run = async (operationId: string, params: Record<string, unknown>) => {
    setError(null);
    setResult(null);
    try { setJobId((await runOperation(operationId, params)).id); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  };
  /** Destructive actions keep their confirmation dialog; the job it starts is picked up here. */
  const confirm = (operationId: string, params: Record<string, unknown>) => {
    const op = findOperation(operationId);
    if (!op) return;
    setError(null);
    setResult(null);
    setJobId(null);
    setWaiting({ op: operationId, known: new Set(jobs.map((j) => j.id)) });
    openOperationModal(op, params);
  };

  const userRows = parseUserRows(usersText);
  const busy = shown?.status === 'queued' || shown?.status === 'running';

  return (
    <section className="workspace-panel policy-panel" aria-labelledby="policy-heading">
      <div className="policy-head">
        <div>
          <h2 id="policy-heading" className="panel-title"><Users size={16} className="text-emerald" />Multi-User & Device Policy</h2>
          <p className="text-xs text-dim">Manage work profiles, user creation, and Android Enterprise policy controls.</p>
        </div>
      </div>

      <div className="policy-grid">
        <div className="inspect-card">
          <div className="inspect-card-head">
            <span className="inspect-card-title"><Users size={14} />Users & profiles</span>
            <div className="inspect-toolbar-actions">
              <button type="button" className="btn btn-ghost btn-xs" disabled={!deviceId || refreshing} onClick={onRefresh} title="Re-read users and owners" aria-label="Re-read users and owners">
                <RefreshCw size={12} className={refreshing ? 'animate-spin' : undefined} />
              </button>
              <button type="button" className="btn btn-secondary btn-xs" disabled={!deviceId || busy} onClick={() => run('users.list', {})}>
                <Terminal size={12} /><span>List Users (pm list users)</span>
              </button>
            </div>
          </div>
          {userRows.length > 0 ? (
            <ul className="inspect-list">
              {userRows.map((u) => (
                <li key={u.id} className="inspect-row">
                  <span className="policy-user-id font-mono">{u.id}</span>
                  <span className="inspect-row-main">{u.name || 'Unnamed'}<span className="inspect-row-sub font-mono">flags 0x{u.flags}</span></span>
                  <span className="inspect-row-tags">
                    {u.id === '0' && <span className="badge badge-neutral">owner</span>}
                    <span className={`badge ${u.running ? 'badge-success' : 'badge-neutral'}`}>{u.running ? 'running' : 'stopped'}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : <div className="inspect-empty">{deviceId ? 'No user list reported yet.' : 'Select a device to list its users.'}</div>}
          <form className="policy-inline" onSubmit={(e) => { e.preventDefault(); confirm('users.create', { name: userName }); }}>
            <input className="input" aria-label="New user name" placeholder="New user name" value={userName} onChange={(e) => setUserName(e.target.value)} />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={!deviceId || !userName.trim() || busy}><Plus size={13} /><span>Create New User</span></button>
          </form>
        </div>

        <div className="inspect-card">
          <div className="inspect-card-head"><span className="inspect-card-title"><Lock size={14} />Policy & app links</span></div>
          <dl className="inspect-kv">
            <dt>Owners</dt>
            <dd>{owners === null ? <span className="text-dim">Unavailable</span> : owners.length === 0 ? <span className="text-dim">No admin owns this device</span> : owners.join(' · ')}</dd>
          </dl>
          <form className="policy-field" onSubmit={(e) => { e.preventDefault(); run('applinks.get', { package: linksPkg.trim() }); }}>
            <label htmlFor="policy-links">Verify app links</label>
            <div className="policy-inline">
              <input id="policy-links" className="input font-mono" placeholder="com.example.app" value={linksPkg} onChange={(e) => setLinksPkg(e.target.value)} />
              <button type="submit" className="btn btn-secondary btn-sm" disabled={!deviceId || !linksPkg.trim() || busy}><Globe size={13} /><span>Verify App Links</span></button>
            </div>
          </form>
          <form className="policy-field" onSubmit={(e) => { e.preventDefault(); confirm('dpm.set_device_owner', { component: ownerComponent.trim() }); }}>
            <label htmlFor="policy-owner">Device Policy Manager · set device owner</label>
            <div className="policy-inline">
              <input id="policy-owner" className="input font-mono" placeholder="com.example/.AdminReceiver" value={ownerComponent} onChange={(e) => setOwnerComponent(e.target.value)} />
              <button type="submit" className="btn btn-danger btn-sm" disabled={!deviceId || busy}><Lock size={13} /><span>Device Policy Manager</span></button>
            </div>
          </form>
        </div>
      </div>

      <div className="policy-output" aria-live="polite">
        <div className="policy-output-head">
          <span className="inspect-card-title"><Play size={13} />Output</span>
          {shown && <span className="font-mono text-xs text-dim">{LABELS[shown.operationId] ?? shown.operationId}</span>}
          {shown && <span className={`badge badge-${shown.status === 'completed' ? 'success' : shown.status === 'failed' ? 'danger' : shown.status === 'cancelled' ? 'neutral' : 'info'}`}>{shown.status}</span>}
          {shown?.exitCode !== undefined && shown?.exitCode !== null && <span className="text-xs text-dim">exit {shown.exitCode}</span>}
        </div>
        {error && <div className="inspect-note inspect-note-error">{error}</div>}
        {waiting && !shown && <div className="inspect-empty">Waiting for confirmation in the operation dialog…</div>}
        {shown ? (
          <pre className="inspection-output policy-output-text">{[shown.stdout, shown.stderr, shown.error].filter((t) => t && t.trim()).join('\n') || (busy ? 'Running…' : 'No output.')}</pre>
        ) : !waiting && !error && <div className="inspect-empty">Run an action above to see its output here.</div>}
      </div>
    </section>
  );
};
