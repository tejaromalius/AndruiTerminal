import { selectPageTab } from './PageTabs.js';
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { selectApp, useAppSelection } from '../lib/packageList.js';
import { PageId } from '../types/api.js';
import {
  Search,
  Smartphone,
  Cpu,
  Layers,
  FileCode,
  ArrowRight,
  X,
} from 'lucide-react';

export const CommandPalette: React.FC = () => {
  const {
    isCommandPaletteOpen,
    setIsCommandPaletteOpen,
    setActivePage,
    operations,
    openOperationModal,
    devices,
    setSelectedDeviceId,
    selectedDeviceId,
  } = useWorkstation();
  const appSelection = useAppSelection(selectedDeviceId);

  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCommandPaletteOpen) {
      setQuery('');
      setSelectedIndex(0);
      setTimeout(() => inputRef.current?.focus(), 50);

      const handleGlobalKeyDown = (e: KeyboardEvent) => {
        if (e.key === 'Escape') {
          setIsCommandPaletteOpen(false);
        }
      };
      window.addEventListener('keydown', handleGlobalKeyDown);
      return () => window.removeEventListener('keydown', handleGlobalKeyDown);
    }
  }, [isCommandPaletteOpen, setIsCommandPaletteOpen]);

  interface PaletteItem {
    id: string;
    type: 'page' | 'operation' | 'device' | 'app';
    title: string;
    subtitle?: string;
    badge?: string;
    action: () => void;
  }

  const pages: { id: PageId; title: string; category: string }[] = [
    { id: 'overview', title: 'Overview / Devices', category: 'Devices' },
    { id: 'apps', title: 'Applications / Lifecycle', category: 'Packages' },
    { id: 'files', title: 'Files / Data Manager', category: 'Files' },
    { id: 'shell', title: 'Shell & Terminal', category: 'Execution' },
    { id: 'logs', title: 'Logs & Diagnostics', category: 'Diagnostics' },
    { id: 'screen', title: 'Screen & Media', category: 'Media' },
    { id: 'layout', title: 'Layout & Accessibility', category: 'Automation' },
    { id: 'network', title: 'Network Mappings', category: 'Network' },
    { id: 'diagnostics', title: 'Performance & Dumpsys', category: 'Diagnostics' },
    { id: 'permissions', title: 'Users & Permissions Policy', category: 'System' },
    { id: 'recovery', title: 'System & Recovery', category: 'System' },
    { id: 'automation', title: 'Automation & Workflows', category: 'Automation' },
    { id: 'ai', title: 'AI Integration (MCP, skill, approvals)', category: 'Automation' },
    { id: 'settings', title: 'Capabilities & Configuration', category: 'Settings' },
  ];

  const filteredItems = useMemo<PaletteItem[]>(() => {
    const q = query.toLowerCase().trim();
    const results: PaletteItem[] = [];

    // Filter Pages
    for (const p of pages) {
      if (!q || p.title.toLowerCase().includes(q) || p.category.toLowerCase().includes(q)) {
        results.push({
          id: `page-${p.id}`,
          type: 'page',
          title: p.title,
          subtitle: `Navigate to ${p.category} view`,
          badge: 'Page',
          action: () => {
            selectPageTab(p.id, 'workspace');
            setActivePage(p.id);
            setIsCommandPaletteOpen(false);
          },
        });
      }
    }

    // Filter Devices
    for (const d of devices) {
      if (!q || d.id.toLowerCase().includes(q) || (d.model && d.model.toLowerCase().includes(q))) {
        results.push({
          id: `dev-${d.id}`,
          type: 'device',
          title: `Device: ${d.id}`,
          subtitle: `${d.state} ${d.model ? `• ${d.model}` : ''}`,
          badge: 'Target',
          action: () => {
            setSelectedDeviceId(d.id);
            setIsCommandPaletteOpen(false);
          },
        });
      }
    }

    // Pinned and recent apps of the target device
    for (const pkg of [...new Set([...appSelection.pinned, ...appSelection.recent])]) {
      if (!q || pkg.toLowerCase().includes(q)) {
        results.push({
          id: `app-${pkg}`,
          type: 'app',
          title: `App: ${pkg}`,
          subtitle: appSelection.pinned.includes(pkg) ? 'Pinned app • open in Applications' : 'Recent app • open in Applications',
          badge: 'App',
          action: () => {
            selectApp(selectedDeviceId, pkg);
            selectPageTab('apps', 'workspace');
            setActivePage('apps');
            setIsCommandPaletteOpen(false);
          },
        });
      }
    }

    // Filter Operations
    for (const op of operations) {
      const matchLabel = op.label.toLowerCase().includes(q);
      const matchId = op.id.toLowerCase().includes(q);
      const matchCat = op.category.toLowerCase().includes(q);
      const matchCov = op.coverageIds?.some((c) => c.toLowerCase().includes(q));

      if (!q || matchLabel || matchId || matchCat || matchCov) {
        results.push({
          id: `op-${op.id}`,
          type: 'operation',
          title: op.label,
          subtitle: `${op.category} • ${op.description}`,
          badge: op.coverageIds?.[0] || 'Op',
          action: () => {
            openOperationModal(op);
            setIsCommandPaletteOpen(false);
          },
        });
      }
    }

    return results.slice(0, 30);
  }, [query, operations, devices, pages, setActivePage, setSelectedDeviceId, openOperationModal, setIsCommandPaletteOpen, appSelection.pinned, appSelection.recent, selectedDeviceId]);

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev + 1) % Math.max(1, filteredItems.length));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => (prev - 1 + filteredItems.length) % Math.max(1, filteredItems.length));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = filteredItems[selectedIndex];
      if (item) item.action();
    } else if (e.key === 'Escape') {
      setIsCommandPaletteOpen(false);
    }
  };

  if (!isCommandPaletteOpen) return null;

  return (
    <div className="modal-overlay" onClick={() => setIsCommandPaletteOpen(false)}>
      <div
        className="modal-box"
        style={{ width: '640px', maxWidth: '100%' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Input Bar */}
        <div
          className="flex items-center gap-3"
          style={{
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-panel)',
          }}
        >
          <Search size={18} className="text-emerald" />
          <input
            ref={inputRef}
            type="text"
            className="font-mono text-sm"
            style={{
              flex: 1,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              color: 'var(--text-main)',
            }}
            placeholder="Type a command, page, device, or coverage ID (e.g. 'install', 'reboot', 'C07')..."
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={handleKeyDown}
          />
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => setIsCommandPaletteOpen(false)}
          >
            <X size={16} />
          </button>
        </div>

        {/* Results List */}
        <div
          style={{
            maxHeight: '380px',
            overflowY: 'auto',
            padding: '6px',
            backgroundColor: 'var(--bg-main)',
          }}
        >
          {filteredItems.length === 0 ? (
            <div className="empty-state" style={{ padding: '30px' }}>
              <div className="text-sm text-dim">No matching commands or pages</div>
            </div>
          ) : (
            filteredItems.map((item, index) => {
              const isSelected = index === selectedIndex;
              return (
                <div
                  key={item.id}
                  onClick={item.action}
                  onMouseEnter={() => setSelectedIndex(index)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    padding: '8px 12px',
                    borderRadius: '6px',
                    cursor: 'pointer',
                    backgroundColor: isSelected
                      ? 'var(--emerald-surface)'
                      : 'transparent',
                    border: isSelected
                      ? '1px solid var(--emerald-border)'
                      : '1px solid transparent',
                    transition: 'background-color 0.12s ease, border-color 0.12s ease',
                  }}
                >
                  <div className="flex items-center gap-3 truncate">
                    {item.type === 'page' && <Layers size={16} className="text-dim" />}
                    {item.type === 'device' && <Smartphone size={16} className="text-emerald" />}
                    {item.type === 'operation' && <Cpu size={16} className="text-info" />}
                    {item.type === 'app' && <FileCode size={16} className="text-emerald" />}

                    <div className="truncate">
                      <div className="text-sm font-semibold text-main truncate">
                        {item.title}
                      </div>
                      {item.subtitle && (
                        <div className="text-xs text-dim truncate">
                          {item.subtitle}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {item.badge && (
                      <span className="badge badge-neutral text-xs font-mono">
                        {item.badge}
                      </span>
                    )}
                    <ArrowRight size={13} className="text-dim" />
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* Footer shortcuts */}
        <div
          className="flex items-center justify-between text-xs text-dim font-mono"
          style={{
            padding: '8px 16px',
            borderTop: '1px solid var(--border-subtle)',
            backgroundColor: 'var(--bg-panel)',
          }}
        >
          <span>Navigate with ↑↓ • Select with Enter • Close with ESC</span>
          <span className="text-emerald">{filteredItems.length} items</span>
        </div>
      </div>
    </div>
  );
};
