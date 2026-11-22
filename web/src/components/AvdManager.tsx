import { Monitor, ChevronDown } from 'lucide-react';
import React, { useState } from 'react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
interface Status { available: boolean; reason?: string; avds: string[]; sessions: { name: string; status: string; exitCode?: number; log: string }[] }
export function AvdManager() {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const { refreshDevices } = useWorkstation();
  const run = async (path = '/emulators', body?: unknown) => {
    setBusy(true); setError('');
    try { setStatus(await api.experience(path, body ? 'POST' : 'GET', body)); await refreshDevices(); }
    catch(e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return <details className="workspace-panel widget-disclosure avd-widget"><summary className="widget-summary"><span className="widget-icon"><Monitor size={18} /></span><span className="widget-heading"><span className="panel-title">Android virtual devices</span><span className="widget-caption">Discover and manage your local emulators</span></span><ChevronDown size={16} className="widget-chevron" /></summary><div className="widget-body widget-body-compact"><div className="widget-actions"><span className="text-xs text-muted" style={{ marginRight: 'auto' }}>Uses local Android SDK emulator; snapshot auto-save disabled.</span><button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => run()}>Discover AVDs and refresh status</button></div>{error && <p className="text-xs text-warning" role="alert">{error}</p>}{status?.reason && <p className="text-xs text-warning">{status.reason}</p>}{status && status.avds.length > 0 && <ul className="avd-list">{status.avds.map(name => { const session = status.sessions.find(s => s.name === name); const running = session?.status === 'running'; return <li key={name} className="avd-row"><Monitor size={15} className="text-muted" /><div className="avd-main"><div className="avd-title">{name.replace(/_/g, ' ')}</div><div className="avd-meta"><span className="font-mono">{name}</span> · {session ? `Process ${session.status}${session.exitCode === undefined || session.exitCode === null ? '' : ` (${session.exitCode})`}` : 'Not launched'}</div>{session && <details><summary className="text-xs">Process output (last 32 KiB)</summary><pre className="text-xs" style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{session.log || 'No output captured.'}</pre></details>}</div>{running ? <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => { if (window.confirm(`Stop emulator ${name}? Unsaved emulator state may be lost.`)) run(`/emulators/${encodeURIComponent(name)}/stop`, { confirmed: true }); }}>Stop</button> : <button className="btn btn-primary btn-sm" disabled={busy} onClick={() => run('/emulators', { name })}>Launch</button>}</li>; })}</ul>}</div></details>;
}

export function EmulatorSnapshots({ deviceId }: { deviceId: string }) {
  const [name, setName] = useState('andrui-checkpoint');
  const [output, setOutput] = useState('');
  const [busy, setBusy] = useState(false);
  const execute = async (action: 'list' | 'save' | 'load') => {
    if (action !== 'list' && !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) { setOutput('Use a snapshot name with letters, digits, periods, underscores or hyphens.'); return; }
    if (action === 'load' && !window.confirm(`Restore snapshot ${name} on ${deviceId}? This replaces the current emulator state.`)) return;
    setBusy(true); setOutput('');
    try { const job = await api.createJob('emu.command', deviceId, { command: `avd snapshot ${action}${action === 'list' ? '' : ` ${name}`}` }); const result = await api.waitForSuccessfulJob(job.id); setOutput(result.stdout || 'Command completed. Verify emulator state.'); }
    catch(e) { setOutput(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <section className="workspace-panel"><h2 className="panel-title">Emulator checkpoints</h2><label className="text-xs">Snapshot name<input className="input" value={name} onChange={e => setName(e.target.value)} /></label><div className="flex flex-wrap gap-2">{(['list','save','load'] as const).map(a => <button className={`btn btn-sm ${a === 'load' ? 'btn-danger' : 'btn-secondary'}`} key={a} disabled={busy} onClick={() => execute(a)}>{a === 'list' ? 'List snapshots' : a === 'save' ? 'Save checkpoint' : 'Restore checkpoint'}</button>)}</div>{output && <pre className="text-xs" style={{whiteSpace:'pre-wrap'}}>{output}</pre>}</section>;
}
