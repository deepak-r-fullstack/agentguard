import { Request, Response } from "express";
import { z } from "zod";
import { MAX_APPROVAL_EXPIRY_HOURS, MIN_APPROVAL_EXPIRY_HOURS } from "../constants";
import { NotFoundError } from "../helpers/errors";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser, userActor } from "../middlewares/auth.middleware";
import { changeApprovalExpiryHours, getApprovalExpiryHours } from "../services/approvals/approvalExpiry.service";

// How long a request may wait for a person. Everyone can read it; only admins change it (Rules screen).

export const approvalSettingsSchema = z.object({
  approvalExpiryHours: z
    .number({ invalid_type_error: "Enter a whole number of hours." })
    .int("Enter a whole number of hours.")
    .min(MIN_APPROVAL_EXPIRY_HOURS, `Approvals must wait at least ${MIN_APPROVAL_EXPIRY_HOURS} hour.`)
    .max(MAX_APPROVAL_EXPIRY_HOURS, `Approvals can wait at most ${MAX_APPROVAL_EXPIRY_HOURS} hours (30 days).`),
});

export async function getApprovalSettings(_req: Request, res: Response) {
  const user = getRequestUser(res);
  return successResponseWithData(res, "Approval settings.", { approvalExpiryHours: await getApprovalExpiryHours(user.workspaceId) });
}

export async function saveApprovalSettings(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const { approvalExpiryHours } = res.locals.body as z.infer<typeof approvalSettingsSchema>;
  const saved = await changeApprovalExpiryHours(user.workspaceId, approvalExpiryHours, userActor(user));
  if (saved === null) throw new NotFoundError("We could not find your company.");
  return successResponseWithData(res, "Saved. New requests will wait this long before they expire.", { approvalExpiryHours: saved });
}
