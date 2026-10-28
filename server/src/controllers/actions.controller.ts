import { Request, Response } from "express";
import { z } from "zod";
import { ACTION_STATUSES } from "../constants";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser, userActor } from "../middlewares/auth.middleware";
import {
  approveAction,
  countPendingApprovals,
  getAction,
  listActions,
  rejectAction,
  toActionDto,
  undoAction,
} from "../services/actions/guard.service";
import { listEventsForAction } from "../services/audit/audit.service";

export const listActionsQuerySchema = z.object({
  status: z.enum(ACTION_STATUSES).optional(),
  action: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

export const rejectActionSchema = z.object({
  note: z.string().trim().max(300).optional().default(""),
});

export async function getActions(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const filters = res.locals.query as z.infer<typeof listActionsQuerySchema>;
  const records = await listActions(user.workspaceId, filters);
  return successResponseWithData(res, "Agent actions.", records.map(toActionDto));
}

export async function getActionDetail(req: Request, res: Response) {
  const user = getRequestUser(res);
  const record = await getAction(user.workspaceId, req.params.id);
  const events = await listEventsForAction(user.workspaceId, record._id);
  return successResponseWithData(res, "Action detail.", {
    ...toActionDto(record),
    timeline: events.map((event) => ({
      id: String(event._id),
      type: event.type,
      actor: event.actor,
      summary: event.summary,
      createdAt: event.createdAt,
    })),
  });
}

export async function getActionStats(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const pendingApprovals = await countPendingApprovals(user.workspaceId);
  return successResponseWithData(res, "Action counts.", { pendingApprovals });
}

export async function approve(req: Request, res: Response) {
  const user = getRequestUser(res);
  const record = await approveAction(user.workspaceId, req.params.id, userActor(user));
  const message = record.status === "done" ? "Approved and done." : "Approved, but the action failed.";
  return successResponseWithData(res, message, toActionDto(record));
}

export async function reject(req: Request, res: Response) {
  const user = getRequestUser(res);
  const { note } = res.locals.body as z.infer<typeof rejectActionSchema>;
  const record = await rejectAction(user.workspaceId, req.params.id, userActor(user), note);
  return successResponseWithData(res, "Rejected. The agent will be told.", toActionDto(record));
}

export async function undo(req: Request, res: Response) {
  const user = getRequestUser(res);
  const record = await undoAction(user.workspaceId, req.params.id, userActor(user));
  return successResponseWithData(res, "Undone. Everything is back the way it was.", toActionDto(record));
}
