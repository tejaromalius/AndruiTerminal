import React, { useState, useMemo } from 'react';
import { QuickStats } from './AssessmentWidgets.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import { Operation } from '../types/api.js';
import { Play, Search, AlertTriangle, ChevronDown, Lock, Cpu } from 'lucide-react';

interface OperationCardListProps {
  category?: string;
  coveragePrefix?: string;
  title?: string;
  description?: string;
}

const operationGroup = (id: string): string => {
  const [family, action = ''] = id.split('.');
  if (family === 'package') {
    if (action.startsWith('install') || action === 'uninstall') return 'Installation & removal';
    if (action === 'list' || action === 'path') return 'Package inspection';
    return 'Package state & data';
  }
  if (family === 'system') {
    if (action === 'reboot' || action.startsWith('rescue') || action === 'sideload') return 'Reboot & recovery';
    if (action === 'backup' || action === 'restore') return 'Backup & restore';
    return 'Root & system configuration';
  }
  const names: Record<string, string> = {
    device: 'Device connections & identity', server: 'ADB server', adb: 'ADB information',
    shell: 'Shell commands', exec: 'Binary input & output', emu: 'Emulator console',
    file: 'Files & transfers', activity: 'Activities & processes', service: 'Services',
    broadcast: 'Broadcasts', instrumentation: 'Instrumentation', debug: 'App debugging',
    permission: 'Runtime permissions', appops: 'App access rules', applinks: 'App links',
    users: 'Users & profiles', dpm: 'Device policy', logcat: 'Device logs',
    diagnostics: 'Diagnostics & inspection', screen: 'Screen capture & recording',
    input: 'Touch, keys & text', power: 'Display power', forward: 'Host to device',
    reverse: 'Device to host', automation: 'Semantic UI actions',
  };
  return names[family] || 'Other operations';
};

export const OperationCardList: React.FC<OperationCardListProps> = ({
  category,
  coveragePrefix,
  title = 'Available Operations',
  description = 'Trigger official ADB host commands and background jobs',
}) => {
  const { operations, openOperationModal, selectedDeviceId } = useWorkstation();
  const [filter, setFilter] = useState('');

  const filteredOps = useMemo(() => {
    return operations.filter((op) => {
      if (coveragePrefix) {
        if (!op.coverageIds?.some((id) => id.startsWith(coveragePrefix))) return false;
      } else if (category && op.category.toLowerCase() !== category.toLowerCase()) return false;

      if (!filter) return true;
      const q = filter.toLowerCase();
      return (
        op.label.toLowerCase().includes(q) ||
        op.id.toLowerCase().includes(q) ||
        op.description.toLowerCase().includes(q) ||
        op.coverageIds?.some((c) => c.toLowerCase().includes(q))
      );
    });
  }, [operations, category, coveragePrefix, filter]);

  const groups = useMemo(() => {
    const result = new Map<string, Operation[]>();
    for (const op of filteredOps) {
      const name = operationGroup(op.id);
      const group = result.get(name) || [];
      group.push(op);
      result.set(name, group);
    }
    return [...result.entries()];
  }, [filteredOps]);

  return (
    <section className="operation-catalog" aria-label={title}>
      <QuickStats items={[
        { label: 'Ready to run', value: filteredOps.filter(op => op.available && (!op.requiresDevice || selectedDeviceId)).length },
        { label: 'Unavailable', value: filteredOps.filter(op => !op.available).length },
        { label: 'Needs device target', value: filteredOps.filter(op => op.available && op.requiresDevice && !selectedDeviceId).length },
      ]} />
      <div className="catalog-heading flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2">
            <Cpu size={16} className="text-emerald" />
            <h2>{title}</h2>
            <span className="text-xs text-dim font-mono">({filteredOps.length})</span>
          </div>
          <p className="text-xs text-dim" style={{ marginTop: '2px' }}>
            {description}
          </p>
        </div>

        {/* Filter input */}
        <div className="catalog-search relative">
          <Search
            size={13}
            className="absolute text-dim"
            style={{ left: '9px', top: '50%', transform: 'translateY(-50%)' }}
          />
          <input
            type="text"
            className="input text-xs"
            style={{ paddingLeft: '30px' }}
            aria-label={`Filter ${title}`}
            placeholder="Filter operations..."
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      {filteredOps.length === 0 ? (
        <div className="empty-state" style={{ padding: '24px' }}>
          <div className="text-xs text-dim">No matching operations. Try another name or clear the filter.</div>
        </div>
      ) : (
        <div className="operation-groups">
          {groups.map(([name, ops], index) => (
            <details className="operation-group" key={`${name}-${filter ? 'search' : 'browse'}`} open={!!filter || index === 0}>
              <summary>
                <ChevronDown size={16} className="group-chevron" />
                <h3>{name}</h3>
                <span className="count-label">{ops.length}</span>
              </summary>
              <div className="operation-grid">
                {ops.map((op: Operation) => {
                  const isTargetBlocked = op.requiresDevice && !selectedDeviceId;

                  return (
                    <div
                      className="operation-card"
                      key={op.id}
                    >
                      <div>
                        <div className="flex items-center justify-between gap-1">
                          <span className="operation-name">
                            {op.label}
                          </span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {op.destructive && (
                              <span className="badge badge-danger text-xs">Destructive</span>
                            )}
                            {op.coverageIds?.[0] && (
                              <span className="badge badge-neutral text-xs font-mono">
                                {op.coverageIds[0]}
                              </span>
                            )}
                          </div>
                        </div>
                        <p
                          className="text-sm text-dim leading-relaxed"
                          style={{ marginTop: '4px' }}
                        >
                          {op.description}
                        </p>
                        {!op.available && (
                          <div className="text-xs text-warning flex items-center gap-1 mt-1 font-mono">
                            <AlertTriangle size={11} />
                            <span className="truncate">{op.unavailableReason || 'Unavailable'}</span>
                          </div>
                        )}
                        {isTargetBlocked && (
                          <div className="text-xs text-dim flex items-center gap-1 mt-1 font-mono">
                            <Lock size={11} /> Requires device target
                          </div>
                        )}
                      </div>

                      <div className="flex items-center justify-between pt-1 border-t border-slate-800">
                        <span className="text-xs text-dim font-mono truncate">
                          {op.fields.length} param{op.fields.length === 1 ? '' : 's'}
                        </span>
                        <button
                          className={`btn btn-sm ${
                            op.destructive ? 'btn-danger' : 'btn-secondary'
                          }`}
                          onClick={() => openOperationModal(op)}
                          disabled={!op.available || isTargetBlocked}
                        >
                          <Play size={11} />
                          <span>Run</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      )}
    </section>
  );
};
