import { FilterQuery, Types } from "mongoose";
import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { AgentDoc } from "../../models/agent.model";
import { ActionStatus } from "../../constants";
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../helpers/errors";
import { logger, serializeError } from "../../utils/logger";
import { Actor, recordAuditEvent, SYSTEM_ACTOR } from "../audit/audit.service";
import { evaluatePolicies } from "../policy/policyEngine";
import { getEnabledRules } from "../policy/policy.service";
import { decideAndReserve, releaseLimitReservations, releaseUnusedReservations } from "../policy/dailyLimit.service";
import { approvalDeadline, EXPIRED_MESSAGE, expireAction, getApprovalExpiryHours } from "../approvals/approvalExpiry.service";
import { notifyApprovalRequested, notifyDecisionMade } from "../slack/slack.service";
import { DEFAULT_CURRENCY } from "../../utils/format";
import { ActionContext, getActionDefinition } from "./actionRegistry";
import { getWorkspaceCurrency, withMoneyFields } from "./money.service";

// ---------------------------------------------------------------------------
// The guard: the one entry point an agent may use to change anything.
//   1. Same idempotency key again?  -> return the first result, do nothing new
//   2. Validate params against the registered action
//   3. Look up trusted facts from the system of record
//   4. Deterministic policy check (no AI)
//   5. Record + audit, then execute now, wait for a person, or refuse
// The daily-limit check and the reservation of its room happen together in step 4, atomically.
// ---------------------------------------------------------------------------

export interface ActionRequestInput {
  action: string;
  params: unknown;
  reason?: string;
  onBehalfOf: string;
  idempotencyKey: string;
}

type AgentIdentity = Pick<AgentDoc, "_id" | "workspaceId" | "name">;

function agentActor(agent: AgentIdentity): Actor {
  return { type: "agent", id: String(agent._id), name: agent.name };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

// People see this message, so only pass on our own (safe, written-by-us) messages.
function safeErrorMessage(err: unknown): string {
  return err instanceof AppError ? err.message : "The action failed because of an unexpected error.";
}

export async function requestAction(agent: AgentIdentity, input: ActionRequestInput): Promise<ActionRecordDoc> {
  const workspaceId = agent.workspaceId as Types.ObjectId;
  const currency = await getWorkspaceCurrency(workspaceId);
  const ctx: ActionContext = { workspaceId, currency };

  // 1. Idempotency: a retried request (network blip, agent loop) must not act twice.
  const existing = await ActionRecord.findOne({
    workspaceId,
    agentId: agent._id,
    idempotencyKey: input.idempotencyKey,
  }).lean<ActionRecordDoc>();
  if (existing) {
    if (existing.action !== input.action) {
      throw new ConflictError("This idempotency key was already used for a different action.");
    }
    return existing;
  }

  // 2. Only registered actions with valid params.
  let definition;
  try {
    definition = getActionDefinition(input.action);
  } catch (err) {
    await recordAuditEvent({
      workspaceId,
      type: "action_denied",
      actor: agentActor(agent),
      onBehalfOf: input.onBehalfOf,
      summary: `Blocked an attempt to use an unregistered action ("${String(input.action).slice(0, 60)}")`,
    });
    throw err;
  }

  const parsedParams = definition.paramsSchema.safeParse(input.params);
  if (!parsedParams.success) {
    throw new BadRequestError("The action's details are not valid.", parsedParams.error.flatten());
  }
  const params = parsedParams.data;

  // 3. Facts come from our own lookup, never from the agent's claims.
  const prepared = await definition.prepare(params, ctx);

  // 4. Deterministic policy check. Daily-limit room is reserved in the same step, so two requests
  // arriving together cannot both take the last of it.
  const rules = await getEnabledRules(workspaceId);
  const context = { params, facts: prepared.facts, agentName: agent.name, onBehalfOf: input.onBehalfOf };
  const { evaluation, reservations } = await decideAndReserve({
    workspaceId,
    agentId: agent._id as Types.ObjectId,
    action: definition.key,
    rules,
    context,
    evaluate: (usageByRuleId) =>
      evaluatePolicies(rules, {
        action: definition.key,
        irreversible: definition.irreversible,
        usageByRuleId,
        money: { currency, fields: definition.moneyFields.facts.map((field) => `facts.${field}`) },
        context,
      }),
  });

  const initialStatus: ActionStatus =
    evaluation.decision === "allow" ? "executing" : evaluation.decision === "deny" ? "denied" : "pending_approval";

  // 5. Record it. A unique index on the idempotency key settles races between identical retries.
  let record;
  try {
    const expiresAt =
      evaluation.decision === "require_approval" ? approvalDeadline(await getApprovalExpiryHours(workspaceId)) : undefined;
    record = await ActionRecord.create({
      workspaceId,
      agentId: agent._id,
      agentName: agent.name,
      onBehalfOf: input.onBehalfOf,
      action: definition.key,
      params,
      facts: prepared.facts,
      summary: prepared.summary,
      reason: input.reason || "",
      decision: evaluation.decision,
      decisionReasons: evaluation.reasons,
      matchedPolicyIds: evaluation.matchedRuleIds,
      irreversible: definition.irreversible,
      status: initialStatus,
      idempotencyKey: input.idempotencyKey,
      decidedAt: evaluation.decision === "require_approval" ? undefined : new Date(),
      expiresAt,
      limitReservations: reservations,
    });
  } catch (err) {
    // No action was created, so the room held for it goes back.
    await releaseUnusedReservations(workspaceId, reservations);
    if (isDuplicateKeyError(err)) {
      const winner = await ActionRecord.findOne({
        workspaceId,
        agentId: agent._id,
        idempotencyKey: input.idempotencyKey,
      }).lean<ActionRecordDoc>();
      if (winner) return winner;
    }
    throw err;
  }

  await recordAuditEvent({
    workspaceId,
    type: "action_requested",
    actionId: record._id,
    actor: agentActor(agent),
    onBehalfOf: input.onBehalfOf,
    summary: `Asked to: ${prepared.summary}`,
  });

  if (evaluation.decision === "deny") {
    await recordAuditEvent({
      workspaceId,
      type: "action_denied",
      actionId: record._id,
      actor: SYSTEM_ACTOR,
      onBehalfOf: input.onBehalfOf,
      summary: `Refused: ${evaluation.reasons.join(" ")}`,
    });
    return record.toObject() as ActionRecordDoc;
  }

  if (evaluation.decision === "require_approval") {
    await recordAuditEvent({
      workspaceId,
      type: "approval_requested",
      actionId: record._id,
      actor: SYSTEM_ACTOR,
      onBehalfOf: input.onBehalfOf,
      summary: `Waiting for approval: ${evaluation.reasons.join(" ")}`,
    });
    const waiting = record.toObject() as ActionRecordDoc;
    // Fire-and-forget: the agent gets its answer without waiting for Slack, and a Slack failure never fails the request.
    notifyApprovalRequested(waiting);
    return waiting;
  }

  return executeAction(record._id, workspaceId, SYSTEM_ACTOR);
}

// Moves an executing action to its final state. Returns null when something else got there first
// (the recovery job, after an interruption), so a late finish never overwrites what it decided.
function settleExecution(record: Pick<ActionRecordDoc, "_id" | "workspaceId">, changes: Record<string, unknown>) {
  return ActionRecord.findOneAndUpdate(
    { _id: record._id, workspaceId: record.workspaceId, status: "executing" },
    { $set: changes },
    { new: true }
  ).lean<ActionRecordDoc>();
}

/**
 * Runs an action that is already in the "executing" state. Saves the
 * before-snapshot first, so undo always has what it needs.
 */
async function executeAction(actionId: Types.ObjectId, workspaceId: Types.ObjectId, actor: Actor) {
  const record = await ActionRecord.findOne({ _id: actionId, workspaceId, status: "executing" }).lean<ActionRecordDoc>();
  if (!record) throw new ConflictError("This action is not ready to run.");

  const definition = getActionDefinition(record.action);
  const ctx: ActionContext = { workspaceId };
  const latest = () => ActionRecord.findOne({ _id: actionId, workspaceId }).lean<ActionRecordDoc>() as Promise<ActionRecordDoc>;

  try {
    if (definition.snapshot) {
      const beforeSnapshot = await definition.snapshot(record.params, ctx);
      await ActionRecord.updateOne({ _id: record._id, workspaceId, status: "executing" }, { $set: { beforeSnapshot } });
    }
    const result = await definition.run(record.params, ctx);
    const done = await settleExecution(record, { status: "done", result, executedAt: new Date() });
    if (!done) return latest();
    await recordAuditEvent({
      workspaceId,
      type: "action_executed",
      actionId: record._id,
      actor,
      onBehalfOf: record.onBehalfOf,
      summary: `Done: ${record.summary}`,
    });
    return done;
  } catch (err) {
    logger.warn("action execution failed", { actionId: String(record._id), action: record.action, ...serializeError(err) });
    const errorMessage = safeErrorMessage(err);
    const failed = await settleExecution(record, { status: "failed", errorMessage });
    if (!failed) return latest();
    await releaseLimitReservations(failed); // a failed action no longer counts towards a daily limit
    await recordAuditEvent({
      workspaceId,
      type: "action_failed",
      actionId: record._id,
      actor,
      onBehalfOf: record.onBehalfOf,
      summary: `Failed: ${record.summary}. ${errorMessage}`,
    });
    return failed;
  }
}

// A decision that missed: say why. A request that is overdue but not yet swept is expired right here,
// so nobody can approve it in the gap between its deadline and the next sweep.
async function explainMissedDecision(workspaceId: Types.ObjectId, actionId: string) {
  const current = await ActionRecord.findOne({ _id: actionId, workspaceId }).select("_id workspaceId status").lean();
  if (!current) return new NotFoundError("That action was not found.");
  const expired = current.status === "expired" || (current.status === "pending_approval" && Boolean(await expireAction(current)));
  return new ConflictError(expired ? EXPIRED_MESSAGE : "This action was already approved or rejected.");
}

// A request can be decided only while it waits and its deadline has not passed (requests from before expiry existed have none).
const STILL_WAITING = (now: Date) => ({ status: "pending_approval", $or: [{ expiresAt: { $gt: now } }, { expiresAt: null }] });

export async function approveAction(workspaceId: Types.ObjectId, actionId: string, approver: Actor & { email: string }) {
  const pending = await ActionRecord.findOne({ _id: actionId, workspaceId }).lean<ActionRecordDoc>();
  if (!pending) throw new NotFoundError("That action was not found.");
  // Separation of duties: nobody approves work requested on their own behalf.
  if (pending.onBehalfOf.toLowerCase() === approver.email.toLowerCase()) {
    throw new ForbiddenError("You cannot approve an action that was requested on your behalf. Ask another manager.");
  }

  // Atomic state change: if two managers click Approve together, only one wins.
  const record = await ActionRecord.findOneAndUpdate(
    { _id: actionId, workspaceId, ...STILL_WAITING(new Date()) },
    { $set: { status: "executing", approvedBy: approver.name, decidedAt: new Date() }, $unset: { expiresAt: 1 } },
    { new: true }
  );
  if (!record) throw await explainMissedDecision(workspaceId, actionId);

  await recordAuditEvent({
    workspaceId,
    type: "action_approved",
    actionId: record._id,
    actor: approver,
    onBehalfOf: record.onBehalfOf,
    summary: `Approved: ${record.summary}`,
  });
  const executed = await executeAction(record._id, workspaceId, approver);
  notifyDecisionMade(executed); // keeps the Slack message in step when the web app made the decision
  return executed;
}

export async function rejectAction(workspaceId: Types.ObjectId, actionId: string, approver: Actor, note = "") {
  const record = await ActionRecord.findOneAndUpdate(
    { _id: actionId, workspaceId, ...STILL_WAITING(new Date()) },
    { $set: { status: "rejected", rejectedBy: approver.name, decidedAt: new Date() }, $unset: { expiresAt: 1 } },
    { new: true }
  );
  if (!record) throw await explainMissedDecision(workspaceId, actionId);
  await releaseLimitReservations(record); // a rejected request no longer counts towards a daily limit
  await recordAuditEvent({
    workspaceId,
    type: "action_rejected",
    actionId: record._id,
    actor: approver,
    onBehalfOf: record.onBehalfOf,
    summary: `Rejected: ${record.summary}${note ? ` — note: ${note}` : ""}`,
  });
  const rejected = record.toObject() as ActionRecordDoc;
  notifyDecisionMade(rejected);
  return rejected;
}

export async function undoAction(workspaceId: Types.ObjectId, actionId: string, user: Actor) {
  const current = await ActionRecord.findOne({ _id: actionId, workspaceId }).lean<ActionRecordDoc>();
  if (!current) throw new NotFoundError("That action was not found.");

  const definition = getActionDefinition(current.action);
  if (!definition.undo) throw new ConflictError("This action is permanent and cannot be undone.");

  // Only one request can move "done" -> "undoing"; a double-click finds nothing to update.
  const record = await ActionRecord.findOneAndUpdate(
    { _id: actionId, workspaceId, status: "done" },
    { $set: { status: "undoing" } },
    { new: true }
  );
  if (!record) throw new ConflictError("This action cannot be undone right now (it may already be undone).");

  try {
    await definition.undo(record.beforeSnapshot, { workspaceId });
    const undone = await ActionRecord.findOneAndUpdate(
      { _id: record._id, workspaceId, status: "undoing" },
      { $set: { status: "undone", undoneBy: user.name, undoneAt: new Date() } },
      { new: true }
    ).lean<ActionRecordDoc>();
    // Only the recovery job moves an undo out of "undoing" (after a long interruption); it has then put the action back to "done".
    if (!undone) throw new ConflictError("This undo took too long and was marked as interrupted. Please check the booking.");
    await releaseLimitReservations(undone); // an undone action no longer counts towards a daily limit
    await recordAuditEvent({
      workspaceId,
      type: "action_undone",
      actionId: record._id,
      actor: user,
      onBehalfOf: record.onBehalfOf,
      summary: `Undid: ${record.summary}`,
    });
    return undone;
  } catch (err) {
    // Put it back to "done" so a person can look and try again.
    await ActionRecord.updateOne({ _id: record._id, workspaceId, status: "undoing" }, { $set: { status: "done" } });
    await recordAuditEvent({
      workspaceId,
      type: "undo_failed",
      actionId: record._id,
      actor: user,
      onBehalfOf: record.onBehalfOf,
      summary: `Could not undo: ${record.summary}. ${safeErrorMessage(err)}`,
    });
    throw err instanceof AppError ? err : new ConflictError(safeErrorMessage(err));
  }
}

// ---------- reads ----------

export interface ActionListFilters {
  status?: ActionStatus;
  action?: string;
  limit?: number;
}

export async function listActions(workspaceId: Types.ObjectId, filters: ActionListFilters = {}) {
  const query: FilterQuery<ActionRecordDoc> = { workspaceId };
  if (filters.status) query.status = filters.status;
  if (filters.action) query.action = filters.action;
  return ActionRecord.find(query)
    .sort({ createdAt: -1, _id: -1 })
    .limit(Math.min(filters.limit || 100, 500))
    .lean<ActionRecordDoc[]>();
}

export async function getAction(workspaceId: Types.ObjectId, actionId: string) {
  const record = await ActionRecord.findOne({ _id: actionId, workspaceId }).lean<ActionRecordDoc>();
  if (!record) throw new NotFoundError("That action was not found.");
  return record;
}

export async function countPendingApprovals(workspaceId: Types.ObjectId) {
  return ActionRecord.countDocuments({ workspaceId, status: "pending_approval" });
}

// What people and agents get back. The before-snapshot stays server-side.
export function toActionDto(record: ActionRecordDoc) {
  const definition = (() => {
    try {
      return getActionDefinition(record.action);
    } catch {
      return null;
    }
  })();
  return {
    id: String(record._id),
    action: record.action,
    actionLabel: definition?.label || record.action,
    agentName: record.agentName,
    onBehalfOf: record.onBehalfOf,
    summary: record.summary,
    reason: record.reason,
    params: record.params,
    facts: record.facts,
    decision: record.decision,
    decisionReasons: record.decisionReasons,
    irreversible: record.irreversible,
    status: record.status,
    canUndo: record.status === "done" && Boolean(definition?.undo),
    result: record.result,
    errorMessage: record.errorMessage,
    approvedBy: record.approvedBy,
    rejectedBy: record.rejectedBy,
    undoneBy: record.undoneBy,
    createdAt: record.createdAt,
    expiresAt: record.status === "pending_approval" ? record.expiresAt : undefined,
    decidedAt: record.decidedAt,
    executedAt: record.executedAt,
    undoneAt: record.undoneAt,
  };
}

// Short reply for agents: what happened and what to do next.
// Every amount comes with its currency and a formatted string (see money.service), so an
// agent never has to guess whether "3900" means rupees, dollars or cents. These are added
// next to the existing fields; nothing was renamed or removed.
export function toAgentResponse(record: ActionRecordDoc, currency = DEFAULT_CURRENCY) {
  const messages: Record<string, string> = {
    done: "Done.",
    pending_approval: "Waiting for a person to approve. Check again later with GET /api/agent/actions/:id.",
    denied: "Not allowed. Do not retry this action; tell the person why.",
    rejected: "A person rejected this action.",
    expired: "Nobody approved this request in time, so it expired and nothing was done. Ask again if it is still needed.",
    failed: `The action failed: ${record.errorMessage}`,
    undone: "This action was undone by a person.",
    executing: "Running.",
    undoing: "Being undone.",
  };
  const moneyFields = (() => {
    try {
      return getActionDefinition(record.action).moneyFields;
    } catch {
      return { facts: [], result: [] };
    }
  })();
  return {
    actionId: String(record._id),
    status: record.status,
    decision: record.decision,
    message: messages[record.status] || record.status,
    reasons: record.decisionReasons,
    // Only while a person still has to decide: when to give up waiting.
    ...(record.status === "pending_approval" && record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    result: record.status === "done" ? withMoneyFields(record.result, moneyFields.result, currency) : null,
    facts: withMoneyFields(record.facts, moneyFields.facts, currency),
    currency,
  };
}

// What both agent doors (REST and MCP) send back: the reply above, in the workspace's own currency.
export async function describeForAgent(record: ActionRecordDoc) {
  return toAgentResponse(record, await getWorkspaceCurrency(record.workspaceId as Types.ObjectId));
}
