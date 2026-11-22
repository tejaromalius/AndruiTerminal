// @vitest-environment-options {"url": "http://127.0.0.1:19801/?view=host"}
import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { HostMonitorModal } from '../components/HostMonitorModal.js';
import { api } from '../api/client.js';

vi.mock('../api/client.js', () => ({
  api: { getHostTelemetry: vi.fn() },
}));

class AnsweringImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(_url: string) {
    setTimeout(() => this.onload?.(), 0);
  }
}

describe('HostMonitorModal standalone offline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps the page and offers another live port instead of navigating', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Image', AnsweringImage);
    vi.mocked(api.getHostTelemetry).mockRejectedValue(new TypeError('Failed to fetch'));
    const startHref = window.location.href;

    render(<HostMonitorModal open={true} standalone={true} onClose={() => {}} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(window.location.href).toBe(startHref);
    expect(screen.getByText(/Host service found on port 19811/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Switch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
