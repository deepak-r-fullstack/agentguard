import { FilterQuery, Types } from "mongoose";
import { AuditEvent, AuditEventDoc } from "../../models/auditEvent.model";
import { ActorType, AuditEventType } from "../../constants";

export interface Actor {
  type: ActorType;
  id: string;
  name: string;
}

export const SYSTEM_ACTOR: Actor = { type: "system", id: "system", name: "AgentGuard" };

interface RecordAuditEventInput {
  workspaceId: Types.ObjectId;
  type: AuditEventType;
  actor: Actor;
  summary: string;
  actionId?: Types.ObjectId;
  policyId?: Types.ObjectId;
  onBehalfOf?: string;
}

// Append-only: this service only ever inserts.
export async function recordAuditEvent(input: RecordAuditEventInput) {
  return AuditEvent.create(input);
}

export interface AuditListFilters {
  type?: AuditEventType;
  actorType?: ActorType;
  actionId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listAuditEvents(workspaceId: Types.ObjectId, filters: AuditListFilters = {}) {
  const query: FilterQuery<AuditEventDoc> = { workspaceId };
  if (filters.type) query.type = filters.type;
  if (filters.actorType) query["actor.type"] = filters.actorType;
  if (filters.actionId) query.actionId = new Types.ObjectId(filters.actionId);
  if (filters.from || filters.to) {
    query.createdAt = {};
    if (filters.from) query.createdAt.$gte = filters.from;
    if (filters.to) query.createdAt.$lte = filters.to;
  }
  const limit = Math.min(filters.limit || 200, 1000);
  return AuditEvent.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit).lean<AuditEventDoc[]>();
}

export async function listEventsForAction(workspaceId: Types.ObjectId, actionId: Types.ObjectId) {
  return AuditEvent.find({ workspaceId, actionId }).sort({ createdAt: 1, _id: 1 }).lean<AuditEventDoc[]>();
}

// CSV for auditors. Every cell is quoted, and cells that start with a formula
// character are prefixed so Excel does not run them (CSV injection).
function csvCell(value: unknown): string {
  let text = value === undefined || value === null ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function auditEventsToCsv(events: AuditEventDoc[]): string {
  const header = ["Time (UTC)", "Event", "Actor type", "Actor", "On behalf of", "Summary", "Action id"];
  const rows = events.map((event) => [
    event.createdAt.toISOString(),
    event.type,
    event.actor?.type || "",
    event.actor?.name || "",
    event.onBehalfOf || "",
    event.summary,
    event.actionId ? String(event.actionId) : "",
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");
}
