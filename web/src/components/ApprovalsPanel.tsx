import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { api } from '../api/client.js';
import type { Approval } from '../types/api.js';
import { ParamList, SeverityBadge } from './ApprovalParts.js';

/** Pending agent (MCP) requests that need the user's decision before a job starts. */
export const ApprovalsPanel: React.FC<{
  deviceName?: (deviceId?: string) => string;
  /** Shown instead of rendering nothing when no request is pending. */
  emptyText?: string;
  /** Whether to show a browser confirmation dialog before approving. */
  confirmOnApprove?: boolean;
}> = ({ deviceName, emptyText, confirmOnApprove = true }) => {
  const [pending, setPending] = useState<Approval[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api
      .getApprovals()
      .then((list) => setPending(list.filter((a) => a.status === 'pending')))
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    // Events arrive over the /events WebSocket; polling covers reconnects and expiry.
    const interval = setInterval(refresh, 10000);
    window.addEventListener('andrui:approval', refresh);
    return () => {
      clearInterval(interval);
      window.removeEventListener('andrui:approval', refresh);
    };
  }, [refresh]);

  const decide = async (approval: Approval, approve: boolean) => {
    if (approve && confirmOnApprove) {
      const target = approval.deviceId ? deviceName?.(approval.deviceId) ?? approval.deviceId : 'host';
      const message =
        `${approval.requester} requests ${approval.destructive ? 'a DESTRUCTIVE operation' : 'an operation'} on ${target}:\n\n` +
        `${approval.operationLabel}\n${approval.preview.display}\n\nRun it?`;
      if (!window.confirm(message)) return;
    }
    setBusyId(approval.id);
    setError(null);
    try {
      await (approve ? api.approveApproval(approval.id) : api.denyApproval(approval.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
      refresh();
    }
  };

  if (pending.length === 0 && !error) {
    return emptyText ? <p className="text-sm text-muted">{emptyText}</p> : null;
  }

  return (
    <div className="approvals-panel" role="region" aria-label="Pending agent approvals">
      {error && <div className="text-xs text-danger">{error}</div>}
      {pending.map((approval) => (
        <div
          key={approval.id}
          className={`approval-row ${approval.destructive ? 'approval-row-danger' : 'approval-row-warning'}`}
        >
          <div className="approval-icon">
            <ShieldAlert size={16} className={approval.destructive ? 'text-danger' : 'text-warning'} />
          </div>
          <div className="approval-main">
            <div className="approval-title">
              <span>{approval.operationLabel}</span>
              <SeverityBadge severity={approval.severity} />
              <span className="text-dim text-xs">
                from {approval.requester} ·{' '}
                {approval.deviceId ? deviceName?.(approval.deviceId) ?? approval.deviceId : 'Host'}
              </span>
            </div>
            <code className="approval-command" title={approval.preview.display}>
              {approval.preview.display}
            </code>
            <ParamList parameters={approval.parameters} />
          </div>
          <div className="approval-actions">
            <button
              className={`btn ${approval.destructive ? 'btn-danger' : 'btn-primary'} btn-sm`}
              disabled={busyId === approval.id}
              onClick={() => decide(approval, true)}
            >
              <Check size={13} />
              <span>Approve</span>
            </button>
            <button
              className="btn btn-secondary btn-sm"
              disabled={busyId === approval.id}
              onClick={() => decide(approval, false)}
            >
              <X size={13} />
              <span>Deny</span>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
