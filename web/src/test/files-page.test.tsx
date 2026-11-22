import React from 'react';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FilesPage } from '../pages/FilesPage.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import type { Operation } from '../types/api.js';

const listing = (path: string) => ({
  path,
  entries: path === '/sdcard'
    ? [
      { name: 'Download', path: '/sdcard/Download', directory: true, mode: 'drwxrwx--x' },
      { name: 'notes.txt', path: '/sdcard/notes.txt', directory: false, size: 2048, mode: '-rw-rw----', modified: '2026-11-01 10:00' },
    ]
    : [{ name: 'a.apk', path: `${path}/a.apk`, directory: false, size: 10 }],
});

function setup() {
  const openOperationModal = vi.fn();
  vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
    selectedDeviceId: 'dev-1',
    findOperation: (id: string) => ({ id, label: id } as Operation),
    openOperationModal,
    runOperation: vi.fn(),
    jobs: [],
  } as any);
  vi.spyOn(api, 'getStats').mockResolvedValue({ deviceId: 'dev-1', scope: 'files', collectedAt: 1, sections: {} } as any);
  const getFiles = vi.spyOn(api, 'getFiles').mockImplementation(async (_d, path) => listing(path));
  return { openOperationModal, getFiles };
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe('FilesPage workbench', () => {
  it('keeps the path toolbar and jump chips, and lists folder entries', async () => {
    setup();
    render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    await waitFor(() => expect(within(list).getByText('notes.txt')).toBeInTheDocument());
    for (const label of ['Go Up', 'Reload directory', 'App Private Data via run-as']) expect(screen.getByTitle(label)).toBeInTheDocument();
    expect(screen.getByText('Upload to Here')).toBeInTheDocument();
    expect(screen.getByText('New Folder')).toBeInTheDocument();
    for (const path of ['/sdcard', '/data/local/tmp', '/sdcard/Download', '/system', '/data']) expect(screen.getByRole('button', { name: path })).toBeInTheDocument();
    expect(within(list).getByText('2.0 KB · -rw-rw---- · 2026-11-01 10:00')).toBeInTheDocument();
  });

  it('shows a detail pane with the entry actions and opens folders', async () => {
    const { openOperationModal, getFiles } = setup();
    render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    fireEvent.click(await within(list).findByText('notes.txt'));
    expect(screen.getByRole('heading', { name: 'notes.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /pull \/ download/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'file.rm' }), { path: '/sdcard/notes.txt', recursive: false });

    fireEvent.click(within(list).getByText('Download'));
    fireEvent.click(screen.getByRole('button', { name: /open folder/i }));
    await waitFor(() => expect(getFiles).toHaveBeenLastCalledWith('dev-1', '/sdcard/Download'));
  });

  it('filters by entry type from the KPI card', async () => {
    setup();
    render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    await within(list).findByText('Download');
    fireEvent.click(screen.getByTestId('kpi-card-files-folder-size'));
    expect(within(list).queryByText('Download')).not.toBeInTheDocument();
    expect(within(list).getByText('notes.txt')).toBeInTheDocument();
  });

  it('pins the current folder and lists recently opened folders', async () => {
    setup();
    render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    await within(list).findByText('Download');
    fireEvent.click(screen.getByRole('button', { name: 'Pin /sdcard' }));
    expect(within(list).getByText('Pinned')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '/system' }));
    await within(list).findByText('a.apk');
    expect(within(list).getAllByText('/sdcard').length).toBeGreaterThan(0);
    expect(JSON.parse(localStorage.getItem('andrui_files_dev-1')!).pinned).toEqual(['/sdcard']);
  });

  it('navigates with breadcrumbs and accepts a typed path', async () => {
    const { getFiles } = setup();
    render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    await within(list).findByText('Download');
    fireEvent.click(screen.getByRole('button', { name: 'Go to /' }));
    await waitFor(() => expect(getFiles).toHaveBeenLastCalledWith('dev-1', '/'));
    fireEvent.click(screen.getByRole('button', { name: 'Edit path' }));
    const input = screen.getByLabelText('Directory path');
    fireEvent.change(input, { target: { value: '/data/local/tmp' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(getFiles).toHaveBeenLastCalledWith('dev-1', '/data/local/tmp'));
    expect(screen.queryByLabelText('Directory path')).toBeNull();
  });

  it('fills the detail pane with the selected folder contents and opens a child from it', async () => {
    const { getFiles } = setup();
    render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    fireEvent.click(await within(list).findByText('Download'));
    const contents = await screen.findByRole('region', { name: 'Folder contents' });
    fireEvent.click(await within(contents).findByText('a.apk'));
    await waitFor(() => expect(getFiles).toHaveBeenLastCalledWith('dev-1', '/sdcard/Download'));
    expect(await screen.findByRole('heading', { name: 'a.apk' })).toBeInTheDocument();
  });
});
