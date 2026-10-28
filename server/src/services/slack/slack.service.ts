import crypto from "crypto";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { BadRequestError, ServiceUnavailableError } from "../../helpers/errors";
import { ActionRecord, ActionRecordDoc } from "../../models/actionRecord.model";
import { Workspace } from "../../models/workspace.model";
import { logger, serializeError } from "../../utils/logger";

// ---------------------------------------------------------------------------
// Slack approvals, outbound side: post the approval request, update it once
// someone decides, and send a test message. Slack is optional - with no token
// or signing secret every function here quietly does nothing.
//
// Posting and updating are "fire-and-forget": they run after the agent already has
// its answer, and a Slack failure is only logged (ids only, never names or text).
// ---------------------------------------------------------------------------

const SLACK_API = "https://slack.com/api";
const SLACK_TIMEOUT_MS = 5000;
// Slack signs every request; older than this is treated as a replay.
const SIGNATURE_MAX_AGE_SECONDS = 5 * 60;

export const APPROVE_ACTION_ID = "agentguard_approve";
export const REJECT_ACTION_ID = "agentguard_reject";

export function isSlackConfigured(): boolean {
  return Boolean(env.SLACK_BOT_TOKEN && env.SLACK_SIGNING_SECRET);
}

// Slack's own error codes are short and safe to log; people get a friendlier sentence.
export class SlackApiError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "SlackApiError";
  }
}

interface SlackResponse {
  ok: boolean;
  error?: string;
  ts?: string;
  user?: { profile?: { email?: string } };
}

// Every call is form-encoded (users.info needs it); blocks are sent as a JSON string.
export async function callSlack(method: string, params: Record<string, unknown>): Promise<SlackResponse> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    body.set(key, typeof value === "string" ? value : JSON.stringify(value));
  }
  const response = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
  });
  if (!response.ok) throw new SlackApiError(`http_${response.status}`);
  const data = (await response.json()) as SlackResponse;
  if (!data.ok) throw new SlackApiError(data.error || "unknown_error");
  return data;
}

// ---------- signature check (used by the interactions endpoint) ----------

export function isValidSlackSignature(rawBody: Buffer, timestamp: string, signature: string, nowSeconds = Date.now() / 1000): boolean {
  if (!env.SLACK_SIGNING_SECRET || !timestamp || !signature) return false;
  const age = Math.abs(nowSeconds - Number(timestamp));
  if (!Number.isFinite(age) || age > SIGNATURE_MAX_AGE_SECONDS) return false;

  const expected = `v0=${crypto
    .createHmac("sha256", env.SLACK_SIGNING_SECRET)
    .update(`v0:${timestamp}:`)
    .update(rawBody)
    .digest("hex")}`;
  const expectedBuffer = Buffer.from(expected);
  const givenBuffer = Buffer.from(signature);
  // timingSafeEqual throws on different lengths, so compare those first.
  return expectedBuffer.length === givenBuffer.length && crypto.timingSafeEqual(expectedBuffer, givenBuffer);
}

// ---------- message building ----------

// Text that came from a customer, an agent or a person must not be able to ping @channel or add links.
export function escapeSlackText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type MessageRecord = Pick<ActionRecordDoc, "_id" | "summary" | "agentName" | "onBehalfOf" | "decisionReasons">;

function summaryBlocks(record: MessageRecord, heading: string) {
  return [
    { type: "section", text: { type: "mrkdwn", text: `*${heading}*\n${escapeSlackText(record.summary)}` } },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Agent *${escapeSlackText(record.agentName)}* is working for ${escapeSlackText(record.onBehalfOf)}`,
        },
      ],
    },
  ];
}

export function buildApprovalMessage(record: MessageRecord) {
  const actionId = String(record._id);
  const reasons = record.decisionReasons.map((reason) => `• ${escapeSlackText(reason)}`).join("\n");
  return {
    text: `Approval needed: ${escapeSlackText(record.summary)}`,
    blocks: [
      ...summaryBlocks(record, "Approval needed"),
      ...(reasons ? [{ type: "section", text: { type: "mrkdwn", text: `*Why a person has to decide*\n${reasons}` } }] : []),
      {
        type: "actions",
        elements: [
          { type: "button", style: "primary", text: { type: "plain_text", text: "Approve" }, action_id: APPROVE_ACTION_ID, value: actionId },
          { type: "button", style: "danger", text: { type: "plain_text", text: "Reject" }, action_id: REJECT_ACTION_ID, value: actionId },
        ],
      },
    ],
  };
}

// Replaces the buttons with the outcome, so nobody clicks a decision that is already made.
export function buildDecisionMessage(record: MessageRecord & Pick<ActionRecordDoc, "status" | "approvedBy" | "rejectedBy" | "errorMessage">) {
  let line: string;
  if (record.status === "rejected") line = `❌ *Rejected by ${escapeSlackText(record.rejectedBy)}*`;
  else if (record.status === "failed") {
    line = `⚠️ *Approved by ${escapeSlackText(record.approvedBy)}*, but the action failed: ${escapeSlackText(record.errorMessage)}`;
  } else line = `✅ *Approved by ${escapeSlackText(record.approvedBy)}* and done`;

  return {
    text: `${record.status === "rejected" ? "Rejected" : "Approved"}: ${escapeSlackText(record.summary)}`,
    blocks: [...summaryBlocks(record, "Decision made"), { type: "section", text: { type: "mrkdwn", text: line } }],
  };
}

// ---------- posting and updating (fire-and-forget) ----------

async function loadWorkspaceChannel(workspaceId: Types.ObjectId): Promise<string> {
  const workspace = await Workspace.findById(workspaceId).select("slackChannelId").lean();
  return workspace?.slackChannelId || "";
}

async function postApprovalMessage(record: ActionRecordDoc) {
  const channel = await loadWorkspaceChannel(record.workspaceId);
  if (!channel) return;

  const message = buildApprovalMessage(record);
  const posted = await callSlack("chat.postMessage", { channel, ...message });
  if (!posted.ts) return;
  await ActionRecord.updateOne(
    { _id: record._id, workspaceId: record.workspaceId },
    { $set: { slackChannelId: channel, slackMessageTs: posted.ts } }
  );

  // Someone may have decided in the web app before we saved where the message is.
  const latest = await ActionRecord.findOne({ _id: record._id, workspaceId: record.workspaceId }).lean<ActionRecordDoc>();
  if (latest && latest.status !== "pending_approval") await updateDecisionMessage(latest);
}

async function updateDecisionMessage(record: ActionRecordDoc) {
  if (!record.slackChannelId || !record.slackMessageTs) return;
  await callSlack("chat.update", {
    channel: record.slackChannelId,
    ts: record.slackMessageTs,
    ...buildDecisionMessage(record),
  });
}

function logFailure(what: string, record: ActionRecordDoc, err: unknown) {
  // Ids and Slack's error code only: never names, summaries or message text.
  logger.warn(what, { actionId: String(record._id), workspaceId: String(record.workspaceId), ...serializeError(err) });
}

/** Called when an action starts waiting for a person. Returns at once; never throws. */
export function notifyApprovalRequested(record: ActionRecordDoc): void {
  if (!isSlackConfigured()) return;
  void postApprovalMessage(record).catch((err) => logFailure("slack approval message failed", record, err));
}

/** Called after a person approves or rejects (in Slack or in the web app). Returns at once; never throws. */
export function notifyDecisionMade(record: ActionRecordDoc): void {
  if (!isSlackConfigured() || !record.slackMessageTs) return;
  void updateDecisionMessage(record).catch((err) => logFailure("slack decision update failed", record, err));
}

// ---------- test message (the admin waits for this one, so errors are shown) ----------

const FRIENDLY_SLACK_ERRORS: Record<string, string> = {
  channel_not_found: "Slack cannot find that channel. Check the channel ID.",
  not_in_channel: "Add the AgentGuard app to that channel first (in Slack: open the channel, then Integrations, then Add apps).",
  is_archived: "That Slack channel is archived.",
  invalid_auth: "The Slack token was not accepted. Ask your developer to check SLACK_BOT_TOKEN.",
  token_revoked: "The Slack token was not accepted. Ask your developer to check SLACK_BOT_TOKEN.",
  account_inactive: "The Slack token was not accepted. Ask your developer to check SLACK_BOT_TOKEN.",
};

export async function sendTestMessage(channelId: string) {
  if (!isSlackConfigured()) throw new ServiceUnavailableError("Slack is not set up on this server yet.");
  if (!channelId) throw new BadRequestError("Save a Slack channel ID first.");
  try {
    await callSlack("chat.postMessage", { channel: channelId, text: "✅ AgentGuard is connected. Approval requests will appear here." });
  } catch (err) {
    const code = err instanceof SlackApiError ? err.code : "";
    logger.warn("slack test message failed", { workspaceChannel: channelId, slackError: code });
    throw new BadRequestError(FRIENDLY_SLACK_ERRORS[code] || "Slack did not accept the test message. Please try again.");
  }
}
