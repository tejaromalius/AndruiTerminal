import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UserPolicyPanel, parseUserRows } from '../components/UserPolicyPanel.js';
import * as WorkstationContext from '../context/WorkstationContext.js';
import { api } from '../api/client.js';
import type { Job, Operation } from '../types/api.js';

afterEach(() => vi.restoreAllMocks());

const USERS = 'Users:\n\tUserInfo{0:Owner:c13} running\n\tUserInfo{10:Work Profile:1030}';
const job = (over: Partial<Job>): Job => ({ id: 'j1', operationId: 'applinks.get', status: 'completed', exitCode: 0, stdout: '', stderr: '', artifactIds: [], createdAt: '', ...over });

describe('UserPolicyPanel', () => {
  it('parses pm list users rows', () => {
    expect(parseUserRows(USERS)).toEqual([
      { id: '0', name: 'Owner', flags: 'c13', running: true },
      { id: '10', name: 'Work Profile', flags: '1030', running: false },
    ]);
  });

  it('runs app links for the typed package and shows the output in the panel', async () => {
    const runOperation = vi.fn().mockResolvedValue(job({ status: 'running' }));
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      findOperation: (id: string) => ({ id, label: id } as Operation), openOperationModal: vi.fn(), runOperation, jobs: [],
    } as any);
    vi.spyOn(api, 'waitForJob').mockResolvedValue(job({ stdout: 'com.example.app:\n  example.com: verified' }));
    render(<UserPolicyPanel deviceId="dev-1" packageName="com.example.app" usersText={USERS} owners={[]} onRefresh={vi.fn()} refreshing={false} />);

    expect(screen.getByText('Work Profile')).toBeInTheDocument();
    expect(screen.getByText('No admin owns this device')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Verify App Links/ }));
    expect(runOperation).toHaveBeenCalledWith('applinks.get', { package: 'com.example.app' });
    expect(await screen.findByText(/example\.com: verified/)).toBeInTheDocument();
    expect(screen.getByText('completed')).toBeInTheDocument();
  });

  it('keeps destructive actions behind the operation dialog', () => {
    const openOperationModal = vi.fn();
    vi.spyOn(WorkstationContext, 'useWorkstation').mockReturnValue({
      findOperation: (id: string) => ({ id, label: id } as Operation), openOperationModal, runOperation: vi.fn(), jobs: [],
    } as any);
    render(<UserPolicyPanel deviceId="dev-1" packageName="" usersText={USERS} owners={null} onRefresh={vi.fn()} refreshing={false} />);
    fireEvent.click(screen.getByRole('button', { name: /Create New User/ }));
    expect(openOperationModal).toHaveBeenCalledWith(expect.objectContaining({ id: 'users.create' }), { name: 'Work Profile' });
    expect(screen.getByText('Waiting for confirmation in the operation dialog…')).toBeInTheDocument();
  });
});
