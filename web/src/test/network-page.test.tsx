import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NetworkPage } from '../pages/NetworkPage.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import { parseForwardRules, parseReverseRules } from '../lib/deviceStats.js';
import type { Operation } from '../types/api.js';

const s = (output: string, exitCode = 0) => ({ output, exitCode });

function setup() {
  const openOperationModal = vi.fn();
  vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
    selectedDeviceId: 'dev-1',
    findOperation: (id: string) => ({ id, label: id } as Operation),
    openOperationModal,
    runOperation: vi.fn(),
    jobs: [],
  } as any);
  vi.spyOn(api, 'getStats').mockResolvedValue({
    deviceId: 'dev-1', scope: 'network', collectedAt: 1,
    sections: {
      forwards: s('dev-1 tcp:8080 tcp:8081\nother tcp:1 tcp:2'),
      reverses: s('UsbFfs tcp:9000 tcp:9001'),
      proxy: s(':0'),
    },
  } as any);
  return { openOperationModal };
}

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe('port rule parsers', () => {
  it('keeps only this device forward rules and reads reverse rules', () => {
    expect(parseForwardRules('dev-1 tcp:8080 tcp:8081\nother tcp:1 tcp:2', 'dev-1')).toEqual([{ local: 'tcp:8080', remote: 'tcp:8081' }]);
    expect(parseReverseRules(s('UsbFfs tcp:9000 tcp:9001'))).toEqual([{ remote: 'tcp:9000', local: 'tcp:9001' }]);
    expect(parseReverseRules(s('error', 1))).toBeNull();
  });
});

describe('NetworkPage workbench', () => {
  it('lists rules and keeps both create forms', async () => {
    const { openOperationModal } = setup();
    render(<NetworkPage />);
    const list = await screen.findByRole('listbox', { name: 'Port rules' });
    expect(await within(list).findByText('tcp:8080 → tcp:8081')).toBeInTheDocument();
    expect(within(list).getByText('tcp:9000 → tcp:9001')).toBeInTheDocument();
    expect(within(list).queryByText('tcp:1 → tcp:2')).not.toBeInTheDocument();

    expect(screen.getByText('Fail if already bound (--no-rebind)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /create forward rule/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'forward.create' }), { local: 'tcp:8080', remote: 'tcp:8080', noRebind: false });

    fireEvent.click(screen.getByRole('tab', { name: /reverse/i }));
    fireEvent.click(screen.getByRole('button', { name: /create reverse rule/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'reverse.create' }), { remote: 'tcp:9000', local: 'tcp:9000' });
    fireEvent.click(screen.getByTitle('Remove all reverse rules'));
    expect(openOperationModal).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'reverse.remove_all' }));
    expect(screen.getByText('Apply Global Proxy')).toBeInTheDocument();
  });

  it('removes one selected rule and filters from the KPI card', async () => {
    const { openOperationModal } = setup();
    render(<NetworkPage />);
    const list = await screen.findByRole('listbox', { name: 'Port rules' });
    fireEvent.click(await within(list).findByText('tcp:9000 → tcp:9001'));
    fireEvent.click(screen.getByRole('button', { name: /remove rule/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'reverse.remove' }), { remote: 'tcp:9000' });

    fireEvent.click(screen.getByTestId('kpi-card-net-forward-rules'));
    expect(within(list).queryByText('tcp:9000 → tcp:9001')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create forward rule/i })).toBeInTheDocument();
  });
});
