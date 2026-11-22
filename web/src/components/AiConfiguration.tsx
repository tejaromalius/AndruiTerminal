import { Plug, ShieldCheck, FileText, RefreshCw, FlaskConical } from 'lucide-react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api/client.js';
import type { AgentPolicy, AssistantReport, ModelProvider } from '../types/experience.js';
const split = (value: string) => value.split(',').map(s => s.trim()).filter(Boolean);
export function AiConfiguration() {
  const [provider, setProvider] = useState<ModelProvider>({ endpoint: 'http://127.0.0.1:11434/v1', model: '', apiKeyEnv: '' });
  const [policy, setPolicy] = useState<AgentPolicy>({ paused: false, readOnly: false, deviceIds: [], packages: [], operationPrefixes: [] });
  const [scopeText, setScopeText] = useState({ deviceIds: '', packages: '', operationPrefixes: '' });
  const [probe, setProbe] = useState('text');
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [selectRunningModel, setSelectRunningModel] = useState(false);
  const [reports, setReports] = useState<AssistantReport[]>([]);
  const [testMessage, setTestMessage] = useState('');
  const mountedRef = useRef(true);
  const modelsReqId = useRef(0);
  const detectRunningModels = useCallback(async (target: ModelProvider) => {
    if (!target.endpoint.trim()) return;
    const reqId = ++modelsReqId.current;
    setModelsLoading(true);
    setMessage('');
    try {
      const result = await api.experience<{ models?: { data?: { id: string }[] }; latencyMs?: number }>('/ai/provider/test', 'POST', { probe: 'models', provider: target });
      if (!mountedRef.current || reqId !== modelsReqId.current) return;
      const list = result?.models?.data?.map(m => m.id).filter(Boolean) || [];
      setModels(list);
      if (list.length > 0) {
        setSelectRunningModel(true);
        setTestMessage(`${result?.latencyMs ?? 0} ms. Found ${list.length} running model${list.length === 1 ? '' : 's'}.`);
      } else {
        setSelectRunningModel(false);
        setTestMessage('Connected, but no running models were returned.');
      }
    } catch (e) {
      if (!mountedRef.current || reqId !== modelsReqId.current) return;
      setModels([]);
      setSelectRunningModel(false);
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      if (mountedRef.current && reqId === modelsReqId.current) setModelsLoading(false);
    }
  }, []);
  useEffect(() => {
    mountedRef.current = true;
    let active = true;
    Promise.all([api.experience<ModelProvider>('/ai/provider'), api.experience<AgentPolicy>('/ai/policy'), api.experience<AssistantReport[]>('/ai/reports')]).then(([p, a, r]) => { if (active) { setProvider(p); setPolicy(a); setScopeText({deviceIds:a.deviceIds.join(', '),packages:a.packages.join(', '),operationPrefixes:a.operationPrefixes.join(', ')}); setReports(r); setLoaded(true); } }).catch(e => { if (active) setMessage(String(e)); });
    return () => { active = false; mountedRef.current = false; };
  }, []);
  const run = async (action: () => Promise<void>) => { setBusy(true); setMessage(''); try { await action(); } catch(e) { setMessage(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); } };
  return <div className="ai-configuration-grid">
    <section className="workspace-panel configuration-card model-configuration" aria-labelledby="model-connection-heading">
      <div className="widget-title-bar"><span className="widget-icon"><Plug size={18} /></span><div className="widget-heading"><h2 id="model-connection-heading" className="panel-title">Model connection</h2><p className="widget-caption">Your model, your choice</p></div><span className={`badge ${provider.model ? 'badge-success' : 'badge-neutral'}`}>{provider.model ? 'Configured' : 'Not configured'}</span></div>
      <p className="widget-description">Connect a local or remote OpenAI-compatible model. API keys stay in the server environment; enter only the variable name.</p>
      <div className="widget-form-grid">
        <label className="widget-field field-wide">API base URL<input className="input" disabled={!loaded || busy} value={provider.endpoint} onChange={e => { modelsReqId.current++; setProvider({ ...provider, endpoint: e.target.value }); setModels([]); setModelsLoading(false); setSelectRunningModel(false); setTestMessage(''); }} /></label>
        <div className="model-picker-row field-wide">
          {selectRunningModel && models.length > 0 ? (
            <label className="widget-field">Model<select aria-label="Model" className="select" disabled={!loaded || busy} value={models.includes(provider.model) ? provider.model : ''} onChange={e => setProvider({ ...provider, model: e.target.value })}><option value="">Select a running model ({models.length})</option>{models.map(m => <option key={m} value={m}>{m}</option>)}</select></label>
          ) : (
            <label className="widget-field">Model<input className="input" disabled={!loaded || busy} value={provider.model} onChange={e => setProvider({ ...provider, model: e.target.value })} /></label>
          )}
          {selectRunningModel && models.length > 0 ? (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || !loaded} onClick={() => setSelectRunningModel(false)}>Manual</button>
          ) : (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy || modelsLoading || !loaded || !provider.endpoint.trim()} onClick={() => void detectRunningModels(provider)}>{modelsLoading ? 'Detecting...' : 'Auto detect'}</button>
          )}
        </div>
        <label className="widget-field field-wide">API key environment variable (optional)<input className="input" disabled={!loaded || busy} placeholder="MODEL_API_KEY" value={provider.apiKeyEnv} onChange={e => setProvider({ ...provider, apiKeyEnv: e.target.value })} /></label>
      </div>
      <div className="widget-actions"><button className="btn btn-primary btn-sm" disabled={busy || !loaded} onClick={() => run(async () => { await api.experience('/ai/provider', 'PUT', provider); window.dispatchEvent(new Event('andrui:provider-changed')); setMessage('Model connection saved.'); })}>Save connection</button>
      <button className="btn btn-secondary btn-sm" disabled={busy || !loaded} onClick={() => run(async () => { await api.experience('/ai/provider', 'PUT', provider); window.dispatchEvent(new Event('andrui:provider-changed')); const result = await api.experience<{ models: { data?: { id: string }[] }; latencyMs: number; capabilities: string }>('/ai/provider/test', 'POST', {probe:'models'}); setModels(result.models.data?.map(m => m.id) || []); setTestMessage(`${result.latencyMs} ms. ${result.capabilities}`); })}>Save and test connection</button></div>
      <div className="connection-probe"><label className="widget-field">Probe selected model<select aria-label="Probe selected model" className="select" value={probe} onChange={e => setProbe(e.target.value)}><option value="text">Text response</option><option value="tools">Tool-call response</option><option value="vision">Image input</option></select></label><button className="btn btn-secondary btn-sm" disabled={busy || !loaded || !provider.model} onClick={() => run(async () => { await api.experience('/ai/provider','PUT',provider); window.dispatchEvent(new Event('andrui:provider-changed')); const result = await api.experience<{capabilities:string;latencyMs:number}>('/ai/provider/test','POST',{probe}); setTestMessage(`${result.latencyMs} ms. ${result.capabilities}`); })}><FlaskConical size={14} />Save and probe selected model</button></div>
      {testMessage && <p className="widget-feedback text-muted" role="status">{testMessage}</p>}
    </section>
    <section className="workspace-panel configuration-card permission-configuration" aria-labelledby="agent-permissions-heading">
      <div className="widget-title-bar"><span className="widget-icon"><ShieldCheck size={18} /></span><div className="widget-heading"><h2 id="agent-permissions-heading" className="panel-title">Agent permissions</h2><p className="widget-caption">Keep device access deliberate</p></div><span className={`badge ${policy.paused ? 'badge-warning' : 'badge-neutral'}`}>{policy.paused ? 'Paused' : policy.readOnly ? 'Read only' : 'Approvals on'}</span></div>
      <p className="widget-description">Scope requests from MCP agents. Empty fields allow any value; package scopes block global shell and UI actions.</p>
      <div className="permission-toggles"><label className="widget-check"><input type="checkbox" checked={policy.paused} onChange={e => setPolicy({ ...policy, paused: e.target.checked })} />Paused</label><label className="widget-check"><input type="checkbox" checked={policy.readOnly} onChange={e => setPolicy({ ...policy, readOnly: e.target.checked })} />Read-only operations</label></div>
      <div className="widget-form-stack">{([['deviceIds', 'Permitted device IDs'], ['packages', 'Permitted packages'], ['operationPrefixes', 'Permitted operation prefixes']] as const).map(([key, label]) => <label className="widget-field" key={key}>{label} (comma separated)<input className="input" value={scopeText[key]} onChange={e => setScopeText({ ...scopeText, [key]: e.target.value })} /></label>)}</div>
      <div className="widget-actions"><button className="btn btn-primary btn-sm" disabled={busy || !loaded} onClick={() => run(async () => { setPolicy(await api.experience('/ai/policy', 'PUT', {...policy,deviceIds:split(scopeText.deviceIds),packages:split(scopeText.packages),operationPrefixes:split(scopeText.operationPrefixes)})); setMessage('Agent permissions saved.'); })}>Save permissions</button><button className="btn btn-danger btn-sm" disabled={busy || !loaded} onClick={() => run(async () => { await api.experience('/ai/stop', 'POST'); setPolicy(p => ({ ...p, paused: true })); setMessage('Agent requests paused; pending requests denied and active MCP jobs signalled to cancel. Actions already delivered to a device may finish.'); })}>Stop agent</button></div>
      <p className="widget-footnote">These controls apply to MCP requests. Other processes running as your user retain direct API access.</p>
    </section>
    {message && <p className="alert alert-info configuration-feedback" role="status">{message}</p>}
    <section className="workspace-panel assistant-report-library"><div className="widget-title-bar"><span className="widget-icon"><FileText size={18} /></span><div className="widget-heading"><h2 className="panel-title">Saved assistant reports</h2><p className="widget-caption">Your evidence, answers, and next steps</p></div><button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => run(async () => setReports(await api.experience('/ai/reports')))}><RefreshCw size={13} />Refresh reports</button></div>{reports.length === 0 ? <p className="widget-empty">Your assistant reports will appear here after your first request.</p> : <div className="report-library-list">{reports.map(r => <a key={r.id} href={`/api/v1/reports/${encodeURIComponent(r.id)}`} download className="report-library-item"><FileText size={15} /><span>{r.question}<small>{r.createdAt}</small></span></a>)}</div>}</section>
  </div>;
}
