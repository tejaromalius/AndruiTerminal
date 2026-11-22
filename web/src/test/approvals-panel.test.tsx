import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ApprovalsPanel } from '../components/ApprovalsPanel.js';
import { api } from '../api/client.js';
import type { Approval } from '../types/api.js';

const pending: Approval = {
  id: 'ap1',
  operationId: 'package.uninstall',
  operationLabel: 'Uninstall Package',
  destructive: true,
  severity: 'high',
  deviceId: 'dev1',
  parameters: { package: 'com.example' },
  preview: { program: 'adb', args: [], display: 'adb -s dev1 uninstall com.example' },
  requester: 'mcp',
  status: 'pending',
  createdAt: '2026-11-11T10:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('ApprovalsPanel', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string }[];
  let list: Approval[];

  beforeEach(() => {
    api.clearCsrfToken();
    calls = [];
    list = [pending, { ...pending, id: 'done', status: 'approved', operationLabel: 'Already done' }];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method });
      if (url.includes('/session')) return jsonResponse({ csrfToken: 'csrf' });
      if (method === 'POST') {
        const status = url.endsWith('/approve') ? 'approved' : 'denied';
        list = list.map((a) => (a.id === 'ap1' ? { ...a, status } : a));
        return jsonResponse({ ...pending, status });
      }
      return jsonResponse(list);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('shows only pending requests with their command preview', async () => {
    render(<ApprovalsPanel />);
    expect(await screen.findByText('Uninstall Package')).toBeTruthy();
    expect(screen.getByText('adb -s dev1 uninstall com.example')).toBeTruthy();
    expect(screen.getByText('High')).toBeTruthy();
    expect(screen.getByText('package')).toBeTruthy();
    expect(screen.getByText('com.example')).toBeTruthy();
    expect(screen.queryByText('Already done')).toBeNull();
  });

  it('approves only after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<ApprovalsPanel />);
    const button = await screen.findByRole('button', { name: 'Approve' });

    fireEvent.click(button);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.click(button);
    await waitFor(() => expect(screen.queryByText('Uninstall Package')).toBeNull());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/approvals/ap1/approve'))).toBe(true);
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it('denies without a confirmation prompt', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<ApprovalsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() => expect(screen.queryByText('Uninstall Package')).toBeNull());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/approvals/ap1/deny'))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('approves without a confirmation prompt when confirmOnApprove is false', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    render(<ApprovalsPanel confirmOnApprove={false} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(screen.queryByText('Uninstall Package')).toBeNull());
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/v1/approvals/ap1/approve'))).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });
});
