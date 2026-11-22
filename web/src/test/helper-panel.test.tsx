import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HelperPanel } from '../components/HelperPanel.js';
import { api } from '../api/client.js';

const baseStatus = {
  deviceId: 'dev1',
  package: 'io.andrui.terminal.helper',
  hostApk: { available: true, path: '/apk/andrui-helper.apk', sha256: 'a'.repeat(64) },
  installed: true,
  versionName: '0.2.0',
  versionCode: 2,
  upToDate: false,
  session: null,
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('HelperPanel', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body?: string }[];

  beforeEach(() => {
    api.clearCsrfToken();
    calls = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string, method: string) => Promise<Response>) {
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.includes('/session')) return jsonResponse({ csrfToken: 'csrf' });
      return handler(url, method);
    }) as typeof fetch;
  }

  it('loads status and offers an update when the installed APK differs', async () => {
    mockFetch(() => jsonResponse(baseStatus));
    render(<HelperPanel deviceId="dev1" deviceReady />);
    expect(await screen.findByText('Update available')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Update helper' })).toBeTruthy();
    expect(screen.getByText('0.2.0 (code 2)')).toBeTruthy();
    expect(calls[0].url).toContain('/api/v1/automation/helper/status?deviceId=dev1');
  });

  it('installs only after confirmation and sends confirmed=true', async () => {
    mockFetch((url, method) =>
      method === 'POST' ? jsonResponse({ ...baseStatus, upToDate: true }) : jsonResponse(baseStatus)
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<HelperPanel deviceId="dev1" deviceReady />);
    const button = await screen.findByRole('button', { name: 'Update helper' });

    fireEvent.click(button);
    expect(calls.some(c => c.method === 'POST')).toBe(false);

    fireEvent.click(button);
    await screen.findByText('Installed');
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/helper/install'));
    expect(post && JSON.parse(post.body!)).toEqual({ deviceId: 'dev1', confirmed: true });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('uninstalls helper only after confirmation and sends confirmed=true', async () => {
    mockFetch((url, method) =>
      method === 'POST' ? jsonResponse({ ...baseStatus, installed: false, upToDate: false }) : jsonResponse(baseStatus)
    );
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<HelperPanel deviceId="dev1" deviceReady />);
    const button = await screen.findByRole('button', { name: 'Uninstall helper' });
    expect(button.classList.contains('btn-uninstall-helper')).toBe(true);

    fireEvent.click(button);
    expect(calls.some(c => c.method === 'POST')).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(screen.getAllByText('Not installed').length).toBeGreaterThan(0));
    expect(await screen.findByRole('button', { name: 'Install helper' })).toBeTruthy();
    const post = calls.find(c => c.method === 'POST' && c.url.includes('/helper/uninstall'));
    expect(post && JSON.parse(post.body!)).toEqual({ deviceId: 'dev1', confirmed: true });
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('shows check results with guidance for a frozen helper', async () => {
    mockFetch(url =>
      url.includes('/helper/checks')
        ? jsonResponse({
            deviceId: 'dev1',
            overall: 'fail',
            status: { ...baseStatus, upToDate: true },
            checks: [
              { id: 'installed', label: 'Helper installed on device', status: 'pass', detail: 'Version 0.2.0 (code 2)' },
              { id: 'power_save', label: 'Power saving does not restrict the helper', status: 'warn', detail: 'Battery optimization: on', guidance: 'Battery → Unrestricted' },
              { id: 'not_frozen', label: 'Helper process is not frozen', status: 'fail', detail: '15 of 19 helper threads are frozen', guidance: 'App launch → Manage manually' },
              { id: 'health', label: 'Helper responds', status: 'skip', detail: 'Skipped: helper process is frozen or not running' },
            ],
          })
        : jsonResponse(baseStatus)
    );
    render(<HelperPanel deviceId="dev1" deviceReady />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run checks' }));

    const list = await screen.findByRole('list', { name: 'Helper checks' });
    expect(list.querySelectorAll('li')).toHaveLength(4);
    expect(list.querySelector('[data-status="fail"]')?.textContent).toContain('15 of 19 helper threads are frozen');
    expect(screen.getByText('App launch → Manage manually')).toBeTruthy();
    expect(screen.getByText('fail')).toBeTruthy();
    expect(screen.getByText('1 passed, 1 failed, 1 warning, 1 not run')).toBeTruthy();
  });

  it('explains why install is unavailable without a host APK', async () => {
    mockFetch(() =>
      jsonResponse({ ...baseStatus, upToDate: null, hostApk: { available: false, reason: 'Helper APK path is not configured.' } })
    );
    render(<HelperPanel deviceId="dev1" deviceReady />);
    const button = await screen.findByRole('button', { name: 'Install helper' });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute('aria-describedby')).toBe('helper-install-blocked');
    expect(document.getElementById('helper-install-blocked')?.textContent).toContain('Install is unavailable. Helper APK path is not configured.');
    expect(screen.getByText('Unknown (no host APK)')).toBeTruthy();
  });

  it('summarizes results and lists multi-step guidance', async () => {
    mockFetch(url =>
      url.includes('/helper/checks')
        ? jsonResponse({
            deviceId: 'dev1',
            overall: 'warn',
            status: { ...baseStatus, upToDate: true },
            checks: [
              { id: 'installed', label: 'Helper installed on device', status: 'pass', detail: 'ok' },
              { id: 'power_save', label: 'Power saving does not restrict the helper', status: 'warn', detail: 'Battery optimization: on', guidance: 'Battery → Unrestricted\nHonor: App launch' },
              { id: 'session', label: 'Helper session running', status: 'warn', detail: 'No active helper session' },
            ],
          })
        : jsonResponse(baseStatus)
    );
    render(<HelperPanel deviceId="dev1" deviceReady />);
    expect(await screen.findByText(/Start it on the Layout page/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Run checks' }));
    expect(await screen.findByText('1 passed, 2 warnings')).toBeTruthy();
    expect(screen.getByText('Battery → Unrestricted').tagName).toBe('LI');
    expect(screen.getByText('Honor: App launch').tagName).toBe('LI');
    // Session hint is not repeated once check results are shown.
    expect(screen.queryByText(/Start it on the Layout page/)).toBeNull();
  });

  it('shows incomplete, not pass or warn, when live checks did not run', async () => {
    mockFetch(url =>
      url.includes('/helper/checks')
        ? jsonResponse({
            deviceId: 'dev1',
            overall: 'incomplete',
            status: { ...baseStatus, upToDate: true },
            checks: [
              { id: 'installed', label: 'Helper installed on device', status: 'pass', detail: 'ok' },
              { id: 'power_save', label: 'Power saving does not restrict the helper', status: 'pass', detail: 'Battery optimization: on; standby bucket: active.' },
              { id: 'session', label: 'Helper session running', status: 'skip', detail: 'No helper session is running', guidance: 'Start the automation helper (Layout page), then run checks again.' },
              { id: 'health', label: 'Helper responds', status: 'skip', detail: 'Not run: no helper session' },
            ],
          })
        : jsonResponse(baseStatus)
    );
    render(<HelperPanel deviceId="dev1" deviceReady />);
    fireEvent.click(await screen.findByRole('button', { name: 'Run checks' }));
    expect(await screen.findByText('2 passed, 2 not run')).toBeTruthy();
    const badge = screen.getByText('incomplete');
    expect(badge.className).toContain('badge-secondary');
    expect(screen.queryAllByLabelText('warning')).toHaveLength(0);
    expect(screen.getAllByLabelText('not run')).toHaveLength(2);
    expect(screen.getByText('Next step')).toBeTruthy();
    expect(screen.queryByText('How to fix')).toBeNull();
  });

  it('does not call the API without a ready device', () => {
    mockFetch(() => jsonResponse(baseStatus));
    render(<HelperPanel deviceId="dev1" deviceReady={false} />);
    expect(screen.getByText('Select a ready device to manage its automation helper.')).toBeTruthy();
    expect(calls).toHaveLength(0);
  });

  it('shows API errors', async () => {
    mockFetch(() => jsonResponse({ error: { code: 'adb_command_failed', message: 'device offline' } }, 400));
    render(<HelperPanel deviceId="dev1" deviceReady />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('device offline'));
  });
});
