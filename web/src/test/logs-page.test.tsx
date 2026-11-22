import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LogsPage } from '../pages/LogsPage.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import type { Operation } from '../types/api.js';

afterEach(() => { vi.restoreAllMocks(); sessionStorage.clear(); });

describe('LogsPage KPI cards', () => {
  it('apply the stream filters they count', () => {
    // jsdom has no scrolling; the embedded logcat view scrolls on render.
    Element.prototype.scrollTo = vi.fn() as never;
    const runOperation = vi.fn().mockResolvedValue({ id: 'job-1' });
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      selectedDeviceId: 'dev-1',
      jobs: [],
      findOperation: (id: string) => ({ id, label: id } as Operation),
      openOperationModal: vi.fn(),
      runOperation,
      cancelJob: vi.fn(),
    } as any);
    vi.spyOn(api, 'getStats').mockResolvedValue({ deviceId: 'dev-1', scope: 'logs', collectedAt: 1, sections: {} } as any);
    render(<LogsPage />);

    fireEvent.click(screen.getByTestId('kpi-card-log-priority-split'));
    expect(screen.getByDisplayValue('Error (E+)')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('kpi-card-log-crash-events'));
    expect(screen.getByDisplayValue('all (All buffers)')).toBeInTheDocument();
    expect(screen.getByDisplayValue('FATAL EXCEPTION|ANR in')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /dump buffer/i }));
    expect(runOperation).toHaveBeenCalledWith('logcat.dump', expect.objectContaining({ buffer: 'all', filter: '*:E', regex: 'FATAL EXCEPTION|ANR in', dumpOnly: true }));
  });

  it('shows one stream toggle that becomes Stop while the capture job runs', async () => {
    Element.prototype.scrollTo = vi.fn() as never;
    const cancelJob = vi.fn().mockResolvedValue(undefined);
    const runOperation = vi.fn().mockResolvedValue({ id: 'job-1' });
    const state: Record<string, unknown> = {
      selectedDeviceId: 'dev-1',
      jobs: [],
      findOperation: (id: string) => ({ id, label: id } as Operation),
      openOperationModal: vi.fn(),
      runOperation,
      cancelJob,
    };
    vi.spyOn(WorkstationContext, 'useWorkstation').mockImplementation(() => state as any);
    vi.spyOn(api, 'getStats').mockResolvedValue({ deviceId: 'dev-1', scope: 'logs', collectedAt: 1, sections: {} } as any);
    const { rerender } = render(<LogsPage />);
    expect(screen.queryByRole('button', { name: /^stop/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /stream live logs/i }));
    await waitFor(() => expect(runOperation).toHaveBeenCalled());

    state.jobs = [{ id: 'job-1', status: 'running', operationId: 'logcat.dump', stdout: '', stderr: '', artifactIds: [], createdAt: '' }];
    rerender(<LogsPage />);
    expect(screen.queryByRole('button', { name: /stream live logs/i })).toBeNull();
    state.jobs = [{ id: 'job-1', status: 'running', operationId: 'logcat.dump', stdout: 'I/Tag: kept line', stderr: '', artifactIds: [], createdAt: '' }];
    rerender(<LogsPage />);
    fireEvent.click(screen.getByRole('button', { name: /stop streaming/i }));
    expect(cancelJob).toHaveBeenCalledWith('job-1');
    state.jobs = [{ id: 'job-1', status: 'cancelled', operationId: 'logcat.dump', stdout: 'I/Tag: kept line', stderr: '', artifactIds: [], createdAt: '' }];
    rerender(<LogsPage />);
    expect(screen.getByRole('button', { name: /stream live logs/i })).toBeInTheDocument();
    expect(screen.getAllByText(/kept line/).length).toBeGreaterThan(0);
  });
});
