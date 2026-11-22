// Package picker: parsers for the `packages`, `foreground` and `package` stats
// scopes, and the per-device app selection shared by every page.
import { useCallback, useSyncExternalStore } from 'react';
import type { StatSection } from '../api/client.js';

type Sections = Record<string, StatSection> | undefined;

export interface AppEntry {
  name: string;
  codePath: string | null;
  uid: number | null;
  versionCode: string | null;
  installer: string | null;
  /** null when the device did not report the flag. */
  system: boolean | null;
  disabled: boolean | null;
  running: boolean | null;
}

const ok = (sections: Sections, key: string): string | null => {
  const section = sections?.[key];
  return section && section.exitCode === 0 ? section.output : null;
};

const lines = (text: string | null): string[] =>
  text ? text.split('\n').map((l) => l.trim()).filter(Boolean) : [];

/** `package:NAME rest…` → [NAME, rest]. */
function packageLines(text: string | null): [string, string][] {
  return lines(text)
    .filter((l) => l.startsWith('package:'))
    .map((l) => {
      const body = l.slice('package:'.length);
      const space = body.search(/\s/);
      return space < 0 ? [body, ''] : [body.slice(0, space), body.slice(space).trim()];
    });
}

const nameSet = (text: string | null): Set<string> | null =>
  text === null ? null : new Set(packageLines(text).map(([name]) => name));

/** Merges the `packages` scope sections into one row per package, sorted by name. */
export function parsePackageList(sections: Sections): AppEntry[] | null {
  const paths = new Map<string, string>();
  for (const l of lines(ok(sections, 'packageList'))) {
    if (!l.startsWith('package:')) continue;
    const body = l.slice('package:'.length);
    const eq = body.lastIndexOf('=');
    if (eq > 0) paths.set(body.slice(eq + 1), body.slice(0, eq));
  }
  const uids = new Map<string, number>();
  for (const [name, rest] of packageLines(ok(sections, 'packageUids'))) {
    const m = /uid:(\d+)/.exec(rest);
    if (m) uids.set(name, Number(m[1]));
  }
  const versions = new Map<string, string>();
  for (const [name, rest] of packageLines(ok(sections, 'packageVersions'))) {
    const m = /versionCode:(\d+)/.exec(rest);
    if (m) versions.set(name, m[1]);
  }
  const installers = new Map<string, string>();
  for (const [name, rest] of packageLines(ok(sections, 'packageInstallers'))) {
    const m = /installer=(\S+)/.exec(rest);
    if (m && m[1] !== 'null') installers.set(name, m[1]);
  }
  const system = nameSet(ok(sections, 'systemPackages'));
  const disabled = nameSet(ok(sections, 'disabledPackages'));
  const runningText = ok(sections, 'runningProcesses');
  const processes = runningText === null ? null : new Set(lines(runningText).map((p) => p.split(':')[0]));

  const names = new Set([...paths.keys(), ...uids.keys(), ...versions.keys(), ...installers.keys()]);
  if (names.size === 0) return null;
  return [...names].sort().map((name) => ({
    name,
    codePath: paths.get(name) ?? null,
    uid: uids.get(name) ?? null,
    versionCode: versions.get(name) ?? null,
    installer: installers.get(name) ?? null,
    system: system ? system.has(name) : null,
    disabled: disabled ? disabled.has(name) : null,
    running: processes ? processes.has(name) : null,
  }));
}

const COMPONENT = /([A-Za-z_][\w.]*)\/([\w.$]+)/;

/** Resumed activity from `dumpsys activity activities`. */
export function parseForeground(sections: Sections): { package: string; component: string } | null {
  for (const l of lines(sections?.resumed?.output ?? null)) {
    const m = COMPONENT.exec(l);
    if (m) return { package: m[1], component: `${m[1]}/${m[2]}` };
  }
  return null;
}

/** Launcher component from `cmd package resolve-activity --brief`. */
export function parseLauncher(sections: Sections): string | null {
  const found = lines(ok(sections, 'launcher')).filter((l) => /^[A-Za-z_][\w.]*\/[\w.$]+$/.test(l));
  if (!found.length) return null;
  const [pkg, cls] = found[found.length - 1].split('/');
  return `${pkg}/${cls.startsWith('.') ? `${pkg}${cls}` : cls}`;
}

/** Activity components of `pkg` from the `Activity Resolver Table` of `dumpsys package`. */
export function parseActivities(details: string | null | undefined, pkg: string): string[] {
  if (!details) return [];
  const found = new Set<string>();
  let inActivities = false;
  for (const line of details.split('\n')) {
    // Top-level headers ("Activity Resolver Table:", "Service Resolver Table:", …) are unindented.
    if (line && !/^\s/.test(line)) inActivities = line.trim() === 'Activity Resolver Table:';
    if (!inActivities) continue;
    for (const m of line.matchAll(/([A-Za-z_][\w.]*)\/([\w.$]+)/g)) {
      if (m[1] !== pkg) continue;
      found.add(`${pkg}/${m[2].startsWith('.') ? `${pkg}${m[2]}` : m[2]}`);
    }
  }
  return [...found].sort();
}

/** APK paths from `pm path`. */
export function parsePaths(output: string | null | undefined): string[] {
  return lines(output ?? null).filter((l) => l.startsWith('package:')).map((l) => l.slice('package:'.length));
}

// --- Per-device selection, pinned and recent apps (browser storage) ---

export interface AppSelection {
  selected: string;
  pinned: string[];
  recent: string[];
}

const EMPTY: AppSelection = { selected: '', pinned: [], recent: [] };
const RECENT_LIMIT = 8;
const cache = new Map<string, AppSelection>();
const listeners = new Set<() => void>();

const storageKey = (deviceId: string) => `andrui_apps_${deviceId}`;

function load(deviceId: string | null): AppSelection {
  if (!deviceId) return EMPTY;
  const hit = cache.get(deviceId);
  if (hit) return hit;
  let value = EMPTY;
  try {
    const raw = localStorage.getItem(storageKey(deviceId));
    if (raw) value = { ...EMPTY, ...JSON.parse(raw) };
  } catch { /* unavailable storage: start empty */ }
  cache.set(deviceId, value);
  return value;
}

function save(deviceId: string, value: AppSelection) {
  cache.set(deviceId, value);
  try { localStorage.setItem(storageKey(deviceId), JSON.stringify(value)); } catch { /* keep in memory */ }
  listeners.forEach((l) => l());
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Selects `pkg` on `deviceId` from outside React (command palette, install). */
export function selectApp(deviceId: string | null, pkg: string) {
  if (!deviceId) return;
  const current = load(deviceId);
  const name = pkg.trim();
  const recent = name ? [name, ...current.recent.filter((p) => p !== name)].slice(0, RECENT_LIMIT) : current.recent;
  save(deviceId, { ...current, selected: name, recent });
}

export function useAppSelection(deviceId: string | null) {
  const state = useSyncExternalStore(subscribe, () => load(deviceId));
  const select = useCallback((pkg: string) => selectApp(deviceId, pkg), [deviceId]);
  /** Updates the selection while typing, without recording a recent entry. */
  const setDraft = useCallback((pkg: string) => {
    if (deviceId) save(deviceId, { ...load(deviceId), selected: pkg });
  }, [deviceId]);
  const togglePin = useCallback((pkg: string) => {
    if (!deviceId) return;
    const current = load(deviceId);
    const pinned = current.pinned.includes(pkg) ? current.pinned.filter((p) => p !== pkg) : [...current.pinned, pkg];
    save(deviceId, { ...current, pinned });
  }, [deviceId]);
  return { ...state, select, setDraft, togglePin };
}

/** Subsequence match ("chrm" matches "com.android.chrome"); lower score is better, null is no match. */
export function fuzzyScore(name: string, query: string): number | null {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const n = name.toLowerCase();
  const index = n.indexOf(q);
  if (index >= 0) return index;
  let pos = -1;
  let gaps = 0;
  for (const ch of q) {
    const next = n.indexOf(ch, pos + 1);
    if (next < 0) return null;
    if (pos >= 0) gaps += next - pos - 1;
    pos = next;
  }
  return 1000 + gaps;
}
