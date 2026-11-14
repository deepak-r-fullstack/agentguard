import { z } from "zod";
import { env } from "../../config/env";
import { ConflictError, ForbiddenError, NotFoundError, ServiceUnavailableError } from "../../helpers/errors";
import { Workspace } from "../../models/workspace.model";
import type { ActionContext, ActionDefinition } from "../actions/actionRegistry";

// ---------------------------------------------------------------------------
// ShiftPilot (the scheduling assistant) sends each approved schedule plan here
// as one action. AgentGuard's rules decide (big plans wait for a manager), the
// audit trail records it, and AgentGuard calls ShiftPilot back to run the plan,
// and later to undo it. ShiftPilot re-checks its own scheduling rules and
// applies the whole plan in one transaction, or refuses with a reason.
// Only the Sunrise Home Care demo company can use this action.
// ---------------------------------------------------------------------------

export const SHIFTPILOT_WORKSPACE_SLUG = "sunrise-home-care";
const TIMEOUT_MS = 8000;

export function isShiftPilotConfigured(): boolean {
  return Boolean(env.SHIFTPILOT_URL && env.SHIFTPILOT_INTERNAL_SECRET);
}

async function assertSunrise(ctx: ActionContext) {
  if (!isShiftPilotConfigured()) throw new ServiceUnavailableError("ShiftPilot is not connected.");
  const workspace = await Workspace.findById(ctx.workspaceId).select("slug").lean();
  if (workspace?.slug !== SHIFTPILOT_WORKSPACE_SLUG) throw new ForbiddenError("Only the Sunrise Home Care company can apply schedule plans.");
}

// Server-owned address and secret, no redirects, no automatic retries of writes, sanitized errors.
async function shiftpilot(path: string, method: "GET" | "POST"): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(`${env.SHIFTPILOT_URL.replace(/\/+$/, "")}${path}`, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "x-shiftpilot-secret": env.SHIFTPILOT_INTERNAL_SECRET, "content-type": "application/json" },
    });
  } catch {
    throw new ServiceUnavailableError("ShiftPilot did not answer. Check the plan in ShiftPilot before trying again; it may already have been applied.");
  }
  const body = (await response.json().catch(() => ({}))) as { message?: string; data?: Record<string, unknown> };
  // ShiftPilot's own plain-language messages (a rule broke, a visit changed) are safe to pass on.
  const message = typeof body.message === "string" ? body.message.slice(0, 300) : "";
  if (response.status === 404) throw new NotFoundError(message || "ShiftPilot could not find that plan.");
  if (response.status === 409) throw new ConflictError(message || "The schedule changed since this plan was made.");
  if (response.status === 401 || response.status === 403) throw new ForbiddenError("ShiftPilot refused the connection. Check the shared secret.");
  if (!response.ok || !body.data) throw new ServiceUnavailableError("ShiftPilot could not complete the request. Check the plan in ShiftPilot.");
  return body.data;
}

const paramsSchema = z.object({ proposalId: z.string().regex(/^[a-f0-9]{24}$/, "A ShiftPilot plan id") }).strict();
type Params = z.infer<typeof paramsSchema>;
const snapshotSchema = z.object({ proposalId: z.string() });
type Snapshot = z.infer<typeof snapshotSchema>;

const factNumber = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export const shiftpilotPlanAction: ActionDefinition<Params, Snapshot> = {
  key: "schedule.applyPlan",
  label: "Apply a schedule plan",
  description:
    "Applies a home care schedule plan that a coordinator approved in ShiftPilot: covers, moves, cancels or adds visits. ShiftPilot re-checks every scheduling rule and applies all changes together. Undo puts every visit back.",
  irreversible: false,
  paramsSchema,
  ruleFields: [
    { path: "facts.existingVisitsChanged", label: "Existing visits changed", type: "number" },
    { path: "facts.newVisits", label: "New visits added", type: "number" },
    { path: "facts.caregiversRemoved", label: "Visits taken from their caregiver", type: "number" },
    { path: "agentName", label: "Agent name", type: "string" },
    { path: "onBehalfOf", label: "Requested by (person)", type: "string" },
  ],
  moneyFields: { facts: [], result: [] },
  exampleParams: { proposalId: "65f0c0ffee0000000000abcd" },
  async prepare(params, ctx) {
    await assertSunrise(ctx);
    const facts = await shiftpilot(`/api/internal/plans/${params.proposalId}/facts`, "GET");
    if (["applied", "undone", "denied"].includes(String(facts.status))) throw new ConflictError("This plan was already handled in ShiftPilot.");
    const existing = factNumber(facts.existingVisitsChanged);
    const added = factNumber(facts.newVisits);
    return {
      facts: {
        existingVisitsChanged: existing,
        newVisits: added,
        caregiversRemoved: factNumber(facts.caregiversRemoved),
        visitor: String(facts.sandboxLabel ?? "").slice(0, 40),
      },
      summary: `Apply schedule plan for ${String(facts.sandboxLabel ?? "ShiftPilot").slice(0, 40)}: ${String(facts.summary ?? "").slice(0, 160)} (${existing} visit${existing === 1 ? "" : "s"} changed, ${added} added)`,
    };
  },
  async snapshot(params, ctx) {
    await assertSunrise(ctx);
    // ShiftPilot keeps the visits' before-state itself, with version checks; the plan id is all undo needs.
    return { proposalId: params.proposalId };
  },
  async run(params, ctx) {
    await assertSunrise(ctx);
    const result = await shiftpilot(`/api/internal/plans/${params.proposalId}/run`, "POST");
    return { proposalId: params.proposalId, applied: factNumber(result.applied) };
  },
  async undo(rawSnapshot, ctx) {
    await assertSunrise(ctx);
    const snapshot = snapshotSchema.parse(rawSnapshot);
    await shiftpilot(`/api/internal/plans/${snapshot.proposalId}/undo`, "POST");
  },
};
