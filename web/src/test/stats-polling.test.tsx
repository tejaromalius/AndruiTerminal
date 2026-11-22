import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, DeviceStats } from '../api/client.js';
import { useDeviceStats } from '../lib/useDeviceStats.js';

const sample = (deviceId: string): DeviceStats => ({ deviceId, scope: 'processes', collectedAt: 1000, sections: {} });

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('visible metric collection', () => {
  it('retains the last sample with an explicit error after a failed refresh', async () => {
    vi.spyOn(api, 'getStats').mockResolvedValueOnce(sample('one')).mockRejectedValueOnce(new Error('Device disconnected'));
    const view = renderHook(() => useDeviceStats('processes', 'one', 0));
    await act(async () => { });
    const previous = view.result.current.stats;
    await act(async () => view.result.current.refresh());
    expect(view.result.current.stats).toBe(previous);
    expect(view.result.current.error).toBe('Device disconnected');
  });

  it('pauses hidden polling and resumes on activation', async () => {
    vi.useFakeTimers();
    const get = vi.spyOn(api, 'getStats').mockResolvedValue(sample('one'));
    const view = renderHook(({ enabled }) => useDeviceStats('processes', 'one', 10000, { enabled }), { initialProps: { enabled: false } });
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(get).not.toHaveBeenCalled();
    view.rerender({ enabled: true });
    await act(async () => { });
    expect(get).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(get).toHaveBeenCalledTimes(2);
    view.rerender({ enabled: false });
    await act(() => vi.advanceTimersByTimeAsync(30000));
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('discards late responses from the previous device', async () => {
    let resolveOld!: (stats: DeviceStats) => void;
    const get = vi.spyOn(api, 'getStats').mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; })).mockResolvedValue(sample('two'));
    const view = renderHook(({ device }) => useDeviceStats('processes', device, 10000), { initialProps: { device: 'one' } });
    view.rerender({ device: 'two' });
    await act(async () => { });
    expect(view.result.current.stats?.deviceId).toBe('two');
    await act(async () => resolveOld(sample('one')));
    expect(view.result.current.stats?.deviceId).toBe('two');
    expect(view.result.current.previous).toBeNull();
    expect(get).toHaveBeenCalledTimes(2);
  });

  it('requires explicit package inspection and clears results when the package changes', async () => {
    const get = vi.spyOn(api, 'getStats').mockResolvedValue({ ...sample('one'), scope: 'package' });
    const view = renderHook(({ name }) => useDeviceStats('package', 'one', 0, { manual: true, packageName: name }), { initialProps: { name: 'com.example' } });
    expect(get).not.toHaveBeenCalled();
    await act(async () => view.result.current.refresh());
    expect(get).toHaveBeenCalledWith('one', 'package', 'com.example');
    expect(view.result.current.stats).not.toBeNull();
    view.rerender({ name: 'com.other' });
    expect(view.result.current.stats).toBeNull();
    expect(get).toHaveBeenCalledTimes(1);
  });
});
