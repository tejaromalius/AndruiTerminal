import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useMemo, useRef, useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid } from '../components/TabKpiGrid.js';
import { AppList, AppFilter } from '../components/AppList.js';
import { AppDetail, DetailTab } from '../components/AppDetail.js';
import { InstallDrawer } from '../components/InstallDrawer.js';
import { useDeviceStats, statsPendingReason } from '../lib/useDeviceStats.js';
import { firstLine, parseCount } from '../lib/deviceStats.js';
import { parseForeground, parsePackageList, useAppSelection } from '../lib/packageList.js';
import { Package, Play, AlertTriangle, CheckCircle, Layers } from 'lucide-react';

export const ApplicationsPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('apps', 'workspace');
  const { selectedDeviceId, jobs } = useWorkstation();

  const apps = useDeviceStats('applications', selectedDeviceId, 15000, { enabled: activeTab !== 'operations' });
  const pending = statsPendingReason(selectedDeviceId, apps);
  const sec = apps.stats?.sections;
  const allPackages = parseCount(sec, 'all');
  const systemPackages = parseCount(sec, 'system');
  const thirdPartyPackages = parseCount(sec, 'thirdParty');
  const disabledPackages = parseCount(sec, 'disabled');
  const psRows = parseCount(sec, 'processes');
  const processes = psRows !== null && psRows > 0 ? psRows - 1 : null; // minus the header row
  const installJobs = jobs.filter(
    (j) => j.deviceId === selectedDeviceId && j.operationId.startsWith('package.install') && ['completed', 'failed', 'cancelled'].includes(j.status)
  );
  const installOk = installJobs.filter((j) => j.status === 'completed' && (j.exitCode ?? 0) === 0).length;

  // Package list (fetched once per device; reloaded on demand and after installs).
  const packages = useDeviceStats('packages', selectedDeviceId, 0, { enabled: activeTab !== 'operations' });
  const appList = useMemo(() => parsePackageList(packages.stats?.sections), [packages.stats]);
  const selection = useAppSelection(selectedDeviceId);
  const selectedEntry = appList?.find((a) => a.name === selection.selected) ?? null;
  const [filter, setFilter] = useState<AppFilter>('all');
  const [detailTab, setDetailTab] = useState<DetailTab>('overview');

  // In the single-column layout the detail sits below the list; bring it into view after a pick.
  const workbenchRef = useRef<HTMLDivElement>(null);
  const pick = (pkg: string) => {
    selection.select(pkg);
    requestAnimationFrame(() => {
      const [list, detail] = Array.from(workbenchRef.current?.children ?? []) as HTMLElement[];
      if (list && detail && detail.offsetTop > list.offsetTop + 20) detail.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const [installOpen, setInstallOpenState] = useState(false);
  const [installClosing, setInstallClosing] = useState(false);
  // Closing plays the collapse animation; the panel unmounts when it ends.
  const setInstallOpen = (open: boolean) => {
    if (open) { setInstallOpenState(true); setInstallClosing(false); }
    else if (installOpen) setInstallClosing(true);
  };
  const [installFile, setInstallFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);

  const [foregroundBusy, setForegroundBusy] = useState(false);
  const [foregroundNote, setForegroundNote] = useState<string | null>(null);
  const readForeground = async () => {
    if (!selectedDeviceId) return;
    setForegroundBusy(true);
    setForegroundNote(null);
    try {
      const found = parseForeground((await api.getStats(selectedDeviceId, 'foreground')).sections);
      if (found) pick(found.package);
      else setForegroundNote('No resumed activity reported (screen off or locked?).');
    } catch (err) {
      setForegroundNote(`Foreground app unavailable: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setForegroundBusy(false);
    }
  };

  const onDrop = (e: React.DragEvent) => {
    const file = [...e.dataTransfer.files].find((f) => /\.(apk|apex)$/i.test(f.name));
    setDragging(false);
    if (!file) return;
    e.preventDefault();
    setInstallFile(file);
    setInstallOpen(true);
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="Applications & Package Lifecycle"
        description="Install APK/APEX splits, control process lifecycle, query packages, and inspect permissions"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertTriangle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      <PageTabs page="apps" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <TabKpiGrid
            items={[
              {
                id: 'app-installed-packages',
                label: 'Installed Packages',
                value: pending ? '—' : allPackages ?? 'Unavailable',
                subtext: pending ?? (systemPackages !== null && thirdPartyPackages !== null ? `${systemPackages} system · ${thirdPartyPackages} third-party` : firstLine(sec?.all)),
                icon: Package,
                color: 'var(--emerald-accent)',
                onClick: () => setFilter('all'),
              },
              {
                id: 'app-disabled-packages',
                label: 'Disabled Packages',
                value: pending ? '—' : disabledPackages ?? 'Unavailable',
                subtext: pending ?? 'pm list packages -d',
                icon: Layers,
                color: 'var(--color-info)',
                onClick: () => setFilter('disabled'),
              },
              {
                id: 'app-active-processes',
                label: 'Running Processes',
                value: pending ? '—' : processes ?? 'Unavailable',
                subtext: pending ?? (processes !== null ? 'All processes (ps -A)' : firstLine(sec?.processes)),
                icon: Play,
                color: 'var(--color-success)',
                onClick: () => setFilter('running'),
              },
              {
                id: 'app-install-results',
                label: 'Install Results',
                value: !selectedDeviceId ? '—' : installJobs.length ? `${installOk} / ${installJobs.length}` : 'None yet',
                subtext: !selectedDeviceId
                  ? 'No device selected'
                  : installJobs.length
                    ? `Succeeded · ${installJobs.length - installOk} failed or cancelled`
                    : 'Install jobs recorded for this device',
                icon: CheckCircle,
                badge: installJobs.length > installOk ? `${installJobs.length - installOk} failed` : undefined,
                badgeType: 'danger',
                color: 'var(--color-purple)',
                onClick: () => setInstallOpen(true),
              },
            ]}
          />
          {installOpen && (
            <div className={`install-drawer-wrap ${installClosing ? 'closing' : ''}`}
              onAnimationEnd={(e) => { if (installClosing && e.target === e.currentTarget) { setInstallOpenState(false); setInstallClosing(false); } }}>
            <InstallDrawer
              file={installFile}
              onFile={setInstallFile}
              selectedPackage={selection.selected}
              onClose={() => setInstallOpen(false)}
              onInstalled={(pkg) => { packages.refresh(); if (pkg) selection.select(pkg); }}
            />
            </div>
          )}
          <div
            ref={workbenchRef}
            className={`app-workbench ${dragging ? 'app-workbench-drop' : ''}`}
            onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) { e.preventDefault(); setDragging(true); } }}
            onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false); }}
            onDrop={onDrop}
          >
            <AppList
              apps={appList}
              loading={packages.loading}
              error={packages.error}
              deviceReady={!!selectedDeviceId}
              selected={selection.selected}
              pinned={selection.pinned}
              recent={selection.recent}
              filter={filter}
              onFilter={setFilter}
              onSelect={pick}
              onTogglePin={selection.togglePin}
              onRefresh={packages.refresh}
              onInstall={() => setInstallOpen(true)}
              onForeground={() => void readForeground()}
              foregroundBusy={foregroundBusy}
              foregroundNote={foregroundNote}
            />
            {selection.selected ? (
              <AppDetail key={`${selectedDeviceId}/${selection.selected}`} deviceId={selectedDeviceId} pkg={selection.selected}
                entry={selectedEntry} tab={detailTab} onTab={setDetailTab} />
            ) : (
              <div className="workspace-panel app-detail-empty">
                <Package size={24} className="text-dim" />
                <p className="text-xs text-dim">Pick an app from the list, use the foreground app, or drop an .apk / .apex here to install it.</p>
                <p className="text-xs text-dim app-hints"><kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> open · <span aria-hidden="true">★</span> pin</p>
              </div>
            )}
          </div>
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Packages"
            coveragePrefix="P"
            title="Package Management Operations"
            description="Standalone/split install, launch intents, disable/enable, and package queries"
          />
        </>
      }]} />
    </div>
  );
};
