import { CollectionStatus } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid, TabKpiItem } from '../components/TabKpiGrid.js';
import { useDeviceStats, statsPendingReason, sampleSeconds } from '../lib/useDeviceStats.js';
import { firstLine, formatRate, parseForwardRules, parseForwards, parseLineCount, parseNetDev, parseReverseRules, parseTcp } from '../lib/deviceStats.js';
import { WorkbenchItem, WorkbenchList } from '../components/WorkbenchList.js';
import { CopyButton } from '../components/AppDetail.js';
import {
  Network,
  ArrowRightLeft,
  Plus,
  Trash2,
  RefreshCw,
  AlertCircle,
  Radio,
  Share2,
  ArrowRight,
} from 'lucide-react';

const RULE_FILTERS = [{ id: 'all', label: 'All' }, { id: 'forward', label: 'Forward (host → device)' }, { id: 'reverse', label: 'Reverse (device → host)' }];

export const NetworkPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('network', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    openOperationModal,
    runOperation,
  } = useWorkstation();

  const net = useDeviceStats('network', selectedDeviceId, 5000, { enabled: activeTab !== 'operations' });
  const pending = statsPendingReason(selectedDeviceId, net);
  const forwards = selectedDeviceId ? parseForwards(net.stats?.sections.forwards?.output ?? null, selectedDeviceId) : null;
  const reverses = parseLineCount(net.stats?.sections.reverses);
  const tcp = parseTcp(net.stats?.sections.tcp?.output ?? null);
  const netNow = parseNetDev(net.stats?.sections.netdev?.output ?? null);
  const netPrev = parseNetDev(net.previous?.sections.netdev?.output ?? null);
  const dt = sampleSeconds(net);
  const rates =
    netNow && netPrev && dt && netNow.rxBytes >= netPrev.rxBytes && netNow.txBytes >= netPrev.txBytes
      ? { rx: (netNow.rxBytes - netPrev.rxBytes) / dt, tx: (netNow.txBytes - netPrev.txBytes) / dt }
      : null;

  const forwardRules = selectedDeviceId ? parseForwardRules(net.stats?.sections.forwards?.output ?? null, selectedDeviceId) : null;
  const reverseRules = parseReverseRules(net.stats?.sections.reverses);
  const ruleItems: WorkbenchItem[] | null = forwardRules === null && reverseRules === null ? null : [
    ...(forwardRules ?? []).map((r) => ({ id: `forward:${r.local}`, title: `${r.local} → ${r.remote}`, subtitle: 'Host local → device remote', icon: <Network size={14} className="text-emerald" />, badges: [{ label: 'forward' }], tags: ['forward'] })),
    ...(reverseRules ?? []).map((r) => ({ id: `reverse:${r.remote}`, title: `${r.remote} → ${r.local}`, subtitle: 'Device remote → host local', icon: <ArrowRightLeft size={14} className="text-info" />, badges: [{ label: 'reverse', type: 'info' as const }], tags: ['reverse'] })),
  ];
  const [ruleFilter, setRuleFilter] = useState('all');
  const [selectedRule, setSelectedRule] = useState('');
  const [newRuleKind, setNewRuleKind] = useState<'forward' | 'reverse'>('forward');
  const [ruleKind, ruleKey] = selectedRule.split(/:(.*)/s);
  const rule = ruleKind === 'forward' ? forwardRules?.find((r) => r.local === ruleKey) : ruleKind === 'reverse' ? reverseRules?.find((r) => r.remote === ruleKey) : undefined;
  const newRule = (kind: 'forward' | 'reverse') => { setSelectedRule(''); setNewRuleKind(kind); };

  // Forward form
  const [fwdLocal, setFwdLocal] = useState('tcp:8080');
  const [fwdRemote, setFwdRemote] = useState('tcp:8080');
  const [noRebind, setNoRebind] = useState(false);

  // Reverse form
  const [revRemote, setRevRemote] = useState('tcp:9000');
  const [revLocal, setRevLocal] = useState('tcp:9000');

  // Proxy form
  const [proxyHost, setProxyHost] = useState('127.0.0.1');
  const [proxyPort, setProxyPort] = useState('8080');
  const [proxyLoading, setProxyLoading] = useState(false);
  const [proxyMessage, setProxyMessage] = useState<string | null>(null);

  const handleSetProxy = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!proxyHost || !proxyPort || !selectedDeviceId) return;
    setProxyLoading(true);
    setProxyMessage(null);
    try {
      const op = findOperation('network.proxy_set');
      if (op) {
        await runOperation(op.id, { host: proxyHost, port: Number(proxyPort) });
        setProxyMessage(`Proxy set to ${proxyHost}:${proxyPort}`);
      }
    } catch (err) {
      setProxyMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProxyLoading(false);
    }
  };

  const handleClearProxy = async () => {
    if (!selectedDeviceId) return;
    setProxyLoading(true);
    setProxyMessage(null);
    try {
      const op = findOperation('network.proxy_clear');
      if (op) {
        await runOperation(op.id, {});
        setProxyMessage('Global HTTP proxy cleared');
      }
    } catch (err) {
      setProxyMessage(`Error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setProxyLoading(false);
    }
  };

  const handleAddForward = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fwdLocal || !fwdRemote || !selectedDeviceId) return;

    const op = findOperation('forward.create');
    if (op) openOperationModal(op, { local: fwdLocal, remote: fwdRemote, noRebind });
  };

  const handleAddReverse = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!revRemote || !revLocal || !selectedDeviceId) return;

    const op = findOperation('reverse.create');
    if (op) openOperationModal(op, { remote: revRemote, local: revLocal });
  };

  const handleRemoveAll = (type: 'forward' | 'reverse') => {
    const op = findOperation(`${type}.remove_all`);
    if (op) openOperationModal(op);
  };

  const networkKpis: TabKpiItem[] = [
    {
      id: 'net-forward-rules',
      label: 'Forward Rules',
      value: pending ? '—' : forwards ?? 'Unavailable',
      subtext: pending ?? 'Host → device (adb forward --list)',
      icon: Network,
      color: 'var(--emerald-accent)',
      onClick: () => { setRuleFilter('forward'); newRule('forward'); },
    },
    {
      id: 'net-reverse-tunnels',
      label: 'Reverse Tunnels',
      value: pending ? '—' : reverses ?? 'Unavailable',
      subtext: pending ?? (reverses === null ? firstLine(net.stats?.sections.reverses) : 'Device → host (adb reverse --list)'),
      icon: ArrowRightLeft,
      color: 'var(--color-info)',
      onClick: () => { setRuleFilter('reverse'); newRule('reverse'); },
    },
    {
      id: 'net-throughput',
      label: 'Device Throughput',
      value: pending ? '—' : rates ? formatRate(rates.rx + rates.tx) : netNow ? 'Measuring…' : 'Unavailable',
      subtext: pending ?? (rates ? `↓ ${formatRate(rates.rx)}  ↑ ${formatRate(rates.tx)}` : 'All interfaces except loopback'),
      icon: Share2,
      color: 'var(--color-success)',
    },
    {
      id: 'net-tcp-sockets',
      label: 'TCP Connections',
      value: pending ? '—' : tcp ? tcp.established : 'Unavailable',
      subtext: pending ?? (tcp ? `Established · ${tcp.timeWait} in TIME_WAIT` : 'Kernel socket table not readable'),
      icon: Radio,
      color: 'var(--color-purple)',
    },
  ];

  const currentProxy = net.stats?.sections.proxy?.exitCode === 0
    ? (net.stats.sections.proxy.output.trim() === 'null' || net.stats.sections.proxy.output.trim() === ':0'
      ? 'None configured'
      : net.stats.sections.proxy.output.trim() || 'Unavailable')
    : 'Unavailable';

  return (
    <div className="workspace-page">
      <PageHeader
        title="Network & Socket Mappings"
        description="TCP/named socket forwarding, reverse proxies, endpoint inspection, and network diagnostics"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      <PageTabs page="network" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <TabKpiGrid items={networkKpis} />
          <div className="app-workbench">
            <WorkbenchList
              items={ruleItems}
              label="Port rules"
              placeholder="Filter rules…"
              filters={RULE_FILTERS}
              filter={ruleFilter}
              onFilter={setRuleFilter}
              selected={selectedRule}
              onSelect={setSelectedRule}
              toolbar={<>
                <button type="button" className="btn btn-secondary btn-sm" onClick={net.refresh} disabled={!selectedDeviceId || net.loading} title="Reload forward and reverse rules">
                  <RefreshCw size={13} className={net.loading ? 'animate-spin' : undefined} />
                </button>
                <button type="button" className="btn btn-primary btn-sm" onClick={() => newRule(ruleFilter === 'reverse' ? 'reverse' : 'forward')} title="Create a forward or reverse rule">
                  <Plus size={13} /><span>New rule</span>
                </button>
              </>}
              status={
                !selectedDeviceId ? <div className="text-xs text-dim">Select a device to list its port rules.</div>
                  : ruleItems === null ? <div className="text-xs text-dim">{pending ?? 'Reading forward and reverse rules…'}</div>
                    : ruleItems.length === 0 ? <div className="text-xs text-dim">No forward or reverse rules on this device yet.</div>
                      : null
              }
            />
            {rule ? (
              <div className="workspace-panel app-detail">
                <div className="app-detail-head">
                  <div className="app-detail-title">
                    {ruleKind === 'forward' ? <Network size={16} className="text-emerald" /> : <ArrowRightLeft size={16} className="text-emerald" />}
                    <h2 className="panel-title font-mono">{ruleKind === 'forward' ? `${rule.local} → ${rule.remote}` : `${rule.remote} → ${rule.local}`}</h2>
                  </div>
                  <dl className="app-detail-factsheet">
                    <div><dt>Direction</dt><dd><span className={`badge ${ruleKind === 'forward' ? 'badge-neutral' : 'badge-info'}`}>{ruleKind === 'forward' ? 'Forward Host → Device' : 'Reverse Device → Host'}</span></dd></div>
                    <div><dt>Host local</dt><dd className="font-mono">{rule.local}<CopyButton value={rule.local} label="host local" /></dd></div>
                    <div><dt>Device remote</dt><dd className="font-mono">{rule.remote}<CopyButton value={rule.remote} label="device remote" /></dd></div>
                  </dl>
                  <div className="app-detail-ops" role="group" aria-label="Rule operations">
                    <button type="button" className="btn btn-secondary btn-xs" disabled={!selectedDeviceId}
                      onClick={() => { const op = findOperation(`${ruleKind}.list`); if (op) openOperationModal(op); }}>
                      <span>List Active</span>
                    </button>
                    <span className="app-detail-ops-danger">
                      <button type="button" className="btn btn-danger btn-xs" disabled={!selectedDeviceId}
                        title={ruleKind === 'forward' ? 'Remove this forward rule (adb forward --remove)' : 'Remove this reverse rule (adb reverse --remove)'}
                        onClick={() => {
                          const op = findOperation(`${ruleKind}.remove`);
                          if (op) openOperationModal(op, ruleKind === 'forward' ? { local: rule.local } : { remote: rule.remote });
                        }}>
                        <Trash2 size={12} /><span>Remove rule</span>
                      </button>
                    </span>
                  </div>
                </div>
              </div>
            ) : (
              <div className="workspace-panel app-detail">
                <div className="rule-form-head">
                  <div className="app-detail-title">
                    {newRuleKind === 'forward' ? <Network size={16} className="text-emerald" /> : <ArrowRightLeft size={16} className="text-emerald" />}
                    <h2 className="panel-title">New {newRuleKind} rule</h2>
                  </div>
                  <button
                    className="btn btn-ghost btn-xs text-danger"
                    onClick={() => handleRemoveAll(newRuleKind)}
                    disabled={!selectedDeviceId}
                    title={`Remove all ${newRuleKind} rules`}
                  >
                    <Trash2 size={12} />
                    <span>Clear All</span>
                  </button>
                </div>
                <div className="app-detail-tabs" role="tablist" aria-label="New rule type">
                  <button type="button" role="tab" aria-selected={newRuleKind === 'forward'} className="app-detail-tab" onClick={() => setNewRuleKind('forward')}>
                    <Network size={13} /><span>Forward · host → device</span>
                  </button>
                  <button type="button" role="tab" aria-selected={newRuleKind === 'reverse'} className="app-detail-tab" onClick={() => setNewRuleKind('reverse')}>
                    <ArrowRightLeft size={13} /><span>Reverse · device → host</span>
                  </button>
                </div>
                <form role="tabpanel" className="rule-form" onSubmit={newRuleKind === 'forward' ? handleAddForward : handleAddReverse}>
                  <p className="text-xs text-muted">
                    {newRuleKind === 'forward'
                      ? <>Connections to the host endpoint are tunnelled to the device (<code className="font-mono">adb forward</code>).</>
                      : <>Connections the device makes to its endpoint reach the host (<code className="font-mono">adb reverse</code>).</>}
                  </p>
                  <div className="rule-flow">
                    {(newRuleKind === 'forward'
                      ? [['Host Local', 'This computer', fwdLocal, setFwdLocal, 'tcp:8080'], ['Device Remote', 'Android device', fwdRemote, setFwdRemote, 'tcp:8080']]
                      : [['Device Remote', 'Android device', revRemote, setRevRemote, 'tcp:9000'], ['Host Local', 'This computer', revLocal, setRevLocal, 'tcp:9000']]
                    ).map(([label, side, value, set, placeholder], i) => (
                      <React.Fragment key={label as string}>
                        {i === 1 && <div className="rule-flow-arrow" aria-hidden="true"><ArrowRight size={18} /></div>}
                        <label className="rule-endpoint">
                          <span className="rule-endpoint-side">{side as string}</span>
                          <span className="rule-endpoint-label">{label as string}</span>
                          <input
                            type="text"
                            className="input font-mono"
                            aria-label={label as string}
                            placeholder={placeholder as string}
                            value={value as string}
                            onChange={(e) => (set as (v: string) => void)(e.target.value)}
                          />
                        </label>
                      </React.Fragment>
                    ))}
                  </div>
                  <p className="rule-form-hint text-xs text-dim">
                    Endpoints: <code>tcp:&lt;port&gt;</code> · <code>localabstract:&lt;name&gt;</code> · <code>localreserved:&lt;name&gt;</code> · <code>localfilesystem:&lt;path&gt;</code>{newRuleKind === 'forward' && <> · <code>jdwp:&lt;pid&gt;</code> (device side)</>}
                  </p>
                  <div className="rule-form-actions">
                    {newRuleKind === 'forward' && (
                      <label className="widget-check">
                        <input type="checkbox" checked={noRebind} onChange={(e) => setNoRebind(e.target.checked)} />
                        <span>Fail if already bound (--no-rebind)</span>
                      </label>
                    )}
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => {
                        const op = findOperation(`${newRuleKind}.list`);
                        if (op) openOperationModal(op);
                      }}
                      disabled={!selectedDeviceId}
                    >
                      <span>List Active</span>
                    </button>
                    <button type="submit" className="btn btn-primary btn-sm" disabled={!selectedDeviceId}>
                      <Plus size={13} />
                      <span>{newRuleKind === 'forward' ? 'Create Forward Rule' : 'Create Reverse Rule'}</span>
                    </button>
                  </div>
                </form>
                <p className="text-xs text-dim app-hints">Pick a rule to inspect or remove it · <kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open</p>
              </div>
            )}
          </div>
          <div className="workspace-panel">
            <div className="flex items-center justify-between flex-wrap gap-2">
              <div className="flex items-center gap-2 flex-wrap">
                <Radio size={16} className="text-emerald" />
                <h2 className="panel-title">Global HTTP Proxy & Traffic Inspection</h2>
                <span className="panel-status-pill font-mono" title="Current HTTP proxy">
                  Active: {currentProxy}
                </span>
              </div>
              <CollectionStatus state={net} deviceId={selectedDeviceId} />
            </div>
            <p className="text-xs text-dim mt-1">
              Configures device system proxy (<code className="font-mono text-emerald">settings put global http_proxy</code>) for mitmproxy, Charles, or Burp Suite.
            </p>

            <form onSubmit={handleSetProxy} className="flex flex-col gap-3 mt-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-dim">Proxy Host / IP</label>
                  <input
                    type="text"
                    className="input text-xs font-mono"
                    placeholder="127.0.0.1"
                    value={proxyHost}
                    onChange={(e) => setProxyHost(e.target.value)}
                  />
                </div>
                <div>
                  <label className="text-xs text-dim">Proxy Port</label>
                  <input
                    type="number"
                    className="input text-xs font-mono"
                    placeholder="8080"
                    value={proxyPort}
                    onChange={(e) => setProxyPort(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="chip-row">
                  <span className="chip-row-label">Presets:</span>
                  <button
                    type="button"
                    className={`chip-button mono ${proxyHost === '127.0.0.1' && proxyPort === '8080' ? 'active' : ''}`}
                    onClick={() => { setProxyHost('127.0.0.1'); setProxyPort('8080'); }}
                  >
                    mitmproxy/Charles (8080)
                  </button>
                  <button
                    type="button"
                    className={`chip-button mono ${proxyHost === '127.0.0.1' && proxyPort === '8082' ? 'active' : ''}`}
                    onClick={() => { setProxyHost('127.0.0.1'); setProxyPort('8082'); }}
                  >
                    Burp Suite (8082)
                  </button>
                </div>

                <div className="flex gap-2">
                  <button
                    type="submit"
                    className="btn btn-primary btn-sm"
                    disabled={!selectedDeviceId || proxyLoading}
                  >
                    <span>Apply Global Proxy</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={handleClearProxy}
                    disabled={!selectedDeviceId || proxyLoading}
                  >
                    <span>Clear Proxy</span>
                  </button>
                </div>
              </div>

              {proxyMessage && (
                <div className={`alert ${proxyMessage.startsWith('Error') ? 'alert-danger' : 'alert-success'} text-xs py-1.5`}>
                  <span>{proxyMessage}</span>
                </div>
              )}
            </form>
          </div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Network"
            coveragePrefix="N"
            title="Network & Socket Mapping Operations"
            description="TCP socket bindings, abstract UNIX domains, JDWP forwarders, and netstat inspection"
          />
        </>
      }]} />
    </div>
  );
};
