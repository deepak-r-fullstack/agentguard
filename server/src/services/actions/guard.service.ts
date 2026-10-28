import { FilterQuery, Types } from "mongoose";
import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { AgentDoc } from "../../models/agent.model";
import { ActionStatus } from "../../constants";
import { AppError, BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "../../helpers/errors";
import { logger, serializeError } from "../../utils/logger";
import { Actor, recordAuditEvent, SYSTEM_ACTOR } from "../audit/audit.service";
import { evaluatePolicies } from "../policy/policyEngine";
import { getEnabledRules, getUsageByRuleId } from "../policy/policy.service";
import { ActionContext, getActionDefinition } from "./actionRegistry";

// ---------------------------------------------------------------------------
// The guard: the one entry point an agent may use to change anything.
//   1. Same idempotency key again?  -> return the first result, do nothing new
//   2. Validate params against the registered action
//   3. Look up trusted facts from the system of record
//   4. Deterministic policy check (no AI)
//   5. Record + audit, then execute now, wait for a person, or refuse
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
  const ctx: ActionContext = { workspaceId };

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

  // 4. Deterministic policy check.
  const rules = await getEnabledRules(workspaceId);
  const usageByRuleId = await getUsageByRuleId(workspaceId, rules, agent._id as Types.ObjectId);
  const evaluation = evaluatePolicies(rules, {
    action: definition.key,
    irreversible: definition.irreversible,
    usageByRuleId,
    context: {
      params,
      facts: prepared.facts,
      agentName: agent.name,
      onBehalfOf: input.onBehalfOf,
    },
  });

  const initialStatus: ActionStatus =
    evaluation.decision === "allow" ? "executing" : evaluation.decision === "deny" ? "denied" : "pending_approval";

  // 5. Record it. A unique index on the idempotency key settles races between identical retries.
  let record;
  try {
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
    });
  } catch (err) {
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
    return record.toObject() as ActionRecordDoc;
  }

  return executeAction(record._id, workspaceId, SYSTEM_ACTOR);
}

/**
 * Runs an action that is already in the "executing" state. Saves the
 * before-snapshot first, so undo always has what it needs.
 */
async function executeAction(actionId: Types.ObjectId, workspaceId: Types.ObjectId, actor: Actor) {
  const record = await ActionRecord.findOne({ _id: actionId, workspaceId, status: "executing" });
  if (!record) throw new ConflictError("This action is not ready to run.");

  const definition = getActionDefinition(record.action);
  const ctx: ActionContext = { workspaceId };

  try {
    if (definition.snapshot) {
      record.beforeSnapshot = await definition.snapshot(record.params, ctx);
      await record.save();
    }
    const result = await definition.run(record.params, ctx);
    record.set({ status: "done", result, executedAt: new Date() });
    await record.save();
    await recordAuditEvent({
      workspaceId,
      type: "action_executed",
      actionId: record._id,
      actor,
      onBehalfOf: record.onBehalfOf,
      summary: `Done: ${record.summary}`,
    });
  } catch (err) {
    logger.warn("action execution failed", { actionId: String(record._id), action: record.action, ...serializeError(err) });
    record.set({ status: "failed", errorMessage: safeErrorMessage(err) });
    await record.save();
    await recordAuditEvent({
      workspaceId,
      type: "action_failed",
      actionId: record._id,
      actor,
      onBehalfOf: record.onBehalfOf,
      summary: `Failed: ${record.summary}. ${record.errorMessage}`,
    });
  }
  return record.toObject() as ActionRecordDoc;
}

export async function approveAction(workspaceId: Types.ObjectId, actionId: string, approver: Actor & { email: string }) {
  const pending = await ActionRecord.findOne({ _id: actionId, workspaceId }).lean<ActionRecordDoc>();
  if (!pending) throw new NotFoundError("That action was not found.");
  // Separation of duties: nobody approves work requested on their own behalf.
  if (pending.onBehalfOf.toLowerCase() === approver.email.toLowerCase()) {
    throw new ForbiddenError("You cannot approve an action that was requested on your behalf. Ask another manager.");
  }

  // Atomic state change: if two managers click Approve together, only one wins.
  const record = await ActionRecord.findOneAndUpdate(
    { _id: actionId, workspaceId, status: "pending_approval" },
    { $set: { status: "executing", approvedBy: approver.name, decidedAt: new Date() } },
    { new: true }
  );
  if (!record) throw new ConflictError("This action was already approved or rejected.");

  await recordAuditEvent({
    workspaceId,
    type: "action_approved",
    actionId: record._id,
    actor: approver,
    onBehalfOf: record.onBehalfOf,
    summary: `Approved: ${record.summary}`,
  });
  return executeAction(record._id, workspaceId, approver);
}

export async function rejectAction(workspaceId: Types.ObjectId, actionId: string, approver: Actor, note = "") {
  const record = await ActionRecord.findOneAndUpdate(
    { _id: actionId, workspaceId, status: "pending_approval" },
    { $set: { status: "rejected", rejectedBy: approver.name, decidedAt: new Date() } },
    { new: true }
  );
  if (!record) {
    const exists = await ActionRecord.exists({ _id: actionId, workspaceId });
    if (!exists) throw new NotFoundError("That action was not found.");
    throw new ConflictError("This action was already approved or rejected.");
  }
  await recordAuditEvent({
    workspaceId,
    type: "action_rejected",
    actionId: record._id,
    actor: approver,
    onBehalfOf: record.onBehalfOf,
    summary: `Rejected: ${record.summary}${note ? ` — note: ${note}` : ""}`,
  });
  return record.toObject() as ActionRecordDoc;
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
    record.set({ status: "undone", undoneBy: user.name, undoneAt: new Date() });
    await record.save();
    await recordAuditEvent({
      workspaceId,
      type: "action_undone",
      actionId: record._id,
      actor: user,
      onBehalfOf: record.onBehalfOf,
      summary: `Undid: ${record.summary}`,
    });
    return record.toObject() as ActionRecordDoc;
  } catch (err) {
    // Put it back to "done" so a person can look and try again.
    record.set({ status: "done" });
    await record.save();
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
    decidedAt: record.decidedAt,
    executedAt: record.executedAt,
    undoneAt: record.undoneAt,
  };
}

// Short reply for agents: what happened and what to do next.
export function toAgentResponse(record: ActionRecordDoc) {
  const messages: Record<string, string> = {
    done: "Done.",
    pending_approval: "Waiting for a person to approve. Check again later with GET /api/agent/actions/:id.",
    denied: "Not allowed. Do not retry this action; tell the person why.",
    rejected: "A person rejected this action.",
    failed: `The action failed: ${record.errorMessage}`,
    undone: "This action was undone by a person.",
    executing: "Running.",
    undoing: "Being undone.",
  };
  return {
    actionId: String(record._id),
    status: record.status,
    decision: record.decision,
    message: messages[record.status] || record.status,
    reasons: record.decisionReasons,
    result: record.status === "done" ? record.result : null,
  };
}
