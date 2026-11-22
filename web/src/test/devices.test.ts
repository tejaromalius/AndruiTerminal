import { describe, it, expect } from 'vitest';
import { deduplicateDevices } from '../lib/devices.js';
import type { Device } from '../types/api.js';

describe('deduplicateDevices', () => {
  it('collapses offline and ready TCP endpoints on the same LAN IP, keeping the ready one', () => {
    const input: Device[] = [
      { id: '192.168.10.54:43733', state: 'offline', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 2 },
      { id: '192.168.10.54:46463', state: 'device', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 3 },
    ];

    expect(deduplicateDevices(input)).toEqual([
      { id: '192.168.10.54:46463', state: 'device', model: 'DNP_NX9', product: 'DNP-NX9', transportId: 3 },
    ]);
  });

  it('keeps the newer transport when two entries on the same LAN IP have the same state', () => {
    const input: Device[] = [
      { id: '192.168.10.54:43733', state: 'offline', transportId: 2 },
      { id: '192.168.10.54:46463', state: 'offline', transportId: 5 },
    ];

    expect(deduplicateDevices(input)).toEqual([
      { id: '192.168.10.54:46463', state: 'offline', transportId: 5 },
    ]);
  });

  it('does not collapse distinct loopback ports or distinct USB serials with the same model', () => {
    const input: Device[] = [
      { id: '127.0.0.1:5555', state: 'device', model: 'Pixel_8', transportId: 1 },
      { id: '127.0.0.1:5557', state: 'offline', model: 'Pixel_8', transportId: 2 },
      { id: 'USB001', state: 'device', model: 'Pixel_8', product: 'shiba', transportId: 3 },
      { id: 'USB002', state: 'offline', model: 'Pixel_8', product: 'shiba', transportId: 4 },
    ];

    expect(deduplicateDevices(input)).toHaveLength(4);
  });

  it('collapses duplicate mDNS TLS endpoints for the same serial', () => {
    const input: Device[] = [
      { id: 'adb-R5CN90ABCDE-old._adb-tls-connect._tcp', state: 'offline', transportId: 1 },
      { id: 'adb-R5CN90ABCDE-new._adb-tls-connect._tcp', state: 'device', transportId: 2 },
    ];

    expect(deduplicateDevices(input)).toEqual([
      { id: 'adb-R5CN90ABCDE-new._adb-tls-connect._tcp', state: 'device', transportId: 2 },
    ]);
  });
});
