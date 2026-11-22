import { useCallback, useEffect, useRef, useState } from 'react';
import { api, DeviceStats, StatsScope } from '../api/client.js';

export interface DeviceStatsState {
  /** Latest successful sample. */
  stats: DeviceStats | null;
  /** Sample before `stats`, for per-second rates. */
  previous: DeviceStats | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

/** Polls GET /stats for one scope while a device is selected. intervalMs <= 0 disables polling. */
export function useDeviceStats(scope: StatsScope, deviceId: string | null, intervalMs: number, options: { enabled?: boolean; manual?: boolean; packageName?: string } = {}): DeviceStatsState {
  const { enabled = true, manual = false, packageName } = options;
  const key = `${deviceId}/${scope}/${packageName ?? ''}`;
  const [sampleKey, setSampleKey] = useState(key);
  const [samples, setSamples] = useState<{ stats: DeviceStats | null; previous: DeviceStats | null }>({
    stats: null,
    previous: null,
  });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<number | null>(null);
  const generation = useRef(0);

  const fetchOnce = useCallback(async () => {
    if (!enabled || !deviceId || inFlight.current !== null) return;
    const gen = generation.current;
    inFlight.current = gen;
    setLoading(true);
    try {
      const next = await api.getStats(deviceId, scope, packageName);
      if (gen !== generation.current) return;
      setSampleKey(key);
      setSamples((prev) => ({ stats: next, previous: prev.stats }));
      setError(null);
    } catch (err) {
      if (gen !== generation.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (inFlight.current === gen) inFlight.current = null;
      if (gen === generation.current) setLoading(false);
    }
  }, [deviceId, scope, packageName, enabled, key]);

  // New device or scope: drop old samples so rates never span two devices.
  useEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    setSampleKey(key);
    setSamples({ stats: null, previous: null });
    setError(null);
    setLoading(false);
  }, [deviceId, scope, packageName, key]);

  useEffect(() => {
    if (!deviceId || !enabled || manual) return;
    void fetchOnce();
    if (intervalMs <= 0) return;
    const timer = setInterval(() => void fetchOnce(), intervalMs);
    return () => clearInterval(timer);
  }, [deviceId, intervalMs, fetchOnce, enabled, manual]);

  return { ...(sampleKey === key ? samples : { stats: null, previous: null }), error: sampleKey === key ? error : null, loading, refresh: () => void fetchOnce() };
}

/** Why KPI values cannot be shown yet, or null once a sample is available. */
export function statsPendingReason(deviceId: string | null, state: DeviceStatsState): string | null {
  if (!deviceId) return 'No device selected';
  if (state.stats) return null;
  if (state.error) return `Unavailable: ${state.error}`;
  return 'Reading device…';
}

/** Seconds between two samples, or null when a rate cannot be computed. */
export function sampleSeconds(state: Pick<DeviceStatsState, 'stats' | 'previous'>): number | null {
  if (!state.stats || !state.previous) return null;
  const dt = (state.stats.collectedAt - state.previous.collectedAt) / 1000;
  return dt > 0 ? dt : null;
}
