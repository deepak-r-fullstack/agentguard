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
//                    -> expired (nobody decided in time)
//   denied (never executed)
export const ACTION_STATUSES = [
  "pending_approval",
  "denied",
  "rejected",
  "expired",
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
  "action_expired",
  "undo_failed",
  "policy_created",
  "policy_updated",
  "policy_deleted",
  "integration_updated",
  "settings_updated",
  "user_added",
  "user_role_changed",
  "user_deactivated",
  "user_reactivated",
  "demo_reset",
  "chain_started",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const ACTOR_TYPES = ["agent", "user", "system"] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

// When no rule matches an action, the safe default is to ask a human.
export const DEFAULT_DECISION: Decision = "require_approval";

// Changes to who can sign in. "Reset demo data" keeps these entries, so the record of
// who was added or switched off never disappears.
export const TEAM_AUDIT_EVENT_TYPES: AuditEventType[] = ["user_added", "user_role_changed", "user_deactivated", "user_reactivated"];

// Approvals that nobody decides expire after this many hours, unless an admin chose another number.
export const DEFAULT_APPROVAL_EXPIRY_HOURS = 24;
export const MIN_APPROVAL_EXPIRY_HOURS = 1;
export const MAX_APPROVAL_EXPIRY_HOURS = 24 * 30;

// An action stuck in "executing" or "undoing" for longer than this was interrupted (a crash, a restart).
export const INTERRUPTED_ACTION_TIMEOUT_MS = 10 * 60 * 1000;
