import { Types } from "mongoose";
import { z } from "zod";
import { AppError } from "../../helpers/errors";
import { ActionRecord } from "../../models/actionRecord.model";
import { User } from "../../models/user.model";
import { Workspace } from "../../models/workspace.model";
import { logger, serializeError } from "../../utils/logger";
import { approveAction, rejectAction } from "../actions/guard.service";
import { APPROVE_ACTION_ID, callSlack, isSlackConfigured, REJECT_ACTION_ID } from "./slack.service";

// ---------------------------------------------------------------------------
// Slack approvals, inbound side: a person clicks Approve / Reject in Slack.
// We never trust the click alone. The Slack user is mapped to an AgentGuard user
// by email, must be an admin or manager of the SAME workspace, and the click must
// come from that workspace's own channel. Then the normal approveAction /
// rejectAction run, so separation of duties and the atomic state change still apply.
// ---------------------------------------------------------------------------

// Only the parts of Slack's block_actions payload that we use.
const interactionSchema = z.object({
  type: z.literal("block_actions"),
  user: z.object({ id: z.string().min(1) }),
  channel: z.object({ id: z.string().min(1) }),
  response_url: z.string().optional(),
  actions: z
    .array(z.object({ action_id: z.string(), value: z.string().optional() }))
    .min(1),
});

export function parseInteractionPayload(rawBody: Buffer) {
  const payload = new URLSearchParams(rawBody.toString("utf8")).get("payload");
  if (!payload) return null;
  try {
    const parsed = interactionSchema.safeParse(JSON.parse(payload));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Interaction = z.infer<typeof interactionSchema>;

// Only the person who clicked sees this ("ephemeral"). Slack gives us a one-time URL for it.
async function replyOnlyToClicker(responseUrl: string | undefined, text: string) {
  if (!responseUrl) return;
  try {
    // The payload is signed by Slack, but still only ever post back to Slack itself.
    if (new URL(responseUrl).hostname !== "hooks.slack.com") return;
    await fetch(responseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response_type: "ephemeral", replace_original: false, text }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    logger.warn("slack reply to clicker failed", serializeError(err));
  }
}

async function findSlackEmail(slackUserId: string): Promise<string> {
  const result = await callSlack("users.info", { user: slackUserId });
  return (result.user?.profile?.email || "").toLowerCase().trim();
}

export async function handleSlackInteraction(interaction: Interaction): Promise<void> {
  if (!isSlackConfigured()) return;
  const clicked = interaction.actions.find((action) => action.action_id === APPROVE_ACTION_ID || action.action_id === REJECT_ACTION_ID);
  if (!clicked || !clicked.value || !Types.ObjectId.isValid(clicked.value)) return;
  const reply = (text: string) => replyOnlyToClicker(interaction.response_url, text);

  try {
    // The action id is the only way in, so this is the one lookup before we know the workspace.
    // Everything after it is filtered by that workspace.
    const action = await ActionRecord.findById(clicked.value).select("workspaceId").lean();
    if (!action) return reply("That request no longer exists.");
    const workspaceId = action.workspaceId as Types.ObjectId;

    const workspace = await Workspace.findById(workspaceId).select("slackChannelId").lean();
    if (!workspace?.slackChannelId || workspace.slackChannelId !== interaction.channel.id) {
      return reply("This request can only be decided in its own company's approval channel.");
    }

    const email = await findSlackEmail(interaction.user.id);
    if (!email) return reply("We could not read your email from Slack, so we cannot tell who you are.");

    const user = await User.findOne({ workspaceId, email }).lean();
    if (!user) return reply("Your Slack email does not match a person in AgentGuard for this company.");
    if (user.role !== "admin" && user.role !== "manager") return reply("Only managers and admins can approve or reject requests.");

    const actor = { type: "user" as const, id: String(user._id), name: user.name, email: user.email };
    if (clicked.action_id === APPROVE_ACTION_ID) {
      await approveAction(workspaceId, clicked.value, actor);
    } else {
      await rejectAction(workspaceId, clicked.value, actor, "Rejected in Slack");
    }
    // The message itself is updated by guard.service (same path as a web decision).
  } catch (err) {
    if (err instanceof AppError) return reply(err.message);
    // Ids only: Slack user ids and action ids are opaque, names and emails are not logged.
    logger.error("slack interaction failed", { actionId: clicked.value, slackUserId: interaction.user.id, ...serializeError(err) });
    return reply("Something went wrong on our side. Please try again in the web app.");
  }
}
