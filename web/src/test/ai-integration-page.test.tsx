import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkstationProvider } from '../context/WorkstationContext.js';
import { AiIntegrationPage } from '../pages/AiIntegrationPage.js';
import { api } from '../api/client.js';
import type { AiStatus, Approval } from '../types/api.js';

const baseStatus: AiStatus = {
  claudeCli: { available: true, path: '/home/u/.local/bin/claude', version: '2.0.0 (Claude Code)' },
  mcp: {
    registered: false,
    args: [],
    matchesExpected: false,
    expectedCommand: '/usr/bin/andrui-terminal',
    expectedArgs: ['mcp', '--server', 'http://127.0.0.1:19801'],
    configPath: '/home/u/.claude.json',
    restartRequired: false,
  },
  skill: {
    installed: false,
    upToDate: false,
    path: '/home/u/.claude/skills/andrui-terminal/SKILL.md',
    bundledContent: '---\nname: andrui-terminal\n---\n',
  },
};

const done: Approval = {
  id: 'ap-done',
  operationId: 'device.list',
  operationLabel: 'List Devices',
  destructive: false,
  severity: 'low',
  parameters: { lines: 200, buffer: 'main' },
  preview: { program: 'adb', args: ['devices'], display: 'adb devices' },
  requester: 'mcp',
  status: 'not_required',
  jobId: 'job-1',
  createdAt: '2026-11-11T10:00:00Z',
};

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));

describe('AiIntegrationPage', () => {
  const originalFetch = globalThis.fetch;
  let calls: { url: string; method: string; body?: string }[];
  let status: AiStatus;
  let approvalsList: Approval[];

  beforeEach(() => {
    sessionStorage.clear();
    api.clearCsrfToken();
    calls = [];
    status = structuredClone(baseStatus);
    approvalsList = [done];
    globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method || 'GET').toUpperCase();
      calls.push({ url, method, body: init?.body as string | undefined });
      if (url.endsWith('/ai/provider')) return jsonResponse({endpoint:'http://127.0.0.1:11434/v1',model:'',apiKeyEnv:''});
      if (url.endsWith('/ai/policy')) return jsonResponse({paused:false,readOnly:false,deviceIds:[],packages:[],operationPrefixes:[]});
      if (url.endsWith('/ai/reports')) return jsonResponse([]);
      if (url.includes('/session')) return jsonResponse({ csrfToken: 'csrf' });
      if (url.endsWith('/ai/mcp/install')) {
        status.mcp = { ...status.mcp, registered: true, matchesExpected: true, scope: 'user' };
        return jsonResponse(status);
      }
      if (url.endsWith('/ai/mcp/remove')) {
        status.mcp = { ...status.mcp, registered: false, matchesExpected: false, scope: undefined };
        return jsonResponse(status);
      }
      if (url.endsWith('/ai/mcp/test')) {
        return jsonResponse({
          ok: true,
          latencyMs: 14,
          protocolVersion: '2025-06-18',
          serverName: 'andrui-terminal',
          serverVersion: '1.0.0',
          toolCount: 11,
          tools: ['android_list_devices', 'android_device_info'],
          sampleToolCallOk: true,
          details: 'Verified MCP server on http://127.0.0.1:19801',
        });
      }
      if (url.endsWith('/ai/skill/install')) {
        status.skill = { ...status.skill, installed: true, upToDate: true };
        return jsonResponse(status);
      }
      if (url.endsWith('/ai/skill/remove')) {
        status.skill = { ...status.skill, installed: false, upToDate: false };
        return jsonResponse(status);
      }
      if (url.endsWith('/ai/mcp/access')) {
        return jsonResponse({
          paused: false,
          deviceIds: [],
          tools: [
            { name: 'android_get_logs', description: 'Dump recent logcat lines.', approval: 'never' },
            { name: 'android_run_operation', description: 'Run a catalog operation.', approval: 'perOperation' },
          ],
          operations: [
            { id: 'logcat.dump', label: 'Logcat Dump', category: 'D', destructive: false, available: true, unavailableReason: null, severity: 'low', blockedReason: null },
            { id: 'shell.exec', label: 'Shell Command', category: 'E', destructive: false, available: true, unavailableReason: null, severity: 'medium', blockedReason: null },
            { id: 'package.uninstall', label: 'Uninstall Package', category: 'P', destructive: true, available: true, unavailableReason: null, severity: 'high', blockedReason: 'Read-only agent policy blocks this operation' },
          ],
        });
      }
      if (url.endsWith('/ai/status')) return jsonResponse(status);
      if (url.endsWith('/approvals') && method === 'POST') {
        const parsed = init?.body ? JSON.parse(init.body as string) : {};
        const simulated: Approval = {
          id: 'ap-sim-123',
          operationId: parsed.operationId || 'device.list',
          operationLabel: 'List Devices',
          destructive: false,
          severity: 'low',
          parameters: parsed.parameters || {},
          preview: { program: 'adb', args: ['devices'], display: 'adb devices' },
          requester: parsed.requester || 'mcp-test',
          status: 'not_required',
          createdAt: '2026-11-11T10:05:00Z',
        };
        approvalsList = [simulated, ...approvalsList];
        return jsonResponse(simulated, 201);
      }
      if (url.endsWith('/approvals')) return jsonResponse(approvalsList);
      return jsonResponse([]);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const renderPage = () =>
    render(
      <WorkstationProvider>
        <AiIntegrationPage />
      </WorkstationProvider>
    );

  it('shows status, the exact MCP command and agent history', async () => {
    renderPage();
    expect(await screen.findByText('/home/u/.local/bin/claude')).toBeTruthy();
    expect(screen.getByText('2.0.0 (Claude Code)')).toBeTruthy();
    expect(screen.getByText('Found')).toBeTruthy();
    expect(screen.getAllByText('Not installed')).toHaveLength(2);
    expect(
      screen.getByText('claude mcp add --scope user andrui -- /usr/bin/andrui-terminal mcp --server http://127.0.0.1:19801')
    ).toBeTruthy();
    expect(screen.getByText('Nothing to approve. Your phone can breathe easy.')).toBeTruthy();
    expect(await screen.findByText('List Devices')).toBeTruthy();
    expect(screen.getByText('not required')).toBeTruthy();
    expect(screen.getByText('Low')).toBeTruthy();
    expect(screen.getByText('lines')).toBeTruthy();
    expect(screen.getByText('200')).toBeTruthy();
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('installs MCP and skill only after confirmation', async () => {
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);
    renderPage();
    const mcpButton = await screen.findByRole('button', { name: 'Install MCP' });
    await waitFor(() => expect((mcpButton as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(mcpButton);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.click(mcpButton);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update MCP' })).toBeDisabled());
    const post = calls.find((c) => c.url.endsWith('/ai/mcp/install'));
    expect(post && JSON.parse(post.body!)).toEqual({ confirmed: true });

    fireEvent.click(screen.getByRole('button', { name: 'Install skill' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Update skill' })).toBeDisabled());
    expect(confirm).toHaveBeenCalledTimes(3);
    expect((screen.getByRole('button', { name: 'Update MCP' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('disables MCP install when the Claude CLI is missing', async () => {
    status.claudeCli = { available: false, reason: 'Claude Code CLI (`claude`) not found' };
    renderPage();
    expect(await screen.findByText('Claude Code CLI (`claude`) not found')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Install MCP' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('runs MCP diagnostic and renders test results', async () => {
    renderPage();
    const testButton = await screen.findByRole('button', { name: 'Run MCP diagnostic' });
    fireEvent.click(testButton);

    expect(await screen.findByText('MCP server diagnostic result')).toBeTruthy();
    expect(screen.getByText('Passed')).toBeTruthy();
    expect(screen.getByText('14 ms')).toBeTruthy();
    expect(screen.getByText('2025-06-18')).toBeTruthy();
    expect(screen.getByText('andrui-terminal v1.0.0')).toBeTruthy();
    expect(screen.getByText('android_list_devices verified')).toBeTruthy();
    expect(screen.getByText(/11 available/)).toBeTruthy();
  });

  it('simulates an agent approval request', async () => {
    renderPage();
    const simButton = await screen.findByRole('button', { name: 'Simulate agent request' });
    fireEvent.click(simButton);

    expect(await screen.findByText(/Submitted agent request ap-sim-123/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/approvals'))).toBe(true);
  });

  it('removes MCP and skill only after confirmation and shows restart notice', async () => {
    status.mcp = {
      ...status.mcp,
      registered: true,
      matchesExpected: true,
      scope: 'user',
      command: '/usr/bin/andrui-terminal',
      args: ['mcp', '--server', 'http://127.0.0.1:19801'],
      restartRequired: true,
    };
    status.skill = {
      ...status.skill,
      installed: true,
      upToDate: true,
    };
    const confirm = vi
      .spyOn(window, 'confirm')
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    renderPage();
    expect(await screen.findByRole('button', { name: 'Remove MCP' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove skill' })).toBeTruthy();
    expect(screen.getAllByText('Up to date')).toHaveLength(2);
    expect(screen.getByText(/binary was replaced on disk/)).toBeTruthy();

    const removeMcpBtn = screen.getByRole('button', { name: 'Remove MCP' });
    fireEvent.click(removeMcpBtn);
    expect(calls.some((c) => c.url.endsWith('/ai/mcp/remove'))).toBe(false);

    fireEvent.click(removeMcpBtn);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove MCP' })).toBeNull());
    const mcpRemoveCall = calls.find((c) => c.url.endsWith('/ai/mcp/remove'));
    expect(mcpRemoveCall && JSON.parse(mcpRemoveCall.body!)).toEqual({ confirmed: true });

    const removeSkillBtn = await screen.findByRole('button', { name: 'Remove skill' });
    fireEvent.click(removeSkillBtn);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Remove skill' })).toBeNull());
    const skillRemoveCall = calls.find((c) => c.url.endsWith('/ai/skill/remove'));
    expect(skillRemoveCall && JSON.parse(skillRemoveCall.body!)).toEqual({ confirmed: true });
    expect(confirm).toHaveBeenCalledTimes(3);
  });

  it('lists MCP tools and operation access only when opened', async () => {
    renderPage();
    const panel = await screen.findByTestId('mcp-access');
    expect(calls.some((c) => c.url.endsWith('/ai/mcp/access'))).toBe(false);
    (panel as HTMLDetailsElement).open = true;
    fireEvent(panel, new Event('toggle'));
    expect(await screen.findByText('android_run_operation')).toBeTruthy();
    expect(screen.getByText('Blocked by policy')).toBeTruthy();
    expect(screen.getByText('Read-only agent policy blocks this operation')).toBeTruthy();
    expect(screen.getByText(/2 tools · 1 operations run without approval · 1 need approval · 1 blocked/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Needs approval (1)' }));
    expect(screen.getByText('(shell.exec)')).toBeTruthy();
    expect(screen.queryByText('(logcat.dump)')).toBeNull();
  });
});
