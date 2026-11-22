import React from 'react';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api } from '../api/client.js';
import { AiDrawer } from '../components/AiDrawer.js';
import { AiConfiguration } from '../components/AiConfiguration.js';

let target = 'phone-a';
const setIsAiDrawerOpen = vi.fn();
const setActivePage = vi.fn();

vi.mock('../context/WorkstationContext.js', () => ({
  useWorkstation: () => ({
    selectedDeviceId: target,
    devices: [
      { id: 'phone-a', model: 'Phone A', state: 'device' },
      { id: 'phone-b', model: 'Phone B', state: 'device' },
    ],
    isAiDrawerOpen: true,
    setIsAiDrawerOpen,
    setActivePage,
  }),
}));

const provider = { endpoint: 'http://127.0.0.1:11434/v1', model: 'local-test', apiKeyEnv: '' };
const result = {
  id: 'report-id',
  question: 'Why?',
  createdAt: '2026-11-17',
  answer: 'Evidence suggests a crash; no action executed.',
  evidence: {},
  provider,
  latencyMs: 12,
};

async function openAssistant() {
  await screen.findByLabelText('Assistant request');
  await screen.findByText(/local-test/);
}

describe('reviewed AI requests', () => {
  beforeEach(() => {
    target = 'phone-a';
    setIsAiDrawerOpen.mockReset();
    setActivePage.mockReset();
    vi.spyOn(api, 'experience').mockImplementation(async (path, method, body) => {
      if (path === '/ai/provider') return provider as never;
      if (path === '/ai/evidence') return { deviceId: target, secret: 'remove-before-send' } as never;
      if (path === '/ai/assist') return result as never;
      if (path === '/ai/policy') return (method === 'PUT' && body ? body : { paused: false, readOnly: false, deviceIds: [], packages: [], operationPrefixes: [] }) as never;
      return [] as never;
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('sends edited evidence and resets the prompt after the request', async () => {
    render(<AiDrawer />);
    await openAssistant();
    expect(screen.getByRole('button', { name: 'Ask assistant' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Assistant request'), { target: { value: 'Explain this crash' } });
    expect(screen.getByRole('button', { name: 'Ask assistant' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Collect evidence' }));
    await waitFor(() =>
      expect((screen.getByLabelText('Evidence to send') as HTMLTextAreaElement).value).toContain('remove-before-send')
    );
    fireEvent.change(screen.getByLabelText('Evidence to send'), {
      target: { value: '{"observations":{"crash":"test"}}' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));
    await screen.findByText(result.answer);
    const request = vi.mocked(api.experience).mock.calls.find((c) => c[0] === '/ai/assist');
    expect(request?.[2]).toMatchObject({ confirmed: true, evidence: { observations: { crash: 'test' } } });
    expect(JSON.stringify(request?.[2])).not.toContain('remove-before-send');
    expect(screen.getByLabelText('Assistant request')).toHaveValue('');
  });

  it('sends a user-selected tool output limit, clamped and remembered', async () => {
    localStorage.removeItem('andrui_ai_tool_output_limit');
    render(<AiDrawer />);
    await openAssistant();
    const limit = screen.getByLabelText('Tool output limit');
    expect(limit).toHaveValue(12000);
    fireEvent.change(limit, { target: { value: '500' } });
    fireEvent.blur(limit);
    expect(limit).toHaveValue(1000);
    fireEvent.change(limit, { target: { value: '6000' } });
    fireEvent.blur(limit);
    expect(localStorage.getItem('andrui_ai_tool_output_limit')).toBe('6000');
    fireEvent.change(screen.getByLabelText('Assistant request'), { target: { value: 'Top RAM process?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));
    await screen.findByText(result.answer);
    const request = vi.mocked(api.experience).mock.calls.find((c) => c[0] === '/ai/assist');
    expect(request?.[2]).toMatchObject({ toolOutputLimit: 6000 });
    localStorage.removeItem('andrui_ai_tool_output_limit');
  });

  it('discards evidence and conversation when the selected device changes', async () => {
    const view = render(<AiDrawer />);
    await openAssistant();
    fireEvent.change(screen.getByLabelText('Evidence to send'), { target: { value: '{"device":"phone-a"}' } });
    target = 'phone-b';
    view.rerender(<AiDrawer />);
    await waitFor(() => expect(screen.getByLabelText('Evidence to send')).toHaveValue('{}'));
  });

  it('saves generated workflows only after a separate review action', async () => {
    const create = vi.spyOn(api, 'createWorkflow').mockResolvedValue({ id: 'wf', name: 'Test', steps: [] });
    vi.mocked(api.experience).mockImplementation(async (path) =>
      path === '/ai/provider'
        ? (provider as never)
        : path === '/ai/assist'
          ? ({
              ...result,
              workflow: { name: 'Test', steps: [{ operationId: 'automation.click', parameters: { selector: { text: 'Settings' } } }] },
            } as never)
          : ([] as never)
    );
    render(<AiDrawer />);
    await openAssistant();
    fireEvent.click(screen.getByRole('button', { name: 'Workflow' }));
    fireEvent.change(screen.getByLabelText('Assistant request'), { target: { value: 'Create test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Propose workflow' }));
    await screen.findByRole('button', { name: 'Save proposed workflow' });
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save proposed workflow' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it('shows backend failures without producing a report', async () => {
    vi.mocked(api.experience).mockImplementation(async (path) => {
      if (path === '/ai/provider') return provider as never;
      throw new Error('Provider rejected the request');
    });
    render(<AiDrawer />);
    await openAssistant();
    fireEvent.change(screen.getByLabelText('Assistant request'), { target: { value: 'Why?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ask assistant' }));
    await screen.findByText('Provider rejected the request');
    expect(screen.queryByText('Download report and evidence')).not.toBeInTheDocument();
  });

  it('persists permission changes and exposes stop', async () => {
    render(<AiConfiguration />);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save permissions' })).toBeEnabled());
    fireEvent.click(screen.getByLabelText('Read-only operations'));
    fireEvent.click(screen.getByRole('button', { name: 'Save permissions' }));
    await waitFor(() =>
      expect(
        vi.mocked(api.experience).mock.calls.some(
          (c) => c[0] === '/ai/policy' && c[1] === 'PUT' && (c[2] as { readOnly: boolean }).readOnly
        )
      ).toBe(true)
    );
    fireEvent.click(screen.getByRole('button', { name: 'Stop agent' }));
    await waitFor(() =>
      expect(vi.mocked(api.experience).mock.calls.some((c) => c[0] === '/ai/stop' && c[1] === 'POST')).toBe(true)
    );
  });

  it('enables and disables full auto mode after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<AiConfiguration />);
    const fullAutoBtn = await screen.findByRole('button', { name: 'Full auto mode' });
    await waitFor(() => expect(fullAutoBtn).toBeEnabled());

    fireEvent.click(fullAutoBtn);
    expect(vi.mocked(api.experience).mock.calls.some((c) => c[0] === '/ai/policy' && c[1] === 'PUT')).toBe(false);

    fireEvent.click(fullAutoBtn);
    await waitFor(() =>
      expect(
        vi.mocked(api.experience).mock.calls.some(
          (c) =>
            c[0] === '/ai/policy' &&
            c[1] === 'PUT' &&
            (c[2] as { autoApprove?: boolean; paused?: boolean; readOnly?: boolean }).autoApprove === true &&
            (c[2] as { paused?: boolean }).paused === false &&
            (c[2] as { readOnly?: boolean }).readOnly === false
        )
      ).toBe(true)
    );
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole('button', { name: 'Disable full auto' })).toBeInTheDocument();
  });

  it('starts with manual model input and switches to running model selector on Auto detect', async () => {
    vi.mocked(api.experience).mockImplementation(async (path, method, body) => {
      if (path === '/ai/provider' && (!method || method === 'GET')) {
        return { endpoint: 'http://127.0.0.1:11434/v1', model: '', apiKeyEnv: '' } as never;
      }
      if (path === '/ai/provider/test' && method === 'POST') {
        const payload = body as { probe?: string; provider?: { endpoint: string } } | undefined;
        if (payload?.provider?.endpoint === 'http://127.0.0.1:1234/v1') {
          return { latencyMs: 5, models: { data: [{ id: 'qwen2.5-coder:7b' }] } } as never;
        }
        return { latencyMs: 8, models: { data: [{ id: 'llama3.2:latest' }, { id: 'mistral:7b' }] } } as never;
      }
      if (path === '/ai/policy') return { paused: false, readOnly: false, deviceIds: [], packages: [], operationPrefixes: [] } as never;
      return [] as never;
    });
    render(<AiConfiguration />);
    const manualInput = (await screen.findByLabelText('Model')) as HTMLInputElement;
    await waitFor(() => expect(manualInput).toBeEnabled());
    expect(manualInput.tagName).toBe('INPUT');

    fireEvent.click(screen.getByRole('button', { name: 'Auto detect' }));
    const select = (await screen.findByRole('combobox', { name: 'Model' })) as HTMLSelectElement;
    expect(screen.getByRole('option', { name: 'llama3.2:latest' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'mistral:7b' })).toBeInTheDocument();
    fireEvent.change(select, { target: { value: 'mistral:7b' } });
    expect(select.value).toBe('mistral:7b');

    fireEvent.click(screen.getByRole('button', { name: 'Manual' }));
    const backToInput = (await screen.findByLabelText('Model')) as HTMLInputElement;
    expect(backToInput.tagName).toBe('INPUT');
    expect(backToInput.value).toBe('mistral:7b');
  });
});
