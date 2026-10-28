import crypto from "crypto";
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
  createdAt?: Date; // only to carry an old entry's time into a new chain (see demo reset)
}

// ---------------------------------------------------------------------------
// Tamper-evident history. Each company's events form a chain:
//   hash = SHA-256( previous event's hash + canonical JSON of this event )
// Change or remove an old entry and its hash (and every hash after it) stops matching,
// which GET /api/audit/verify reports. The first entry starts from GENESIS_HASH.
// ---------------------------------------------------------------------------

export const GENESIS_HASH = "0".repeat(64);

// Two writers at the same instant may pick the same number. One wins, the others read again and retry.
const MAX_APPEND_ATTEMPTS = 100;

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: number }).code === 11000;
}

// Same value, same text: keys are sorted and nothing depends on property order.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`);
  return `{${entries.join(",")}}`;
}

interface HashableEvent {
  workspaceId: Types.ObjectId;
  seq?: number | null;
  type: AuditEventType;
  actionId?: Types.ObjectId | null;
  policyId?: Types.ObjectId | null;
  actor?: Actor | null;
  onBehalfOf?: string | null;
  summary: string;
  createdAt: Date;
}

export function computeEventHash(prevHash: string, event: HashableEvent): string {
  const body = canonicalJson({
    workspaceId: String(event.workspaceId),
    seq: event.seq,
    type: event.type,
    actionId: event.actionId ? String(event.actionId) : null,
    policyId: event.policyId ? String(event.policyId) : null,
    actor: { type: event.actor?.type, id: event.actor?.id, name: event.actor?.name },
    onBehalfOf: event.onBehalfOf || "",
    summary: event.summary,
    createdAt: event.createdAt.toISOString(),
  });
  return crypto.createHash("sha256").update(prevHash + body).digest("hex");
}

// Append-only: this service only ever inserts.
export async function recordAuditEvent(input: RecordAuditEventInput) {
  for (let attempt = 1; ; attempt++) {
    const last = await AuditEvent.findOne({ workspaceId: input.workspaceId, seq: { $exists: true } })
      .sort({ seq: -1 })
      .select("seq hash")
      .lean<{ seq: number; hash: string }>();
    const prevHash = last?.hash || GENESIS_HASH;
    const event = new AuditEvent({ ...input, createdAt: input.createdAt || new Date(), seq: (last?.seq || 0) + 1, prevHash });
    event.hash = computeEventHash(prevHash, event);
    try {
      return await event.save();
    } catch (err) {
      if (!isDuplicateKeyError(err) || attempt >= MAX_APPEND_ATTEMPTS) throw err;
      // Spread the retries out a little, so a crowd of writers does not collide in lockstep.
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 5));
    }
  }
}

export type ChainCheck =
  | { ok: true; checked: number; legacyEvents: number; headHash: string }
  | { ok: false; checked: number; legacyEvents: number; brokenAt: { seq: number; id: string; type: string; createdAt: Date; reason: string } };

/**
 * Walks one company's chain from the first entry and reports OK, or the first entry that does
 * not fit. Entries from before the chain existed are counted but cannot be checked.
 */
export async function verifyAuditChain(workspaceId: Types.ObjectId): Promise<ChainCheck> {
  const legacyEvents = await AuditEvent.countDocuments({ workspaceId, seq: { $exists: false } });
  let checked = 0;
  let expectedSeq = 1;
  let expectedPrevHash = GENESIS_HASH;

  const events = AuditEvent.find({ workspaceId, seq: { $exists: true } }).sort({ seq: 1 }).lean<AuditEventDoc[]>().cursor();
  for await (const event of events) {
    const problem = (() => {
      if (event.seq !== expectedSeq) return `Entry ${expectedSeq} is missing.`;
      if (event.prevHash !== expectedPrevHash) return `Entry ${event.seq} no longer follows the one before it.`;
      if (event.hash !== computeEventHash(expectedPrevHash, event)) return `Entry ${event.seq} was changed after it was written.`;
      return "";
    })();
    if (problem) {
      // For a gap, the broken place is the missing number; the entry reported is the first one found after it.
      return { ok: false, checked, legacyEvents, brokenAt: { seq: expectedSeq, id: String(event._id), type: event.type, createdAt: event.createdAt, reason: problem } };
    }
    checked += 1;
    expectedSeq += 1;
    expectedPrevHash = event.hash as string;
  }
  return { ok: true, checked, legacyEvents, headHash: expectedPrevHash };
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
