import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useState, useEffect } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { isSplashEnabled, setSplashEnabled } from '../lib/splash.js';
import {
  Settings,
  Server,
  Key,
  Database,
  Radio,
  RefreshCw,
  ShieldCheck,
  Palette,
  Info,
} from 'lucide-react';

export const SettingsPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('settings', 'workspace');
  const {
    capabilities,
    health,
    isWsConnected,
    refreshCapabilities,
    theme,
    setTheme,
    availableThemes,
  } = useWorkstation();

  const [splashEnabled, setSplashEnabledState] = useState(isSplashEnabled);
  const [capSearch, setCapSearch] = useState('');
  const [capFilter, setCapFilter] = useState<'all' | 'available' | 'restricted'>('all');
  const [settingsData, setSettingsData] = useState<Record<string, unknown>>({});
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsError, setSettingsError] = useState<string | null>(null);

  useEffect(() => {
    const fetchSettings = async () => {
      try {
        const data = await api.getSettings();
        setSettingsData(data);
      } catch (err: unknown) {
        console.warn('Settings load warning:', err);
      }
    };
    fetchSettings();
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    setSettingsLoading(true);
    setSettingsSaved(false);
    setSettingsError(null);
    try {
      const updated = await api.updateSettings(settingsData);
      setSettingsData(updated);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 3000);
    } catch (err: unknown) {
      setSettingsError(err instanceof Error ? err.message : 'Failed to update settings');
    } finally {
      setSettingsLoading(false);
    }
  };

  const allCaps = capabilities?.capabilities ?? [];
  const filteredCaps = allCaps.filter((c) => {
    if (capFilter === 'available' && !c.available) return false;
    if (capFilter === 'restricted' && c.available) return false;
    if (!capSearch.trim()) return true;
    const q = capSearch.trim().toLowerCase();
    return c.id.toLowerCase().includes(q) || (c.reason?.toLowerCase().includes(q) ?? false);
  });

  return (
    <div className="workspace-page">
      <PageHeader
        title="Capabilities & Workstation Settings"
        description="Host ADB version detection, capability restrictions, server runtime configuration, and contracts"
        actions={
          <button className="btn btn-secondary btn-sm" onClick={refreshCapabilities}>
            <RefreshCw size={13} />
            <span>Refresh Capabilities</span>
          </button>
        }
      />

      <PageTabs page="settings" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <div className="grid grid-cols-3 gap-4">
            {/* Host Companion Info */}
            <div className="workspace-panel">
              <div className="flex items-center gap-2">
                <Server size={16} className="text-emerald" />
                <span className="text-sm font-medium text-main">Backend Mode</span>
              </div>
              <div className="font-mono text-base font-bold text-main">
                {health?.mode || 'Unavailable'}
              </div>
              <div className="text-xs text-dim font-mono">Version: {health?.version || 'Unavailable'}</div>
            </div>

            {/* ADB Binary Version */}
            <div className="workspace-panel">
              <div className="flex items-center gap-2">
                <Database size={16} className="text-info" />
                <span className="text-sm font-medium text-main">Configured ADB</span>
              </div>
              <div className="font-mono text-base font-bold text-main truncate">
                {capabilities?.adbVersion || 'Unavailable'}
              </div>
              <div className="text-xs text-dim font-mono">Catalog reference: ADB 34.0.4 (1.0.41)</div>
            </div>

            {/* Real-time Events & CSRF */}
            <div className="workspace-panel">
              <div className="flex items-center gap-2">
                <Radio size={16} className="text-emerald" />
                <span className="text-sm font-medium text-main">Events & Security</span>
              </div>
              <div className="flex items-center gap-2">
                <span
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    backgroundColor: isWsConnected ? 'var(--color-success)' : 'var(--color-warning)',
                  }}
                />
                <span className="font-mono text-xs font-semibold text-main">
                  {isWsConnected ? 'WebSocket Live' : 'Reconnecting...'}
                </span>
              </div>
              <div className="text-xs text-dim font-mono flex items-center gap-1">
                <ShieldCheck size={12} className="text-emerald" />
                <span>CSRF Token Protected</span>
              </div>
            </div>
          </div>
          <details open className="workspace-panel settings-section">
            <summary className="flex items-center justify-between gap-2">
              <div>
                <div className="flex items-center gap-2">
                  <Key size={16} className="text-emerald" />
                  <h2 className="panel-title">Capabilities & restrictions</h2>
                </div>
                <p className="text-xs text-dim">
                  Inspection of underlying host features. Unsupported operations show exact unmet conditions. Catalog baseline: ADB 34.0.4.
                </p>
              </div>
              <span className="badge badge-neutral font-mono">
                {capabilities?.capabilities?.length || 0} features
              </span>
            </summary>

            <div className="settings-content" style={{ maxHeight: '560px', overflow: 'auto' }}>
              {/* Extended Reference & Coverage Specification Notice */}
              <div className="alert alert-info text-xs mb-4 flex flex-col gap-3 p-3.5 leading-relaxed rounded-md">
                <div className="flex items-center gap-2 border-b border-[var(--border-card)] pb-2">
                  <Info size={16} className="text-info shrink-0" />
                  <div className="font-semibold text-main text-sm">
                    Catalog Reference Baseline &amp; Feature Coverage Architecture
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-dim">
                  <div>
                    <span className="font-bold text-main block mb-1">
                      1. Reference ADB Version &amp; Baseline Scope
                    </span>
                    <p>
                      The typed command catalog and test fixtures are authored against <strong>Android Debug Bridge 1.0.41</strong> (package <span className="font-mono text-main">34.0.4-10411341</span>). The feature tracking matrix covers 164 ADB capability identifiers, tracked in <span className="font-mono text-main">docs/FEATURE_COVERAGE.md</span>.
                    </p>
                  </div>

                  <div>
                    <span className="font-bold text-main block mb-1">
                      2. Status Criteria: Available vs. Partial vs. Restricted
                    </span>
                    <p>
                      <span className="badge badge-online text-[10px] mr-1">Available</span> indicates the host ADB binary executable supports invoking the command adapter. It does <em>not</em> imply complete feature or protocol parity in the feature matrix (<span className="font-mono text-main">docs/FEATURE_COVERAGE.md</span>), where capabilities are classified as <strong>Partial</strong> until full contract parity and domain integration exist.
                    </p>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
                <div className="chip-row">
                  {([
                    ['all', `All (${allCaps.length})`],
                    ['available', `Available (${allCaps.filter((c) => c.available).length})`],
                    ['restricted', `Restricted (${allCaps.filter((c) => !c.available).length})`],
                  ] as const).map(([key, label]) => (
                    <button
                      key={key}
                      type="button"
                      className={`chip-button ${capFilter === key ? 'active' : ''}`}
                      onClick={() => setCapFilter(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <input
                  type="search"
                  className="input text-xs font-mono"
                  style={{ maxWidth: '240px' }}
                  placeholder="Filter capability ID or reason..."
                  aria-label="Filter capabilities"
                  value={capSearch}
                  onChange={(e) => setCapSearch(e.target.value)}
                />
              </div>

              <div className="capabilities-table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Capability ID</th>
                    <th>Status</th>
                    <th>Availability / Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredCaps.map((c) => (
                    <tr key={c.id}>
                      <td className="font-mono text-xs font-semibold text-main">{c.id}</td>
                      <td>
                        {c.available ? (
                          <span className="badge badge-online text-xs">Available</span>
                        ) : (
                          <span className="badge badge-danger text-xs">Restricted</span>
                        )}
                      </td>
                      <td className="font-mono text-xs text-dim">
                        {c.available ? (
                          <span className="text-emerald">Supported by host ADB and environment</span>
                        ) : (
                          <span className="text-warning">
                            {c.reason || 'Hardware / firmware condition not met on current host'}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {allCaps.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="text-center text-dim py-4">
                        Loading capability descriptors...
                      </td>
                    </tr>
                  ) : filteredCaps.length === 0 && (
                    <tr>
                      <td colSpan={3} className="text-center text-dim py-4">
                        No capabilities match the current filter.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              </div>
            </div>
          </details>
          <details open className="workspace-panel settings-section">
            <summary className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Palette size={16} className="text-emerald" />
                <h2 className="panel-title">UI Appearance & Theme</h2>
              </div>
              <span className="text-xs font-mono text-dim">
                Active: <span className="font-semibold text-emerald">{availableThemes.find((t) => t.id === theme)?.name || theme}</span>
              </span>
            </summary>
            <div className="settings-content">
              <p className="text-xs text-dim">
                Select a visual theme variant for the terminal workspace. Changes apply instantly across all panes, graphs, and toolbars and persist in local storage.
              </p>

              <label className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={splashEnabled} onChange={(e) => { setSplashEnabled(e.target.checked); setSplashEnabledState(e.target.checked); }} />
                Show the startup splash screen once per browser tab
              </label>

              {/* Dark themes Section */}
              <div>
                <div className="text-xs text-dim font-semibold mb-2">
                  Dark themes ({availableThemes.filter((t) => t.variant === 'dark').length})
                </div>
                <div className="theme-grid">
                  {availableThemes
                    .filter((t) => t.variant === 'dark')
                    .map((t) => {
                      const isSelected = theme === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTheme(t.id)}
                          aria-pressed={isSelected}
                          aria-label={t.name}
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: isSelected ? '2px solid var(--emerald-accent)' : '2px solid var(--border-card)',
                            borderRadius: '6px',
                            padding: '12px 10px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            gap: '8px',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'all 0.15s ease',
                            boxShadow: isSelected ? '0 0 0 3px var(--emerald-surface)' : 'none',
                          }}
                        >
                          <div className="flex items-center justify-between w-full">
                            <span
                              style={{
                                width: '10px',
                                height: '10px',
                                borderRadius: '50%',
                                backgroundColor: t.accent,
                                display: 'inline-block',
                                boxShadow: `0 0 6px ${t.accent}`,
                              }}
                            />
                            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${isSelected ? 'bg-emerald' : 'badge-neutral text-dim'}`}>
                              {isSelected ? 'ACTIVE' : 'DARK'}
                            </span>
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-main">{t.name}</div>
                            <div className="text-[10px] text-dim">{t.description}</div>
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>

              {/* Light themes Section */}
              <div>
                <div className="text-xs text-dim font-semibold mb-2">
                  Light themes ({availableThemes.filter((t) => t.variant === 'light').length})
                </div>
                <div className="theme-grid">
                  {availableThemes
                    .filter((t) => t.variant === 'light')
                    .map((t) => {
                      const isSelected = theme === t.id;
                      return (
                        <button
                          key={t.id}
                          type="button"
                          onClick={() => setTheme(t.id)}
                          aria-pressed={isSelected}
                          aria-label={t.name}
                          style={{
                            backgroundColor: 'var(--bg-card)',
                            border: isSelected ? '2px solid var(--emerald-accent)' : '2px solid var(--border-card)',
                            borderRadius: '6px',
                            padding: '12px 10px',
                            display: 'flex',
                            flexDirection: 'column',
                            alignItems: 'flex-start',
                            gap: '8px',
                            cursor: 'pointer',
                            textAlign: 'left',
                            transition: 'all 0.15s ease',
                            boxShadow: isSelected ? '0 0 0 3px var(--emerald-surface)' : 'none',
                          }}
                        >
                          <div className="flex items-center justify-between w-full">
                            <span
                              style={{
                                width: '10px',
                                height: '10px',
                                borderRadius: '50%',
                                backgroundColor: t.accent,
                                display: 'inline-block',
                                boxShadow: `0 0 6px ${t.accent}`,
                              }}
                            />
                            <span className={`text-[10px] font-mono font-bold px-1.5 py-0.5 rounded ${isSelected ? 'bg-emerald' : 'badge-neutral text-dim'}`}>
                              {isSelected ? 'ACTIVE' : 'LIGHT'}
                            </span>
                          </div>
                          <div>
                            <div className="text-xs font-semibold text-main">{t.name}</div>
                            <div className="text-[10px] text-dim">{t.description}</div>
                          </div>
                        </button>
                      );
                    })}
                </div>
              </div>
            </div>
          </details>
          <div className="workspace-panel">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Settings size={16} className="text-emerald" />
                <h2 className="panel-title">Workstation Settings</h2>
              </div>
              {settingsSaved && (
                <span className="badge badge-online text-xs font-mono">Settings Saved</span>
              )}
            </div>

            <form onSubmit={handleSaveSettings} className="flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-dim font-medium">Configured ADB Executable Path</label>
                  <input
                    type="text"
                    className="input text-xs font-mono"
                    placeholder="/usr/bin/adb"
                    value={(settingsData.adbPath as string) || ''}
                    onChange={(e) =>
                      setSettingsData((prev) => ({ ...prev, adbPath: e.target.value }))
                    }
                  />
                </div>

                <div>
                  <label className="text-xs text-dim font-medium">Application Data Directory</label>
                  <input
                    type="text"
                    className="input text-xs font-mono"
                    placeholder="/var/lib/andrui-terminal"
                    value={(settingsData.dataDir as string) || ''}
                    onChange={(e) =>
                      setSettingsData((prev) => ({ ...prev, dataDir: e.target.value }))
                    }
                  />
                </div>
              </div>

              {settingsError && (
                <div className="alert alert-danger text-xs">{settingsError}</div>
              )}

              <button
                type="submit"
                className="btn btn-primary btn-sm self-end"
                disabled={settingsLoading}
              >
                <span>{settingsLoading ? 'Saving...' : 'Save Configuration'}</span>
              </button>
            </form>
          </div>
        </>
      }]} />
    </div>
  );
};
