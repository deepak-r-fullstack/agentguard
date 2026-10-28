import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { ActionRecord } from "../src/models/actionRecord.model";
import { AuditEvent } from "../src/models/auditEvent.model";
import { User } from "../src/models/user.model";
import { Workspace } from "../src/models/workspace.model";
import { DEMO_PASSWORD, seedDemoData, SeedResult } from "../src/services/demo/demo.service";
import { isValidSlackSignature } from "../src/services/slack/slack.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Slack approvals, end to end. Slack itself is faked: global fetch is mocked, so no real
// network call is ever made. All tokens here are placeholders.

const app = createApp();
const SIGNING_SECRET = "test-signing-secret";
const ACME_CHANNEL = "C0ACME00001";
const RESPONSE_URL = "https://hooks.slack.com/actions/T000/B000/placeholder";

// Which AgentGuard person each fake Slack user is (looked up through users.info).
const SLACK_USERS: Record<string, string> = {
  U_MANAGER: "manager@acme.test",
  U_ADMIN: "admin@acme.test",
  U_AUDITOR: "auditor@acme.test",
  U_GLOBEX: "manager@globex.test",
  U_STRANGER: "someone.else@nowhere.test",
};

interface SlackCall {
  method: string;
  params: URLSearchParams;
}
let slackCalls: SlackCall[] = [];
let ephemeralReplies: string[] = [];
let slackBehaviour: "ok" | "down" = "ok";

let seed: SeedResult;
let acmeAgentKey: string;
let acmeWorkspaceId: string;

const mutableEnv = env as { SLACK_BOT_TOKEN: string; SLACK_SIGNING_SECRET: string };

function installFakeSlack() {
  jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.startsWith("https://hooks.slack.com/")) {
      ephemeralReplies.push(JSON.parse(String(init?.body)).text);
      return new Response("ok", { status: 200 });
    }
    const method = url.replace("https://slack.com/api/", "");
    const params = new URLSearchParams(String(init?.body));
    slackCalls.push({ method, params });
    if (slackBehaviour === "down") throw new Error("network is down");
    if (method === "chat.postMessage") {
      return new Response(JSON.stringify({ ok: true, ts: "1700000000.000100", channel: params.get("channel") }), { status: 200 });
    }
    if (method === "users.info") {
      const email = SLACK_USERS[params.get("user") || ""];
      return new Response(JSON.stringify(email ? { ok: true, user: { profile: { email } } } : { ok: false, error: "user_not_found" }), {
        status: 200,
      });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  });
}

const callsTo = (method: string) => slackCalls.filter((call) => call.method === method);

// Posting and updating are fire-and-forget, so tests wait for the effect instead of the response.
async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the expected change.");
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

function sign(body: string, timestamp: number, secret = SIGNING_SECRET) {
  return `v0=${crypto.createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

function clickBody(slackUserId: string, actionId: string, verb: "approve" | "reject" = "approve", channelId = ACME_CHANNEL) {
  const payload = {
    type: "block_actions",
    user: { id: slackUserId },
    channel: { id: channelId },
    response_url: RESPONSE_URL,
    actions: [{ action_id: `agentguard_${verb}`, value: actionId }],
  };
  return `payload=${encodeURIComponent(JSON.stringify(payload))}`;
}

function sendClick(body: string, options: { timestamp?: number; signature?: string } = {}) {
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000);
  return request(app)
    .post("/api/integrations/slack/interactions")
    .set("content-type", "application/x-www-form-urlencoded")
    .set("x-slack-request-timestamp", String(timestamp))
    .set("x-slack-signature", options.signature ?? sign(body, timestamp))
    .send(body);
}

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

// A cancellation that needs a manager (BK-1001 is over the auto-run limit).
async function requestApproval(onBehalfOf = "Ravi (support team)") {
  const res = await request(app)
    .post("/api/agent/actions")
    .set("x-agent-key", acmeAgentKey)
    .send({ action: "booking.cancel", params: { bookingCode: "BK-1001" }, onBehalfOf, idempotencyKey: crypto.randomUUID() });
  expect(res.status).toBe(202);
  return res.body.data.actionId as string;
}

// Same, but waits until the approval message is posted and its place is saved.
async function requestApprovalPostedToSlack(onBehalfOf?: string) {
  const actionId = await requestApproval(onBehalfOf);
  await waitFor(async () => Boolean((await ActionRecord.findById(actionId).lean())?.slackMessageTs));
  return actionId;
}

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  mutableEnv.SLACK_BOT_TOKEN = "xoxb-placeholder-token";
  mutableEnv.SLACK_SIGNING_SECRET = SIGNING_SECRET;
  slackCalls = [];
  ephemeralReplies = [];
  slackBehaviour = "ok";
  installFakeSlack();

  seed = await seedDemoData();
  acmeAgentKey = seed.agentKeys.find((key) => key.agentName === "Support Copilot")!.apiKey;
  const manager = await User.findOne({ email: "manager@acme.test" }).lean();
  acmeWorkspaceId = String(manager!.workspaceId);
  await Workspace.updateOne({ _id: acmeWorkspaceId }, { $set: { slackChannelId: ACME_CHANNEL } });
});

afterEach(() => {
  jest.restoreAllMocks();
  mutableEnv.SLACK_BOT_TOKEN = "";
  mutableEnv.SLACK_SIGNING_SECRET = "";
});

describe("Slack signature check", () => {
  const body = "payload=%7B%7D";
  const now = 1_700_000_000;

  it("accepts a correct, recent signature", () => {
    expect(isValidSlackSignature(Buffer.from(body), String(now), sign(body, now), now + 10)).toBe(true);
  });

  it("rejects a wrong secret, a changed body, a missing signature and a different length", () => {
    expect(isValidSlackSignature(Buffer.from(body), String(now), sign(body, now, "other-secret"), now)).toBe(false);
    expect(isValidSlackSignature(Buffer.from(`${body}x`), String(now), sign(body, now), now)).toBe(false);
    expect(isValidSlackSignature(Buffer.from(body), String(now), "", now)).toBe(false);
    expect(isValidSlackSignature(Buffer.from(body), String(now), "v0=short", now)).toBe(false);
  });

  it("rejects requests older (or newer) than 5 minutes, so they cannot be replayed", () => {
    expect(isValidSlackSignature(Buffer.from(body), String(now), sign(body, now), now + 301)).toBe(false);
    expect(isValidSlackSignature(Buffer.from(body), String(now), sign(body, now), now - 301)).toBe(false);
    expect(isValidSlackSignature(Buffer.from(body), String(now), sign(body, now), now + 299)).toBe(true);
    expect(isValidSlackSignature(Buffer.from(body), "not-a-number", sign(body, now), now)).toBe(false);
  });

  it("the endpoint answers 401 to a bad or stale signature and never acts", async () => {
    const actionId = await requestApprovalPostedToSlack();
    const body = clickBody("U_MANAGER", actionId);
    expect((await sendClick(body, { signature: "v0=deadbeef" })).status).toBe(401);
    const stale = Math.floor(Date.now() / 1000) - 600;
    expect((await sendClick(body, { timestamp: stale })).status).toBe(401);
    await settle();
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
    expect(callsTo("users.info")).toHaveLength(0);
  });

  it("the endpoint is off (503) when Slack is not configured", async () => {
    mutableEnv.SLACK_SIGNING_SECRET = "";
    const res = await sendClick("payload=%7B%7D", { signature: "v0=anything" });
    expect(res.status).toBe(503);
  });
});

describe("approval message", () => {
  it("is posted to the company's channel with the summary, reasons and buttons", async () => {
    const actionId = await requestApprovalPostedToSlack();
    const posts = callsTo("chat.postMessage");
    expect(posts).toHaveLength(1);
    expect(posts[0].params.get("channel")).toBe(ACME_CHANNEL);
    expect(posts[0].params.get("text")).toContain("BK-1001");

    const blocks = JSON.parse(posts[0].params.get("blocks")!);
    const buttons = blocks.find((block: { type: string }) => block.type === "actions").elements;
    expect(buttons.map((button: { action_id: string }) => button.action_id)).toEqual(["agentguard_approve", "agentguard_reject"]);
    expect(buttons.every((button: { value: string }) => button.value === actionId)).toBe(true);
    expect(JSON.stringify(blocks)).toContain("Why a person has to decide");

    const record = await ActionRecord.findById(actionId).lean();
    expect(record?.slackChannelId).toBe(ACME_CHANNEL);
    expect(record?.slackMessageTs).toBe("1700000000.000100");
  });

  it("stops text from customers or agents from pinging the whole channel", async () => {
    const res = await request(app)
      .post("/api/agent/actions")
      .set("x-agent-key", acmeAgentKey)
      .send({
        action: "notification.sendEmail",
        params: { customerCode: "CU-101", subject: "<!channel> hello", body: "Your trip is confirmed." },
        onBehalfOf: "<!here>",
        idempotencyKey: crypto.randomUUID(),
      });
    expect(res.status).toBe(202);
    await waitFor(() => callsTo("chat.postMessage").length === 1);
    const sent = callsTo("chat.postMessage")[0].params.get("blocks")!;
    expect(sent).not.toContain("<!channel>");
    expect(sent).not.toContain("<!here>");
    expect(sent).toContain("&lt;!channel&gt;");
  });

  it("is not posted when the company has no channel, or for actions that run at once", async () => {
    await Workspace.updateOne({ _id: acmeWorkspaceId }, { $set: { slackChannelId: "" } });
    await requestApproval();
    const small = await request(app)
      .post("/api/agent/actions")
      .set("x-agent-key", acmeAgentKey)
      .send({ action: "booking.cancel", params: { bookingCode: "BK-1002" }, onBehalfOf: "Ravi", idempotencyKey: crypto.randomUUID() });
    expect(small.body.data.status).toBe("done");
    await settle();
    expect(callsTo("chat.postMessage")).toHaveLength(0);
  });

  it("is not posted when Slack is not configured", async () => {
    mutableEnv.SLACK_BOT_TOKEN = "";
    await requestApproval();
    await settle();
    expect(slackCalls).toHaveLength(0);
  });

  it("never fails the agent's request when Slack is down", async () => {
    slackBehaviour = "down";
    const actionId = await requestApproval(); // requestApproval itself expects 202
    await waitFor(() => callsTo("chat.postMessage").length > 0);
    await settle();
    const record = await ActionRecord.findById(actionId).lean();
    expect(record?.status).toBe("pending_approval");
    expect(record?.slackMessageTs).toBe("");
  });

  it("does not make the agent wait for Slack", async () => {
    // Slack never answers; the agent still gets its reply straight away.
    jest.spyOn(global, "fetch").mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    await requestApproval();
    expect(Date.now() - started).toBeLessThan(2500);
  });
});

describe("approving and rejecting in Slack", () => {
  it("approves for a manager: maps the Slack user by email, runs the action, updates the message", async () => {
    const actionId = await requestApprovalPostedToSlack();
    const res = await sendClick(clickBody("U_MANAGER", actionId));
    expect(res.status).toBe(200); // Slack gets its answer first

    await waitFor(async () => (await ActionRecord.findById(actionId).lean())?.status === "done");
    const record = await ActionRecord.findById(actionId).lean();
    expect(record?.approvedBy).toBe("Karan Shah");
    const approvedEvent = await AuditEvent.findOne({ actionId, type: "action_approved" }).lean();
    expect(approvedEvent?.actor?.type).toBe("user");
    expect(approvedEvent?.actor?.name).toBe("Karan Shah");

    await waitFor(() => callsTo("chat.update").length === 1);
    const update = callsTo("chat.update")[0];
    expect(update.params.get("channel")).toBe(ACME_CHANNEL);
    expect(update.params.get("ts")).toBe("1700000000.000100");
    expect(update.params.get("blocks")).toContain("Approved by Karan Shah");
    expect(update.params.get("blocks")).not.toContain("agentguard_approve"); // buttons are gone
  });

  it("rejects, and shows who rejected", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await sendClick(clickBody("U_ADMIN", actionId, "reject"));
    await waitFor(async () => (await ActionRecord.findById(actionId).lean())?.status === "rejected");
    expect((await ActionRecord.findById(actionId).lean())?.rejectedBy).toBe("Meera Nair");
    await waitFor(() => callsTo("chat.update").length === 1);
    expect(callsTo("chat.update")[0].params.get("blocks")).toContain("Rejected by Meera Nair");
  });

  it("keeps separation of duties: nobody approves work requested on their own behalf", async () => {
    const actionId = await requestApprovalPostedToSlack("manager@acme.test");
    await sendClick(clickBody("U_MANAGER", actionId));
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("cannot approve");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
    expect(callsTo("chat.update")).toHaveLength(0);
  });

  it("does not let an auditor decide", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await sendClick(clickBody("U_AUDITOR", actionId));
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("Only managers and admins");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
  });

  it("does not let a person whose account was turned off decide", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await User.updateOne({ email: "manager@acme.test" }, { $set: { active: false } });
    await sendClick(clickBody("U_MANAGER", actionId));
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("turned off");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
  });

  it("does not let someone from another company decide", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await sendClick(clickBody("U_GLOBEX", actionId)); // a real Globex manager, but Acme's request
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("does not match a person");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
  });

  it("does not know a Slack user who has no AgentGuard account", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await sendClick(clickBody("U_STRANGER", actionId));
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("does not match a person");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
  });

  it("explains it when Slack does not know the person at all (no email to read)", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await sendClick(clickBody("U_UNKNOWN_TO_SLACK", actionId));
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("could not read your email");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
  });

  it("ignores a click that did not come from the company's own channel", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await sendClick(clickBody("U_MANAGER", actionId, "approve", "C0SOMEWHERE"));
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("own company's approval channel");
    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("pending_approval");
    expect(callsTo("users.info")).toHaveLength(0);
  });

  it("only one of two quick clicks wins (atomic), the other is told it is decided", async () => {
    const actionId = await requestApprovalPostedToSlack();
    await Promise.all([sendClick(clickBody("U_MANAGER", actionId)), sendClick(clickBody("U_ADMIN", actionId))]);
    await waitFor(async () => (await ActionRecord.findById(actionId).lean())?.status === "done");
    await waitFor(() => ephemeralReplies.length === 1);
    expect(ephemeralReplies[0]).toContain("already approved or rejected");
    expect(await AuditEvent.countDocuments({ actionId, type: "action_approved" })).toBe(1);
  });

  it("ignores payloads it does not understand", async () => {
    const res = await sendClick("payload=not-json");
    expect(res.status).toBe(200);
    await settle();
    expect(slackCalls).toHaveLength(0);
  });
});

describe("decisions made in the web app", () => {
  it("also update the Slack message", async () => {
    const actionId = await requestApprovalPostedToSlack();
    const token = await loginAs("manager@acme.test");
    const res = await request(app).post(`/api/actions/${actionId}/approve`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    await waitFor(() => callsTo("chat.update").length === 1);
    expect(callsTo("chat.update")[0].params.get("blocks")).toContain("Approved by Karan Shah");
  });

  it("show a rejection in Slack too", async () => {
    const actionId = await requestApprovalPostedToSlack();
    const token = await loginAs("manager@acme.test");
    await request(app).post(`/api/actions/${actionId}/reject`).set("authorization", `Bearer ${token}`).send({ note: "" });
    await waitFor(() => callsTo("chat.update").length === 1);
    expect(callsTo("chat.update")[0].params.get("blocks")).toContain("Rejected by Karan Shah");
  });

  it("still succeed when Slack is down", async () => {
    const actionId = await requestApprovalPostedToSlack();
    slackBehaviour = "down";
    const token = await loginAs("manager@acme.test");
    const res = await request(app).post(`/api/actions/${actionId}/approve`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("done");
  });
});

describe("Connections settings", () => {
  it("shows an admin whether Slack is set up, and keeps managers out", async () => {
    const admin = await loginAs("admin@acme.test");
    const res = await request(app).get("/api/integrations").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(res.body.data.slack).toEqual({ configured: true, channelId: ACME_CHANNEL });

    mutableEnv.SLACK_BOT_TOKEN = "";
    const off = await request(app).get("/api/integrations").set("authorization", `Bearer ${admin}`);
    expect(off.body.data.slack.configured).toBe(false);

    const manager = await loginAs("manager@acme.test");
    expect((await request(app).get("/api/integrations").set("authorization", `Bearer ${manager}`)).status).toBe(403);
    expect((await request(app).put("/api/integrations/slack").set("authorization", `Bearer ${manager}`).send({ slackChannelId: "C0123456789" })).status).toBe(403);
    expect((await request(app).post("/api/integrations/slack/test").set("authorization", `Bearer ${manager}`)).status).toBe(403);
  });

  it("saves a valid channel for the admin's own company only, and rejects nonsense", async () => {
    const admin = await loginAs("admin@acme.test");
    const bad = await request(app).put("/api/integrations/slack").set("authorization", `Bearer ${admin}`).send({ slackChannelId: "general" });
    expect(bad.status).toBe(400);

    const saved = await request(app).put("/api/integrations/slack").set("authorization", `Bearer ${admin}`).send({ slackChannelId: " c0newchan01 " });
    expect(saved.status).toBe(200);
    expect(saved.body.data.slack.channelId).toBe("C0NEWCHAN01");
    expect((await Workspace.findById(acmeWorkspaceId).lean())?.slackChannelId).toBe("C0NEWCHAN01");
    const globexManager = await User.findOne({ email: "manager@globex.test" }).lean();
    expect((await Workspace.findById(globexManager!.workspaceId).lean())?.slackChannelId).toBe("");

    const cleared = await request(app).put("/api/integrations/slack").set("authorization", `Bearer ${admin}`).send({ slackChannelId: "" });
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.slack.channelId).toBe("");
  });

  it("records who changed or cleared the channel in the audit log, and nothing when it did not change", async () => {
    const admin = await loginAs("admin@acme.test");
    const put = (slackChannelId: string) =>
      request(app).put("/api/integrations/slack").set("authorization", `Bearer ${admin}`).send({ slackChannelId });
    const events = () => AuditEvent.find({ type: "integration_updated" }).sort({ createdAt: 1, _id: 1 }).lean();

    await put("C0NEWCHAN01");
    await put("C0NEWCHAN01"); // same value again: no new event
    await put("");
    await put(""); // already off: no new event

    const recorded = await events();
    expect(recorded).toHaveLength(2);
    expect(recorded[0].summary).toBe(`Changed the Slack approvals channel from ${ACME_CHANNEL} to C0NEWCHAN01`);
    expect(recorded[1].summary).toBe("Turned off Slack approvals (was channel C0NEWCHAN01)");
    for (const event of recorded) {
      expect(event.actor?.type).toBe("user");
      expect(event.actor?.name).toBe("Meera Nair");
      expect(String(event.workspaceId)).toBe(acmeWorkspaceId);
    }

    await put("C0AGAIN0001"); // set from empty
    expect((await events())[2].summary).toBe("Set the Slack approvals channel to C0AGAIN0001");

    // A rejected value changes nothing and records nothing.
    await put("general");
    expect(await events()).toHaveLength(3);
  });

  it("sends a test message to the saved channel", async () => {
    const admin = await loginAs("admin@acme.test");
    const res = await request(app).post("/api/integrations/slack/test").set("authorization", `Bearer ${admin}`);
    expect(res.status).toBe(200);
    expect(callsTo("chat.postMessage")).toHaveLength(1);
    expect(callsTo("chat.postMessage")[0].params.get("channel")).toBe(ACME_CHANNEL);
  });

  it("explains problems in plain words", async () => {
    const admin = await loginAs("admin@acme.test");
    mutableEnv.SLACK_BOT_TOKEN = "";
    expect((await request(app).post("/api/integrations/slack/test").set("authorization", `Bearer ${admin}`)).status).toBe(503);

    mutableEnv.SLACK_BOT_TOKEN = "xoxb-placeholder-token";
    await Workspace.updateOne({ _id: acmeWorkspaceId }, { $set: { slackChannelId: "" } });
    const noChannel = await request(app).post("/api/integrations/slack/test").set("authorization", `Bearer ${admin}`);
    expect(noChannel.status).toBe(400);
    expect(noChannel.body.message).toContain("channel ID");

    await Workspace.updateOne({ _id: acmeWorkspaceId }, { $set: { slackChannelId: ACME_CHANNEL } });
    jest.spyOn(global, "fetch").mockImplementation(async () => new Response(JSON.stringify({ ok: false, error: "not_in_channel" }), { status: 200 }));
    const notIn = await request(app).post("/api/integrations/slack/test").set("authorization", `Bearer ${admin}`);
    expect(notIn.status).toBe(400);
    expect(notIn.body.message).toContain("Add the AgentGuard app");
  });
});
