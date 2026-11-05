import { AgentReplay } from "@sritarak/agentreplay";
import { env } from "../../config/env";
import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { logger, serializeError } from "../../utils/logger";
import { activityLink, agentReplayBaseUrl, isAgentReplayConfigured, recordingViewUrl } from "./agentReplay.service";

// ---------------------------------------------------------------------------
// The AgentReplay recording of one guided-demo journey: the agent's request, AgentGuard's rule check, the manager's
// decision and the result. Every step links back to the same AgentGuard action, so the replay opens the action whose
// Undo lives here. Optional: without AGENTREPLAY_API_KEY nothing is recorded and nothing is sent.
//
// The rules that keep the demo safe:
//  - recording happens AFTER a person decides, in the background: it never delays or fails an approval or a rejection
//  - each action is recorded at most once (an atomic claim on the action record), however often it is retried
//  - the state shown to the visitor comes from AgentReplay itself: "available" only once AgentReplay confirms that
//    THIS run arrived and links to THIS action, so an unrelated recording is never offered
//  - the SDK key stays on the server; the browser only ever sees the viewing link
// ---------------------------------------------------------------------------

export const GUIDED_BOOKING_JOURNEY = "guided_booking" as const;

// How long a recording may take to arrive before it is called unavailable. The SDK sends within a few seconds and gives
// up after short timeouts, so a recording that has not arrived after this is not coming.
export const RECORDING_CONFIRM_WINDOW_MS = 2 * 60 * 1000;
const LOOKUP_TIMEOUT_MS = 3000;
const LOOKUP_CACHE_MS = 4000;

// Decided journeys only: there is nothing to replay while a person still has to decide.
const RECORDABLE_STATUSES = ["done", "failed", "rejected", "denied", "undoing", "undone"];

export type GuidedRecordingState = "waiting" | "pending" | "available" | "unavailable";
export interface GuidedRecordingStatus {
  state: GuidedRecordingState;
  message: string;
  url?: string;
}

function millisecondsBetween(from?: Date | null, to?: Date | null) {
  if (!from || !to) return 0;
  return Math.max(0, new Date(to).getTime() - new Date(from).getTime());
}

/** Records the journey in the background. Returns at once and never throws. */
export function recordGuidedJourney(record: ActionRecordDoc | null | undefined): void {
  if (!record || record.demoJourney !== GUIDED_BOOKING_JOURNEY || !isAgentReplayConfigured()) return;
  void sendJourney(record).catch((err) => logger.warn("guided journey recording failed", { actionId: String(record._id), ...serializeError(err) }));
}

/** The work behind recordGuidedJourney. Exported for tests, which wait for it. Resolves to true when it recorded. */
export async function sendJourney(record: ActionRecordDoc): Promise<boolean> {
  if (record.demoJourney !== GUIDED_BOOKING_JOURNEY || !isAgentReplayConfigured() || !RECORDABLE_STATUSES.includes(record.status)) return false;

  // Only one caller ever records an action: approval, a retried status check and a second server all race here.
  const claimed = await ActionRecord.findOneAndUpdate(
    { _id: record._id, workspaceId: record.workspaceId, demoJourney: GUIDED_BOOKING_JOURNEY, replayRecording: { $exists: false } },
    { $set: { replayRecording: { state: "sending", runId: "", sentAt: new Date() } } },
    { new: true }
  ).lean<ActionRecordDoc>();
  if (!claimed) return false;

  // A client of its own per journey (not the SDK's shared one), so nothing outside this journey is touched.
  const client = new AgentReplay({ apiKey: env.AGENTREPLAY_API_KEY, baseUrl: env.AGENTREPLAY_URL || undefined });
  const params = (record.params || {}) as { bookingCode?: string };
  const actionId = String(record._id);
  const link = { system: "agentguard", id: actionId, url: activityLink(actionId) };
  const run = client.startRun({ name: `Guided demo: cancel booking ${params.bookingCode || ""}`.trim(), userRef: record.onBehalfOf, tags: ["agentguard", "guided-demo"] });

  run.step({
    type: "tool",
    name: "Agent asks to cancel the booking",
    input: { action: record.action, params, reason: record.reason, workingFor: record.onBehalfOf },
    output: { sentTo: "AgentGuard", summary: record.summary },
    externalRef: link,
  });
  run.step({
    type: "custom",
    name: "AgentGuard checks the company rules",
    input: { checkedFacts: record.facts },
    output: {
      decision: record.decision === "require_approval" ? "Needs a manager's approval" : record.decision === "deny" ? "Refused" : "Allowed",
      why: record.decisionReasons,
    },
    externalRef: link,
  });

  if (record.decision === "require_approval") {
    const approved = Boolean(record.approvedBy);
    run.step({
      type: "custom",
      name: approved ? "A manager approves in AgentGuard" : "A manager rejects in AgentGuard",
      output: approved ? { decision: "approved", by: record.approvedBy } : { decision: "rejected", by: record.rejectedBy },
      durationMs: millisecondsBetween(record.createdAt, record.decidedAt),
      externalRef: link,
    });
  }
  if (["done", "failed", "undoing", "undone"].includes(record.status)) {
    run.step({
      type: "tool",
      name: "AgentGuard cancels the booking",
      input: params,
      output: record.status === "failed" ? undefined : { result: record.result, canBeUndoneIn: "AgentGuard" },
      error: record.status === "failed" ? record.errorMessage || "The action failed." : undefined,
      externalRef: link,
    });
  }
  run.end(record.status === "failed" ? "failed" : "ok");

  await ActionRecord.updateOne(
    { _id: record._id, workspaceId: record.workspaceId, "replayRecording.state": "sending" },
    { $set: { "replayRecording.state": "sent", "replayRecording.runId": run.id } }
  );
  await client.flush(); // never rejects; a failed send is reported later as "unavailable"
  return true;
}

// ---------- did it arrive? ----------

type LookupResult = "found" | "missing" | "unknown";
const lookupCache = new Map<string, { at: number; result: LookupResult }>();

// Asks AgentReplay (with the app's own key, server-side) whether this run arrived AND links to this action.
async function lookupRecording(runId: string, actionId: string): Promise<LookupResult> {
  const cacheKey = `${runId}:${actionId}`;
  const cached = lookupCache.get(cacheKey);
  if (cached && Date.now() - cached.at < LOOKUP_CACHE_MS) return cached.result;

  let result: LookupResult = "unknown";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  timer.unref?.();
  try {
    const url = `${agentReplayBaseUrl()}/api/ingest/runs/${encodeURIComponent(runId)}?ref=${encodeURIComponent(actionId)}`;
    const response = await fetch(url, { headers: { "x-api-key": env.AGENTREPLAY_API_KEY }, signal: controller.signal });
    if (response.ok) {
      const body = (await response.json()) as { data?: { linked?: boolean; stepCount?: number } };
      // A run that does not link to this action is never shown as this action's recording.
      result = body.data?.linked && (body.data.stepCount ?? 0) > 0 ? "found" : "missing";
    } else if (response.status === 404) {
      result = "missing";
    }
  } catch {
    result = "unknown"; // AgentReplay is asleep, slow or down
  } finally {
    clearTimeout(timer);
  }

  if (lookupCache.size > 500) lookupCache.clear();
  lookupCache.set(cacheKey, { at: Date.now(), result });
  return result;
}

/** Test helper: forget earlier answers from AgentReplay. */
export function clearRecordingLookupCache() {
  lookupCache.clear();
}

const MESSAGES = {
  notGuided: "This action is not part of the guided demo, so it has no journey recording.",
  notConfigured: "Recording to AgentReplay is not turned on for this server. Everything in AgentGuard works the same.",
  waiting: "The recording is saved once a manager decides.",
  expired: "Nobody decided in time, so the request expired and there is no journey to record.",
  pending: "Saving the recording to AgentReplay. This usually takes a few seconds.",
  available: "Your recording is ready. If AgentReplay asks you to sign in, press “Try the demo”.",
  notSent: "The recording could not be saved. The booking, approval and Undo are not affected.",
  notArrived: "AgentReplay did not receive the recording. The booking, approval and Undo are not affected.",
  unreachable: "AgentReplay could not be reached to confirm the recording. The booking, approval and Undo are not affected.",
} as const;

/**
 * What the visitor sees about this action's recording. Workspace scoping is the caller's job (it loads the action
 * for the signed-in person's company). A decided journey without a recording (for example after a restart) is
 * recorded now: that is the supported recovery.
 */
export async function describeGuidedRecording(record: ActionRecordDoc, now = new Date()): Promise<GuidedRecordingStatus> {
  if (record.demoJourney !== GUIDED_BOOKING_JOURNEY) return { state: "unavailable", message: MESSAGES.notGuided };
  if (!isAgentReplayConfigured()) return { state: "unavailable", message: MESSAGES.notConfigured };
  if (record.status === "expired") return { state: "unavailable", message: MESSAGES.expired };
  if (!RECORDABLE_STATUSES.includes(record.status)) return { state: "waiting", message: MESSAGES.waiting };

  const recording = record.replayRecording;
  if (!recording) {
    recordGuidedJourney(record);
    return { state: "pending", message: MESSAGES.pending };
  }

  const withinWindow = now.getTime() - new Date(recording.sentAt).getTime() < RECORDING_CONFIRM_WINDOW_MS;
  const url = recording.runId ? recordingViewUrl(recording.runId) : null;
  if (!recording.runId || !url) return withinWindow ? { state: "pending", message: MESSAGES.pending } : { state: "unavailable", message: MESSAGES.notSent };
  if (recording.state === "confirmed") return { state: "available", message: MESSAGES.available, url };

  const found = await lookupRecording(recording.runId, String(record._id));
  if (found === "found") {
    await ActionRecord.updateOne(
      { _id: record._id, workspaceId: record.workspaceId, "replayRecording.runId": recording.runId },
      { $set: { "replayRecording.state": "confirmed", "replayRecording.confirmedAt": now } }
    );
    return { state: "available", message: MESSAGES.available, url };
  }
  // Still checked after the window, so a recording that arrives late still becomes available.
  if (withinWindow) return { state: "pending", message: MESSAGES.pending };
  return { state: "unavailable", message: found === "missing" ? MESSAGES.notArrived : MESSAGES.unreachable };
}
