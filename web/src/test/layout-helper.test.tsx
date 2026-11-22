import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkstationProvider, useWorkstation } from '../context/WorkstationContext.js';
import { LayoutPage } from '../pages/LayoutPage.js';
import { api } from '../api/client.js';

const SelectDevice: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { setSelectedDeviceId } = useWorkstation();
  React.useEffect(() => { setSelectedDeviceId('dev1'); }, [setSelectedDeviceId]);
  return <>{children}</>;
};

const json = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);

describe('LayoutPage automation helper button', () => {
  const originalFetch = globalThis.fetch;
  let sessions: unknown[];

  beforeEach(() => {
    api.clearCsrfToken();
    sessions = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/session') return json({ csrfToken: 'csrf' });
      if (url === '/api/v1/automation/sessions') return json(sessions);
      if (url === '/api/v1/devices') return json([{ id: 'dev1', state: 'device', model: 'Phone' }]);
      return json([]);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const renderPage = () =>
    render(
      <WorkstationProvider>
        <SelectDevice>
          <LayoutPage />
        </SelectDevice>
      </WorkstationProvider>
    );

  it('restores a running session after the page is remounted', async () => {
    sessions = [{ id: 'sess-1', deviceId: 'dev1', helperVersion: '0.3.0' }];
    const first = renderPage();
    expect(await screen.findByText('Helper running')).toBeTruthy();
    first.unmount();

    // Switching pages unmounts LayoutPage; coming back must not offer to install/start again.
    renderPage();
    expect(await screen.findByText('Helper running')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Stop helper/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Install & start automation helper/ })).toBeNull();
    expect(screen.getByRole('button', { name: /Capture Window Hierarchy/ })).toBeTruthy();
  });

  it('offers a primary install & start button when no session runs', async () => {
    renderPage();
    const button = await screen.findByRole('button', { name: /Install & start automation helper/ });
    expect(button.className).toContain('btn-primary');
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.queryByText('Helper running')).toBeNull();
    expect(screen.queryByRole('button', { name: /Capture Window Hierarchy/ })).toBeNull();
  });
});
