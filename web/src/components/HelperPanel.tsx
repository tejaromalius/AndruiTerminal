import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, ChevronDown, CircleCheck, CircleMinus, CircleX, Cpu, RefreshCw, TriangleAlert } from 'lucide-react';
import {
  automationClient,
  HelperCheckStatus,
  HelperOverallStatus,
  HelperChecksResponse,
  HelperStatus,
} from '../lib/automationClient.js';

const STATUS_ICON: Record<HelperCheckStatus, React.ReactNode> = {
  pass: <CircleCheck size={15} className="text-success" aria-label="pass" />,
  warn: <TriangleAlert size={15} className="text-warning" aria-label="warning" />,
  fail: <CircleX size={15} className="text-danger" aria-label="fail" />,
  skip: <CircleMinus size={15} className="helper-skip-icon" aria-label="not run" />,
};

/** e.g. "4 passed, 1 warning, 5 not run". */
function summarize(checks: HelperChecksResponse['checks']): string {
  const count = (status: HelperCheckStatus) => checks.filter(c => c.status === status).length;
  return ([
    [count('pass'), 'passed'],
    [count('fail'), 'failed'],
    [count('warn'), count('warn') === 1 ? 'warning' : 'warnings'],
    [count('skip'), 'not run'],
  ] as [number, string][])
    .filter(([n]) => n)
    .map(([n, label]) => `${n} ${label}`)
    .join(', ');
}

/** Renders multi-line guidance (one step per line) as a list. */
const Guidance: React.FC<{ text: string; heading: string }> = ({ text, heading }) => {
  const lines = text.split('\n').filter(Boolean);
  return (
    <div className="helper-guidance">
      <span>{heading}</span>
      {lines.length > 1 ? <ul>{lines.map(line => <li key={line}>{line}</li>)}</ul> : <p>{lines[0]}</p>}
    </div>
  );
};

const OVERALL_BADGE: Record<HelperOverallStatus, string> = {
  pass: 'badge-online',
  warn: 'badge-warning',
  fail: 'badge-danger',
  incomplete: 'badge-secondary',
};

function installBadge(status: HelperStatus | null): { label: string; className: string } {
  if (!status) return { label: 'Unknown', className: 'badge-secondary' };
  if (!status.installed) return { label: 'Not installed', className: 'badge-secondary' };
  if (status.upToDate === false) return { label: 'Update available', className: 'badge-warning' };
  return { label: 'Installed', className: 'badge-online' };
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Rejects bodies that are not helper status objects, so a bad response cannot crash the page. */
function checkedStatus(value: HelperStatus): HelperStatus {
  if (!value || typeof value.hostApk !== 'object' || typeof value.installed !== 'boolean') {
    throw new Error('Unexpected helper status response from the server');
  }
  return value;
}

/** Install status, confirmed install, and functional checks for the automation helper on one device. */
export const HelperPanel: React.FC<{ deviceId: string | null; deviceReady: boolean; defaultOpen?: boolean }> = ({ deviceId, deviceReady, defaultOpen = true }) => {
  const [status, setStatus] = useState<HelperStatus | null>(null);
  const [checks, setChecks] = useState<HelperChecksResponse | null>(null);
  const [busy, setBusy] = useState<'status' | 'install' | 'uninstall' | 'checks' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    if (!deviceId || !deviceReady) return;
    setBusy('status');
    setError(null);
    try {
      setStatus(checkedStatus(await automationClient.getHelperStatus(deviceId)));
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  }, [deviceId, deviceReady]);

  useEffect(() => {
    setStatus(null);
    setChecks(null);
    setError(null);
    void loadStatus();
  }, [loadStatus]);

  const install = async () => {
    if (!deviceId) return;
    const message = `Install the AndruiTerminal automation helper on ${deviceId}? This replaces an installed helper and stops a running helper session.`;
    if (!window.confirm(message)) return;
    setBusy('install');
    setError(null);
    try {
      setStatus(checkedStatus(await automationClient.installHelper(deviceId)));
      setChecks(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const uninstall = async () => {
    if (!deviceId) return;
    const message = `Uninstall the AndruiTerminal automation helper from ${deviceId}? This removes the helper package and stops any running helper session.`;
    if (!window.confirm(message)) return;
    setBusy('uninstall');
    setError(null);
    try {
      setStatus(checkedStatus(await automationClient.uninstallHelper(deviceId)));
      setChecks(null);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const runChecks = async () => {
    if (!deviceId) return;
    setBusy('checks');
    setError(null);
    try {
      const result = await automationClient.runHelperChecks(deviceId);
      if (!Array.isArray(result?.checks)) throw new Error('Unexpected helper checks response from the server');
      setStatus(checkedStatus(result.status));
      setChecks(result);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const badge = installBadge(status);
  const installLabel = status?.upToDate === false && status.installed ? 'Update helper'
    : status?.upToDate === true ? 'Reinstall helper' : 'Install helper';
  const installBlocked = status ? !status.hostApk.available : false;
  const matchesText = status?.upToDate === true ? 'Yes'
    : status?.upToDate === false ? (status.installed ? 'No, update available' : 'Not installed')
    : status && !status.hostApk.available ? 'Unknown (no host APK)' : 'Unknown';

  return (
    <details className="workspace-panel widget-disclosure helper-panel" open={defaultOpen}>
      <summary className="widget-summary">
        <span className="widget-icon"><Cpu size={18} /></span>
        <span className="widget-heading">
          <span className="panel-title">Automation helper</span>
          <span className="widget-caption">Install and verify the UI automation helper</span>
        </span>
        {deviceReady && <span className={`badge ${badge.className}`}>{badge.label}</span>}
        <ChevronDown size={16} className="widget-chevron" />
      </summary>
      <div className="widget-body widget-body-compact">
        {!deviceId || !deviceReady ? (
          <p className="text-sm text-muted">Select a ready device to manage its automation helper.</p>
        ) : (
          <>
            {error && <div className="alert alert-danger" role="alert"><AlertCircle size={16} /><span>{error}</span></div>}
            <dl className="helper-facts">
              <div><dt>Host APK</dt><dd className={status?.hostApk.available ? 'font-mono' : ''}>{status ? (status.hostApk.available ? status.hostApk.path : 'Not configured') : '…'}</dd></div>
              <div><dt>Installed version</dt><dd>{status?.installed ? `${status.versionName ?? '?'} (code ${status.versionCode ?? '?'})` : status ? 'Not installed' : '…'}</dd></div>
              <div><dt>Matches host APK</dt><dd>{matchesText}</dd></div>
              <div><dt>Session</dt><dd>{status?.session ? `Running (helper ${status.session.helperVersion})` : 'Not running'}</dd></div>
            </dl>
            <div className="helper-actions">
              <button className="btn btn-ghost btn-sm" onClick={loadStatus} disabled={!deviceReady || busy !== null} aria-label="Refresh helper status" style={{ marginRight: 'auto' }}>
                <RefreshCw size={13} className={busy === 'status' ? 'animate-spin' : ''} />Refresh
              </button>
              <button className="btn btn-primary btn-sm" onClick={install} disabled={busy !== null || !status || installBlocked}
                aria-describedby={installBlocked ? 'helper-install-blocked' : undefined}>
                {busy === 'install' ? 'Installing…' : installLabel}
              </button>
              {status?.installed && (
                <button className="btn btn-secondary btn-sm btn-uninstall-helper" onClick={uninstall} disabled={busy !== null}>
                  {busy === 'uninstall' ? 'Uninstalling…' : 'Uninstall helper'}
                </button>
              )}
              <button className="btn btn-secondary btn-sm" onClick={runChecks} disabled={busy !== null || !status?.installed}>
                {busy === 'checks' ? 'Running checks…' : 'Run checks'}
              </button>
            </div>
            {installBlocked && status && (
              <p id="helper-install-blocked" className="text-sm text-muted">
                Install is unavailable. {status.hostApk.reason} Start AndruiTerminal with <code>./scripts/run-dev.sh</code>, which builds the helper and uses it by default.
              </p>
            )}
            {!checks && !status?.session && status?.installed && (
              <p className="text-sm text-muted">Live checks (responsiveness, hierarchy, screenshot) need a running helper session. Start it on the Layout page.</p>
            )}
            {checks && (
              <div className="helper-checks">
                <p className="text-sm">
                  Overall: <span className={`badge ${OVERALL_BADGE[checks.overall]}`}>{checks.overall}</span>{' '}
                  <span className="text-muted">{summarize(checks.checks)}</span>
                </p>
                <ul aria-label="Helper checks">
                  {checks.checks.map(item => (
                    <li key={item.id} data-status={item.status}>
                      {STATUS_ICON[item.status]}
                      <div>
                        <strong>{item.label}</strong>
                        <p className="text-sm text-muted">{item.detail}</p>
                        {item.guidance && item.status !== 'pass' && <Guidance text={item.guidance} heading={item.status === 'skip' ? 'Next step' : 'How to fix'} />}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </>
        )}
      </div>
    </details>
  );
};
