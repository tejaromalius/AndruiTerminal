import React, { useEffect, useState } from 'react';
import { api, ApiError } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import { ARTIFACTS_CHANGED_EVENT } from './ArtifactDrawer.js';
import { DatabaseBrowser } from './DatabaseBrowser.js';
import {
  PackageSigning,
  DbAccessProbe,
  DbEntry,
  DbSnapshot,
  MemoryReport,
  FirebaseReport,
} from '../types/api.js';
import { Shield, Database, Cpu, Flame, RefreshCw, Download, AlertTriangle } from 'lucide-react';

interface Props {
  deviceId: string | null;
  packageName: string;
  /** Render only this section, without the panel title and section switcher. */
  section?: Section;
}

export type Section = 'signing' | 'databases' | 'memory' | 'firebase';

/**
 * Deep per-app inspection: APK signing certificates, private SQLite databases
 * (read + edit a host snapshot, optional guarded write-back), process memory,
 * and Firebase tooling. All calls target the real inspection API.
 */
export const AppInspector: React.FC<Props> = ({ deviceId, packageName, section: only }) => {
  const [chosen, setSection] = useState<Section>('signing');
  const section = only ?? chosen;
  const ready = !!deviceId && !!packageName;

  return (
    <div className={only ? undefined : 'workspace-panel'}>
      {!only && <>
      <h2 className="panel-title">App Inspector</h2>
      <p className="text-xs text-muted">
        Signing certificates, private databases, memory and Firebase for{' '}
        <span className="font-mono text-main">{packageName || '(select a package)'}</span>.
      </p>
      <div className="flex gap-1.5 my-2 flex-wrap">
        {([
          ['signing', 'Signing', Shield],
          ['databases', 'Databases', Database],
          ['memory', 'Memory', Cpu],
          ['firebase', 'Firebase', Flame],
        ] as [Section, string, typeof Shield][]).map(([id, label, Icon]) => (
          <button
            key={id}
            className={`btn btn-xs ${section === id ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setSection(id)}
          >
            <Icon size={12} />
            <span>{label}</span>
          </button>
        ))}
      </div>
      </>}
      {!ready && (
        <div className="text-xs text-dim">Select a device and a package to inspect.</div>
      )}
      {ready && section === 'signing' && <SigningView deviceId={deviceId!} pkg={packageName} />}
      {ready && section === 'databases' && <DatabaseView deviceId={deviceId!} pkg={packageName} />}
      {ready && section === 'memory' && <MemoryView deviceId={deviceId!} pkg={packageName} />}
      {ready && section === 'firebase' && <FirebaseView deviceId={deviceId!} pkg={packageName} />}
    </div>
  );
};

function errMessage(e: unknown): string {
  return e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

const Busy: React.FC<{ error: string | null; loading: boolean }> = ({ error, loading }) => (
  <>
    {loading && <div className="inspect-note"><RefreshCw size={12} className="animate-spin" /> Working…</div>}
    {error && (
      <div className="inspect-note inspect-note-error">
        <AlertTriangle size={12} /> {error}
      </div>
    )}
  </>
);

// --- Signing ---
const SigningView: React.FC<{ deviceId: string; pkg: string }> = ({ deviceId, pkg }) => {
  const [data, setData] = useState<PackageSigning | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.inspectPackageSigning(deviceId, pkg));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="inspect-view">
      <div className="inspect-toolbar">
        <p>Reads the APK signature blocks and hashes every installed APK.</p>
        <button className="btn btn-sm btn-secondary" onClick={load} disabled={loading}>
          <RefreshCw size={13} /> <span>Inspect signing</span>
        </button>
      </div>
      <Busy error={error} loading={loading} />
      {data && (
        <>
          <section className="inspect-card">
            <div className="inspect-card-head">
              <span className="inspect-card-title"><Shield size={14} />Schemes</span>
              <span className="inspect-row-tags">
                {data.signing.schemes.length
                  ? data.signing.schemes.map((s) => <span key={s} className="badge badge-info">{s}</span>)
                  : <span className="text-dim text-xs">none detected</span>}
              </span>
            </div>
            {data.signing.warnings.map((w) => (
              <div key={w} className="inspect-note inspect-note-warning"><AlertTriangle size={12} /> {w}</div>
            ))}
          </section>
          {data.signing.certificates.length > 0 && (
            <section className="inspect-card">
              <div className="inspect-card-head"><span className="inspect-card-title">Certificates ({data.signing.certificates.length})</span></div>
              <ul className="inspect-list">
                {data.signing.certificates.map((c, i) => (
                  <li key={i} className="inspect-block">
                    <div className="inspect-block-head">
                      <span className="badge badge-primary">{c.scheme}</span>
                      {c.debugKey && <span className="badge badge-warning">DEBUG KEY</span>}
                    </div>
                    <dl className="inspect-kv">
                      <dt>SHA-256</dt><dd className="font-mono">{c.sha256}</dd>
                      <dt>SHA-1</dt><dd className="font-mono">{c.sha1}</dd>
                    </dl>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="inspect-card">
            <div className="inspect-card-head"><span className="inspect-card-title">APKs ({data.apks.length})</span></div>
            <ul className="inspect-list">
              {data.apks.map((a) => (
                <li key={a.path} className="inspect-block">
                  <code className="inspect-path">{a.path}</code>
                  <dl className="inspect-kv">
                    <dt>SHA-256</dt><dd className="font-mono">{a.sha256}</dd>
                    <dt>Size</dt><dd>{a.sizeBytes.toLocaleString()} bytes</dd>
                  </dl>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
};

// --- Databases ---
const DatabaseView: React.FC<{ deviceId: string; pkg: string }> = ({ deviceId, pkg }) => {
  const [probe, setProbe] = useState<DbAccessProbe | null>(null);
  const [dbs, setDbs] = useState<DbEntry[] | null>(null);
  const [snapshots, setSnapshots] = useState<DbSnapshot[]>([]);
  const [active, setActive] = useState<DbSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const guard = async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const checkAccess = () =>
    guard(async () => {
      const p = await api.dbAccess(deviceId, pkg);
      setProbe(p);
      setDbs(null);
    });
  const listDbs = () =>
    guard(async () => {
      const r = await api.dbList(deviceId, pkg);
      setDbs(r.databases);
    });
  const snapshot = (database: string) =>
    guard(async () => {
      const snap = await api.dbSnapshotCreate(deviceId, pkg, database);
      setSnapshots((s) => [snap, ...s.filter((x) => x.id !== snap.id)]);
      setActive(snap);
    });
  const push = () =>
    guard(async () => {
      if (!active) return;
      if (
        !window.confirm(
          `Write this snapshot back to ${active.package}/${active.databaseName} on the device? The app will be force-stopped and a backup artifact saved. This is destructive.`
        )
      )
        return;
      const r = await api.dbPush(active.id);
      setError(null);
      window.dispatchEvent(new Event(ARTIFACTS_CHANGED_EVENT));
      window.alert(`Pushed ${r.bytesWritten} bytes. Backup artifact: ${r.backupArtifactId} (listed in the Artifacts panel).`);
    });

  return (
    <div className="inspect-view">
      <div className="inspect-toolbar">
        <p>Snapshot private SQLite databases to the host, query or edit the copy, then optionally push it back.</p>
        <div className="inspect-toolbar-actions">
          <button className="btn btn-xs btn-secondary" onClick={checkAccess} disabled={loading}>Check access</button>
          <button className="btn btn-xs btn-secondary" onClick={listDbs} disabled={loading || !probe?.mode}>List databases</button>
        </div>
      </div>
      <Busy error={error} loading={loading} />
      {probe && (
        <section className="inspect-card">
          <dl className="inspect-kv inspect-kv-inline">
            <dt>Access</dt>
            <dd>{probe.mode ? <span className="badge badge-success">{probe.mode}</span> : <span className="badge badge-danger">unavailable</span>}</dd>
            <dt>Debuggable</dt><dd className="font-mono">{String(probe.debuggable)}</dd>
            <dt>Root</dt><dd className="font-mono">{String(probe.rootAvailable)}</dd>
          </dl>
          {probe.reason && <div className="inspect-note inspect-note-warning">{probe.reason}</div>}
        </section>
      )}
      {dbs && (
        <section className="inspect-card">
          <div className="inspect-card-head"><span className="inspect-card-title"><Database size={14} />Databases ({dbs.length})</span></div>
          {dbs.length === 0 && <div className="inspect-empty">No databases found.</div>}
          <ul className="inspect-list">
            {dbs.map((d) => (
              <li key={d.name} className="inspect-row">
                <span className="inspect-row-main font-mono">{d.name}</span>
                <span className="inspect-row-tags">
                  {d.sqlite ? <span className="badge badge-neutral">sqlite</span> : null}
                  {d.encrypted ? <span className="badge badge-warning">encrypted</span> : null}
                  {d.sizeBytes != null && <span className="text-dim text-xs">{d.sizeBytes} B</span>}
                </span>
                <button className="btn btn-xs btn-primary" onClick={() => snapshot(d.name)} disabled={loading || !d.sqlite}>
                  Snapshot
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {snapshots.length > 0 && (
        <section className="inspect-card">
          <div className="inspect-card-head"><span className="inspect-card-title">Snapshots</span></div>
          <div className="chip-row">
            {snapshots.map((s) => (
              <button
                key={s.id}
                className={`chip-button ${active?.id === s.id ? 'active' : ''}`}
                onClick={() => setActive(s)}
              >
                {s.databaseName} · {new Date(s.createdAt).toLocaleTimeString()} {s.hadWal ? '· WAL' : ''}
              </button>
            ))}
          </div>
        </section>
      )}
      {active && <DatabaseBrowser snapshot={active} onPush={push} pushing={loading} />}
    </div>
  );
};

// --- Memory ---
const MemoryView: React.FC<{ deviceId: string; pkg: string }> = ({ deviceId, pkg }) => {
  const [data, setData] = useState<MemoryReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [dumpId, setDumpId] = useState<string | null>(null);
  const { setIsArtifactDrawerOpen } = useWorkstation();

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.memoryReport(deviceId, pkg));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };
  // `dumpsys meminfo` is read-only, so the report loads as soon as the tab opens.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, []);

  const dump = async (native: boolean) => {
    if (!window.confirm('A heap dump may contain personal data. Capture it as a downloadable artifact?')) return;
    setLoading(true);
    setError(null);
    setNote(null);
    setDumpId(null);
    try {
      const r = await api.heapDump(deviceId, pkg, native);
      setNote(`Heap dump saved: artifact ${r.artifactId} (${r.sizeBytes.toLocaleString()} bytes).`);
      setDumpId(r.artifactId);
      window.dispatchEvent(new Event(ARTIFACTS_CHANGED_EVENT));
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const rows: [string, number | null][] = data
    ? [
        ['Java heap', data.summary.javaHeapKb],
        ['Native heap', data.summary.nativeHeapKb],
        ['Code', data.summary.codeKb],
        ['Stack', data.summary.stackKb],
        ['Graphics', data.summary.graphicsKb],
        ['Private other', data.summary.privateOtherKb],
        ['System', data.summary.systemKb],
        ['TOTAL PSS', data.summary.totalPssKb],
        ['TOTAL RSS', data.summary.totalRssKb],
      ]
    : [];

  return (
    <div className="inspect-view">
      <div className="inspect-toolbar">
        <p>Live <span className="font-mono">dumpsys meminfo</span> for the app process; heap dumps are saved as artifacts.</p>
        <div className="inspect-toolbar-actions">
          <button className="btn btn-xs btn-secondary" onClick={load} disabled={loading}><RefreshCw size={12} /> {data ? "Reload memory" : "Load memory"}</button>
          <button className="btn btn-xs btn-secondary" onClick={() => dump(false)} disabled={loading}>
            <Flame size={12} /> Java heap dump
          </button>
          <button className="btn btn-xs btn-secondary" onClick={() => dump(true)} disabled={loading}>
            <Flame size={12} /> Native heap dump
          </button>
        </div>
      </div>
      <Busy error={error} loading={loading} />
      {note && (
        <div className="inspect-note inspect-note-success">
          <Download size={12} /> <span>{note}</span>
          {dumpId && <a className="btn btn-secondary btn-xs" href={api.getArtifactDownloadUrl(dumpId)} download><Download size={12} /><span>Download heap dump</span></a>}
          <button type="button" className="btn btn-ghost btn-xs" onClick={() => setIsArtifactDrawerOpen(true)}>Open Artifacts panel</button>
        </div>
      )}
      {data && !data.available && <div className="inspect-note inspect-note-warning">{data.reason}</div>}
      {data && data.available && (
        <dl className="app-fact-grid">
          <div className="app-fact"><dt>PID</dt><dd>{data.summary.pid ?? '—'}</dd></div>
          {rows.map(([label, v]) => (
            <div key={label} className={`app-fact ${label.startsWith('TOTAL') ? 'app-fact-accent' : ''}`}>
              <dt>{label}</dt>
              <dd>{v == null ? '—' : `${v.toLocaleString()} KB`}</dd>
            </div>
          ))}
        </dl>
      )}
      {data?.smapsRollup && (
        <details className="inspect-raw">
          <summary>smaps_rollup (debuggable)</summary>
          <pre className="inspection-output">{data.smapsRollup}</pre>
        </details>
      )}
    </div>
  );
};

// --- Firebase ---
const FirebaseView: React.FC<{ deviceId: string; pkg: string }> = ({ deviceId, pkg }) => {
  const [data, setData] = useState<FirebaseReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [fcm, setFcm] = useState({ serviceAccountEnv: 'GOOGLE_APPLICATION_CREDENTIALS', projectId: '', token: '', title: '', body: '' });

  const guard = async (fn: () => Promise<void>) => {
    setLoading(true);
    setError(null);
    setNote(null);
    try {
      await fn();
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  };

  const scan = () => guard(async () => setData(await api.firebaseReport(deviceId, pkg)));
  const toggle = (enable: boolean) =>
    guard(async () => {
      const r = await api.firebaseDebug(deviceId, pkg, enable);
      setNote(`Debug ${r.enabled ? 'enabled' : 'disabled'}: ${r.commands.join('; ')}`);
    });
  const reverse = () =>
    guard(async () => {
      const r = await api.firebaseEmulatorReverse(deviceId);
      setNote(`Reversed ports: ${r.ports.map((p) => `${p.service}:${p.port}`).join(', ')}`);
    });
  const sendFcm = () =>
    guard(async () => {
      if (!window.confirm('Send a test FCM message via Google? This makes an outbound cloud call using your service account.')) return;
      await api.firebaseFcmSend(fcm);
      setNote('FCM message accepted by Google.');
    });

  return (
    <div className="inspect-view">
      <div className="inspect-toolbar">
        <p>Detect Firebase SDKs and config, toggle Analytics debug mode, and forward emulator suite ports.</p>
        <div className="inspect-toolbar-actions">
          <button className="btn btn-xs btn-secondary" onClick={scan} disabled={loading}>Scan Firebase</button>
          <button className="btn btn-xs btn-secondary" onClick={() => toggle(true)} disabled={loading}>Enable debug</button>
          <button className="btn btn-xs btn-secondary" onClick={() => toggle(false)} disabled={loading}>Disable debug</button>
          <button className="btn btn-xs btn-secondary" onClick={reverse} disabled={loading}>Emulator reverse</button>
        </div>
      </div>
      <Busy error={error} loading={loading} />
      {note && <div className="inspect-note inspect-note-success">{note}</div>}
      {data && (
        <>
          <section className="inspect-card">
            <div className="inspect-card-head">
              <span className="inspect-card-title"><Flame size={14} />Uses Firebase</span>
              <span className={`badge ${data.usesFirebase ? 'badge-success' : 'badge-neutral'}`}>{String(data.usesFirebase)}</span>
            </div>
            {data.sdks.length > 0 && (
              <ul className="inspect-list">
                {data.sdks.map((s) => (
                  <li key={s.artifact} className="inspect-row">
                    <span className="inspect-row-main font-mono">{s.artifact}</span>
                    {s.version && <span className="badge badge-neutral">{s.version}</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="inspect-card">
            <div className="inspect-card-head"><span className="inspect-card-title">Config</span></div>
            <dl className="inspect-kv">
              {Object.entries(data.config).map(([k, v]) => (
                <React.Fragment key={k}><dt>{k}</dt><dd className="font-mono">{(v as string[]).join(', ') || '—'}</dd></React.Fragment>
              ))}
            </dl>
          </section>
          <section className="inspect-card">
            <dl className="inspect-kv">
              <dt>Log tags</dt><dd className="font-mono">{data.logTags.join(', ')}</dd>
              <dt>Emulator ports</dt><dd className="font-mono">{data.emulatorPorts.map((p) => `${p.service}:${p.port}`).join(', ')}</dd>
            </dl>
          </section>
        </>
      )}
      <details className="inspect-raw">
        <summary>Send FCM test message (cloud)</summary>
        <div className="inspect-form">
          <label>Service account env var<input className="input" placeholder="Service account env var" value={fcm.serviceAccountEnv} onChange={(e) => setFcm({ ...fcm, serviceAccountEnv: e.target.value })} /></label>
          <label>Project ID<input className="input" placeholder="Project ID (optional)" value={fcm.projectId} onChange={(e) => setFcm({ ...fcm, projectId: e.target.value })} /></label>
          <label className="inspect-form-wide">Registration token<input className="input" placeholder="Registration token" value={fcm.token} onChange={(e) => setFcm({ ...fcm, token: e.target.value })} /></label>
          <label>Title<input className="input" placeholder="Title" value={fcm.title} onChange={(e) => setFcm({ ...fcm, title: e.target.value })} /></label>
          <label>Body<input className="input" placeholder="Body" value={fcm.body} onChange={(e) => setFcm({ ...fcm, body: e.target.value })} /></label>
          <button className="btn btn-xs btn-danger" onClick={sendFcm} disabled={loading || !fcm.title}>Send via Google</button>
        </div>
      </details>
    </div>
  );
};
