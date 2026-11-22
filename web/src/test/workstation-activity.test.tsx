import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkstationActivity } from '../components/WorkstationActivity.js';
import { Sidebar } from '../components/Sidebar.js';
import { PageTabs, usePageTab } from '../components/PageTabs.js';
import { api } from '../api/client.js';
import type { Approval, Job, Operation } from '../types/api.js';

const { state } = vi.hoisted(() => ({ state: {} as Record<string, any> }));
vi.mock('../context/WorkstationContext.js', () => ({ useWorkstation: () => state }));
const operation = (id: string, coverage: string, available = true): Operation => ({
  id, label: id, category: coverage === 'A' ? 'Automation' : 'Packages', coverageIds: [`${coverage}01`],
  available, description: '', requiresDevice: true, destructive: false, streaming: false, fields: [],
});
const approval = (status: Approval['status']): Approval => ({
  id: 'approval-1', status, operationId: 'package.stop', operationLabel: 'Stop app', destructive: true,
  severity: 'high', parameters: {}, preview: { program: 'adb', args: [], display: 'adb shell am force-stop app' },
  requester: 'mcp', createdAt: '2026-11-11T12:00:00Z',
});
const job = (status: Job['status']): Job => ({
  id: 'job-1', operationId: 'package.list', status, deviceId: 'phone', stdout: '', stderr: '',
  artifactIds: [], createdAt: '2026-11-11T12:00:00Z',
});
const tree = () => <WorkstationActivity><Sidebar /></WorkstationActivity>;

function AccordionWorkspace() {
  const [value, onChange] = usePageTab('overview', 'workspace');
  return <PageTabs page="overview" value={value} onChange={onChange} tabs={[
    { id: 'workspace', label: 'Workspace', content: <input aria-label="Device draft" /> },
    { id: 'operations', label: 'Operations', content: 'Operation catalog' },
  ]} />;
}

beforeEach(() => {
  Object.assign(state, {
    activePage: 'overview', devices: [{ id: 'phone', state: 'device' }, { id: 'offline', state: 'offline' }],
    devicesLoading: false, devicesError: null, operationsLoading: false, operationsError: null,
    operations: [operation('package.list', 'P'), operation('package.stop', 'P', false), operation('automation.tap', 'A')],
    capabilities: { adbVersion: '34', capabilities: [{ id: 'ok', available: true }, { id: 'missing', available: false }] },
    jobs: [], isWsConnected: true, isMobileNavOpen: false, health: null,
    setActivePage: vi.fn(), setSelectedJobId: vi.fn(), setIsJobDrawerOpen: vi.fn(), setIsArtifactDrawerOpen: vi.fn(), setIsMobileNavOpen: vi.fn(),
  });
  vi.spyOn(api, 'getApprovals').mockResolvedValue([]);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.useRealTimers(); });

it('renders sections inside the sidebar accordion and preserves content when it collapses', () => {
  sessionStorage.clear();
  render(<WorkstationActivity><Sidebar /><div data-testid="workspace"><AccordionWorkspace /></div></WorkstationActivity>);
  const sidebar = document.querySelector('aside')!;
  const parent = screen.getByRole('button', { name: 'Overview / Devices' });
  expect(within(sidebar).getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  expect(within(screen.getByTestId('workspace')).queryByRole('tablist')).toBeNull();
  const draft = screen.getByLabelText('Device draft');
  fireEvent.change(draft, { target: { value: 'keep this draft' } });
  fireEvent.click(parent);
  expect(parent).toHaveAttribute('aria-expanded', 'false');
  expect(screen.queryByRole('tab', { name: 'Devices' })).toBeNull();
  expect(draft).toBeVisible();
  fireEvent.click(parent);
  expect(parent).toHaveAttribute('aria-expanded', 'true');
  const operations = screen.getByRole('tab', { name: 'Operations' });
  expect(within(sidebar).getAllByRole('tab').map(tab => tab.textContent)).toEqual(['Operations']);
  expect(operations).toHaveAttribute('tabindex', '0');
  fireEvent.click(operations);
  expect(screen.getByRole('tabpanel', { name: 'Operations' })).toBeVisible();
  fireEvent.click(parent);
  expect(parent).toHaveAttribute('aria-expanded', 'true');
  expect(screen.getByLabelText('Device draft')).toHaveValue('keep this draft');
  expect(state.setIsMobileNavOpen).toHaveBeenCalledWith(false);
});

it('shows labeled counts on all 14 sidebar tabs and attention for unavailable operations and devices', async () => {
  render(tree());
  await waitFor(() => expect(within(screen.getByRole('button', { name: 'AI Integration' })).getByTitle('Pending agent approvals')).toHaveTextContent('0'));
  expect(screen.getAllByTitle(/^(Connected devices|Available operations|Pending agent approvals|Available capabilities)$/)).toHaveLength(14);
  expect(within(screen.getByRole('button', { name: 'Applications' })).getByTitle('Available operations')).toHaveTextContent('1');
  expect(within(screen.getByRole('button', { name: 'Applications' })).getByTitle('1 unavailable operations')).toBeTruthy();
  expect(within(screen.getByRole('button', { name: 'Overview / Devices' })).getByTitle(/1 devices not ready/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Applications' }));
  expect(state.setActivePage).toHaveBeenCalledWith('apps');
});

it('updates pending approval counts from live events and opens the relevant page from a toast', async () => {
  render(tree());
  await waitFor(() => expect(api.getApprovals).toHaveBeenCalled());
  await act(async () => {});
  act(() => window.dispatchEvent(new CustomEvent('andrui:approval', { detail: approval('pending') })));
  expect(within(screen.getByRole('button', { name: 'AI Integration' })).getByTitle('Pending agent approvals')).toHaveTextContent('1');
  const toast = screen.getByRole('status');
  expect(toast).toHaveTextContent('1 agent request waiting for approval. Your phone is holding its breath.');
  act(() => window.dispatchEvent(new CustomEvent('andrui:approval', { detail: approval('pending') })));
  expect(screen.getAllByRole('status')).toHaveLength(1);
  fireEvent.click(within(toast).getByRole('button', { name: 'View' }));
  expect(state.setActivePage).toHaveBeenCalledWith('ai');
  expect(screen.queryByRole('status')).toBeNull();
  act(() => window.dispatchEvent(new CustomEvent('andrui:approval', { detail: approval('approved') })));
  expect(within(screen.getByRole('button', { name: 'AI Integration' })).getByTitle('Pending agent approvals')).toHaveTextContent('0');
});

it('does not replay historical failures, but notifies once when an active job fails and opens that job', async () => {
  state.jobs = [job('failed')];
  const { rerender } = render(tree());
  await act(async () => {});
  expect(screen.queryByRole('alert')).toBeNull();
  state.jobs = [job('running')];
  rerender(tree());
  expect(within(screen.getByRole('button', { name: 'Applications' })).getByTitle('1 running or queued jobs')).toBeTruthy();
  state.jobs = [job('failed')];
  rerender(tree());
  const toast = screen.getByRole('alert');
  expect(toast).toHaveTextContent('package.list: failed');
  state.jobs = [{ ...job('failed'), stderr: 'Updated output' }];
  rerender(tree());
  expect(screen.getAllByRole('alert')).toHaveLength(1);
  fireEvent.click(within(toast).getByRole('button', { name: 'View' }));
  expect(state.setSelectedJobId).toHaveBeenCalledWith('job-1');
  expect(state.setIsJobDrawerOpen).toHaveBeenCalledWith(true);
});

it('expires success toasts and keeps connection-loss toasts dismissible', async () => {
  vi.useFakeTimers();
  state.jobs = [job('running')];
  const { rerender } = render(tree());
  await act(async () => {});
  state.jobs = [job('completed')];
  rerender(tree());
  expect(screen.getByRole('status')).toHaveTextContent('finished');
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.queryByRole('status')).toBeNull();
  state.isWsConnected = false;
  rerender(tree());
  expect(screen.getByRole('status')).toHaveTextContent('Live connection lost');
  act(() => vi.advanceTimersByTime(6000));
  expect(screen.getByRole('status')).toHaveTextContent('Live connection lost');
  fireEvent.click(screen.getByRole('button', { name: 'Dismiss notification' }));
  expect(screen.queryByRole('status')).toBeNull();
  state.isWsConnected = true;
  rerender(tree());
  expect(screen.getByRole('status')).toHaveTextContent('Live connection restored');
});

it('reports unavailable approval status rather than displaying a false zero', async () => {
  vi.mocked(api.getApprovals).mockRejectedValue(new Error('offline'));
  render(tree());
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not refresh agent approvals');
  const ai = screen.getByRole('button', { name: 'AI Integration' });
  expect(within(ai).getByTitle('Pending agent approvals')).toHaveTextContent('—');
  expect(within(ai).getByTitle('Approval status unavailable')).toBeTruthy();
});

it('keeps a live approval update when an older snapshot arrives late', async () => {
  let resolve!: (items: Approval[]) => void;
  vi.mocked(api.getApprovals).mockReturnValue(new Promise(done => { resolve = done; }));
  render(tree());
  act(() => window.dispatchEvent(new CustomEvent('andrui:approval', { detail: approval('pending') })));
  await act(async () => resolve([]));
  expect(within(screen.getByRole('button', { name: 'AI Integration' })).getByTitle('Pending agent approvals')).toHaveTextContent('1');
});

it('announces device state changes and disconnects without replaying initial states', async () => {
  const { rerender } = render(tree());
  await act(async () => {});
  expect(screen.queryByRole('status')).toBeNull();
  state.devices = [{ id: 'phone', state: 'unauthorized' }, { id: 'offline', state: 'offline' }];
  rerender(tree());
  expect(screen.getByRole('status')).toHaveTextContent('phone: unauthorized');
  state.devices = [{ id: 'offline', state: 'offline' }];
  rerender(tree());
  expect(screen.getByRole('status')).toHaveTextContent('phone: disconnected');
});

it('keeps rolling toaster while job is working and transitions to finished with view and close buttons', async () => {
  vi.useFakeTimers();
  state.jobs = [];
  const { rerender } = render(tree());
  await act(async () => {});

  // 1. Job starts working
  state.jobs = [job('running')];
  rerender(tree());

  const rollingToast = screen.getByRole('status');
  expect(rollingToast).toHaveTextContent('package.list: running');
  expect(within(rollingToast).getByRole('button', { name: 'View' })).toBeTruthy();
  expect(within(rollingToast).getByRole('button', { name: 'Dismiss notification' })).toBeTruthy();

  // 2. Rolling toast does NOT auto-expire while running
  act(() => vi.advanceTimersByTime(12000));
  expect(screen.getByRole('status')).toHaveTextContent('package.list: running');

  // 3. Job finishes: closes working toaster and opens finished toaster
  state.jobs = [job('completed')];
  rerender(tree());

  const finishedToast = screen.getByRole('status');
  expect(finishedToast).toHaveTextContent('package.list: finished');
  expect(within(finishedToast).getByRole('button', { name: 'View' })).toBeTruthy();
  expect(within(finishedToast).getByRole('button', { name: 'Dismiss notification' })).toBeTruthy();

  // 4. View button opens job drawer and selects job
  fireEvent.click(within(finishedToast).getByRole('button', { name: 'View' }));
  expect(state.setSelectedJobId).toHaveBeenCalledWith('job-1');
  expect(state.setIsJobDrawerOpen).toHaveBeenCalledWith(true);
});

it('displays allowing and rejecting buttons on the approval toaster and allows or rejects directly', async () => {
  const approveSpy = vi.spyOn(api, 'approveApproval').mockImplementation((id: string) =>
    Promise.resolve({ ...approval('approved'), id, status: 'approved' })
  );
  const denySpy = vi.spyOn(api, 'denyApproval').mockImplementation((id: string) =>
    Promise.resolve({ ...approval('denied'), id, status: 'denied' })
  );

  render(tree());
  await waitFor(() => expect(api.getApprovals).toHaveBeenCalled());
  await act(async () => {});

  act(() => window.dispatchEvent(new CustomEvent('andrui:approval', { detail: approval('pending') })));

  const toast = screen.getByRole('status');
  expect(toast).toHaveTextContent('1 agent request waiting for approval. Your phone is holding its breath.');

  const allowBtn = within(toast).getByRole('button', { name: 'Allow' });
  const rejectBtn = within(toast).getByRole('button', { name: 'Reject' });
  const viewBtn = within(toast).getByRole('button', { name: 'View' });
  expect(allowBtn).toBeTruthy();
  expect(rejectBtn).toBeTruthy();
  expect(viewBtn).toBeTruthy();

  await act(async () => {
    fireEvent.click(allowBtn);
  });

  expect(approveSpy).toHaveBeenCalledWith('approval-1');
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());

  const secondApproval = { ...approval('pending'), id: 'approval-2' };
  act(() => window.dispatchEvent(new CustomEvent('andrui:approval', { detail: secondApproval })));

  const secondToast = await screen.findByRole('status');
  const rejectBtn2 = within(secondToast).getByRole('button', { name: 'Reject' });

  await act(async () => {
    fireEvent.click(rejectBtn2);
  });

  expect(denySpy).toHaveBeenCalledWith('approval-2');
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
});

it('displays a toaster when a new artifact is added and opens the artifacts drawer on View', async () => {
  render(tree());
  await waitFor(() => expect(api.getApprovals).toHaveBeenCalled());

  act(() => window.dispatchEvent(new CustomEvent('andrui:artifact', {
    detail: { id: 'art-1', name: 'base.apk', size: 1234, contentType: 'application/octet-stream', createdAt: '2026-11-18T12:00:00Z' },
  })));

  const toast = await screen.findByRole('status');
  expect(toast).toHaveTextContent('Artifact added: base.apk');
  fireEvent.click(within(toast).getByRole('button', { name: 'View' }));
  expect(state.setIsArtifactDrawerOpen).toHaveBeenCalledWith(true);
});

it('displays an artifact toaster when a job completes with new artifactIds and deduplicates with live events', async () => {
  state.jobs = [job('running')];
  const { rerender } = render(tree());
  await waitFor(() => expect(api.getApprovals).toHaveBeenCalled());

  state.jobs = [{ ...job('completed'), artifactIds: ['art-job-1'] }];
  rerender(tree());

  const statuses = await screen.findAllByRole('status');
  const artifactToast = statuses.find(el => el.textContent?.includes('Artifact added'));
  expect(artifactToast).toBeTruthy();
  expect(artifactToast).toHaveTextContent('Artifact added from package.list');

  // Sending andrui:artifact for the same ID does not create a duplicate toast.
  act(() => window.dispatchEvent(new CustomEvent('andrui:artifact', {
    detail: { id: 'art-job-1', name: 'base.apk', size: 1234, contentType: 'application/octet-stream', createdAt: '2026-11-18T12:00:00Z' },
  })));
  expect(screen.getAllByRole('status').filter(el => el.textContent?.includes('Artifact added'))).toHaveLength(1);
});
