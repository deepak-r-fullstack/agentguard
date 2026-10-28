import { Types } from "mongoose";
import { UsageCounter } from "../../models/usageCounter.model";
import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { STATUSES_COUNTING_TOWARDS_LIMITS } from "../../constants";
import { ConflictError } from "../../helpers/errors";
import { checkDailyLimit, evaluateCondition, EvaluationResult, getValueAtPath, PolicyRule } from "./policyEngine";

// ---------------------------------------------------------------------------
// Daily limits that cannot be raced. The old way was "add up today's actions, then decide",
// so two requests arriving together both saw room and both went through. Now every limit has
// a counter per company + rule + agent + UTC day, and a request takes its room from it with ONE
// conditional update ("add my amount, but only if it still fits"). MongoDB runs that update one
// request at a time, so the total can never go over the limit.
//
// The room is given back (releaseLimitReservations) when the action is denied, rejected,
// fails, expires or is undone. Pending requests keep their room: they count, as before.
// The policy engine stays pure: it still just compares numbers it is given.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
// Counters stay a little past their day (a waiting request can give room back later), then MongoDB removes them.
const COUNTER_KEEP_MS = 3 * DAY_MS;

export interface LimitReservation {
  ruleId: Types.ObjectId;
  action: string;
  agentId: Types.ObjectId | null;
  field: string;
  day: string;
  amount: number;
}

// Which counter: the company comes separately, so the same key also describes a reservation.
type CounterKey = Omit<LimitReservation, "amount">;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

export function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function limitRulesFor(rules: PolicyRule[], action: string): PolicyRule[] {
  return rules.filter((rule) => rule.enabled && rule.dailyLimit && rule.action === action);
}

function counterKeyFor(rule: PolicyRule, agentId: Types.ObjectId, day: string): CounterKey {
  const limit = rule.dailyLimit!;
  return {
    ruleId: new Types.ObjectId(rule.id),
    action: rule.action,
    agentId: limit.scope === "agent" ? agentId : null,
    field: limit.sumField,
    day,
  };
}

// What this action adds to the rule's total. An amount we cannot read adds nothing (the engine already fails closed on it).
function amountFor(rule: PolicyRule, context: Record<string, unknown>): number {
  const raw = getValueAtPath(context, rule.dailyLimit!.sumField);
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

/**
 * Creates today's counter if it is missing. It starts from what today's actions already add up to,
 * so a rule created (or a server updated) in the middle of the day does not start from zero.
 */
async function ensureCounter(workspaceId: Types.ObjectId, key: CounterKey) {
  if (await UsageCounter.exists({ workspaceId, ...key })) return;
  // sumField is validated as "facts.<name>" (see policySchemas), so it is safe to use as a field path.
  const [used] = await ActionRecord.aggregate<{ total: number }>([
    {
      $match: {
        workspaceId,
        action: key.action,
        status: { $in: STATUSES_COUNTING_TOWARDS_LIMITS },
        createdAt: { $gte: new Date(`${key.day}T00:00:00.000Z`) },
        ...(key.agentId ? { agentId: key.agentId } : {}),
      },
    },
    { $group: { _id: null, total: { $sum: `$${key.field}` } } },
  ]);
  try {
    await UsageCounter.updateOne(
      { workspaceId, ...key },
      { $setOnInsert: { total: used?.total || 0, expiresAt: new Date(new Date(`${key.day}T00:00:00.000Z`).getTime() + COUNTER_KEEP_MS) } },
      { upsert: true }
    );
  } catch (err) {
    // Another request created it at the same moment. Its counter is as good as ours.
    if (!isDuplicateKeyError(err)) throw err;
  }
}

/** Today's total for each rule with a daily limit on this action. */
async function readUsage(workspaceId: Types.ObjectId, limitRules: PolicyRule[], agentId: Types.ObjectId, day: string) {
  const usage: Record<string, number> = {};
  for (const rule of limitRules) {
    const key = counterKeyFor(rule, agentId, day);
    await ensureCounter(workspaceId, key);
    const counter = await UsageCounter.findOne({ workspaceId, ...key }).select("total").lean();
    usage[rule.id] = counter?.total || 0;
  }
  return usage;
}

/** Gives room back to the counters it came from. Never takes a total below zero. */
async function giveBack(workspaceId: Types.ObjectId, reservations: LimitReservation[]) {
  for (const { amount, ...rest } of reservations) {
    await UsageCounter.updateOne({ workspaceId, ...rest, total: { $gte: amount } }, { $inc: { total: -amount } });
  }
}

type ReserveOutcome = { ok: true; reservations: LimitReservation[] } | { ok: false; exceeded: Record<string, number> };

/**
 * Takes room for this action from every limit it counts towards.
 *  - A limit this action is checked against and still fits: the room is taken only if it still fits
 *    right now (the conditional update). If it no longer does, everything taken so far is given back.
 *  - Any other limit (this action is not covered by the rule's conditions, or the rule is already
 *    over and a person will decide): the room is simply added, because the action counts either way.
 */
async function reserve(
  workspaceId: Types.ObjectId,
  limitRules: PolicyRule[],
  agentId: Types.ObjectId,
  day: string,
  context: Record<string, unknown>,
  usage: Record<string, number>
): Promise<ReserveOutcome> {
  const taken: LimitReservation[] = [];
  for (const rule of limitRules) {
    const limit = rule.dailyLimit!;
    const amount = amountFor(rule, context);
    if (amount === 0) continue;

    const counterKey = counterKeyFor(rule, agentId, day);
    const key = { workspaceId, ...counterKey };
    const checked = rule.conditions.every((condition) => evaluateCondition(condition, context)) && !checkDailyLimit(limit, context, usage[rule.id] || 0).exceeded;

    if (checked) {
      const updated = await UsageCounter.findOneAndUpdate({ ...key, total: { $lte: limit.max - amount } }, { $inc: { total: amount } }).lean();
      if (!updated) {
        await giveBack(workspaceId, taken);
        const current = await UsageCounter.findOne(key).select("total").lean();
        // Whatever the counter says now, report it as over: it was over at the moment of the check.
        return { ok: false, exceeded: { [rule.id]: Math.max(current?.total || 0, limit.max - amount + 1) } };
      }
    } else {
      await UsageCounter.updateOne(key, { $inc: { total: amount } });
    }
    taken.push({ ...counterKey, amount });
  }
  return { ok: true, reservations: taken };
}

/**
 * Decides one request and, in the same step, holds its room under the daily limits.
 * `evaluate` is the policy engine, given today's totals. If another request takes the room between
 * our reading and our reservation, the decision is made again with the fresh totals, so the answer
 * always matches what was actually reserved.
 */
export async function decideAndReserve(args: {
  workspaceId: Types.ObjectId;
  agentId: Types.ObjectId;
  action: string;
  rules: PolicyRule[];
  context: Record<string, unknown>;
  now?: Date;
  evaluate: (usageByRuleId: Record<string, number>) => EvaluationResult;
}): Promise<{ evaluation: EvaluationResult; reservations: LimitReservation[] }> {
  const { workspaceId, agentId, context } = args;
  const limitRules = limitRulesFor(args.rules, args.action);
  if (limitRules.length === 0) return { evaluation: args.evaluate({}), reservations: [] };

  const day = utcDay(args.now || new Date());
  const forced: Record<string, number> = {};
  // Each lost race turns one more limit into "over", so this ends after at most one round per limit.
  for (let round = 0; round <= limitRules.length; round++) {
    const usage = { ...(await readUsage(workspaceId, limitRules, agentId, day)), ...forced };
    const evaluation = args.evaluate(usage);
    if (evaluation.decision === "deny") return { evaluation, reservations: [] }; // a refused action holds nothing
    const outcome = await reserve(workspaceId, limitRules, agentId, day, context, usage);
    if (outcome.ok) return { evaluation, reservations: outcome.reservations };
    Object.assign(forced, outcome.exceeded);
  }
  throw new ConflictError("Too many requests are arriving at once. Please try again in a moment.");
}

/** Gives back the room an action was holding, once: whoever empties the list is the only one who returns it. */
export async function releaseLimitReservations(record: Pick<ActionRecordDoc, "_id" | "workspaceId">) {
  const claimed = await ActionRecord.findOneAndUpdate(
    { _id: record._id, workspaceId: record.workspaceId },
    { $set: { limitReservations: [] } },
    { new: false, timestamps: false }
  ).lean<ActionRecordDoc>();
  // The list as it was just before we emptied it. A second caller finds it already empty and gives back nothing.
  if (claimed) await giveBack(claimed.workspaceId as Types.ObjectId, claimed.limitReservations as LimitReservation[]);
}

/** For a request that reserved room but never became an action (for example, it lost an idempotency race). */
export async function releaseUnusedReservations(workspaceId: Types.ObjectId, reservations: LimitReservation[]) {
  await giveBack(workspaceId, reservations);
}
