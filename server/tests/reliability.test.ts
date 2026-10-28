import crypto from "crypto";
import { Types } from "mongoose";
import request from "supertest";
import { createApp } from "../src/app";
import { Booking, Customer } from "../src/models/demo.model";
import { ActionRecord } from "../src/models/actionRecord.model";
import { AuditEvent } from "../src/models/auditEvent.model";
import { UsageCounter } from "../src/models/usageCounter.model";
import { recoverInterruptedActions } from "../src/services/actions/recovery.service";
import { expireOverdueApprovals } from "../src/services/approvals/approvalExpiry.service";
import { GENESIS_HASH, recordAuditEvent, SYSTEM_ACTOR, verifyAuditChain } from "../src/services/audit/audit.service";
import { DEMO_PASSWORD, seedDemoData, SeedResult } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The four reliability fixes, end to end: daily limits that cannot be raced, recovery of interrupted
// actions, approvals that expire, and the tamper-evident audit log. Real HTTP API, real (in-memory) MongoDB.

const app = createApp();
let seed: SeedResult;
let acmeAgentKey: string;
let globexAgentKey: string;
let acmeWorkspaceId: Types.ObjectId;
let globexWorkspaceId: Types.ObjectId;

const newKey = () => crypto.randomUUID();
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);
const HOUR_MS = 60 * 60 * 1000;

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}
const authed = (token: string) => ({ authorization: `Bearer ${token}` });

function agentRequest(body: Record<string, unknown>, key = acmeAgentKey) {
  return request(app)
    .post("/api/agent/actions")
    .set("x-agent-key", key)
    .send({ onBehalfOf: "Ravi (support team)", reason: "Customer asked in chat", idempotencyKey: newKey(), ...body });
}
const cancel = (bookingCode: string) => agentRequest({ action: "booking.cancel", params: { bookingCode } });

// MCP: the same guard behind a different door.
async function mcpStatus(actionId: string) {
  const res = await request(app)
    .post("/api/mcp")
    .set("accept", "application/json, text/event-stream")
    .set("authorization", `Bearer ${acmeAgentKey}`)
    .send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_action_status", arguments: { actionId } } });
  expect(res.status).toBe(200);
  return JSON.parse(res.body.result.content[0].text) as { status: string; message: string };
}

// Used today across all of Acme's daily limits (the demo has one: a per-agent refund cap).
async function usedToday() {
  const counters = await UsageCounter.find({ workspaceId: acmeWorkspaceId }).lean();
  return counters.reduce((sum, counter) => sum + counter.total, 0);
}

// Moves a record into a state the app itself would only reach through a crash or a long wait.
function forceState(actionId: string, fields: Record<string, unknown>) {
  return ActionRecord.collection.updateOne({ _id: new Types.ObjectId(actionId) }, { $set: fields });
}

async function auditChain(workspaceId = acmeWorkspaceId) {
  return AuditEvent.find({ workspaceId, seq: { $exists: true } }).sort({ seq: 1 }).lean();
}

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  seed = await seedDemoData();
  acmeAgentKey = seed.agentKeys.find((key) => key.agentName === "Support Copilot")!.apiKey;
  globexAgentKey = seed.agentKeys.find((key) => key.agentName === "Globex Assistant")!.apiKey;
  acmeWorkspaceId = new Types.ObjectId(seed.workspaces.find((workspace) => workspace.name === "Acme Travels")!.workspaceId);
  globexWorkspaceId = new Types.ObjectId(seed.workspaces.find((workspace) => workspace.name === "Globex Holidays")!.workspaceId);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("daily limits cannot be raced", () => {
  it("never goes over the limit when 10 requests arrive at the same instant", async () => {
    // Ten ₹3,000 bookings, each small enough to run alone. The cap is ₹20,000, so exactly six fit.
    const customer = await Customer.findOne({ workspaceId: acmeWorkspaceId, code: "CU-101" }).lean();
    const codes = Array.from({ length: 10 }, (_, index) => `BK-90${String(index + 1).padStart(2, "0")}`);
    await Booking.insertMany(
      codes.map((code) => ({ workspaceId: acmeWorkspaceId, code, customerId: customer!._id, title: "Race test stay", startsAt: new Date(Date.now() + 10 * 24 * HOUR_MS), amount: 3000 }))
    );

    const results = await Promise.all(codes.map((code) => cancel(code)));
    const statuses = results.map((res) => res.body.data.status as string);

    expect(statuses.filter((status) => status === "done")).toHaveLength(6);
    expect(statuses.filter((status) => status === "denied")).toHaveLength(4);
    const refunded = (await Booking.find({ workspaceId: acmeWorkspaceId, code: { $in: codes }, status: "cancelled" }).lean()).reduce(
      (sum, booking) => sum + booking.refundAmount,
      0
    );
    expect(refunded).toBe(18000);
    expect(refunded).toBeLessThanOrEqual(20000);
    // The counter agrees with what really happened, and the refused requests hold nothing.
    expect(await usedToday()).toBe(18000);
  });

  it("holds the same line for pending requests that arrive together", async () => {
    // Two ₹18,500 requests cannot both wait: only one fits under the ₹20,000 cap.
    await Booking.updateOne({ workspaceId: acmeWorkspaceId, code: "BK-1008" }, { $set: { amount: 18500 } });
    const [first, second] = await Promise.all([cancel("BK-1005"), cancel("BK-1008")]);
    const statuses = [first.body.data.status, second.body.data.status].sort();
    expect(statuses).toEqual(["denied", "pending_approval"]);
    expect(await usedToday()).toBe(18500);
  });

  it("gives the room back when a waiting request is rejected", async () => {
    const big = await cancel("BK-1005"); // ₹18,500, waiting
    expect((await cancel("BK-1002")).body.data.status).toBe("denied");
    const manager = await loginAs("manager@acme.test");
    const rejected = await request(app).post(`/api/actions/${big.body.data.actionId}/reject`).set(authed(manager)).send({ note: "no" });
    expect(rejected.status).toBe(200);
    expect(await usedToday()).toBe(0);
    expect((await cancel("BK-1002")).body.data.status).toBe("done");
  });

  it("gives the room back when an action is undone", async () => {
    for (const code of ["BK-1002", "BK-1003", "BK-1004", "BK-1006"]) expect((await cancel(code)).body.data.status).toBe("done"); // ₹17,400
    const manager = await loginAs("manager@acme.test");
    const undo = await request(app)
      .post(`/api/actions/${(await ActionRecord.findOne({ workspaceId: acmeWorkspaceId, status: "done", "facts.amount": 4500 }).lean())!._id}/undo`)
      .set(authed(manager));
    expect(undo.status).toBe(200);
    expect(await usedToday()).toBe(12900);
    expect((await cancel("BK-1007")).body.data.status).toBe("done"); // 12,900 + 4,900 fits; it would not have before the undo
  });

  it("gives the room back when an action fails", async () => {
    jest.spyOn(Booking, "findOneAndUpdate").mockRejectedValueOnce(new Error("the booking system is down"));
    const res = await cancel("BK-1002");
    expect(res.body.data.status).toBe("failed");
    expect(await usedToday()).toBe(0);
  });

  it("holds nothing for a refused request, and an undo that fails keeps the room", async () => {
    for (const code of ["BK-1002", "BK-1003", "BK-1004", "BK-1006"]) await cancel(code);
    expect((await cancel("BK-1007")).body.data.status).toBe("denied");
    expect(await usedToday()).toBe(17400);

    // Someone re-confirms BK-1002 by hand, so its undo is refused and the action stays done (and counted).
    await Booking.updateOne({ workspaceId: acmeWorkspaceId, code: "BK-1002" }, { $set: { status: "confirmed", refundAmount: 0 } });
    const manager = await loginAs("manager@acme.test");
    const record = await ActionRecord.findOne({ workspaceId: acmeWorkspaceId, "facts.amount": 4500 }).lean();
    const undo = await request(app).post(`/api/actions/${record!._id}/undo`).set(authed(manager));
    expect(undo.status).toBe(409);
    expect(await usedToday()).toBe(17400);
  });

  it("releases room only once, however many times release is triggered", async () => {
    const big = await cancel("BK-1005");
    const manager = await loginAs("manager@acme.test");
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request(app).post(`/api/actions/${big.body.data.actionId}/reject`).set(authed(manager)).send({}))
    );
    expect(results.filter((res) => res.status === 200)).toHaveLength(1);
    expect(await usedToday()).toBe(0); // not negative
  });

  it("counts what was already used today when a counter is first created", async () => {
    // An action that ran before counters existed: it must still count towards today's limit.
    const done = await cancel("BK-1002");
    expect(done.body.data.status).toBe("done");
    await UsageCounter.deleteMany({ workspaceId: acmeWorkspaceId });
    for (const code of ["BK-1003", "BK-1004", "BK-1006"]) await cancel(code); // 4,500 + 3,900 + 4,800 + 4,200 = 17,400
    expect(await usedToday()).toBe(17400);
    expect((await cancel("BK-1007")).body.data.status).toBe("denied");
  });
});

describe("recovery of interrupted actions", () => {
  async function approvedAndStuck() {
    const res = await cancel("BK-1001"); // ₹7,500: waits for a person
    const actionId = res.body.data.actionId as string;
    await forceState(actionId, { status: "executing", approvedBy: "Karan Shah", updatedAt: minutesAgo(30) });
    return actionId;
  }

  it("marks an action stuck in 'executing' as failed, with a clear message and an audit event", async () => {
    const actionId = await approvedAndStuck();
    expect(await recoverInterruptedActions()).toBe(1);

    const record = await ActionRecord.findById(actionId).lean();
    expect(record?.status).toBe("failed");
    expect(record?.errorMessage).toBe("This action was interrupted; please check the booking.");
    const event = await AuditEvent.findOne({ actionId, type: "action_failed" }).lean();
    expect(event?.actor?.type).toBe("system");
    expect(event?.summary).toContain("interrupted; please check the booking");
    expect(await usedToday()).toBe(0); // a failed action no longer holds daily-limit room

    const status = await request(app).get(`/api/agent/actions/${actionId}`).set("x-agent-key", acmeAgentKey);
    expect(status.body.data.status).toBe("failed");
    expect(status.body.data.message).toContain("interrupted");
  });

  it("moves an action stuck in 'undoing' back to 'done', with an audit event", async () => {
    const res = await cancel("BK-1002");
    const actionId = res.body.data.actionId as string;
    await forceState(actionId, { status: "undoing", updatedAt: minutesAgo(30) });

    expect(await recoverInterruptedActions()).toBe(1);
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("done");
    const event = await AuditEvent.findOne({ actionId, type: "undo_failed" }).lean();
    expect(event?.actor?.type).toBe("system");
    expect(event?.summary).toContain("interrupted");
    expect(await usedToday()).toBe(4500); // it was never undone, so it still counts
  });

  it("leaves actions that are only just running alone", async () => {
    const res = await cancel("BK-1001");
    await forceState(res.body.data.actionId, { status: "executing", updatedAt: minutesAgo(1) });
    expect(await recoverInterruptedActions()).toBe(0);
    expect((await ActionRecord.findById(res.body.data.actionId).lean())?.status).toBe("executing");
  });

  it("is safe when several servers run it at the same moment: each action is settled once", async () => {
    const actionId = await approvedAndStuck();
    const counts = await Promise.all(Array.from({ length: 6 }, () => recoverInterruptedActions()));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await AuditEvent.countDocuments({ actionId, type: "action_failed" })).toBe(1);
  });

  it("a slow action that finishes after recovery gave up on it does not overwrite what recovery decided", async () => {
    const waiting = await cancel("BK-1001");
    const actionId = waiting.body.data.actionId as string;
    // While the booking system is "slow", the action looks abandoned and another server's recovery job settles it.
    const original = Booking.findOneAndUpdate.bind(Booking) as (...args: unknown[]) => unknown;
    jest.spyOn(Booking, "findOneAndUpdate").mockImplementationOnce(((...args: unknown[]) =>
      (async () => {
        await forceState(actionId, { updatedAt: minutesAgo(30) });
        await recoverInterruptedActions();
        return original(...args);
      })()) as never);

    const manager = await loginAs("manager@acme.test");
    const approve = await request(app).post(`/api/actions/${actionId}/approve`).set(authed(manager));
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe("failed"); // the late "done" did not win
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("failed");
    expect(await AuditEvent.countDocuments({ actionId, type: "action_executed" })).toBe(0);
    expect(await AuditEvent.countDocuments({ actionId, type: "action_failed" })).toBe(1);
  });
});

describe("approvals that expire", () => {
  it("gives each waiting request an expiry time: 24 hours by default", async () => {
    const res = await cancel("BK-1001");
    expect(res.status).toBe(202);
    const record = await ActionRecord.findById(res.body.data.actionId).lean();
    expect(Math.abs(record!.expiresAt!.getTime() - (Date.now() + 24 * HOUR_MS))).toBeLessThan(60 * 1000);
    expect(new Date(res.body.data.expiresAt).getTime()).toBe(record!.expiresAt!.getTime()); // the agent is told when
    // Requests that need no person never get one.
    const auto = await cancel("BK-1002");
    expect((await ActionRecord.findById(auto.body.data.actionId).lean())?.expiresAt).toBeUndefined();
  });

  it("lets an admin change the wait on the Rules screen, for new requests only", async () => {
    const waiting = await cancel("BK-1001");
    const admin = await loginAs("admin@acme.test");
    const saved = await request(app).put("/api/settings/approvals").set(authed(admin)).send({ approvalExpiryHours: 48 });
    expect(saved.status).toBe(200);
    expect(saved.body.data.approvalExpiryHours).toBe(48);

    const record = await ActionRecord.findById((await cancel("BK-1005")).body.data.actionId).lean();
    expect(Math.abs(record!.expiresAt!.getTime() - (Date.now() + 48 * HOUR_MS))).toBeLessThan(60 * 1000);
    const earlier = await ActionRecord.findById(waiting.body.data.actionId).lean();
    expect(Math.abs(earlier!.expiresAt!.getTime() - (Date.now() + 24 * HOUR_MS))).toBeLessThan(60 * 1000);

    const manager = await loginAs("manager@acme.test");
    expect((await request(app).get("/api/settings/approvals").set(authed(manager))).body.data.approvalExpiryHours).toBe(48);
    const event = await AuditEvent.findOne({ type: "settings_updated" }).lean();
    expect(event?.summary).toContain("from 24 to 48 hours");
    // Saving the same number again is not a change.
    await request(app).put("/api/settings/approvals").set(authed(admin)).send({ approvalExpiryHours: 48 });
    expect(await AuditEvent.countDocuments({ type: "settings_updated" })).toBe(1);
  });

  it("only lets admins change it, and only to a sensible number of hours", async () => {
    const manager = await loginAs("manager@acme.test");
    expect((await request(app).put("/api/settings/approvals").set(authed(manager)).send({ approvalExpiryHours: 48 })).status).toBe(403);
    const admin = await loginAs("admin@acme.test");
    for (const bad of [0, -5, 1.5, 100000, "soon", null]) {
      expect((await request(app).put("/api/settings/approvals").set(authed(admin)).send({ approvalExpiryHours: bad })).status).toBe(400);
    }
  });

  it("expires an overdue request: frees its daily-limit room, writes an audit event, and agents see 'expired'", async () => {
    const big = await cancel("BK-1005"); // ₹18,500, waiting
    const actionId = big.body.data.actionId as string;
    expect((await cancel("BK-1002")).body.data.status).toBe("denied"); // the waiting request holds the room
    await forceState(actionId, { expiresAt: new Date(Date.now() - 1000) });

    expect(await expireOverdueApprovals()).toBe(1);

    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("expired");
    expect(await usedToday()).toBe(0);
    const event = await AuditEvent.findOne({ actionId, type: "action_expired" }).lean();
    expect(event?.actor?.type).toBe("system");
    expect((await cancel("BK-1002")).body.data.status).toBe("done"); // the room is free again

    const rest = await request(app).get(`/api/agent/actions/${actionId}`).set("x-agent-key", acmeAgentKey);
    expect(rest.body.data.status).toBe("expired");
    expect(rest.body.data.message).toContain("expired");
    expect(rest.body.data).not.toHaveProperty("expiresAt");
    const mcp = await mcpStatus(actionId);
    expect(mcp.status).toBe("expired");
    expect(mcp.message).toContain("expired");
  });

  it("can no longer be approved or rejected once expired", async () => {
    const res = await cancel("BK-1001");
    const actionId = res.body.data.actionId as string;
    await forceState(actionId, { expiresAt: new Date(Date.now() - 1000) });
    await expireOverdueApprovals();

    const manager = await loginAs("manager@acme.test");
    const approve = await request(app).post(`/api/actions/${actionId}/approve`).set(authed(manager));
    expect(approve.status).toBe(409);
    expect(approve.body.message).toContain("expired");
    const reject = await request(app).post(`/api/actions/${actionId}/reject`).set(authed(manager)).send({});
    expect(reject.status).toBe(409);
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("confirmed");
  });

  it("refuses to approve an overdue request even before the sweep has run, and expires it on the spot", async () => {
    const res = await cancel("BK-1001");
    const actionId = res.body.data.actionId as string;
    await forceState(actionId, { expiresAt: new Date(Date.now() - 1000) });

    const manager = await loginAs("manager@acme.test");
    const approve = await request(app).post(`/api/actions/${actionId}/approve`).set(authed(manager));
    expect(approve.status).toBe(409);
    expect(approve.body.message).toContain("expired");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("expired");
    expect(await AuditEvent.countDocuments({ actionId, type: "action_expired" })).toBe(1);
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("confirmed");
  });

  it("does not expire a request that is still inside its time", async () => {
    const res = await cancel("BK-1001");
    expect(await expireOverdueApprovals()).toBe(0);
    const manager = await loginAs("manager@acme.test");
    const approve = await request(app).post(`/api/actions/${res.body.data.actionId}/approve`).set(authed(manager));
    expect(approve.status).toBe(200);
    expect(approve.body.data.status).toBe("done");
  });

  it("is safe when several servers sweep at the same moment: expired once, audited once", async () => {
    const res = await cancel("BK-1001");
    const actionId = res.body.data.actionId as string;
    await forceState(actionId, { expiresAt: new Date(Date.now() - 1000) });
    const counts = await Promise.all(Array.from({ length: 6 }, () => expireOverdueApprovals()));
    expect(counts.reduce((sum, count) => sum + count, 0)).toBe(1);
    expect(await AuditEvent.countDocuments({ actionId, type: "action_expired" })).toBe(1);
  });

  it("an approval that wins the race against the sweep is not expired afterwards", async () => {
    const res = await cancel("BK-1001");
    const actionId = res.body.data.actionId as string;
    const manager = await loginAs("manager@acme.test");
    await request(app).post(`/api/actions/${actionId}/approve`).set(authed(manager));
    await forceState(actionId, { expiresAt: new Date(Date.now() - 1000) });
    expect(await expireOverdueApprovals()).toBe(0);
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("done");
  });

  it("gives requests that were already waiting before expiry existed a fresh deadline instead of expiring them", async () => {
    const res = await cancel("BK-1001");
    const actionId = res.body.data.actionId as string;
    await ActionRecord.collection.updateOne({ _id: new Types.ObjectId(actionId) }, { $unset: { expiresAt: 1 } });
    expect(await expireOverdueApprovals()).toBe(0);
    const record = await ActionRecord.findById(actionId).lean();
    expect(record?.status).toBe("pending_approval");
    expect(Math.abs(record!.expiresAt!.getTime() - (Date.now() + 24 * HOUR_MS))).toBeLessThan(60 * 1000);
  });

  it("only sweeps waiting requests", async () => {
    const done = await cancel("BK-1002");
    await forceState(done.body.data.actionId, { expiresAt: new Date(Date.now() - 1000) });
    expect(await expireOverdueApprovals()).toBe(0);
    expect((await ActionRecord.findById(done.body.data.actionId).lean())?.status).toBe("done");
  });
});

describe("tamper-evident audit log", () => {
  async function someHistory() {
    await cancel("BK-1002");
    const waiting = await cancel("BK-1001");
    const manager = await loginAs("manager@acme.test");
    await request(app).post(`/api/actions/${waiting.body.data.actionId}/approve`).set(authed(manager));
    return manager;
  }

  it("numbers every event and links each one to the one before", async () => {
    await someHistory();
    const events = await auditChain();
    expect(events.length).toBeGreaterThanOrEqual(6);
    events.forEach((event, index) => {
      expect(event.seq).toBe(index + 1);
      expect(event.prevHash).toBe(index === 0 ? GENESIS_HASH : events[index - 1].hash);
      expect(event.hash).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("GET /api/audit/verify reports OK for an untouched history (every role may ask)", async () => {
    await someHistory();
    const events = await auditChain();
    for (const email of ["auditor@acme.test", "manager@acme.test", "admin@acme.test"]) {
      const res = await request(app).get("/api/audit/verify").set(authed(await loginAs(email)));
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ ok: true, checked: events.length, legacyEvents: 0, headHash: events[events.length - 1].hash });
    }
    expect((await request(app).get("/api/audit/verify")).status).toBe(401);
  });

  it("an empty history is fine", async () => {
    const res = await request(app).get("/api/audit/verify").set(authed(await loginAs("auditor@acme.test")));
    expect(res.body.data).toMatchObject({ ok: true, checked: 0, headHash: GENESIS_HASH });
  });

  it("reports the first entry that was edited", async () => {
    const manager = await someHistory();
    await AuditEvent.collection.updateOne({ workspaceId: acmeWorkspaceId, seq: 3 }, { $set: { summary: "Nothing to see here" } });
    const res = await request(app).get("/api/audit/verify").set(authed(manager));
    expect(res.status).toBe(200);
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.checked).toBe(2);
    expect(res.body.data.brokenAt).toMatchObject({ seq: 3, reason: "Entry 3 was changed after it was written." });
  });

  it("reports an entry that was removed", async () => {
    const manager = await someHistory();
    await AuditEvent.collection.deleteOne({ workspaceId: acmeWorkspaceId, seq: 2 });
    const res = await request(app).get("/api/audit/verify").set(authed(manager));
    expect(res.body.data.ok).toBe(false);
    expect(res.body.data.brokenAt).toMatchObject({ seq: 2, reason: "Entry 2 is missing." });
  });

  it("reports the start of the history being cut off", async () => {
    const manager = await someHistory();
    await AuditEvent.collection.deleteOne({ workspaceId: acmeWorkspaceId, seq: 1 });
    const res = await request(app).get("/api/audit/verify").set(authed(manager));
    expect(res.body.data.brokenAt).toMatchObject({ seq: 1, reason: "Entry 1 is missing." });
  });

  it("reports an entry whose link to the one before it was changed", async () => {
    const manager = await someHistory();
    await AuditEvent.collection.updateOne({ workspaceId: acmeWorkspaceId, seq: 2 }, { $set: { prevHash: "f".repeat(64) } });
    const res = await request(app).get("/api/audit/verify").set(authed(manager));
    expect(res.body.data.brokenAt).toMatchObject({ seq: 2, reason: "Entry 2 no longer follows the one before it." });
  });

  it("covers each company on its own", async () => {
    await someHistory();
    await AuditEvent.collection.updateOne({ workspaceId: acmeWorkspaceId, seq: 1 }, { $set: { summary: "Edited" } });
    const globex = await loginAs("manager@globex.test");
    expect((await agentRequest({ action: "booking.cancel", params: { bookingCode: "BK-2001" } }, globexAgentKey)).body.data.status).toBe("done");
    const res = await request(app).get("/api/audit/verify").set(authed(globex));
    expect(res.body.data).toMatchObject({ ok: true });
    expect(res.body.data.checked).toBeGreaterThan(0);
    expect((await verifyAuditChain(acmeWorkspaceId)).ok).toBe(false);
    expect(await AuditEvent.countDocuments({ workspaceId: globexWorkspaceId, seq: 1 })).toBe(1);
  });

  it("copes with 40 events written at the same instant: no duplicate numbers, no gaps, chain intact", async () => {
    const workspaceId = new Types.ObjectId(); // a company of its own, so nothing else writes to it
    await Promise.all(
      Array.from({ length: 40 }, (_, index) =>
        recordAuditEvent({ workspaceId, type: "policy_created", actor: SYSTEM_ACTOR, summary: `Event ${index}` })
      )
    );
    const events = await auditChain(workspaceId);
    expect(events.map((event) => event.seq)).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
    expect(await verifyAuditChain(workspaceId)).toMatchObject({ ok: true, checked: 40 });
  });

  it("the database itself refuses two events with the same number", async () => {
    await recordAuditEvent({ workspaceId: acmeWorkspaceId, type: "policy_created", actor: SYSTEM_ACTOR, summary: "One" });
    const [first] = await auditChain();
    await expect(
      AuditEvent.collection.insertOne({ workspaceId: acmeWorkspaceId, type: "policy_created", actor: first.actor, summary: "Clash", seq: first.seq, prevHash: "x", hash: "y", createdAt: new Date() })
    ).rejects.toMatchObject({ code: 11000 });
  });

  it("leaves entries from before the chain existed outside it, and says how many", async () => {
    const old = { workspaceId: acmeWorkspaceId, type: "policy_created", actor: { type: "user", id: "u1", name: "Old" }, summary: "Old entry", onBehalfOf: "" };
    // Two of them: the unique number must not apply to entries that have none.
    await AuditEvent.collection.insertOne({ ...old, createdAt: new Date(Date.now() - 5 * HOUR_MS) });
    await AuditEvent.collection.insertOne({ ...old, createdAt: new Date(Date.now() - 4 * HOUR_MS) });
    await someHistory();
    const res = await request(app).get("/api/audit/verify").set(authed(await loginAs("auditor@acme.test")));
    expect(res.body.data).toMatchObject({ ok: true, legacyEvents: 2 });
    expect((await auditChain())[0].seq).toBe(1);
  });

  it("a demo reset starts a new chain with a 'chain_started' event, and keeps the record of who was added", async () => {
    const admin = await loginAs("admin@acme.test");
    await someHistory();
    const added = await request(app).post("/api/team").set(authed(admin)).send({ name: "Divya Pillai", email: "divya@acme.test", role: "manager" });
    expect(added.status).toBe(201);
    const oldLength = (await auditChain()).length;
    expect(oldLength).toBeGreaterThan(5);
    const addedEvent = await AuditEvent.findOne({ workspaceId: acmeWorkspaceId, type: "user_added" }).lean();

    const reset = await request(app).post("/api/demo/reset").set(authed(admin));
    expect(reset.status).toBe(200);

    const events = await auditChain();
    expect(events.map((event) => event.type)).toEqual(["chain_started", "user_added", "demo_reset"]);
    expect(events.map((event) => event.seq)).toEqual([1, 2, 3]);
    expect(events[0].prevHash).toBe(GENESIS_HASH);
    // The old history is gone, and so are the old counters.
    expect(await AuditEvent.countDocuments({ workspaceId: acmeWorkspaceId, type: "action_requested" })).toBe(0);
    expect(await UsageCounter.countDocuments({ workspaceId: acmeWorkspaceId })).toBe(0);
    const verify = await request(app).get("/api/audit/verify").set(authed(admin));
    expect(verify.body.data).toMatchObject({ ok: true, checked: 3 });

    // The entry that was carried over keeps its original time and wording.
    expect(events[1].createdAt).toEqual(addedEvent!.createdAt);
    expect(events[1].summary).toBe(addedEvent!.summary);
    const list = await request(app).get("/api/audit").set(authed(admin));
    expect(list.body.data.map((event: { type: string }) => event.type)).toEqual(expect.arrayContaining(["chain_started", "user_added", "demo_reset"]));
  });
});
