import { AvdManager, EmulatorSnapshots } from '../components/AvdManager.js';
import { DeviceExperience, DeviceGallery, DeviceTimeline, DeviceTasks, DeviceKindIcon, useDeviceProfiles } from '../components/DeviceExperience.js';
import { QuickStats } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab, selectPageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, type DiscoveryStatus, type DiscoveredService } from '../api/client.js';
import type { HostTelemetry } from '../types/api.js';
import { deduplicateDevices } from '../lib/devices.js';
import { useWorkstation } from '../context/WorkstationContext.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { HelperPanel } from '../components/HelperPanel.js';
import { WORKSPACE_REFRESH_EVENT } from '../components/Header.js';
import { formatUptime } from '../components/HostMonitorModal.js';
import { Wifi, Radio, RefreshCw, Power, Shield, Server, AlertCircle, Usb, Check, Terminal, ArrowUpRight } from 'lucide-react';

const RADAR_SWEEP_SECONDS = 4.2;

function getRadarBlipLayout(service: DiscoveredService, index: number) {
  let hash = 2166136261;
  const key = `${service.kind}:${service.endpoint}`;
  for (let i = 0; i < key.length; i += 1) {
    hash ^= key.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  const angleDeg = ((Math.abs(hash) % 360) + index * 137.5) % 360;
  const radius = service.kind === 'connect' ? 54 : service.kind === 'pairing' ? 72 : 84;
  const rad = ((angleDeg - 90) * Math.PI) / 180;
  const left = 50 + (Math.cos(rad) * radius) / 2.1;
  const top = 50 + (Math.sin(rad) * radius) / 2.1;
  const delaySec = Number(((angleDeg / 360) * RADAR_SWEEP_SECONDS).toFixed(2));
  return { left: `${left.toFixed(1)}%`, top: `${top.toFixed(1)}%`, animationDelay: `${delaySec}s` };
}

export const OverviewPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('overview', 'workspace');
  const {
    devices,
    selectedDeviceId,
    setSelectedDeviceId,
    refreshDevices,
    devicesError,
    findOperation,
    openOperationModal,
    activeJobs,
    runOperation,
    capabilities,
    health,
    isWsConnected,
    setActivePage,
  } = useWorkstation();

  const profiles = useDeviceProfiles();
  const visibleDevices = useMemo(() => deduplicateDevices(devices), [devices]);
  const target = visibleDevices.find(device => device.id === selectedDeviceId);
  const readyDevices = visibleDevices.filter(device => device.state === 'device').length;
  const availableCapabilities = capabilities?.capabilities.filter(capability => capability.available).length;
  const isEmulator = Boolean(
    target &&
      (target.id.startsWith('emulator-') ||
        target.model?.toLowerCase().includes('sdk') ||
        target.product?.toLowerCase().includes('sdk') ||
        target.product?.toLowerCase().includes('emulator'))
  );
  const connectOperation = findOperation('device.connect');
  const pairOperation = findOperation('device.pair');

  // Quick Action Forms
  const [connectHost, setConnectHost] = useState('');
  const [connectLoading, setConnectLoading] = useState(false);

  const [pairHost, setPairHost] = useState('');
  const [pairCode, setPairCode] = useState('');
  const [pairLoading, setPairLoading] = useState(false);

  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Nearby wireless devices (mDNS), refreshed while this page is open
  const [discovery, setDiscovery] = useState<DiscoveryStatus | null>(null);
  const [connectingEndpoint, setConnectingEndpoint] = useState<string | null>(null);
  const pairCodeRef = useRef<HTMLInputElement>(null);
  // Endpoints already attached show as device cards, so the radar only plots the rest.
  const radarServices = (discovery?.services ?? []).filter(service => !visibleDevices.some(device => device.id === service.endpoint));
  useEffect(() => {
    if (activeTab === 'operations') return;
    let cancelled = false;
    const load = async () => {
      if (document.hidden) return;
      try {
        const status = await api.getDiscovery();
        if (!cancelled) setDiscovery(status);
      } catch (err: unknown) {
        if (!cancelled) setDiscovery({ available: false, error: err instanceof Error ? err.message : 'Discovery request failed', services: [] });
      }
    };
    load();
    const timer = setInterval(load, 3000);
    window.addEventListener(WORKSPACE_REFRESH_EVENT, load);
    return () => { cancelled = true; clearInterval(timer); window.removeEventListener(WORKSPACE_REFRESH_EVENT, load); };
  }, [activeTab]);

  // Host identity for the connection panel; reloaded with the top-bar refresh
  const [hostInfo, setHostInfo] = useState<HostTelemetry | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () => api.getHostTelemetry().then(info => { if (!cancelled) setHostInfo(info); }, () => { if (!cancelled) setHostInfo(null); });
    load();
    window.addEventListener(WORKSPACE_REFRESH_EVENT, load);
    return () => { cancelled = true; window.removeEventListener(WORKSPACE_REFRESH_EVENT, load); };
  }, []);

  const handleDiscoveredConnect = async (service: DiscoveredService) => {
    setConnectingEndpoint(service.endpoint);
    setActionFeedback(null);
    try {
      if (!connectOperation) throw new Error('TCP connection is unavailable in the operation catalog');
      const job = await runOperation(connectOperation.id, { host: service.endpoint });
      await api.waitForSuccessfulJob(job.id);
      await refreshDevices();
    } catch (err: unknown) {
      setActionFeedback(err instanceof Error ? err.message : 'Connect failed');
    } finally {
      setConnectingEndpoint(null);
    }
  };

  const handleDiscoveredPair = (service: DiscoveredService) => {
    setPairHost(service.endpoint);
    document.getElementById('wireless-connection')?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    pairCodeRef.current?.focus();
  };

  const handleQuickConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!connectHost) return;
    setConnectLoading(true);
    setActionFeedback(null);
    try {
      const op = findOperation('device.connect');
      if (!op) throw new Error('TCP connection is unavailable in the operation catalog');
      const job = await runOperation(op.id, { host: connectHost });
      await api.waitForSuccessfulJob(job.id);
      await refreshDevices();
      setConnectHost('');
    } catch (err: unknown) {
      setActionFeedback(err instanceof Error ? err.message : 'Connect failed');
    } finally {
      setConnectLoading(false);
    }
  };

  const handleQuickPair = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pairHost || !pairCode) return;
    setPairLoading(true);
    setActionFeedback(null);
    try {
      const op = findOperation('device.pair');
      if (!op) throw new Error('Wireless pairing is unavailable in the operation catalog');
      const job = await runOperation(op.id, { host: pairHost, code: pairCode });
      await api.waitForSuccessfulJob(job.id);
      setPairHost('');
      setPairCode('');
    } catch (err: unknown) {
      setActionFeedback(err instanceof Error ? err.message : 'Pair failed');
    } finally {
      setPairLoading(false);
    }
  };

  const handleServerAction = (action: 'status' | 'start' | 'kill') => {
    const op = findOperation(`server.${action}`);
    if (op) openOperationModal(op);
  };

  // Live events plus a successful device listing mean `adb devices` reached a running server.
  const adbServerRunning = isWsConnected && !devicesError;
  const [serverRestarting, setServerRestarting] = useState(false);
  const handleServerRestart = async () => {
    const killOperation = findOperation('server.kill');
    const startOperation = findOperation('server.start');
    if (!killOperation || !startOperation) return;
    if (!window.confirm('Restart the ADB server? Connected devices will drop briefly and reconnect.')) return;
    setServerRestarting(true);
    setActionFeedback(null);
    try {
      await api.waitForSuccessfulJob((await runOperation(killOperation.id, {}, true)).id);
      await api.waitForSuccessfulJob((await runOperation(startOperation.id, {})).id);
      await refreshDevices();
    } catch (err: unknown) {
      setActionFeedback(err instanceof Error ? err.message : 'ADB server restart failed');
    } finally {
      setServerRestarting(false);
    }
  };

  return (
    <div className="overview-page">
      <PageHeader
        title="Device workbench"
        description="Connect, inspect, and take control of your Android devices."
      />

      {devicesError && <div className="alert alert-danger" role="alert"><AlertCircle size={16} /><span>Error loading devices: {devicesError}</span></div>}
      {actionFeedback && <div className="alert alert-warning" role="alert"><AlertCircle size={16} /><span>{actionFeedback}</span></div>}

      <PageTabs page="overview" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <div className="device-summary-strip"><QuickStats items={[{ label: 'Connected devices', value: visibleDevices.length }, { label: 'Ready', value: readyDevices }, { label: 'Needs attention', value: visibleDevices.filter(device => device.state !== 'device').length }]} /></div>
          <div className="workbench-grid">
            <section className="device-bay" aria-labelledby="devices-heading">
              <div className="panel-heading">
                <div className="flex items-center gap-2"><h2 id="devices-heading">Your devices</h2><span className="count-label">{visibleDevices.length}</span></div>
                <span className="text-sm text-muted">{readyDevices} ready</span>
              </div>
              <div className={`device-welcome ${visibleDevices.length > 0 ? 'device-welcome-compact' : ''}`}>
                <div className="orbital-radar">
                  <div className="orbital-axis orbital-axis-h" aria-hidden="true" />
                  <div className="orbital-axis orbital-axis-v" aria-hidden="true" />
                  <div className="orbital-ring orbital-ring-1" aria-hidden="true" />
                  <div className="orbital-ring orbital-ring-2" aria-hidden="true" />
                  <div className="orbital-ring orbital-ring-3" aria-hidden="true" />
                  <div className="orbital-sweep" aria-hidden="true" />
                  {radarServices.slice(0, 12).map((service, index) => {
                    const layout = getRadarBlipLayout(service, index);
                    const isPairing = service.kind === 'pairing';
                    const isBusy = connectingEndpoint === service.endpoint;
                    const unavailable = isPairing ? !pairOperation?.available : !connectOperation?.available;
                    const label = `${service.hostname} (${service.endpoint}) — ${isPairing ? 'Click to pair' : 'Click to connect'}`;
                    return (
                      <button
                        key={`${service.kind}-${service.name}`}
                        type="button"
                        className={`orbital-blip orbital-blip-${service.kind} ${isBusy ? 'busy' : ''}`}
                        style={layout}
                        disabled={isBusy || unavailable}
                        onClick={() => (isPairing ? handleDiscoveredPair(service) : handleDiscoveredConnect(service))}
                        title={label}
                        aria-label={label}
                      >
                        <span className="orbital-blip-tip" aria-hidden="true">
                          <strong>{service.hostname}</strong>
                          <span>{isBusy ? 'Connecting…' : isPairing ? 'Pair' : 'Connect'}</span>
                        </span>
                      </button>
                    );
                  })}
                  <div className="orbital-core" aria-hidden="true">
                    <Terminal size={24} strokeWidth={1.7} />
                  </div>
                </div>
                <div className="device-welcome-copy">
                  <span className={`orbital-status-pill ${isWsConnected ? 'live' : ''}`}>
                    <span className="orbital-pulse-dot" />
                    {isWsConnected ? 'Listening on USB & Wi-Fi' : 'Waiting for live events'}
                    {radarServices.length > 0 ? ` · ${radarServices.length} nearby` : ''}
                  </span>
                  <h3>{visibleDevices.length === 0 ? 'Waiting for an Android device' : 'Add another device'}</h3>
                  <p>{visibleDevices.length === 0
                    ? <>Plug in a cable or pair wirelessly. Once detected, your device&apos;s shell, apps, and live logs open right here.</>
                    : 'Plug in a cable, or pick a nearby device on the radar to connect or pair it.'}</p>
                  <div className="orbital-checklist">
                    <span className="orbital-step"><span className="orbital-step-num">01</span> Enable <strong>USB debugging</strong></span>
                    <span className="orbital-step"><span className="orbital-step-num">02</span> Plug in &amp; <strong>Allow</strong> prompt</span>
                  </div>
                </div>
              </div>
              {visibleDevices.length > 0 && (
                <div className="device-list" tabIndex={0} role="region" aria-label="Connected devices">
                  {visibleDevices.map(device => {
                    const selected = device.id === selectedDeviceId;
                    return (
                      <article className={`device-card ${selected ? 'selected' : ''}`} key={device.id}>
                        <div className="device-card-top">
                          <div className="device-avatar"><DeviceKindIcon device={device} profiles={profiles} size={30} strokeWidth={1.3} /></div>
                          <div className="device-identity"><h3>{device.model?.replace(/_/g, ' ') || device.id}</h3><span className="device-serial font-mono text-xs text-muted">{device.id}</span></div>
                          <span className={`badge ${device.state === 'device' ? 'badge-device' : device.state === 'unauthorized' ? 'badge-unauthorized' : 'badge-offline'}`}>{device.state === 'device' ? 'Ready' : device.state}</span>
                        </div>
                        <div className="device-metadata"><span>{device.product || 'Android device'}</span><span>Transport {device.transportId ?? 'unavailable'}</span></div>
                        {device.state === 'unauthorized' && <p className="text-sm text-warning">Allow USB debugging on this device to continue.</p>}
                        {device.state === 'offline' && <p className="text-sm text-warning">Check the cable or wireless connection, then reconnect.</p>}
                        {device.details && Object.keys(device.details).length > 0 && <dl className="device-details">{Object.entries(device.details).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value}</dd></div>)}</dl>}
                        <div className="device-card-actions">
                          <div className="flex flex-wrap gap-1">
                            {(['tcpip', 'usb', 'reconnect'] as const).map(action => {
                              const operation = findOperation(`device.${action}`);
                              return <button key={action} className="btn btn-ghost btn-sm" disabled={!operation?.available}
                                title={operation?.unavailableReason}
                                onClick={() => { setSelectedDeviceId(device.id); if (operation) openOperationModal(operation, action === 'tcpip' ? { port: 5555 } : {}); }}>
                                {action === 'tcpip' ? <Wifi size={13} /> : action === 'usb' ? <Usb size={13} /> : <RefreshCw size={13} />}
                                {action === 'tcpip' ? 'TCP/IP' : action === 'usb' ? 'USB' : 'Reconnect'}
                              </button>;
                            })}
                          </div>
                          <button className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setSelectedDeviceId(device.id)}>{selected && <Check size={13} />}{selected ? 'Active target' : 'Select device'}</button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
              <div id="wireless-connection" className="bay-wireless">
                <div className="wireless-forms">
                  <form onSubmit={handleQuickConnect} className="connection-form">
                    <h3>Connect by address</h3><p>For a device already listening over TCP/IP.</p>
                    <label htmlFor="connect-host">Device address</label>
                    <div className="flex gap-2"><input id="connect-host" type="text" className="input font-mono" aria-label="Connection host" placeholder="192.168.1.100:5555" value={connectHost} onChange={e => setConnectHost(e.target.value)} />
                      <button type="submit" className="btn btn-primary" disabled={connectLoading || !connectHost || !connectOperation?.available}>{connectLoading ? 'Connecting…' : 'Connect'}</button></div>
                    {!connectOperation?.available && <p className="text-warning">{connectOperation?.unavailableReason || 'TCP connection is unavailable in the operation catalog.'}</p>}
                  </form>
                  <form onSubmit={handleQuickPair} className="connection-form">
                    <h3>Pair a new device <span className="text-xs text-muted">Android 11+</span></h3><p>Open Wireless debugging → Pair device with pairing code.</p>
                    <div className="pair-fields"><div><label htmlFor="pair-host">Pairing address</label><input id="pair-host" type="text" className="input font-mono" aria-label="Pairing host" placeholder="192.168.1.100:38291" value={pairHost} onChange={e => setPairHost(e.target.value)} /></div>
                      <div><label htmlFor="pair-code">Pairing code</label><input id="pair-code" ref={pairCodeRef} type="text" className="input font-mono" aria-label="Pairing code" placeholder="6-digit code" value={pairCode} onChange={e => setPairCode(e.target.value)} /></div>
                      <button type="submit" className="btn btn-secondary" disabled={pairLoading || !pairHost || !pairCode || !pairOperation?.available}><Shield size={14} />{pairLoading ? 'Pairing…' : 'Pair device'}</button>
                    </div>
                    {!pairOperation?.available && <p className="text-warning">{pairOperation?.unavailableReason || 'Wireless pairing is unavailable in the operation catalog.'}</p>}
                  </form>
                </div>
                <div className="discovery-actions">
                  {[{ id: 'device.mdns.services', label: 'Discover mDNS services', icon: Radio }, { id: 'server.features', label: 'Inspect host features', icon: Server }].map(item => {
                    const operation = findOperation(item.id);
                    return <button key={item.id} className="btn btn-ghost btn-sm" disabled={!operation?.available} title={operation?.unavailableReason} onClick={() => { if (operation) openOperationModal(operation); }}><item.icon size={14} />{item.label}</button>;
                  })}
                </div>
              </div>
              <DeviceExperience embedded />
              <div className="bay-footer"><Usb size={14} /><span>USB and wireless transports</span><span className="text-muted">Changes update live</span></div>
            </section>

            <aside className="host-panel" aria-labelledby="host-heading">
              <div className="panel-heading"><h2 id="host-heading">Host connection</h2><Server size={17} className="text-muted" /></div>
              <div className="host-state"><span className={`connection-dot ${isWsConnected ? 'connected' : ''}`} /><span>{isWsConnected ? 'Receiving live events' : 'Waiting for live events'}</span></div>
              <dl className="host-facts">
                <div><dt>Host</dt><dd>{hostInfo?.hostname || 'Unavailable'}</dd></div>
                <div><dt>System</dt><dd className="font-mono">{hostInfo ? `${hostInfo.kernel} · ${hostInfo.arch}` : 'Unavailable'}</dd></div>
                <div><dt>Host uptime</dt><dd>{hostInfo ? formatUptime(hostInfo.uptimeSecs) : 'Unavailable'}</dd></div>
                <div><dt>Runtime</dt><dd>{health ? `${health.mode} v${health.version}` : 'Unavailable'}</dd></div>
                <div><dt>ADB version</dt><dd className="font-mono">{capabilities?.adbVersion || 'Unavailable'}</dd></div>
                <div><dt>ADB server</dt><dd>{adbServerRunning ? 'Running' : devicesError ? 'Not responding' : 'Unknown'}</dd></div>
                <div><dt>Wireless discovery</dt><dd>{!discovery ? 'Starting' : discovery.available ? `${discovery.services.length} nearby` : 'Unavailable'}</dd></div>
                <div><dt>Devices</dt><dd>{readyDevices} ready of {visibleDevices.length}</dd></div>
                <div><dt>Active jobs</dt><dd>{activeJobs.length}</dd></div>
                <div><dt>Capabilities</dt><dd>{capabilities ? `${availableCapabilities} of ${capabilities.capabilities.length}` : 'Unavailable'}</dd></div>
                <div><dt>Selected target</dt><dd>{target?.model || target?.id || 'None selected'}</dd></div>
              </dl>
              <div className="host-controls">
                <p className="text-sm text-muted">ADB server</p>
                <div className="host-server-actions">
                  {(['status', 'start', 'kill'] as const).map(action => {
                    const operation = findOperation(`server.${action}`);
                    if (action === 'start' && adbServerRunning) {
                      const killOperation = findOperation('server.kill');
                      return <button key="restart" className="btn btn-sm btn-secondary" disabled={serverRestarting || !operation?.available || !killOperation?.available} title={operation?.unavailableReason || killOperation?.unavailableReason} onClick={handleServerRestart}>
                        <RefreshCw size={12} className={serverRestarting ? 'animate-spin' : ''} />{serverRestarting ? 'Restarting…' : 'Restart'}
                      </button>;
                    }
                    return <button key={action} className={`btn btn-sm ${action === 'kill' ? 'btn-danger' : 'btn-secondary'}`} disabled={!operation?.available} title={operation?.unavailableReason} onClick={() => handleServerAction(action)}>
                      {action !== 'status' && <Power size={12} />}{action === 'status' ? 'Status' : action === 'start' ? 'Start' : 'Stop'}
                    </button>;
                  })}
                </div>
              </div>
              <button className="host-settings-link" onClick={() => { selectPageTab('settings', 'workspace'); setActivePage('settings'); }}>View capabilities and settings<ArrowUpRight size={15} /></button>
            </aside>
          </div>
          <DeviceTasks />
          <div className="device-tools-stack">
            <DeviceGallery />
            <DeviceTimeline />
            <AvdManager />
            <HelperPanel deviceId={selectedDeviceId} deviceReady={target?.state === 'device'} defaultOpen={false} />
          </div>
          {isEmulator && selectedDeviceId && <EmulatorSnapshots deviceId={selectedDeviceId} />}
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList category="Devices" coveragePrefix="C" title="Device & Transport Operations" description="Discovery, targeting, keys, and transport controls from your host’s operation catalog." />
        </>
      }]} />
    </div>
  );
};
