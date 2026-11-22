import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { parsePackageDump, ApkToolkit, splitKind } from '../components/ApkToolkit.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import type { Operation } from '../types/api.js';

describe('ApkToolkit and parsePackageDump', () => {
  it('correctly parses package dump stdout', () => {
    const sampleOutput = `
Packages:
  Package [com.example.sampleapp] (3f21a4):
    userId=10182
    pkg=Package{8e89f1 com.example.sampleapp}
    codePath=/data/app/~~abcd==/com.example.sampleapp-efgh==
    resourcePath=/data/app/~~abcd==/com.example.sampleapp-efgh==
    legacyNativeLibraryDir=/data/app/~~abcd==/com.example.sampleapp-efgh==/lib/arm64
    primaryCpuAbi=arm64-v8a
    versionCode=20408 minSdk=28 targetSdk=34
    versionName=2.4.8
    splits=[base, config.arm64_v8a]
    requested permissions:
      android.permission.INTERNET
      android.permission.CAMERA
      android.permission.POST_NOTIFICATIONS
    install permissions:
      android.permission.INTERNET: granted=true
    runtime permissions:
      android.permission.CAMERA: granted=true, flags=[ USER_SET ]
      android.permission.POST_NOTIFICATIONS: granted=false, flags=[ USER_SET ]
`;

    const parsed = parsePackageDump(sampleOutput);

    expect(parsed.packageName).toBe('com.example.sampleapp');
    expect(parsed.userId).toBe('10182');
    expect(parsed.codePath).toBe('/data/app/~~abcd==/com.example.sampleapp-efgh==');
    expect(parsed.versionCode).toBe('20408');
    expect(parsed.minSdk).toBe('28');
    expect(parsed.targetSdk).toBe('34');
    expect(parsed.versionName).toBe('2.4.8');

    expect(parsed.permissions.length).toBe(3);

    const internet = parsed.permissions.find((p) => p.name === 'android.permission.INTERNET');
    expect(internet?.granted).toBe(true);
    expect(internet?.type).toBe('install');

    const camera = parsed.permissions.find((p) => p.name === 'android.permission.CAMERA');
    expect(camera?.granted).toBe(true);
    expect(camera?.type).toBe('runtime');

    const notif = parsed.permissions.find((p) => p.name === 'android.permission.POST_NOTIFICATIONS');
    expect(notif?.granted).toBe(false);
    expect(notif?.type).toBe('runtime');
  });

  it('opens operation modal with remote param and empty local so pulled APK becomes an artifact', () => {
    const mockOpenOperationModal = vi.fn();
    const mockFindOperation = vi.fn().mockImplementation((id: string) =>
      id === 'file.pull' ? ({ id: 'file.pull', label: 'Pull File' } as Operation) : undefined
    );
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      selectedDeviceId: 'dev-1',
      findOperation: mockFindOperation,
      openOperationModal: mockOpenOperationModal,
    } as any);

    render(<ApkToolkit view="overview" details={null}
      paths={'package:/data/app/~~VEtFaSZ2nNtoSq8iKWynQA==/tr.com.bipatihouse.app-puKmWuHJCswtbzN4bV002g==/base.apk\n'} />);

    expect(screen.getByText(/APK Splits on Device \(1\)/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /pull to host/i }));

    expect(mockOpenOperationModal).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file.pull' }),
      {
        remote: '/data/app/~~VEtFaSZ2nNtoSq8iKWynQA==/tr.com.bipatihouse.app-puKmWuHJCswtbzN4bV002g==/base.apk',
      }
    );
  });

  it('names each split once under its shared install directory and tags what it carries', () => {
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({ findOperation: vi.fn(), openOperationModal: vi.fn() } as any);
    const dir = '/data/app/~~2w5F==/ai.x.grok-I-xK==';
    render(<ApkToolkit view="overview" details={null}
      paths={['base', 'split_config.arm64_v8a', 'split_config.en', 'split_config.xxxhdpi', 'split_feature'].map((n) => `package:${dir}/${n}.apk`).join('\n')} />);

    expect(screen.getByText(dir)).toBeInTheDocument();
    expect(screen.getByText('split_config.arm64_v8a.apk')).toBeInTheDocument();
    expect(screen.getByText('split_config.arm64_v8a.apk').closest('li')).toHaveAttribute('title', `${dir}/split_config.arm64_v8a.apk`);
    expect(['base', 'split_config.arm64_v8a', 'split_config.en', 'split_config.xxxhdpi', 'split_feature', 'split_config.pt_BR'].map((n) => splitKind(`${dir}/${n}.apk`)))
      .toEqual(['base', 'abi', 'language', 'density', 'feature', 'language']);
  });
});
