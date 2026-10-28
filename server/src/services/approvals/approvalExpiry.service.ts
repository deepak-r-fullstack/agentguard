import { Types } from "mongoose";
import { DEFAULT_APPROVAL_EXPIRY_HOURS } from "../../constants";
import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { Workspace } from "../../models/workspace.model";
import { logger, serializeError } from "../../utils/logger";
import { Actor, recordAuditEvent, SYSTEM_ACTOR } from "../audit/audit.service";
import { releaseLimitReservations } from "../policy/dailyLimit.service";
import { notifyDecisionMade } from "../slack/slack.service";

// ---------------------------------------------------------------------------
// Approvals that expire. A request nobody decides must not wait forever (and must not hold its
// share of a daily limit forever). Each waiting request has an expiresAt; once it passes, the
// request becomes "expired": its daily-limit room is given back, the audit log and Slack are
// updated, and nobody can approve it any more. Every step is one atomic, workspace-scoped update,
// so it is safe when several server instances run the sweep at the same time.
// ---------------------------------------------------------------------------

const HOUR_MS = 60 * 60 * 1000;
const SWEEP_BATCH = 200;

export const EXPIRED_MESSAGE = "This request has expired and can no longer be approved. The agent can ask again.";

export async function getApprovalExpiryHours(workspaceId: Types.ObjectId): Promise<number> {
  const workspace = await Workspace.findById(workspaceId).select("approvalExpiryHours").lean();
  return workspace?.approvalExpiryHours || DEFAULT_APPROVAL_EXPIRY_HOURS;
}

export function approvalDeadline(hours: number, from = new Date()): Date {
  return new Date(from.getTime() + hours * HOUR_MS);
}

/**
 * Moves one overdue waiting request to "expired". Returns null when it is not (or no longer) an
 * overdue waiting request, for example because a person just decided it or another server got here first.
 */
export async function expireAction(record: Pick<ActionRecordDoc, "_id" | "workspaceId">, now = new Date()) {
  const expired = await ActionRecord.findOneAndUpdate(
    { _id: record._id, workspaceId: record.workspaceId, status: "pending_approval", expiresAt: { $lte: now } },
    { $set: { status: "expired" } },
    { new: true }
  ).lean<ActionRecordDoc>();
  if (!expired) return null;

  await releaseLimitReservations(expired);
  await recordAuditEvent({
    workspaceId: expired.workspaceId as Types.ObjectId,
    type: "action_expired",
    actionId: expired._id,
    actor: SYSTEM_ACTOR,
    onBehalfOf: expired.onBehalfOf,
    summary: `Expired: ${expired.summary}. Nobody approved it in time.`,
  });
  notifyDecisionMade(expired); // turns the Slack message into "Expired"
  return expired;
}

// Requests that were already waiting before expiry existed get a fresh full period, instead of expiring the moment this ships.
async function giveLegacyRequestsADeadline(now: Date) {
  const legacy = await ActionRecord.find({ status: "pending_approval", expiresAt: null }).select("_id workspaceId").limit(SWEEP_BATCH).lean();
  const hoursByWorkspace = new Map<string, number>();
  for (const record of legacy) {
    const workspaceKey = String(record.workspaceId);
    if (!hoursByWorkspace.has(workspaceKey)) hoursByWorkspace.set(workspaceKey, await getApprovalExpiryHours(record.workspaceId as Types.ObjectId));
    await ActionRecord.updateOne(
      { _id: record._id, workspaceId: record.workspaceId, status: "pending_approval", expiresAt: null },
      { $set: { expiresAt: approvalDeadline(hoursByWorkspace.get(workspaceKey) as number, now) } },
      { timestamps: false }
    );
  }
}

/** The background sweep. Returns how many requests this run expired. */
export async function expireOverdueApprovals(now = new Date()): Promise<number> {
  await giveLegacyRequestsADeadline(now);
  let expiredCount = 0;
  for (;;) {
    const overdue = await ActionRecord.find({ status: "pending_approval", expiresAt: { $lte: now } })
      .select("_id workspaceId")
      .limit(SWEEP_BATCH)
      .lean();
    for (const record of overdue) {
      try {
        if (await expireAction(record, now)) expiredCount += 1;
      } catch (err) {
        // One bad record must not stop the rest. Ids only.
        logger.error("expiring an approval failed", { actionId: String(record._id), workspaceId: String(record.workspaceId), ...serializeError(err) });
      }
    }
    if (overdue.length < SWEEP_BATCH) return expiredCount;
  }
}

// ---------- the setting (Rules screen) ----------

export async function changeApprovalExpiryHours(workspaceId: Types.ObjectId, hours: number, actor: Actor) {
  // The old value comes back from the same atomic update, so the audit line is always accurate.
  const before = await Workspace.findOneAndUpdate({ _id: workspaceId }, { $set: { approvalExpiryHours: hours } }, { new: false }).lean();
  if (!before) return null;
  const previous = before.approvalExpiryHours || DEFAULT_APPROVAL_EXPIRY_HOURS;
  if (previous !== hours) {
    await recordAuditEvent({
      workspaceId,
      type: "settings_updated",
      actor,
      summary: `Changed how long approvals wait from ${previous} to ${hours} hours (applies to new requests)`,
    });
  }
  return hours;
}
