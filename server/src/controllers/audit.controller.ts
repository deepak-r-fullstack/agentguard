import { Request, Response } from "express";
import { z } from "zod";
import { ACTOR_TYPES, AUDIT_EVENT_TYPES } from "../constants";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser } from "../middlewares/auth.middleware";
import { auditEventsToCsv, listAuditEvents, verifyAuditChain } from "../services/audit/audit.service";

export const auditQuerySchema = z.object({
  type: z.enum(AUDIT_EVENT_TYPES).optional(),
  actorType: z.enum(ACTOR_TYPES).optional(),
  actionId: z
    .string()
    .regex(/^[a-f0-9]{24}$/i)
    .optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).optional(),
});

export async function getAuditEvents(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const events = await listAuditEvents(user.workspaceId, res.locals.query as z.infer<typeof auditQuerySchema>);
  return successResponseWithData(
    res,
    "Audit trail.",
    events.map((event) => ({
      id: String(event._id),
      type: event.type,
      actionId: event.actionId ? String(event.actionId) : null,
      actor: event.actor,
      onBehalfOf: event.onBehalfOf,
      summary: event.summary,
      createdAt: event.createdAt,
    }))
  );
}

export async function exportAuditCsv(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const filters = { ...(res.locals.query as z.infer<typeof auditQuerySchema>), limit: 1000 };
  const events = await listAuditEvents(user.workspaceId, filters);
  const fileName = `agentguard-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  return res.status(200).send(auditEventsToCsv(events));
}

// Walks this company's whole chain. A broken chain is an ANSWER (ok: false), not an error, so it is a normal 200.
export async function verifyAudit(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const check = await verifyAuditChain(user.workspaceId);
  const message = check.ok ? "The audit history is intact." : "The audit history has been changed.";
  return successResponseWithData(res, message, { ...check, verifiedAt: new Date() });
}
