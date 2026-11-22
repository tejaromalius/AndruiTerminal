import type { Device } from '../types/api.js';

const STATE_PRIORITY: Record<string, number> = {
  device: 4,
  authorizing: 3,
  connecting: 3,
  unauthorized: 2,
  recovery: 2,
  sideload: 2,
  bootloader: 2,
  offline: 1,
};

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function parseTcpHost(id: string): string | null {
  const ipv6 = id.match(/^\[([^\]]+)\]:(\d+)$/);
  if (ipv6) return ipv6[1].toLowerCase();
  const hostPort = id.match(/^([^:\s]+):(\d+)$/);
  if (hostPort) return hostPort[1].toLowerCase();
  return null;
}

/**
 * Identity key used to collapse duplicate ADB transports for the same device
 * (e.g. a stale offline wireless endpoint alongside a ready one on the same IP).
 */
export function deviceDedupeKey(device: Device): string {
  const tcpHost = parseTcpHost(device.id);
  if (tcpHost && !isLoopbackHost(tcpHost)) {
    return `tcp:${tcpHost}`;
  }
  const mdns = device.id.match(/^adb-([^-]+)-[^.]+\._adb-tls-connect\._tcp$/);
  if (mdns) {
    return `mdns:${mdns[1]}`;
  }
  return `id:${device.id}`;
}

function metadataScore(device: Device): number {
  return (device.model ? 1 : 0) + (device.product ? 1 : 0) + (device.device ? 1 : 0);
}

function isPreferredDevice(candidate: Device, current: Device): boolean {
  const candidateState = STATE_PRIORITY[candidate.state] ?? 0;
  const currentState = STATE_PRIORITY[current.state] ?? 0;
  if (candidateState !== currentState) {
    return candidateState > currentState;
  }
  const candidateTransport = candidate.transportId ?? -1;
  const currentTransport = current.transportId ?? -1;
  if (candidateTransport !== currentTransport) {
    return candidateTransport > currentTransport;
  }
  return metadataScore(candidate) > metadataScore(current);
}

/**
 * Deduplicate device entries that represent the same physical/network endpoint,
 * keeping the healthiest (and newest transport) entry in place.
 */
export function deduplicateDevices(devices: Device[]): Device[] {
  const indexByKey = new Map<string, number>();
  const result: Device[] = [];

  for (const device of devices) {
    const key = deviceDedupeKey(device);
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, result.length);
      result.push(device);
    } else if (isPreferredDevice(device, result[existingIndex])) {
      result[existingIndex] = device;
    }
  }

  return result;
}
