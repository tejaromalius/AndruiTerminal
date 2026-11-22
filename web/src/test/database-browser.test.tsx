import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseBrowser, quoteIdent, sqlLiteral } from '../components/DatabaseBrowser.js';
import { api } from '../api/client.js';
import type { DbQueryResult, DbSnapshot } from '../types/api.js';

const snapshot: DbSnapshot = {
  id: 'snap-1', deviceId: 'dev-1', package: 'com.ex', databaseName: 'products.db', mode: 'run-as',
  sha256: 'x', sizeBytes: 4096, hadWal: false, createdAt: '2026-11-22T12:00:00Z',
};
const rows = (columns: string[], data: unknown[][]): DbQueryResult => ({ columns, rows: data, rowsAffected: null, truncated: false });

describe('DatabaseBrowser', () => {
  let query: ReturnType<typeof vi.spyOn>;
  let execute: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(api, 'dbSchema').mockResolvedValue({
      tables: [
        { name: 'products', type: 'table', columns: [
          { name: 'id', type: 'INTEGER', notNull: true, pk: 1 },
          { name: 'name', type: 'TEXT', notNull: false, pk: 0 },
        ] },
        { name: 'scan_log', type: 'table', columns: [{ name: 'code', type: 'TEXT', notNull: false, pk: 0 }] },
      ],
    });
    query = vi.spyOn(api, 'dbQuery').mockImplementation(async (_id: string, sql: string) => {
      if (sql.includes('UNION ALL')) return rows(['t', 'n'], [['products', 2], ['scan_log', 1]]);
      if (sql.startsWith('SELECT COUNT(*) FROM "products"')) return rows(['n'], [[2]]);
      if (sql.startsWith('SELECT COUNT(*) FROM "scan_log"')) return rows(['n'], [[1]]);
      if (sql.includes('FROM "products"')) return rows(['id', 'name'], [[1, "Bob's"], [2, null]]);
      if (sql.includes('FROM "scan_log"')) return rows(['__andrui_rowid__', 'code'], [[7, 'A1']]);
      return rows([], []);
    });
    execute = vi.spyOn(api, 'dbExecute').mockResolvedValue({ columns: [], rows: [], rowsAffected: 1, truncated: false });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('lists tables with row counts and pages the first table', async () => {
    render(<DatabaseBrowser snapshot={snapshot} onPush={vi.fn()} pushing={false} />);
    const tree = screen.getByRole('complementary', { name: 'Database objects' });
    await waitFor(() => expect(within(tree).getByText('products')).toBeInTheDocument());
    expect(within(tree).getByText('1')).toBeInTheDocument();
    expect(await screen.findByText("Bob's")).toBeInTheDocument();
    expect(screen.getByText('NULL')).toBeInTheDocument();
    expect(screen.getByText(/Rows 1–2 of 2/)).toBeInTheDocument();
    expect(query).toHaveBeenCalledWith('snap-1', 'SELECT * FROM "products" LIMIT 50 OFFSET 0', 50);
  });

  it('updates only the changed column of a row addressed by primary key', async () => {
    render(<DatabaseBrowser snapshot={snapshot} onPush={vi.fn()} pushing={false} />);
    fireEvent.click(await screen.findByText("Bob's"));
    fireEvent.change(screen.getByLabelText('name'), { target: { value: "Bob's shop" } });
    fireEvent.click(screen.getByRole('button', { name: /Save row/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('snap-1', `UPDATE "products" SET "name" = 'Bob''s shop' WHERE "id" = 1`));
    expect(await screen.findByText('modified · not on device')).toBeInTheDocument();
  });

  it('deletes a row of a table without a primary key by rowid', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<DatabaseBrowser snapshot={snapshot} onPush={vi.fn()} pushing={false} />);
    await screen.findByText("Bob's");
    fireEvent.click(within(screen.getByRole('complementary', { name: 'Database objects' })).getByText('scan_log'));
    fireEvent.click(await screen.findByText('A1'));
    expect(screen.queryByText('__andrui_rowid__')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Delete row/ }));
    await waitFor(() => expect(execute).toHaveBeenCalledWith('snap-1', 'DELETE FROM "scan_log" WHERE rowid = 7'));
  });

  it('escapes identifiers and literals', () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
    expect(sqlLiteral("it's")).toBe("'it''s'");
    expect(sqlLiteral(null)).toBe('NULL');
    expect(sqlLiteral(4.5)).toBe('4.5');
  });

  it('toggles NULL, saves with Ctrl+Enter and closes with Escape from the side editor', async () => {
    render(<DatabaseBrowser snapshot={snapshot} onPush={vi.fn()} pushing={false} />);
    fireEvent.click(await screen.findByText("Bob's"));
    const editor = screen.getByRole('complementary', { name: 'Edit row' });
    expect(within(editor).getByText('products · row 1')).toBeInTheDocument();
    fireEvent.click(within(editor).getByRole('button', { name: 'Set name to NULL' }));
    expect(within(editor).getByText('1 field changed')).toBeInTheDocument();
    fireEvent.keyDown(within(editor).getByLabelText('name'), { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(execute).toHaveBeenCalledWith('snap-1', 'UPDATE "products" SET "name" = NULL WHERE "id" = 1'));
    await screen.findByText('modified · not on device');
    await waitFor(() => expect(screen.queryByRole('complementary', { name: 'Edit row' })).toBeNull());
    fireEvent.click(await screen.findByText("Bob's"));
    fireEvent.keyDown(screen.getByRole('complementary', { name: 'Edit row' }), { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Edit row' })).toBeNull();
  });
});
