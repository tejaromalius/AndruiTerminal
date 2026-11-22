import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OverviewPage } from '../pages/OverviewPage.js';
import { api } from '../api/client.js';
import { WORKSPACE_REFRESH_EVENT } from '../components/Header.js';
import type { Job, Operation } from '../types/api.js';

const { state } = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock('../context/WorkstationContext.js', () => ({ useWorkstation: () => state }));
vi.mock('../components/AvdManager.js', () => ({ AvdManager: () => null, EmulatorSnapshots: () => null }));
vi.mock('../components/DeviceExperience.js', () => ({
  DeviceExperience: () => null,
  DeviceGallery: () => null,
  DeviceTimeline: () => null,
  DeviceTasks: () => null,
  DeviceKindIcon: () => null,
  useDeviceProfiles: () => [],
}));
vi.mock('../components/HelperPanel.js', () => ({ HelperPanel: () => null }));
vi.mock('../components/OperationCardList.js', () => ({ OperationCardList: () => null }));

const makeOp = (id: string): Operation => ({
  id,
  label: id,
  category: 'Devices',
  coverageIds: ['C01'],
  available: true,
  description: '',
  requiresDevice: false,
  destructive: false,
  streaming: false,
  fields: [],
});

const makeJob = (id: string, operationId: string): Job => ({
  id,
  operationId,
  status: 'queued',
  stdout: '',
  stderr: '',
  artifactIds: [],
  createdAt: '2026-11-17T12:00:00Z',
});

describe('OverviewPage wireless connections', () => {
  beforeEach(() => {
    sessionStorage.clear();
    const ops = [makeOp('device.connect'), makeOp('device.pair')];
    Object.assign(state, {
      devices: [],
      selectedDeviceId: null,
      setSelectedDeviceId: vi.fn(),
      refreshDevices: vi.fn().mockResolvedValue(undefined),
      devicesLoading: false,
      devicesError: null,
      operations: ops,
      findOperation: (id: string) => ops.find((o) => o.id === id),
      openOperationModal: vi.fn(),
      runOperation: vi.fn(),
      activeJobs: [],
      capabilities: null,
      health: null,
      isWsConnected: true,
      setActivePage: vi.fn(),
    });
    vi.spyOn(api, 'getDiscovery').mockResolvedValue({ available: true, services: [] });
    vi.spyOn(api, 'getHostTelemetry').mockRejectedValue(new Error('offline'));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('displays failed connection error and keeps host input when connect job fails', async () => {
    state.runOperation.mockResolvedValue(makeJob('job-connect-fail', 'device.connect'));
    vi.spyOn(api, 'waitForSuccessfulJob').mockRejectedValue(
      new Error("failed to connect to '192.168.1.100:5555': Connection refused")
    );

    render(<OverviewPage />);

    const hostInput = screen.getByLabelText('Connection host') as HTMLInputElement;
    fireEvent.change(hostInput, { target: { value: '192.168.1.100:5555' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        "failed to connect to '192.168.1.100:5555': Connection refused"
      );
    });
    expect(hostInput.value).toBe('192.168.1.100:5555');
    expect(state.refreshDevices).not.toHaveBeenCalled();
  });

  it('auto-refreshes devices and clears host input when connect job succeeds', async () => {
    const completedJob: Job = { ...makeJob('job-connect-ok', 'device.connect'), status: 'completed' };
    state.runOperation.mockResolvedValue(makeJob('job-connect-ok', 'device.connect'));
    vi.spyOn(api, 'waitForSuccessfulJob').mockResolvedValue(completedJob);

    render(<OverviewPage />);

    const hostInput = screen.getByLabelText('Connection host') as HTMLInputElement;
    fireEvent.change(hostInput, { target: { value: '192.168.1.100:5555' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => {
      expect(state.refreshDevices).toHaveBeenCalledTimes(1);
    });
    expect(hostInput.value).toBe('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('displays failed pairing error and keeps pair inputs when pair job fails', async () => {
    state.runOperation.mockResolvedValue(makeJob('job-pair-fail', 'device.pair'));
    vi.spyOn(api, 'waitForSuccessfulJob').mockRejectedValue(
      new Error('Failed: Unable to start pairing client.')
    );

    render(<OverviewPage />);

    const pairHostInput = screen.getByLabelText('Pairing host') as HTMLInputElement;
    const pairCodeInput = screen.getByLabelText('Pairing code') as HTMLInputElement;
    fireEvent.change(pairHostInput, { target: { value: '192.168.1.100:38291' } });
    fireEvent.change(pairCodeInput, { target: { value: '123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Pair device' }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Failed: Unable to start pairing client.'
      );
    });
    expect(pairHostInput.value).toBe('192.168.1.100:38291');
    expect(pairCodeInput.value).toBe('123456');
  });

  it('does not display duplicate device cards for the same wireless host', () => {
    state.devices = [
      { id: '192.168.10.54:43733', state: 'offline', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 2 },
      { id: '192.168.10.54:46463', state: 'device', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 3 },
    ];
    state.selectedDeviceId = '192.168.10.54:46463';

    render(<OverviewPage />);

    expect(screen.queryByText('192.168.10.54:43733')).toBeNull();
    expect(screen.getByText('192.168.10.54:46463')).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });

  it('plots real nearby mDNS services as interactive radar dots', async () => {
    const completedJob: Job = { ...makeJob('job-radar-connect', 'device.connect'), status: 'completed' };
    state.runOperation.mockResolvedValue(makeJob('job-radar-connect', 'device.connect'));
    vi.spyOn(api, 'waitForSuccessfulJob').mockResolvedValue(completedJob);
    vi.spyOn(api, 'getDiscovery').mockResolvedValue({
      available: true,
      services: [
        {
          name: 'adb-pixel-connect',
          kind: 'connect',
          hostname: 'Pixel-8',
          address: '192.168.1.42',
          port: 41235,
          endpoint: '192.168.1.42:41235',
        },
        {
          name: 'adb-tablet-pair',
          kind: 'pairing',
          hostname: 'Galaxy-Tab',
          address: '192.168.1.77',
          port: 39111,
          endpoint: '192.168.1.77:39111',
        },
      ],
    });

    render(<OverviewPage />);

    const connectDot = await screen.findByRole('button', {
      name: 'Pixel-8 (192.168.1.42:41235) — Click to connect',
    });
    const pairDot = screen.getByRole('button', {
      name: 'Galaxy-Tab (192.168.1.77:39111) — Click to pair',
    });

    fireEvent.click(pairDot);
    expect((screen.getByLabelText('Pairing host') as HTMLInputElement).value).toBe('192.168.1.77:39111');

    fireEvent.click(connectDot);
    await waitFor(() => {
      expect(state.runOperation).toHaveBeenCalledWith('device.connect', { host: '192.168.1.42:41235' });
      expect(state.refreshDevices).toHaveBeenCalledTimes(1);
    });
  });

  it('offers Restart instead of Start while live events show a running ADB server', async () => {
    const ops = [makeOp('server.status'), makeOp('server.start'), makeOp('server.kill')];
    state.findOperation = (id: string) => ops.find((o) => o.id === id);
    state.runOperation.mockImplementation((id: string) => Promise.resolve(makeJob(`job-${id}`, id)));
    vi.spyOn(api, 'waitForSuccessfulJob').mockImplementation((id: string) => Promise.resolve({ ...makeJob(id, id), status: 'completed' }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { rerender } = render(<OverviewPage />);
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
    await waitFor(() => expect(state.refreshDevices).toHaveBeenCalledTimes(1));
    expect(state.runOperation.mock.calls).toEqual([['server.kill', {}, true], ['server.start', {}]]);

    state.isWsConnected = false;
    rerender(<OverviewPage />);
    expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Restart' })).toBeNull();
  });

  it('reloads nearby discovery when the top-bar refresh fires', async () => {
    render(<OverviewPage />);
    await waitFor(() => expect(api.getDiscovery).toHaveBeenCalledTimes(1));
    window.dispatchEvent(new Event(WORKSPACE_REFRESH_EVENT));
    await waitFor(() => expect(api.getDiscovery).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: /Refresh devices|Rescan/ })).toBeNull();
  });

  it('shows host identity and connection state in the host panel', async () => {
    vi.spyOn(api, 'getHostTelemetry').mockResolvedValue({ hostname: 'workbench', kernel: '6.8.0', arch: 'x86_64', uptimeSecs: 3720 } as never);
    state.health = { status: 'ok', mode: 'local', version: '1.2.3' };
    state.activeJobs = [makeJob('job-active', 'device.connect')];

    render(<OverviewPage />);

    expect(await screen.findByText('workbench')).toBeInTheDocument();
    expect(screen.getByText('6.8.0 · x86_64')).toBeInTheDocument();
    expect(screen.getByText('1h 2m')).toBeInTheDocument();
    expect(screen.getByText('local v1.2.3')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.queryByText('Nearby devices')).toBeNull();
    expect(screen.queryByRole('button', { name: /Connect over Wi-Fi/ })).toBeNull();
  });

  it('keeps the radar beside connected devices and skips endpoints already attached', async () => {
    state.devices = [{ id: '192.168.1.42:41235', state: 'device', model: 'Pixel_8', product: 'shiba', transportId: 1 }];
    vi.spyOn(api, 'getDiscovery').mockResolvedValue({
      available: true,
      services: [
        { name: 'adb-pixel-connect', kind: 'connect', hostname: 'Pixel-8', address: '192.168.1.42', port: 41235, endpoint: '192.168.1.42:41235' },
        { name: 'adb-tablet-pair', kind: 'pairing', hostname: 'Galaxy-Tab', address: '192.168.1.77', port: 39111, endpoint: '192.168.1.77:39111' },
      ],
    });

    render(<OverviewPage />);

    expect(await screen.findByRole('button', { name: 'Galaxy-Tab (192.168.1.77:39111) — Click to pair' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Pixel-8 \(192\.168\.1\.42:41235\)/ })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Add another device' })).toBeInTheDocument();
    expect(screen.getAllByRole('article')).toHaveLength(1);
  });
});
