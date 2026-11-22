import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Star } from 'lucide-react';
import { fuzzyScore } from '../lib/packageList.js';

export interface WorkbenchBadge {
  label: string;
  type?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
}

export interface WorkbenchItem {
  id: string;
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  badges?: WorkbenchBadge[];
  /** Filter ids this item belongs to; every item belongs to 'all'. */
  tags?: string[];
  /** false hides the pin toggle on this row. */
  pinnable?: boolean;
}

export interface WorkbenchFilter { id: string; label: string }

/** Search field of a workbench list: icon and `/` shortcut hint sit inside the field. */
export const ListSearch = React.forwardRef<HTMLInputElement, {
  placeholder: string; label: string; value: string; onChange: (value: string) => void; onKeyDown: (e: React.KeyboardEvent) => void;
}>(({ placeholder, label, value, onChange, onKeyDown }, ref) => (
  <div className="app-search">
    <Search size={13} aria-hidden="true" />
    <input ref={ref} type="search" className="input text-xs font-mono" placeholder={placeholder}
      aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} onKeyDown={onKeyDown} />
    {!value && <kbd aria-hidden="true">/</kbd>}
  </div>
));
ListSearch.displayName = 'ListSearch';

/** One chip per filter with its count; the chip shows the label without its parenthetical hint, which moves to the tooltip. */
export const FilterChips: React.FC<{
  label: string; filters: WorkbenchFilter[]; value: string; counts: Record<string, number> | null; onChange: (id: string) => void;
}> = ({ label, filters, value, counts, onChange }) => (
  <div className="chip-row list-filter-chips" role="group" aria-label={label}>
    {filters.map((f) => (
      <button key={f.id} type="button" className={`chip-button ${value === f.id ? 'active' : ''}`} aria-pressed={value === f.id}
        title={f.label} onClick={() => onChange(f.id)}>
        <span>{f.label.replace(/\s*\(.*\)$/, '')}</span>
        {counts && <span className="chip-count">{counts[f.id] ?? 0}</span>}
      </button>
    ))}
  </div>
);

/** Rows rendered per page of the list; more load on scroll. */
const PAGE = 150;

interface Props {
  items: WorkbenchItem[] | null;
  /** Accessible name of the listbox, e.g. "Folder entries". */
  label: string;
  placeholder: string;
  filters?: WorkbenchFilter[];
  filter?: string;
  onFilter?: (filter: string) => void;
  selected: string;
  onSelect: (id: string) => void;
  /** Double-click or Enter on the selected row, e.g. open a folder. */
  onOpen?: (id: string) => void;
  pinned?: WorkbenchItem[];
  recent?: WorkbenchItem[];
  isPinned?: (id: string) => boolean;
  onTogglePin?: (item: WorkbenchItem) => void;
  /** Buttons beside the search field. */
  toolbar?: React.ReactNode;
  /** Controls beside the filter select. */
  filterbar?: React.ReactNode;
  /** Loading, error and empty messages shown above the rows. */
  status?: React.ReactNode;
  /** Shown when the search matches nothing. */
  noMatch?: (query: string) => React.ReactNode;
}

const Row: React.FC<{ item: WorkbenchItem; active: boolean; cursor: boolean; pinned: boolean | null; onSelect: () => void; onOpen?: () => void; onTogglePin: () => void }> = ({ item, active, cursor, pinned, onSelect, onOpen, onTogglePin }) => (
  <div role="option" aria-selected={active} data-id={item.id} className={`app-row ${active ? 'app-row-active' : ''} ${cursor ? 'app-row-cursor' : ''}`}
    onClick={onSelect} onDoubleClick={onOpen} title={item.subtitle ?? item.title}>
    {item.icon}
    <span className="app-row-main">
      <span className="app-row-top">
        <span className="app-row-tail">{item.title}</span>
        <span className="app-row-badges">
          {item.badges?.map((b) => <span key={b.label} className={`badge badge-${b.type ?? 'neutral'}`}>{b.label}</span>)}
        </span>
      </span>
      {item.subtitle && <span className="app-row-sub"><span className="app-row-name font-mono">{item.subtitle}</span></span>}
    </span>
    {pinned !== null && (
      <button type="button" className={`btn btn-ghost btn-xs app-pin ${pinned ? 'app-pin-on' : ''}`} aria-label={pinned ? `Unpin ${item.title}` : `Pin ${item.title}`}
        onClick={(e) => { e.stopPropagation(); onTogglePin(); }}>
        <Star size={12} />
      </button>
    )}
  </div>
);

/** Searchable, filterable picker for the list side of a workbench (same behavior as the package list). */
export const WorkbenchList: React.FC<Props> = (p) => {
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [cursor, setCursor] = useState(-1);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const filter = p.filter ?? 'all';

  // `/` focuses the search unless the user is already typing somewhere or another visible list took it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.defaultPrevented || t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (!searchRef.current || searchRef.current.closest('[hidden]')) return;
      e.preventDefault();
      searchRef.current.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const inFilter = (item: WorkbenchItem, id: string) => id === 'all' || (item.tags ?? []).includes(id);
  const matchesQuery = (item: WorkbenchItem) => fuzzyScore(item.title, query) ?? (item.subtitle ? fuzzyScore(item.subtitle, query) : null);
  const matches = useMemo(() => (p.items ?? [])
    .map((item) => ({ item, score: inFilter(item, filter) ? matchesQuery(item) : null }))
    .filter((x): x is { item: WorkbenchItem; score: number } => x.score !== null)
    .sort((x, y) => x.score - y.score)
    .map((x) => x.item),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  [p.items, query, filter]);
  const counts = useMemo(() => Object.fromEntries((p.filters ?? []).map((f) => [f.id, (p.items ?? []).filter((i) => inFilter(i, f.id)).length])), [p.items, p.filters]);

  const pinnedItems = (p.pinned ?? []).filter((i) => !query || matchesQuery(i) !== null);
  const recentItems = (p.recent ?? []).filter((i) => !pinnedItems.some((x) => x.id === i.id) && (!query || matchesQuery(i) !== null));
  const visible = matches.slice(0, limit);
  const keyboardOrder = [...pinnedItems, ...recentItems, ...visible].map((i) => i.id);

  useEffect(() => { setLimit(PAGE); setCursor(-1); }, [query, filter]);

  const move = (delta: number) => {
    if (!keyboardOrder.length) return;
    const next = Math.max(0, Math.min(keyboardOrder.length - 1, cursor + delta));
    setCursor(next);
    listRef.current?.querySelectorAll('[data-id]')[next]?.scrollIntoView?.({ block: 'nearest' });
  };

  const onSearchKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'Enter') {
      const id = keyboardOrder[cursor >= 0 ? cursor : 0];
      if (!id) return;
      if (id === p.selected && p.onOpen) p.onOpen(id);
      else p.onSelect(id);
    } else if (e.key === 'Escape') setQuery('');
  };

  const rows = (items: WorkbenchItem[], offset: number) => items.map((item, i) => (
    <Row key={`${offset}-${item.id}`} item={item} active={item.id === p.selected} cursor={cursor === offset + i}
      pinned={p.onTogglePin && item.pinnable !== false ? p.isPinned?.(item.id) ?? false : null}
      onSelect={() => p.onSelect(item.id)} onOpen={p.onOpen ? () => p.onOpen!(item.id) : undefined} onTogglePin={() => p.onTogglePin?.(item)} />
  ));
  const filterLabel = p.filters ? p.filters.find((f) => f.id === filter)?.label ?? 'All' : p.label;

  return (
    <div className="workspace-panel app-list">
      <div className="app-list-toolbar">
        <ListSearch ref={searchRef} placeholder={p.placeholder} label={p.placeholder.replace(/…$/, '')} value={query} onChange={setQuery} onKeyDown={onSearchKey} />
        {p.toolbar}
      </div>
      {(p.filters || p.filterbar) && (
        <div className="app-list-filterbar">
          {p.filters && <FilterChips label={`${p.label} filter`} filters={p.filters} value={filter} counts={p.items ? counts : null} onChange={(id) => p.onFilter?.(id)} />}
          {p.filterbar}
        </div>
      )}

      <div className="app-list-scroll" role="listbox" aria-label={p.label} ref={listRef}
        onScroll={(e) => { const el = e.currentTarget; if (el.scrollTop + el.clientHeight > el.scrollHeight - 200 && limit < matches.length) setLimit(limit + PAGE); }}>
        {p.status}
        {pinnedItems.length > 0 && <><div className="app-list-heading">Pinned</div>{rows(pinnedItems, 0)}</>}
        {recentItems.length > 0 && <><div className="app-list-heading">Recent</div>{rows(recentItems, pinnedItems.length)}</>}
        {p.items && p.items.length > 0 && <div className="app-list-heading">{filterLabel} ({matches.length})</div>}
        {rows(visible, pinnedItems.length + recentItems.length)}
        {p.items && matches.length === 0 && query && <div className="text-xs text-dim">{p.noMatch ? p.noMatch(query) : `Nothing matches “${query}”.`}</div>}
      </div>
    </div>
  );
};

/** Placeholder for the detail side while nothing is selected. */
export const WorkbenchEmpty: React.FC<{ icon: React.ReactNode; children: React.ReactNode; openHint?: string }> = ({ icon, children, openHint }) => (
  <div className="workspace-panel app-detail-empty">
    {icon}
    <p className="text-xs text-dim">{children}</p>
    <p className="text-xs text-dim app-hints"><kbd>/</kbd> search · <kbd>↑</kbd><kbd>↓</kbd> move · <kbd>Enter</kbd> {openHint ?? 'open'}</p>
  </div>
);
