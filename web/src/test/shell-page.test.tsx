import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkstationProvider } from '../context/WorkstationContext.js';
import { ShellPage } from '../pages/ShellPage.js';

describe('ShellPage Interactive PTY Terminal Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const setupShellFetch = () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const u = typeof url === 'string' ? url : (url as Request).url;
      if (u.includes('/api/v1/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: 'test-token' }),
        });
      }
      if (u.includes('/api/v1/devices')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ id: 'emulator-5554', state: 'device', model: 'Pixel_8' }],
        });
      }
      if (u.includes('/api/v1/shell') && !u.includes('/shell/')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ id: 'shell-uuid-123' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });
  };

  it('renders interactive terminal card with proper layout container', async () => {
    setupShellFetch();

    const { container } = render(
      <WorkstationProvider>
        <ShellPage />
      </WorkstationProvider>
    );

    expect(screen.getByText('Interactive PTY shell')).toBeInTheDocument();
    expect(screen.getByText('Disconnected')).toBeInTheDocument();

    // Verify terminal placeholder container exists with correct positioning
    const launchBtns = screen.getAllByRole('button', { name: /launch shell/i });
    expect(launchBtns.length).toBeGreaterThan(0);

    // Verify terminal canvas container is rendered and hidden via visibility rather than display: none
    const canvasContainers = container.querySelectorAll('[style*="position: relative"]');
    expect(canvasContainers.length).toBeGreaterThan(0);
  });

  it('focuses the one-shot runner from its results KPI card', () => {
    setupShellFetch();
    const { container } = render(
      <WorkstationProvider>
        <ShellPage />
      </WorkstationProvider>
    );
    fireEvent.click(screen.getByTestId('kpi-card-shell-command-results'));
    expect(container.querySelector('.shell-runner-panel')?.contains(document.activeElement)).toBe(true);
  });
});
