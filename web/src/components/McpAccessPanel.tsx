import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { api } from '../api/client.js';
import { SeverityBadge } from './ApprovalParts.js';
import type { McpAccess } from '../types/api.js';

type Access = 'auto' | 'approval' | 'blocked';
type Filter = 'all' | Access;

const ACCESS: Record<Access, { label: string; className: string }> = {
  auto: { label: 'Runs without approval', className: 'badge-success' },
  approval: { label: 'Needs approval', className: 'badge-warning' },
  blocked: { label: 'Blocked by policy', className: 'badge-danger' },
};

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'auto', label: 'Without approval' },
  { id: 'approval', label: 'Needs approval' },
  { id: 'blocked', label: 'Blocked' },
];

const accessOf = (op: McpAccess['operations'][number]): Access =>
  op.blockedReason ? 'blocked' : op.severity === 'low' ? 'auto' : 'approval';

/** What the MCP tools can reach, loaded when the panel is opened. */
export const McpAccessPanel: React.FC = () => {
  const [access, setAccess] = useState<McpAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('all');

  const load = () => {
    api
      .getMcpAccess()
      .then((value) => {
        setAccess(value);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  const counts = access?.operations.reduce<Record<Access, number>>(
    (acc, op) => ({ ...acc, [accessOf(op)]: acc[accessOf(op)] + 1 }),
    { auto: 0, approval: 0, blocked: 0 }
  );
  const operations = access?.operations.filter((op) => filter === 'all' || accessOf(op) === filter) ?? [];

  return (
    <details
      className="workspace-panel widget-disclosure"
      data-testid="mcp-access"
      onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && load()}
    >
      <summary className="widget-summary">
        <ShieldCheck size={17} className="widget-icon" />
        <span className="widget-heading">
          <span className="panel-title">MCP tools and approvals</span>
          <span className="widget-caption">
            {access && counts
              ? `${access.tools.length} tools · ${counts.auto} operations run without approval · ${counts.approval} need approval · ${counts.blocked} blocked`
              : 'What an agent can do on its own and what waits for you'}
          </span>
        </span>
        <span className="widget-chevron" aria-hidden="true">⌄</span>
      </summary>
      <div className="widget-body">
        {error && <p className="text-sm text-danger">{error}</p>}
        {!access ? (
          !error && <p className="text-sm text-muted">Loading…</p>
        ) : (
          <>
            {access.paused && (
              <div className="alert alert-warning" role="status">
                <span>Agent execution is paused. MCP requests are refused until you resume it.</span>
              </div>
            )}
            <p className="text-xs text-muted">
              Read-only operations run immediately. Every other operation waits in the execution queue until you
              approve it; destructive operations are marked High. Your agent policy can block operations entirely.
              {access.deviceIds.length > 0 && ` Agents may only target: ${access.deviceIds.join(', ')}.`}
            </p>

            <div className="table-container ai-history-container">
              <table className="ai-history" aria-label="MCP tools">
                <thead>
                  <tr>
                    <th className="ai-col-operation">Tool</th>
                    <th className="ai-col-status">Approval</th>
                    <th className="ai-col-params">Description</th>
                  </tr>
                </thead>
                <tbody>
                  {access.tools.map((tool) => (
                    <tr key={tool.name}>
                      <td className="ai-col-operation font-mono">{tool.name}</td>
                      <td className="ai-col-status">
                        {tool.approval === 'never' ? (
                          <span className="badge badge-success">Not needed</span>
                        ) : (
                          <span className="badge badge-neutral">Per operation</span>
                        )}
                      </td>
                      <td className="ai-col-params text-muted">{tool.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="chip-row" role="group" aria-label="Filter operations">
              <span className="chip-row-label">Operations:</span>
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`chip-button${filter === f.id ? ' active' : ''}`}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  {f.id !== 'all' && counts ? ` (${counts[f.id]})` : ` (${access.operations.length})`}
                </button>
              ))}
            </div>

            <div className="table-container ai-history-container" style={{ maxHeight: '420px', overflowY: 'auto' }}>
              <table className="ai-history" aria-label="MCP operation access">
                <thead>
                  <tr>
                    <th className="ai-col-operation">Operation</th>
                    <th className="ai-col-device">Category</th>
                    <th className="ai-col-severity">Severity</th>
                    <th className="ai-col-status">Agent access</th>
                    <th className="ai-col-params">Note</th>
                  </tr>
                </thead>
                <tbody>
                  {operations.map((op) => {
                    const a = ACCESS[accessOf(op)];
                    return (
                      <tr key={op.id}>
                        <td className="ai-col-operation">
                          <span className="font-medium">{op.label}</span>{' '}
                          <span className="text-dim text-xs font-mono">({op.id})</span>
                        </td>
                        <td className="ai-col-device">{op.category}</td>
                        <td className="ai-col-severity">
                          <SeverityBadge severity={op.severity} />
                        </td>
                        <td className="ai-col-status">
                          <span className={`badge ${a.className}`}>{a.label}</span>
                        </td>
                        <td className="ai-col-params text-xs text-muted">
                          {op.blockedReason ?? (op.available ? '' : op.unavailableReason ?? 'Unavailable on this host')}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </details>
  );
};
