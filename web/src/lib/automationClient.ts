import { api, ApiError } from '../api/client.js';

export interface OcrRegion {
  text: string;
  left: number;
  top: number;
  width: number;
  height: number;
  confidence: number;
}

export interface OcrResponse {
  text: string;
  regions: OcrRegion[];
}

export interface MatchResultItem {
  x: number;
  y: number;
  width: number;
  height: number;
  score: number;
}

export interface MatchResponse {
  matches: MatchResultItem[];
}

export interface RecordedStep {
  action: string;
  selector: Record<string, unknown> | string | unknown;
  text?: string;
  direction?: string;
  condition?: string;
  timestamp: number;
  durationMs: number;
}

export interface RecordingDetail {
  id: string;
  deviceId: string;
  name?: string;
  startedAt: number;
  steps: RecordedStep[];
}

export interface StartRecordingResponse {
  id: string;
  deviceId: string;
  name?: string;
  startedAt: number;
}

export interface StartReplayResponse {
  id: string;
  recordingId: string;
  deviceId: string;
  status: string;
  totalSteps: number;
}

export interface CancelReplayResponse {
  id: string;
  cancelled: boolean;
}

export interface ReplayEvent {
  replayId: string;
  stepIndex?: number;
  totalSteps?: number;
  action?: string;
  status: string;
  durationMs?: number;
  error?: string;
}

export interface AccessibilityEventBatch {
  type: 'events';
  sequence: number;
  events: Record<string, unknown>[];
}

export interface SequenceGapMessage {
  type: 'sequence_gap';
  dropped: number;
  lastSequence: number;
  nextSequence: number;
  message: string;
}

export interface ReconnectNeededMessage {
  type: 'reconnect_needed';
  message: string;
}

export interface AutomationErrorMessage {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type AccessibilityStreamMessage =
  | AccessibilityEventBatch
  | SequenceGapMessage
  | ReconnectNeededMessage
  | AutomationErrorMessage;

export interface AutomationCapabilitiesResponse {
  helperApk: {
    available: boolean;
    path?: string;
    reason?: string;
  };
  tesseract: {
    available: boolean;
    version?: string;
    reason?: string;
  };
  templateMatching: {
    available: boolean;
    method: string;
  };
  capabilities: Array<{
    id: string;
    available: boolean;
    reason?: string;
  }>;
}

export interface HelperStatus {
  deviceId: string;
  package: string;
  hostApk: { available: boolean; path?: string; sha256?: string; reason?: string };
  installed: boolean;
  installedPath?: string;
  versionName?: string;
  versionCode?: number;
  installedSha256?: string;
  upToDate: boolean | null;
  session: { id: string; helperVersion: string; hostPort: number } | null;
}

export type HelperCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

/** `incomplete`: nothing failed or warned, but some checks did not run. */
export type HelperOverallStatus = 'pass' | 'warn' | 'fail' | 'incomplete';

export interface HelperCheck {
  id: string;
  label: string;
  status: HelperCheckStatus;
  detail: string;
  guidance?: string;
}

export interface HelperChecksResponse {
  deviceId: string;
  overall: HelperOverallStatus;
  checks: HelperCheck[];
  status: HelperStatus;
}

const BASE_URL = '/api/v1/automation';

async function fetchCsrfToken(): Promise<string> {
  const session = await api.getSession();
  return session.csrfToken;
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {},
  isRetry = false
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const method = (options.method || 'GET').toUpperCase();
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };

  if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(method)) {
    headers['X-CSRF-Token'] = await fetchCsrfToken();
  }

  const res = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    headers,
  });

  if (!res.ok) {
    let errorData: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      errorData = await res.json();
    } catch {
      // Body is not JSON
    }
    const code = errorData.error?.code || `HTTP_${res.status}`;
    if (res.status === 403 && !isRetry && ['CSRF_ERROR', 'CSRF_INVALID'].includes(code)) {
      api.clearCsrfToken();
      return request<T>(endpoint, options, true);
    }
    const message = errorData.error?.message || res.statusText || 'Request failed';
    throw new ApiError(res.status, code, message, errorData.error?.details);
  }

  if (res.status === 204) {
    return {} as T;
  }

  return (await res.json()) as T;
}

async function requestMultipart<T>(
  endpoint: string,
  formData: FormData,
  isRetry = false
): Promise<T> {
  const url = `${BASE_URL}${endpoint}`;
  const csrfToken = await fetchCsrfToken();

  const res = await fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      Accept: 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: formData,
  });

  if (!res.ok) {
    let errorData: { error?: { code?: string; message?: string; details?: unknown } } = {};
    try {
      errorData = await res.json();
    } catch {
      // Body is not JSON
    }
    const code = errorData.error?.code || `HTTP_${res.status}`;
    if (res.status === 403 && !isRetry && ['CSRF_ERROR', 'CSRF_INVALID'].includes(code)) {
      api.clearCsrfToken();
      return requestMultipart<T>(endpoint, formData, true);
    }
    const message = errorData.error?.message || res.statusText || 'Request failed';
    throw new ApiError(res.status, code, message, errorData.error?.details);
  }

  return (await res.json()) as T;
}

export const automationClient = {
  // OCR via host Tesseract
  async runOcr(image: Blob | File, language?: string): Promise<OcrResponse> {
    const formData = new FormData();
    formData.append('image', image);
    if (language && language.trim().length > 0) {
      formData.append('language', language.trim());
    }
    return requestMultipart<OcrResponse>('/ocr', formData);
  },

  // Normalized template matching
  async runTemplateMatch(
    image: Blob | File,
    template: Blob | File,
    threshold?: number,
    maxMatches?: number
  ): Promise<MatchResponse> {
    const formData = new FormData();
    formData.append('image', image);
    formData.append('template', template);
    if (threshold !== undefined) {
      formData.append('threshold', String(threshold));
    }
    if (maxMatches !== undefined) {
      formData.append('maxMatches', String(maxMatches));
    }
    return requestMultipart<MatchResponse>('/match', formData);
  },

  // Action recording
  async startRecording(deviceId: string, name?: string): Promise<StartRecordingResponse> {
    return request<StartRecordingResponse>('/recordings/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        ...(name && name.trim().length > 0 ? { name: name.trim() } : {}),
      }),
    });
  },

  async stopRecording(recordingId: string): Promise<RecordingDetail> {
    return request<RecordingDetail>(`/recordings/${encodeURIComponent(recordingId)}/stop`, {
      method: 'POST',
    });
  },

  async listRecordings(): Promise<RecordingDetail[]> {
    return request<RecordingDetail[]>('/recordings', { method: 'GET' });
  },

  async getRecording(recordingId: string): Promise<RecordingDetail> {
    return request<RecordingDetail>(`/recordings/${encodeURIComponent(recordingId)}`, {
      method: 'GET',
    });
  },

  // Replay
  async startReplay(recordingId: string, deviceId: string): Promise<StartReplayResponse> {
    return request<StartReplayResponse>('/replay', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recordingId, deviceId }),
    });
  },

  async cancelReplay(replayId: string): Promise<CancelReplayResponse> {
    return request<CancelReplayResponse>(`/replays/${encodeURIComponent(replayId)}`, {
      method: 'DELETE',
    });
  },

  // Capabilities
  async getCapabilities(): Promise<AutomationCapabilitiesResponse> {
    return request<AutomationCapabilitiesResponse>('/capabilities', { method: 'GET' });
  },

  // Helper APK status, confirmed install, and functional checks
  async getHelperStatus(deviceId: string): Promise<HelperStatus> {
    return request<HelperStatus>(`/helper/status?deviceId=${encodeURIComponent(deviceId)}`);
  },

  async installHelper(deviceId: string): Promise<HelperStatus> {
    return request<HelperStatus>('/helper/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, confirmed: true }),
    });
  },

  async uninstallHelper(deviceId: string): Promise<HelperStatus> {
    return request<HelperStatus>('/helper/uninstall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, confirmed: true }),
    });
  },

  async runHelperChecks(deviceId: string): Promise<HelperChecksResponse> {
    return request<HelperChecksResponse>(`/helper/checks?deviceId=${encodeURIComponent(deviceId)}`);
  },

  // WebSocket Handshake and URL helpers
  async prepareWsSession(): Promise<string> {
    return fetchCsrfToken();
  },

  getReplayWebSocketUrl(replayId: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${BASE_URL}/replays/${encodeURIComponent(replayId)}/events`;
  },

  getEventsWebSocketUrl(deviceId: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${BASE_URL}/events?deviceId=${encodeURIComponent(deviceId)}`;
  },
};
