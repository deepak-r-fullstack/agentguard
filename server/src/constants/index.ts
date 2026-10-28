// Shared constant lists. Kept as `as const` tuples so the same list drives
// TypeScript types, Mongoose enums and zod validation.

export const USER_ROLES = ["admin", "manager", "auditor"] as const;
export type UserRole = (typeof USER_ROLES)[number];

// What the policy engine decides for one requested action.
export const DECISIONS = ["allow", "require_approval", "deny"] as const;
export type Decision = (typeof DECISIONS)[number];

// Lifecycle of one agent action.
//   pending_approval -> executing -> done -> undoing -> undone
//                    -> rejected       \-> failed
//   denied (never executed)
export const ACTION_STATUSES = [
  "pending_approval",
  "denied",
  "rejected",
  "executing",
  "done",
  "failed",
  "undoing",
  "undone",
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

// Statuses that count towards daily limits. A pending request counts too,
// otherwise an agent could queue many requests before any is approved.
export const STATUSES_COUNTING_TOWARDS_LIMITS: ActionStatus[] = [
  "pending_approval",
  "executing",
  "done",
  "undoing",
];

export const CONDITION_OPERATORS = ["eq", "neq", "gt", "gte", "lt", "lte", "in", "nin"] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const LIMIT_SCOPES = ["agent", "workspace"] as const;
export type LimitScope = (typeof LIMIT_SCOPES)[number];

export const AUDIT_EVENT_TYPES = [
  "action_requested",
  "action_denied",
  "approval_requested",
  "action_approved",
  "action_rejected",
  "action_executed",
  "action_failed",
  "action_undone",
  "undo_failed",
  "policy_created",
  "policy_updated",
  "policy_deleted",
  "integration_updated",
  "demo_reset",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const ACTOR_TYPES = ["agent", "user", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// When no rule matches an action, the safe default is to ask a human.
export const DEFAULT_DECISION: Decision = "require_approval";
