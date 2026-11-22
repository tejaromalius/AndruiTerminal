import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Crosshair, Plus, RefreshCw, Star } from 'lucide-react';
import type { AppEntry } from '../lib/packageList.js';
import { fuzzyScore } from '../lib/packageList.js';
import { FilterChips, ListSearch } from './WorkbenchList.js';

export type AppFilter = 'all' | 'user' | 'system' | 'disabled' | 'running';

const FILTERS: [AppFilter, string, (a: AppEntry) => boolean | null][] = [
  ['all', 'All', () => true],
  ['user', 'User (-3)', (a) => (a.system === null ? null : !a.system)],
  ['system', 'System (-s)', (a) => a.system],
  ['disabled', 'Disabled (-d)', (a) => a.disabled],
  ['running', 'Running', (a) => a.running],
];

/** Rows rendered per page of the list; more load on scroll. */
const PAGE = 150;

interface Props {
  apps: AppEntry[] | null;
  loading: boolean;
  error: string | null;
  deviceReady: boolean;
  selected: string;
  pinned: string[];
  recent: string[];
  filter: AppFilter;
  onFilter: (filter: AppFilter) => void;
  onSelect: (pkg: string) => void;
  onTogglePin: (pkg: string) => void;
  onRefresh: () => void;
  onInstall: () => void;
  onForeground: () => void;
  foregroundBusy: boolean;
  foregroundNote: string | null;
}

/** Last dot-separated segment, which is what usually tells apps apart ("carrierwifi"). */
const GENERIC = new Set(['android', 'app', 'apps', 'mobile', 'client', 'main', 'free', 'lite', 'pro']);
const tailOf = (name: string) => {
  const parts = name.split('.');
  const last = parts[parts.length - 1];
  // "com.github.android" → "github.android": a generic last segment alone says nothing.
  return GENERIC.has(last.toLowerCase()) && parts.length > 1 ? parts.slice(-2).join('.') : last;
};

const Row: React.FC<{ app: AppEntry; active: boolean; cursor: boolean; pinned: boolean; onSelect: () => void; onTogglePin: () => void }> = ({ app, active, cursor, pinned, onSelect, onTogglePin }) => (
  <div role="option" aria-selected={active} data-pkg={app.name} className={`app-row ${active ? 'app-row-active' : ''} ${cursor ? 'app-row-cursor' : ''}`} onClick={onSelect} title={app.name}>
    <span className="app-row-main">
      <span className="app-row-top">
        <span className="app-row-tail">{tailOf(app.name)}</span>
        <span className="app-row-badges">
          {app.system !== null && <span className="badge badge-neutral">{app.system ? 'system' : 'user'}</span>}
          {app.disabled && <span className="badge badge-warning">disabled</span>}
          {app.running && <span className="badge badge-success">running</span>}
        </span>
      </span>
      <span className="app-row-sub">
        {app.name.includes('.') && <span className="app-row-name font-mono">{app.name}</span>}
        {app.versionCode && <span className="text-dim font-mono">{app.versionCode}</span>}
      </span>
    </span>
    <button type="button" className={`btn btn-ghost btn-xs app-pin ${pinned ? 'app-pin-on' : ''}`} aria-label={pinned ? `Unpin ${app.name}` : `Pin ${app.name}`}
      onClick={(e) => { e.stopPropagation(); onTogglePin(); }}>
      <Star size={12} />
    </button>
  </div>
);

/** Searchable, filterable package picker with pinned and recent apps. */
export const AppList: React.FC<Props> = (p) => {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // `/` focuses the search unless the user is already typing somewhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const byName = useMemo(() => new Map((p.apps ?? []).map((a) => [a.name, a])), [p.apps]);
  const test = FILTERS.find(([id]) => id === p.filter)![2];
  const matches = useMemo(() => {
    if (!p.apps) return [];
    return p.apps
      .map((a) => ({ a, score: test(a) ? fuzzyScore(a.name, query) : null }))
      .filter((x): x is { a: AppEntry; score: number } => x.score !== null)
      .sort((x, y) => x.score - y.score || x.a.name.localeCompare(y.a.name))
      .map((x) => x.a);
  }, [p.apps, query, test]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map(([id, , f]) => [id, (p.apps ?? []).filter((a) => f(a)).length])), [p.apps]);
  const unknownFilter = p.apps !== null && p.filter !== 'all' && p.apps.every((a) => test(a) === null);

  const quick = (names: string[]) => names
    .map((n) => byName.get(n) ?? { name: n, codePath: null, uid: null, versionCode: null, installer: null, system: null, disabled: null, running: null })
    .filter((a) => !query || fuzzyScore(a.name, query) !== null);
  const pinnedApps = quick(p.pinned);
  const recentApps = quick(p.recent.filter((n) => !p.pinned.includes(n)));
  const visible = matches.slice(0, limit);
  const keyboardOrder = [...pinnedApps, ...recentApps, ...visible].map((a) => a.name);

  useEffect(() => { setLimit(PAGE); setCursor(-1); }, [query, p.filter]);

  const move = (delta: number) => {
    if (!keyboardOrder.length) return;
    const next = Math.max(0, Math.min(keyboardOrder.length - 1, cursor + delta));
    setCursor(next);
    listRef.current?.querySelectorAll('[data-pkg]')[next]?.scrollIntoView?.({ block: 'nearest' });
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      const name = keyboardOrder[cursor >= 0 ? cursor : 0];
      if (name) p.onSelect(name);
      // Allow selecting an unlisted package by typing its exact name.
      else if (/^[A-Za-z_][\w]*(\.[A-Za-z_]\w*)+$/.test(query.trim())) p.onSelect(query.trim());
    } else if (e.key === 'Escape') setQuery('');
  };

  const rows = (apps: AppEntry[], offset: number) => apps.map((a, i) => (
    <Row key={`${offset}-${a.name}`} app={a} active={a.name === p.selected} cursor={cursor === offset + i}
      pinned={p.pinned.includes(a.name)} onSelect={() => p.onSelect(a.name)} onTogglePin={() => p.onTogglePin(a.name)} />
  ));

  return (
    <div className="workspace-panel app-list">
      <div className="app-list-toolbar">
        <ListSearch ref={searchRef} placeholder="Filter packages…" label="Filter packages" value={query} onChange={setQuery} onKeyDown={onSearchKey} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={p.onRefresh} disabled={!p.deviceReady || p.loading} title="Reload package list">
          <RefreshCw size={13} className={p.loading ? 'animate-spin' : undefined} />
        </button>
        <button type="button" className="btn btn-primary btn-sm" onClick={p.onInstall} title="Install APK/APEX">
          <Plus size={13} /><span>Install</span>
        </button>
      </div>
      <div className="app-list-filterbar">
        <FilterChips label="Package filter" filters={FILTERS.map(([id, label]) => ({ id, label }))} value={p.filter}
          counts={p.apps ? counts : null} onChange={(id) => p.onFilter(id as AppFilter)} />
        <button type="button" className="btn btn-ghost btn-xs" onClick={p.onForeground} disabled={!p.deviceReady || p.foregroundBusy} title="Select the app currently on screen">
          <Crosshair size={13} /><span>{p.foregroundBusy ? 'Reading…' : 'Foreground app'}</span>
        </button>
      </div>
      {p.foregroundNote && <div className="text-xs text-dim">{p.foregroundNote}</div>}

      <div className="app-list-scroll" role="listbox" aria-label="Installed packages" ref={listRef}
        onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && limit < matches.length) setLimit(limit + PAGE); }}>
        {!p.deviceReady && <div className="text-xs text-dim">Select a device to list its packages.</div>}
        {p.deviceReady && p.error && <div className="text-xs text-rose-400">Package list unavailable: {p.error}</div>}
        {pinnedApps.length > 0 && <><div className="app-list-heading">Pinned</div>{rows(pinnedApps, 0)}</>}
        {recentApps.length > 0 && <><div className="app-list-heading">Recent</div>{rows(recentApps, pinnedApps.length)}</>}
        {p.apps && <div className="app-list-heading">{p.filter === 'all' ? 'All' : FILTERS.find(([id]) => id === p.filter)![1]} ({matches.length})</div>}
        {unknownFilter && <div className="text-xs text-dim">This device did not report the data for this filter.</div>}
        {rows(visible, pinnedApps.length + recentApps.length)}
        {p.deviceReady && !p.apps && !p.error && <div className="text-xs text-dim">Reading package list…</div>}
        {p.apps && matches.length === 0 && query && <div className="text-xs text-dim">No package matches “{query}”. Press Enter to use it as typed.</div>}
      </div>
    </div>
  );
};
