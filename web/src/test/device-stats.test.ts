import { describe, it, expect } from 'vitest';
import {
  buildTelemetry,
  cpuUsage,
  parseBattery,
  parseCount,
  parseDf,
  parseForwards,
  parseFrames,
  parseLogBuffers,
  parseLogLevels,
  parseMeminfo,
  parseNetDev,
  parseOwners,
  parseProcStat,
  parseRefreshHz,
  parseTcp,
  parseUsers,
} from '../lib/deviceStats.js';

const ok = (output: string) => ({ output, exitCode: 0 });

describe('device stats parsers', () => {
  it('reads dumpsys battery fields at line start only', () => {
    const b = parseBattery(`Current Battery Service state:
  AC powered: false
  USB powered: true
  Max charging current: 500000
  Max charging voltage: 5000000
  Charge counter: 2875000
  status: 2
  health: 2
  present: true
  level: 87
  scale: 100
  voltage: 4312
  temperature: 298
  technology: Li-ion`);
    expect(b).toMatchObject({ level: 87, voltageMv: 4312, tempC: 29.8, status: 'Charging', health: 'Good', chargeCounterMah: 2875, powerSource: 'USB' });
  });

  it('returns null instead of defaults when battery output is unusable', () => {
    expect(parseBattery('DUMP OF SERVICE dumpsys battery:\n  Current state: normal')).toBeNull();
    expect(parseBattery(null)).toBeNull();
  });

  it('computes CPU usage from two /proc/stat samples', () => {
    const a = parseProcStat('cpu  100 0 50 800 50 0 0 0 0 0\ncpu0 1 1 1 1\ncpu1 1 1 1 1\nctxt 1000\nprocs_running 3')!;
    const b = parseProcStat('cpu  160 0 70 860 60 0 0 0 0 0\ncpu0 1 1 1 1\ncpu1 1 1 1 1\nctxt 1600\nprocs_running 2')!;
    expect(a.cores).toBe(2);
    expect(cpuUsage(a, b)).toEqual({ total: 53.3, user: 40, system: 13.3 });
  });

  it('parses meminfo without inventing a total', () => {
    expect(parseMeminfo('nothing')).toBeNull();
    const m = parseMeminfo('MemTotal:  7810048 kB\nMemFree:  204800 kB\nMemAvailable: 3145728 kB\nBuffers: 102400 kB\nCached: 2048000 kB\nSwapTotal: 4194304 kB\nSwapFree: 3145728 kB\nDirty: 1024 kB\nSlab: 204800 kB\nPageTables: 61440 kB\nKernelStack: 30720 kB')!;
    expect(m).toMatchObject({ totalMb: 7627, freeMb: 200, cachedMb: 2100, availableMb: 3072, swapUsedMb: 1024, dirtyMb: 1, kernelMb: 290 });
  });

  it('sums non-loopback interface bytes from /proc/net/dev', () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 5000 10 0 0 0 0 0 0 5000 10 0 0 0 0 0 0
 wlan0: 1000 5 0 0 0 0 0 0 400 3 0 0 0 0 0 0
rmnet0: 24 1 0 0 0 0 0 0 6 1 0 0 0 0 0 0`;
    expect(parseNetDev(text)).toEqual({ rxBytes: 1024, txBytes: 406 });
  });

  it('counts TCP socket states', () => {
    const text = `  sl  local_address rem_address   st tx_queue rx_queue
   0: 0100007F:13AD 00000000:0000 0A 00000000:00000000
   1: 0F02000A:A1B2 8E5ED8AC:01BB 01 00000000:00000000
   2: 0F02000A:A1B3 8E5ED8AC:01BB 06 00000000:00000000`;
    expect(parseTcp(text)).toEqual({ established: 1, timeWait: 1 });
  });

  it('keeps only forwards of the selected serial', () => {
    expect(parseForwards('ABC tcp:1 tcp:1\nXYZ tcp:2 tcp:2\nABC tcp:3 tcp:3', 'ABC')).toBe(2);
    expect(parseForwards('', 'ABC')).toBe(0);
  });

  it('accepts grep -c output even when grep exits 1', () => {
    expect(parseCount({ crashes: { output: '0', exitCode: 1 } }, 'crashes')).toBe(0);
    expect(parseCount({ crashes: ok('/system/bin/sh: grep: not found') }, 'crashes')).toBeNull();
  });

  it('parses old and new logcat -g formats', () => {
    expect(parseLogBuffers('main: ring buffer is 256Kb (229Kb consumed), max entry is 5120b, max payload is 4068b')).toEqual([
      { name: 'main', sizeBytes: 262144, usedBytes: 234496 },
    ]);
    expect(parseLogBuffers('main: ring buffer is 1 MiB (512 KiB consumed), max entry is 5120 B, max payload is 4068 B')).toEqual([
      { name: 'main', sizeBytes: 1048576, usedBytes: 524288 },
    ]);
  });

  it('parses priority counts, df, users, owners and refresh rate', () => {
    expect(parseLogLevels('   12 D\n  340 I\n    2 E\n    3 -')).toEqual({ D: 12, I: 340, E: 2 });
    expect(parseDf('Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/block/dm-8 115037224 52428800 62608424  46% /data')).toEqual({
      totalBytes: 115037224 * 1024,
      usedBytes: 52428800 * 1024,
      availBytes: 62608424 * 1024,
    });
    expect(parseUsers('Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Work:1030}')).toEqual({ total: 2, running: 1 });
    expect(parseOwners(ok('no owners'))).toEqual([]);
    expect(parseOwners(ok('1 owner:\nUser  0: admin=com.corp.mdm/.Admin,DeviceOwner,Affiliated'))).toEqual(['Device owner: com.corp.mdm']);
    expect(parseRefreshHz('16666666\n')).toBe(60);
  });

  it('derives FPS only from two samples of the same focused app', () => {
    const frames = (n: number, janky: number) =>
      `package com.example.app\nTotal frames rendered: ${n}\nJanky frames: ${janky} (1.00%)\n90th percentile: 13ms`;
    expect(parseFrames(frames(10, 1))).toMatchObject({ packageName: 'com.example.app', totalFrames: 10, p90Ms: 13 });
    const first = { collectedAt: 1000, sections: { frames: ok(frames(100, 2)) } };
    const second = { collectedAt: 3000, sections: { frames: ok(frames(220, 5)) } };
    expect(buildTelemetry(first, null).point.fps).toBeNull();
    expect(buildTelemetry(second, first).point.fps).toEqual({ fps: 60, p90FrameMs: 13, jankCount: 3, packageName: 'com.example.app' });
    expect(parseFrames('package mCurrentFocus=null')).toBeNull();
  });
});
