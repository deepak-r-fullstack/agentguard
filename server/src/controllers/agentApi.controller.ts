import { Request, Response } from "express";
import { Types } from "mongoose";
import { z } from "zod";
import { successResponseWithData } from "../helpers/response";
import { getRequestAgent } from "../middlewares/auth.middleware";
import { describeActionCatalog } from "../services/actions/actionRegistry";
import { describeForAgent, getAction, requestAction } from "../services/actions/guard.service";
import { ForbiddenError } from "../helpers/errors";

// The API that AI agents call (authenticated with x-agent-key).

export const agentActionRequestSchema = z.object({
  action: z.string().trim().min(1).max(100),
  params: z.record(z.unknown()).default({}),
  reason: z.string().trim().max(500).optional().default(""),
  onBehalfOf: z.string().trim().min(1).max(200),
  idempotencyKey: z.string().trim().min(8).max(100),
});

export async function submitAgentAction(_req: Request, res: Response) {
  const agent = getRequestAgent(res);
  const input = res.locals.body as z.infer<typeof agentActionRequestSchema>;
  const record = await requestAction(agent, input);
  // 202 Accepted when a person still has to decide; 200 otherwise.
  const statusCode = record.status === "pending_approval" ? 202 : 200;
  const response = await describeForAgent(record);
  return successResponseWithData(res, response.message, response, statusCode);
}

export async function getAgentActionStatus(req: Request, res: Response) {
  const agent = getRequestAgent(res);
  const record = await getAction(agent.workspaceId as Types.ObjectId, req.params.id);
  // Agents can only read their own actions.
  if (String(record.agentId) !== String(agent._id)) throw new ForbiddenError();
  return successResponseWithData(res, "Action status.", await describeForAgent(record));
}

export async function getAgentCatalog(_req: Request, res: Response) {
  return successResponseWithData(res, "Actions this agent may request.", describeActionCatalog());
}
