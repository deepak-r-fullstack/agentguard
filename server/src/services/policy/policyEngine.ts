import { ConditionOperator, Decision, DEFAULT_DECISION, LimitScope } from "../../constants";

// ---------------------------------------------------------------------------
// The policy engine. Pure functions only: no database, no network, no AI.
// Given the rules and the facts about one action, it always returns the same
// decision. That is what makes it fast, testable and impossible to "talk into"
// saying yes.
// ---------------------------------------------------------------------------

export interface PolicyCondition {
  field: string;
  op: ConditionOperator;
  value: unknown;
}

export interface PolicyDailyLimit {
  scope: LimitScope;
  sumField: string;
  max: number;
}

export interface PolicyRule {
  id: string;
  name: string;
  action: string; // action key or "*"
  effect: Decision;
  conditions: PolicyCondition[];
  dailyLimit?: PolicyDailyLimit | null;
  enabled: boolean;
}

export interface EvaluationInput {
  action: string;
  // Everything a rule may read: { params, facts, agentId, onBehalfOf }.
  context: Record<string, unknown>;
  irreversible: boolean;
  // Total already used today for each rule that has a daily limit (rule id -> sum).
  usageByRuleId?: Record<string, number>;
}

export interface EvaluationResult {
  decision: Decision;
  matchedRuleIds: string[];
  reasons: string[];
}

// Higher number = stricter. The strictest matched rule wins.
const STRICTNESS: Record<Decision, number> = { allow: 0, require_approval: 1, deny: 2 };

// Indian digit grouping (1,20,000) to match how the amounts are shown everywhere else.
function formatNumber(value: number): string {
  return value.toLocaleString("en-IN");
}

export function getValueAtPath(source: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, source);
}

export function evaluateCondition(condition: PolicyCondition, context: Record<string, unknown>): boolean {
  const actual = getValueAtPath(context, condition.field);
  const expected = condition.value;

  // A missing field never satisfies a condition. Rules are written about facts
  // we know; guessing would make "deny" rules silently skip.
  if (actual === undefined || actual === null) return false;

  switch (condition.op) {
    case "eq":
      return actual === expected;
    case "neq":
      return actual !== expected;
    case "gt":
    case "gte":
    case "lt":
    case "lte": {
      if (typeof actual !== "number" || typeof expected !== "number") return false;
      if (condition.op === "gt") return actual > expected;
      if (condition.op === "gte") return actual >= expected;
      if (condition.op === "lt") return actual < expected;
      return actual <= expected;
    }
    case "in":
      return Array.isArray(expected) && expected.includes(actual);
    case "nin":
      return Array.isArray(expected) && !expected.includes(actual);
    default:
      return false;
  }
}

export function ruleAppliesToAction(rule: PolicyRule, action: string): boolean {
  return rule.enabled && (rule.action === action || rule.action === "*");
}

/**
 * Checks a daily limit. Returns the amounts so the reason shown to people can
 * say exactly why. If the amount cannot be read, the limit counts as exceeded
 * (fail closed): an action we cannot measure should not slip past a limit.
 */
export function checkDailyLimit(
  limit: PolicyDailyLimit,
  context: Record<string, unknown>,
  alreadyUsed: number
): { exceeded: boolean; thisAmount: number | null; projectedTotal: number | null } {
  const raw = getValueAtPath(context, limit.sumField);
  if (typeof raw !== "number" || Number.isNaN(raw)) {
    return { exceeded: true, thisAmount: null, projectedTotal: null };
  }
  const projectedTotal = alreadyUsed + raw;
  return { exceeded: projectedTotal > limit.max, thisAmount: raw, projectedTotal };
}

export function evaluatePolicies(rules: PolicyRule[], input: EvaluationInput): EvaluationResult {
  const usage = input.usageByRuleId || {};
  const matched: { rule: PolicyRule; reason: string }[] = [];

  for (const rule of rules) {
    if (!ruleAppliesToAction(rule, input.action)) continue;

    const conditionsMet = rule.conditions.every((condition) => evaluateCondition(condition, input.context));
    if (!conditionsMet) continue;

    if (rule.dailyLimit) {
      const { exceeded, projectedTotal } = checkDailyLimit(rule.dailyLimit, input.context, usage[rule.id] || 0);
      if (!exceeded) continue;
      const detail =
        projectedTotal === null
          ? "the amount could not be measured"
          : `today's total would reach ${formatNumber(projectedTotal)}, over the limit of ${formatNumber(rule.dailyLimit.max)}`;
      matched.push({ rule, reason: `Rule "${rule.name}": ${detail}.` });
      continue;
    }

    matched.push({ rule, reason: `Rule "${rule.name}" applies.` });
  }

  let decision: Decision;
  const reasons: string[] = [];

  if (matched.length === 0) {
    decision = DEFAULT_DECISION;
    reasons.push("No rule covers this action, so a person must approve it.");
  } else {
    decision = matched.reduce<Decision>(
      (strictest, { rule }) => (STRICTNESS[rule.effect] > STRICTNESS[strictest] ? rule.effect : strictest),
      "allow"
    );
    // Only explain the rules that produced the final decision.
    matched.filter(({ rule }) => rule.effect === decision).forEach(({ reason }) => reasons.push(reason));
  }

  // Irreversible actions always reach a person (unless a rule already refuses them).
  if (input.irreversible && decision !== "deny") {
    decision = "require_approval";
    reasons.push("This action cannot be undone, so a person must approve it.");
  }

  return {
    decision,
    matchedRuleIds: matched.filter(({ rule }) => rule.effect === decision).map(({ rule }) => rule.id),
    reasons,
  };
}
