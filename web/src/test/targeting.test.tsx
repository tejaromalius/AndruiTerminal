import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkstationProvider, useWorkstation } from '../context/WorkstationContext.js';
import { Header } from '../components/Header.js';
import { Device } from '../types/api.js';

const mockDevices: Device[] = [
  { id: 'emulator-5554', state: 'device', model: 'Pixel_8', transportId: 1 },
  { id: '192.168.1.50:5555', state: 'offline', transportId: 2 },
  { id: 'usb-unauth-001', state: 'unauthorized', transportId: 3 },
  { id: 'fastboot-dev-99', state: 'bootloader', transportId: 4 },
];

const TargetStatusWatcher: React.FC = () => {
  const { selectedDeviceId, selectedDevice } = useWorkstation();
  return (
    <div>
      <div data-testid="target-id">{selectedDeviceId || 'NO_TARGET'}</div>
      <div data-testid="target-state">{selectedDevice?.state || 'NO_STATE'}</div>
    </div>
  );
};

describe('Device Targeting and State Rendering', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('populates device selector with all device states and automatically selects first device', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/devices') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockDevices,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });

    render(
      <WorkstationProvider>
        <Header />
        <TargetStatusWatcher />
      </WorkstationProvider>
    );

    // Initial load auto-selects first device
    await waitFor(() => {
      expect(screen.getByTestId('target-id')).toHaveTextContent('emulator-5554');
      expect(screen.getByTestId('target-state')).toHaveTextContent('device');
    });

    // Check device state badge rendered in header
    expect(screen.getAllByText('device').length).toBeGreaterThan(0);

    // Change targeted device to offline device
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: '192.168.1.50:5555' } });

    await waitFor(() => {
      expect(screen.getByTestId('target-id')).toHaveTextContent('192.168.1.50:5555');
      expect(screen.getByTestId('target-state')).toHaveTextContent('offline');
    });

    // Verify localStorage persistence
    expect(localStorage.getItem('andrui_selected_device')).toBe('192.168.1.50:5555');
  });

  it('renders unauthorized and bootloader device states accurately', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/devices') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockDevices,
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });

    render(
      <WorkstationProvider>
        <Header />
        <TargetStatusWatcher />
      </WorkstationProvider>
    );

    await waitFor(() => {
      expect(screen.getByTestId('target-id')).toHaveTextContent('emulator-5554');
    });

    // Switch to unauthorized device
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'usb-unauth-001' } });

    await waitFor(() => {
      expect(screen.getByTestId('target-id')).toHaveTextContent('usb-unauth-001');
      expect(screen.getByTestId('target-state')).toHaveTextContent('unauthorized');
    });
  });
  it('keeps the chosen target when it disconnects instead of selecting another device', async () => {
    let current = [...mockDevices];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({ok:true,status:200,json:async()=>url==='/api/v1/devices'?current:[]}));
    render(<WorkstationProvider><Header /><TargetStatusWatcher /></WorkstationProvider>);
    await waitFor(() => expect(screen.getByTestId('target-id')).toHaveTextContent('emulator-5554'));
    current = mockDevices.slice(1);
    fireEvent.click(screen.getByRole('button',{name:'Refresh devices'}));
    await waitFor(() => expect(screen.getByTestId('target-state')).toHaveTextContent('NO_STATE'));
    expect(screen.getByTestId('target-id')).toHaveTextContent('emulator-5554');
    expect(screen.getByRole('combobox')).toHaveValue('');
    expect(screen.getByText('Selected device disconnected — choose a target')).toBeInTheDocument();
  });

  it('does not overwrite a selection made while the first device snapshot is arriving', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve({ok:true,status:200,json:async()=>url==='/api/v1/devices'?mockDevices:[]}));
    function SelectAsDevicesArrive() {
      const {devices,setSelectedDeviceId} = useWorkstation();
      const chosen = React.useRef(false);
      React.useLayoutEffect(() => { if (devices.length && !chosen.current) { chosen.current=true; setSelectedDeviceId('192.168.1.50:5555'); } },[devices,setSelectedDeviceId]);
      return null;
    }
    render(<WorkstationProvider><SelectAsDevicesArrive /><Header /><TargetStatusWatcher /></WorkstationProvider>);
    await waitFor(() => expect(screen.getByTestId('target-id')).toHaveTextContent('192.168.1.50:5555'));
    expect(localStorage.getItem('andrui_selected_device')).toBe('192.168.1.50:5555');
  });

  it('deduplicates wireless endpoints in target selection and remaps stale selected port to the ready one', async () => {
    localStorage.setItem('andrui_selected_device', '192.168.10.54:43733');
    const duplicateDevices: Device[] = [
      { id: '192.168.10.54:43733', state: 'offline', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 2 },
      { id: '192.168.10.54:46463', state: 'device', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 3 },
    ];
    globalThis.fetch = vi.fn().mockImplementation((url: string) =>
      Promise.resolve({ ok: true, status: 200, json: async () => (url === '/api/v1/devices' ? duplicateDevices : []) })
    );

    render(<WorkstationProvider><Header /><TargetStatusWatcher /></WorkstationProvider>);

    await waitFor(() => expect(screen.getByTestId('target-id')).toHaveTextContent('192.168.10.54:46463'));
    expect(screen.getByTestId('target-state')).toHaveTextContent('device');
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveValue('192.168.10.54:46463');
  });

});
