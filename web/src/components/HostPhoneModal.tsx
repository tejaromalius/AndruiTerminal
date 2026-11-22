import React, { useEffect, useState } from 'react';
import { Activity, AlertCircle, CheckCircle2, X } from 'lucide-react';
import { api } from '../api/client.js';
import { useWorkstation } from '../context/WorkstationContext.js';

interface HostPhoneModalProps {
  open: boolean;
  onClose: () => void;
}

interface ReverseStatus {
  deviceId: string;
  port: number;
  active: boolean;
  autoReverse: boolean;
  url: string;
}

export const HostPhoneModal: React.FC<HostPhoneModalProps> = ({ open, onClose }) => {
  const { selectedDevice } = useWorkstation();
  const [busy, setBusy] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [reverseStatus, setReverseStatus] = useState<ReverseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launchedUrl, setLaunchedUrl] = useState<string | null>(null);

  const ready = selectedDevice?.state === 'device';

  useEffect(() => {
    if (!open) return;
    setBusy(false);
    setToggling(false);
    setError(null);
    setLaunchedUrl(null);
    setReverseStatus(null);
    if (!selectedDevice || selectedDevice.state !== 'device') return;
    let cancelled = false;
    setLoadingStatus(true);
    api
      .getHostReverseStatus?.(selectedDevice.id)
      ?.then((status) => {
        if (!cancelled && status) setReverseStatus(status);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoadingStatus(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selectedDevice?.id, selectedDevice?.state]);

  if (!open) return null;

  const handleToggleReverse = async () => {
    if (!selectedDevice || !ready || !reverseStatus) return;
    setToggling(true);
    setError(null);
    try {
      const next = await api.setHostReverse(selectedDevice.id, { enabled: !reverseStatus.active });
      setReverseStatus(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };

  const handleToggleAutoReverse = async (checked: boolean) => {
    if (!selectedDevice || !ready) return;
    setToggling(true);
    setError(null);
    try {
      const next = await api.setHostReverse(selectedDevice.id, { autoReverse: checked });
      setReverseStatus(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToggling(false);
    }
  };

  const handleConfirm = async () => {
    if (!selectedDevice || !ready) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.openHostOnPhone(selectedDevice.id, true);
      setLaunchedUrl(res.url);
      setReverseStatus((prev) =>
        prev
          ? { ...prev, active: true, port: res.port, url: res.url }
          : {
              deviceId: selectedDevice.id,
              port: res.port,
              active: true,
              autoReverse: false,
              url: res.url,
            }
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="modal-box"
        role="dialog"
        aria-modal="true"
        aria-label="Open Host Dashboard on Phone"
        style={{ width: '480px', maxWidth: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center justify-between"
          style={{
            padding: '12px 18px',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-panel)',
          }}
        >
          <div className="flex items-center gap-2">
            <Activity size={16} />
            <span className="text-base font-semibold text-main">Open Host Dashboard on Phone</span>
          </div>
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </div>

        <div className="flex flex-col gap-3" style={{ padding: '16px 18px' }}>
          <p className="text-sm text-dim">
            This will forward the local server port over ADB (<code className="font-mono">adb reverse</code>) and open the Host Resource &amp; Process Monitor in your phone&apos;s browser.
          </p>

          {!selectedDevice ? (
            <div className="alert alert-warning" role="alert">
              <AlertCircle size={16} />
              <span>No device selected. Select a connected Android device first.</span>
            </div>
          ) : !ready ? (
            <div className="alert alert-warning" role="alert">
              <AlertCircle size={16} />
              <span>
                Selected device <code className="font-mono">{selectedDevice.id}</code> is in state{' '}
                <strong>{selectedDevice.state}</strong> and is not ready.
              </span>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="text-sm">
                Target device:{' '}
                <strong>{selectedDevice.model || selectedDevice.id}</strong>{' '}
                <code className="font-mono text-dim">({selectedDevice.id})</code>
              </div>

              <div
                className="flex items-center justify-between gap-2"
                style={{
                  padding: '10px 12px',
                  borderRadius: '8px',
                  border: '1px solid var(--border-subtle)',
                  backgroundColor: 'var(--bg-panel)',
                }}
              >
                <div className="flex flex-col gap-1">
                  <div className="flex items-center gap-2 text-sm">
                    <span>Reverse proxy:</span>
                    {loadingStatus ? (
                      <span className="text-dim">Checking…</span>
                    ) : reverseStatus ? (
                      <span
                        className="font-semibold"
                        style={{ color: reverseStatus.active ? '#34d399' : '#fbbf24' }}
                      >
                        {reverseStatus.active ? `Active (tcp:${reverseStatus.port})` : 'Inactive'}
                      </span>
                    ) : (
                      <span className="text-dim">Unknown</span>
                    )}
                  </div>
                  {reverseStatus && (
                    <label className="flex items-center gap-2 text-xs text-dim cursor-pointer">
                      <input
                        type="checkbox"
                        checked={reverseStatus.autoReverse}
                        disabled={toggling || busy}
                        onChange={(e) => void handleToggleAutoReverse(e.target.checked)}
                      />
                      <span>Auto-enable on reconnect (survives network/IP changes)</span>
                    </label>
                  )}
                </div>
                {reverseStatus && (
                  <button
                    type="button"
                    className={`btn btn-sm ${reverseStatus.active ? 'btn-secondary' : 'btn-primary'}`}
                    onClick={() => void handleToggleReverse()}
                    disabled={toggling || busy}
                  >
                    {toggling ? 'Updating…' : reverseStatus.active ? 'Disable' : 'Enable'}
                  </button>
                )}
              </div>
            </div>
          )}

          {error && (
            <div className="alert alert-danger" role="alert">
              <AlertCircle size={16} />
              <span>{error}</span>
            </div>
          )}

          {launchedUrl && (
            <div className="alert alert-success" role="status">
              <CheckCircle2 size={16} />
              <span>
                Opened <code className="font-mono">{launchedUrl}</code> on phone.
              </span>
            </div>
          )}

          <div className="flex justify-between items-center gap-2" style={{ marginTop: '4px' }}>
            <a
              href="/?view=host"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-ghost btn-sm"
            >
              Open locally
            </a>
            <div className="flex gap-2">
              <button type="button" className="btn btn-secondary btn-sm" onClick={onClose} disabled={busy}>
                {launchedUrl ? 'Close' : 'Cancel'}
              </button>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => void handleConfirm()}
                disabled={busy || toggling || !ready}
              >
                {busy ? 'Opening…' : 'Open on phone'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
