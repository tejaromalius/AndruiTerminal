import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WorkstationProvider, useWorkstation } from '../context/WorkstationContext.js';
import { OperationFormModal } from '../components/OperationFormModal.js';
import { Operation } from '../types/api.js';

// Helper component to trigger modal open
const TestModalTrigger: React.FC<{ operation: Operation }> = ({ operation }) => {
  const { openOperationModal, setSelectedDeviceId } = useWorkstation();

  React.useEffect(() => {
    setSelectedDeviceId('device-serial-123');
  }, [setSelectedDeviceId]);

  return (
    <button onClick={() => openOperationModal(operation)}>
      Open Modal
    </button>
  );
};

describe('OperationFormModal Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  const mockNonDestructiveOp: Operation = {
    id: 'test_echo',
    label: 'Echo Command',
    category: 'Execution',
    description: 'Echo user text parameter',
    fields: [
      { name: 'message', label: 'Message', type: 'string', required: true, default: 'hello' },
      { name: 'repeat', label: 'Repeat Count', type: 'number', default: 1 },
      { name: 'loud', label: 'Loud Mode', type: 'boolean', default: false },
    ],
    requiresDevice: true,
    destructive: false,
    streaming: false,
    available: true,
    coverageIds: ['E02'],
  };

  const mockDestructiveOp: Operation = {
    id: 'wipe_data',
    label: 'Wipe User Data',
    category: 'System',
    description: 'Wipe device userdata partition',
    fields: [
      { name: 'target', label: 'Target Partition', type: 'string', default: 'userdata' },
    ],
    requiresDevice: true,
    destructive: true,
    streaming: false,
    available: true,
    coverageIds: ['X08'],
  };

  it('renders field types and live preview without destructive warning for normal op', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: 'tok-123' }),
        });
      }
      if (url === '/api/v1/operations/preview') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            program: 'adb',
            args: ['-s', 'device-serial-123', 'shell', 'echo', 'hello'],
            display: 'adb -s device-serial-123 shell echo hello',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });

    render(
      <WorkstationProvider>
        <TestModalTrigger operation={mockNonDestructiveOp} />
        <OperationFormModal />
      </WorkstationProvider>
    );

    // Open the modal
    fireEvent.click(screen.getByText('Open Modal'));

    // Check header and fields
    expect(screen.getByText('Echo Command')).toBeInTheDocument();
    expect(screen.getByText('Message')).toBeInTheDocument();
    expect(screen.getByText('Repeat Count')).toBeInTheDocument();
    expect(screen.getByText('Enable Loud Mode')).toBeInTheDocument();

    // Check preview appears
    await waitFor(() => {
      expect(screen.getByText(/adb -s device-serial-123 shell echo hello/)).toBeInTheDocument();
    });

    // Run button is enabled
    const runBtn = screen.getByRole('button', { name: /Run Operation/i });
    expect(runBtn).not.toBeDisabled();
  });

  it('enforces explicit destructive confirmation for destructive operations', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: 'tok-123' }),
        });
      }
      if (url === '/api/v1/operations/preview') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            program: 'adb',
            args: ['-s', 'device-serial-123', 'rescue', 'wipe', 'userdata'],
            display: 'adb -s device-serial-123 rescue wipe userdata',
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => [],
      });
    });

    render(
      <WorkstationProvider>
        <TestModalTrigger operation={mockDestructiveOp} />
        <OperationFormModal />
      </WorkstationProvider>
    );

    fireEvent.click(screen.getByText('Open Modal'));

    // Verify destructive badge & warning message
    expect(screen.getByText('Wipe User Data')).toBeInTheDocument();
    expect(screen.getByText('Destructive Action Safeguard')).toBeInTheDocument();

    // Run button is disabled before checking confirmation
    const runBtn = screen.getByRole('button', { name: /Run Operation/i });
    expect(runBtn).toBeDisabled();

    // Check the confirmation checkbox
    const confirmCheckbox = screen.getByRole('checkbox', {
      name: /I confirm I want to execute this destructive operation/i,
    });
    fireEvent.click(confirmCheckbox);

    // Now Run button is enabled
    expect(runBtn).not.toBeDisabled();
  });
});
