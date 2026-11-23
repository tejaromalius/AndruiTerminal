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
  const runOperation = vi.fn().mockResolvedValue({ id: 'push-job' });
  vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
    selectedDeviceId: 'dev-1',
    findOperation: (id: string) => ({ id, label: id, destructive: id === 'file.push' } as Operation),
    openOperationModal,
    runOperation,
    jobs: [],
  } as any);
  vi.spyOn(api, 'getStats').mockResolvedValue({ deviceId: 'dev-1', scope: 'files', collectedAt: 1, sections: {} } as any);
  const getFiles = vi.spyOn(api, 'getFiles').mockImplementation(async (_d, path) => listing(path));
  return { openOperationModal, getFiles, runOperation };
}

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); sessionStorage.clear(); });

describe('FilesPage workbench', () => {

  it.each(['picker', 'drop'])('confirms and pushes an upload from the %s to the current directory', async (source) => {
    const { runOperation, getFiles } = setup();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const upload = vi.spyOn(api, 'uploadArtifact').mockResolvedValue({ id: 'upload-id' } as any);
    const completed = vi.spyOn(api, 'waitForSuccessfulJob').mockResolvedValue({ id: 'push-job' } as any);
    const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { container } = render(<FilesPage />);
    const list = await screen.findByRole('listbox', { name: 'Folder entries' });
    await within(list).findByText('notes.txt');
    fireEvent.click(screen.getByRole('button', { name: '/sdcard/Download' }));
    await within(list).findByText('a.apk');
    const file = new File(['hello'], 'hello.txt');
    if (source === 'picker') {
      fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [file] } });
    } else {
      fireEvent.drop(container.querySelector('.app-workbench')!, { dataTransfer: { files: [file] } });
    }
    await waitFor(() => expect(completed).toHaveBeenCalledWith('push-job'));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('/sdcard/Download/hello.txt on dev-1'));
    expect(upload).toHaveBeenCalledWith(file);
    expect(runOperation).toHaveBeenCalledWith('file.push', { local: 'upload-id', remote: '/sdcard/Download/hello.txt' }, true);
    await waitFor(() => expect(getFiles.mock.calls.filter(([, path]) => path === '/sdcard/Download')).toHaveLength(2));
    expect(download).not.toHaveBeenCalled();
  });

  it('does not stage or push a file when upload confirmation is cancelled', async () => {
    const { runOperation } = setup();
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const upload = vi.spyOn(api, 'uploadArtifact');
    const { container } = render(<FilesPage />);
    await screen.findByText('notes.txt');
    fireEvent.change(container.querySelector('input[type="file"]')!, { target: { files: [new File(['hello'], 'hello.txt')] } });
    expect(window.confirm).toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
    expect(runOperation).not.toHaveBeenCalled();
  });

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
