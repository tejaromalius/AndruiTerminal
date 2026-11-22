import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FastbootPanel, parseGetvar } from '../components/FastbootPanel.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import type { Operation } from '../types/api.js';

afterEach(() => vi.restoreAllMocks());

const GETVAR = '(bootloader) current-slot: b\n(bootloader) partition-size:boot_a: 0x4000000\nFinished. Total time: 0.012s';

describe('FastbootPanel', () => {
  it('parses getvar lines, keeping colons inside keys', () => {
    expect(parseGetvar(GETVAR)).toEqual([['current-slot', 'b'], ['partition-size:boot_a', '0x4000000']]);
  });

  it('does not claim an active slot until getvar reports one', async () => {
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      selectedDeviceId: 'dev-1', findOperation: (id: string) => ({ id, label: id } as Operation), runOperation: vi.fn().mockResolvedValue({ id: 'j1' }),
    } as any);
    vi.spyOn(api, 'waitForJob').mockResolvedValue({ id: 'j1', operationId: 'fastboot.getvar', status: 'completed', exitCode: 0, stdout: '', stderr: GETVAR, artifactIds: [], createdAt: '' });
    render(<FastbootPanel />);
    expect(screen.getByText('unknown')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'getvar' }));
    expect(await screen.findByText('Set Slot B · active')).toBeInTheDocument();
    expect(screen.getByText('partition-size:boot_a')).toBeInTheDocument();
  });
});
