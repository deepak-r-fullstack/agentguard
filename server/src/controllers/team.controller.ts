import { Request, Response } from "express";
import { z } from "zod";
import { USER_ROLES } from "../constants";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser, userActor } from "../middlewares/auth.middleware";
import { addTeamMember, changeTeamMemberRole, listTeam, setTeamMemberActive } from "../services/team/team.service";

// Admin screen "Team": the people in the admin's own company.

export const addMemberSchema = z.object({
  name: z.string().trim().min(2, "Please enter the person's full name.").max(100),
  email: z.string().trim().toLowerCase().email("Please enter a valid email address.").max(200),
  role: z.enum(USER_ROLES),
});

export const changeRoleSchema = z.object({
  role: z.enum(USER_ROLES),
});

export async function getTeam(_req: Request, res: Response) {
  const user = getRequestUser(res);
  return successResponseWithData(res, "Your team.", await listTeam(user.workspaceId));
}

// The temporary password comes back in this one reply only.
export async function addMember(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const input = res.locals.body as z.infer<typeof addMemberSchema>;
  const added = await addTeamMember(user.workspaceId, input, userActor(user));
  return successResponseWithData(res, "Person added. Copy the temporary password now — it will not be shown again.", added, 201);
}

export async function changeRole(req: Request, res: Response) {
  const user = getRequestUser(res);
  const { role } = res.locals.body as z.infer<typeof changeRoleSchema>;
  const { member, changed } = await changeTeamMemberRole(user.workspaceId, req.params.id, role, userActor(user));
  return successResponseWithData(res, changed ? "Role changed." : "Nothing to change. They already have that role.", member);
}

export async function deactivate(req: Request, res: Response) {
  const user = getRequestUser(res);
  const { member, changed } = await setTeamMemberActive(user.workspaceId, req.params.id, false, userActor(user));
  return successResponseWithData(res, changed ? "Account turned off. They can no longer sign in." : "That account was already turned off.", member);
}

export async function reactivate(req: Request, res: Response) {
  const user = getRequestUser(res);
  const { member, changed } = await setTeamMemberActive(user.workspaceId, req.params.id, true, userActor(user));
  return successResponseWithData(res, changed ? "Account turned on. They can sign in again." : "That account was already turned on.", member);
}
