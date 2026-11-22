import React, { useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import {
  Cpu,
  Zap,
  RotateCcw,
  CheckCircle,
  AlertTriangle,
  Layers,
  Search,
  Upload,
  ShieldAlert,
} from 'lucide-react';

export const FastbootPanel: React.FC = () => {
  const { findOperation, runOperation } = useWorkstation();

  // Fastboot device state
  const [discoveredFastbootDevices, setDiscoveredFastbootDevices] = useState<string[]>([]);
  const [scanningDevices, setScanningDevices] = useState(false);

  // Getvar state
  const [getvarQuery, setGetvarQuery] = useState('all');
  const [getvarOutput, setGetvarOutput] = useState<string | null>(null);
  const [getvarLoading, setGetvarLoading] = useState(false);

  // Slot switcher state
  // Unknown until getvar or a successful --set-active reports it.
  const [activeSlot, setActiveSlot] = useState<'a' | 'b' | null>(null);
  const [slotStatus, setSlotStatus] = useState<string | null>(null);
  const [slotLoading, setSlotLoading] = useState(false);

  // Partition flash state
  const [targetPartition, setTargetPartition] = useState('boot');
  const [imagePath, setImagePath] = useState('');
  const [flashConfirmed, setFlashConfirmed] = useState(false);
  const [flashStatus, setFlashStatus] = useState<string | null>(null);
  const [flashLoading, setFlashLoading] = useState(false);

  // Fastboot reboot state
  const [rebootStatus, setRebootStatus] = useState<string | null>(null);

  const handleScanDevices = async () => {
    setScanningDevices(true);
    setDiscoveredFastbootDevices([]);
    try {
      const op = findOperation('fastboot.devices');
      if (!op) throw new Error('Operation fastboot.devices is not available.');

      const pending = await runOperation(op.id, {});
      const job = await api.waitForJob(pending.id);
      const devices = job.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      setDiscoveredFastbootDevices(devices);
    } catch (err: unknown) {
      setDiscoveredFastbootDevices([`Scan failed: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setScanningDevices(false);
    }
  };

  const handleGetvar = async () => {
    setGetvarLoading(true);
    setGetvarOutput(null);
    try {
      const op = findOperation('fastboot.getvar');
      if (!op) throw new Error('Operation fastboot.getvar is not available.');

      const pending = await runOperation(op.id, {
        variable: getvarQuery || 'all',
      });
      const job = await api.waitForJob(pending.id);
      const out = (job.stdout + '\n' + job.stderr).trim();
      setGetvarOutput(out || 'No variables returned');
      const slot = parseGetvar(out).find(([k]) => k === 'current-slot')?.[1];
      if (slot === 'a' || slot === 'b') setActiveSlot(slot);
    } catch (err: unknown) {
      setGetvarOutput(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGetvarLoading(false);
    }
  };

  const handleSetActiveSlot = async (slot: 'a' | 'b') => {
    setSlotLoading(true);
    setSlotStatus(null);
    try {
      const op = findOperation('fastboot.set_active');
      if (!op) throw new Error('Operation fastboot.set_active is not available.');

      const pending = await runOperation(op.id, { slot });
      const job = await api.waitForJob(pending.id);
      if (job.exitCode === 0) {
        setActiveSlot(slot);
        setSlotStatus(`Active slot successfully set to Slot ${slot.toUpperCase()}`);
      } else {
        setSlotStatus(`Slot switch failed: ${job.stderr || job.error}`);
      }
    } catch (err: unknown) {
      setSlotStatus(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setSlotLoading(false);
    }
  };

  const handleFlash = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!flashConfirmed || !imagePath || !targetPartition) return;

    setFlashLoading(true);
    setFlashStatus('Flashing partition...');
    try {
      const op = findOperation('fastboot.flash');
      if (!op) throw new Error('Operation fastboot.flash is not available.');

      const pending = await runOperation(op.id, {
        partition: targetPartition,
        imagePath,
      });
      const job = await api.waitForJob(pending.id);
      if (job.exitCode === 0) {
        setFlashStatus(`Successfully flashed ${targetPartition} with ${imagePath}!`);
        setFlashConfirmed(false);
      } else {
        setFlashStatus(`Flash failed: ${job.stderr || job.error}`);
      }
    } catch (err: unknown) {
      setFlashStatus(`Flash error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFlashLoading(false);
    }
  };

  const handleFastbootReboot = async (target: string) => {
    setRebootStatus(`Rebooting (${target || 'system'})...`);
    try {
      const op = findOperation('fastboot.reboot');
      if (!op) throw new Error('Operation fastboot.reboot is not available.');

      const pending = await runOperation(op.id, { target: target || undefined });
      const job = await api.waitForJob(pending.id);
      if (job.exitCode === 0) {
        setRebootStatus(`Reboot command dispatched successfully.`);
      } else {
        setRebootStatus(`Reboot failed: ${job.stderr || job.error}`);
      }
    } catch (err: unknown) {
      setRebootStatus(`Reboot error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const getvarRows = getvarOutput ? parseGetvar(getvarOutput) : [];
  const fastbootDevices = discoveredFastbootDevices.map((line) => line.split(/\s+/));
  const tone = (text: string) => /fail|error/i.test(text) ? 'inspect-note-error' : /success|dispatched/i.test(text) ? 'inspect-note-success' : '';

  return (
    <section className="workspace-panel fastboot-panel">
      <div className="fastboot-head">
        <div>
          <h2 className="panel-title"><Cpu size={16} className="text-warning" />Bootloader & Flashing Workbench (Fastboot)</h2>
          <p className="text-xs text-dim">Low-level bootloader interactions, A/B slot switching, firmware variable inspection, and raw partition flashing via fastboot protocol.</p>
        </div>
        <span className="badge badge-warning">Hobbyist & Modder Tier</span>
      </div>

      <div className="fastboot-grid">
        <div className="inspect-card">
          <div className="inspect-card-head">
            <span className="inspect-card-title"><Search size={14} />Fastboot Devices</span>
            <button type="button" className="btn btn-secondary btn-xs" disabled={scanningDevices} onClick={handleScanDevices}>
              <Search size={12} /><span>{scanningDevices ? 'Scanning...' : 'Scan Fastboot Devices'}</span>
            </button>
          </div>
          {fastbootDevices.length === 0 ? (
            <div className="inspect-empty">No fastboot devices scanned yet. Reboot a device to the bootloader, then scan.</div>
          ) : (
            <ul className="inspect-list">
              {fastbootDevices.map(([serial, ...rest], i) => (
                <li key={i} className="inspect-row">
                  <span className="inspect-row-main font-mono">{serial}</span>
                  {rest.length > 0 && <span className="badge badge-warning">{rest.join(' ')}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="inspect-card">
          <div className="inspect-card-head"><span className="inspect-card-title"><Zap size={14} />Query Bootloader Variables</span></div>
          <form className="policy-inline" onSubmit={(e) => { e.preventDefault(); void handleGetvar(); }}>
            <input type="text" className="input font-mono" aria-label="Bootloader variable" placeholder="e.g. all, current-slot, unlocked"
              value={getvarQuery} onChange={(e) => setGetvarQuery(e.target.value)} />
            <button type="submit" className="btn btn-secondary btn-sm" disabled={getvarLoading}><span>{getvarLoading ? 'Reading...' : 'getvar'}</span></button>
          </form>
          <div className="chip-row">
            {['all', 'current-slot', 'unlocked', 'product', 'version-bootloader', 'slot-count'].map((v) => (
              <button key={v} type="button" className={`chip-button mono ${getvarQuery === v ? 'active' : ''}`} onClick={() => setGetvarQuery(v)}>{v}</button>
            ))}
          </div>
          {getvarOutput && (getvarRows.length > 0 ? (
            <div className="fastboot-vars">
              <dl className="inspect-kv">
                {getvarRows.map(([k, v], i) => <React.Fragment key={`${k}-${i}`}><dt className="font-mono">{k}</dt><dd className="font-mono">{v || '—'}</dd></React.Fragment>)}
              </dl>
            </div>
          ) : <pre className="inspection-output fastboot-output">{getvarOutput}</pre>)}
        </div>

        <div className="inspect-card">
          <div className="inspect-card-head">
            <span className="inspect-card-title"><Layers size={14} />A/B Active Slot Switcher</span>
            <span className="text-xs text-dim">current: <span className="font-mono">{activeSlot ? activeSlot.toUpperCase() : 'unknown'}</span></span>
          </div>
          <p className="text-xs text-dim">Switch the active boot partition slot on dual-partition devices without rewriting firmware.{!activeSlot && ' Query current-slot to see which one is active.'}</p>
          <div className="action-tiles">
            {(['a', 'b'] as const).map((slot) => (
              <button key={slot} type="button" className={`action-tile ${activeSlot === slot ? 'action-tile-active' : ''}`} disabled={slotLoading} onClick={() => handleSetActiveSlot(slot)}>
                <span className="action-tile-icon font-mono">{slot.toUpperCase()}</span>
                <span className="action-tile-text">
                  <span className="action-tile-label">Set Slot {slot.toUpperCase()}{activeSlot === slot ? ' · active' : ''}</span>
                  <code className="action-tile-cmd">--set-active={slot}</code>
                </span>
              </button>
            ))}
          </div>
          {slotStatus && <div className={`inspect-note ${tone(slotStatus)}`}>{slotStatus}</div>}
        </div>

        <div className="inspect-card">
          <div className="inspect-card-head"><span className="inspect-card-title"><RotateCcw size={14} />Fastboot Reboot Variants</span></div>
          <p className="text-xs text-dim">Exit bootloader mode into standard system, recovery, or fastbootd.</p>
          <div className="action-tiles">
            {([['', 'Reboot System', 'fastboot reboot'], ['bootloader', 'Reboot Bootloader', 'reboot bootloader'], ['recovery', 'Reboot Recovery', 'reboot recovery'], ['fastboot', 'Reboot Fastbootd', 'reboot fastboot']] as const).map(([target, label, cmd]) => (
              <button key={label} type="button" className="action-tile" onClick={() => handleFastbootReboot(target)}>
                <span className="action-tile-icon"><RotateCcw size={14} /></span>
                <span className="action-tile-text"><span className="action-tile-label">{label}</span><code className="action-tile-cmd">{cmd}</code></span>
              </button>
            ))}
          </div>
          {rebootStatus && <div className={`inspect-note ${tone(rebootStatus)}`}>{rebootStatus}</div>}
        </div>
      </div>

      <form onSubmit={handleFlash} className="fastboot-flash">
        <div className="inspect-card-head">
          <span className="inspect-card-title fastboot-flash-title"><ShieldAlert size={14} />Raw Partition Flasher (fastboot flash)</span>
        </div>
        <p className="text-xs fastboot-flash-warning">
          <AlertTriangle size={12} /> Flashing an incompatible kernel, boot image, or vbmeta binary can corrupt device storage or prevent boot. Double confirmation required.
        </p>
        <div className="fastboot-flash-fields">
          <label className="policy-field">
            <span>Target Partition</span>
            <select className="select input font-mono" value={targetPartition} onChange={(e) => setTargetPartition(e.target.value)}>
              {['boot', 'init_boot', 'recovery', 'vbmeta', 'vendor_boot', 'dtbo'].map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
          <label className="policy-field">
            <span>Image File Path on Host</span>
            <input type="text" className="input font-mono" placeholder="/path/to/image.img" value={imagePath} onChange={(e) => setImagePath(e.target.value)} />
          </label>
        </div>
        <div className="fastboot-flash-footer">
          <label className="widget-check">
            <input type="checkbox" checked={flashConfirmed} onChange={(e) => setFlashConfirmed(e.target.checked)} />
            <span>I understand that flashing raw partitions can brick or soft-brick the device</span>
          </label>
          <button type="submit" className="btn btn-danger btn-sm" disabled={flashLoading || !flashConfirmed || !imagePath}>
            <Upload size={13} /><span>{flashLoading ? 'Flashing Partition...' : `Flash ${targetPartition.toUpperCase()} Partition`}</span>
          </button>
        </div>
        {flashStatus && <div className={`inspect-note ${tone(flashStatus)}`}><CheckCircle size={12} />{flashStatus}</div>}
      </form>
    </section>
  );
};

/** `fastboot getvar` lines (`(bootloader) key: value`); keys may themselves contain colons, e.g. `partition-size:boot_a`. */
export function parseGetvar(text: string): [string, string][] {
  return text.split('\n').flatMap((raw) => {
    const line = raw.replace(/^\(bootloader\)\s*/, '').trim();
    const at = line.lastIndexOf(': ');
    if (at <= 0 || /^(Finished|OKAY|FAILED)/.test(line)) return [];
    return [[line.slice(0, at), line.slice(at + 2).trim()] as [string, string]];
  });
}
