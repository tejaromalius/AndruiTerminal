export interface AgentPolicy { paused: boolean; readOnly: boolean; deviceIds: string[]; packages: string[]; operationPrefixes: string[] }
export interface DeviceProfile { id: string; name: string; kind: string; tags: string[]; transports: string[]; notes: string }
export interface ModelProvider { endpoint: string; model: string; apiKeyEnv: string }
export interface AssistantReport { id: string; question: string; createdAt: string; answer: string; evidence: unknown; workflow?: { name: string; steps: import('./api.js').WorkflowStep[] }; provider: { endpoint: string; model: string }; latencyMs: number; usage?: unknown }
