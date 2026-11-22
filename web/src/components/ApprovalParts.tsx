import React from 'react';
import type { Approval } from '../types/api.js';

const SEVERITY: Record<Approval['severity'], { label: string; className: string; title: string }> = {
  high: { label: 'High', className: 'badge-danger', title: 'Destructive operation; needs your approval' },
  medium: { label: 'Medium', className: 'badge-warning', title: 'Device operation; needs your approval' },
  low: { label: 'Low', className: 'badge-neutral', title: 'Runs without approval' },
};

export const SeverityBadge: React.FC<{ severity: Approval['severity'] }> = ({ severity }) => {
  const s = SEVERITY[severity];
  return (
    <span className={`badge ${s.className}`} title={s.title}>
      {s.label}
    </span>
  );
};

const formatValue = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value));

/** Request parameters as `name = value` pairs, exactly as the agent sent them. */
export const ParamList: React.FC<{ parameters: Record<string, unknown> }> = ({ parameters }) => {
  const entries = Object.entries(parameters ?? {});
  if (entries.length === 0) return <span className="text-dim">none</span>;
  return (
    <dl className="approval-params">
      {entries.map(([name, value]) => (
        <div key={name} className="approval-param-pair">
          <dt>{name}</dt>
          <dd title={typeof value === 'string' ? value : JSON.stringify(value)}>{formatValue(value)}</dd>
        </div>
      ))}
    </dl>
  );
};
