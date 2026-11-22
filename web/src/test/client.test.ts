import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, ApiError } from '../api/client.js';

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    api.clearCsrfToken();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('fetches health without CSRF token', async () => {
    const mockHealth = { status: 'ok', mode: 'host', version: '1.0.0' };
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => mockHealth,
    });

    const res = await api.getHealth();
    expect(res).toEqual(mockHealth);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      '/api/v1/health',
      expect.objectContaining({
        credentials: 'same-origin',
      })
    );
  });

  it('automatically acquires CSRF token before POST mutating requests', async () => {
    const mockSession = { csrfToken: 'test-csrf-token-123' };
    const mockJob = {
      id: 'job-1',
      operationId: 'reboot',
      status: 'queued',
      stdout: '',
      stderr: '',
      createdAt: '2026-11-08T00:00:00Z',
      artifactIds: [],
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url === '/api/v1/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => mockSession,
        });
      }
      if (url === '/api/v1/jobs' && init?.method === 'POST') {
        expect(init.headers).toHaveProperty('X-CSRF-Token', 'test-csrf-token-123');
        return Promise.resolve({
          ok: true,
          status: 202,
          json: async () => mockJob,
        });
      }
      return Promise.reject(new Error(`Unexpected call: ${url}`));
    });

    const job = await api.createJob('reboot', 'emulator-5554', {}, true);
    expect(job).toEqual(mockJob);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('parses structured API errors into ApiError', async () => {
    const errorPayload = {
      error: {
        code: 'DEVICE_OFFLINE',
        message: 'Device emulator-5554 is offline',
        details: { transportId: 4 },
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => errorPayload,
    });

    await expect(api.getFiles('emulator-5554', '/sdcard')).rejects.toThrow(ApiError);

    try {
      await api.getFiles('emulator-5554', '/sdcard');
    } catch (err: unknown) {
      const apiErr = err as ApiError;
      expect(apiErr.code).toBe('DEVICE_OFFLINE');
      expect(apiErr.message).toBe('Device emulator-5554 is offline');
      expect(apiErr.status).toBe(400);
      expect(apiErr.details).toEqual({ transportId: 4 });
    }
  });

  it('refetches CSRF token and retries once on 403 response', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: `token-${callCount}` }),
        });
      }
      if (url === '/api/v1/jobs/job-1/cancel') {
        callCount++;
        if (callCount === 1) {
          // first try returns 403 invalid CSRF
          return Promise.resolve({
            ok: false,
            status: 403,
            statusText: 'Forbidden - CSRF invalid',
            json: async () => ({ error: { code: 'CSRF_INVALID', message: 'Token expired' } }),
          });
        }
        // retry succeeds
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ id: 'job-1', status: 'cancelled' }),
        });
      }
      return Promise.reject(new Error(`Unexpected call: ${url}`));
    });

    const res = await api.cancelJob('job-1');
    expect(res.status).toBe('cancelled');
    expect(callCount).toBe(2);
  });

  it('previews operations through POST /operations/preview', async () => {
    const previewData = {
      program: 'adb',
      args: ['-s', 'emulator-5554', 'install', '-r', 'pkg.apk'],
      display: 'adb -s emulator-5554 install -r pkg.apk',
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/v1/session') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ csrfToken: 'tok' }),
        });
      }
      if (url === '/api/v1/operations/preview') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => previewData,
        });
      }
      return Promise.reject(new Error(url));
    });

    const res = await api.previewOperation('install', 'emulator-5554', { replace: true });
    expect(res).toEqual(previewData);
  });
  it('does not send a mutation if session acquisition fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Session unavailable'));
    await expect(api.createJob('package.install', 'phone', {})).rejects.toThrow('Session unavailable');
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry a forbidden device operation', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => Promise.resolve(
      url.endsWith('/session')
        ? { ok: true, status: 200, json: async () => ({ csrfToken: 'token' }) }
        : { ok: false, status: 403, json: async () => ({ error: { code: 'DEVICE_FORBIDDEN', message: 'Denied' } }) }
    ));
    await expect(api.createJob('package.install', 'phone', {})).rejects.toThrow('Denied');
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('passes limit and offset to getJobs and extracts total from X-Total-Count', async () => {
    const mockJobs = [{ id: 'job-1', operationId: 'shell', status: 'completed' }];
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      expect(url).toBe('/api/v1/jobs?limit=50&offset=100');
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ 'X-Total-Count': '350' }),
        json: async () => mockJobs,
      });
    });

    const res = await api.getJobs({ limit: 50, offset: 100 });
    expect(res.jobs).toEqual(mockJobs);
    expect(res.total).toBe(350);
  });
});
