import React from 'react';
import { WorkstationProvider, useWorkstation } from './context/WorkstationContext.js';
import { WorkstationActivity } from './components/WorkstationActivity.js';
import { Header } from './components/Header.js';
import { Sidebar } from './components/Sidebar.js';
import { JobDrawer } from './components/JobDrawer.js';
import { AiDrawer } from './components/AiDrawer.js';
import { ArtifactDrawer } from './components/ArtifactDrawer.js';
import { CommandPalette } from './components/CommandPalette.js';
import { SplashScreen } from './components/SplashScreen.js';
import { LogcatRunner } from './components/LogcatRunner.js';
import { AndroidDrop } from './components/AndroidDrop.js';
import { OperationFormModal } from './components/OperationFormModal.js';
import { HostMonitorModal } from './components/HostMonitorModal.js';
import { HostPhoneModal } from './components/HostPhoneModal.js';

import { OverviewPage } from './pages/OverviewPage.js';
import { ApplicationsPage } from './pages/ApplicationsPage.js';
import { FilesPage } from './pages/FilesPage.js';
import { ShellPage } from './pages/ShellPage.js';
import { LogsPage } from './pages/LogsPage.js';
import { ScreenPage } from './pages/ScreenPage.js';
import { LayoutPage } from './pages/LayoutPage.js';
import { NetworkPage } from './pages/NetworkPage.js';
import { DiagnosticsPage } from './pages/DiagnosticsPage.js';
import { PermissionsPage } from './pages/PermissionsPage.js';
import { RecoveryPage } from './pages/RecoveryPage.js';
import { AutomationPage } from './pages/AutomationPage.js';
import { SettingsPage } from './pages/SettingsPage.js';
import { AiIntegrationPage } from './pages/AiIntegrationPage.js';
import { APP_VERSION } from './version.js';
import { AlertCircle, RefreshCw } from 'lucide-react';

const MainContent: React.FC = () => {
  const { activePage, isJobDrawerOpen, isAiDrawerOpen, isArtifactDrawerOpen, health } = useWorkstation();
  const mainRef = React.useRef<HTMLElement>(null);

  React.useEffect(() => {
    const resetScroll = () => { if (mainRef.current) mainRef.current.scrollTop = 0; };
    resetScroll();
    window.addEventListener('andrui-subtab', resetScroll);
    return () => window.removeEventListener('andrui-subtab', resetScroll);
  }, [activePage]);

  const renderActivePage = () => {
    switch (activePage) {
      case 'overview':
        return <OverviewPage />;
      case 'apps':
        return <ApplicationsPage />;
      case 'files':
        return <FilesPage />;
      case 'shell':
        return <ShellPage />;
      case 'logs':
        return <LogsPage />;
      case 'screen':
        return <ScreenPage />;
      case 'layout':
        return <LayoutPage />;
      case 'network':
        return <NetworkPage />;
      case 'diagnostics':
        return <DiagnosticsPage />;
      case 'permissions':
        return <PermissionsPage />;
      case 'recovery':
        return <RecoveryPage />;
      case 'automation':
        return <AutomationPage />;
      case 'ai':
        return <AiIntegrationPage />;
      case 'settings':
        return <SettingsPage />;
      default:
        return <OverviewPage />;
    }
  };

  // The docked bottom panel publishes its height as --job-drawer-height, --ai-drawer-height or --artifact-drawer-height.
  const bottomPadding = isJobDrawerOpen
    ? 'calc(var(--job-drawer-height, 320px) + 20px)'
    : isAiDrawerOpen
      ? 'calc(var(--ai-drawer-height, 380px) + 20px)'
      : isArtifactDrawerOpen
        ? 'calc(var(--artifact-drawer-height, 320px) + 20px)'
        : '24px';

  return (
    <main
      id="main-content"
      ref={mainRef}
      role="main"
      className="main-content-area flex-1 overflow-auto"
      style={{ paddingBottom: bottomPadding }}
    >
      <div className="workspace-content" style={{ width: '100%' }}>
        {health?.version && health.version !== APP_VERSION && (
          // Typically after a package upgrade while this tab stayed open.
          <div className="alert alert-warning version-mismatch" role="alert">
            <AlertCircle size={16} />
            <span>This page is from AndruiTerminal {APP_VERSION}, but the server is running {health.version}. Reload to use the matching version.</span>
            <button className="btn btn-secondary btn-sm" onClick={() => window.location.reload()}><RefreshCw size={13} />Reload</button>
          </div>
        )}
        {renderActivePage()}
      </div>
    </main>
  );
};

function isMobilePhoneClient(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
}

export const App: React.FC = () => {
  const isMobileOnly = React.useMemo(() => isMobilePhoneClient(), []);
  const [hostMonitorOpen, setHostMonitorOpen] = React.useState<boolean>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('view') === 'host' || window.location.hash === '#host-monitor';
  });
  const [hostPhoneOpen, setHostPhoneOpen] = React.useState(false);

  const openHostOnPhone = React.useCallback(() => {
    setHostPhoneOpen(true);
  }, []);

  // Mobile phones only have access to the Host Resource & Process Monitor when the server is not bound to 0.0.0.0.
  if (isMobileOnly) {
    return <HostMonitorModal open={true} standalone={true} onClose={() => {}} />;
  }

  return (
    <WorkstationProvider>
      <WorkstationActivity>
        <div className="flex flex-col w-full h-full overflow-hidden bg-main">
          <Header onOpenHostMonitor={openHostOnPhone} hostMonitorOpen={hostPhoneOpen} />
          <div className="flex flex-1 overflow-hidden relative">
            <MainContent />
            <Sidebar />
            <JobDrawer />
            <AiDrawer />
            <ArtifactDrawer />
          </div>
          <SplashScreen />
          <LogcatRunner />
          <AndroidDrop />
          <CommandPalette />
          <OperationFormModal />
          <HostPhoneModal open={hostPhoneOpen} onClose={() => setHostPhoneOpen(false)} />
          <HostMonitorModal open={hostMonitorOpen} onClose={() => setHostMonitorOpen(false)} />
        </div>
      </WorkstationActivity>
    </WorkstationProvider>
  );
};

export default App;
