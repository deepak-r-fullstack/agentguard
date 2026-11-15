import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { ActionRecord } from "../src/models/actionRecord.model";
import { Workspace } from "../src/models/workspace.model";
import { Agent } from "../src/models/agent.model";
import { Policy } from "../src/models/policy.model";
import { DEMO_PASSWORD, resetWorkspaceDemoData, seedDemoData, SHIFTPILOT_AGENT_NAME } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Real HTTP handlers, guard, policy checks and database; only ShiftPilot is faked (fetch).
const app = createApp();
const FIXED_KEY = `agk_${"a1".repeat(24)}`;
const PLAN = "65f0c0ffee0000000000abcd";
let calls: { method: string; path: string; secret: string | null }[];
let facts: Record<string, unknown>;
let runStatus: number, undoStatus: number, runThrows: boolean;
let acmeKey: string;

const submit = (proposalId = PLAN, key = FIXED_KEY) =>
  request(app)
    .post("/api/agent/actions")
    .set("x-agent-key", key)
    .send({ action: "schedule.applyPlan", params: { proposalId }, onBehalfOf: "coordinator@sunrise.test", idempotencyKey: crypto.randomUUID() });

async function tokenFor(email: string) {
  return (await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD })).body.data.token as string;
}
const as = (token: string) => ({ Authorization: `Bearer ${token}` });

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  Object.assign(env, { DEMO_MODE: true, SHIFTPILOT_URL: "https://shiftpilot.test", SHIFTPILOT_INTERNAL_SECRET: "sp_secret_for_tests", SHIFTPILOT_AGENT_KEY: FIXED_KEY });
  const seed = await seedDemoData();
  acmeKey = seed.agentKeys.find((k) => k.agentName === "Support Copilot")!.apiKey;
  calls = [];
  facts = { status: "applying", summary: "Cover Priya tomorrow", sandboxLabel: "Visitor 4F2A", existingVisitsChanged: 3, newVisits: 1, caregiversRemoved: 3 };
  runStatus = 200;
  undoStatus = 200;
  runThrows = false;
  jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).replace("https://shiftpilot.test", "");
    const method = init?.method || "GET";
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ method, path, secret: headers["x-shiftpilot-secret"] ?? null });
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/facts")) return new Response(JSON.stringify({ success: true, data: facts }), { status: 200 });
    if (path.endsWith("/run")) {
      if (runThrows) throw new Error("socket hang up");
      return new Response(JSON.stringify(runStatus === 200 ? { success: true, data: { applied: 4 } } : { success: false, message: "Some visits changed since this plan was made. Ask the agent again." }), { status: runStatus });
    }
    if (path.endsWith("/undo"))
      return new Response(JSON.stringify(undoStatus === 200 ? { success: true, data: { undone: 4 } } : { success: false, message: "Some visits changed after this plan was applied, so undo would overwrite newer work." }), { status: undoStatus });
    return new Response("{}", { status: 404 });
  });
});
afterEach(() => {
  jest.restoreAllMocks();
  Object.assign(env, { SHIFTPILOT_URL: "", SHIFTPILOT_INTERNAL_SECRET: "", SHIFTPILOT_AGENT_KEY: "" });
});

describe("Sunrise Home Care demo company", () => {
  it("is seeded with its people, the ShiftPilot agent on the fixed key, and two rules", async () => {
    const sunrise = await Workspace.findOne({ slug: "sunrise-home-care" }).lean();
    expect(sunrise).toMatchObject({ name: "Sunrise Home Care (demo)", currency: "USD" });
    expect(await Agent.countDocuments({ workspaceId: sunrise!._id, name: SHIFTPILOT_AGENT_NAME })).toBe(1);
    expect((await Policy.find({ workspaceId: sunrise!._id }).lean()).map((p) => p.name).sort()).toEqual(["Big schedule changes need a manager", "Normal schedule changes run"]);
    const catalog = await request(app).get("/api/agent/catalog").set("x-agent-key", FIXED_KEY);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.map((a: any) => a.key)).toContain("schedule.applyPlan");
  });

  it("keeps Sunrise's history when Acme's demo is reset", async () => {
    const res = await submit();
    expect(res.body.data.status).toBe("done");
    const acme = await Workspace.findOne({ slug: "acme-travels" }).lean();
    await resetWorkspaceDemoData(acme!._id, { type: "user", id: "x", name: "Admin" } as any);
    expect(await ActionRecord.countDocuments({ _id: res.body.data.actionId })).toBe(1);
  });
});

describe("schedule.applyPlan", () => {
  it("runs a small plan at once, calling ShiftPilot with the shared secret", async () => {
    const res = await submit();
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ status: "done", facts: { existingVisitsChanged: 3, newVisits: 1 } });
    expect(calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(1);
    expect(calls.every((c) => c.secret === "sp_secret_for_tests")).toBe(true);
  });

  it("makes a big plan wait for a manager who is not the coordinator", async () => {
    facts.existingVisitsChanged = 11;
    const res = await submit();
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe("pending_approval");
    const id = res.body.data.actionId;
    expect(calls.some((c) => c.path.endsWith("/run"))).toBe(false);

    const dana = await request(app).post(`/api/actions/${id}/approve`).set(as(await tokenFor("coordinator@sunrise.test")));
    expect(dana.status).toBe(403);
    const sam = await request(app).post(`/api/actions/${id}/approve`).set(as(await tokenFor("manager@sunrise.test")));
    expect(sam.status).toBe(200);
    expect(sam.body.data.status).toBe("done");
    expect(calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(1);
  });

  it("undoes through ShiftPilot, and refuses when ShiftPilot says the visits changed", async () => {
    const first = await submit();
    const sam = as(await tokenFor("manager@sunrise.test"));
    const undone = await request(app).post(`/api/actions/${first.body.data.actionId}/undo`).set(sam);
    expect(undone.body.data.status).toBe("undone");
    expect(calls.filter((c) => c.path === `/api/internal/plans/${PLAN}/undo`)).toHaveLength(1);

    undoStatus = 409;
    const second = await submit("65f0c0ffee0000000000abce");
    const refused = await request(app).post(`/api/actions/${second.body.data.actionId}/undo`).set(sam);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("undo would overwrite newer work");
  });

  it("passes on ShiftPilot's reason when the schedule changed before running", async () => {
    runStatus = 409;
    const res = await submit();
    expect(res.body.data.status).toBe("failed");
    expect(res.body.data.message).toContain("changed since this plan was made");
  });

  it("never retries a run that may have happened", async () => {
    runThrows = true;
    const res = await submit();
    expect(res.body.data.status).toBe("failed");
    expect(res.body.data.message).toContain("Check the plan in ShiftPilot");
    expect(calls.filter((c) => c.path.endsWith("/run"))).toHaveLength(1);
  });

  it("is refused for other companies", async () => {
    const res = await submit(PLAN, acmeKey);
    expect(res.status).toBe(403);
    expect(calls.some((c) => c.path.endsWith("/run"))).toBe(false);
  });

  it("is hidden when ShiftPilot is not connected", async () => {
    env.SHIFTPILOT_URL = "";
    const catalog = await request(app).get("/api/agent/catalog").set("x-agent-key", FIXED_KEY);
    expect(catalog.body.data.map((a: any) => a.key)).not.toContain("schedule.applyPlan");
  });

  it("is offered as an MCP tool", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("Authorization", `Bearer ${FIXED_KEY}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(res.body.result.tools.map((t: any) => t.name)).toContain("schedule_applyPlan");
  });
});
