import { useDeviceProfiles, DeviceKindIcon } from './DeviceExperience.js';
import React, { useMemo } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { deduplicateDevices } from '../lib/devices.js';
import { AndruiGlyph } from './AndruiGlyph.js';
import { ANDROID_DROP_EVENT } from './AndroidDrop.js';
import { Search, RefreshCw, Cpu, Smartphone, ChevronDown, Menu, Sparkles, Archive, Activity } from 'lucide-react';

/** Fired by the top-bar refresh so page widgets with their own data reload alongside devices. */
export const WORKSPACE_REFRESH_EVENT = 'andrui:workspace-refresh';

interface HeaderProps {
  onOpenHostMonitor?: () => void;
  hostMonitorOpen?: boolean;
}

export const Header: React.FC<HeaderProps> = ({ onOpenHostMonitor, hostMonitorOpen = false }) => {
  const profiles = useDeviceProfiles();
  const {
    devices, selectedDevice, selectedDeviceId, setSelectedDeviceId, refreshDevices, refreshCapabilities, devicesLoading,
    health, isWsConnected, activeJobs, setIsJobDrawerOpen, isJobDrawerOpen,
    isAiDrawerOpen, setIsAiDrawerOpen, isArtifactDrawerOpen, setIsArtifactDrawerOpen,
    setIsCommandPaletteOpen, isMobileNavOpen, setIsMobileNavOpen,
  } = useWorkstation();
  const visibleDevices = useMemo(() => deduplicateDevices(devices), [devices]);
  const refreshWorkspace = () => {
    refreshDevices();
    refreshCapabilities();
    window.dispatchEvent(new Event(WORKSPACE_REFRESH_EVENT));
  };

  return (
    <header className="workstation-header">
      <div className="header-brand mobile-hide">
        <button type="button" className="brand-symbol" onClick={() => window.dispatchEvent(new Event(ANDROID_DROP_EVENT))}
          title="Say hi to the Android" aria-label="Drop the Android"><AndruiGlyph /></button>
        <span className="brand-name mobile-hide">AndruiTerminal<span className="brand-caption">Android workbench</span></span>
      </div>

      <div className="header-target">
        {selectedDevice ? <DeviceKindIcon device={selectedDevice} profiles={profiles} size={17} className="text-muted flex-shrink-0" /> : <Smartphone size={17} className="text-muted flex-shrink-0" />}
        <div className="target-select-wrap">
          <label htmlFor="target-device" className="target-label mobile-hide">Target device</label>
          <select id="target-device" aria-label="Target device" value={selectedDevice?.id || ''}
            onChange={e => setSelectedDeviceId(e.target.value || null)}>
            {selectedDeviceId && !selectedDevice && visibleDevices.length > 0 && <option value="">Selected device disconnected — choose a target</option>}
            {visibleDevices.length === 0 ? <option value="" disabled>No devices connected</option> : visibleDevices.map(device => (
              <option key={device.id} value={device.id}>{profiles.find(p => p.transports.includes(device.id))?.name || device.model || device.id}{device.state !== 'device' ? ` (${device.state})` : ''} {device.model ? device.id : ''}</option>
            ))}
          </select>
          <ChevronDown size={13} className="target-chevron" aria-hidden="true" />
        </div>
        {selectedDevice && selectedDevice.state !== 'device' && <span className={`badge mobile-hide ${selectedDevice.state === 'unauthorized' ? 'badge-unauthorized' : 'badge-offline'}`}>{selectedDevice.state}</span>}
        <button className="btn btn-ghost btn-sm" onClick={refreshWorkspace} disabled={devicesLoading} title="Refresh devices" aria-label="Refresh devices">
          <RefreshCw size={15} className={devicesLoading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="header-actions">
        <span className="host-indicator mobile-hide" title={health ? `${health.mode} v${health.version}` : 'Waiting for backend'}>
          <span className={`connection-dot ${isWsConnected ? 'connected' : ''}`} />{isWsConnected ? 'Live' : 'Reconnecting'}
        </span>
        <button className="btn btn-ghost search-trigger" onClick={() => setIsCommandPaletteOpen(true)} title="Search actions, pages, operations (Ctrl+K)">
          <Search size={17} /><span className="mobile-hide">Find an action</span><kbd className="mobile-hide">Ctrl K</kbd>
        </button>
        <button type="button" className={`btn btn-sm ${isAiDrawerOpen ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setIsAiDrawerOpen(!isAiDrawerOpen)} title="Toggle AI Chat Panel" aria-label="AI" aria-expanded={isAiDrawerOpen}>
          <Sparkles size={16} /><span className="mobile-hide">AI</span>
        </button>
        <button type="button" className={`btn btn-sm ${isArtifactDrawerOpen ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setIsArtifactDrawerOpen(!isArtifactDrawerOpen)} title="Toggle Artifacts Panel" aria-label="Artifacts" aria-expanded={isArtifactDrawerOpen}>
          <Archive size={16} /><span className="mobile-hide">Artifacts</span>
        </button>
        <button type="button" className={`btn btn-sm ${isJobDrawerOpen || activeJobs.length ? 'btn-primary' : 'btn-secondary'}`}
          onClick={() => setIsJobDrawerOpen(!isJobDrawerOpen)} title="Toggle Jobs Panel" aria-expanded={isJobDrawerOpen}>
          <Cpu size={16} /><span className="mobile-hide">Jobs</span>{activeJobs.length > 0 && <span>{activeJobs.length}</span>}
        </button>
        {onOpenHostMonitor && (
          <button
            type="button"
            className={`btn btn-sm ${hostMonitorOpen ? 'btn-primary' : 'btn-secondary'}`}
            onClick={onOpenHostMonitor}
            title="Open Host Dashboard on Phone"
            aria-label="Host"
            data-testid="host-monitor-btn"
          >
            <Activity size={16} />
            <span className="mobile-hide">Host</span>
          </button>
        )}
        <button type="button" className="btn btn-ghost desktop-hide" onClick={() => setIsMobileNavOpen(!isMobileNavOpen)}
          aria-label="Toggle Navigation Menu" aria-expanded={isMobileNavOpen}>
          <Menu size={20} />
        </button>
      </div>
    </header>
  );
};
