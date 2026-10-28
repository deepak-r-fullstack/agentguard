import crypto from "crypto";
import { Types } from "mongoose";
import { UserRole } from "../../constants";
import { BadRequestError, ConflictError, NotFoundError } from "../../helpers/errors";
import { User, UserDoc } from "../../models/user.model";
import { Actor, recordAuditEvent } from "../audit/audit.service";
import { hashPassword, isUserActive } from "../auth/auth.service";

// ---------------------------------------------------------------------------
// The Team screen: admins add and manage the people in THEIR company, so nobody
// needs the database. Every query carries the workspaceId, so one company can
// never see or change another's people. Two rules always hold:
//   - an admin cannot turn off or demote themselves
//   - a company always keeps at least one active admin
// ---------------------------------------------------------------------------

const ROLE_LABEL: Record<UserRole, string> = { admin: "Admin", manager: "Manager", auditor: "Auditor" };

// No look-alike characters (0/O, 1/l/I), so a password read out loud or typed from a screen is not misread.
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

export function generateTemporaryPassword() {
  const pick = () => PASSWORD_CHARS[crypto.randomInt(PASSWORD_CHARS.length)];
  const group = () => Array.from({ length: 4 }, pick).join("");
  return `${group()}-${group()}-${group()}`;
}

type TeamMemberRecord = Pick<UserDoc, "name" | "email" | "role"> & { _id: Types.ObjectId; active?: boolean | null; createdAt?: Date };

// Never includes the password hash.
export function toTeamMemberDto(user: TeamMemberRecord) {
  return {
    id: String(user._id),
    name: user.name,
    email: user.email,
    role: user.role,
    active: isUserActive(user),
    createdAt: user.createdAt,
  };
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

async function findMember(workspaceId: Types.ObjectId, userId: string) {
  // Someone else's company looks exactly like "no such person".
  if (!Types.ObjectId.isValid(userId)) throw new NotFoundError("That person was not found.");
  const member = await User.findOne({ _id: userId, workspaceId }).lean();
  if (!member) throw new NotFoundError("That person was not found.");
  return member;
}

// "Active" means "not false": people created before the field existed have no value.
function countActiveAdmins(workspaceId: Types.ObjectId) {
  return User.countDocuments({ workspaceId, role: "admin", active: { $ne: false } });
}

export async function listTeam(workspaceId: Types.ObjectId) {
  const members = await User.find({ workspaceId }).sort({ name: 1 }).lean();
  return members.map(toTeamMemberDto);
}

export async function addTeamMember(
  workspaceId: Types.ObjectId,
  input: { name: string; email: string; role: UserRole },
  actor: Actor
) {
  // Shown to the admin once. Only its hash is stored, so it cannot be shown again.
  const temporaryPassword = generateTemporaryPassword();
  let member;
  try {
    member = await User.create({ ...input, workspaceId, passwordHash: await hashPassword(temporaryPassword), active: true });
  } catch (err) {
    // Emails are unique across the whole product (the sign-in screen only asks for an email).
    if (isDuplicateKeyError(err)) throw new ConflictError("That email address is already in use. Please use a different one.");
    throw err;
  }
  await recordAuditEvent({
    workspaceId,
    type: "user_added",
    actor,
    summary: `Added ${member.name} (${member.email}) as ${ROLE_LABEL[member.role]}`,
  });
  return { member: toTeamMemberDto(member), temporaryPassword };
}

/**
 * Applies a change that could remove a company's last active admin, then checks. MongoDB cannot
 * enforce "at least one admin" in one step, so if two admins demote each other at the same moment
 * and nobody is left, the change is put back and refused. The company is never left without an admin.
 */
async function applyKeepingAnAdmin(
  workspaceId: Types.ObjectId,
  member: { _id: Types.ObjectId; role: UserRole; active?: boolean | null },
  change: { role?: UserRole; active?: boolean }
) {
  const wasActiveAdmin = member.role === "admin" && isUserActive(member);
  if (wasActiveAdmin && (await countActiveAdmins(workspaceId)) <= 1) {
    throw new ConflictError("Your company needs at least one active admin. Make someone else an admin first.");
  }
  // The filter makes sure the person still looks the way we just read them.
  const updated = await User.findOneAndUpdate(
    { _id: member._id, workspaceId, role: member.role },
    { $set: change },
    { new: true }
  ).lean();
  if (!updated) throw new ConflictError("This person was just changed by someone else. Please refresh and try again.");

  if (wasActiveAdmin && (await countActiveAdmins(workspaceId)) === 0) {
    await User.updateOne({ _id: member._id, workspaceId }, { $set: { role: member.role, active: member.active ?? true } });
    throw new ConflictError("Your company needs at least one active admin. Make someone else an admin first.");
  }
  return updated;
}

export async function changeTeamMemberRole(workspaceId: Types.ObjectId, userId: string, role: UserRole, actor: Actor) {
  const member = await findMember(workspaceId, userId);
  if (member.role === role) return { member: toTeamMemberDto(member), changed: false };
  if (String(member._id) === actor.id && role !== "admin") {
    throw new BadRequestError("You cannot change your own role. Ask another admin to do it.");
  }
  const updated = await applyKeepingAnAdmin(workspaceId, member, { role });
  await recordAuditEvent({
    workspaceId,
    type: "user_role_changed",
    actor,
    summary: `Changed ${member.name} (${member.email}) from ${ROLE_LABEL[member.role]} to ${ROLE_LABEL[role]}`,
  });
  return { member: toTeamMemberDto(updated), changed: true };
}

export async function setTeamMemberActive(workspaceId: Types.ObjectId, userId: string, active: boolean, actor: Actor) {
  const member = await findMember(workspaceId, userId);
  if (isUserActive(member) === active) return { member: toTeamMemberDto(member), changed: false };
  if (!active && String(member._id) === actor.id) {
    throw new BadRequestError("You cannot turn off your own account. Ask another admin to do it.");
  }
  const updated = active ? await reactivate(workspaceId, member) : await applyKeepingAnAdmin(workspaceId, member, { active: false });
  await recordAuditEvent({
    workspaceId,
    type: active ? "user_reactivated" : "user_deactivated",
    actor,
    summary: `${active ? "Turned on" : "Turned off"} the account of ${member.name} (${member.email})`,
  });
  return { member: toTeamMemberDto(updated), changed: true };
}

async function reactivate(workspaceId: Types.ObjectId, member: { _id: Types.ObjectId }) {
  const updated = await User.findOneAndUpdate({ _id: member._id, workspaceId }, { $set: { active: true } }, { new: true }).lean();
  if (!updated) throw new NotFoundError("That person was not found.");
  return updated;
}
