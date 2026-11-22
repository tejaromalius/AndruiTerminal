import { JobAssessment } from '../components/AssessmentWidgets.js';
import { DeviceStatusWidgets } from '../components/AssessmentWidgets.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { PageHeader } from '../components/PageHeader.js';
import React from 'react';
import { useWorkstation } from '../context/WorkstationContext.js';
import { OperationCardList } from '../components/OperationCardList.js';
import { FastbootPanel } from '../components/FastbootPanel.js';
import {
  Power,
  ShieldAlert,
  AlertTriangle,
  Upload,
  RotateCcw,
  Cpu,
  Terminal,
  Zap,
} from 'lucide-react';

interface Action { label: string; hint: string; command: string; icon: React.ReactNode; onClick: () => void; danger?: boolean }

/** Labelled set of action tiles: what each does and the adb command behind it. */
const ActionGroup: React.FC<{ label: string; actions: Action[]; disabled: boolean; danger?: boolean }> = ({ label, actions, disabled, danger }) => (
  <div className={`action-group ${danger ? 'action-group-danger' : ''}`}>
    <span className="action-group-label">{label}</span>
    <div className="action-tiles">
      {actions.map((a) => (
        <button key={a.label} type="button" className={`action-tile ${danger || a.danger ? 'action-tile-danger' : ''}`} onClick={a.onClick} disabled={disabled} title={a.command}>
          <span className="action-tile-icon">{a.icon}</span>
          <span className="action-tile-text">
            <span className="action-tile-label">{a.label}</span>
            <span className="action-tile-hint">{a.hint}</span>
            <code className="action-tile-cmd">{a.command}</code>
          </span>
        </button>
      ))}
    </div>
  </div>
);

export const RecoveryPage: React.FC = () => {
  const [activeTab, setActiveTab] = usePageTab('recovery', 'workspace');
  const {
    selectedDeviceId,
    findOperation,
    openOperationModal,
  } = useWorkstation();

  const handleReboot = (target?: string) => {
    if (!selectedDeviceId) return;
    const op = findOperation('system.reboot');
    if (op) openOperationModal(op, { target: target || '' });
  };

  const handleRootAction = (root: boolean) => {
    if (!selectedDeviceId) return;
    const op = findOperation(root ? 'system.root' : 'system.unroot');
    if (op) {
      openOperationModal(op);
    }
  };

  const handleRemount = () => {
    if (!selectedDeviceId) return;
    const op = findOperation('system.remount');
    if (op) {
      openOperationModal(op, { rebootIfRequired: true });
    }
  };

  const handleVerity = (disable: boolean) => {
    if (!selectedDeviceId) return;
    const op = findOperation(disable ? 'system.disable_verity' : 'system.enable_verity');
    if (op) {
      openOperationModal(op);
    }
  };

  return (
    <div className="workspace-page">
      <PageHeader
        title="System, Recovery & Partition Controls"
        description="Root daemon escalation, partition remount, dm-verity toggles, recovery reboot variants, and OTA sideload"
      />

      {/* Prominent Destructive Safeguard Notice */}
      <div className="alert alert-danger">
        <ShieldAlert size={18} className="text-danger flex-shrink-0" />
        <div>
          <div className="font-semibold text-danger">Safety & Recovery Warning</div>
          <div className="text-xs text-red-300">
            Operations on this page affect firmware, recovery, dm-verity, and device partitions.
            All mutating commands enforce deliberate user confirmation before execution on target device{' '}
            <code className="font-mono font-bold text-main">
              {selectedDeviceId || 'No device selected'}
            </code>.
          </div>
        </div>
      </div>

      <PageTabs page="recovery" value={activeTab} onChange={setActiveTab} tabs={[{
        id: 'workspace', label: 'Workspace', content: <>
          <DeviceStatusWidgets scope="system" deviceId={selectedDeviceId} enabled={activeTab !== 'operations'} />
          <div className="workspace-section-grid">
          <div className="workspace-panel action-panel">
            <h2 className="panel-title"><Power size={16} className="text-emerald" />Reboot Target Variant</h2>
            <ActionGroup label="Boot targets" actions={[
              { label: 'Standard Reboot', hint: 'Restart into Android', command: 'adb reboot', icon: <RotateCcw size={15} />, onClick: () => handleReboot('system') },
              { label: 'Recovery Mode', hint: 'Recovery menu, wipes and updates', command: 'reboot recovery', icon: <Zap size={15} className="text-warning" />, onClick: () => handleReboot('recovery') },
              { label: 'Bootloader / Fastboot', hint: 'Flash partitions over fastboot', command: 'reboot bootloader', icon: <Cpu size={15} className="text-info" />, onClick: () => handleReboot('bootloader') },
              { label: 'Sideload Mode', hint: 'Recovery waiting for an OTA zip', command: 'reboot sideload', icon: <Upload size={15} />, onClick: () => handleReboot('sideload') },
            ]} disabled={!selectedDeviceId} />
            <ActionGroup label="Vendor rescue modes" danger actions={[
              { label: 'Emergency (EDL)', hint: 'Qualcomm emergency download; needs vendor tools to leave', command: 'reboot edl', icon: <AlertTriangle size={15} />, onClick: () => handleReboot('edl') },
              { label: 'Download Mode', hint: 'Samsung Odin download mode', command: 'reboot download', icon: <AlertTriangle size={15} />, onClick: () => handleReboot('download') },
            ]} disabled={!selectedDeviceId} />
          </div>
          <div className="workspace-panel action-panel">
            <h2 className="panel-title"><ShieldAlert size={16} className="text-emerald" />Root, Remount & Verity</h2>
            <ActionGroup label="adbd privileges" actions={[
              { label: 'adb root (Escalate)', hint: 'Restart adbd as root (userdebug/eng builds)', command: 'adb root', icon: <ShieldAlert size={15} className="text-warning" />, onClick: () => handleRootAction(true) },
              { label: 'adb unroot (Drop)', hint: 'Restart adbd as the shell user', command: 'adb unroot', icon: <RotateCcw size={15} />, onClick: () => handleRootAction(false) },
            ]} disabled={!selectedDeviceId} />
            <ActionGroup label="Partitions" actions={[
              { label: 'remount -R', hint: 'Make /system writable, rebooting if needed', command: 'adb remount -R', icon: <Terminal size={15} />, onClick: handleRemount },
              { label: 'disable-verity', hint: 'Turn off dm-verity; needs a reboot', command: 'adb disable-verity', icon: <AlertTriangle size={15} />, onClick: () => handleVerity(true), danger: true },
            ]} disabled={!selectedDeviceId} />
            <ActionGroup label="Rescue tools" actions={[
              { label: 'Sideload OTA Package', hint: 'Send an OTA zip to sideload mode', command: 'adb sideload', icon: <Upload size={15} />, onClick: () => { const op = findOperation('X07') || findOperation('sideload'); if (op) openOperationModal(op); } },
              { label: 'Test Harness Enable', hint: 'Factory-reset into test harness mode', command: 'cmd testharness enable', icon: <Terminal size={15} />, onClick: () => { const op = findOperation('X10') || findOperation('testharness'); if (op) openOperationModal(op); } },
            ]} disabled={!selectedDeviceId} />
          </div>
          </div>
          <JobAssessment prefixes={['fastboot.']} />
          <FastbootPanel />
        </>
      }, {
        id: 'operations', label: 'Operations', content: <>
          <OperationCardList
            category="System"
            coveragePrefix="X"
            title="System & Recovery Operations"
            description="Root escalations, dm-verity, OTA sideloads, trade-in diagnostics, and rescue services"
          />
        </>
      }]} />
    </div>
  );
};
