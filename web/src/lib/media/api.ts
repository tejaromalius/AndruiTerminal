import { api } from '../../api/client.js';
import {
  CaptureResponse,
  CreateSessionOptions,
  MediaCapabilities,
  ScreenSessionResponse,
} from './types.js';

class MediaApi {
  private baseUrl = '/api/v1/screen';

  private async fetchCsrfToken(): Promise<string> {
    const session = await api.getSession();
    if (!session.csrfToken) throw new Error('No session token was issued');
    return session.csrfToken;
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = (options.method || 'GET').toUpperCase();
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((options.headers as Record<string, string>) || {}),
    };

    if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
      headers['X-CSRF-Token'] = await this.fetchCsrfToken();
    }

    const res = await fetch(url, {
      ...options,
      credentials: 'same-origin',
      headers,
    });

    if (!res.ok) {
      let errorBody: { error?: { code?: string; message?: string } } = {};
      try {
        errorBody = await res.json();
      } catch {
        // Non-JSON error
      }
      const code = errorBody.error?.code || `HTTP_${res.status}`;
      const message = errorBody.error?.message || res.statusText || 'API request failed';
      throw new Error(`[${code}] ${message}`);
    }

    return res.json();
  }

  async getCapabilities(): Promise<MediaCapabilities> {
    return this.request<MediaCapabilities>('/capabilities');
  }

  async captureScreen(deviceId: string): Promise<CaptureResponse> {
    return this.request<CaptureResponse>(`/capture?deviceId=${encodeURIComponent(deviceId)}`);
  }

  async getScreenshotBlob(deviceId: string): Promise<Blob> {
    const url = `${this.baseUrl}/screenshot?deviceId=${encodeURIComponent(deviceId)}`;
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error(`Failed to capture screenshot: ${res.statusText}`);
    }
    return res.blob();
  }

  async createSession(options: CreateSessionOptions): Promise<ScreenSessionResponse> {
    return this.request<ScreenSessionResponse>('/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(options),
    });
  }

  async deleteSession(sessionId: string): Promise<{ deleted: boolean; id: string }> {
    return this.request<{ deleted: boolean; id: string }>(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE',
    });
  }
}

export const mediaApi = new MediaApi();
