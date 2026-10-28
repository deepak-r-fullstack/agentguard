import { Request, Response } from "express";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser } from "../middlewares/auth.middleware";
import { Agent } from "../models/agent.model";
import { rotateAgentKey } from "../services/auth/auth.service";
import { NotFoundError } from "../helpers/errors";

// Admin screen data for the agents allowed to call AgentGuard.

export async function getAgents(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const agents = await Agent.find({ workspaceId: user.workspaceId }).sort({ name: 1 }).lean();
  return successResponseWithData(
    res,
    "Agents.",
    agents.map((agent) => ({
      id: String(agent._id),
      name: agent.name,
      description: agent.description,
      apiKeyPreview: agent.apiKeyPreview,
      active: agent.active,
    }))
  );
}

// Shows the new key ONCE. Only its hash is stored, so it cannot be shown again later.
export async function rotateKey(req: Request, res: Response) {
  const user = getRequestUser(res);
  const rotated = await rotateAgentKey(user.workspaceId, req.params.id);
  if (!rotated) throw new NotFoundError("That agent was not found.");
  return successResponseWithData(res, "New key created. Copy it now — it will not be shown again.", {
    id: String(rotated.agent._id),
    name: rotated.agent.name,
    apiKey: rotated.apiKey,
  });
}
