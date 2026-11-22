import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiagnosticsPage } from '../pages/DiagnosticsPage.js';
import { SettingsPage } from '../pages/SettingsPage.js';
import { OverviewPage } from '../pages/OverviewPage.js';
import { ApplicationsPage } from '../pages/ApplicationsPage.js';
import { NetworkPage } from '../pages/NetworkPage.js';
import { WorkstationProvider } from '../context/WorkstationContext.js';

describe('Performance Dashboard, Multi-Graph Telemetry & Theme Selection', () => {
  beforeEach(() => {
    localStorage.clear();
    sessionStorage.clear();
    document.documentElement.removeAttribute('data-theme');

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.startsWith('/api/v1/stats?')) {
        const query = new URL(url, 'http://localhost').searchParams;
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ deviceId: query.get('deviceId'), scope: query.get('scope'), collectedAt: Date.now(), sections: {} }) });
      }
      if (url === '/api/v1/devices') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'device-test-01',
              serial: 'device-test-01',
              state: 'device',
              model: 'Pixel 8 Pro',
              androidVersion: '14',
              sdkLevel: 34,
              features: ['fastboot', 'root'],
            },
          ],
        });
      }
      if (url === '/api/v1/operations') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [
            {
              id: 'diagnostics.dumpsys',
              name: 'Dumpsys Query',
              category: 'Diagnostics',
              description: 'Query Android dumpsys service',
              commandPrefix: 'dumpsys',
              isDestructive: false,
              fields: [{ name: 'service', label: 'Service', fieldType: 'string', required: true }],
            },
          ],
        });
      }
      if (url.startsWith('/api/v1/jobs')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      }
      if (url === '/api/v1/capabilities') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ adbVersion: '34.0.4', mode: 'native', capabilities: [
            { id: 'shell', available: true },
            { id: 'root', available: false, reason: 'Requires a rooted device' },
          ] }),
        });
      }
      if (url === '/api/v1/discovery') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ available: true, services: [
            { name: 'adb-XYZ', kind: 'connect', hostname: 'Android-2.local', address: '192.168.1.50', port: 41297, endpoint: '192.168.1.50:41297' },
          ] }),
        });
      }
      if (url === '/api/v1/settings') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ adbPath: '/usr/bin/adb', dataDir: '/tmp' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });
  });

  it('renders grid dashboard with all 5 native SVG performance graphs', async () => {
    render(
      <WorkstationProvider>
        <DiagnosticsPage />
      </WorkstationProvider>
    );

    // Verify Title & Telemetry Header
    expect(screen.getByText('Performance & System Diagnostics')).toBeInTheDocument();
    expect(screen.getByText('Hardware Performance Dashboard')).toBeInTheDocument();

    // Verify Grid View is rendered by default
    expect(screen.getByTestId('dashboard-view-grid')).toBeInTheDocument();

    // Verify all 5 individual chart cards are present
    expect(screen.getByTestId('chart-cpu')).toBeInTheDocument();
    expect(screen.getByTestId('chart-memory')).toBeInTheDocument();
    expect(screen.getByTestId('chart-battery')).toBeInTheDocument();
    expect(screen.getByTestId('chart-fps')).toBeInTheDocument();
    expect(screen.getByTestId('chart-network')).toBeInTheDocument();

    // Verify metrics inside graphs
    expect(screen.getByText('CPU Utilization')).toBeInTheDocument();
    expect(screen.getByText('RAM Memory Usage')).toBeInTheDocument();
    expect(screen.getByText('Battery & Thermals')).toBeInTheDocument();
    expect(screen.getByText('Graphics & Frame Rate')).toBeInTheDocument();
    expect(screen.getByText('Network Throughput')).toBeInTheDocument();
  });

  it('opens a grid KPI card as the hero chart', () => {
    render(
      <WorkstationProvider>
        <DiagnosticsPage />
      </WorkstationProvider>
    );
    fireEvent.click(screen.getByTestId('kpi-card-diag-battery-state'));
    expect(screen.getByTestId('dashboard-view-split')).toBeInTheDocument();
    expect(screen.getByText('Battery Current')).toBeInTheDocument();
    expect(localStorage.getItem('andrui_diag_layout')).toBe('split');
    fireEvent.click(screen.getByTestId('layout-grid-btn'));
  });

  it('switches between Grid, Split (Hero), and Compact layout modes', async () => {
    render(
      <WorkstationProvider>
        <DiagnosticsPage />
      </WorkstationProvider>
    );

    // Initially in Grid mode
    expect(screen.getByTestId('dashboard-view-grid')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view-split')).toBeNull();
    expect(screen.queryByTestId('dashboard-view-compact')).toBeNull();

    // Switch to Split mode
    const splitBtn = screen.getByTestId('layout-split-btn');
    fireEvent.click(splitBtn);

    expect(screen.getByTestId('dashboard-view-split')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view-grid')).toBeNull();
    expect(screen.getByText('Hero Metric:')).toBeInTheDocument();

    // Change hero metric to RAM Memory
    const ramTab = screen.getByRole('button', { name: /RAM Memory/i });
    fireEvent.click(ramTab);

    // Switch to Compact mode
    const compactBtn = screen.getByTestId('layout-compact-btn');
    fireEvent.click(compactBtn);

    expect(screen.getByTestId('dashboard-view-compact')).toBeInTheDocument();
    expect(screen.queryByTestId('dashboard-view-split')).toBeNull();

    // Verify compact metric labels and sparklines
    expect(screen.getByText('Framerate')).toBeInTheDocument();

    // Switch back to Grid mode
    const gridBtn = screen.getByTestId('layout-grid-btn');
    fireEvent.click(gridBtn);
    expect(screen.getByTestId('dashboard-view-grid')).toBeInTheDocument();
  });

  it('allows manual telemetry sampling and interval toggle', async () => {
    render(
      <WorkstationProvider>
        <DiagnosticsPage />
      </WorkstationProvider>
    );

    // Find and click the Sample button
    const sampleBtn = screen.getByRole('button', { name: /Sample/i });
    expect(sampleBtn).toBeInTheDocument();
    fireEvent.click(sampleBtn);

    // Check polling interval buttons
    const interval1s = screen.getByRole('button', { name: '1s' });
    fireEvent.click(interval1s);
    expect(screen.getByText('1s interval')).toBeInTheDocument();

    const interval5s = screen.getByRole('button', { name: '5s' });
    fireEvent.click(interval5s);
    expect(screen.getByText('5s interval')).toBeInTheDocument();
  });

  it('does not allow theme selection in Performance & System Diagnostics', async () => {
    render(
      <WorkstationProvider>
        <DiagnosticsPage />
      </WorkstationProvider>
    );

    // Verify Theme selection control is removed from Diagnostics toolbar
    expect(screen.queryByLabelText('Theme selection')).toBeNull();
  });

  it('renders visual theme selection cards on SettingsPage with dark and light variants and allows clicking', async () => {
    render(
      <WorkstationProvider>
        <SettingsPage />
      </WorkstationProvider>
    );

    const appearance = screen.getByText('UI Appearance & Theme').closest('details')!;
    expect(appearance.open).toBe(true);
    expect(screen.getByText(/Dark themes \(5\)/i)).toBeInTheDocument();
    expect(screen.getByText(/Light themes \(5\)/i)).toBeInTheDocument();

    // Verify all 5 dark variants
    expect(screen.getByRole('button', { name: /Graphite Workbench \(Dark\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Midnight Cobalt \(Dark\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Matrix Terminal \(Dark\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Titanium Synthwave \(Dark\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Solar Amber \(Dark\)/i })).toBeInTheDocument();

    // Verify all 5 light variants
    expect(screen.getByRole('button', { name: /Graphite Workbench \(Light\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Midnight Cobalt \(Light\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Matrix Terminal \(Light\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Titanium Synthwave \(Light\)/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Solar Amber \(Light\)/i })).toBeInTheDocument();

    // Select Titanium Synthwave (Dark)
    const purpleCard = screen.getByRole('button', { name: /Titanium Synthwave \(Dark\)/i });
    fireEvent.click(purpleCard);
    expect(document.documentElement.getAttribute('data-theme')).toBe('purple');
    expect(localStorage.getItem('andrui_theme')).toBe('purple');

    // Select Graphite Workbench (Light)
    const emeraldLightCard = screen.getByRole('button', { name: /Graphite Workbench \(Light\)/i });
    fireEvent.click(emeraldLightCard);
    expect(document.documentElement.getAttribute('data-theme')).toBe('emerald-light');
    expect(localStorage.getItem('andrui_theme')).toBe('emerald-light');

    // Select Solar Amber (Light)
    const amberLightCard = screen.getByRole('button', { name: /Solar Amber \(Light\)/i });
    fireEvent.click(amberLightCard);
    expect(document.documentElement.getAttribute('data-theme')).toBe('amber-light');
    expect(localStorage.getItem('andrui_theme')).toBe('amber-light');
  });

  it('renders live workbench state and page-specific metrics', async () => {
    // Overview reports live device and host state.
    const { unmount: unmountOverview } = render(
      <WorkstationProvider>
        <OverviewPage />
      </WorkstationProvider>
    );
    expect(screen.getByRole('heading', { name: 'Your devices' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Host connection' })).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('1 ready')).toBeInTheDocument();
      expect(screen.getAllByText('Pixel 8 Pro').length).toBeGreaterThan(0);
      expect(screen.getByText('1 of 2')).toBeInTheDocument();
    });
    expect(screen.queryByText('0.8 ms')).not.toBeInTheDocument();
    expect(screen.queryByText('100% Signal')).not.toBeInTheDocument();
    expect(await screen.findByText('1 nearby')).toBeInTheDocument();
    unmountOverview();

    // 2. Applications Tab KPIs
    const { unmount: unmountApps } = render(
      <WorkstationProvider>
        <ApplicationsPage />
      </WorkstationProvider>
    );
    expect(screen.getByText('Installed Packages')).toBeInTheDocument();
    expect(screen.getByText('Disabled Packages')).toBeInTheDocument();
    expect(screen.getByText('Running Processes')).toBeInTheDocument();
    expect(screen.getByText('Install Results')).toBeInTheDocument();
    expect(screen.queryByText('214 Packages')).not.toBeInTheDocument();
    expect(screen.queryByText('99.4% Pass')).not.toBeInTheDocument();
    unmountApps();

    // 3. Network Tab KPIs
    const { unmount: unmountNet } = render(
      <WorkstationProvider>
        <NetworkPage />
      </WorkstationProvider>
    );
    expect(screen.getByText('Forward Rules')).toBeInTheDocument();
    expect(screen.getByTestId('kpi-card-net-reverse-tunnels')).toHaveTextContent('Reverse Tunnels');
    expect(screen.getByText('Device Throughput')).toBeInTheDocument();
    expect(screen.getByText('TCP Connections')).toBeInTheDocument();
    expect(screen.queryByText('4.2 MB/s')).not.toBeInTheDocument();
    unmountNet();
  });

  it('renders subsystem-specific KPIs in Diagnostics split mode for selected hero tab', async () => {
    render(
      <WorkstationProvider>
        <DiagnosticsPage />
      </WorkstationProvider>
    );

    // Switch to Split mode
    const splitBtn = screen.getByTestId('layout-split-btn');
    fireEvent.click(splitBtn);

    // CPU Hero: verify CPU subsystem KPIs
    expect(screen.getByText('Context Switches')).toBeInTheDocument();
    expect(screen.getByText('Runnable Tasks')).toBeInTheDocument();
    expect(screen.getByText('Core Topology')).toBeInTheDocument();
    expect(screen.getByText('CPU Governor')).toBeInTheDocument();
    expect(screen.queryByText('schedutil')).not.toBeInTheDocument();

    // Switch Hero to Battery: verify Battery subsystem KPIs
    const batteryTab = screen.getByTestId('hero-tab-battery');
    fireEvent.click(batteryTab);
    expect(screen.getByText('Battery Current')).toBeInTheDocument();
    expect(screen.getByText('Remaining Charge')).toBeInTheDocument();
    expect(screen.getByText('Thermal Status')).toBeInTheDocument();

    // Switch Hero to Graphics & FPS: verify Graphics subsystem KPIs
    const fpsTab = screen.getByTestId('hero-tab-fps');
    fireEvent.click(fpsTab);
    expect(screen.getByText('90th %ile Frame Time')).toBeInTheDocument();
    expect(screen.getByText('Janky Frames')).toBeInTheDocument();
    expect(screen.getByText('Display Refresh')).toBeInTheDocument();
  });
});
