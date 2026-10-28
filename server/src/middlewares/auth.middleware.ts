import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { UserRole } from "../constants";
import { ForbiddenError, UnauthorizedError } from "../helpers/errors";
import { findAgentByApiKey, verifyToken } from "../services/auth/auth.service";
import { AgentDoc } from "../models/agent.model";
import { Actor } from "../services/audit/audit.service";

// The signed-in person (from the JWT) and the calling agent (from the API key)
// are kept on res.locals, like res.locals.documentToDelete in the NueAssist services.

export interface RequestUser {
  id: string;
  workspaceId: Types.ObjectId;
  role: UserRole;
  name: string;
  email: string;
}

export function getRequestUser(res: Response): RequestUser {
  const user = res.locals.user as RequestUser | undefined;
  if (!user) throw new UnauthorizedError();
  return user;
}

export function getRequestAgent(res: Response): AgentDoc {
  const agent = res.locals.agent as AgentDoc | undefined;
  if (!agent) throw new UnauthorizedError("Missing agent key.");
  return agent;
}

export function userActor(user: RequestUser): Actor & { email: string } {
  return { type: "user", id: user.id, name: user.name, email: user.email };
}

export function authenticateUser(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) return next(new UnauthorizedError("Please sign in."));

  const payload = verifyToken(token);
  if (!Types.ObjectId.isValid(payload.workspaceId)) return next(new UnauthorizedError());

  res.locals.user = {
    id: payload.sub,
    workspaceId: new Types.ObjectId(payload.workspaceId),
    role: payload.role,
    name: payload.name,
    email: payload.email,
  } satisfies RequestUser;
  return next();
}

export function authorizeRoles(...roles: UserRole[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = getRequestUser(res);
    if (!roles.includes(user.role)) return next(new ForbiddenError());
    return next();
  };
}

export async function authenticateAgent(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = String(req.headers["x-agent-key"] || "");
    if (!apiKey) throw new UnauthorizedError("Send your agent key in the x-agent-key header.");
    const agent = await findAgentByApiKey(apiKey);
    if (!agent) throw new UnauthorizedError("This agent key is not valid or the agent is turned off.");
    res.locals.agent = agent;
    next();
  } catch (err) {
    next(err);
  }
}
