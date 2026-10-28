import { ActionStatus, ConditionOperator, Decision, PolicyCondition, PolicyDailyLimit, RuleField } from "utils/types";

export function formatMoney(amount: number) {
  return new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(amount);
}

export function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(new Date(value));
}

export function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("en-IN", {
    day: "numeric",
    month: "short",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

export function timeAgo(value: string) {
  const seconds = Math.round((Date.now() - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  return formatDateTime(value);
}

// "in 3 hr", "in 20 min": how long until a waiting request expires.
export function timeUntil(value: string) {
  const minutes = Math.round((new Date(value).getTime() - Date.now()) / 60000);
  if (minutes < 1) return "any moment now";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours} hr`;
  return `in ${Math.round(hours / 24)} days`;
}

// Words people see for each status. Kept in one place so every screen says the same thing.
export const STATUS_META: Record<ActionStatus, { label: string; tone: "done" | "waiting" | "refused" | "undone" | "neutral" }> = {
  pending_approval: { label: "Waiting for you", tone: "waiting" },
  executing: { label: "Running", tone: "neutral" },
  done: { label: "Done", tone: "done" },
  denied: { label: "Blocked by a rule", tone: "refused" },
  rejected: { label: "Rejected", tone: "refused" },
  expired: { label: "Expired", tone: "neutral" },
  failed: { label: "Failed", tone: "refused" },
  undoing: { label: "Undoing", tone: "neutral" },
  undone: { label: "Undone", tone: "undone" },
};

export const EFFECT_LABEL: Record<Decision, string> = {
  allow: "Agent can do it alone",
  require_approval: "Needs a person's approval",
  deny: "Never allowed",
};

export const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  eq: "is",
  neq: "is not",
  gt: "is more than",
  gte: "is at least",
  lt: "is less than",
  lte: "is at most",
  in: "is one of",
  nin: "is not one of",
};

function fieldLabel(path: string, fields: RuleField[]) {
  return fields.find((field) => field.path === path)?.label || path;
}

function valueText(value: PolicyCondition["value"], path: string) {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "number" && /amount/i.test(path)) return formatMoney(value);
  if (typeof value === "number" && /percent/i.test(path)) return `${value}%`;
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

// "Refund amount (₹) is more than ₹5,000" — a rule read back as a sentence.
export function describeCondition(condition: PolicyCondition, fields: RuleField[]) {
  return `${fieldLabel(condition.field, fields)} ${OPERATOR_LABEL[condition.op]} ${valueText(condition.value, condition.field)}`;
}

export function describeDailyLimit(limit: PolicyDailyLimit, fields: RuleField[]) {
  const who = limit.scope === "agent" ? "for each agent" : "for the whole company";
  const max = /amount/i.test(limit.sumField) ? formatMoney(limit.max) : String(limit.max);
  return `Today's total of ${fieldLabel(limit.sumField, fields).toLowerCase()} would go over ${max} ${who}`;
}
