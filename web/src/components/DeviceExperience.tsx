import { Smartphone, Tablet, TabletSmartphone, Tv, Watch, MonitorSmartphone, Cpu, ChevronDown, Camera, FileDown, Package, Clapperboard, Images, History, ArrowUpRight, Settings2 } from 'lucide-react';
import { WearControls } from './WearControls.js';
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import type { DeviceProfile } from '../types/experience.js';
import type { Device } from '../types/api.js';

export function useDeviceProfiles() {
  const [profiles, setProfiles] = useState<DeviceProfile[]>([]);
  useEffect(() => {
    let active = true;
    const load = () => api.experience<DeviceProfile[]>('/device-profiles').then(p => { if (active && Array.isArray(p)) setProfiles(p); }).catch(() => {});
    load(); window.addEventListener('andrui:profiles-changed', load);
    return () => { active = false; window.removeEventListener('andrui:profiles-changed', load); };
  }, []);
  return profiles;
}

const kindIcons = { phone: Smartphone, tablet: Tablet, foldable: TabletSmartphone, tv: Tv, watch: Watch, emulator: MonitorSmartphone, other: Cpu };

export function DeviceKindIcon({ device, profiles, size, strokeWidth, className }: { device: Device; profiles: DeviceProfile[]; size?: number; strokeWidth?: number; className?: string }) {
  const kind = profiles.find(p => p.transports.includes(device.id))?.kind
    || (device.id.startsWith('emulator-') || /sdk|emulator/i.test(`${device.model} ${device.product}`) ? 'emulator' : 'phone');
  const Icon = kindIcons[kind as keyof typeof kindIcons] || Smartphone;
  return <Icon size={size} strokeWidth={strokeWidth} className={className} aria-label={kind} />;
}

const guidance: Record<string, string> = {
  device: 'Ready for ADB. If semantic automation is unavailable, check and start the helper below. Screen capture and audio depend on Android and browser capabilities.',
  unauthorized: 'Unlock the device and accept the USB debugging fingerprint prompt. If no prompt appears, verify USB debugging and use a data-capable cable.',
  offline: 'Check the cable or Wi-Fi connection and refresh. Wireless debugging can advertise a new port after reconnecting; use Nearby devices to find the current endpoint.',
  bootloader: 'ADB is unavailable in bootloader mode. Open System & Recovery to scan with fastboot. Do not assume the fastboot serial matches the ADB serial.',
  recovery: 'Recovery exposes a limited ADB surface. Package management and the automation helper may be unavailable.',
  sideload: 'Sideload mode only accepts supported update transfers. Reboot into Android before using shell, screen or automation.',
};
const kindGuidance: Record<string, string> = {
  phone: 'Enable Developer options and USB debugging; unlock the phone to authorize this computer.',
  tablet: 'Use the display selector in Screen for external displays. Verify orientation before replaying coordinate-based input.',
  foldable: 'Capture separate test runs for folded and unfolded layouts. Prefer semantic selectors over fixed coordinates.',
  tv: 'Enable debugging in the TV developer settings and pair over Wi-Fi when supported. Use the D-pad below to test focus navigation.',
  watch: 'Enable ADB debugging and wireless debugging on the watch, then use Nearby devices or its pairing endpoint. Verify phone and watch targets separately.',
  emulator: 'Use the existing emulator simulation panel for GPS, SMS, battery and network conditions. Simulation does not validate physical hardware behavior.',
  other: 'Verify ADB access and helper compatibility for this device before running automation.',
};

export function DeviceExperience({ embedded = false }: { embedded?: boolean } = {}) {
  const { selectedDeviceId, devices, runOperation, setActivePage, refreshDevices, setSelectedDeviceId } = useWorkstation();
  const profiles = useDeviceProfiles();
  const profile = profiles.find(p => p.transports.includes(selectedDeviceId || ''));
  const [draft, setDraft] = useState<DeviceProfile>({ id: '', name: '', kind: 'phone', tags: [], transports: [], notes: '' });
  const [tagsText, setTagsText] = useState('');
  const [transportsText, setTransportsText] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const device = devices.find(d => d.id === selectedDeviceId);
  useEffect(() => {
    setDraft(profile || { id: selectedDeviceId || '', name: device?.model || selectedDeviceId || '', kind: selectedDeviceId?.startsWith('emulator-') ? 'emulator' : 'phone', tags: [], transports: selectedDeviceId ? [selectedDeviceId] : [], notes: '' });
    setTagsText(profile?.tags.join(', ') || '');
    setTransportsText(profile?.transports.join('\n') || selectedDeviceId || '');
  }, [selectedDeviceId, profile]);
  useEffect(() => { setMessage(''); }, [selectedDeviceId]);
  const save = async () => {
    setBusy(true); setMessage('');
    try {
      await api.experience('/device-profiles', 'PUT', [...profiles.filter(p => p.id !== draft.id), {...draft,tags:tagsText.split(',').map(s=>s.trim()).filter(Boolean),transports:transportsText.split('\n').map(s=>s.trim()).filter(Boolean)}]);
      window.dispatchEvent(new Event('andrui:profiles-changed')); setMessage('Profile saved. Transport aliases are linked explicitly.');
    } catch(e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const send = async (keycode?: number) => {
    setBusy(true); setMessage('');
    try { const job = await runOperation(keycode === undefined ? 'input.text' : 'input.keyevent', keycode === undefined ? { text } : { keycode }); await api.waitForSuccessfulJob(job.id); setMessage('Input completed. Verify the result on the device.'); }
    catch(e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  const body = <>
    {!embedded && device && <div className="profile-identity"><div className="profile-avatar"><Smartphone size={26} strokeWidth={1.4} /></div><div><h3>{profile?.name || device.model?.replace(/_/g, ' ') || device.id}</h3><p className="font-mono">{device.id}</p><div className="profile-tags"><span className="badge badge-neutral">{draft.kind}</span>{profile?.tags.map(tag => <span key={tag} className="profile-tag">{tag}</span>)}</div></div><span className={`badge ${device.state === 'device' ? 'badge-success' : 'badge-warning'}`}>{device.state === 'device' ? 'Ready' : device.state}</span></div>}
    <p className="widget-description">{device ? device.state === 'device' ? 'Connected and ready. Manage its profile below, or open the automation helper for semantic actions.' : guidance[device.state] || `State: ${device.state}. Wait for the device to become ready before running tasks.` : 'Connect a device using USB or wireless debugging. Check USB access permissions if it is missing from the list.'}</p>
    {profiles.length > 0 && <details><summary className="text-sm">Saved devices</summary>{profiles.map(p => <div key={p.id} className="mt-2"><p className="text-sm">{p.name} · {p.kind} · {p.tags.join(', ')}</p>{p.transports.map(t => {
      const connected = devices.some(d => d.id === t);
      return connected ? <button key={t} className="btn btn-ghost btn-sm" onClick={() => setSelectedDeviceId(t)}>Select {t}</button> : /:\d+$/.test(t) ? <button key={t} className="btn btn-secondary btn-sm" disabled={busy} onClick={async () => { setBusy(true); try { const job = await api.createJob('device.connect', undefined, {host:t}); await api.waitForSuccessfulJob(job.id); await refreshDevices(); setMessage('Connection command completed; check the refreshed device list.'); } catch(e) { setMessage(String(e)); } finally { setBusy(false); } }}>Reconnect {t}</button> : <span className="text-xs text-muted" key={t}>{t} (disconnected) </span>;
    })}</div>)}</details>}
    {device && <>
      <details className="profile-editor"><summary><Settings2 size={15} /><span>Edit device profile</span><ChevronDown size={14} /></summary><div className="profile-editor-body">
      <div className="widget-form-grid"><label className="text-xs">Device name<input className="input" value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label className="text-xs">Device type<select aria-label="Device type" className="select" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value })}>{Object.keys(kindGuidance).map(k => <option key={k} value={k}>{k}</option>)}</select></label>
      <label className="text-xs">Tags (comma separated)<input className="input" value={tagsText} onChange={e => setTagsText(e.target.value)} /></label>
      <label className="text-xs">Transport IDs for this device (one per line)<textarea aria-label="Transport IDs for this device (one per line)" className="input font-mono" rows={2} value={transportsText} onChange={e => setTransportsText(e.target.value)} /></label></div>
      <label className="text-xs">Notes<textarea className="input" value={draft.notes} onChange={e => setDraft({ ...draft, notes: e.target.value })} /></label>
      <p className="text-xs text-muted">{kindGuidance[draft.kind]}</p>
      <div className="widget-actions"><button className="btn btn-primary btn-sm" disabled={busy || !draft.name.trim()} onClick={save}>Save device profile</button></div></div></details>
      {draft.kind === 'watch' && selectedDeviceId && device.state === 'device' && <WearControls key={selectedDeviceId} deviceId={selectedDeviceId} />}
      {draft.kind === 'tv' && <div className="flex flex-col gap-2 mt-3"><h3 className="text-sm">TV remote</h3><div className="flex flex-wrap gap-2">{([['Up',19],['Left',21],['Select',23],['Right',22],['Down',20],['Back',4],['Home',3],['Play/pause',85]] as const).map(([label, key]) => <button className="btn btn-secondary btn-sm" key={key} disabled={busy || device.state !== 'device'} onClick={() => send(key)}>{label}</button>)}</div><label className="text-xs">Remote text<input className="input" value={text} onChange={e => setText(e.target.value)} /></label><button className="btn btn-secondary btn-sm" disabled={busy || !text || device.state !== 'device'} onClick={() => send()}>Send text</button><button className="btn btn-ghost btn-sm" onClick={() => setActivePage('layout')}>Inspect focus and UI hierarchy</button></div>}
    </>}
    {message && <p className="text-xs text-warning" role="status">{message}</p>}
  </>;
  if (embedded) return <div className="device-bay-doctor">{body}</div>;
  return <section className="workspace-panel device-profile-widget"><div className="widget-title-bar"><span className="widget-icon"><Smartphone size={18} /></span><div className="widget-heading"><h2 className="panel-title">Device profile & connection doctor</h2><p className="widget-caption">Identity, connection, and device-specific controls</p></div></div>
    {body}
  </section>;
}

export function DeviceGallery() {
  const { devices, setSelectedDeviceId } = useWorkstation();
  const profiles = useDeviceProfiles();
  const [roundWatches, setRoundWatches] = useState(false);
  const [shots, setShots] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const urls = useRef<string[]>([]);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); urls.current.forEach(URL.revokeObjectURL); }, []);
  const capture = async () => {
    controller.current?.abort(); const current = new AbortController(); controller.current = current;
    setBusy(true); setErrors({});
    urls.current.forEach(URL.revokeObjectURL); urls.current = []; setShots({});
    // Sequential captures bound host/device load. No background polling or input broadcast.
    for (const device of devices.filter(d => d.state === 'device').slice(0, 8)) {
      if (current.signal.aborted) break;
      try {
        const response = await fetch(`/api/v1/automation/screenshot?deviceId=${encodeURIComponent(device.id)}`, { credentials: 'same-origin', signal: current.signal });
        if (!response.ok) { const value = await response.json(); throw new Error(value.error?.message || `HTTP ${response.status}`); }
        const url = URL.createObjectURL(await response.blob());
        if (current.signal.aborted) { URL.revokeObjectURL(url); break; }
        urls.current.push(url); setShots(s => ({ ...s, [device.id]: url }));
      } catch(e) { if (!current.signal.aborted) setErrors(s => ({ ...s, [device.id]: e instanceof Error ? e.message : String(e) })); }
    }
    if (!current.signal.aborted) setBusy(false);
  };
  const hasOutput = Object.keys(shots).length > 0 || Object.keys(errors).length > 0;
  return <details className="workspace-panel widget-disclosure device-gallery-widget"><summary className="widget-summary"><span className="widget-icon"><Images size={18} /></span><span className="widget-heading"><span className="panel-title">Device gallery</span><span className="widget-caption">A visual check across your connected devices</span></span><ChevronDown size={16} className="widget-chevron" /></summary><div className="widget-body widget-body-compact"><div className="widget-actions"><label className="widget-check"><input type="checkbox" checked={roundWatches} onChange={e => setRoundWatches(e.target.checked)} /> Round watch preview (visual mask)</label><span className="text-xs text-muted" style={{ marginRight: 'auto' }}>{devices.filter(d => d.state === 'device').length} ready · requires running helper</span><button className="btn btn-secondary btn-sm" disabled={busy || !devices.length} onClick={capture}>{busy ? 'Capturing…' : 'Refresh snapshots'}</button></div>{hasOutput && <div className="grid grid-cols-3 gap-3 mt-1">{devices.map(d => <article key={d.id}><button className="btn btn-ghost btn-sm" onClick={() => setSelectedDeviceId(d.id)}>{profiles.find(p => p.transports.includes(d.id))?.name || d.model || d.id}</button><p className="text-xs font-mono">{d.id} · {d.state}</p>{shots[d.id] && <img src={shots[d.id]} alt={`Snapshot of ${d.id}`} style={{ width: '100%', maxHeight: 260, objectFit: 'contain', ...(roundWatches && profiles.find(p => p.transports.includes(d.id))?.kind === 'watch' ? { aspectRatio: '1', borderRadius: '50%', maxWidth: 260 } : {}) }} />}{errors[d.id] && <p className="text-xs text-warning">{errors[d.id]}</p>}</article>)}</div>}</div></details>;
}

interface TimelineEntry { id: string; kind: string; createdAt: string; label: string; status?: string; error?: string; artifactIds: string[]; reportId?: string }
export function DeviceTimeline() {
  const { selectedDeviceId } = useWorkstation();
  const [entries, setEntries] = useState<TimelineEntry[]>([]);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = async (capture = false) => {
    if (!selectedDeviceId) return;
    const current = ++generation.current;
    setBusy(true); setError('');
    try {
      if (capture) await api.experience(`/devices/${encodeURIComponent(selectedDeviceId)}/snapshots`, 'POST');
      const value = await api.experience<TimelineEntry[]>(`/devices/${encodeURIComponent(selectedDeviceId)}/timeline`);
      if (current === generation.current) setEntries(value);
    } catch(e) { if (current === generation.current) setError(String(e)); }
    finally { if (current === generation.current) setBusy(false); }
  };
  useEffect(() => {
    generation.current++; setEntries([]); setError(''); setBusy(false);
    if (open) load();
    return () => { generation.current++; };
  }, [selectedDeviceId, open]);
  const formatTime = (iso: string) => {
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? iso : new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };
  const statusTone = (entry: TimelineEntry) => {
    const s = (entry.status || entry.kind).toLowerCase();
    if (s === 'completed' || s === 'snapshot') return 'badge-success';
    if (s === 'failed' || s === 'cancelled') return 'badge-danger';
    if (s === 'running' || s === 'queued') return 'badge-info';
    return 'badge-neutral';
  };
  return <details className="workspace-panel widget-disclosure timeline-widget" onToggle={e => setOpen(e.currentTarget.open)}><summary className="widget-summary"><span className="widget-icon"><History size={18} /></span><span className="widget-heading"><span className="panel-title">Device session timeline</span><span className="widget-caption">Captures, diagnostics, and recent activity</span></span><ChevronDown size={16} className="widget-chevron" /></summary><div className="widget-body widget-body-compact"><div className="widget-actions"><button className="btn btn-secondary btn-sm" disabled={busy || !selectedDeviceId} onClick={() => load()}>Refresh timeline</button><button className="btn btn-secondary btn-sm" disabled={busy || !selectedDeviceId} onClick={() => load(true)}>Capture diagnostic snapshot</button></div>{error && <p className="text-xs text-warning" role="alert">{error}</p>}<div className="timeline-list" role="region" aria-label="Device activity timeline">{entries.length === 0 && !error ? <p className="timeline-empty">No recorded activity for this device.</p> : entries.map(entry => <div key={`${entry.kind}-${entry.id}`} className="timeline-item"><span className={`timeline-dot ${statusTone(entry)}`} aria-hidden="true" /><div className="timeline-item-main"><span className="timeline-item-label font-mono">{entry.label}</span><span className="timeline-item-time font-mono">{formatTime(entry.createdAt)}</span>{entry.error && <p className="text-xs text-warning mt-1">{entry.error}</p>}</div><div className="timeline-item-actions"><span className={`badge ${statusTone(entry)}`}>{entry.status || entry.kind}</span>{entry.artifactIds.map(id => <a key={id} className="btn btn-ghost btn-sm" href={api.getArtifactDownloadUrl(id)}>Download artifact</a>)}{entry.reportId && <a className="btn btn-ghost btn-sm" href={`/api/v1/reports/${entry.reportId}`} download>Assistant report</a>}</div></div>)}</div></div></details>;
}

export function DeviceTasks() {
  const { selectedDeviceId, selectedDevice, runOperation, setActivePage } = useWorkstation();
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const capture = async (operation: string) => {
    setBusy(true); setMessage('');
    try {
      const pending = await runOperation(operation, {}, false, { showDrawer: true });
      const job = await api.waitForSuccessfulJob(pending.id);
      setMessage('Capture completed. Download it from Jobs or the device timeline.');
      if (job.artifactIds.length) { const link = document.createElement('a'); link.href = api.getArtifactDownloadUrl(job.artifactIds[0]); link.download = ''; link.click(); }
    } catch(e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  };
  return <section className="workspace-panel quick-tasks-widget"><div className="widget-title-bar"><div className="widget-heading"><h2 className="panel-title">Common tasks</h2><p className="widget-caption">A shortcut to your next step</p></div></div><div className="quick-task-grid"><button className="quick-task" disabled={busy || !selectedDeviceId || selectedDevice?.state !== 'device'} onClick={() => capture('screen.screencap')}><Camera size={19} /><span>Capture screenshot<small>Save the current display</small></span><ArrowUpRight size={14} /></button><button className="quick-task" disabled={busy || !selectedDeviceId || selectedDevice?.state !== 'device'} onClick={() => capture('diagnostics.bugreport')}><FileDown size={19} /><span>Download bugreport<small>Collect device diagnostics</small></span><ArrowUpRight size={14} /></button><button className="quick-task" onClick={() => setActivePage('apps')}><Package size={19} /><span>Install & launch an app<small>Manage an application</small></span><ArrowUpRight size={14} /></button><button className="quick-task" onClick={() => setActivePage('screen')}><Clapperboard size={19} /><span>Record a reproduction<small>Open screen and media</small></span><ArrowUpRight size={14} /></button></div>{message && <p className="widget-feedback text-warning" role="status">{message}</p>}</section>;
}
