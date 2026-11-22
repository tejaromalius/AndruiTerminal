// Shapes of the /api/v1 resources; keep in sync with the Rust models in crates/andrui-core/src/models/.

export type Device = {
  id: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: number;
  details?: Record<string, string>;
};

export type Capability = {
  id: string;
  available: boolean;
  reason?: string;
};

export type Field = {
  name: string;
  label: string;
  type: "string" | "number" | "boolean" | "select" | "text" | "file";
  required?: boolean;
  default?: unknown;
  options?: Array<{
    label: string;
    value: string;
  }>;
  description?: string;
};

export type Operation = {
  id: string;
  label: string;
  category: string;
  description: string;
  unavailableReason?: string;
  requiresDevice: boolean;
  destructive: boolean;
  streaming: boolean;
  available: boolean;
  fields: Array<Field>;
  coverageIds: Array<string>;
};

export type Job = {
  id: string;
  operationId: string;
  deviceId?: string;
  stdout: string;
  stderr: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  exitCode?: number;
  artifactIds: Array<string>;
};

export type Artifact = {
  id: string;
  name: string;
  contentType: string;
  createdAt: string;
  size: number;
};

export type WorkflowStep = {
  operationId: string;
  parameters: Record<string, unknown>;
  assertion?: {
    kind?: string;
    value?: unknown;
  };
  timeoutMs?: number;
};

export type Workflow = {
  id: string;
  name: string;
  steps: Array<WorkflowStep>;
};

export type Error = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

export interface CapabilitiesResponse {
  adbVersion: string;
  capabilities: Capability[];
  mode: string;
}

export interface FieldOption {
  label: string;
  value: string;
}





export type JobStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';









export interface Health {
  status: 'ok' | string;
  mode: string;
  version: string;
}

export interface Session {
  csrfToken: string;
}

export interface FileEntry {
  name: string;
  path: string;
  directory: boolean;
  size?: number;
  mode?: string;
  modified?: string;
}

export interface FileListResponse {
  path: string;
  entries: FileEntry[];
}

export interface ShellCreateResponse {
  id: string;
}

export interface PreviewResponse {
  program: string;
  args: string[];
  display: string;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'failed' | 'not_required';

/** Operation submitted by an agent (MCP); pending ones wait for the user's decision. */
export interface Approval {
  id: string;
  operationId: string;
  operationLabel: string;
  destructive: boolean;
  /** high = destructive, medium = device shell needing approval, low = runs without approval. */
  severity: 'low' | 'medium' | 'high';
  deviceId?: string;
  parameters: Record<string, unknown>;
  preview: PreviewResponse;
  requester: string;
  status: ApprovalStatus;
  jobId?: string;
  error?: string;
  createdAt: string;
  resolvedAt?: string;
}

/** GET /ai/status: Claude Code integration state for the user running the server. */
export interface AiStatus {
  claudeCli: { available: boolean; path?: string; version?: string; reason?: string };
  mcp: {
    registered: boolean;
    scope?: string;
    command?: string;
    args: string[];
    matchesExpected: boolean;
    expectedCommand: string;
    expectedArgs: string[];
    configPath: string;
    restartRequired: boolean;
    reason?: string;
  };
  skill: {
    installed: boolean;
    upToDate: boolean;
    path: string;
    bundledContent: string;
  };
}

/** POST /ai/mcp/test: End-to-end diagnostics result for the MCP server. */
export interface McpTestResult {
  ok: boolean;
  latencyMs: number;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  tools: string[];
  sampleToolCallOk: boolean;
  details?: string;
  error?: string;
}

/** GET /ai/mcp/access: MCP tools and per-operation agent access. */
export interface McpAccess {
  paused: boolean;
  autoApprove?: boolean;
  deviceIds: string[];
  tools: { name: string; description: string; approval: 'never' | 'perOperation' }[];
  operations: {
    id: string;
    label: string;
    category: string;
    destructive: boolean;
    available: boolean;
    unavailableReason: string | null;
    severity: Approval['severity'];
    blockedReason: string | null;
  }[];
}

/** POST /approvals: Agent submission request. */
export interface CreateApprovalRequest {
  operationId: string;
  deviceId?: string;
  parameters?: Record<string, unknown>;
  requester: string;
}

export interface ApiErrorPayload {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type PageId =
  | 'overview'
  | 'apps'
  | 'files'
  | 'shell'
  | 'logs'
  | 'screen'
  | 'layout'
  | 'network'
  | 'diagnostics'
  | 'permissions'
  | 'recovery'
  | 'automation'
  | 'ai'
  | 'settings';

export type ThemeId =
  | 'emerald'
  | 'emerald-light'
  | 'midnight'
  | 'midnight-light'
  | 'matrix'
  | 'matrix-light'
  | 'purple'
  | 'purple-light'
  | 'amber'
  | 'amber-light';

export interface ThemeOption {
  id: ThemeId;
  name: string;
  accent: string;
  bg: string;
  description: string;
  variant: 'dark' | 'light';
  group: 'emerald' | 'midnight' | 'matrix' | 'purple' | 'amber';
}

export type DashboardLayoutMode = 'grid' | 'split' | 'compact';

/** One telemetry sample. A metric is null when the device did not report it. */
export interface TelemetryPoint {
  timestamp: number;
  cpu: {
    total: number;
    user: number;
    system: number;
  } | null;
  memory: {
    usedMb: number;
    cachedMb: number;
    freeMb: number;
    totalMb: number;
  } | null;
  battery: {
    level: number;
    tempC: number | null;
    voltageMv: number | null;
    status: string;
  } | null;
  fps: {
    fps: number;
    p90FrameMs: number | null;
    jankCount: number;
    packageName: string;
  } | null;
  network: {
    rxKb: number;
    txKb: number;
  } | null;
}

// --- Deep inspection: package signing, databases, memory, Firebase ---
export interface CertInfo {
  scheme: string;
  sha256: string;
  sha1: string;
  derLen: number;
  debugKey: boolean;
}
export interface ApkSigning {
  schemes: string[];
  certificates: CertInfo[];
  warnings: string[];
}
export interface ApkFile {
  path: string;
  sha256: string;
  sizeBytes: number;
}
export interface PackageSigning {
  package: string;
  deviceId: string;
  apks: ApkFile[];
  signing: ApkSigning;
}

export type DbAccessMode = 'run-as' | 'root';
export interface DbAccessProbe {
  deviceId: string;
  package: string;
  mode: DbAccessMode | null;
  debuggable: boolean;
  rootAvailable: boolean;
  reason: string | null;
}
export interface DbEntry {
  name: string;
  sizeBytes: number | null;
  sqlite: boolean;
  encrypted: boolean;
}
export interface DbSnapshot {
  id: string;
  deviceId: string;
  package: string;
  databaseName: string;
  mode: DbAccessMode;
  sha256: string;
  sizeBytes: number;
  hadWal: boolean;
  createdAt: string;
}
export interface DbColumn {
  name: string;
  type: string;
  notNull: boolean;
  pk: number;
}
export interface DbTable {
  name: string;
  type: string;
  columns: DbColumn[];
}
export interface DbSchema {
  tables: DbTable[];
}
export interface DbQueryResult {
  columns: string[];
  rows: unknown[][];
  rowsAffected: number | null;
  truncated: boolean;
}
export interface DbPushResult {
  snapshotId: string;
  deviceId: string;
  package: string;
  databaseName: string;
  mode: string;
  bytesWritten: number;
  backupArtifactId: string;
  appForceStopped: boolean;
}

export interface MemorySummary {
  pid: number | null;
  javaHeapKb: number | null;
  nativeHeapKb: number | null;
  codeKb: number | null;
  stackKb: number | null;
  graphicsKb: number | null;
  privateOtherKb: number | null;
  systemKb: number | null;
  totalPssKb: number | null;
  totalRssKb: number | null;
}
export interface MemoryReport {
  deviceId: string;
  package: string;
  summary: MemorySummary;
  rawMeminfo: string;
  smapsRollup?: string;
  available: boolean;
  reason?: string;
}
export interface HeapDumpResult {
  deviceId: string;
  package: string;
  artifactId: string;
  sizeBytes: number;
  native: boolean;
}

export interface FirebaseSdk {
  artifact: string;
  version?: string;
}
export interface FirebaseConfig {
  appIds: string[];
  apiKeys: string[];
  projectIds: string[];
  databaseUrls: string[];
  storageBuckets: string[];
  senderIds: string[];
}
export interface FirebaseReport {
  package: string;
  usesFirebase: boolean;
  sdks: FirebaseSdk[];
  config: FirebaseConfig;
  logTags: string[];
  emulatorPorts: { service: string; port: number }[];
}
export interface FirebaseDebugResult {
  package: string;
  enabled: boolean;
  commands: string[];
}
export interface FcmSendRequest {
  serviceAccountEnv: string;
  projectId?: string;
  token?: string;
  topic?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export interface HostCpuTelemetry {
  model: string;
  cores: number;
  usagePercent: number;
  perCorePercent: number[];
  loadAvg: [number, number, number];
  frequencyMhz?: number | null;
}

export interface HostMemoryTelemetry {
  totalKb: number;
  availableKb: number;
  usedKb: number;
  cachedKb: number;
  buffersKb: number;
  swapTotalKb: number;
  swapUsedKb: number;
  usagePercent: number;
}

export interface HostDiskTelemetry {
  mountPoint: string;
  device: string;
  fsType: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usagePercent: number;
}

export interface HostNetTelemetry {
  interface: string;
  rxBytes: number;
  txBytes: number;
  rxBytesPerSec: number;
  txBytesPerSec: number;
}

export interface HostThermalTelemetry {
  label: string;
  tempC: number;
}

export interface HostBatteryTelemetry {
  capacityPercent: number;
  status: string;
}

export interface HostGpuTelemetry {
  name: string;
  driver: string;
  pciSlot: string;
  suspended: boolean;
  usagePercent?: number | null;
  memoryUsedBytes?: number | null;
  memoryTotalBytes?: number | null;
  tempC?: number | null;
  frequencyMhz?: number | null;
}

export interface HostProcessSummary {
  total: number;
  running: number;
  sleeping: number;
  threads: number;
}

export interface HostProcessEntry {
  pid: number;
  ppid: number;
  uid: number;
  name: string;
  cmdline: string;
  state: string;
  cpuPercent: number;
  rssKb: number;
  threads: number;
}

export interface HostTelemetry {
  collectedAt: number;
  hostname: string;
  kernel: string;
  arch: string;
  uptimeSecs: number;
  cpu: HostCpuTelemetry;
  memory: HostMemoryTelemetry;
  disks: HostDiskTelemetry[];
  network: HostNetTelemetry[];
  thermals: HostThermalTelemetry[];
  battery?: HostBatteryTelemetry | null;
  gpus: HostGpuTelemetry[];
  processSummary: HostProcessSummary;
  processes: HostProcessEntry[];
}
