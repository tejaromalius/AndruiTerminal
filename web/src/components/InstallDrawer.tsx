import React, { useState } from 'react';
import { FileCode, Play, Upload, Workflow, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import { parseLauncher, parsePackageList } from '../lib/packageList.js';

interface Props {
  file: File | null;
  onFile: (file: File | null) => void;
  /** Package currently selected in the list; used for the workflow when the install did not reveal a new one. */
  selectedPackage: string;
  onClose: () => void;
  /** Called after a successful install with the newly installed package, when it could be identified. */
  onInstalled: (pkg: string | null) => void;
}

async function packageNames(deviceId: string): Promise<Set<string> | null> {
  try {
    const list = parsePackageList((await api.getStats(deviceId, 'packages')).sections);
    return list ? new Set(list.map((a) => a.name)) : null;
  } catch {
    return null;
  }
}

/** Upload-and-install form for APK/APEX files, with an install-and-launch workflow recipe. */
export const InstallDrawer: React.FC<Props> = ({ file, onFile, selectedPackage, onClose, onInstalled }) => {
  const { selectedDeviceId, findOperation, runOperation, openOperationModal } = useWorkstation();
  const [uploading, setUploading] = useState(false);
  const [replaceExisting, setReplaceExisting] = useState(true);
  const [allowTest, setAllowTest] = useState(false);
  const [allowDowngrade, setAllowDowngrade] = useState(false);
  const [grantPermissions, setGrantPermissions] = useState(false);
  const [streaming, setStreaming] = useState(true);
  const [userId, setUserId] = useState('');
  const [installStatus, setInstallStatus] = useState<string | null>(null);
  const [installed, setInstalled] = useState<string | null>(null);

  const installParams = (apkPath: string) => ({
    apkPath,
    reinstall: replaceExisting,
    allowTest,
    allowDowngrade,
    grantPermissions,
    streaming,
    ...(userId ? { user: userId } : {}),
  });

  const launcherOf = async (pkg: string) => {
    if (!selectedDeviceId) return null;
    try { return parseLauncher((await api.getStats(selectedDeviceId, 'package', pkg)).sections); } catch { return null; }
  };

  const handleInstallSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file) return;
    if (!selectedDeviceId) {
      setInstallStatus('Error: Please select a target device first.');
      return;
    }
    setUploading(true);
    setInstalled(null);
    setInstallStatus('Uploading APK to host artifacts...');
    try {
      const op = findOperation('package.install');
      if (!op) throw new Error('The backend does not expose package installation. Refresh capabilities and operation catalog.');
      const before = await packageNames(selectedDeviceId);
      const artifact = await api.uploadArtifact(file);
      setInstallStatus(`Artifact uploaded (${artifact.id}). Running install...`);
      const job = await runOperation(op.id, installParams(artifact.id), true);
      setInstallStatus('Install job dispatched! Waiting for the result (also visible in the Jobs drawer)...');
      const done = await api.waitForJob(job.id);
      if (done.status !== 'completed' || (done.exitCode ?? 0) !== 0) {
        setInstallStatus(`Install ${done.status}: ${(done.stderr || done.stdout || done.error || '').trim() || `exit ${done.exitCode}`}`);
        return;
      }
      const after = await packageNames(selectedDeviceId);
      const added = before && after ? [...after].filter((p) => !before.has(p)) : [];
      const pkg = added.length === 1 ? added[0] : null;
      setInstalled(pkg);
      onInstalled(pkg);
      setInstallStatus(pkg
        ? `Installed ${pkg}; it is now selected.`
        : 'Install succeeded. The package already existed (or could not be identified), so the selection is unchanged.');
    } catch (err: unknown) {
      setInstallStatus(`Install failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
    }
  };

  const launchNow = async () => {
    if (!installed) return;
    const op = findOperation('activity.start');
    const component = await launcherOf(installed);
    if (op) openOperationModal(op, { component: component ?? `${installed}/` });
  };

  const workflowPackage = installed ?? selectedPackage;
  const saveInstallLaunch = async () => {
    if (!file || !workflowPackage) return;
    setUploading(true);
    try {
      const component = await launcherOf(workflowPackage);
      if (!component) throw new Error(`No launcher activity resolved for ${workflowPackage}; install it first or pick another package.`);
      const artifact = await api.uploadArtifact(file);
      await api.createWorkflow({ name: `Install and launch ${workflowPackage}`, steps: [
        { operationId: 'package.install', parameters: installParams(artifact.id), assertion: { kind: 'exit_code_zero' } },
        { operationId: 'activity.start', parameters: { component }, assertion: { kind: 'exit_code_zero' } },
        { operationId: 'screen.screencap', parameters: {} },
      ] });
      window.dispatchEvent(new Event('andrui:workflows-changed'));
      setInstallStatus(`Install-and-launch workflow saved for ${component} with a screenshot step. Review and run it in Automation.`);
    } catch (error) { setInstallStatus(error instanceof Error ? error.message : String(error)); }
    finally { setUploading(false); }
  };

  return (
    <div className="workspace-panel install-drawer" role="dialog" aria-label="Install package">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Upload size={16} className="text-emerald" />
          <h2 className="panel-title">Install Package (APK/APEX)</h2>
        </div>
        <button type="button" className="btn btn-ghost btn-xs" aria-label="Close install" onClick={onClose}><X size={14} /></button>
      </div>

      <form onSubmit={handleInstallSubmit} className="install-form">
        <div className="install-dropzone">
          <input type="file" accept=".apk,.apex" id="apk-file-input" style={{ display: 'none' }}
            onChange={(e) => onFile(e.target.files?.[0] || null)} />
          <label htmlFor="apk-file-input" className="cursor-pointer">
            <FileCode size={24} className="text-dim mx-auto mb-1" />
            <div className="text-xs text-main font-semibold">{file ? file.name : 'Select or drop .apk / .apex file'}</div>
            {file && <div className="text-xs text-dim font-mono">{(file.size / 1024 / 1024).toFixed(2)} MB</div>}
          </label>
        </div>

        <fieldset className="install-options">
          <legend>Install options</legend>
          {([
            ['Replace (-r)', 'Reinstall over an existing copy, keeping its data', replaceExisting, setReplaceExisting],
            ['Allow Test (-t)', 'Accept APKs marked testOnly', allowTest, setAllowTest],
            ['Downgrade (-d)', 'Allow a lower versionCode', allowDowngrade, setAllowDowngrade],
            ['Grant All (-g)', 'Grant every runtime permission on install', grantPermissions, setGrantPermissions],
            ['Streaming', 'Stream the APK instead of copying it first', streaming, setStreaming],
          ] as const).map(([label, hint, checked, set]) => (
            <label key={label} className={`install-option ${checked ? 'on' : ''}`}>
              <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} />
              <span><span className="install-option-label">{label}</span><span className="install-option-hint">{hint}</span></span>
            </label>
          ))}
          <label className="install-option install-option-user">
            <span><span className="install-option-label">User</span><span className="install-option-hint">Android user id; empty = current</span></span>
            <input type="text" className="input input-xs text-xs font-mono install-user" placeholder="current" value={userId} onChange={(e) => setUserId(e.target.value)} />
          </label>
        </fieldset>

        <div className="install-footer">
          <div className="install-status text-xs font-mono" aria-live="polite">{installStatus ?? (file ? 'Ready to upload and install.' : 'Choose a file to install.')}</div>
          {installed && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={() => void launchNow()}>
              <Play size={13} /><span>Launch {installed}</span>
            </button>
          )}
          <button type="submit" className="btn btn-primary btn-sm" disabled={uploading || !file || !selectedDeviceId}>
            <Upload size={13} /><span>{uploading ? 'Uploading & Installing...' : 'Upload & Install APK'}</span>
          </button>
        </div>
      </form>

      <div className="workflow-recipe">
        <Workflow size={18} className="text-emerald" />
        <div className="workflow-recipe-text">
          <h3 className="panel-title">Install, launch & capture</h3>
          <p className="text-xs text-muted">
            Saves a reviewable workflow that installs this APK, starts the launcher activity of{' '}
            <span className="font-mono">{workflowPackage || '(select or install a package)'}</span> and takes a screenshot.
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" disabled={uploading || !file || !workflowPackage} onClick={() => void saveInstallLaunch()}>
          Save install-and-launch workflow
        </button>
      </div>
    </div>
  );
};
