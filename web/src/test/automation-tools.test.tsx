import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WorkstationProvider, useWorkstation } from '../context/WorkstationContext.js';
import { AutomationTools } from '../components/AutomationTools.js';
import { api } from '../api/client.js';

// Helper component to initialize device in WorkstationContext
const TestDeviceWrapper: React.FC<{ deviceId?: string | null; children: React.ReactNode }> = ({
  deviceId = 'emulator-5554',
  children,
}) => {
  const { setSelectedDeviceId } = useWorkstation();

  React.useEffect(() => {
    setSelectedDeviceId(deviceId);
  }, [deviceId, setSelectedDeviceId]);

  return <>{children}</>;
};

describe('AutomationTools Component and automationClient', () => {
  const originalFetch = globalThis.fetch;
  const originalWebSocket = globalThis.WebSocket;

  let activeSockets: any[] = [];

  class ControllableMockWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = 1;
    url: string;
    onopen: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    close = vi.fn(() => {
      this.readyState = ControllableMockWebSocket.CLOSED;
      if (this.onclose) this.onclose();
    });

    send = vi.fn();

    constructor(url: string) {
      this.url = url;
      activeSockets.push(this);
      setTimeout(() => {
        if (this.onopen) this.onopen();
      }, 0);
    }
  }

  beforeEach(() => {
    api.clearCsrfToken();
    vi.restoreAllMocks();
    activeSockets = [];
    globalThis.WebSocket = ControllableMockWebSocket as unknown as typeof WebSocket;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    globalThis.WebSocket = originalWebSocket;
  });

  // =========================================================================
  // 1. Host OCR
  // =========================================================================
  describe('Host OCR', () => {
    it('sends multipart request with image and language, and parses response', async () => {
      let capturedUrl = '';
      let capturedMethod = '';
      let capturedHeaders: Record<string, string> = {};
      let capturedBody: any = null;

      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (url === '/api/v1/automation/ocr') {
          capturedUrl = url;
          capturedMethod = init?.method || '';
          capturedHeaders = (init?.headers as Record<string, string>) || {};
          capturedBody = init?.body as FormData;

          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              text: 'Recognized Sample Text',
              regions: [
                {
                  text: 'Sample',
                  left: 12,
                  top: 34,
                  width: 56,
                  height: 78,
                  confidence: 96.4,
                },
              ],
            }),
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      render(
        <WorkstationProvider>
          <AutomationTools />
        </WorkstationProvider>
      );

      // Verify on OCR tab by default
      expect(screen.getByTestId('ocr-section')).toBeInTheDocument();

      // Submit should be disabled before selecting an image
      const submitBtn = screen.getByTestId('ocr-submit-button');
      expect(submitBtn).toBeDisabled();

      // Create dummy image file
      const file = new File(['fake-png-bytes'], 'test-image.png', { type: 'image/png' });
      const fileInput = screen.getByTestId('ocr-file-input');
      fireEvent.change(fileInput, { target: { files: [file] } });

      // Change language code
      const langInput = screen.getByTestId('ocr-language-input');
      fireEvent.change(langInput, { target: { value: 'deu' } });

      expect(submitBtn).not.toBeDisabled();

      // Click Run OCR
      fireEvent.click(submitBtn);

      await waitFor(() => {
        expect(screen.getByTestId('ocr-result')).toBeInTheDocument();
      });

      // Validate multipart HTTP interaction
      expect(capturedUrl).toBe('/api/v1/automation/ocr');
      expect(capturedMethod).toBe('POST');
      expect(capturedHeaders['X-CSRF-Token']).toBe('test-csrf-token');
      expect(capturedBody).toBeInstanceOf(FormData);
      expect(capturedBody?.get('image')).toBeInstanceOf(File);
      expect(capturedBody?.get('language')).toBe('deu');

      // Validate displayed output
      expect(screen.getByTestId('ocr-text-output')).toHaveTextContent('Recognized Sample Text');
      expect(screen.getByTestId('ocr-regions-table')).toHaveTextContent('Sample');
      expect(screen.getByTestId('ocr-regions-table')).toHaveTextContent('[12, 34, 56, 78]');
      expect(screen.getByTestId('ocr-regions-table')).toHaveTextContent('96.4%');
    });

    it('displays explicit API error when Tesseract is unavailable and does NOT show success', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (url === '/api/v1/automation/ocr') {
          return Promise.resolve({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: async () => ({
              error: {
                code: 'tesseract_unavailable',
                message:
                  'Tesseract OCR executable not found in host PATH. Install tesseract-ocr to enable OCR capabilities.',
              },
            }),
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      render(
        <WorkstationProvider>
          <AutomationTools />
        </WorkstationProvider>
      );

      const file = new File(['dummy-bytes'], 'screenshot.png', { type: 'image/png' });
      fireEvent.change(screen.getByTestId('ocr-file-input'), { target: { files: [file] } });

      fireEvent.click(screen.getByTestId('ocr-submit-button'));

      await waitFor(() => {
        expect(screen.getByTestId('ocr-error')).toBeInTheDocument();
      });

      expect(screen.getByTestId('ocr-error')).toHaveTextContent('tesseract_unavailable');
      expect(screen.getByTestId('ocr-error')).toHaveTextContent(
        'Tesseract OCR executable not found in host PATH'
      );
      expect(screen.queryByTestId('ocr-result')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 2. Template Matching
  // =========================================================================
  describe('Template Matching', () => {
    it('sends two images with threshold and maxMatches, and displays coordinates', async () => {
      let capturedBody: any = null;

      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (url === '/api/v1/automation/match') {
          capturedBody = init?.body as FormData;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              matches: [
                {
                  x: 150,
                  y: 240,
                  width: 48,
                  height: 48,
                  score: 0.9234,
                },
              ],
            }),
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      render(
        <WorkstationProvider>
          <AutomationTools />
        </WorkstationProvider>
      );

      // Switch to Template Match tab
      fireEvent.click(screen.getByTestId('tab-match'));
      expect(screen.getByTestId('match-section')).toBeInTheDocument();

      const sourceFile = new File(['haystack-bytes'], 'haystack.png', { type: 'image/png' });
      const templateFile = new File(['needle-bytes'], 'needle.png', { type: 'image/png' });

      fireEvent.change(screen.getByTestId('match-source-input'), {
        target: { files: [sourceFile] },
      });
      fireEvent.change(screen.getByTestId('match-template-input'), {
        target: { files: [templateFile] },
      });

      fireEvent.change(screen.getByTestId('match-threshold-input'), { target: { value: '0.85' } });
      fireEvent.change(screen.getByTestId('match-max-matches-input'), { target: { value: '5' } });

      fireEvent.click(screen.getByTestId('match-submit-button'));

      await waitFor(() => {
        expect(screen.getByTestId('match-result')).toBeInTheDocument();
      });

      expect(capturedBody?.get('threshold')).toBe('0.85');
      expect(capturedBody?.get('maxMatches')).toBe('5');
      expect(capturedBody?.get('image')).toBeInstanceOf(File);
      expect(capturedBody?.get('template')).toBeInstanceOf(File);

      expect(screen.getByTestId('match-count-badge')).toHaveTextContent('1 matches found');
      expect(screen.getByTestId('matches-table')).toHaveTextContent('[150, 240]');
      expect(screen.getByTestId('matches-table')).toHaveTextContent('48 × 48');
      expect(screen.getByTestId('matches-table')).toHaveTextContent('92.3%');
    });

    it('displays error and does not render matches on bad request', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (url === '/api/v1/automation/match') {
          return Promise.resolve({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
              error: {
                code: 'invalid_image',
                message: 'Failed to decode source image',
              },
            }),
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      render(
        <WorkstationProvider>
          <AutomationTools />
        </WorkstationProvider>
      );

      fireEvent.click(screen.getByTestId('tab-match'));

      const sourceFile = new File(['corrupt-bytes'], 'bad.png', { type: 'image/png' });
      const templateFile = new File(['needle-bytes'], 'needle.png', { type: 'image/png' });

      fireEvent.change(screen.getByTestId('match-source-input'), {
        target: { files: [sourceFile] },
      });
      fireEvent.change(screen.getByTestId('match-template-input'), {
        target: { files: [templateFile] },
      });

      fireEvent.click(screen.getByTestId('match-submit-button'));

      await waitFor(() => {
        expect(screen.getByTestId('match-error')).toBeInTheDocument();
      });

      expect(screen.getByTestId('match-error')).toHaveTextContent('invalid_image');
      expect(screen.getByTestId('match-error')).toHaveTextContent('Failed to decode source image');
      expect(screen.queryByTestId('matches-table')).not.toBeInTheDocument();
    });
  });

  // =========================================================================
  // 3. Action Recordings
  // =========================================================================
  describe('Action Recordings', () => {
    it('disables recording start when device is not selected', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => [],
      });

      render(
        <WorkstationProvider>
          <TestDeviceWrapper deviceId={null}>
            <AutomationTools />
          </TestDeviceWrapper>
        </WorkstationProvider>
      );

      fireEvent.click(screen.getByTestId('tab-recordings'));

      expect(screen.getByTestId('no-device-warning')).toBeInTheDocument();
      expect(screen.getByTestId('start-recording-btn')).toBeDisabled();
    });

    it('starts and stops recording and displays steps', async () => {
      let startBody: any = null;
      let stoppedId = '';

      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings/start') {
          startBody = JSON.parse(init?.body as string);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              id: 'rec-xyz-789',
              deviceId: 'emulator-5554',
              name: 'Checkout Flow',
              startedAt: 1700000000000,
            }),
          });
        }
        if (url.startsWith('/api/v1/automation/recordings/') && url.endsWith('/stop')) {
          const match = url.match(/\/recordings\/(.+?)\/stop/);
          stoppedId = match ? match[1] : '';
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              id: 'rec-xyz-789',
              deviceId: 'emulator-5554',
              name: 'Checkout Flow',
              startedAt: 1700000000000,
              steps: [
                {
                  action: 'click',
                  selector: { resourceId: 'com.app:id/btn_buy' },
                  timestamp: 1700000001000,
                  durationMs: 82,
                },
                {
                  action: 'setText',
                  selector: { resourceId: 'com.app:id/input_code' },
                  text: 'DISCOUNT10',
                  timestamp: 1700000002000,
                  durationMs: 120,
                },
              ],
            }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'rec-xyz-789',
                deviceId: 'emulator-5554',
                name: 'Checkout Flow',
                startedAt: 1700000000000,
                steps: [
                  {
                    action: 'click',
                    selector: { resourceId: 'com.app:id/btn_buy' },
                    timestamp: 1700000001000,
                    durationMs: 82,
                  },
                ],
              },
            ],
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      render(
        <WorkstationProvider>
          <TestDeviceWrapper deviceId="emulator-5554">
            <AutomationTools />
          </TestDeviceWrapper>
        </WorkstationProvider>
      );

      fireEvent.click(screen.getByTestId('tab-recordings'));

      // Enter recording name and click Start
      const nameInput = screen.getByTestId('recording-name-input');
      fireEvent.change(nameInput, { target: { value: 'Checkout Flow' } });

      fireEvent.click(screen.getByTestId('start-recording-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('stop-recording-btn')).toBeInTheDocument();
      });

      expect(startBody).toEqual({
        deviceId: 'emulator-5554',
        name: 'Checkout Flow',
      });

      // Stop recording
      fireEvent.click(screen.getByTestId('stop-recording-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('selected-recording-steps')).toBeInTheDocument();
      });

      expect(stoppedId).toBe('rec-xyz-789');

      // Verify steps table rendered
      const stepsTable = screen.getByTestId('recorded-steps-table');
      expect(stepsTable).toHaveTextContent('click');
      expect(stepsTable).toHaveTextContent('com.app:id/btn_buy');
      expect(stepsTable).toHaveTextContent('82ms');
      expect(stepsTable).toHaveTextContent('setText');
      expect(stepsTable).toHaveTextContent('text="DISCOUNT10"');
    });
  });

  // =========================================================================
  // 4. Action Replay & WebSocket Progress
  // =========================================================================
  describe('Action Replay and WebSocket', () => {
    it('initiates replay, establishes WebSocket, streams step progress, and handles cancel', async () => {
      let replayBody: any = null;
      let cancelledReplayId = '';

      globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [
              {
                id: 'rec-test-100',
                deviceId: 'emulator-5554',
                name: 'Login Sequence',
                startedAt: 1700000000000,
                steps: [
                  { action: 'click', selector: { text: 'Login' }, timestamp: 1, durationMs: 40 },
                  { action: 'setText', selector: { resourceId: 'user' }, text: 'admin', timestamp: 2, durationMs: 60 },
                ],
              },
            ],
          });
        }
        if (url === '/api/v1/automation/replay') {
          replayBody = JSON.parse(init?.body as string);
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              id: 'rep-session-555',
              recordingId: 'rec-test-100',
              deviceId: 'emulator-5554',
              status: 'running',
              totalSteps: 2,
            }),
          });
        }
        if (url === '/api/v1/automation/replays/rep-session-555') {
          cancelledReplayId = 'rep-session-555';
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ id: 'rep-session-555', cancelled: true }),
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      render(
        <WorkstationProvider>
          <TestDeviceWrapper deviceId="emulator-5554">
            <AutomationTools />
          </TestDeviceWrapper>
        </WorkstationProvider>
      );

      fireEvent.click(screen.getByTestId('tab-replay'));

      // Wait for recordings to populate dropdown
      await waitFor(() => {
        expect(screen.getByTestId('replay-recording-select')).toBeInTheDocument();
      });

      fireEvent.change(screen.getByTestId('replay-recording-select'), {
        target: { value: 'rec-test-100' },
      });

      // Start replay
      fireEvent.click(screen.getByTestId('start-replay-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('replay-status-badge')).toHaveTextContent('RUNNING');
      });

      expect(replayBody).toEqual({
        recordingId: 'rec-test-100',
        deviceId: 'emulator-5554',
      });

      // Find the active WebSocket
      const replaySocket = activeSockets.find((s) =>
        s.url.includes('/api/v1/automation/replays/rep-session-555/events')
      );
      expect(replaySocket).toBeDefined();

      // Emit step 1 passed event
      act(() => {
        if (replaySocket?.onmessage) {
          replaySocket.onmessage({
            data: JSON.stringify({
              replayId: 'rep-session-555',
              stepIndex: 0,
              totalSteps: 2,
              action: 'click',
              status: 'passed',
              durationMs: 45,
            }),
          } as MessageEvent);
        }
      });

      await waitFor(() => {
        expect(screen.getByTestId('replay-events-table')).toHaveTextContent('click');
      });

      expect(screen.getByTestId('replay-events-table')).toHaveTextContent('45ms');

      // Click cancel replay
      fireEvent.click(screen.getByTestId('cancel-replay-btn'));

      await waitFor(() => {
        expect(cancelledReplayId).toBe('rep-session-555');
        expect(screen.getByTestId('replay-status-badge')).toHaveTextContent('CANCELLED');
      });

      expect(replaySocket.close).toHaveBeenCalled();
    });
  });

  // =========================================================================
  // 5. Accessibility Events Stream, Bounded Events & Cleanup
  // =========================================================================
  describe('Accessibility Events Stream and Cleanup', () => {
    it('streams events, bounds retention to max 200, detects sequence gap, and cleans up on unmount', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        if (url === '/api/v1/automation/recordings') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => [],
          });
        }
        if (url === '/api/v1/capabilities') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              capabilities: [],
              adbVersion: '34.0.4',
              mode: 'native',
            }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      const { unmount } = render(
        <WorkstationProvider>
          <TestDeviceWrapper deviceId="emulator-5554">
            <AutomationTools />
          </TestDeviceWrapper>
        </WorkstationProvider>
      );

      fireEvent.click(screen.getByTestId('tab-events'));

      const startStreamBtn = screen.getByTestId('start-stream-btn');
      fireEvent.click(startStreamBtn);

      await waitFor(() => {
        expect(screen.getByTestId('stream-status-badge')).toHaveTextContent('CONNECTED');
      });

      const eventsSocket = activeSockets.find((s) =>
        s.url.includes('/api/v1/automation/events?deviceId=emulator-5554')
      );
      expect(eventsSocket).toBeDefined();

      // Emit 250 batch events to test max 200 retention bound
      const batchOf250 = Array.from({ length: 250 }, (_, i) => ({
        sequence: i + 1,
        eventType: 'TYPE_VIEW_CLICKED',
        packageName: 'com.android.settings',
        className: 'android.widget.TextView',
        text: `Item ${i + 1}`,
      }));

      act(() => {
        if (eventsSocket?.onmessage) {
          eventsSocket.onmessage({
            data: JSON.stringify({
              type: 'events',
              sequence: 250,
              events: batchOf250,
            }),
          } as MessageEvent);
        }
      });

      await waitFor(() => {
        expect(screen.getByTestId('event-count-indicator')).toHaveTextContent('200 / 200 retained');
      });

      // Item 1 should have been dropped; Item 250 must be present
      const eventsTable = screen.getByTestId('accessibility-events-table');
      expect(eventsTable).toHaveTextContent('Item 250');
      expect(eventsTable).not.toHaveTextContent('Item 1\n');

      // Simulate sequence gap message from helper ring-buffer overflow
      act(() => {
        if (eventsSocket?.onmessage) {
          eventsSocket.onmessage({
            data: JSON.stringify({
              type: 'sequence_gap',
              dropped: 42,
              lastSequence: 250,
              nextSequence: 293,
              message:
                'Event buffer overflow: 42 accessibility events were dropped. Re-fetch hierarchy snapshot.',
            }),
          } as MessageEvent);
        }
      });

      await waitFor(() => {
        expect(screen.getByTestId('sequence-gap-alert')).toBeInTheDocument();
      });
      expect(screen.getByTestId('sequence-gap-alert')).toHaveTextContent('42 accessibility events were dropped');

      // Test unmount cleanup
      unmount();
      expect(eventsSocket.close).toHaveBeenCalled();
    });

    it('cleans up WebSocket when device changes', async () => {
      globalThis.fetch = vi.fn().mockImplementation((url: string) => {
        if (url === '/api/v1/session') {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ csrfToken: 'test-csrf-token' }),
          });
        }
        return Promise.resolve({ ok: true, status: 200, json: async () => [] });
      });

      const TestHarness: React.FC = () => {
        const { setSelectedDeviceId } = useWorkstation();
        return (
          <div>
            <button
              onClick={() => setSelectedDeviceId('device-A')}
              data-testid="select-device-a"
            >
              Device A
            </button>
            <button
              onClick={() => setSelectedDeviceId('device-B')}
              data-testid="select-device-b"
            >
              Device B
            </button>
            <AutomationTools />
          </div>
        );
      };

      render(
        <WorkstationProvider>
          <TestHarness />
        </WorkstationProvider>
      );

      fireEvent.click(screen.getByTestId('select-device-a'));
      fireEvent.click(screen.getByTestId('tab-events'));

      fireEvent.click(screen.getByTestId('start-stream-btn'));

      await waitFor(() => {
        expect(screen.getByTestId('stream-status-badge')).toHaveTextContent('CONNECTED');
      });

      const socketA = activeSockets.find((s) => s.url.includes('deviceId=device-A'));
      expect(socketA).toBeDefined();

      // Change device to device-B
      fireEvent.click(screen.getByTestId('select-device-b'));

      await waitFor(() => {
        expect(socketA.close).toHaveBeenCalled();
        expect(screen.getByTestId('stream-status-badge')).toHaveTextContent('DISCONNECTED');
      });
    });
  });
});
