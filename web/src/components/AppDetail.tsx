import React, { useEffect, useState } from 'react';
import { Ban, Check, Copy, Cpu, Database, Download, Eraser, Flame, Layers, ListTree, Pause, Play, Power, RefreshCw, Shield, ShieldPlus, Square, Terminal, Trash2, Zap } from 'lucide-react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { useDeviceStats } from '../lib/useDeviceStats.js';
import { AppEntry, parseActivities, parseLauncher } from '../lib/packageList.js';
import { ApkToolkit, parsePackageDump } from './ApkToolkit.js';
import { PackageInspection } from './AssessmentWidgets.js';
import { AppInspector } from './AppInspector.js';

export type DetailTab = 'overview' | 'permissions' | 'appops' | 'signing' | 'databases' | 'memory' | 'firebase' | 'raw';

const TABS: [DetailTab, string, typeof Shield][] = [
  ['overview', 'Overview', Layers],
  ['permissions', 'Permissions', Shield],
  ['appops', 'AppOps', ListTree],
  ['signing', 'Signing', Shield],
  ['databases', 'Data', Database],
  ['memory', 'Memory', Cpu],
  ['firebase', 'Firebase', Flame],
  ['raw', 'Raw', Terminal],
];

const VALID = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const CUSTOM = '__custom__';

/** `pkg/pkg.ui.Main` → `.ui.Main`, the short form `am start` accepts. */
const shortClass = (component: string, pkg: string) => {
  const cls = component.split('/')[1] ?? component;
  return cls.startsWith(`${pkg}.`) ? cls.slice(pkg.length) : cls;
};

export const CopyButton: React.FC<{ value: string; label: string }> = ({ value, label }) => {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-ghost btn-xs" title={`Copy ${label}`} aria-label={`Copy ${label}`}
      onClick={() => { void navigator.clipboard?.writeText(value); setDone(true); setTimeout(() => setDone(false), 1500); }}>
      {done ? <Check size={12} className="text-emerald" /> : <Copy size={12} />}
    </button>
  );
};

interface Props {
  deviceId: string | null;
  pkg: string;
  entry: AppEntry | null;
  tab: DetailTab;
  onTab: (tab: DetailTab) => void;
}

/** Header, lifecycle actions and inspection tabs for one selected package. */
export const AppDetail: React.FC<Props> = ({ deviceId, pkg, entry, tab, onTab }) => {
  const { findOperation, openOperationModal } = useWorkstation();
  const valid = pkg.length <= 255 && VALID.test(pkg);
  const inspection = useDeviceStats('package', deviceId, 0, { packageName: pkg, enabled: valid, manual: true });
  const [activity, setActivity] = useState('');
  const [custom, setCustom] = useState('');

  // One inspection per selection; every tab reads from it.
  useEffect(() => {
    if (deviceId && valid) inspection.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, pkg, valid]);

  const sections = inspection.stats?.sections;
  const details = sections?.details?.exitCode === 0 ? sections.details.output : null;
  const dump = details ? parsePackageDump(details) : null;
  const launcher = parseLauncher(sections);
  const activities = parseActivities(details, pkg);
  const component = activity === CUSTOM ? (custom.includes('/') ? custom : custom ? `${pkg}/${custom}` : '') : activity || launcher || '';

  const open = (operationId: string, params: Record<string, unknown>) => {
    const op = findOperation(operationId);
    if (op) openOperationModal(op, params);
  };
  const disabled = !deviceId || !valid;
  const uid = entry?.uid ?? (dump?.userId ? Number(dump.userId) : null);

  return (
    <div className="workspace-panel app-detail">
      <div className="app-detail-head">
        <div className="app-detail-identity">
          <div className="app-detail-title">
            <h2 className="panel-title font-mono" title={pkg}>{pkg}</h2>
            <CopyButton value={pkg} label="package name" />
          </div>
          <div className="app-detail-badges">
            {entry?.system !== null && entry?.system !== undefined && <span className="badge badge-neutral">{entry.system ? 'system' : 'user'}</span>}
            {entry?.disabled !== null && entry?.disabled !== undefined && <span className={`badge ${entry.disabled ? 'badge-warning' : 'badge-success'}`}>{entry.disabled ? 'disabled' : 'enabled'}</span>}
            {entry?.running && <span className="badge badge-info">running</span>}
          </div>
        </div>
        <dl className="app-detail-factsheet">
          <div><dt>Version</dt><dd className="font-mono"><span>{dump?.versionName ? `v${dump.versionName}` : 'version —'} ({dump?.versionCode ?? entry?.versionCode ?? '—'})</span></dd></div>
          <div><dt>UID</dt><dd className="font-mono"><span>{uid ?? '—'}</span>{uid !== null && <CopyButton value={String(uid)} label="uid" />}</dd></div>
          {entry?.installer && <div><dt>Installer</dt><dd className="font-mono" title={entry.installer}>{entry.installer}</dd></div>}
          {!entry && <div><dt>Package list</dt><dd className="text-dim">not in the device package list</dd></div>}
        </dl>

        <div className="app-detail-actions">
          <div className="app-launch">
            <button type="button" className="btn btn-primary btn-sm" disabled={disabled || !component}
              title={component ? `Launch ${component} (am start)` : 'No launcher activity; pick one or enter a custom component'}
              onClick={() => open('activity.start', { component })}>
              <Play size={13} /><span>Launch</span>
            </button>
            <select className="input text-xs font-mono" aria-label="Activity to launch" value={activity} onChange={(e) => setActivity(e.target.value)} disabled={disabled}>
              <option value="">{launcher ? `Launcher: ${shortClass(launcher, pkg)}` : inspection.loading ? 'Resolving launcher…' : activities.length ? 'No launcher — pick an activity' : 'No launcher activity'}</option>
              {activities.filter((a) => a !== launcher).map((a) => <option key={a} value={a}>{shortClass(a, pkg)}</option>)}
              <option value={CUSTOM}>Custom component…</option>
            </select>
          </div>
          {activity === CUSTOM && (
            <input type="text" className="input text-xs font-mono app-launch-custom" aria-label="Custom activity" placeholder=".MainActivity or pkg/.Activity"
              value={custom} onChange={(e) => setCustom(e.target.value)} />
          )}
          <div className="app-detail-run">
            <button type="button" className="btn btn-secondary btn-sm" disabled={disabled} title="Force Stop (am force-stop)" onClick={() => open('activity.force_stop', { package: pkg })}>
              <Square size={13} className="text-warning" /><span>Force Stop</span>
            </button>
            <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || inspection.loading} onClick={inspection.refresh} title="Re-run dumpsys package, appops, pm path and launcher resolution">
              <RefreshCw size={13} className={inspection.loading ? 'animate-spin' : undefined} /><span>{inspection.loading ? 'Inspecting…' : 'Re-inspect'}</span>
            </button>
          </div>
        </div>
        <div className="app-detail-ops app-op-groups" role="group" aria-label="Package operations">
          <div className="app-op-group">
            <span className="app-op-group-label">Package</span>
            <div className="app-op-buttons">
              <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} title="Get APK Path (pm path)" onClick={() => open('package.path', { package: pkg })}><Download size={12} /><span>APK Path</span></button>
              <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} title="Grant a runtime permission (pm grant)" onClick={() => open('permission.grant', { package: pkg })}><ShieldPlus size={12} /><span>Grant permission…</span></button>
              <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} title={entry?.disabled ? 'Enable package (pm enable)' : 'Disable package (pm disable-user)'} onClick={() => open(entry?.disabled ? 'package.enable' : 'package.disable', { target: pkg })}>{entry?.disabled ? <Power size={12} /> : <Ban size={12} />}<span>{entry?.disabled ? 'Enable' : 'Disable'}</span></button>
            </div>
          </div>
          <div className="app-op-group">
            <span className="app-op-group-label">Processes</span>
            <div className="app-op-buttons">
              <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} title="Suspend package (pm suspend)" onClick={() => open('package.suspend', { package: pkg })}><Pause size={12} /><span>Suspend</span></button>
              <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} title="Unsuspend package (pm unsuspend)" onClick={() => open('package.unsuspend', { package: pkg })}><Play size={12} /><span>Unsuspend</span></button>
              <button type="button" className="btn btn-secondary btn-xs" disabled={disabled} title="Kill background processes (am kill)" onClick={() => open('activity.kill', { package: pkg })}><Zap size={12} /><span>Kill background</span></button>
            </div>
          </div>
          <div className="app-op-group app-op-group-danger">
            <span className="app-op-group-label">Destructive</span>
            <div className="app-op-buttons">
              <button type="button" className="btn btn-danger btn-xs" disabled={disabled} title="Clear Data (pm clear - Destructive)" onClick={() => open('package.clear', { package: pkg })}><Eraser size={12} /><span>Clear Data</span></button>
              <button type="button" className="btn btn-danger btn-xs" disabled={disabled} title="Uninstall Package (pm uninstall - Destructive)" onClick={() => open('package.uninstall', { package: pkg, keepData: false })}><Trash2 size={12} /><span>Uninstall</span></button>
            </div>
          </div>
        </div>
        {!valid && <div className="inspect-note inspect-note-error">“{pkg}” is not a valid package identifier.</div>}
        {inspection.error && <div className="inspect-note inspect-note-error">Inspection failed: {inspection.error}</div>}
      </div>

      <div className="app-detail-tabs" role="tablist" aria-label="Package details">
        {TABS.map(([id, label, Icon]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className="app-detail-tab" onClick={() => onTab(id)}>
            <Icon size={13} /><span>{label}</span>
          </button>
        ))}
      </div>

      <div role="tabpanel" className="app-detail-body">
        {tab === 'overview' && <ApkToolkit view="overview" details={details} userId={uid} paths={sections?.paths?.exitCode === 0 ? sections.paths.output : null} />}
        {tab === 'permissions' && <ApkToolkit view="permissions" details={details} paths={null} />}
        {tab === 'appops' && <PackageInspection packageName={pkg} deviceId={deviceId} enabled={valid} showPermissions={false} state={inspection} />}
        {(tab === 'signing' || tab === 'databases' || tab === 'memory' || tab === 'firebase') && <AppInspector deviceId={deviceId} packageName={valid ? pkg : ''} section={tab} />}
        {tab === 'raw' && (
          <div className="inspect-view">
            {(['details', 'appops', 'paths', 'launcher'] as const).map((key) => (
              <details key={key} className="inspect-raw" open={key === 'details'}>
                <summary>
                  <span className="font-mono">{key}</span>
                  {sections?.[key] && <span className={`badge ${sections[key].exitCode === 0 ? 'badge-success' : 'badge-danger'}`}>exit {sections[key].exitCode}</span>}
                </summary>
                <pre className="inspection-output">{sections?.[key]?.output ?? 'Unavailable'}</pre>
              </details>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
