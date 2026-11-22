import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, ChevronDown, ChevronLeft, ChevronRight, Code, Columns3, Eye, History,
  KeyRound, Play, Plus, RefreshCw, Rows3, Save, Search, Table2, Trash2, Upload, X,
} from 'lucide-react';
import { api, ApiError } from '../api/client.js';
import type { DbQueryResult, DbSchema, DbSnapshot, DbTable } from '../types/api.js';

/** `"name"` with embedded quotes doubled, safe as an SQLite identifier. */
export const quoteIdent = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** SQLite literal for a cell value read back from the API. */
export function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const ROWID = '__andrui_rowid__';
const isBlob = (v: unknown): v is { $blob: string; len: number } => typeof v === 'object' && v !== null && '$blob' in v;

function errMessage(e: unknown): string {
  return e instanceof ApiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
}

const Cell: React.FC<{ value: unknown }> = ({ value }) => {
  if (value === null || value === undefined) return <span className="db-null">NULL</span>;
  if (isBlob(value)) return <span className="db-blob">BLOB · {value.len.toLocaleString()} B</span>;
  if (typeof value === 'object') return <>{JSON.stringify(value)}</>;
  return <>{String(value)}</>;
};

const ResultGrid: React.FC<{
  result: DbQueryResult;
  hidden?: string;
  offset?: number;
  sort?: { col: string; desc: boolean } | null;
  onSort?: (col: string) => void;
  selected?: number | null;
  onSelect?: (index: number) => void;
}> = ({ result, hidden, offset = 0, sort, onSort, selected, onSelect }) => {
  const visible = result.columns.map((c, i) => [c, i] as const).filter(([c]) => c !== hidden);
  return (
    <div className="db-grid-wrap">
      <table className={`db-grid ${onSelect ? 'db-grid-selectable' : ''}`}>
        <thead>
          <tr>
            <th className="db-rownum">#</th>
            {visible.map(([c]) => (
              <th key={c}>
                {onSort ? (
                  <button type="button" onClick={() => onSort(c)} title={`Sort by ${c}`}>
                    <span>{c}</span>
                    {sort?.col === c && (sort.desc ? <ArrowDown size={11} /> : <ArrowUp size={11} />)}
                  </button>
                ) : c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr key={i} className={selected === i ? 'selected' : undefined} onClick={onSelect ? () => onSelect(i) : undefined}>
              <td className="db-rownum">{offset + i + 1}</td>
              {visible.map(([c, j]) => <td key={c} title={typeof row[j] === 'string' ? (row[j] as string) : undefined}><Cell value={row[j]} /></td>)}
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length === 0 && <div className="db-grid-empty">No rows</div>}
    </div>
  );
};

type Draft = Record<string, { value: string; isNull: boolean }>;

/** Edit one existing row, or compose a new one, against the host snapshot copy. */
const RowEditor: React.FC<{
  table: DbTable;
  row: Record<string, unknown> | null;
  /** Which row is open, e.g. `products · row 3`. */
  subtitle: string;
  busy: boolean;
  onSave: (changes: Record<string, string | null>) => void;
  onDelete?: () => void;
  onClose: () => void;
}> = ({ table, row, subtitle, busy, onSave, onDelete, onClose }) => {
  const initial = (): Draft => Object.fromEntries(table.columns.map((c) => {
    const v = row?.[c.name];
    return [c.name, { value: v === null || v === undefined || isBlob(v) ? '' : String(v), isNull: row ? v === null : false }];
  }));
  const [draft, setDraft] = useState<Draft>(initial);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(initial()), [row, table]);

  const changes = (): Record<string, string | null> => {
    const out: Record<string, string | null> = {};
    for (const c of table.columns) {
      const d = draft[c.name];
      if (!d || isBlob(row?.[c.name])) continue;
      if (row) {
        const before = row[c.name];
        const now = d.isNull ? null : d.value;
        if ((before === null ? null : String(before)) !== now) out[c.name] = now;
      } else if (d.isNull || d.value !== '') {
        out[c.name] = d.isNull ? null : d.value;
      }
    }
    return out;
  };
  const changed = changes();
  const pending = Object.keys(changed).length;
  const [fieldFilter, setFieldFilter] = useState('');
  const shown = table.columns.filter((c) => !fieldFilter || c.name.toLowerCase().includes(fieldFilter.toLowerCase()));
  const canSave = !busy && (!row || pending > 0);

  return (
    <aside className="db-editor" aria-label={row ? 'Edit row' : 'Insert row'}
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose();
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && canSave) { e.preventDefault(); onSave(changed); }
      }}>
      <div className="db-pane-head db-editor-head">
        <div className="db-editor-heading">
          <span className="inspect-card-title">{row ? <><Rows3 size={14} />Edit row</> : <><Plus size={14} />New row</>}</span>
          <span className="db-editor-sub font-mono" title={subtitle}>{subtitle}</span>
        </div>
        <button type="button" className="btn btn-ghost btn-xs" onClick={onClose} aria-label="Close row editor"><X size={13} /></button>
      </div>
      {table.columns.length > 8 && (
        <div className="db-search db-editor-search">
          <Search size={12} />
          <input className="input" placeholder={`Find among ${table.columns.length} fields`} aria-label="Find field" value={fieldFilter} onChange={(e) => setFieldFilter(e.target.value)} />
        </div>
      )}
      <div className="db-editor-fields">
        {shown.map((c) => {
          const d = draft[c.name] ?? { value: '', isNull: false };
          const blob = isBlob(row?.[c.name]);
          const long = d.value.length > 40 || d.value.includes('\n');
          const set = (patch: Partial<typeof d>) => setDraft((prev) => ({ ...prev, [c.name]: { ...d, ...patch } }));
          const dirty = c.name in changed;
          return (
            <div key={c.name} className={`db-field ${dirty ? 'dirty' : ''}`}>
              <div className="db-field-label">
                {c.pk > 0 && <KeyRound size={11} className="text-warning" aria-label="primary key" />}
                <span className="font-mono db-field-name" title={c.name}>{c.name}</span>
                <span className="db-field-type">{c.type || 'ANY'}{c.notNull ? ' · NOT NULL' : ''}</span>
                {dirty && <span className="db-field-dot" title="Changed" />}
              </div>
              {blob ? (
                <span className="db-blob">BLOB · {(row?.[c.name] as { len: number }).len.toLocaleString()} B (read-only)</span>
              ) : (
                <div className="db-field-control">
                  {long ? (
                    <textarea className="input font-mono" rows={Math.min(6, Math.ceil(d.value.length / 40) + 1)} aria-label={c.name} value={d.isNull ? '' : d.value}
                      placeholder={d.isNull ? 'NULL' : ''} disabled={d.isNull} onChange={(e) => set({ value: e.target.value })} />
                  ) : (
                    <input className="input font-mono" aria-label={c.name} value={d.isNull ? '' : d.value} disabled={d.isNull}
                      placeholder={d.isNull ? 'NULL' : row ? '' : 'default'} onChange={(e) => set({ value: e.target.value })} />
                  )}
                  {!c.notNull && (
                    <button type="button" className={`db-null-btn ${d.isNull ? 'active' : ''}`} aria-pressed={d.isNull}
                      aria-label={`Set ${c.name} to NULL`} title="Toggle NULL" onClick={() => set({ isNull: !d.isNull })}>NULL</button>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {shown.length === 0 && <div className="db-tree-empty">No fields match</div>}
      </div>
      <div className="db-editor-actions">
        <span className="text-dim text-xs">{row ? (pending ? `${pending} field${pending === 1 ? '' : 's'} changed` : 'No changes') : 'Empty fields use the column default'}</span>
        <div className="db-editor-buttons">
          {onDelete && <button type="button" className="btn btn-danger btn-xs" disabled={busy} onClick={onDelete} aria-label="Delete row" title="Delete row"><Trash2 size={12} /></button>}
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy || (!!row && pending === 0)} onClick={() => setDraft(initial())}>Reset</button>
          <button type="button" className="btn btn-primary btn-xs" disabled={!canSave} onClick={() => onSave(changed)} title="Ctrl+Enter">
            <Save size={12} />{row ? 'Save row' : 'Insert row'}
          </button>
        </div>
      </div>
    </aside>
  );
};

type Tab = 'data' | 'structure' | 'sql';

/**
 * pgAdmin-style browser for one host snapshot: object tree, paged table data
 * with row editing, structure/DDL, and a SQL editor. Every write targets the
 * host copy; only `onPush` writes back to the device.
 */
export const DatabaseBrowser: React.FC<{ snapshot: DbSnapshot; onPush: () => void; pushing: boolean }> = ({ snapshot, onPush, pushing }) => {
  const [schema, setSchema] = useState<DbSchema | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [tableName, setTableName] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('data');
  const [treeFilter, setTreeFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [sort, setSort] = useState<{ col: string; desc: boolean } | null>(null);
  const [whereDraft, setWhereDraft] = useState('');
  const [where, setWhere] = useState('');
  const [data, setData] = useState<DbQueryResult | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [selectedRow, setSelectedRow] = useState<number | null>(null);
  const [inserting, setInserting] = useState(false);

  const [ddl, setDdl] = useState<DbQueryResult | null>(null);
  const [sql, setSql] = useState('');
  const [sqlResult, setSqlResult] = useState<DbQueryResult | null>(null);
  const [history, setHistory] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [modified, setModified] = useState(false);

  const table = schema?.tables.find((t) => t.name === tableName) ?? null;
  const isView = table?.type === 'view';
  const pkCols = table?.columns.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk) ?? [];
  const usesRowid = !!table && !isView && pkCols.length === 0;

  const guard = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(errMessage(e)); } finally { setBusy(false); }
  };

  const loadSchema = async () => {
    const next = await api.dbSchema(snapshot.id);
    setSchema(next);
    const tables = next.tables.filter((t) => t.type === 'table');
    if (tables.length) {
      const r = await api.dbQuery(snapshot.id, tables.map((t) => `SELECT ${sqlLiteral(t.name)}, COUNT(*) FROM ${quoteIdent(t.name)}`).join(' UNION ALL '), tables.length + 1);
      setCounts(Object.fromEntries(r.rows.map(([name, n]) => [String(name), Number(n)])));
    } else {
      setCounts({});
    }
    setTableName((current) => current && next.tables.some((t) => t.name === current) ? current : next.tables[0]?.name ?? null);
  };

  useEffect(() => {
    setTableName(null);
    setModified(false);
    setSqlResult(null);
    void guard(loadSchema);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.id]);

  const whereClause = where.trim() ? ` WHERE ${where.trim()}` : '';

  const loadData = async () => {
    if (!table) return;
    const from = `FROM ${quoteIdent(table.name)}${whereClause}`;
    const order = sort ? ` ORDER BY ${quoteIdent(sort.col)} ${sort.desc ? 'DESC' : 'ASC'}` : '';
    const select = usesRowid ? `rowid AS ${quoteIdent(ROWID)}, *` : '*';
    const [rows, count] = await Promise.all([
      api.dbQuery(snapshot.id, `SELECT ${select} ${from}${order} LIMIT ${pageSize} OFFSET ${page * pageSize}`, pageSize),
      api.dbQuery(snapshot.id, `SELECT COUNT(*) ${from}`, 1),
    ]);
    setData(rows);
    setTotal(Number(count.rows[0]?.[0] ?? 0));
  };

  useEffect(() => {
    setSelectedRow(null);
    if (tab === 'data' && table) void guard(loadData);
    if (tab === 'structure' && table) {
      void guard(async () => setDdl(await api.dbQuery(snapshot.id,
        `SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ${sqlLiteral(table.name)} AND sql IS NOT NULL ORDER BY type = 'index', name`, 100)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, tableName, schema, page, pageSize, sort, where]);

  const openTable = (name: string) => {
    if (name !== tableName) {
      setTableName(name);
      setPage(0);
      setSort(null);
      setWhere('');
      setWhereDraft('');
      setInserting(false);
    }
    if (tab === 'sql') setTab('data');
  };

  const rowObject = (index: number): Record<string, unknown> | null => {
    const row = data?.rows[index];
    if (!row || !data) return null;
    return Object.fromEntries(data.columns.map((c, i) => [c, row[i]]));
  };

  /** WHERE clause that pins one displayed row, by primary key or rowid. */
  const rowKey = (row: Record<string, unknown>): string | null => {
    const parts = usesRowid ? [['rowid', row[ROWID]] as const] : pkCols.map((c) => [quoteIdent(c.name), row[c.name]] as const);
    if (!parts.length || parts.some(([, v]) => v === undefined || isBlob(v))) return null;
    return parts.map(([k, v]) => (v === null ? `${k} IS NULL` : `${k} = ${sqlLiteral(v)}`)).join(' AND ');
  };

  const write = async (statement: string, message: string) => {
    const r = await api.dbExecute(snapshot.id, statement);
    setModified(true);
    setNote(`${message} (${r.rowsAffected ?? 0} row${r.rowsAffected === 1 ? '' : 's'} affected on the host copy)`);
    setHistory((h) => [statement, ...h.filter((s) => s !== statement)].slice(0, 15));
    await loadSchema();
  };

  const saveRow = (changes: Record<string, string | null>) => guard(async () => {
    if (!table) return;
    const cols = Object.keys(changes);
    if (inserting) {
      await write(cols.length
        ? `INSERT INTO ${quoteIdent(table.name)} (${cols.map(quoteIdent).join(', ')}) VALUES (${cols.map((c) => sqlLiteral(changes[c])).join(', ')})`
        : `INSERT INTO ${quoteIdent(table.name)} DEFAULT VALUES`, 'Row inserted');
      setInserting(false);
      return;
    }
    const row = selectedRow === null ? null : rowObject(selectedRow);
    const key = row && rowKey(row);
    if (!key) throw new Error('This row cannot be addressed by primary key or rowid.');
    await write(`UPDATE ${quoteIdent(table.name)} SET ${cols.map((c) => `${quoteIdent(c)} = ${sqlLiteral(changes[c])}`).join(', ')} WHERE ${key}`, 'Row updated');
    setSelectedRow(null);
  });

  const deleteRow = () => guard(async () => {
    if (!table || selectedRow === null) return;
    const row = rowObject(selectedRow);
    const key = row && rowKey(row);
    if (!key) throw new Error('This row cannot be addressed by primary key or rowid.');
    if (!window.confirm(`Delete this row from ${table.name} in the host copy? The device is not changed until you Push.`)) return;
    await write(`DELETE FROM ${quoteIdent(table.name)} WHERE ${key}`, 'Row deleted');
    setSelectedRow(null);
  });

  const runSql = (mode: 'query' | 'execute') => guard(async () => {
    const statement = sql.trim();
    if (!statement) return;
    if (mode === 'execute') {
      if (!window.confirm('Apply this statement to the host snapshot copy? The device is not changed until you Push.')) return;
      const r = await api.dbExecute(snapshot.id, statement);
      setSqlResult(r);
      if (r.rowsAffected != null) { setModified(true); await loadSchema(); }
    } else {
      setSqlResult(await api.dbQuery(snapshot.id, statement, 500));
    }
    setHistory((h) => [statement, ...h.filter((s) => s !== statement)].slice(0, 15));
  });

  const toggleSort = (col: string) => {
    setPage(0);
    setSort((s) => (s?.col !== col ? { col, desc: false } : !s.desc ? { col, desc: true } : null));
  };

  const filtered = useMemo(() => {
    const f = treeFilter.trim().toLowerCase();
    return (schema?.tables ?? []).filter((t) => !f || t.name.toLowerCase().includes(f) || t.columns.some((c) => c.name.toLowerCase().includes(f)));
  }, [schema, treeFilter]);

  const pages = total === null ? 1 : Math.max(1, Math.ceil(total / pageSize));
  // Stable per row so the editor only resets its draft when the selection or data changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const editingRow = useMemo(() => (selectedRow === null ? null : rowObject(selectedRow)), [data, selectedRow]);
  const editorOpen = tab === 'data' && !!table && (inserting || editingRow !== null);

  const group = (kind: 'table' | 'view', label: string, Icon: typeof Table2) => {
    const items = filtered.filter((t) => t.type === kind);
    if (!items.length) return null;
    return (
      <div className="db-tree-group">
        <div className="db-tree-group-label">{label} <span>{items.length}</span></div>
        {items.map((t) => {
          const open = expanded.has(t.name);
          return (
            <div key={t.name}>
              <div className={`db-tree-item ${t.name === tableName ? 'active' : ''}`}>
                <button type="button" className="db-tree-caret" aria-label={`${open ? 'Collapse' : 'Expand'} ${t.name} columns`}
                  onClick={() => setExpanded((s) => { const n = new Set(s); if (open) n.delete(t.name); else n.add(t.name); return n; })}>
                  {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                </button>
                <button type="button" className="db-tree-name" onClick={() => openTable(t.name)} title={t.name}>
                  <Icon size={13} /><span>{t.name}</span>
                  {counts[t.name] !== undefined && <span className="db-tree-count">{counts[t.name].toLocaleString()}</span>}
                </button>
              </div>
              {open && (
                <ul className="db-tree-columns">
                  {t.columns.map((c) => (
                    <li key={c.name}>
                      {c.pk > 0 ? <KeyRound size={10} className="text-warning" /> : <Columns3 size={10} />}
                      <span className="font-mono">{c.name}</span>
                      <span className="db-field-type">{c.type || 'ANY'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <section className="db-browser">
      <header className="db-browser-head">
        <div className="db-browser-title">
          <span className="inspect-card-title"><Table2 size={14} />{snapshot.databaseName}</span>
          <span className="text-dim text-xs">
            snapshot {new Date(snapshot.createdAt).toLocaleTimeString()} · {snapshot.sizeBytes.toLocaleString()} B · {snapshot.mode}{snapshot.hadWal ? ' · WAL' : ''}
          </span>
          {modified && <span className="badge badge-warning" title="The host copy differs from the device until you push it">modified · not on device</span>}
        </div>
        <div className="inspect-toolbar-actions">
          <button type="button" className="btn btn-secondary btn-xs" disabled={busy} onClick={() => guard(loadSchema)}><RefreshCw size={12} className={busy ? 'animate-spin' : undefined} />Refresh</button>
          <button type="button" className="btn btn-danger btn-xs" disabled={busy || pushing} onClick={onPush}><Upload size={12} />Push to device…</button>
        </div>
      </header>
      {error && <div className="inspect-note inspect-note-error"><AlertTriangle size={12} /> {error}</div>}
      {note && <div className="inspect-note inspect-note-success">{note}<button type="button" className="btn btn-ghost btn-xs" onClick={() => setNote(null)} aria-label="Dismiss"><X size={12} /></button></div>}

      <div className={`db-browser-body ${editorOpen ? 'db-browser-body-editing' : ''}`}>
        <aside className="db-tree" aria-label="Database objects">
          <div className="db-pane-head">
            <div className="db-search">
              <Search size={12} />
              <input className="input" placeholder="Filter tables or columns" aria-label="Filter tables or columns" value={treeFilter} onChange={(e) => setTreeFilter(e.target.value)} />
            </div>
          </div>
          <div className="db-pane-scroll">
            {!schema ? <div className="db-tree-empty">Loading schema…</div> : (
              <>
                {group('table', 'Tables', Table2)}
                {group('view', 'Views', Eye)}
                {filtered.length === 0 && <div className="db-tree-empty">{schema.tables.length ? 'No matches' : 'No tables'}</div>}
              </>
            )}
          </div>
        </aside>

        <div className="db-main">
          <div className="db-pane-head db-main-tabs" role="tablist" aria-label="Database view">
            {([['data', 'Data', Rows3], ['structure', 'Structure', Columns3], ['sql', 'SQL', Code]] as const).map(([id, label, Icon]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className="app-detail-tab" disabled={id !== 'sql' && !table} onClick={() => setTab(id)}>
                <Icon size={13} /><span>{label}</span>
              </button>
            ))}
            {table && tab !== 'sql' && <span className="db-main-context font-mono">{table.name}{isView ? ' (view)' : ''}</span>}
          </div>

          <div className="db-pane-body">
          {tab === 'data' && table && (
            <>
              <div className="db-data-toolbar">
                <form className="db-where" onSubmit={(e) => { e.preventDefault(); setPage(0); setWhere(whereDraft); }}>
                  <span className="font-mono">WHERE</span>
                  <input className="input font-mono" aria-label="Row filter" placeholder="e.g. qty > 0 AND name LIKE '%a%'" value={whereDraft} onChange={(e) => setWhereDraft(e.target.value)} />
                  <button type="submit" className="btn btn-secondary btn-xs" disabled={busy}>Apply</button>
                  {where && <button type="button" className="btn btn-ghost btn-xs" onClick={() => { setWhere(''); setWhereDraft(''); setPage(0); }}>Clear</button>}
                </form>
                {!isView && <button type="button" className="btn btn-primary btn-xs" disabled={busy} onClick={() => { setSelectedRow(null); setInserting(true); }}><Plus size={12} />Add row</button>}
              </div>
              {data && (
                <ResultGrid result={data} hidden={ROWID} offset={page * pageSize} sort={sort} onSort={toggleSort}
                  selected={selectedRow} onSelect={isView ? undefined : (i) => { setInserting(false); setSelectedRow(i === selectedRow ? null : i); }} />
              )}
              <div className="db-pager">
                <span className="text-dim text-xs">
                  {total === null ? '…' : total === 0 ? 'No rows' : `Rows ${(page * pageSize + 1).toLocaleString()}–${Math.min(total, (page + 1) * pageSize).toLocaleString()} of ${total.toLocaleString()}`}
                  {!isView && total ? ' · click a row to edit' : ''}
                </span>
                <select className="input" aria-label="Rows per page" value={pageSize} onChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}>
                  {[25, 50, 100, 250, 500].map((n) => <option key={n} value={n}>{n} / page</option>)}
                </select>
                <button type="button" className="btn btn-secondary btn-xs" aria-label="Previous page" disabled={busy || page === 0} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={12} /></button>
                <span className="db-pager-page">{page + 1} / {pages}</span>
                <button type="button" className="btn btn-secondary btn-xs" aria-label="Next page" disabled={busy || page + 1 >= pages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={12} /></button>
              </div>
            </>
          )}

          {tab === 'structure' && table && (
            <>
              <div className="db-grid-wrap">
                <table className="db-grid">
                  <thead><tr><th className="db-rownum">#</th><th>Column</th><th>Type</th><th>Not null</th><th>Primary key</th></tr></thead>
                  <tbody>
                    {table.columns.map((c, i) => (
                      <tr key={c.name}>
                        <td className="db-rownum">{i + 1}</td>
                        <td className="font-mono">{c.name}</td>
                        <td className="font-mono">{c.type || 'ANY'}</td>
                        <td>{c.notNull ? 'yes' : ''}</td>
                        <td>{c.pk > 0 ? <span className="db-pk"><KeyRound size={11} />{pkCols.length > 1 ? `#${c.pk}` : 'yes'}</span> : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {ddl?.rows.map(([type, name, text]) => (
                <div key={String(name)} className="db-ddl">
                  <div className="db-ddl-head"><span className="badge badge-neutral">{String(type)}</span><span className="font-mono">{String(name)}</span></div>
                  <pre className="inspection-output">{String(text)}</pre>
                </div>
              ))}
            </>
          )}

          {tab === 'sql' && (
            <div className="db-sql">
              <textarea
                className="input font-mono db-sql-editor"
                rows={6}
                aria-label="SQL statement"
                placeholder="SELECT * FROM ... (read-only via Query; edits via Execute change the host copy only)"
                value={sql}
                onChange={(e) => setSql(e.target.value)}
                onKeyDown={(e) => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); void runSql('query'); } }}
              />
              <div className="db-sql-actions">
                <button type="button" className="btn btn-primary btn-xs" disabled={busy || !sql.trim()} onClick={() => runSql('query')}><Play size={12} />Query (read-only)</button>
                <button type="button" className="btn btn-secondary btn-xs" disabled={busy || !sql.trim()} onClick={() => runSql('execute')}>Execute (host copy)</button>
                {table && <button type="button" className="btn btn-ghost btn-xs" onClick={() => setSql(`SELECT * FROM ${quoteIdent(table.name)} LIMIT 100;`)}>Template for {table.name}</button>}
                <span className="text-dim text-xs">Ctrl+Enter runs the query</span>
              </div>
              {history.length > 0 && (
                <details className="db-history">
                  <summary><History size={12} />History ({history.length})</summary>
                  <ul>{history.map((h) => <li key={h}><button type="button" className="font-mono" onClick={() => setSql(h)} title={h}>{h}</button></li>)}</ul>
                </details>
              )}
              {sqlResult && (sqlResult.rowsAffected != null
                ? <div className="inspect-note inspect-note-success">Rows affected: {sqlResult.rowsAffected}</div>
                : <>
                    <ResultGrid result={sqlResult} />
                    <div className="text-dim text-xs">{sqlResult.rows.length.toLocaleString()} row{sqlResult.rows.length === 1 ? '' : 's'}</div>
                  </>)}
              {sqlResult?.truncated && <div className="inspect-note inspect-note-warning">Results truncated.</div>}
            </div>
          )}
          </div>
        </div>

        {editorOpen && table && (
          <RowEditor table={table} row={inserting ? null : editingRow} busy={busy}
            subtitle={inserting ? table.name : `${table.name} · row ${page * pageSize + (selectedRow ?? 0) + 1}`}
            onSave={saveRow} onDelete={inserting ? undefined : deleteRow}
            onClose={() => { setInserting(false); setSelectedRow(null); }} />
        )}
      </div>
    </section>
  );
};
