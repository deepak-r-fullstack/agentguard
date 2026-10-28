// Shapes returned by the AgentGuard API (see server controllers).

export type UserRole = "admin" | "manager" | "auditor";
export type Decision = "allow" | "require_approval" | "deny";
export type ActionStatus =
  | "pending_approval"
  | "denied"
  | "rejected"
  | "executing"
  | "done"
  | "failed"
  | "undoing"
  | "undone";

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  workspaceId: string;
  workspaceName: string;
}

export interface ApiEnvelope<T> {
  success: boolean;
  message: string;
  data: T;
}

export interface TimelineEvent {
  id: string;
  type: string;
  actor: { type: "agent" | "user" | "system"; id: string; name: string };
  summary: string;
  createdAt: string;
}

export interface AgentAction {
  id: string;
  action: string;
  actionLabel: string;
  agentName: string;
  onBehalfOf: string;
  summary: string;
  reason: string;
  params: Record<string, unknown>;
  facts: Record<string, unknown>;
  decision: Decision;
  decisionReasons: string[];
  irreversible: boolean;
  status: ActionStatus;
  canUndo: boolean;
  result: Record<string, unknown> | null;
  errorMessage: string;
  approvedBy: string;
  rejectedBy: string;
  undoneBy: string;
  createdAt: string;
  decidedAt?: string;
  executedAt?: string;
  undoneAt?: string;
  timeline?: TimelineEvent[];
}

export type ConditionOperator = "eq" | "neq" | "gt" | "gte" | "lt" | "lte" | "in" | "nin";

export interface PolicyCondition {
  field: string;
  op: ConditionOperator;
  value: number | string | boolean | (number | string)[];
}

export interface PolicyDailyLimit {
  scope: "agent" | "workspace";
  sumField: string;
  max: number;
}

export interface Policy {
  id: string;
  name: string;
  action: string;
  effect: Decision;
  conditions: PolicyCondition[];
  dailyLimit: PolicyDailyLimit | null;
  enabled: boolean;
  sourceText: string;
  createdAt: string;
}

export type PolicyInput = Omit<Policy, "id" | "createdAt">;

export interface RuleField {
  path: string;
  label: string;
  type: "number" | "string" | "boolean";
}

export interface CatalogAction {
  key: string;
  label: string;
  description: string;
  irreversible: boolean;
  canUndo: boolean;
  ruleFields: RuleField[];
  exampleParams: Record<string, unknown>;
}

export interface Catalog {
  actions: CatalogAction[];
  ai: { provider: string; model: string; configured: boolean };
}

export interface RuleDraft {
  draft: PolicyInput;
  explanation: string;
  valid: boolean;
  issues: string[];
}

export interface AuditEvent {
  id: string;
  type: string;
  actionId: string | null;
  actor: { type: "agent" | "user" | "system"; id: string; name: string };
  onBehalfOf: string;
  summary: string;
  createdAt: string;
}

export interface CompanyData {
  customers: { code: string; name: string; email: string }[];
  bookings: {
    code: string;
    title: string;
    customerName: string;
    customerCode: string;
    startsAt: string;
    amount: number;
    status: "confirmed" | "cancelled";
    refundAmount: number;
    discountPercent: number;
    updatedAt: string;
  }[];
  outbox: { id: string; customerName: string; subject: string; sentAt: string }[];
}

export interface AgentSummary {
  id: string;
  name: string;
  description: string;
  apiKeyPreview: string;
  active: boolean;
}

export interface TeamMember {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
}

export interface AddedTeamMember {
  member: TeamMember;
  temporaryPassword: string;
}

export interface Connections {
  slack: { configured: boolean; channelId: string };
}

export interface ChatOutcome {
  planned: { action: string; params: Record<string, unknown>; reason: string };
  outcome: AgentAction | null;
  error: string | null;
}
