import { PackageInspection } from '../components/AssessmentWidgets.js';
import { parsePackageList, useAppSelection } from '../lib/packageList.js';
import { WorkbenchItem, WorkbenchList } from '../components/WorkbenchList.js';
import { CopyButton } from '../components/AppDetail.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React, { useMemo, useState } from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { TabKpiGrid } from '../components/TabKpiGrid.js';
import { SecurityResearchPanel } from '../components/SecurityResearchPanel.js';
import { useDeviceStats, statsPendingReason } from '../lib/useDeviceStats.js';
import { UserPolicyPanel } from '../components/UserPolicyPanel.js';
import { firstLine, parseFirstLine, parseOwners, parseUsers } from '../lib/deviceStats.js';
import {
  ShieldCheck,
  Users,
  Lock,
  Globe,
  RefreshCw,
  AlertCircle,
  CheckCircle,
  Package,
} from 'lucide-react';

const PACKAGE_FILTERS = [{ id: 'all', label: 'All' }, { id: 'user', label: 'User (-3)' }, { id: 'system', label: 'System (-s)' }, { id: 'disabled', label: 'Disabled (-d)' }];
const packageItem = (name: string, tags: string[] = []): WorkbenchItem => ({ id: name, title: name.split('.').pop() || name, subtitle: name, tags });

export const PermissionsPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('permissions', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    openOperationModal,
  } = useWorkstation();

  const policy = useDeviceStats('permissions', selectedDeviceId, 30000, { enabled: activeTab !== 'operations' });
  const pending = statsPendingReason(selectedDeviceId, policy);
  const sec = policy.stats?.sections;
  const users = parseUsers(sec?.users?.output ?? null);
  const owners = parseOwners(sec?.owners);
  const selinux = parseFirstLine(sec, 'selinux');
  const patch = parseFirstLine(sec, 'patch');
  const rootLine = parseFirstLine(sec, 'root');
  const isAdbRoot = rootLine?.includes('uid=0(root)') ?? false;
  const suLine = parseFirstLine(sec, 'su');
  const hasSu = Boolean(suLine && !suLine.includes('not found') && !suLine.includes('no su'));
  const buildType = parseFirstLine(sec, 'buildType');

  // Permission form
  // Shared with the Applications page so a package picked there is ready here.
  const { selected: pkgName, setDraft: setPkgName, select: selectPkg, pinned, recent, togglePin } = useAppSelection(selectedDeviceId);
  const packages = useDeviceStats('packages', selectedDeviceId, 0, { enabled: activeTab !== 'operations' });
  const appList = useMemo(() => parsePackageList(packages.stats?.sections), [packages.stats]);
  const [pkgFilter, setPkgFilter] = useState('all');
  const packageItems = useMemo(() => appList?.map((a) => packageItem(a.name, [
    ...(a.system === false ? ['user'] : []), ...(a.system ? ['system'] : []), ...(a.disabled ? ['disabled'] : []),
  ])) ?? null, [appList]);
  const [permissionName, setPermissionName] = useState('android.permission.POST_NOTIFICATIONS');

  // AppOps form
  const [appOpName, setAppOpName] = useState('CAMERA');
  const [appOpMode, setAppOpMode] = useState('allow');

  const handleGrantPermission = async (grant: boolean) => {
    if (!pkgName || !permissionName || !selectedDeviceId) return;
    const op = findOperation(grant ? 'permission.grant' : 'permission.revoke');
    if (op) openOperationModal(op, { package: pkgName, permission: permissionName });
  };

  const handleAppOp = async () => {
    if (!pkgName || !selectedDeviceId) return;
    const op = findOperation('appops.set');
    if (op) {
      openOperationModal(op, {
        package: pkgName,
        op: appOpName,
        mode: appOpMode,
      });
    }
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="Users, Permissions & Policy Manager"
        description="Runtime permission grants, AppOps restrictions, multi-user profiles, and Device Policy Manager"
      />

      {!selectedDeviceId && (
        <div className="alert alert-warning">
          <AlertCircle size={16} />
          <span>No device selected. Please select a target device in the top bar.</span>
        </div>
      )}

      <PageTabs page="permissions" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <TabKpiGrid
            items={[
              {
                id: 'perm-user-profiles',
                label: 'User Profiles',
                value: pending ? '—' : users ? users.total : 'Unavailable',
                subtext: pending ?? (users ? `${users.running} running (pm list users)` : firstLine(sec?.users)),
                icon: Users,
                color: 'var(--emerald-accent)',
                onClick: selectedDeviceId ? () => { const op = findOperation('users.list'); if (op) openOperationModal(op); } : undefined,
              },
              {
                id: 'perm-owners',
                label: 'Device / Profile Owners',
                value: pending ? '—' : owners ? owners.length : 'Unavailable',
                subtext: pending ?? (owners ? owners[0] ?? 'No admin owns this device' : firstLine(sec?.owners)),
                icon: Globe,
                color: 'var(--color-purple)',
              },
              {
                id: 'perm-selinux',
                label: 'SELinux Mode',
                value: pending ? '—' : selinux ?? 'Unavailable',
                subtext: pending ?? 'Kernel mandatory access control (getenforce)',
                icon: Lock,
                badge: selinux === 'Permissive' ? 'Not enforcing' : undefined,
                badgeType: 'warning',
                color: 'var(--color-info)',
              },
              {
                id: 'perm-security-patch',
                label: 'Security Patch',
                value: pending ? '—' : patch ?? 'Unavailable',
                subtext: pending ?? 'ro.build.version.security_patch',
                icon: ShieldCheck,
                color: 'var(--color-success)',
              },
            ]}
          />
          <div className="app-workbench">
            <WorkbenchList
              items={packageItems}
              label="Packages"
              placeholder="Filter packages…"
              filters={PACKAGE_FILTERS}
              filter={pkgFilter}
              onFilter={setPkgFilter}
              selected={pkgName}
              onSelect={selectPkg}
              pinned={pinned.map((n) => packageItem(n))}
              recent={recent.map((n) => packageItem(n))}
              isPinned={(n) => pinned.includes(n)}
              onTogglePin={(item) => togglePin(item.id)}
              toolbar={
                <button type="button" className="btn btn-secondary btn-sm" onClick={packages.refresh} disabled={!selectedDeviceId || packages.loading} title="Reload package list">
                  <RefreshCw size={13} className={packages.loading ? 'animate-spin' : undefined} />
                </button>
              }
              status={
                !selectedDeviceId ? <div className="text-xs text-dim">Select a device to list its packages.</div>
                  : packages.error ? <div className="text-xs text-rose-400">Package list unavailable: {packages.error}</div>
                    : !appList ? <div className="text-xs text-dim">Reading package list…</div>
                      : null
              }
              noMatch={(q) => `No package matches “${q}”. Type the exact name in the Package Name field instead.`}
            />
            <div className="workbench-detail-stack">
            <div className="workspace-panel app-detail">
              <div className="app-detail-head">
                <div className="app-detail-title">
                  <ShieldCheck size={16} className="text-emerald" />
                  <h2 className="panel-title">Runtime Permissions & AppOps</h2>
                </div>
                <div className="app-detail-facts text-xs">
                  {pkgName ? <><Package size={12} /><span className="font-mono">{pkgName}</span><CopyButton value={pkgName} label="package name" /></>
                    : <span className="text-dim">Pick a package from the list or type its name below.</span>}
                </div>
              </div>

              <div className="flex flex-col gap-2">
                <div>
                  <label className="text-xs text-dim">Package Name</label>
                  <input
                    type="text"
                    className="input text-xs font-mono"
                    placeholder="e.g. com.example.app"
                    value={pkgName}
                    onChange={(e) => setPkgName(e.target.value)}
                  />
                </div>

                <div>
                  <label className="text-xs text-dim">Permission Identifier</label>
                  <input
                    type="text"
                    className="input text-xs font-mono"
                    placeholder="e.g. android.permission.CAMERA"
                    value={permissionName}
                    onChange={(e) => setPermissionName(e.target.value)}
                  />
                </div>
              </div>

              {/* Quick Permission Actions */}
              <div className="widget-actions mt-1">
                <button
                  className="btn btn-danger btn-sm"
                  onClick={() => handleGrantPermission(false)}
                  disabled={!pkgName || !permissionName || !selectedDeviceId}
                >
                  <span>Revoke (pm revoke)</span>
                </button>
                <button
                  className="btn btn-primary btn-sm"
                  onClick={() => handleGrantPermission(true)}
                  disabled={!pkgName || !permissionName || !selectedDeviceId}
                >
                  <CheckCircle size={12} />
                  <span>Grant (pm grant)</span>
                </button>
              </div>

              {/* AppOps Control Sub-row */}
              <div className="pt-2 border-t border-slate-800 flex flex-col gap-2">
                <label className="text-xs text-dim font-medium">AppOps Operations</label>
                <div className="flex gap-2">
                  <select
                    className="select text-xs font-mono flex-1"
                    value={appOpName}
                    onChange={(e) => setAppOpName(e.target.value)}
                  >
                    <option value="CAMERA">CAMERA</option>
                    <option value="RECORD_AUDIO">RECORD_AUDIO</option>
                    <option value="FINE_LOCATION">FINE_LOCATION</option>
                    <option value="POST_NOTIFICATION">POST_NOTIFICATION</option>
                    <option value="SYSTEM_ALERT_WINDOW">SYSTEM_ALERT_WINDOW</option>
                  </select>
                  <select
                    className="select text-xs font-mono"
                    style={{ width: '100px' }}
                    value={appOpMode}
                    onChange={(e) => setAppOpMode(e.target.value)}
                  >
                    <option value="allow">allow</option>
                    <option value="ignore">ignore</option>
                    <option value="deny">deny</option>
                    <option value="default">default</option>
                  </select>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={handleAppOp}
                    disabled={!pkgName || !selectedDeviceId}
                  >
                    <span>Set Mode</span>
                  </button>
                </div>
              </div>
            </div>
            <PackageInspection packageName={pkgName} deviceId={selectedDeviceId} enabled={activeTab !== 'operations'} />
            </div>
          </div>
          <UserPolicyPanel deviceId={selectedDeviceId} packageName={pkgName} usersText={sec?.users?.output ?? null} owners={owners}
            onRefresh={policy.refresh} refreshing={policy.loading} />
          <SecurityResearchPanel
            deviceId={selectedDeviceId}
            isAdbRoot={isAdbRoot}
            hasSu={hasSu}
            buildType={buildType}
            selinuxMode={selinux}
          />
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="Packages"
            coveragePrefix="P"
            title="Permission & Profile Operations"
            description="AppOps restrictions, user profile creation, and device policy controls"
          />
        </>
      }]} />
    </div>
  );
};
