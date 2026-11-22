import {
  AiStatus,
  Approval,
  Artifact,
  CapabilitiesResponse,
  CreateApprovalRequest,
  Device,
  FileListResponse,
  Health,
  Job,
  McpAccess,
  McpTestResult,
  Operation,
  PreviewResponse,
  Session,
  ShellCreateResponse,
  Workflow,
  PackageSigning,
  DbAccessProbe,
  DbEntry,
  DbSnapshot,
  DbSchema,
  DbQueryResult,
  DbPushResult,
  MemoryReport,
  HeapDumpResult,
  FirebaseReport,
  FirebaseDebugResult,
  FcmSendRequest,
  HostTelemetry,
} from '../types/api.js';

export interface DiscoveredService {
  name: string;
  kind: 'connect' | 'pairing' | 'legacy';
  hostname: string;
  address: string;
  port: number;
  endpoint: string;
}
export interface DiscoveryStatus {
  available: boolean;
  error?: string;
  services: DiscoveredService[];
}

export type StatsScope = 'network' | 'permissions' | 'files' | 'applications' | 'logs' | 'shell' | 'telemetry' | 'screen' | 'system' | 'processes' | 'package' | 'packages' | 'foreground';
export interface StatSection {
  output: string;
  exitCode: number;
}
export interface DeviceStats {
  deviceId: string;
  scope: StatsScope;
  collectedAt: number;
  sections: Record<string, StatSection>;
}

export class ApiError extends Error {
  code: string;
  details?: unknown;
  status: number;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

class ApiClient {
  private baseUrl = '/api/v1';
  private csrfToken: string | null = null;
  private tokenPromise: Promise<string> | null = null;

  private async fetchCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    if (this.tokenPromise) return this.tokenPromise;

    this.tokenPromise = (async () => {
      try {
        const res = await fetch(`${this.baseUrl}/session`, {
          method: 'GET',
          credentials: 'same-origin',
          headers: {
            Accept: 'application/json',
          },
        });
        if (!res.ok) {
          throw new Error(`Failed to fetch session: ${res.statusText}`);
        }
        const data: Session = await res.json();
        this.csrfToken = data.csrfToken;
        return data.csrfToken;
      } finally {
        this.tokenPromise = null;
      }
    })();

    return this.tokenPromise;
  }

  public clearCsrfToken() {
    this.csrfToken = null;
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {},
    isRetry = false
  ): Promise<T> {
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

      let errorData: { error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        errorData = await res.json();
      } catch {
        // Not JSON
      }

      const code = errorData.error?.code || `HTTP_${res.status}`;
      if (res.status === 403 && !isRetry && ['CSRF_ERROR', 'CSRF_INVALID'].includes(code)) {
        this.clearCsrfToken();
        return this.request<T>(endpoint, options, true);
      }
      const message = errorData.error?.message || res.statusText || 'Request failed';
      throw new ApiError(res.status, code, message, errorData.error?.details);
    }

    if (res.status === 204) {
      return {} as T;
    }

    return (await res.json()) as T;
  }

  private async requestWithResponse<T>(
    endpoint: string,
    options: RequestInit = {},
    isRetry = false
  ): Promise<{ data: T; headers: Headers }> {
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
      let errorData: { error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        errorData = await res.json();
      } catch {
        // Not JSON
      }

      const code = errorData.error?.code || `HTTP_${res.status}`;
      if (res.status === 403 && !isRetry && ['CSRF_ERROR', 'CSRF_INVALID'].includes(code)) {
        this.clearCsrfToken();
        return this.requestWithResponse<T>(endpoint, options, true);
      }
      const message = errorData.error?.message || res.statusText || 'Request failed';
      throw new ApiError(res.status, code, message, errorData.error?.details);
    }

    if (res.status === 204) {
      return { data: {} as T, headers: res.headers };
    }

    const data = (await res.json()) as T;
    return { data, headers: res.headers };
  }

  async experience<T>(path: string, method = 'GET', body?: unknown, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method, signal, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }

  // --- Deep inspection: package signing, databases, memory, Firebase ---
  async inspectPackageSigning(deviceId: string, pkg: string): Promise<PackageSigning> {
    const q = new URLSearchParams({ deviceId, package: pkg });
    return this.request<PackageSigning>(`/inspect/package/signing?${q.toString()}`);
  }

  async dbAccess(deviceId: string, pkg: string): Promise<DbAccessProbe> {
    const q = new URLSearchParams({ deviceId, package: pkg });
    return this.request<DbAccessProbe>(`/inspect/database/access?${q.toString()}`);
  }

  async dbList(deviceId: string, pkg: string): Promise<{ mode: string; databases: DbEntry[] }> {
    const q = new URLSearchParams({ deviceId, package: pkg });
    return this.request<{ mode: string; databases: DbEntry[] }>(`/inspect/database/list?${q.toString()}`);
  }

  async dbSnapshots(): Promise<DbSnapshot[]> {
    return this.request<DbSnapshot[]>('/inspect/database/snapshots');
  }

  async dbSnapshotCreate(deviceId: string, pkg: string, database: string): Promise<DbSnapshot> {
    return this.experience<DbSnapshot>('/inspect/database/snapshots', 'POST', {
      deviceId,
      package: pkg,
      database,
    });
  }

  async dbSnapshotDelete(id: string): Promise<void> {
    await this.experience<unknown>(`/inspect/database/snapshots/${encodeURIComponent(id)}`, 'DELETE');
  }

  async dbSchema(id: string): Promise<DbSchema> {
    return this.request<DbSchema>(`/inspect/database/snapshots/${encodeURIComponent(id)}/schema`);
  }

  async dbQuery(id: string, sql: string, maxRows?: number): Promise<DbQueryResult> {
    return this.experience<DbQueryResult>(
      `/inspect/database/snapshots/${encodeURIComponent(id)}/query`,
      'POST',
      { sql, maxRows }
    );
  }

  async dbExecute(id: string, sql: string): Promise<DbQueryResult> {
    return this.experience<DbQueryResult>(
      `/inspect/database/snapshots/${encodeURIComponent(id)}/execute`,
      'POST',
      { sql }
    );
  }

  async dbPush(id: string): Promise<DbPushResult> {
    return this.experience<DbPushResult>(
      `/inspect/database/snapshots/${encodeURIComponent(id)}/push`,
      'POST',
      { confirmed: true }
    );
  }

  async memoryReport(deviceId: string, pkg: string): Promise<MemoryReport> {
    const q = new URLSearchParams({ deviceId, package: pkg });
    return this.request<MemoryReport>(`/inspect/memory?${q.toString()}`);
  }

  async heapDump(deviceId: string, pkg: string, native: boolean): Promise<HeapDumpResult> {
    return this.experience<HeapDumpResult>('/inspect/memory/heapdump', 'POST', {
      deviceId,
      package: pkg,
      native,
      confirmed: true,
    });
  }

  async firebaseReport(deviceId: string, pkg: string): Promise<FirebaseReport> {
    const q = new URLSearchParams({ deviceId, package: pkg });
    return this.request<FirebaseReport>(`/inspect/firebase?${q.toString()}`);
  }

  async firebaseDebug(deviceId: string, pkg: string, enable: boolean): Promise<FirebaseDebugResult> {
    return this.experience<FirebaseDebugResult>('/inspect/firebase/debug', 'POST', {
      deviceId,
      package: pkg,
      enable,
      confirmed: true,
    });
  }

  async firebaseEmulatorReverse(deviceId: string): Promise<{ ports: { service: string; port: number }[] }> {
    return this.experience<{ ports: { service: string; port: number }[] }>(
      '/inspect/firebase/emulator-reverse',
      'POST',
      { deviceId, confirmed: true }
    );
  }

  async firebaseFcmSend(req: FcmSendRequest): Promise<unknown> {
    return this.experience<unknown>('/inspect/firebase/fcm/send', 'POST', { ...req, confirmed: true });
  }

  async waitForSuccessfulJob(id: string, signal?: AbortSignal): Promise<Job> {
    const deadline = Date.now() + 120000;
    while (!signal?.aborted && Date.now() < deadline) {
      const job = await this.request<Job>(`/jobs/${encodeURIComponent(id)}`, { signal });
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (job.status !== 'completed') throw new Error(job.error || job.stderr || `Job ${job.status}`);
        return job;
      }
      await new Promise<void>((resolve, reject) => {
        const abort = () => { clearTimeout(timer); reject(new DOMException('Aborted', 'AbortError')); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, 300);
        signal?.addEventListener('abort', abort, { once: true });
      });
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    throw new Error('Job is still running; inspect or cancel it in Jobs');
  }

  // Health & Session
  async getHealth(): Promise<Health> {
    return this.request<Health>('/health');
  }

  async getSession(): Promise<Session> {
    const token = await this.fetchCsrfToken();
    return { csrfToken: token };
  }

  // Devices
  async getDevices(): Promise<Device[]> {
    return this.request<Device[]>('/devices');
  }

  // Wireless ADB devices advertised over mDNS on the local network
  async getDiscovery(): Promise<DiscoveryStatus> {
    return this.request<DiscoveryStatus>('/discovery');
  }

  // Operations
  async getOperations(): Promise<Operation[]> {
    return this.request<Operation[]>('/operations');
  }

  async previewOperation(
    operationId: string,
    deviceId?: string,
    parameters: Record<string, unknown> = {}
  ): Promise<PreviewResponse> {
    return this.request<PreviewResponse>('/operations/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, deviceId, parameters }),
    });
  }

  // Capabilities
  async getCapabilities(): Promise<CapabilitiesResponse> {
    return this.request<CapabilitiesResponse>('/capabilities');
  }

  // Jobs
  async createJob(
    operationId: string,
    deviceId?: string,
    parameters: Record<string, unknown> = {},
    confirmed = false
  ): Promise<Job> {
    return this.request<Job>('/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationId, deviceId, parameters, confirmed }),
    });
  }

  async getJobs(params?: { limit?: number; offset?: number; full?: boolean }): Promise<{ jobs: Job[]; total: number }> {
    const query = new URLSearchParams();
    if (params?.limit !== undefined) query.set('limit', String(params.limit));
    if (params?.offset !== undefined) query.set('offset', String(params.offset));
    if (params?.full !== undefined) query.set('full', String(params.full));
    const qs = query.toString();
    const res = await this.requestWithResponse<Job[]>(`/jobs${qs ? `?${qs}` : ''}`);
    const jobs = Array.isArray(res.data) ? res.data : [];
    const totalHeader = res.headers?.get ? res.headers.get('X-Total-Count') : null;
    const parsedTotal = totalHeader ? parseInt(totalHeader, 10) : NaN;
    const total = !isNaN(parsedTotal) ? parsedTotal : jobs.length;
    return { jobs, total };
  }

  async getJob(id: string): Promise<Job> {
    return this.request<Job>(`/jobs/${encodeURIComponent(id)}`);
  }

  async cancelJob(id: string): Promise<Job> {
    return this.request<Job>(`/jobs/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    });
  }

  // Agent approvals
  async getApprovals(): Promise<Approval[]> {
    return this.request<Approval[]>('/approvals');
  }

  async approveApproval(id: string): Promise<Approval> {
    return this.request<Approval>(`/approvals/${encodeURIComponent(id)}/approve`, { method: 'POST' });
  }

  async denyApproval(id: string): Promise<Approval> {
    return this.request<Approval>(`/approvals/${encodeURIComponent(id)}/deny`, { method: 'POST' });
  }

  async createApproval(req: CreateApprovalRequest): Promise<Approval> {
    return this.request<Approval>('/approvals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
    });
  }

  // Claude Code integration
  async getAiStatus(): Promise<AiStatus> {
    return this.request<AiStatus>('/ai/status');
  }

  async installMcp(): Promise<AiStatus> {
    return this.request<AiStatus>('/ai/mcp/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
  }

  async removeMcp(): Promise<AiStatus> {
    return this.request<AiStatus>('/ai/mcp/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
  }

  async testMcp(): Promise<McpTestResult> {
    return this.request<McpTestResult>('/ai/mcp/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
  }

  async getMcpAccess(): Promise<McpAccess> {
    return this.request<McpAccess>('/ai/mcp/access');
  }

  async installSkill(): Promise<AiStatus> {
    return this.request<AiStatus>('/ai/skill/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
  }

  async removeSkill(): Promise<AiStatus> {
    return this.request<AiStatus>('/ai/skill/remove', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true }),
    });
  }

  // Artifacts
  async getArtifacts(): Promise<Artifact[]> {
    return this.request<Artifact[]>('/artifacts');
  }

  async uploadArtifact(file: File): Promise<Artifact> {
    const token = await this.fetchCsrfToken();
    const formData = new FormData();
    formData.append('file', file);

    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (token) {
      headers['X-CSRF-Token'] = token;
    }

    const res = await fetch(`${this.baseUrl}/artifacts`, {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: formData,
    });

    if (!res.ok) {
      let errorData: { error?: { code?: string; message?: string; details?: unknown } } = {};
      try {
        errorData = await res.json();
      } catch {
        // no-op
      }
      throw new ApiError(
        res.status,
        errorData.error?.code || `HTTP_${res.status}`,
        errorData.error?.message || 'File upload failed',
        errorData.error?.details
      );
    }

    return res.json();
  }

  getArtifactDownloadUrl(id: string): string {
    return `${this.baseUrl}/artifacts/${encodeURIComponent(id)}`;
  }

  async deleteArtifact(id: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(`/artifacts/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  // Files
  async getFiles(deviceId: string, path: string): Promise<FileListResponse> {
    const q = new URLSearchParams({ deviceId, path });
    return this.request<FileListResponse>(`/files?${q.toString()}`);
  }

  // Read-only KPI statistics (not recorded as jobs)
  async getStats(deviceId: string, scope: StatsScope, packageName?: string): Promise<DeviceStats> {
    const q = new URLSearchParams({ deviceId, scope });
    if (packageName) q.set('package', packageName);
    return this.request<DeviceStats>(`/stats?${q.toString()}`);
  }

  // Shell
  async createShell(deviceId: string, cols?: number, rows?: number): Promise<ShellCreateResponse> {
    return this.request<ShellCreateResponse>('/shell', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, cols, rows }),
    });
  }

  getShellWebSocketUrl(shellId: string): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.baseUrl}/shell/${encodeURIComponent(shellId)}`;
  }

  getEventsWebSocketUrl(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${window.location.host}${this.baseUrl}/events`;
  }

  getJobEventsUrl(jobId: string): string {
    return `${this.baseUrl}/jobs/${encodeURIComponent(jobId)}/events`;
  }

  // Workflows
  async getWorkflows(): Promise<Workflow[]> {
    return this.request<Workflow[]>('/workflows');
  }

  async getWorkflow(id: string): Promise<Workflow> {
    return this.request<Workflow>(`/workflows/${encodeURIComponent(id)}`);
  }

  async createWorkflow(workflow: Omit<Workflow, 'id'>): Promise<Workflow> {
    return this.request<Workflow>('/workflows', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
  }

  async updateWorkflow(id: string, workflow: Partial<Workflow>): Promise<Workflow> {
    return this.request<Workflow>(`/workflows/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(workflow),
    });
  }

  async deleteWorkflow(id: string): Promise<{ deleted: boolean }> {
    return this.request<{ deleted: boolean }>(`/workflows/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  }

  async runWorkflow(id: string, deviceIds: string[], confirmed = false): Promise<{ jobIds: string[] }> {
    return this.request<{ jobIds: string[] }>(`/workflows/${encodeURIComponent(id)}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceIds, confirmed }),
    });
  }

  async waitForJob(id: string, timeoutMs = 120000): Promise<Job> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const job = await this.getJob(id);
      if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    throw new Error('Job is still running; inspect or cancel it in Jobs');
  }

  // Settings
  async getSettings(): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/settings');
  }

  async updateSettings(settings: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>('/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(settings),
    });
  }

  // Screen Extension
  async captureScreen(deviceId: string): Promise<{ artifactId?: string; dataUrl?: string }> {
    return this.request<{ artifactId?: string; dataUrl?: string }>(
      `/screen/capture?deviceId=${encodeURIComponent(deviceId)}`
    );
  }

  async startAutomationSession(deviceId: string): Promise<{ id: string; helperVersion: string }> {
    return this.request('/automation/sessions', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, confirmed: true }),
    });
  }

  async listAutomationSessions(): Promise<Array<{ id: string; deviceId: string; helperVersion: string }>> {
    return this.request('/automation/sessions');
  }

  async stopAutomationSession(id: string): Promise<unknown> {
    return this.request(`/automation/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
  }

  // Automation Extension
  async getAutomationHierarchy(deviceId: string, fallback = false): Promise<{ hierarchy: string; nodeCount?: number }> {
    const fallbackParam = fallback ? '&fallback=true' : '';
    const result = await this.request<{ xml: string }>(
      `/automation/hierarchy?deviceId=${encodeURIComponent(deviceId)}${fallbackParam}`
    );
    return { hierarchy: result.xml };
  }

  async runAutomationAction(
    deviceId: string,
    action: Record<string, unknown>
  ): Promise<{ success: boolean; result?: unknown }> {
    return this.request<{ success: boolean; result?: unknown }>('/automation/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        ...action,
        action: action.action || action.type,
        selector: typeof action.selector === 'string'
          ? (action.selector.startsWith('/') ? { xpath: action.selector }
            : action.selector.includes(':id/') ? { resourceId: action.selector }
            : { text: action.selector })
          : action.selector,
      }),
    });
  }

  async getHostTelemetry(): Promise<HostTelemetry> {
    return this.request<HostTelemetry>('/host/telemetry');
  }

  async getHostReverseStatus(deviceId: string): Promise<{
    deviceId: string;
    port: number;
    active: boolean;
    autoReverse: boolean;
    url: string;
  }> {
    return this.request(`/host/reverse?deviceId=${encodeURIComponent(deviceId)}`);
  }

  async setHostReverse(
    deviceId: string,
    options: { enabled?: boolean; autoReverse?: boolean }
  ): Promise<{
    deviceId: string;
    port: number;
    active: boolean;
    autoReverse: boolean;
    url: string;
  }> {
    return this.request('/host/reverse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, ...options }),
    });
  }

  async openHostOnPhone(
    deviceId: string,
    confirmed: boolean
  ): Promise<{ deviceId: string; port: number; url: string }> {
    return this.request<{ deviceId: string; port: number; url: string }>('/host/open-on-phone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, confirmed }),
    });
  }
}

export const api = new ApiClient();
