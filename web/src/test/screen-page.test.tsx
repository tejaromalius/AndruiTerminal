import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkstationProvider } from '../context/WorkstationContext.js';
import { ScreenPage } from '../pages/ScreenPage.js';

describe('ScreenPage Device Display Viewer with Zoom / Fullscreen Control', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const setupScreenFetch = () => {
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
      if (u.includes('/api/v1/media/capabilities')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            scrcpyServerAvailable: true,
            scrcpyServerVersion: '3.3.1',
            supportedCodecs: ['h264', 'h265'],
            webCodecsSupported: true,
            audioSupported: true,
            maxSupportedFps: 60,
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });
  };

  it('renders Zoom button on Device Display Viewer panel', async () => {
    setupScreenFetch();

    render(
      <WorkstationProvider>
        <ScreenPage />
      </WorkstationProvider>
    );

    // Verify Device Display Viewer header
    expect(await screen.findByText('Device Display Viewer')).toBeInTheDocument();

    // Verify Zoom button is present
    const zoomButton = screen.getByRole('button', { name: /zoom to full screen/i });
    expect(zoomButton).toBeInTheDocument();
    expect(zoomButton).toHaveTextContent('Zoom');
  });

  it('toggles full screen mode when Zoom button is clicked and exits via Exit button or Escape key', async () => {
    setupScreenFetch();

    // Mock HTML5 requestFullscreen and exitFullscreen
    const requestFullscreenMock = vi.fn().mockResolvedValue(undefined);
    Element.prototype.requestFullscreen = requestFullscreenMock;

    render(
      <WorkstationProvider>
        <ScreenPage />
      </WorkstationProvider>
    );

    const viewerTitle = await screen.findByText('Device Display Viewer');
    const panel = viewerTitle.closest('.workspace-panel');
    expect(panel).not.toHaveClass('device-viewer-fullscreen');

    const zoomButton = screen.getByRole('button', { name: /zoom to full screen/i });
    fireEvent.click(zoomButton);

    // Panel enters fullscreen mode
    await waitFor(() => {
      expect(panel).toHaveClass('device-viewer-fullscreen');
    });

    // Zoom button changes to Exit Full Screen
    const exitButton = screen.getByRole('button', { name: /exit full screen/i });
    expect(exitButton).toBeInTheDocument();
    expect(exitButton).toHaveTextContent('Exit Full Screen');

    // In full screen mode, hardware navigation controls are visible inside the viewer for higher quality control
    expect(within(panel as HTMLElement).getByRole('button', { name: /back/i })).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByRole('button', { name: /home/i })).toBeInTheDocument();
    expect(within(panel as HTMLElement).getByRole('button', { name: /overview/i })).toBeInTheDocument();

    // Pressing Escape exits fullscreen mode
    fireEvent.keyDown(window, { key: 'Escape' });

    await waitFor(() => {
      expect(panel).not.toHaveClass('device-viewer-fullscreen');
    });
    expect(screen.getByRole('button', { name: /zoom to full screen/i })).toBeInTheDocument();
  });
});
