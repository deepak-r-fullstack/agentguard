import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { Booking } from "../src/models/demo.model";
import { ActionRecord } from "../src/models/actionRecord.model";
import { AuditEvent } from "../src/models/auditEvent.model";
import { Workspace } from "../src/models/workspace.model";
import { DEMO_PASSWORD, seedDemoData, SeedResult } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// End-to-end tests through the real HTTP API, with a real (in-memory) MongoDB.

const app = createApp();
let seed: SeedResult;
let acmeAgentKey: string;
let globexAgentKey: string;

const newKey = () => crypto.randomUUID();

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

function agentRequest(key: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/agent/actions")
    .set("x-agent-key", key)
    .send({ onBehalfOf: "Ravi (support team)", reason: "Customer asked in chat", idempotencyKey: newKey(), ...body });
}

const cancel = (bookingCode: string, key = acmeAgentKey) =>
  agentRequest(key, { action: "booking.cancel", params: { bookingCode } });

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
});

describe("agent authentication", () => {
  it("rejects requests without a valid agent key", async () => {
    const res = await request(app).post("/api/agent/actions").send({});
    expect(res.status).toBe(401);
    const bad = await agentRequest("agk_not_a_real_key", { action: "booking.cancel", params: { bookingCode: "BK-1002" } });
    expect(bad.status).toBe(401);
  });
});

describe("policy decisions", () => {
  it("runs a small cancellation immediately", async () => {
    const res = await cancel("BK-1002");
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("done");
    const booking = await Booking.findOne({ code: "BK-1002" }).lean();
    expect(booking?.status).toBe("cancelled");
    expect(booking?.refundAmount).toBe(4500);
  });

  it("holds a big cancellation for a manager, then runs it once approved", async () => {
    const res = await cancel("BK-1001");
    expect(res.status).toBe(202);
    expect(res.body.data.status).toBe("pending_approval");
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("confirmed");

    const token = await loginAs("manager@acme.test");
    const approved = await request(app)
      .post(`/api/actions/${res.body.data.actionId}/approve`)
      .set("authorization", `Bearer ${token}`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("done");
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("cancelled");

    // The agent can check the outcome with its own key.
    const status = await request(app)
      .get(`/api/agent/actions/${res.body.data.actionId}`)
      .set("x-agent-key", acmeAgentKey);
    expect(status.body.data.status).toBe("done");
  });

  it("blocks the split attack: many small refunds that add up past the daily cap", async () => {
    // 4,500 + 3,900 + 4,800 + 4,200 = 17,400 (each small enough to run on its own)
    for (const code of ["BK-1002", "BK-1003", "BK-1004", "BK-1006"]) {
      const res = await cancel(code);
      expect(res.body.data.status).toBe("done");
    }
    // + 4,900 = 22,300, over the 20,000 cap
    const fifth = await cancel("BK-1007");
    expect(fifth.status).toBe(200);
    expect(fifth.body.data.status).toBe("denied");
    expect(fifth.body.data.reasons.join(" ")).toContain("22,300");
    expect((await Booking.findOne({ code: "BK-1007" }).lean())?.status).toBe("confirmed");
  });

  it("counts pending requests towards the cap, so queuing does not get around it", async () => {
    const big = await cancel("BK-1005"); // 18,500 -> pending approval
    expect(big.body.data.status).toBe("pending_approval");
    const small = await cancel("BK-1002"); // 18,500 + 4,500 > 20,000
    expect(small.body.data.status).toBe("denied");
  });

  it("never auto-runs an action that cannot be undone", async () => {
    const res = await agentRequest(acmeAgentKey, {
      action: "notification.sendEmail",
      params: { customerCode: "CU-101", subject: "Hello", body: "Your trip is confirmed." },
    });
    expect(res.status).toBe(202);
    expect(res.body.data.reasons.join(" ")).toMatch(/cannot be undone|must approve/);
  });

  it("asks a person when no rule covers an action", async () => {
    const res = await agentRequest(acmeAgentKey, {
      action: "customer.updateEmail",
      params: { customerCode: "CU-101", email: "priya.new@example.com" },
    });
    expect(res.body.data.status).toBe("pending_approval");
  });
});

describe("trust boundaries", () => {
  it("does not let an agent touch another company's data", async () => {
    const res = await cancel("BK-2001"); // Globex booking, Acme agent
    expect(res.status).toBe(404);
    expect((await Booking.findOne({ code: "BK-2001" }).lean())?.status).toBe("confirmed");

    // Globex's own agent can.
    const own = await cancel("BK-2001", globexAgentKey);
    expect(own.body.data.status).toBe("done");
  });

  it("rejects params the action does not define (the agent cannot claim its own amount)", async () => {
    const res = await agentRequest(acmeAgentKey, {
      action: "booking.cancel",
      params: { bookingCode: "BK-1001", amount: 1 },
    });
    expect(res.status).toBe(400);
  });

  it("blocks and audits unregistered actions", async () => {
    const res = await agentRequest(acmeAgentKey, { action: "database.dropEverything", params: {} });
    expect(res.status).toBe(400);
    const event = await AuditEvent.findOne({ type: "action_denied" }).lean();
    expect(event?.summary).toContain("unregistered action");
  });

  it("does not let auditors approve", async () => {
    const res = await cancel("BK-1001");
    const token = await loginAs("auditor@acme.test");
    const approve = await request(app)
      .post(`/api/actions/${res.body.data.actionId}/approve`)
      .set("authorization", `Bearer ${token}`);
    expect(approve.status).toBe(403);
  });

  it("does not let a manager approve work requested on their own behalf", async () => {
    const res = await agentRequest(acmeAgentKey, {
      action: "booking.cancel",
      params: { bookingCode: "BK-1001" },
      onBehalfOf: "manager@acme.test",
    });
    const token = await loginAs("manager@acme.test");
    const approve = await request(app)
      .post(`/api/actions/${res.body.data.actionId}/approve`)
      .set("authorization", `Bearer ${token}`);
    expect(approve.status).toBe(403);
  });

  it("hides another workspace's actions from people too", async () => {
    const res = await cancel("BK-1001");
    const globexToken = await loginAs("manager@globex.test");
    const detail = await request(app)
      .get(`/api/actions/${res.body.data.actionId}`)
      .set("authorization", `Bearer ${globexToken}`);
    expect(detail.status).toBe(404);
  });
});

describe("idempotency", () => {
  it("returns the first result when the same request is retried", async () => {
    const idempotencyKey = newKey();
    const first = await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" }, idempotencyKey });
    const second = await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" }, idempotencyKey });
    expect(second.body.data.actionId).toBe(first.body.data.actionId);
    expect(await ActionRecord.countDocuments({ idempotencyKey })).toBe(1);
  });

  it("refuses to reuse a key for a different action", async () => {
    const idempotencyKey = newKey();
    await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" }, idempotencyKey });
    const reused = await agentRequest(acmeAgentKey, {
      action: "booking.reschedule",
      params: { bookingCode: "BK-1003", newStartDate: "2030-01-15" },
      idempotencyKey,
    });
    expect(reused.status).toBe(409);
  });
});

describe("undo", () => {
  async function doneCancellation() {
    const res = await cancel("BK-1002");
    expect(res.body.data.status).toBe("done");
    return res.body.data.actionId as string;
  }

  it("puts the booking back exactly as it was", async () => {
    const actionId = await doneCancellation();
    const token = await loginAs("manager@acme.test");
    const res = await request(app).post(`/api/actions/${actionId}/undo`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("undone");
    const booking = await Booking.findOne({ code: "BK-1002" }).lean();
    expect(booking?.status).toBe("confirmed");
    expect(booking?.refundAmount).toBe(0);
  });

  it("undoes only once, even if Undo is clicked 20 times at the same moment", async () => {
    const actionId = await doneCancellation();
    const token = await loginAs("manager@acme.test");
    const results = await Promise.all(
      Array.from({ length: 20 }, () => request(app).post(`/api/actions/${actionId}/undo`).set("authorization", `Bearer ${token}`))
    );
    const statuses = results.map((res) => res.status);
    expect(statuses.filter((status) => status === 200)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(19);
    expect(await AuditEvent.countDocuments({ type: "action_undone" })).toBe(1);
    // The losing clicks must not disturb the winner's final state.
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("undone");
    expect(await AuditEvent.countDocuments({ type: "undo_failed" })).toBe(0);
  });

  it("refuses to undo when the record changed since (no overwriting newer work)", async () => {
    const actionId = await doneCancellation();
    // Someone re-confirms the booking by hand after the agent cancelled it.
    await Booking.updateOne({ code: "BK-1002" }, { $set: { status: "confirmed", refundAmount: 0 } });
    const token = await loginAs("manager@acme.test");
    const res = await request(app).post(`/api/actions/${actionId}/undo`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(409);
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("done");
    expect(await AuditEvent.countDocuments({ type: "undo_failed" })).toBe(1);
  });

  it("cannot undo an email that was sent", async () => {
    const res = await agentRequest(acmeAgentKey, {
      action: "notification.sendEmail",
      params: { customerCode: "CU-101", subject: "Hello", body: "Your trip is confirmed." },
    });
    const token = await loginAs("manager@acme.test");
    await request(app).post(`/api/actions/${res.body.data.actionId}/approve`).set("authorization", `Bearer ${token}`);
    const undo = await request(app).post(`/api/actions/${res.body.data.actionId}/undo`).set("authorization", `Bearer ${token}`);
    expect(undo.status).toBe(409);
    expect(undo.body.message).toContain("permanent");
  });
});

describe("money in agent replies (REST)", () => {
  // The real-world problem: an agent got "3900" and guessed it might be $39.00 in cents.
  it("sends the currency and a formatted amount next to the number, and keeps the old fields", async () => {
    const res = await cancel("BK-1003"); // ₹3,900, small enough to run at once
    expect(res.body.data.status).toBe("done");
    expect(res.body.data.currency).toBe("INR");
    expect(res.body.data.result).toEqual({
      bookingCode: "BK-1003",
      status: "cancelled",
      refundAmount: 3900,
      currency: "INR",
      refundAmountFormatted: "₹3,900",
    });
    // Every field that existed before is still there, with the same type.
    expect(Object.keys(res.body.data)).toEqual(expect.arrayContaining(["actionId", "status", "decision", "message", "reasons", "result"]));
  });

  it("formats the facts too, including while a person still has to decide", async () => {
    const res = await cancel("BK-1001");
    expect(res.status).toBe(202);
    expect(res.body.data.result).toBeNull();
    expect(res.body.data.facts).toMatchObject({ amount: 7500, currency: "INR", amountFormatted: "₹7,500", customerCode: "CU-101" });
  });

  it("formats amounts for discounts (result and facts)", async () => {
    const res = await agentRequest(acmeAgentKey, { action: "booking.applyDiscount", params: { bookingCode: "BK-1003", percent: 10 } });
    expect(res.body.data.status).toBe("done");
    expect(res.body.data.result).toMatchObject({ newAmount: 3510, currency: "INR", newAmountFormatted: "₹3,510", discountPercent: 10 });
    expect(res.body.data.facts).toMatchObject({ amountFormatted: "₹3,900", discountAmount: 390, discountAmountFormatted: "₹390" });
  });

  it("leaves replies with no money in them as they were (no stray currency on the result)", async () => {
    const res = await agentRequest(acmeAgentKey, { action: "booking.reschedule", params: { bookingCode: "BK-1002", newStartDate: "2099-01-15" } });
    expect(res.body.data.status).toBe("done");
    expect(res.body.data.result).not.toHaveProperty("currency");
    expect(res.body.data.facts).toMatchObject({ amount: 4500, amountFormatted: "₹4,500" }); // the booking's own price is money
  });

  it("puts the currency in the reasons a refusal gives", async () => {
    for (const code of ["BK-1002", "BK-1003", "BK-1004", "BK-1006"]) await cancel(code);
    const refused = await cancel("BK-1007");
    expect(refused.body.data.status).toBe("denied");
    expect(refused.body.data.reasons.join(" ")).toContain("₹22,300");
    expect(refused.body.data.reasons.join(" ")).toContain("₹20,000");
  });

  it("answers the status check with the same fields", async () => {
    const res = await cancel("BK-1003");
    const status = await request(app).get(`/api/agent/actions/${res.body.data.actionId}`).set("x-agent-key", acmeAgentKey);
    expect(status.status).toBe(200);
    expect(status.body.data.currency).toBe("INR");
    expect(status.body.data.result).toMatchObject({ refundAmount: 3900, currency: "INR", refundAmountFormatted: "₹3,900" });
  });

  it("uses the company's own currency, in the reply and in the sentence people read", async () => {
    await Workspace.updateOne({ slug: "acme-travels" }, { $set: { currency: "USD" } });
    const res = await cancel("BK-1003");
    expect(res.body.data.currency).toBe("USD");
    expect(res.body.data.result).toMatchObject({ refundAmount: 3900, currency: "USD", refundAmountFormatted: "$3,900" });
    const record = await ActionRecord.findById(res.body.data.actionId).lean();
    expect(record?.summary).toContain("$3,900");
    expect(record?.summary).not.toContain("₹");
    // Another company keeps its own currency.
    const other = await cancel("BK-2001", globexAgentKey);
    expect(other.body.data.currency).toBe("INR");
  });

  it("still answers, with the code spelled out, when the saved currency is not a real one", async () => {
    await Workspace.updateOne({ slug: "acme-travels" }, { $set: { currency: "RUPEES" } });
    const res = await cancel("BK-1003");
    expect(res.status).toBe(200);
    expect(res.body.data.result).toMatchObject({ currency: "RUPEES", refundAmountFormatted: "RUPEES 3,900" });
  });
});

describe("audit trail", () => {
  it("records who asked, who approved and what happened, in order", async () => {
    const res = await cancel("BK-1001");
    const token = await loginAs("manager@acme.test");
    await request(app).post(`/api/actions/${res.body.data.actionId}/approve`).set("authorization", `Bearer ${token}`);
    const detail = await request(app).get(`/api/actions/${res.body.data.actionId}`).set("authorization", `Bearer ${token}`);
    const types = detail.body.data.timeline.map((event: { type: string }) => event.type);
    expect(types).toEqual(["action_requested", "approval_requested", "action_approved", "action_executed"]);
    expect(detail.body.data.timeline[2].actor.name).toBe("Karan Shah");
  });

  it("exports CSV for auditors with formula cells neutralised", async () => {
    await agentRequest(acmeAgentKey, {
      action: "booking.cancel",
      params: { bookingCode: "BK-1002" },
      onBehalfOf: "=HYPERLINK(\"http://evil\")",
    });
    const token = await loginAs("auditor@acme.test");
    const res = await request(app).get("/api/audit/export").set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/csv");
    expect(res.text).toContain(`"'=HYPERLINK`);
  });
});

describe("rules", () => {
  it("validates rules and audits changes", async () => {
    const token = await loginAs("admin@acme.test");
    const bad = await request(app)
      .post("/api/policies")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "Bad rule", action: "booking.cancel", effect: "deny", conditions: [{ field: "facts.mood", op: "eq", value: "x" }] });
    expect(bad.status).toBe(400);

    const good = await request(app)
      .post("/api/policies")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "No discounts over 20%", action: "booking.applyDiscount", effect: "deny", conditions: [{ field: "facts.percent", op: "gt", value: 20 }] });
    expect(good.status).toBe(201);
    expect(await AuditEvent.countDocuments({ type: "policy_created" })).toBe(1);

    const discount = await agentRequest(acmeAgentKey, { action: "booking.applyDiscount", params: { bookingCode: "BK-1003", percent: 25 } });
    expect(discount.body.data.status).toBe("denied");
  });

  it("only lets admins change rules", async () => {
    const token = await loginAs("manager@acme.test");
    const res = await request(app)
      .post("/api/policies")
      .set("authorization", `Bearer ${token}`)
      .send({ name: "Allow all", action: "*", effect: "allow" });
    expect(res.status).toBe(403);
  });

  it("explains that AI drafting is optional when no AI is configured", async () => {
    const token = await loginAs("admin@acme.test");
    const res = await request(app)
      .post("/api/policies/draft")
      .set("authorization", `Bearer ${token}`)
      .send({ text: "Refunds over 10000 need a manager" });
    expect(res.status).toBe(503);
  });
});
