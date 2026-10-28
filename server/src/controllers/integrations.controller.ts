import { Request, Response } from "express";
import { z } from "zod";
import { successResponseWithData } from "../helpers/response";
import { NotFoundError } from "../helpers/errors";
import { getRequestUser } from "../middlewares/auth.middleware";
import { Workspace } from "../models/workspace.model";
import { isSlackConfigured, sendTestMessage } from "../services/slack/slack.service";

// Admin screen "Connections": how agents connect (MCP) and where approvals go (Slack).

// Slack channel ids look like C0123456789 (or G... for private channels). Empty turns Slack off.
export const slackChannelSchema = z.object({
  slackChannelId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^([CG][A-Z0-9]{8,20})?$/, "A Slack channel ID looks like C0123456789."),
});

async function getWorkspaceChannel(workspaceId: unknown): Promise<string> {
  const workspace = await Workspace.findById(workspaceId).select("slackChannelId").lean();
  if (!workspace) throw new NotFoundError("We could not find your company.");
  return workspace.slackChannelId || "";
}

function describeConnections(slackChannelId: string) {
  return {
    slack: { configured: isSlackConfigured(), channelId: slackChannelId },
  };
}

export async function getIntegrations(_req: Request, res: Response) {
  const user = getRequestUser(res);
  return successResponseWithData(res, "Connections.", describeConnections(await getWorkspaceChannel(user.workspaceId)));
}

export async function saveSlackChannel(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const { slackChannelId } = res.locals.body as z.infer<typeof slackChannelSchema>;
  const updated = await Workspace.findOneAndUpdate({ _id: user.workspaceId }, { $set: { slackChannelId } }, { new: true }).lean();
  if (!updated) throw new NotFoundError("We could not find your company.");
  const message = slackChannelId ? "Slack channel saved." : "Slack approvals are turned off for your company.";
  return successResponseWithData(res, message, describeConnections(updated.slackChannelId || ""));
}

export async function sendSlackTest(_req: Request, res: Response) {
  const user = getRequestUser(res);
  await sendTestMessage(await getWorkspaceChannel(user.workspaceId));
  return successResponseWithData(res, "Test message sent. Check your Slack channel.", { sent: true });
}
