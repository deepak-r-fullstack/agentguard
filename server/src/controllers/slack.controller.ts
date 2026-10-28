import { Request, Response } from "express";
import { UnauthorizedError, ServiceUnavailableError } from "../helpers/errors";
import { logger, serializeError } from "../utils/logger";
import { handleSlackInteraction, parseInteractionPayload } from "../services/slack/slackApprovals.service";
import { isSlackConfigured, isValidSlackSignature } from "../services/slack/slack.service";

// Slack calls this when someone clicks Approve / Reject. It is not a signed-in
// person or an agent, so the Slack signature is the only credential.

export async function receiveSlackInteraction(req: Request, res: Response) {
  if (!isSlackConfigured()) throw new ServiceUnavailableError("Slack approvals are not set up on this server.");

  // express.raw leaves the exact bytes Slack signed in req.body (anything else means a wrong content type).
  const rawBody = req.body;
  const signature = String(req.headers["x-slack-signature"] || "");
  const timestamp = String(req.headers["x-slack-request-timestamp"] || "");
  if (!Buffer.isBuffer(rawBody) || !isValidSlackSignature(rawBody, timestamp, signature)) {
    throw new UnauthorizedError("This request did not come from Slack.");
  }

  // Slack gives us 3 seconds: answer now, decide afterwards.
  res.status(200).end();

  const interaction = parseInteractionPayload(rawBody);
  if (!interaction) return;
  handleSlackInteraction(interaction).catch((err) => logger.error("slack interaction crashed", serializeError(err)));
}
