import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArtifactDrawer, formatBytes } from '../components/ArtifactDrawer.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';

const artifacts = [
  { id: 'a1', name: 'screenshot.png', contentType: 'image/png', createdAt: '2026-11-18T10:00:00Z', size: 2048 },
  { id: '11d4bb4d', name: 'com.bixes.bixes-java.hprof', contentType: 'application/octet-stream', createdAt: '2026-11-18T12:18:00Z', size: 38549638 },
];

describe('ArtifactDrawer', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists newest first, filters, downloads and deletes after confirmation', async () => {
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      isArtifactDrawerOpen: true, setIsArtifactDrawerOpen: vi.fn(), jobs: [],
    } as any);
    vi.spyOn(api, 'getArtifacts').mockResolvedValue(artifacts);
    const del = vi.spyOn(api, 'deleteArtifact').mockResolvedValue({ deleted: true });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);

    render(<ArtifactDrawer />);
    await waitFor(() => expect(screen.getByText('com.bixes.bixes-java.hprof')).toBeInTheDocument());
    const names = screen.getAllByRole('row').slice(1).map((r) => r.querySelector('.artifact-name')?.textContent);
    expect(names).toEqual(['com.bixes.bixes-java.hprof', 'screenshot.png']);
    expect(screen.getByText('36.8 MB')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /download/i })[0]).toHaveAttribute('href', '/api/v1/artifacts/11d4bb4d');

    fireEvent.change(screen.getByLabelText('Filter artifacts'), { target: { value: 'hprof' } });
    expect(screen.queryByText('screenshot.png')).toBeNull();

    const remove = screen.getByRole('button', { name: 'Delete com.bixes.bixes-java.hprof' });
    fireEvent.click(remove);
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(remove);
    await waitFor(() => expect(screen.queryByText('com.bixes.bixes-java.hprof')).toBeNull());
    expect(del).toHaveBeenCalledWith('11d4bb4d');
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(38549638)).toBe('36.8 MB');
  });
});
