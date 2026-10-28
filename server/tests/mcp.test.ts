import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { Booking } from "../src/models/demo.model";
import { ActionRecord } from "../src/models/actionRecord.model";
import { Workspace } from "../src/models/workspace.model";
import * as guardService from "../src/services/actions/guard.service";
import { DEMO_PASSWORD, seedDemoData, SeedResult } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// MCP tests go through the real HTTP API (JSON-RPC over POST /api/mcp) with a real in-memory MongoDB.

const app = createApp();
let seed: SeedResult;
let acmeAgentKey: string;
let globexAgentKey: string;

const newKey = () => crypto.randomUUID();

// MCP clients must accept both reply formats; ours always answers with plain JSON.
function mcpRequest(method: string, params: unknown, auth: Record<string, string> = { authorization: `Bearer ${acmeAgentKey}` }) {
  return request(app)
    .post("/api/mcp")
    .set("accept", "application/json, text/event-stream")
    .set(auth)
    .send({ jsonrpc: "2.0", id: 1, method, params });
}

async function callTool(name: string, args: Record<string, unknown>, key = acmeAgentKey) {
  const res = await mcpRequest(
    "tools/call",
    // get_action_status is read-only and takes only an actionId (its schema is strict).
    { name, arguments: name === "get_action_status" ? args : { onBehalfOf: "Ravi (support team)", idempotencyKey: newKey(), ...args } },
    { authorization: `Bearer ${key}` }
  );
  expect(res.status).toBe(200);
  const result = res.body.result as { isError?: boolean; content: { type: string; text: string }[] };
  return { isError: Boolean(result.isError), text: result.content[0].text, json: () => JSON.parse(result.content[0].text) };
}

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
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
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("MCP protocol", () => {
  it("answers initialize", async () => {
    const res = await mcpRequest("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test-client", version: "1.0.0" },
    });
    expect(res.status).toBe(200);
    expect(res.body.result.serverInfo.name).toBe("agentguard");
    expect(res.body.result.capabilities.tools).toBeDefined();
  });

  it("lists one tool per action plus get_action_status, with the right hints", async () => {
    const res = await mcpRequest("tools/list", {});
    expect(res.status).toBe(200);
    const tools = res.body.result.tools as { name: string; annotations: Record<string, boolean>; inputSchema: { properties: object; required: string[] } }[];
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    expect(Object.keys(byName).sort()).toEqual(
      [
        "booking_applyDiscount",
        "booking_cancel",
        "booking_reschedule",
        "customer_updateEmail",
        "get_action_status",
        "notification_sendEmail",
      ].sort()
    );
    // Dots become "_"; the action's own fields sit next to the common ones.
    expect(Object.keys(byName.booking_cancel.inputSchema.properties)).toEqual(
      expect.arrayContaining(["bookingCode", "onBehalfOf", "idempotencyKey", "reason"])
    );
    expect(byName.booking_cancel.inputSchema.required).toEqual(expect.arrayContaining(["bookingCode", "onBehalfOf", "idempotencyKey"]));
    expect(byName.booking_cancel.inputSchema.required).not.toContain("reason");

    expect(byName.notification_sendEmail.annotations.destructiveHint).toBe(true);
    expect(byName.booking_cancel.annotations.destructiveHint).toBe(false);
    expect(byName.booking_cancel.annotations.idempotentHint).toBe(true);
    expect(byName.get_action_status.annotations.readOnlyHint).toBe(true);
  });

  it("refuses GET and DELETE with 405 (no sessions are kept)", async () => {
    expect((await request(app).get("/api/mcp")).status).toBe(405);
    expect((await request(app).delete("/api/mcp")).status).toBe(405);
  });
});

describe("MCP authentication", () => {
  it("accepts Authorization: Bearer agk_... and still accepts x-agent-key", async () => {
    const bearer = await mcpRequest("tools/list", {}, { authorization: `Bearer ${acmeAgentKey}` });
    expect(bearer.status).toBe(200);
    const header = await mcpRequest("tools/list", {}, { "x-agent-key": acmeAgentKey });
    expect(header.status).toBe(200);
  });

  it("rejects a missing, malformed or unknown key", async () => {
    expect((await mcpRequest("tools/list", {}, {})).status).toBe(401);
    expect((await mcpRequest("tools/list", {}, { authorization: "Bearer agk_not_a_real_key" })).status).toBe(401);
    expect((await mcpRequest("tools/list", {}, { authorization: "Basic abc" })).status).toBe(401);
    expect((await mcpRequest("tools/list", {}, { authorization: "Bearer not-an-agent-key" })).status).toBe(401);
  });

  it("does not accept a signed-in person's token as an agent key", async () => {
    const token = await loginAs("manager@acme.test");
    expect((await mcpRequest("tools/list", {}, { authorization: `Bearer ${token}` })).status).toBe(401);
  });

  it("lets the Bearer form work on the existing agent API too", async () => {
    const res = await request(app).get("/api/agent/catalog").set("authorization", `Bearer ${acmeAgentKey}`);
    expect(res.status).toBe(200);
  });
});

describe("MCP tool calls go through the guard", () => {
  it("runs an allowed action right away", async () => {
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-1002", reason: "Customer asked in chat" });
    expect(outcome.isError).toBe(false);
    expect(outcome.json().status).toBe("done");
    const booking = await Booking.findOne({ code: "BK-1002" }).lean();
    expect(booking?.status).toBe("cancelled");
    // The agent is the real agent, so the audit trail names it.
    const record = await ActionRecord.findById(outcome.json().actionId).lean();
    expect(record?.agentName).toBe("Support Copilot");
  });

  it("holds an action for approval, and the status tool follows it through to done", async () => {
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-1001" });
    expect(outcome.json().status).toBe("pending_approval");
    expect(outcome.json().message).toContain("get_action_status");
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("confirmed");

    const waiting = await callTool("get_action_status", { actionId: outcome.json().actionId });
    expect(waiting.json().status).toBe("pending_approval");

    const token = await loginAs("manager@acme.test");
    const approved = await request(app).post(`/api/actions/${outcome.json().actionId}/approve`).set("authorization", `Bearer ${token}`);
    expect(approved.status).toBe(200);

    const finished = await callTool("get_action_status", { actionId: outcome.json().actionId });
    expect(finished.json().status).toBe("done");
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("cancelled");
  });

  it("refuses an action that a rule denies", async () => {
    const adminToken = await loginAs("admin@acme.test");
    const rule = await request(app)
      .post("/api/policies")
      .set("authorization", `Bearer ${adminToken}`)
      .send({ name: "No discounts over 20%", action: "booking.applyDiscount", effect: "deny", conditions: [{ field: "facts.percent", op: "gt", value: 20 }] });
    expect(rule.status).toBe(201);

    const outcome = await callTool("booking_applyDiscount", { bookingCode: "BK-1003", percent: 25 });
    expect(outcome.json().status).toBe("denied");
    expect(outcome.json().decision).toBe("deny");
    expect((await Booking.findOne({ code: "BK-1003" }).lean())?.discountPercent).toBe(0);
  });

  it("never auto-runs an action that cannot be undone", async () => {
    const outcome = await callTool("notification_sendEmail", { customerCode: "CU-101", subject: "Hello", body: "Your trip is confirmed." });
    expect(outcome.json().status).toBe("pending_approval");
  });

  it("is idempotent: the same key returns the first result and acts once", async () => {
    const idempotencyKey = newKey();
    const first = await callTool("booking_cancel", { bookingCode: "BK-1002", idempotencyKey });
    const second = await callTool("booking_cancel", { bookingCode: "BK-1002", idempotencyKey });
    expect(second.json().actionId).toBe(first.json().actionId);
    expect(await ActionRecord.countDocuments({ idempotencyKey })).toBe(1);
  });

  it("shares idempotency with the REST API", async () => {
    const idempotencyKey = newKey();
    const viaRest = await request(app)
      .post("/api/agent/actions")
      .set("x-agent-key", acmeAgentKey)
      .send({ action: "booking.cancel", params: { bookingCode: "BK-1002" }, onBehalfOf: "Ravi (support team)", idempotencyKey });
    const viaMcp = await callTool("booking_cancel", { bookingCode: "BK-1002", idempotencyKey });
    expect(viaMcp.json().actionId).toBe(viaRest.body.data.actionId);
  });

  it("returns our own error messages as tool errors", async () => {
    const missing = await callTool("booking_cancel", { bookingCode: "BK-9999" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toBe("Booking BK-9999 was not found.");
  });

  it("does not let an agent reach another company's data", async () => {
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-2001" }); // Globex booking, Acme agent
    expect(outcome.isError).toBe(true);
    expect((await Booking.findOne({ code: "BK-2001" }).lean())?.status).toBe("confirmed");
  });

  it("hides unexpected error details from the agent", async () => {
    jest.spyOn(guardService, "requestAction").mockRejectedValueOnce(new Error("mongo://user:password@internal-host failed"));
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-1002" });
    expect(outcome.isError).toBe(true);
    expect(outcome.text).toBe("The action failed because of an unexpected error.");
    expect(outcome.text).not.toContain("internal-host");
  });

  it("rejects fields the action does not define, like the REST API (the agent cannot claim its own amount)", async () => {
    const res = await mcpRequest("tools/call", {
      name: "booking_cancel",
      arguments: { bookingCode: "BK-1002", amount: 1, onBehalfOf: "Ravi", idempotencyKey: newKey() },
    });
    const failed = res.body.error || res.body.result?.isError;
    expect(failed).toBeTruthy();
    expect(await ActionRecord.countDocuments({})).toBe(0);
    expect((await Booking.findOne({ code: "BK-1002" }).lean())?.status).toBe("confirmed");

    const listed = await mcpRequest("tools/list", {});
    const cancel = listed.body.result.tools.find((tool: { name: string }) => tool.name === "booking_cancel");
    expect(cancel.inputSchema.additionalProperties).toBe(false);
  });

  it("rejects input that does not match the tool (missing idempotencyKey)", async () => {
    const res = await mcpRequest("tools/call", { name: "booking_cancel", arguments: { bookingCode: "BK-1002", onBehalfOf: "Ravi" } });
    const failed = res.body.error || res.body.result?.isError;
    expect(failed).toBeTruthy();
    expect((await Booking.findOne({ code: "BK-1002" }).lean())?.status).toBe("confirmed");
  });
});

describe("money in MCP tool results", () => {
  it("sends the currency and a formatted amount next to the number, and keeps the old fields", async () => {
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-1003" });
    expect(outcome.isError).toBe(false);
    expect(outcome.json().currency).toBe("INR");
    expect(outcome.json().result).toEqual({
      bookingCode: "BK-1003",
      status: "cancelled",
      refundAmount: 3900,
      currency: "INR",
      refundAmountFormatted: "₹3,900",
    });
    expect(Object.keys(outcome.json())).toEqual(expect.arrayContaining(["actionId", "status", "decision", "message", "reasons", "result"]));
  });

  it("formats the facts while waiting, and again through get_action_status", async () => {
    const waiting = await callTool("booking_cancel", { bookingCode: "BK-1001" });
    expect(waiting.json().facts).toMatchObject({ amount: 7500, currency: "INR", amountFormatted: "₹7,500" });
    const checked = await callTool("get_action_status", { actionId: waiting.json().actionId });
    expect(checked.json().facts).toMatchObject({ amount: 7500, currency: "INR", amountFormatted: "₹7,500" });
    expect(checked.json().message).toContain("get_action_status");
  });

  it("puts the currency in the reasons a refusal gives", async () => {
    for (const code of ["BK-1002", "BK-1003", "BK-1004", "BK-1006"]) await callTool("booking_cancel", { bookingCode: code });
    const refused = await callTool("booking_cancel", { bookingCode: "BK-1007" });
    expect(refused.json().status).toBe("denied");
    expect(refused.json().reasons.join(" ")).toContain("₹22,300");
  });

  it("uses the company's own currency", async () => {
    await Workspace.updateOne({ slug: "acme-travels" }, { $set: { currency: "USD" } });
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-1003" });
    expect(outcome.json().result).toMatchObject({ refundAmount: 3900, currency: "USD", refundAmountFormatted: "$3,900" });
  });
});

describe("get_action_status", () => {
  it("only shows an agent its own actions", async () => {
    const outcome = await callTool("booking_cancel", { bookingCode: "BK-1001" });
    const other = await callTool("get_action_status", { actionId: outcome.json().actionId }, globexAgentKey);
    expect(other.isError).toBe(true);
    expect(other.text).toBe("That action was not found.");
  });

  it("answers a made-up id with not found, not an error dump", async () => {
    const bad = await callTool("get_action_status", { actionId: "not-an-id" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toBe("That action was not found.");
  });
});
