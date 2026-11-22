import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { JobDrawer } from '../components/JobDrawer.js';
import { WorkstationProvider, useWorkstation } from '../context/WorkstationContext.js';
import { api } from '../api/client.js';

describe('JobDrawer pagination & total count', () => {
  const originalFetch = globalThis.fetch;
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    localStorage.removeItem('andrui_job_drawer_height');
    api.clearCsrfToken();
    vi.restoreAllMocks();
    // Stub EventSource
    globalThis.EventSource = vi.fn().mockImplementation(() => ({
      close: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      onmessage: null,
      onerror: null,
    })) as unknown as typeof EventSource;
  });

  it('resizes and expands an empty panel and remembers its resized height', async () => {
    globalThis.fetch = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      const data = url.includes('/session') ? { csrfToken: 'tok' }
        : url.includes('/capabilities') ? { capabilities: [] }
        : url.includes('/health') ? { status: 'ok', mode: 'native' } : [];
      return Promise.resolve(new Response(JSON.stringify(data)));
    });
    const TestHost = () => {
      const { setIsJobDrawerOpen } = useWorkstation();
      React.useEffect(() => { setIsJobDrawerOpen(true); }, [setIsJobDrawerOpen]);
      return <JobDrawer />;
    };
    const tree = <WorkstationProvider><TestHost /></WorkstationProvider>;
    const view = render(tree);
    const handle = await screen.findByRole('separator', { name: 'Resize jobs panel' });
    const panel = handle.closest('.job-drawer-container')!;
    expect(panel).toHaveStyle({ height: '170px' });
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(panel).toHaveStyle({ height: '210px' });
    expect(localStorage.getItem('andrui_job_drawer_height')).toBe('210');
    expect(document.documentElement.style.getPropertyValue('--job-drawer-height')).toBe('210px');
    fireEvent.click(screen.getByTitle('Expand'));
    expect(panel).toHaveStyle({ height: '100%' });
    fireEvent.click(screen.getByTitle('Collapse'));
    expect(panel).toHaveStyle({ height: '210px' });
    view.unmount();
    render(tree);
    const restored = await screen.findByRole('separator', { name: 'Resize jobs panel' });
    expect(restored.closest('.job-drawer-container')).toHaveStyle({ height: '210px' });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.EventSource = originalEventSource;
  });

  it('displays true total jobs count and paginates on demand', async () => {
    const batch1 = Array.from({ length: 50 }, (_, i) => ({
      id: `job-${i + 1}`,
      operationId: 'diagnostics.dumpsys',
      status: 'completed' as const,
      createdAt: '2026-11-11T00:00:00Z',
      stdout: `Output of job ${i + 1}`,
      stderr: '',
    }));

    const batch2 = Array.from({ length: 25 }, (_, i) => ({
      id: `job-${i + 51}`,
      operationId: 'diagnostics.dumpsys',
      status: 'completed' as const,
      createdAt: '2026-11-11T00:00:00Z',
      stdout: `Output of job ${i + 51}`,
      stderr: '',
    }));

    const requestedUrls: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = String(url);
      requestedUrls.push(u);

      if (u.includes('/session')) {
        return Promise.resolve(new Response(JSON.stringify({ csrfToken: 'tok' })));
      }
      if (u.includes('/devices')) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (u.includes('/operations')) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (u.includes('/capabilities')) {
        return Promise.resolve(new Response(JSON.stringify({ capabilities: [] })));
      }
      if (u.includes('/health')) {
        return Promise.resolve(new Response(JSON.stringify({ status: 'ok' })));
      }
      if (u.includes('/approvals')) {
        return Promise.resolve(new Response(JSON.stringify([])));
      }
      if (u.includes('/jobs?limit=50&offset=50')) {
        return Promise.resolve(
          new Response(JSON.stringify(batch2), {
            headers: { 'X-Total-Count': '75', 'Content-Type': 'application/json' },
          })
        );
      }
      if (u.includes('/jobs')) {
        return Promise.resolve(
          new Response(JSON.stringify(batch1), {
            headers: { 'X-Total-Count': '75', 'Content-Type': 'application/json' },
          })
        );
      }
      return Promise.resolve(new Response(JSON.stringify({})));
    });

    const TestHost: React.FC = () => {
      const { setIsJobDrawerOpen } = useWorkstation();
      React.useEffect(() => {
        setIsJobDrawerOpen(true);
      }, [setIsJobDrawerOpen]);
      return <JobDrawer />;
    };

    render(
      <WorkstationProvider>
        <TestHost />
      </WorkstationProvider>
    );

    // Initial load: 50 jobs loaded, but total count is 75
    // Wait for the total count 75 to appear in "All" filter count and toolbar
    await waitFor(() => {
      const allCounts = screen.getAllByText('75');
      expect(allCounts.length).toBeGreaterThan(0);
    });

    // Check load more button is displayed with remaining count
    const loadMoreBtn = await screen.findByRole('button', {
      name: /load older jobs \(25 remaining\)/i,
    });
    expect(loadMoreBtn).toBeInTheDocument();

    // Click load more
    fireEvent.click(loadMoreBtn);

    // Verify offset=50 fetch was made
    await waitFor(() => {
      expect(requestedUrls.some((u) => u.includes('offset=50'))).toBe(true);
    });

    // After batch2 is appended, all 75 jobs are loaded, so the load more button disappears
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /load older jobs/i })).toBeNull();
    });
  });
});
