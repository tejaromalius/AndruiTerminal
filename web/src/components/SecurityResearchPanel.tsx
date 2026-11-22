import React, { useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import {
  Shield,
  Terminal,
  Play,
  RotateCw,
  Share2,
  FileText,
  Key,
} from 'lucide-react';

interface SecurityResearchPanelProps {
  deviceId: string | null;
  isAdbRoot: boolean;
  hasSu: boolean;
  buildType: string | null;
  selinuxMode: string | null;
}

export const SecurityResearchPanel: React.FC<SecurityResearchPanelProps> = ({
  deviceId,
  isAdbRoot,
  hasSu,
  buildType,
  selinuxMode,
}) => {
  const { findOperation, runOperation } = useWorkstation();

  // Frida Server State
  const [fridaPath, setFridaPath] = useState('/data/local/tmp/frida-server');
  const [fridaUseSu, setFridaUseSu] = useState(true);
  const [fridaStatus, setFridaStatus] = useState<string | null>(null);
  const [fridaLoading, setFridaLoading] = useState(false);

  // Certificate State
  const [certPath, setCertPath] = useState('/sdcard/mitmproxy-ca-cert.cer');
  const [certTarget, setCertTarget] = useState<'user' | 'system'>('user');
  const [certStatus, setCertStatus] = useState<string | null>(null);
  const [certLoading, setCertLoading] = useState(false);

  // Port Forward State
  const [portForwardStatus, setPortForwardStatus] = useState<string | null>(null);

  const handleStartFrida = async () => {
    if (!deviceId) return;
    setFridaLoading(true);
    setFridaStatus(null);
    try {
      const op = findOperation('execution.frida_start');
      if (!op) throw new Error('Operation execution.frida_start is not available in catalog.');

      const pending = await runOperation(op.id, {
        path: fridaPath,
        useSu: fridaUseSu,
      });
      const job = await api.waitForJob(pending.id);
      if (job.exitCode === 0) {
        setFridaStatus('Frida server daemon launched successfully!');
      } else {
        setFridaStatus(`Frida start error: ${job.stderr || job.error || 'Non-zero exit'}`);
      }
    } catch (err: unknown) {
      setFridaStatus(`Failed to launch Frida: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFridaLoading(false);
    }
  };

  const handleCheckFridaStatus = async () => {
    if (!deviceId) return;
    setFridaLoading(true);
    setFridaStatus(null);
    try {
      const op = findOperation('execution.frida_status');
      if (!op) throw new Error('Operation execution.frida_status is not available.');

      const pending = await runOperation(op.id, {});
      const job = await api.waitForJob(pending.id);
      setFridaStatus(job.stdout.trim() || 'No output from process check');
    } catch (err: unknown) {
      setFridaStatus(`Status check failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setFridaLoading(false);
    }
  };

  const handleForwardFridaPort = async () => {
    if (!deviceId) return;
    setPortForwardStatus('Configuring port forward tcp:27042 -> tcp:27042...');
    try {
      const op = findOperation('network.forward');
      if (!op) throw new Error('Operation network.forward is not available.');

      const pending = await runOperation(op.id, {
        local: 'tcp:27042',
        remote: 'tcp:27042',
      });
      const job = await api.waitForJob(pending.id);
      if (job.exitCode === 0) {
        setPortForwardStatus('Frida port forward active on localhost:27042');
      } else {
        setPortForwardStatus(`Forward failed: ${job.stderr || job.error}`);
      }
    } catch (err: unknown) {
      setPortForwardStatus(`Forward error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleInstallCert = async () => {
    if (!deviceId || !certPath) return;
    setCertLoading(true);
    setCertStatus(null);
    try {
      const op = findOperation('system.cert_install');
      if (!op) throw new Error('Operation system.cert_install is not available.');

      const pending = await runOperation(op.id, {
        certPath,
        target: certTarget,
      });
      const job = await api.waitForJob(pending.id);
      if (job.exitCode === 0) {
        setCertStatus(
          certTarget === 'system'
            ? 'CA certificate installed to /system/etc/security/cacerts/!'
            : 'Opened Android system credentials dialog for certificate install.'
        );
      } else {
        setCertStatus(`Cert install failed: ${job.stderr || job.error}`);
      }
    } catch (err: unknown) {
      setCertStatus(`Cert install error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setCertLoading(false);
    }
  };

  return (
    <div className="workspace-panel flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Shield size={16} className="text-emerald" />
          <h2 className="panel-title">Security Research & Reverse Engineering Workbench</h2>
        </div>
        <span className="badge badge-subtle text-xs font-mono">Root & Frida Tools</span>
      </div>

      <p className="text-xs text-dim">
        Instrumentation daemon controls, Frida client reverse proxying, CA trust store certificates, and privilege escalation audits.
      </p>

      {/* Privilege Status Indicators */}
      <div className="grid grid-cols-4 gap-2 text-xs">
        <div className="p-2.5 rounded bg-slate-950/80 border border-slate-800 flex flex-col">
          <span className="text-dim text-[10px] uppercase font-bold">adbd Privilege</span>
          <span className={`font-mono font-semibold ${isAdbRoot ? 'text-emerald' : 'text-slate-300'}`}>
            {isAdbRoot ? 'Root (uid 0)' : 'Shell (uid 2000)'}
          </span>
        </div>
        <div className="p-2.5 rounded bg-slate-950/80 border border-slate-800 flex flex-col">
          <span className="text-dim text-[10px] uppercase font-bold">su Binary</span>
          <span className={`font-mono font-semibold ${hasSu ? 'text-emerald' : 'text-slate-400'}`}>
            {hasSu ? 'Present (su available)' : 'Not detected'}
          </span>
        </div>
        <div className="p-2.5 rounded bg-slate-950/80 border border-slate-800 flex flex-col">
          <span className="text-dim text-[10px] uppercase font-bold">Build Type</span>
          <span className="font-mono text-cyan-400 font-semibold">{buildType || 'user'}</span>
        </div>
        <div className="p-2.5 rounded bg-slate-950/80 border border-slate-800 flex flex-col">
          <span className="text-dim text-[10px] uppercase font-bold">SELinux</span>
          <span className={`font-mono font-semibold ${selinuxMode === 'Permissive' ? 'text-amber-400' : 'text-slate-300'}`}>
            {selinuxMode || 'Enforcing'}
          </span>
        </div>
      </div>

      {/* Frida Server & Certificate Management Grid */}
      <div className="grid grid-cols-2 gap-4 pt-2 border-t border-slate-800">
        {/* Frida Server Controls */}
        <div className="flex flex-col gap-2 p-3 bg-slate-900/50 rounded border border-slate-800">
          <div className="flex items-center gap-1.5 font-bold text-xs text-main">
            <Terminal size={14} className="text-purple-400" />
            <span>Frida Server Daemon</span>
          </div>

          <label className="text-xs text-dim">Binary Path on Target</label>
          <input
            type="text"
            className="input text-xs font-mono"
            value={fridaPath}
            onChange={(e) => setFridaPath(e.target.value)}
          />

          <label className="flex items-center gap-1.5 text-xs text-dim cursor-pointer">
            <input
              type="checkbox"
              checked={fridaUseSu}
              onChange={(e) => setFridaUseSu(e.target.checked)}
            />
            <span>Execute via root (su -c)</span>
          </label>

          <div className="flex gap-2 mt-1">
            <button
              type="button"
              className="btn btn-primary btn-sm flex-1"
              disabled={fridaLoading || !deviceId}
              onClick={handleStartFrida}
            >
              <Play size={12} />
              <span>{fridaLoading ? 'Starting...' : 'Launch Frida'}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary btn-sm flex-1"
              disabled={fridaLoading || !deviceId}
              onClick={handleCheckFridaStatus}
            >
              <RotateCw size={12} />
              <span>Process Status</span>
            </button>
          </div>

          <button
            type="button"
            className="btn btn-ghost btn-sm text-xs mt-1"
            disabled={!deviceId}
            onClick={handleForwardFridaPort}
            title="forward tcp:27042 -> tcp:27042"
          >
            <Share2 size={12} />
            <span>Forward Port 27042 (Host)</span>
          </button>

          {fridaStatus && (
            <div className="text-xs font-mono p-2 rounded bg-slate-950 border border-slate-800 text-slate-300 break-words">
              {fridaStatus}
            </div>
          )}
          {portForwardStatus && (
            <div className="text-xs font-mono text-emerald p-1">{portForwardStatus}</div>
          )}
        </div>

        {/* Certificate Installation Helper */}
        <div className="flex flex-col gap-2 p-3 bg-slate-900/50 rounded border border-slate-800">
          <div className="flex items-center gap-1.5 font-bold text-xs text-main">
            <Key size={14} className="text-cyan-400" />
            <span>CA Certificate Trust Installer</span>
          </div>

          <label className="text-xs text-dim">Certificate Path on Device</label>
          <input
            type="text"
            className="input text-xs font-mono"
            placeholder="/sdcard/mitmproxy-ca-cert.cer"
            value={certPath}
            onChange={(e) => setCertPath(e.target.value)}
          />

          <label className="text-xs text-dim">Target Credential Store</label>
          <select
            className="select text-xs font-mono"
            value={certTarget}
            onChange={(e) => setCertTarget(e.target.value as 'user' | 'system')}
          >
            <option value="user">User Store (System Credentials Intent - No Root)</option>
            <option value="system">System Store (/system/etc/security/cacerts/ - Requires Root)</option>
          </select>

          <button
            type="button"
            className="btn btn-secondary btn-sm mt-2"
            disabled={certLoading || !certPath || !deviceId}
            onClick={handleInstallCert}
          >
            <FileText size={12} />
            <span>{certLoading ? 'Installing...' : 'Install CA Certificate'}</span>
          </button>

          {certStatus && (
            <div className="text-xs font-mono p-2 rounded bg-slate-950 border border-slate-800 text-slate-300 break-words">
              {certStatus}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
