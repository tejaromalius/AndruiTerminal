import React, { useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { parsePaths } from '../lib/packageList.js';
import {
  Shield,
  Download,
  CheckCircle,
  XCircle,
  Layers,
  Copy,
  Check,
} from 'lucide-react';

export interface PermissionItem {
  name: string;
  granted: boolean;
  type: 'runtime' | 'install' | 'requested';
}

export interface ParsedPackageDump {
  packageName: string;
  versionCode?: string;
  versionName?: string;
  minSdk?: string;
  targetSdk?: string;
  userId?: string;
  codePath?: string;
  permissions: PermissionItem[];
}

export function parsePackageDump(stdout: string): ParsedPackageDump {
  const result: ParsedPackageDump = {
    packageName: '',
    permissions: [],
  };

  let currentSection = '';
  const lines = stdout.split('\n');

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (line.startsWith('Package [')) {
      const match = line.match(/Package \[([^\]]+)\]/);
      if (match) result.packageName = match[1];
    } else if (line.startsWith('userId=')) {
      result.userId = line.replace('userId=', '').split(/\s+/)[0];
    } else if (line.startsWith('codePath=')) {
      result.codePath = line.replace('codePath=', '').trim();
    } else if (line.includes('versionCode=')) {
      const parts = line.split(/\s+/);
      for (const part of parts) {
        if (part.startsWith('versionCode=')) result.versionCode = part.replace('versionCode=', '');
        if (part.startsWith('minSdk=')) result.minSdk = part.replace('minSdk=', '');
        if (part.startsWith('targetSdk=')) result.targetSdk = part.replace('targetSdk=', '');
      }
    } else if (line.startsWith('versionName=')) {
      result.versionName = line.replace('versionName=', '').trim();
    } else if (line.toLowerCase() === 'requested permissions:') {
      currentSection = 'requested';
    } else if (line.toLowerCase() === 'install permissions:') {
      currentSection = 'install';
    } else if (line.toLowerCase() === 'runtime permissions:') {
      currentSection = 'runtime';
    } else if (line.endsWith(':') && !line.includes('permissions')) {
      currentSection = '';
    } else if (currentSection && (line.startsWith('android.permission.') || line.includes('.permission.'))) {
      let name = line;
      let granted = false;
      if (line.includes(':')) {
        const [permName, rest] = line.split(':', 2);
        name = permName.trim();
        granted = rest.includes('granted=true');
      }
      const existing = result.permissions.find((p) => p.name === name);
      if (existing) {
        if (currentSection === 'install' || currentSection === 'runtime') {
          existing.granted = granted;
          existing.type = currentSection;
        }
      } else {
        result.permissions.push({
          name,
          granted,
          type: (currentSection as any) || 'requested',
        });
      }
    }
  }

  return result;
}

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), 0));

const ABIS = new Set(['arm64_v8a', 'armeabi_v7a', 'armeabi', 'x86', 'x86_64']);

/** What an installed split carries, from its file name (base, ABI, density, language or feature module). */
export function splitKind(path: string): string {
  const file = path.slice(path.lastIndexOf('/') + 1).replace(/\.apk$/, '');
  if (file === 'base') return 'base';
  const config = file.match(/^split_config\.(.+)$/)?.[1];
  if (!config) return 'feature';
  if (ABIS.has(config)) return 'abi';
  if (/dpi$/.test(config)) return 'density';
  if (/^[a-z]{2,3}(_[A-Za-z0-9]+)?$/.test(config)) return 'language';
  return 'config';
}

interface ApkToolkitProps {
  /** `dumpsys package` output from the shared package inspection. */
  details: string | null;
  /** `pm path` output from the shared package inspection. */
  paths: string | null;
  view: 'overview' | 'permissions';
  /** uid from the package list, shown when `dumpsys package` omits userId. */
  userId?: number | null;
}

/** Version targets, code path and APK splits, or the permission matrix, of one inspected package. */
export const ApkToolkit: React.FC<ApkToolkitProps> = ({ details: dump, paths, view, userId }) => {
  const { findOperation, openOperationModal } = useWorkstation();
  const [permFilter, setPermFilter] = useState('');
  const [permState, setPermState] = useState<'all' | 'granted' | 'denied'>('all');
  const [copiedCodePath, setCopiedCodePath] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);

  const details = dump ? parsePackageDump(dump) : null;
  const splitPaths = parsePaths(paths);

  const handlePullApk = (remotePath: string) => {
    const op = findOperation('file.pull');
    if (!op) {
      setPullError('Operation file.pull is not available.');
      return;
    }
    // Leave local empty so file.pull stores a managed artifact instead of writing to the server CWD.
    openOperationModal(op, { remote: remotePath });
  };

  if (view === 'permissions') {
    const filteredPermissions = details?.permissions.filter((p) =>
      p.name.toLowerCase().includes(permFilter.toLowerCase()) &&
      (permState === 'all' || p.granted === (permState === 'granted'))
    ) || [];
    const grantedCount = details?.permissions.filter((p) => p.granted).length || 0;
    const totalCount = details?.permissions.length || 0;
    if (!details) return <div className="inspect-empty">Permissions appear once the package inspection completes.</div>;
    return (
      <div className="inspect-view">
        <section className="inspect-card">
          <div className="inspect-card-head">
            <span className="inspect-card-title"><Shield size={14} />Permissions Matrix ({grantedCount}/{totalCount} Granted)</span>
            <input
              type="text"
              className="input input-xs text-xs font-mono perm-filter"
              placeholder="Filter permissions..."
              value={permFilter}
              onChange={(e) => setPermFilter(e.target.value)}
            />
          </div>
          {totalCount > 0 && (
            <div className="perm-meter" aria-hidden="true">
              <div style={{ width: `${(grantedCount / totalCount) * 100}%` }} />
            </div>
          )}
          <div className="chip-row" role="group" aria-label="Grant state">
            {([['all', 'All', totalCount], ['granted', 'Granted', grantedCount], ['denied', 'Denied', totalCount - grantedCount]] as const).map(([id, label, count]) => (
              <button key={id} type="button" className={`chip-button ${permState === id ? 'active' : ''}`} aria-pressed={permState === id} onClick={() => setPermState(id)}>
                <span>{label}</span><span className="text-dim">{count}</span>
              </button>
            ))}
          </div>
        </section>

        {filteredPermissions.length === 0 ? (
          <div className="inspect-empty">No permissions matched</div>
        ) : (
          <ul className="inspect-list perm-list">
            {filteredPermissions.map((perm, idx) => (
              <li key={idx} className="inspect-row">
                {perm.granted ? (
                  <CheckCircle size={14} className="text-emerald flex-shrink-0" />
                ) : (
                  <XCircle size={14} className="text-red-400 flex-shrink-0" />
                )}
                <span className="inspect-row-main font-mono" title={perm.name}>
                  {perm.name.startsWith('android.permission.') ? <><span className="text-dim">android.permission.</span>{perm.name.slice('android.permission.'.length)}</> : perm.name}
                </span>
                <span className="inspect-row-tags">
                  <span className={`badge ${perm.granted ? 'badge-success' : 'badge-danger'}`}>{perm.granted ? 'Granted' : 'Denied'}</span>
                  <span className="badge badge-neutral">{perm.type}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  const splitDirs = new Set(splitPaths.map(dirOf));
  const sharedDir = splitDirs.size === 1 ? [...splitDirs][0] : null;

  return (
    <div className="inspect-view">
      {details ? (
        <>
          <dl className="app-fact-grid">
            <div className="app-fact app-fact-accent"><dt>Version Name</dt><dd>{details.versionName || '—'}</dd></div>
            <div className="app-fact"><dt>Version Code</dt><dd>{details.versionCode || '—'}</dd></div>
            <div className="app-fact"><dt>Target SDK</dt><dd>{details.targetSdk || '—'}</dd></div>
            <div className="app-fact"><dt>Min SDK</dt><dd>{details.minSdk || '—'}</dd></div>
            <div className="app-fact"><dt>User ID</dt><dd>{details.userId || userId || '—'}</dd></div>
          </dl>

          {details.codePath && (
            <section className="inspect-card">
              <div className="inspect-card-head">
                <span className="inspect-card-title">Code Path</span>
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={() => {
                    navigator.clipboard.writeText(details.codePath || '');
                    setCopiedCodePath(true);
                    setTimeout(() => setCopiedCodePath(false), 2000);
                  }}
                  title="Copy code path"
                  aria-label="Copy code path"
                >
                  {copiedCodePath ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
                </button>
              </div>
              <code className="inspect-path">{details.codePath}</code>
            </section>
          )}
        </>
      ) : (
        <div className="inspect-empty">Version targets appear once the package inspection completes.</div>
      )}

      <section className="inspect-card">
        <div className="inspect-card-head">
          <span className="inspect-card-title"><Layers size={14} />APK Splits on Device ({splitPaths.length})</span>
        </div>
        {sharedDir && <div className="inspect-card-sub">in <code className="inspect-path">{sharedDir}</code></div>}
        {pullError && <div className="inspect-note inspect-note-error">{pullError}</div>}
        {splitPaths.length === 0 && <div className="inspect-empty">{paths === null ? 'pm path not reported yet' : 'pm path returned no APK files'}</div>}
        {splitPaths.length > 0 && (
          <ul className="inspect-list">
            {splitPaths.map((path, idx) => (
              <li key={idx} className="inspect-row" title={path}>
                <span className="inspect-row-main">
                  <span className="font-mono">{path.slice(dirOf(path).length + 1)}</span>
                  {!sharedDir && <span className="inspect-row-sub font-mono">{dirOf(path)}</span>}
                </span>
                <span className="inspect-row-tags"><span className="badge badge-neutral">{splitKind(path)}</span></span>
                <button
                  type="button"
                  className="btn btn-secondary btn-xs flex-shrink-0"
                  onClick={() => handlePullApk(path)}
                  title="Configure and pull APK split to host"
                >
                  <Download size={12} />
                  <span>Pull to Host</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
};
