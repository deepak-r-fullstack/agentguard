import { apiClient } from "./apiClient";
import {
  AgentAction,
  AgentSummary,
  ApiEnvelope,
  AuditEvent,
  Catalog,
  ChatOutcome,
  CompanyData,
  Policy,
  PolicyInput,
  RuleDraft,
  SessionUser,
} from "utils/types";

// Thin wrappers around each endpoint. They return `data` only; the message comes back too when a screen wants it.

async function unwrap<T>(request: Promise<{ data: ApiEnvelope<T> }>) {
  const response = await request;
  return response.data;
}

export const authService = {
  login: (email: string, password: string) =>
    unwrap<{ token: string; user: SessionUser }>(apiClient.post("/auth/login", { email, password })),
};

export const actionService = {
  list: (filters: { status?: string; action?: string } = {}) =>
    unwrap<AgentAction[]>(apiClient.get("/actions", { params: filters })),
  get: (id: string) => unwrap<AgentAction>(apiClient.get(`/actions/${id}`)),
  stats: () => unwrap<{ pendingApprovals: number }>(apiClient.get("/actions/stats")),
  approve: (id: string) => unwrap<AgentAction>(apiClient.post(`/actions/${id}/approve`)),
  reject: (id: string, note = "") => unwrap<AgentAction>(apiClient.post(`/actions/${id}/reject`, { note })),
  undo: (id: string) => unwrap<AgentAction>(apiClient.post(`/actions/${id}/undo`)),
};

export const policyService = {
  list: () => unwrap<Policy[]>(apiClient.get("/policies")),
  catalog: () => unwrap<Catalog>(apiClient.get("/policies/catalog")),
  create: (input: PolicyInput) => unwrap<Policy>(apiClient.post("/policies", input)),
  update: (id: string, input: PolicyInput) => unwrap<Policy>(apiClient.put(`/policies/${id}`, input)),
  remove: (id: string) => unwrap<null>(apiClient.delete(`/policies/${id}`)),
  draft: (text: string) => unwrap<RuleDraft>(apiClient.post("/policies/draft", { text })),
};

export const auditService = {
  list: (filters: { type?: string; actorType?: string } = {}) =>
    unwrap<AuditEvent[]>(apiClient.get("/audit", { params: filters })),
  exportCsv: async (filters: { type?: string; actorType?: string } = {}) => {
    const response = await apiClient.get("/audit/export", { params: filters, responseType: "blob" });
    return response.data as Blob;
  },
};

export const agentService = {
  list: () => unwrap<AgentSummary[]>(apiClient.get("/agents")),
  rotateKey: (id: string) => unwrap<{ id: string; name: string; apiKey: string }>(apiClient.post(`/agents/${id}/rotate-key`)),
};

export const demoService = {
  company: () => unwrap<CompanyData>(apiClient.get("/demo/company")),
  reset: () => unwrap<{ reset: boolean }>(apiClient.post("/demo/reset")),
  act: (input: { action: string; params: Record<string, unknown>; reason: string; onBehalfOf: string }) =>
    unwrap<AgentAction>(apiClient.post("/demo/playground/act", input)),
  chat: (instruction: string, onBehalfOf: string) =>
    unwrap<{ message: string; outcomes: ChatOutcome[] }>(apiClient.post("/demo/playground/chat", { instruction, onBehalfOf })),
};
