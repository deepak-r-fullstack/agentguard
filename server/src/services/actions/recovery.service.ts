import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { INTERRUPTED_ACTION_TIMEOUT_MS } from "../../constants";
import { logger, serializeError } from "../../utils/logger";
import { recordAuditEvent, SYSTEM_ACTOR } from "../audit/audit.service";
import { releaseLimitReservations } from "../policy/dailyLimit.service";
import { notifyDecisionMade } from "../slack/slack.service";

// ---------------------------------------------------------------------------
// Recovery for interrupted actions. If the server dies (or restarts) while an action is running
// or being undone, the record would stay in "executing" / "undoing" forever. This job finds
// those that have not moved for longer than a safe timeout and settles them honestly:
//   executing -> failed ("interrupted; please check the booking"), so a person looks at it
//   undoing   -> done again, so the person can try Undo once more
// Each one gets an audit event. The change is one conditional update, so when several server
// instances run the job together exactly one of them settles each record.
// ---------------------------------------------------------------------------

export const INTERRUPTED_EXECUTION_MESSAGE = "This action was interrupted; please check the booking.";
export const INTERRUPTED_UNDO_MESSAGE = "The undo was interrupted; please check the booking. It is marked as done again, so you can try Undo once more.";

const BATCH = 100;

/** Returns how many actions this run settled. */
export async function recoverInterruptedActions(now = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - INTERRUPTED_ACTION_TIMEOUT_MS);
  let settled = 0;

  for (;;) {
    // updatedAt moves on every change, so "not touched since the cutoff" means nobody is working on it.
    const stuck = await ActionRecord.find({ status: { $in: ["executing", "undoing"] }, updatedAt: { $lt: cutoff } })
      .select("_id workspaceId status")
      .limit(BATCH)
      .lean();
    let settledInBatch = 0;
    for (const candidate of stuck) {
      try {
        const wasExecuting = candidate.status === "executing";
        const record = await ActionRecord.findOneAndUpdate(
          { _id: candidate._id, workspaceId: candidate.workspaceId, status: candidate.status, updatedAt: { $lt: cutoff } },
          { $set: wasExecuting ? { status: "failed", errorMessage: INTERRUPTED_EXECUTION_MESSAGE } : { status: "done" } },
          { new: true }
        ).lean<ActionRecordDoc>();
        if (!record) continue; // another server instance (or the action itself) got there first

        settledInBatch += 1;
        if (wasExecuting) {
          await releaseLimitReservations(record);
          await recordAuditEvent({
            workspaceId: record.workspaceId,
            type: "action_failed",
            actionId: record._id,
            actor: SYSTEM_ACTOR,
            onBehalfOf: record.onBehalfOf,
            summary: `Failed: ${record.summary}. ${INTERRUPTED_EXECUTION_MESSAGE}`,
          });
          if (record.approvedBy) notifyDecisionMade(record); // the Slack message still shows it as approved and running
        } else {
          await recordAuditEvent({
            workspaceId: record.workspaceId,
            type: "undo_failed",
            actionId: record._id,
            actor: SYSTEM_ACTOR,
            onBehalfOf: record.onBehalfOf,
            summary: `Could not undo: ${record.summary}. ${INTERRUPTED_UNDO_MESSAGE}`,
          });
        }
      } catch (err) {
        // One bad record must not stop the rest. Ids only.
        logger.error("recovering an interrupted action failed", { actionId: String(candidate._id), workspaceId: String(candidate.workspaceId), ...serializeError(err) });
      }
    }
    settled += settledInBatch;
    // Stop when the batch was the last one, or when nothing in it could be settled (it would only repeat).
    if (stuck.length < BATCH || settledInBatch === 0) return settled;
  }
}
