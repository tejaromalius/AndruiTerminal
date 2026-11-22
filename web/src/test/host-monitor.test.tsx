import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { HostMonitorModal } from '../components/HostMonitorModal.js';
import { HostPhoneModal } from '../components/HostPhoneModal.js';
import { WorkstationProvider } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';

vi.mock('../api/client.js', () => ({
  api: {
    getHostTelemetry: vi.fn(),
    getHostReverseStatus: vi.fn(),
    setHostReverse: vi.fn(),
    openHostOnPhone: vi.fn(),
    listDevices: vi.fn(async () => [{ id: 'RF8M10ABCDE', state: 'device', model: 'Pixel_8' }]),
    getDevices: vi.fn(async () => [{ id: 'RF8M10ABCDE', state: 'device', model: 'Pixel_8' }]),
    getSession: vi.fn(async () => 'csrf'),
    getEventsWebSocketUrl: vi.fn(() => 'ws://127.0.0.1/api/v1/events'),
    getCapabilities: vi.fn(async () => ({ adbVersion: '34.0.4', capabilities: [], mode: 'native' })),
    getOperations: vi.fn(async () => []),
    getJobs: vi.fn(async () => []),
    getHealth: vi.fn(async () => ({ status: 'ok', mode: 'native', version: '1.0.0' })),
    getSettings: vi.fn(async () => ({ adbPath: 'adb', dataDir: './data' })),
  },
}));

const sampleTelemetry = {
  collectedAt: 1700000000000,
  hostname: 'andrui-workstation',
  kernel: '6.8.0-generic',
  arch: 'x86_64',
  uptimeSecs: 7540,
  cpu: {
    model: 'AMD Ryzen 9 7940HS',
    cores: 16,
    usagePercent: 24.5,
    perCorePercent: [18.0, 32.0, 12.5, 40.0],
    loadAvg: [1.42, 1.15, 0.98] as [number, number, number],
    frequencyMhz: 3850,
  },
  memory: {
    totalKb: 32 * 1024 * 1024,
    availableKb: 18 * 1024 * 1024,
    usedKb: 14 * 1024 * 1024,
    cachedKb: 4 * 1024 * 1024,
    buffersKb: 512 * 1024,
    swapTotalKb: 8 * 1024 * 1024,
    swapUsedKb: 256 * 1024,
    usagePercent: 43.8,
  },
  disks: [
    {
      mountPoint: '/',
      device: '/dev/nvme0n1p2',
      fsType: 'ext4',
      totalBytes: 500 * 1024 ** 3,
      usedBytes: 210 * 1024 ** 3,
      availableBytes: 290 * 1024 ** 3,
      usagePercent: 42.0,
    },
  ],
  network: [
    {
      interface: 'wlan0',
      rxBytes: 120_000_000,
      txBytes: 45_000_000,
      rxBytesPerSec: 125_000,
      txBytesPerSec: 32_000,
    },
  ],
  thermals: [{ label: 'x86_pkg_temp', tempC: 54.2 }],
  battery: { capacityPercent: 86, status: 'Discharging' },
  gpus: [
    {
      name: 'NVIDIA GeForce RTX 3060 Laptop GPU',
      driver: 'nvidia',
      pciSlot: '0000:01:00.0',
      suspended: false,
      usagePercent: 61.0,
      memoryUsedBytes: 2 * 1024 ** 3,
      memoryTotalBytes: 6 * 1024 ** 3,
      tempC: 64,
      frequencyMhz: null,
    },
    {
      name: 'Intel GPU',
      driver: 'i915',
      pciSlot: '0000:00:02.0',
      suspended: true,
      usagePercent: null,
      memoryUsedBytes: null,
      memoryTotalBytes: null,
      tempC: null,
      frequencyMhz: null,
    },
  ],
  processSummary: { total: 240, running: 3, sleeping: 237, threads: 912 },
  processes: [
    {
      pid: 4242,
      ppid: 1,
      uid: 1000,
      name: 'andrui-terminal',
      cmdline: '/usr/bin/andrui-terminal serve --bind 127.0.0.1:19801',
      state: 'R',
      cpuPercent: 12.4,
      rssKb: 98304,
      threads: 14,
    },
    {
      pid: 1200,
      ppid: 1,
      uid: 1000,
      name: 'firefox',
      cmdline: '/usr/lib/firefox/firefox',
      state: 'S',
      cpuPercent: 6.1,
      rssKb: 1048576,
      threads: 48,
    },
  ],
};

describe('HostMonitorModal', () => {
  beforeEach(() => {
    vi.mocked(api.getHostTelemetry).mockResolvedValue(sampleTelemetry);
    localStorage.removeItem('andrui_theme');
    document.documentElement.removeAttribute('data-theme');
  });

  it('renders host telemetry, gauges, and filters processes', async () => {
    const onClose = vi.fn();
    render(<HostMonitorModal open={true} onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText('andrui-workstation')).toBeInTheDocument();
    });

    expect(screen.getByText('24.5%')).toBeInTheDocument();
    expect(screen.getByText('43.8%')).toBeInTheDocument();
    expect(screen.getByText('61.0%')).toBeInTheDocument();
    expect(screen.getByText('2.00 GiB / 6.00 GiB')).toBeInTheDocument();
    expect(screen.getByText('SLEEPING')).toBeInTheDocument();
    expect(screen.getByText('andrui-terminal')).toBeInTheDocument();
    expect(screen.getByText('firefox')).toBeInTheDocument();

    const filterInput = screen.getByLabelText('Filter host processes');
    fireEvent.change(filterInput, { target: { value: 'andrui' } });

    expect(screen.getByText('andrui-terminal')).toBeInTheDocument();
    expect(screen.queryByText('firefox')).not.toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Close Host Monitor'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('switches themes in standalone mode and persists selection alongside keep-screen-on', async () => {
    localStorage.setItem('andrui_theme', 'midnight');
    render(<HostMonitorModal open={true} standalone={true} onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('andrui-workstation')).toBeInTheDocument();
    });

    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');
    expect(screen.getByLabelText('Toggle keep screen on')).toBeInTheDocument();

    const themeBtn = screen.getByLabelText('Change theme');
    fireEvent.click(themeBtn);
    expect(screen.getByRole('menu', { name: 'Theme selection' })).toBeInTheDocument();

    const options = screen.getAllByRole('menuitemradio');
    expect(options).toHaveLength(10);

    // Click the Light variant of Graphite Workbench (emerald-light)
    const lightGraphite = options.find(
      (el) => el.textContent?.includes('Graphite Workbench') && el.closest('.hm-theme-section')?.textContent?.startsWith('Light')
    );
    expect(lightGraphite).toBeDefined();
    fireEvent.click(lightGraphite!);

    expect(document.documentElement.getAttribute('data-theme')).toBe('emerald-light');
    expect(localStorage.getItem('andrui_theme')).toBe('emerald-light');
    expect(screen.queryByRole('menu', { name: 'Theme selection' })).not.toBeInTheDocument();
  });
});

describe('HostPhoneModal', () => {
  it('asks for confirmation and launches the host dashboard on the selected device', async () => {
    vi.mocked(api.getHostReverseStatus).mockResolvedValue({
      deviceId: 'RF8M10ABCDE',
      port: 19801,
      active: false,
      autoReverse: false,
      url: 'http://127.0.0.1:19801/?view=host',
    });
    const openSpy = vi
      .mocked(api.openHostOnPhone)
      .mockResolvedValue({ deviceId: 'RF8M10ABCDE', port: 19801, url: 'http://127.0.0.1:19801/?view=host' });

    render(
      <WorkstationProvider>
        <HostPhoneModal open={true} onClose={vi.fn()} />
      </WorkstationProvider>
    );

    const confirmBtn = await screen.findByRole('button', { name: 'Open on phone' });
    await waitFor(() => expect(confirmBtn).toBeEnabled());
    expect(openSpy).not.toHaveBeenCalled();

    fireEvent.click(confirmBtn);
    await waitFor(() => expect(openSpy).toHaveBeenCalledWith('RF8M10ABCDE', true));
    expect(await screen.findByText(/http:\/\/127\.0\.0\.1:19801\/\?view=host/)).toBeInTheDocument();
  });

  it('displays reverse proxy status and allows enabling and disabling', async () => {
    vi.mocked(api.getHostReverseStatus).mockResolvedValue({
      deviceId: 'RF8M10ABCDE',
      port: 19811,
      active: true,
      autoReverse: true,
      url: 'http://127.0.0.1:19811/?view=host',
    });
    const setSpy = vi.mocked(api.setHostReverse).mockResolvedValue({
      deviceId: 'RF8M10ABCDE',
      port: 19811,
      active: false,
      autoReverse: true,
      url: 'http://127.0.0.1:19811/?view=host',
    });

    render(
      <WorkstationProvider>
        <HostPhoneModal open={true} onClose={vi.fn()} />
      </WorkstationProvider>
    );

    expect(await screen.findByText('Active (tcp:19811)')).toBeInTheDocument();
    const disableBtn = screen.getByRole('button', { name: 'Disable' });
    fireEvent.click(disableBtn);
    await waitFor(() => expect(setSpy).toHaveBeenCalledWith('RF8M10ABCDE', { enabled: false }));
    expect(await screen.findByText('Inactive')).toBeInTheDocument();
  });
});
