import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  fuzzyScore,
  parseActivities,
  parseForeground,
  parseLauncher,
  parsePackageList,
  parsePaths,
  useAppSelection,
  type AppEntry,
} from '../lib/packageList.js';
import { AppList } from '../components/AppList.js';
import { AppDetail } from '../components/AppDetail.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import type { Operation } from '../types/api.js';

const s = (output: string, exitCode = 0) => ({ output, exitCode });

describe('package list parsers', () => {
  it('merges the packages scope into one row per package', () => {
    const list = parsePackageList({
      packageList: s('package:/system/app/Settings/Settings.apk=com.android.settings\npackage:/data/app/~~a==/com.ex=1-b==/base.apk=com.ex'),
      packageUids: s('package:com.android.settings uid:1000\npackage:com.ex uid:10123'),
      packageVersions: s('package:com.android.settings versionCode:34\npackage:com.ex versionCode:231'),
      packageInstallers: s('package:com.android.settings  installer=null\npackage:com.ex  installer=com.android.vending'),
      systemPackages: s('package:com.android.settings'),
      disabledPackages: s(''),
      runningProcesses: s('NAME\ninit\ncom.ex:remote'),
    });
    expect(list).toEqual([
      { name: 'com.android.settings', codePath: '/system/app/Settings/Settings.apk', uid: 1000, versionCode: '34', installer: null, system: true, disabled: false, running: false },
      { name: 'com.ex', codePath: '/data/app/~~a==/com.ex=1-b==/base.apk', uid: 10123, versionCode: '231', installer: 'com.android.vending', system: false, disabled: false, running: true },
    ]);
  });

  it('reports unsupported columns as unknown instead of false', () => {
    const list = parsePackageList({
      packageList: s('package:/system/app/A.apk=com.a'),
      packageVersions: s('Error: Unknown option: --show-versioncode', 255),
      systemPackages: s('', 1),
    });
    expect(list?.[0]).toMatchObject({ name: 'com.a', versionCode: null, system: null, disabled: null, running: null });
    expect(parsePackageList({ packageList: s('', 1) })).toBeNull();
  });

  it('reads foreground, launcher, activities and paths', () => {
    expect(parseForeground({ resumed: s('  topResumedActivity=ActivityRecord{1a u0 com.ex/.Main t12}') })).toEqual({ package: 'com.ex', component: 'com.ex/.Main' });
    expect(parseForeground({ resumed: s('', 1) })).toBeNull();
    expect(parseLauncher({ launcher: s('priority=0 preferredOrder=0\ncom.ex/.MainActivity') })).toBe('com.ex/com.ex.MainActivity');
    expect(parseLauncher({ launcher: s('No activity found') })).toBeNull();
    const dump = [
      'Activity Resolver Table:',
      '  Non-Data Actions:',
      '      android.intent.action.MAIN:',
      '        5c3a com.ex/.MainActivity filter 1d2e',
      '        5c3b com.ex/com.ex.Settings filter 1d2f',
      '        5c3c other.pkg/.Leak filter 1d30',
      'Service Resolver Table:',
      '        5c3d com.ex/.SyncService filter 1d31',
    ].join('\n');
    expect(parseActivities(dump, 'com.ex')).toEqual(['com.ex/com.ex.MainActivity', 'com.ex/com.ex.Settings']);
    expect(parsePaths('package:/data/app/a/base.apk\npackage:/data/app/a/split.apk\n')).toEqual(['/data/app/a/base.apk', '/data/app/a/split.apk']);
  });

  it('fuzzy-matches subsequences and ranks substrings first', () => {
    expect(fuzzyScore('com.android.chrome', 'chrm')).not.toBeNull();
    expect(fuzzyScore('com.android.chrome', 'xyz')).toBeNull();
    expect(fuzzyScore('com.android.chrome', 'chrome')!).toBeLessThan(fuzzyScore('com.android.chrome', 'chrm')!);
  });
});

describe('app selection store', () => {
  beforeEach(() => localStorage.clear());

  it('keeps selection, recents and pins per device', () => {
    const a = renderHook(() => useAppSelection('dev-a'));
    const b = renderHook(() => useAppSelection('dev-b'));
    act(() => a.result.current.select('com.one'));
    act(() => a.result.current.select('com.two'));
    act(() => a.result.current.select('com.one'));
    act(() => a.result.current.togglePin('com.two'));
    expect(a.result.current.selected).toBe('com.one');
    expect(a.result.current.recent).toEqual(['com.one', 'com.two']);
    expect(a.result.current.pinned).toEqual(['com.two']);
    expect(b.result.current.selected).toBe('');
    act(() => a.result.current.setDraft('com.typ'));
    expect(a.result.current.recent).toEqual(['com.one', 'com.two']);
  });
});

const entry = (name: string, extra: Partial<AppEntry> = {}): AppEntry => ({
  name, codePath: null, uid: null, versionCode: null, installer: null, system: false, disabled: false, running: false, ...extra,
});

describe('AppList', () => {
  const base = {
    loading: false, error: null, deviceReady: true, selected: '', pinned: [], recent: [], filter: 'all' as const,
    onFilter: vi.fn(), onTogglePin: vi.fn(), onRefresh: vi.fn(), onInstall: vi.fn(), onForeground: vi.fn(),
    foregroundBusy: false, foregroundNote: null,
  };

  it('filters by query and selects with the keyboard', () => {
    const onSelect = vi.fn();
    render(<AppList {...base} onSelect={onSelect} apps={[entry('com.android.chrome'), entry('com.example.app')]} />);
    const search = screen.getByLabelText('Filter packages');
    fireEvent.change(search, { target: { value: 'chrm' } });
    expect(screen.queryByText('com.example.app')).toBeNull();
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('com.android.chrome');
  });

  it('applies filter flags and accepts an unlisted exact name', () => {
    const onSelect = vi.fn();
    render(<AppList {...base} filter="running" onSelect={onSelect}
      apps={[entry('com.idle'), { ...entry('com.busy'), running: true }]} />);
    expect(screen.getByText('com.busy')).toBeInTheDocument();
    expect(screen.queryByText('com.idle')).toBeNull();
    const search = screen.getByLabelText('Filter packages');
    fireEvent.change(search, { target: { value: 'org.unlisted.pkg' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith('org.unlisted.pkg');
  });
});

describe('AppDetail', () => {
  it('inspects on selection and launches the resolved launcher without typing', async () => {
    const openOperationModal = vi.fn();
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      findOperation: (id: string) => ({ id, label: id } as Operation),
      openOperationModal,
    } as any);
    const getStats = vi.spyOn(api, 'getStats').mockResolvedValue({
      deviceId: 'dev-1', scope: 'package', collectedAt: 1,
      sections: {
        details: s('Packages:\n  Package [com.ex] (1):\n    versionCode=231 minSdk=28 targetSdk=34\n    versionName=2.3.1'),
        appops: s('CAMERA: allow'),
        paths: s('package:/data/app/x/base.apk'),
        launcher: s('priority=0\ncom.ex/.Main'),
      },
    });
    render(<AppDetail deviceId="dev-1" pkg="com.ex" entry={entry('com.ex')} tab="overview" onTab={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Launcher: .Main')).toBeInTheDocument());
    expect(getStats).toHaveBeenCalledTimes(1);
    expect(getStats).toHaveBeenCalledWith('dev-1', 'package', 'com.ex');
    expect(screen.getByText('v2.3.1 (231)')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /launch/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'activity.start' }), { component: 'com.ex/com.ex.Main' });
    getStats.mockRestore();
  });
});

describe('AppList row names', () => {
  it('leads with the distinctive tail and keeps the full name', () => {
    render(<AppList loading={false} error={null} deviceReady selected="" pinned={[]} recent={[]} filter="all"
      onFilter={vi.fn()} onSelect={vi.fn()} onTogglePin={vi.fn()} onRefresh={vi.fn()} onInstall={vi.fn()} onForeground={vi.fn()}
      foregroundBusy={false} foregroundNote={null}
      apps={[entry('com.google.android.apps.carrier.carrierwifi'), entry('com.github.android'), entry('android')]} />);
    expect(screen.getByText('carrierwifi')).toBeInTheDocument();
    expect(screen.getByText('com.google.android.apps.carrier.carrierwifi')).toBeInTheDocument();
    expect(screen.getByText('github.android')).toBeInTheDocument();
    expect(screen.getAllByText('android')).toHaveLength(1);
  });
});
