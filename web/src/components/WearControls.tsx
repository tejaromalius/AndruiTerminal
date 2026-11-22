import React, { useState } from 'react';
import { api } from '../api/client.js';
export function WearControls({ deviceId }: { deviceId: string }) {
  const [rotary, setRotary] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const execute = async (operationId: string, parameters: Record<string, unknown>) => {
    setBusy(true); setMessage('');
    try { const pending = await api.createJob(operationId, deviceId, parameters); const job = await api.waitForSuccessfulJob(pending.id); return job; }
    catch(e) { setMessage(e instanceof Error ? e.message : String(e)); return null; }
    finally { setBusy(false); }
  };
  const check = async () => {
    const job = await execute('shell.exec', {command:'input help'});
    const supported = Boolean(job && /rotaryencoder/.test(job.stdout + job.stderr) && /scroll/.test(job.stdout + job.stderr));
    setRotary(supported);
    setMessage(supported ? 'The device input utility advertises rotary scroll. Verify behavior in the target app.' : 'Rotary scroll is unavailable or could not be verified from input help.');
  };
  return <section className="mt-3"><h3 className="text-sm">Wear OS controls</h3><p className="text-xs text-muted">Check this device before enabling rotary input. Stem-key behavior depends on the watch. Each action targets {deviceId}.</p><div className="flex flex-wrap gap-2"><button className="btn btn-secondary btn-sm" disabled={busy} onClick={check}>Check rotary support</button>{([['Back',4],['Home',3],['Primary stem',264]] as const).map(([label,keycode]) => <button className="btn btn-secondary btn-sm" key={keycode} disabled={busy} onClick={async () => { if (await execute('input.keyevent',{keycode})) setMessage('Input completed; verify the watch screen.'); }}>{label}</button>)}{[-1,1].map(axisValue => <button className="btn btn-secondary btn-sm" key={axisValue} disabled={busy || !rotary} onClick={async () => { if(await execute('input.rotary',{axisValue})) setMessage('Rotary input completed; verify app behavior.'); }}>Rotate {axisValue < 0 ? 'backward' : 'forward'}</button>)}</div>{message && <p className="text-xs text-warning" role="status">{message}</p>}</section>;
}
