import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PermissionsPage } from '../pages/PermissionsPage.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import type { Operation } from '../types/api.js';

const s = (output: string, exitCode = 0) => ({ output, exitCode });

function setup(deviceId = 'dev-1') {
  const openOperationModal = vi.fn();
  vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
    selectedDeviceId: deviceId,
    findOperation: (id: string) => ({ id, label: id } as Operation),
    openOperationModal,
    runOperation: vi.fn(),
    jobs: [],
  } as any);
  vi.spyOn(api, 'getStats').mockImplementation(async (_d, scope) => ({
    deviceId: 'dev-1', scope, collectedAt: 1,
    sections: scope === 'packages'
      ? {
        packageList: s('package:/data/app/a/base.apk=com.ex.camera\npackage:/system/app/S.apk=com.android.settings'),
        systemPackages: s('package:com.android.settings'),
        disabledPackages: s(''),
      }
      : {},
  }) as any);
  return { openOperationModal };
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe('PermissionsPage workbench', () => {
  it('picks a package from the list and grants a permission to it', async () => {
    const { openOperationModal } = setup();
    render(<PermissionsPage />);
    const list = await screen.findByRole('listbox', { name: 'Packages' });
    fireEvent.click(await within(list).findByText('com.ex.camera'));
    expect(screen.getByPlaceholderText('e.g. com.example.app')).toHaveValue('com.ex.camera');
    fireEvent.click(screen.getByRole('button', { name: /grant \(pm grant\)/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'permission.grant' }), { package: 'com.ex.camera', permission: 'android.permission.POST_NOTIFICATIONS' });
    fireEvent.click(screen.getByRole('button', { name: /set mode/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'appops.set' }), { package: 'com.ex.camera', op: 'CAMERA', mode: 'allow' });
  });

  it('filters system packages and keeps the multi-user actions', async () => {
    const { openOperationModal } = setup('dev-2');
    render(<PermissionsPage />);
    const list = await screen.findByRole('listbox', { name: 'Packages' });
    await within(list).findByText('com.ex.camera');
    fireEvent.click(within(screen.getByRole('group', { name: 'Packages filter' })).getByRole('button', { name: /^System/ }));
    expect(within(list).queryByText('com.ex.camera')).not.toBeInTheDocument();
    expect(within(list).getByText('com.android.settings')).toBeInTheDocument();
    for (const label of [/list users/i, /create new user/i, /verify app links/i, /device policy manager/i]) expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('kpi-card-perm-user-profiles'));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'users.list' }));
  });
});
