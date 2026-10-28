import { NextFunction, Request, Response } from "express";
import { Types } from "mongoose";
import { UserRole } from "../constants";
import { ForbiddenError, UnauthorizedError } from "../helpers/errors";
import { findAgentByApiKey, isUserActive, verifyToken } from "../services/auth/auth.service";
import { User } from "../models/user.model";
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

export async function authenticateUser(req: Request, res: Response, next: NextFunction) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");
    if (scheme !== "Bearer" || !token) throw new UnauthorizedError("Please sign in.");

    const payload = verifyToken(token);
    if (!Types.ObjectId.isValid(payload.sub) || !Types.ObjectId.isValid(payload.workspaceId)) throw new UnauthorizedError();

    // The token only proves who signed in earlier. The person's current record decides what they may do now,
    // so turning someone off, or changing their role, takes effect on their very next request.
    const user = await User.findOne({ _id: payload.sub, workspaceId: payload.workspaceId }).lean();
    if (!user) throw new UnauthorizedError();
    if (!isUserActive(user)) throw new UnauthorizedError("This account has been turned off. Please ask an admin at your company.");

    res.locals.user = {
      id: String(user._id),
      workspaceId: user.workspaceId as Types.ObjectId,
      role: user.role,
      name: user.name,
      email: user.email,
    } satisfies RequestUser;
    next();
  } catch (err) {
    next(err);
  }
}

export function authorizeRoles(...roles: UserRole[]) {
  return (_req: Request, res: Response, next: NextFunction) => {
    const user = getRequestUser(res);
    if (!roles.includes(user.role)) return next(new ForbiddenError());
    return next();
  };
}

// Agents send their key in x-agent-key. MCP clients can only send "Authorization: Bearer <key>",
// so that form is accepted too. x-agent-key wins when both are present.
function readAgentKey(req: Request): string {
  const headerKey = String(req.headers["x-agent-key"] || "");
  if (headerKey) return headerKey;
  const [scheme, token] = (req.headers.authorization || "").split(" ");
  return scheme?.toLowerCase() === "bearer" && token ? token : "";
}

export async function authenticateAgent(req: Request, res: Response, next: NextFunction) {
  try {
    const apiKey = readAgentKey(req);
    if (!apiKey) throw new UnauthorizedError("Send your agent key in the x-agent-key header (or as Authorization: Bearer agk_...).");
    const agent = await findAgentByApiKey(apiKey);
    if (!agent) throw new UnauthorizedError("This agent key is not valid or the agent is turned off.");
    res.locals.agent = agent;
    next();
  } catch (err) {
    next(err);
  }
}
