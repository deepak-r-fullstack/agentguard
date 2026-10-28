import crypto from "crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Types } from "mongoose";
import { env } from "../../config/env";
import { User, UserDoc } from "../../models/user.model";
import { Agent, AgentDoc } from "../../models/agent.model";
import { Workspace } from "../../models/workspace.model";
import { UserRole } from "../../constants";
import { UnauthorizedError } from "../../helpers/errors";

export interface AuthTokenPayload {
  sub: string; // user id
  workspaceId: string;
  role: UserRole;
  name: string;
  email: string;
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 10);
}

export function signToken(user: Pick<UserDoc, "_id" | "workspaceId" | "role" | "name" | "email">) {
  const payload: AuthTokenPayload = {
    sub: String(user._id),
    workspaceId: String(user.workspaceId),
    role: user.role,
    name: user.name,
    email: user.email,
  };
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: env.JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"] });
}

export function verifyToken(token: string): AuthTokenPayload {
  try {
    return jwt.verify(token, env.JWT_SECRET) as AuthTokenPayload;
  } catch {
    throw new UnauthorizedError("Your session has ended. Please sign in again.");
  }
}

// Users created before the "active" field existed have no value, and they are active.
export function isUserActive(user: { active?: boolean | null }) {
  return user.active !== false;
}

export async function login(email: string, password: string) {
  const user = await User.findOne({ email: email.toLowerCase().trim() }).select("+passwordHash");
  // Same message for "no such user" and "wrong password", so emails cannot be guessed.
  const passwordOk = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !passwordOk) throw new UnauthorizedError("Email or password is not correct.");
  // Only said after the password is right, so this message cannot be used to find out who has an account.
  if (!isUserActive(user)) throw new UnauthorizedError("This account has been turned off. Please ask an admin at your company.");

  const workspace = await Workspace.findById(user.workspaceId).lean();
  return {
    token: signToken(user),
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role,
      workspaceId: String(user.workspaceId),
      workspaceName: workspace?.name || "",
    },
  };
}

// ---------- agent API keys ----------

export function hashApiKey(apiKey: string) {
  return crypto.createHash("sha256").update(apiKey).digest("hex");
}

export function generateApiKey() {
  const apiKey = `agk_${crypto.randomBytes(24).toString("hex")}`;
  return { apiKey, apiKeyHash: hashApiKey(apiKey), apiKeyPreview: `${apiKey.slice(0, 8)}…` };
}

export async function findAgentByApiKey(apiKey: string): Promise<AgentDoc | null> {
  if (!apiKey.startsWith("agk_")) return null;
  return Agent.findOne({ apiKeyHash: hashApiKey(apiKey), active: true }).lean<AgentDoc>();
}

export async function rotateAgentKey(workspaceId: Types.ObjectId, agentId: string) {
  const { apiKey, apiKeyHash, apiKeyPreview } = generateApiKey();
  const agent = await Agent.findOneAndUpdate(
    { _id: agentId, workspaceId },
    { $set: { apiKeyHash, apiKeyPreview } },
    { new: true }
  ).lean<AgentDoc>();
  return agent ? { agent, apiKey } : null;
}
