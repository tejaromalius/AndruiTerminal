import React, { useState } from 'react';
import { useDeviceStats, DeviceStatsState, statsPendingReason } from '../lib/useDeviceStats.js';
import { parseAppOps, parsePackage, parseProcesses, sectionText, ProcessRow } from '../lib/inspectionStats.js';
import { useWorkstation } from '../context/WorkstationContext.js';

export function QuickStats({ items }: { items: Array<{ label: string; value: React.ReactNode; detail?: string }> }) {
  return <dl className="assessment-grid">{items.map(item => {
    const isMuted = item.value === 'Unavailable' || item.value === '—' || item.value === 'None';
    return <div className="assessment-card" key={item.label}>
      <dt>{item.label}</dt><dd className={isMuted ? 'stat-value-muted' : undefined}>{item.value}</dd>{item.detail && <p>{item.detail}</p>}
    </div>;
  })}</dl>;
}

export function JobAssessment({ prefixes }: { prefixes: string[] }) {
  const { jobs, selectedDeviceId } = useWorkstation();
  const relevant = jobs.filter(job => job.deviceId === selectedDeviceId && prefixes.some(prefix => job.operationId.startsWith(prefix)));
  return <QuickStats items={[
    { label: 'Active jobs', value: relevant.filter(job => job.status === 'running' || job.status === 'queued').length },
    { label: 'Completed jobs', value: relevant.filter(job => job.status === 'completed').length },
    { label: 'Failed jobs', value: relevant.filter(job => job.status === 'failed').length, detail: 'Loaded job history for the selected device' },
  ]} />;
}

export function CollectionStatus({ state, deviceId }: { state: DeviceStatsState; deviceId: string | null }) {
  return <div className="collection-status" role="status">
    <span>{state.error ? `Unavailable: ${state.error}${state.stats ? ' · Showing stale data' : ''}` :
      state.loading ? 'Reading device…' : state.stats ? `Collected ${new Date(state.stats.collectedAt).toLocaleTimeString()}` :
        deviceId ? 'Not collected yet' : 'No device selected'}</span>
    <button type="button" className="btn btn-secondary btn-sm" disabled={!deviceId || state.loading} onClick={state.refresh}>Refresh</button>
  </div>;
}

export function DeviceStatusWidgets({ scope, deviceId, enabled }: {
  scope: 'screen' | 'system'; deviceId: string | null; enabled: boolean;
}) {
  const state = useDeviceStats(scope, deviceId, 30000, { enabled });
  const sections = state.stats?.sections;
  const read = (key: string) => sectionText(sections?.[key]);
  const uptime = Number(read('uptime')?.split(' ')[0]);
  const items = scope === 'screen' ? [
    { label: 'Display size', value: read('size')?.split('\n').slice(-1)[0]?.replace(/^.*size:\s*/, '') ?? 'Unavailable' },
    { label: 'Display density', value: read('density')?.split('\n').slice(-1)[0]?.replace(/^.*density:\s*/, '') ?? 'Unavailable', detail: 'Device-reported DPI' },
  ] : [
    { label: 'Uptime', value: Number.isFinite(uptime) ? `${Math.floor(uptime / 3600)}h ${Math.floor(uptime / 60) % 60}m` : 'Unavailable' },
    { label: 'Build / boot', value: read('buildType') ?? 'Unavailable', detail: read('bootCompleted') === '1' ? 'Boot completed' : 'Boot completion unconfirmed' },
    { label: 'ADB identity', value: read('root')?.match(/uid=\d+\([^)]*\)/)?.[0] ?? 'Unavailable' },
    { label: 'Verified boot', value: read('verifiedBoot') ?? 'Unavailable', detail: read('bootloaderLocked') === '1' ? 'Bootloader reports locked' : read('bootloaderLocked') === '0' ? 'Bootloader reports unlocked' : 'Lock state unavailable' },
  ];
  return <div><QuickStats items={items} /><CollectionStatus state={state} deviceId={deviceId} /></div>;
}

export function ProcessInspector({ deviceId, enabled }: { deviceId: string | null; enabled: boolean }) {
  const state = useDeviceStats('processes', deviceId, 10000, { enabled });
  const rows = parseProcesses(state.stats?.sections.processes);
  const [sort, setSort] = useState<{ key: keyof ProcessRow; descending: boolean }>({ key: 'rss', descending: true });
  const sorted = rows ? [...rows].sort((a, b) => {
    const left = a[sort.key], right = b[sort.key];
    const result = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return sort.descending ? -result : result;
  }) : [];
  const largest = rows?.reduce<ProcessRow | null>((best, row) => !best || row.rss > best.rss ? row : best, null);
  return <div className="workspace-panel">
    <h2 className="panel-title">Process memory inspection</h2>
    <QuickStats items={[
      { label: 'Processes', value: rows?.length ?? 'Unavailable' },
      { label: 'Reported RSS', value: rows ? `${(rows.reduce((sum, row) => sum + row.rss, 0) / 1024).toFixed(1)} MiB` : 'Unavailable', detail: 'Sum includes shared memory; not total device usage' },
      { label: 'Largest RSS', value: largest ? `${(largest.rss / 1024).toFixed(1)} MiB` : '—', detail: largest?.name },
    ]} />
    <CollectionStatus state={state} deviceId={deviceId} />
    {rows === null ? <p className="text-sm text-muted">{statsPendingReason(deviceId, state) ?? 'Process details unavailable: device output is unsupported or unreadable.'}</p> :
      <div className="assessment-table"><table className="data-table"><thead><tr>
        {([['pid', 'PID'], ['user', 'User'], ['name', 'Process'], ['rss', 'RSS (KiB)'], ['vsz', 'Virtual (KiB)']] as const).map(([key, label]) =>
          <th key={key} aria-sort={sort.key === key ? sort.descending ? 'descending' : 'ascending' : 'none'}>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSort({ key, descending: sort.key === key ? !sort.descending : key === 'rss' || key === 'vsz' })}>{label}</button>
          </th>)}
      </tr></thead><tbody>{sorted.map(row => <tr key={row.pid}><td>{row.pid}</td><td>{row.user}</td><td>{row.name}</td><td>{row.rss}</td><td>{row.vsz}</td></tr>)}</tbody></table>
        {rows.length === 0 && <p>No processes reported.</p>}</div>}
  </div>;
}

const APPOP_MODE_TONE: Record<string, string> = { allow: 'badge-success', foreground: 'badge-info', ignore: 'badge-warning', deny: 'badge-danger', errored: 'badge-danger' };

export function PackageInspection({ packageName, deviceId, enabled, showPermissions = true, state: shared }: {
  packageName: string; deviceId: string | null; enabled: boolean; showPermissions?: boolean;
  /** Inspection owned by the caller; hides the panel's own Inspect button. */
  state?: DeviceStatsState;
}) {
  const valid = packageName.length <= 255 && /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(packageName);
  const own = useDeviceStats('package', deviceId, 0, { packageName, enabled: enabled && valid && !shared, manual: true });
  const state = shared ?? own;
  const permissions = parsePackage(state.stats?.sections.details);
  const appops = parseAppOps(state.stats?.sections.appops);
  return <div className={shared ? 'package-inspection package-inspection-embedded' : 'workspace-panel package-inspection'}>
    {!shared && <>
    <div className="flex items-center justify-between gap-2"><h2 className="panel-title">{showPermissions ? 'Package permission assessment' : 'Package AppOps assessment'}</h2>
      <button type="button" className="btn btn-secondary btn-sm" disabled={!valid || !deviceId || state.loading} onClick={state.refresh}>Inspect package</button></div>
    <p className="text-xs text-muted">{valid ? packageName : 'Enter a valid package name above to inspect permissions and AppOps.'}</p>
    </>}
    {state.stats || state.error || state.loading ? <>
      <QuickStats items={[
        ...(showPermissions ? [
          { label: 'Requested permissions', value: permissions?.requested ?? 'Unavailable' },
          { label: 'Granted entries', value: permissions?.granted ?? 'Unavailable', detail: 'Reported install/runtime entries across users' },
          { label: 'Denied entries', value: permissions?.denied ?? 'Unavailable' },
        ] : []),
        { label: 'AppOps entries', value: appops?.length ?? 'Unavailable', detail: appops ? Object.entries(appops.reduce<Record<string, number>>((counts, row) => ({ ...counts, [row.mode]: (counts[row.mode] ?? 0) + 1 }), {})).map(([mode, count]) => `${mode}: ${count}`).join(' · ') : undefined },
      ]} />
      <CollectionStatus state={state} deviceId={deviceId} />
      {appops && appops.length > 0 && <div className="assessment-table"><table className="data-table"><thead><tr><th>AppOp</th><th>Mode</th></tr></thead><tbody>{appops.map((row, i) => <tr key={`${row.operation}-${i}`}><td className="font-mono">{row.operation}</td><td><span className={`badge ${APPOP_MODE_TONE[row.mode] ?? 'badge-neutral'}`}>{row.mode}</span></td></tr>)}</tbody></table></div>}
      <details><summary>Raw inspection output</summary>{(['details', 'appops'] as const).map(key => <pre key={key} className="inspection-output">{state.stats?.sections[key]?.output ?? 'Unavailable'}</pre>)}</details>
    </> : null}
  </div>;
}
