import React from 'react';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkstationProvider } from '../context/WorkstationContext.js';
import { AutomationPage } from '../pages/AutomationPage.js';
import { Operation, Workflow } from '../types/api.js';
import { api } from '../api/client.js';

const mockOperations: Operation[] = [
  {
    id: 'shell.exec',
    label: 'Execute Shell Command',
    category: 'E',
    description: 'Run command in device shell',
    fields: [
      { name: 'command', label: 'Shell Command', type: 'text', required: true, default: 'getprop ro.build.version.release' },
    ],
    requiresDevice: true,
    destructive: false,
    streaming: true,
    available: true,
    coverageIds: ['E02'],
  },
  {
    id: 'packages.install',
    label: 'Install Package',
    category: 'P',
    description: 'Install APK on device',
    fields: [
      { name: 'package', label: 'Package Identifier', type: 'string', required: true, default: 'com.example.app' },
      { name: 'reinstall', label: 'Reinstall Existing', type: 'boolean', default: true },
      { name: 'timeout', label: 'Timeout Seconds', type: 'number', default: 30 },
    ],
    requiresDevice: true,
    destructive: false,
    streaming: false,
    available: true,
    coverageIds: ['P01'],
  },
  {
    id: 'device.noop',
    label: 'No-op Operation',
    category: 'C',
    description: 'Takes no parameters',
    fields: [],
    requiresDevice: false,
    destructive: false,
    streaming: false,
    available: true,
    coverageIds: ['C01'],
  },
];

const mockWorkflows: Workflow[] = [
  {
    id: 'wf-1',
    name: 'Sample Pipeline',
    steps: [
      {
        operationId: 'shell.exec',
        parameters: { command: 'uname -a' },
      },
    ],
  },
];

describe('AutomationPage Step Parameter Accordion', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const setupFetch = (createdCallback?: (body: unknown) => void) => {
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const u = typeof url === 'string' ? url : (url as Request).url;
      if (u.includes('/api/v1/session')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: 'test-token' }),
        });
      }
      if (u.includes('/api/v1/operations')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockOperations,
        });
      }
      if (u.includes('/api/v1/workflows') && init?.method === 'POST') {
        const parsed = JSON.parse(init.body as string);
        if (createdCallback) createdCallback(parsed);
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ id: 'wf-new-123', ...parsed }),
        });
      }
      if (u.includes('/api/v1/workflows')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockWorkflows,
        });
      }
      if (u.includes('/api/v1/devices')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [{ id: 'dev-1', state: 'device' }],
        });
      }
      if (u.includes('/api/v1/capabilities')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ adbVersion: '1.0.41', capabilities: [], mode: 'native' }),
        });
      }
      if (u.includes('/api/v1/jobs')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => [],
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });
  };

  it('lists saved pipelines and deletes the selected one from its detail', async () => {
    setupFetch();
    const deleteWorkflow = vi.spyOn(api, 'deleteWorkflow').mockResolvedValue(undefined as never);
    render(
      <WorkstationProvider>
        <AutomationPage />
      </WorkstationProvider>
    );
    const list = await screen.findByRole('listbox', { name: 'Saved Pipelines' });
    fireEvent.click(await within(list).findByText('Sample Pipeline'));
    expect(screen.getByText(/ID: wf-1/)).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Delete workflow'));
    await waitFor(() => expect(deleteWorkflow).toHaveBeenCalledWith('wf-1'));
  });

  it('renders step parameter controls and initializes with defaults', async () => {
    setupFetch();

    render(
      <WorkstationProvider>
        <AutomationPage />
      </WorkstationProvider>
    );

    // Wait for initial data to load
    await screen.findAllByText('Sample Pipeline');

    // Click "New Workflow"
    const newBtn = await screen.findByRole('button', { name: /new workflow/i });
    fireEvent.click(newBtn);

    // Step #1 should be present and expanded with parameter field for shell.exec
    expect(await screen.findByText(/Step Parameters \(1\)/i)).toBeDefined();
    const cmdInput = (await screen.findByLabelText(/Shell Command/i)) as HTMLTextAreaElement;
    expect(cmdInput.value).toBe('getprop ro.build.version.release');
  });

  it('allows expanding and collapsing steps', async () => {
    setupFetch();

    render(
      <WorkstationProvider>
        <AutomationPage />
      </WorkstationProvider>
    );

    await screen.findAllByText('Sample Pipeline');

    const newBtn = await screen.findByRole('button', { name: /new workflow/i });
    fireEvent.click(newBtn);

    expect(await screen.findByText(/Step Parameters \(1\)/i)).toBeDefined();

    // Collapse step #1
    const collapseBtn = screen.getByRole('button', { name: /collapse step 1/i });
    fireEvent.click(collapseBtn);

    expect(screen.queryByText(/Step Parameters \(1\)/i)).toBeNull();

    // Re-expand step #1
    const expandBtn = screen.getByRole('button', { name: /expand step 1/i });
    fireEvent.click(expandBtn);

    expect(screen.getByText(/Step Parameters \(1\)/i)).toBeDefined();
  });

  it('re-seeds default parameters when changing operation to packages.install', async () => {
    setupFetch();

    render(
      <WorkstationProvider>
        <AutomationPage />
      </WorkstationProvider>
    );

    await screen.findAllByText('Sample Pipeline');

    const newBtn = await screen.findByRole('button', { name: /new workflow/i });
    fireEvent.click(newBtn);

    const selectOp = await screen.findByDisplayValue(/Execute Shell Command \(shell\.exec\)/i);
    fireEvent.change(selectOp, { target: { value: 'packages.install' } });

    // Should now show parameters for packages.install
    expect(await screen.findByText(/Step Parameters \(3\)/i)).toBeDefined();
    const pkgInput = screen.getByPlaceholderText(/Package Identifier/i) as HTMLInputElement;
    expect(pkgInput.value).toBe('com.example.app');

    const timeoutInput = screen.getByPlaceholderText(/Timeout Seconds/i) as HTMLInputElement;
    expect(timeoutInput.value).toBe('30');
  });

  it('enforces validation on required fields before saving', async () => {
    let savedPayload: any = null;
    setupFetch((body) => {
      savedPayload = body;
    });

    render(
      <WorkstationProvider>
        <AutomationPage />
      </WorkstationProvider>
    );

    await screen.findAllByText('Sample Pipeline');

    const newBtn = await screen.findByRole('button', { name: /new workflow/i });
    fireEvent.click(newBtn);

    const cmdInput = (await screen.findByLabelText(/Shell Command/i)) as HTMLTextAreaElement;
    const saveBtn = screen.getByRole('button', { name: /save workflow/i }) as HTMLButtonElement;

    // Initially valid with default value
    expect(saveBtn.disabled).toBe(false);

    // Clear required command input
    fireEvent.change(cmdInput, { target: { value: '' } });

    // Save should now be disabled and show validation message
    expect(saveBtn.disabled).toBe(true);
    expect(screen.getByText(/Missing required \(1\)/i)).toBeDefined();

    // Fill valid parameter
    fireEvent.change(cmdInput, { target: { value: 'pm list packages' } });
    expect(saveBtn.disabled).toBe(false);

    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(savedPayload).not.toBeNull();
      expect(savedPayload.steps[0].parameters.command).toBe('pm list packages');
    });
  });
});
