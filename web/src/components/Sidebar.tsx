import React from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { PageId } from '../types/api.js';
import { SidebarIndicator } from './WorkstationActivity.js';
import { APP_VERSION } from '../version.js';
import { ANTENNA_WIGGLE_EVENT } from './AndruiGlyph.js';
import { LOGCAT_RUNNER_EVENT } from './LogcatRunner.js';
import { getPageTab, selectPageTab } from './PageTabs.js';
import {
  Smartphone,
  Package,
  Folder,
  Terminal,
  FileText,
  MonitorPlay,
  Layers,
  Network,
  Activity,
  ShieldCheck,
  RefreshCw,
  Cpu,
  Bot,
  Settings,
  LucideIcon,
  ChevronDown,
} from 'lucide-react';

interface NavItem {
  id: PageId;
  label: string;
  icon: LucideIcon;
  badge?: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview / Devices', icon: Smartphone },
  { id: 'apps', label: 'Applications', icon: Package },
  { id: 'files', label: 'Files / Data', icon: Folder },
  { id: 'shell', label: 'Shell & Terminal', icon: Terminal },
  { id: 'logs', label: 'Logs & Logcat', icon: FileText },
  { id: 'screen', label: 'Screen & Media', icon: MonitorPlay },
  { id: 'layout', label: 'Layout & Accessibility', icon: Layers },
  { id: 'network', label: 'Network Mappings', icon: Network },
  { id: 'diagnostics', label: 'Diagnostics & Perf', icon: Activity },
  { id: 'permissions', label: 'Users & Policy', icon: ShieldCheck },
  { id: 'recovery', label: 'System & Recovery', icon: RefreshCw },
  { id: 'automation', label: 'Workflows & Automation', icon: Cpu },
  { id: 'ai', label: 'AI Integration', icon: Bot },
  { id: 'settings', label: 'Capabilities & Config', icon: Settings },
];

export const Sidebar: React.FC = () => {
  const {
    activePage,
    setActivePage,
    capabilities,
    health,
    operations,
    isMobileNavOpen,
    setIsMobileNavOpen,
  } = useWorkstation();

  const [expandedPage, setExpandedPage] = React.useState<PageId | null>(activePage);
  const [activeSection, setActiveSection] = React.useState(() => getPageTab(activePage));
  React.useEffect(() => {
    setExpandedPage(activePage);
    setActiveSection(getPageTab(activePage));
    const updateSection = (event: Event) => {
      const detail = (event as CustomEvent<{ page: PageId; tab: string }>).detail;
      if (detail.page === activePage) setActiveSection(detail.tab);
    };
    window.addEventListener('andrui-subtab', updateSection);
    return () => window.removeEventListener('andrui-subtab', updateSection);
  }, [activePage]);
  React.useEffect(() => {
    const closeMobileNavigation = () => setIsMobileNavOpen(false);
    window.addEventListener('andrui-section-chosen', closeMobileNavigation);
    return () => window.removeEventListener('andrui-section-chosen', closeMobileNavigation);
  }, [setIsMobileNavOpen]);

  // Like Android's "build number" tap: seven quick taps on the version wiggle the antennae; three more open Logcat Runner.
  const [versionNote, setVersionNote] = React.useState<string | null>(null);
  const taps = React.useRef({ count: 0, last: 0 });
  const tapVersion = () => {
    const now = Date.now();
    taps.current.count = now - taps.current.last > 2000 ? 1 : taps.current.count + 1;
    taps.current.last = now;
    if (taps.current.count === 7) {
      window.dispatchEvent(new Event(ANTENNA_WIGGLE_EVENT));
      setVersionNote('You are now a developer!');
      window.setTimeout(() => setVersionNote(null), 3000);
    } else if (taps.current.count === 10) {
      taps.current.count = 0;
      window.dispatchEvent(new Event(LOGCAT_RUNNER_EVENT));
    }
  };

  const groups = [
    { label: 'Workspace', items: NAV_ITEMS.slice(0, 3) },
    { label: 'Inspect & control', items: NAV_ITEMS.slice(3, 9) },
    { label: 'Manage', items: NAV_ITEMS.slice(9) },
  ];

  return (
    <>
      {isMobileNavOpen && <div className="sidebar-backdrop" onClick={() => setIsMobileNavOpen(false)} aria-label="Close sidebar backdrop" />}
      <aside className={`sidebar-container ${isMobileNavOpen ? 'open' : ''}`}>
        <nav className="sidebar-nav" aria-label="Workstation views">
          {groups.map(group => (
            <div className="nav-group" key={group.label}>
              <p className="nav-group-label">{group.label}</p>
              {group.items.map(item => {
                const Icon = item.icon;
                const hasSections = item.id !== 'ai' && item.id !== 'settings';
                const expanded = hasSections && expandedPage === item.id;
                return <div className="nav-accordion" key={item.id}><button className={`nav-item ${activePage === item.id ? 'active' : ''}`}
                  aria-label={item.label}
                  aria-describedby={`nav-status-${item.id}`}
                  aria-current={activePage === item.id ? 'page' : undefined}
                  aria-expanded={hasSections ? expanded : undefined}
                  aria-controls={hasSections ? `sidebar-sections-${item.id}` : undefined}
                  onClick={() => {
                    setExpandedPage(expanded && activeSection !== 'operations' ? null : item.id);
                    setActiveSection('workspace');
                    selectPageTab(item.id, 'workspace');
                    setActivePage(item.id);
                    setIsMobileNavOpen(false);
                  }}>
                  <Icon size={17} strokeWidth={1.6} /><span className="nav-label" title={item.label}>{item.label}</span>
                  <SidebarIndicator page={item.id} />
                  {hasSections ? <ChevronDown className={`nav-accordion-chevron ${expanded ? 'expanded' : ''}`} size={12} aria-hidden="true" /> : <span className="nav-chevron-spacer" aria-hidden="true" />}
                </button>
                  <div id={`sidebar-sections-${item.id}`} className="nav-subsections" hidden={!expanded} />
                </div>;
              })}
            </div>
          ))}
        </nav>
        <div className="sidebar-system">
          <p className="nav-group-label">Host environment</p>
          <div><span>ADB version</span><span className="truncate">{capabilities?.adbVersion || 'Unavailable'}</span></div>
          <div><span>Operation catalog</span><span>{operations.length}</span></div>
          <div><span>AndruiTerminal</span>
            <button type="button" className="version-tap font-mono" onClick={tapVersion}>{versionNote ?? `v${health?.version || APP_VERSION}`}</button>
          </div>
          <div><span>Capabilities</span><span>{capabilities?.capabilities.filter(c => c.available).length || 0} / {capabilities?.capabilities.length || 0}</span></div>
        </div>
      </aside>
    </>
  );
};
