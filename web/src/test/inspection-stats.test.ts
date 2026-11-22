import { describe, expect, it } from 'vitest';
import { parseAppOps, parsePackage, parseProcesses } from '../lib/inspectionStats.js';

const ok = (output: string) => ({ output, exitCode: 0 });

describe('inspection metric parsing', () => {
  it('parses process memory and distinguishes empty output from unsupported data', () => {
    expect(parseProcesses(ok('  PID USER NAME RSS VSZ\n12 root init 100 200\n25 u0_a1 com.example 1024 4096'))).toEqual([
      { pid: 12, user: 'root', name: 'init', rss: 100, vsz: 200 },
      { pid: 25, user: 'u0_a1', name: 'com.example', rss: 1024, vsz: 4096 },
    ]);
    expect(parseProcesses(ok('PID USER NAME RSS VSZ'))).toEqual([]);
    for (const section of [undefined, ok(''), ok('ps: bad -o'), ok('PID USER NAME RSS VSZ\n1 root init unknown 20'), { output: 'permission denied', exitCode: 1 }]) {
      expect(parseProcesses(section)).toBeNull();
    }
  });

  it('counts requested permissions once and reported grant entries across users', () => {
    expect(parsePackage(ok(`Packages:
      Package [com.example] (123):
        requested permissions:
          android.permission.CAMERA
          android.permission.INTERNET
        install permissions:
          android.permission.INTERNET: granted=true
        User 0:
          runtime permissions:
            android.permission.CAMERA: granted=false, flags=[]
        User 10:
          runtime permissions:
            android.permission.CAMERA: granted=true, flags=[]`))).toEqual({ requested: 2, granted: 2, denied: 1 });
    expect(parsePackage(ok('Unable to find package: missing'))).toBeNull();
    expect(parsePackage({ output: 'Package [com.example]', exitCode: 1 })).toBeNull();
  });

  it('summarizes AppOps modes without counting unrecognized output as zero', () => {
    expect(parseAppOps(ok('CAMERA: allow; time=1m\nRECORD_AUDIO: foreground\nUid mode: RUN_IN_BACKGROUND: ignore'))).toEqual([
      { operation: 'CAMERA', mode: 'allow' }, { operation: 'RECORD_AUDIO', mode: 'foreground' }, { operation: 'RUN_IN_BACKGROUND', mode: 'ignore' },
    ]);
    expect(parseAppOps(ok('No operations.'))).toEqual([]);
    expect(parseAppOps(ok('Unknown command'))).toBeNull();
    expect(parseAppOps({ output: 'CAMERA: allow', exitCode: 1 })).toBeNull();
  });
});
