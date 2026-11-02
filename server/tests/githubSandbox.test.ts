import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { Workspace } from "../src/models/workspace.model";
import { Policy } from "../src/models/policy.model";
import { AuditEvent } from "../src/models/auditEvent.model";
import { DEMO_PASSWORD, seedDemoData } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// Actual HTTP handlers, guard, policy checks and database; only GitHub is faked.
const app = createApp();
let agentKey: string, otherKey: string, token: string, workspaceId: string;
let spy: jest.SpyInstance;
let labels: string[], version: number, reads: number, changeOnRead: number;
let calls: { method: string; path: string }[];
let failStatus: number, failWrite: boolean, pullRequest: boolean;
const stamp = () => "2026-11-02T10:00:" + String(version).padStart(2, "0") + "Z";
const writes = () => calls.filter((call) => call.method !== "GET");
const submit = (params: object = { issueNumber: 1 }, key = crypto.randomUUID(), authKey = agentKey) =>
  request(app)
    .post("/api/agent/actions")
    .set("x-agent-key", authKey)
    .send({ action: "github.addSandboxLabel", params, onBehalfOf: "support@example.test", idempotencyKey: key });
const decide = (id: string, verb = "approve") =>
  request(app)
    .post("/api/actions/" + id + "/" + verb)
    .set("Authorization", "Bearer " + token);

beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  env.DEMO_MODE = true;
  const seed = await seedDemoData();
  agentKey = seed.agentKeys.find((k) => k.agentName === "Support Copilot")!.apiKey;
  otherKey = seed.agentKeys.find((k) => k.agentName === "Globex Assistant")!.apiKey;
  workspaceId = seed.workspaces.find((w) => w.name === "Acme Travels")!.workspaceId;
  token = (await request(app).post("/api/auth/login").send({ email: "manager@acme.test", password: DEMO_PASSWORD })).body.data.token;
  await Workspace.updateOne({ _id: workspaceId }, { $set: { slug: "private-engineering-sandbox" } });
  Object.assign(env, {
    DEMO_MODE: false,
    GITHUB_SANDBOX_TOKEN: "github_test_secret",
    GITHUB_SANDBOX_REPOSITORY: "example/agentguard-sandbox",
    GITHUB_SANDBOX_WORKSPACE_ID: workspaceId,
    GITHUB_SANDBOX_LABEL: "agentguard-demo"
  });
  labels = ["bug"];
  version = 0;
  reads = 0;
  changeOnRead = 0;
  calls = [];
  failStatus = 0;
  failWrite = false;
  pullRequest = false;
  spy = jest.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).replace("https://api.github.com/repos/example/agentguard-sandbox", "");
    const method = init?.method || "GET";
    calls.push({ method, path });
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeDefined();
    if (failWrite && method !== "GET") throw new Error("Timeout with github_test_secret");
    if (failStatus) return new Response(JSON.stringify({ message: "github_test_secret" }), { status: failStatus });
    if (method === "POST") {
      labels.push(...JSON.parse(init?.body as string).labels);
      version++;
    }
    if (method === "DELETE") {
      labels = labels.filter((label) => label !== "agentguard-demo");
      version++;
    }
    if (path === "/issues/1") {
      reads++;
      if (changeOnRead === reads) {
        labels.push("human-added");
        version++;
      }
      return Response.json({
        number: 1,
        title: "Sandbox task",
        state: "open",
        updated_at: stamp(),
        labels: labels.map((name) => ({ name })),
        ...(pullRequest ? { pull_request: {} } : {})
      });
    }
    return Response.json(path.startsWith("/labels/") ? { name: "agentguard-demo" } : labels.map((name) => ({ name })));
  });
});
afterEach(async () => {
  spy.mockRestore();
  await Workspace.updateOne({ _id: workspaceId }, { $set: { slug: "acme-travels" } });
  Object.assign(env, { DEMO_MODE: true, GITHUB_SANDBOX_TOKEN: "", GITHUB_SANDBOX_REPOSITORY: "", GITHUB_SANDBOX_WORKSPACE_ID: "" });
});

test("human approval gates the external write; undo removes only its label", async () => {
  const sent = await submit();
  expect(sent.status).toBe(202);
  expect(writes()).toHaveLength(0);
  expect(sent.body.data.facts).toMatchObject({ repository: "example/agentguard-sandbox", issueNumber: 1, labels: ["bug"] });
  const id = sent.body.data.actionId;
  expect((await decide(id)).body.data.status).toBe("done");
  expect(labels).toEqual(["bug", "agentguard-demo"]);
  expect((await decide(id, "undo")).body.data.status).toBe("undone");
  expect(labels).toEqual(["bug"]);
  expect(writes().map((call) => call.method)).toEqual(["POST", "DELETE"]);
  expect(await AuditEvent.countDocuments({ actionId: id, type: "action_undone" })).toBe(1);
});

test("wildcard allow cannot bypass external approval", async () => {
  await Policy.create({ workspaceId, name: "Allow everything", action: "*", effect: "allow", conditions: [], enabled: true });
  expect((await submit()).body.data.status).toBe("pending_approval");
  expect(writes()).toHaveLength(0);
});

test("a deny rule still wins", async () => {
  await Policy.create({ workspaceId, name: "No external changes", action: "github.addSandboxLabel", effect: "deny", conditions: [], enabled: true });
  expect((await submit()).body.data.status).toBe("denied");
  expect(writes()).toHaveLength(0);
});

test("retries and racing approval/undo clicks perform each write once", async () => {
  const key = crypto.randomUUID();
  const sent = await submit(undefined, key),
    duplicate = await submit(undefined, key);
  const id = sent.body.data.actionId;
  expect(duplicate.body.data.actionId).toBe(id);
  expect((await Promise.all(Array.from({ length: 5 }, () => decide(id)))).filter((res) => res.status === 200)).toHaveLength(1);
  expect((await Promise.all(Array.from({ length: 5 }, () => decide(id, "undo")))).filter((res) => res.status === 200)).toHaveLength(1);
  expect(writes().map((call) => call.method)).toEqual(["POST", "DELETE"]);
});

test("rejection never writes to GitHub", async () => {
  const sent = await submit();
  expect((await decide(sent.body.data.actionId, "reject")).body.data.status).toBe("rejected");
  expect(writes()).toHaveLength(0);
});

test("refuses issues changed while waiting for approval", async () => {
  const sent = await submit();
  labels.push("human-added");
  version++;
  expect((await decide(sent.body.data.actionId)).body.data.status).toBe("failed");
  expect(writes()).toHaveLength(0);
});

test("rechecks after snapshot capture immediately before execution", async () => {
  const sent = await submit();
  changeOnRead = reads + 2;
  expect((await decide(sent.body.data.actionId)).body.data.status).toBe("failed");
  expect(writes()).toHaveLength(0);
});

test("undo preserves human edits and refuses a changed issue", async () => {
  const sent = await submit();
  const id = sent.body.data.actionId;
  await decide(id);
  labels.push("human-added");
  version++;
  expect((await decide(id, "undo")).status).toBe(409);
  expect(labels).toEqual(["bug", "agentguard-demo", "human-added"]);
  expect(writes()).toHaveLength(1);
});

test("configuration changes cannot redirect an old undo", async () => {
  const sent = await submit();
  const id = sent.body.data.actionId;
  await decide(id);
  env.GITHUB_SANDBOX_REPOSITORY = "example/other";
  expect((await decide(id, "undo")).status).toBe(409);
  expect(writes()).toHaveLength(1);
});

test("other companies and public demos cannot contact GitHub", async () => {
  expect((await submit(undefined, undefined, otherKey)).status).toBe(403);
  env.DEMO_MODE = true;
  expect((await submit()).status).toBe(503);
  env.DEMO_MODE = false;
  await Workspace.updateOne({ _id: workspaceId }, { $set: { slug: "acme-travels" } });
  expect((await submit()).status).toBe(403);
  expect(calls).toHaveLength(0);
});

test("agents cannot choose repository, label, host or invalid issue numbers", async () => {
  for (const params of [
    { issueNumber: 1, repository: "evil/target" },
    { issueNumber: 1, label: "production" },
    { issueNumber: 1, url: "http://localhost" },
    { issueNumber: -1 }
  ])
    expect((await submit(params)).status).toBe(400);
  expect(calls).toHaveLength(0);
});

test("refuses pull requests and labels already present", async () => {
  pullRequest = true;
  expect((await submit()).status).toBe(409);
  pullRequest = false;
  labels.push("agentguard-demo");
  expect((await submit()).status).toBe(409);
  expect(writes()).toHaveLength(0);
});

test.each([401, 403, 404, 429, 500])("GitHub %s errors expose no remote bodies or credentials", async (status) => {
  failStatus = status;
  const response = await submit();
  expect(response.status).toBe(status === 401 || status === 403 ? 403 : status === 404 ? 404 : 503);
  expect(JSON.stringify(response.body)).not.toContain("github_test_secret");
  expect(writes()).toHaveLength(0);
});

test("an ambiguous write timeout is never retried automatically", async () => {
  const sent = await submit();
  const id = sent.body.data.actionId;
  failWrite = true;
  const response = await decide(id);
  expect(response.body.data.status).toBe("failed");
  expect(response.body.data.errorMessage).toContain("write may already have happened");
  expect(writes()).toHaveLength(1);
  expect((await decide(id)).status).toBe(409);
  expect(writes()).toHaveLength(1);
});

test("reusing a key for a different issue is refused before contacting GitHub", async () => {
  const key = crypto.randomUUID();
  await submit({ issueNumber: 1 }, key);
  const before = calls.length;
  expect((await submit({ issueNumber: 2 }, key)).status).toBe(409);
  expect(calls).toHaveLength(before);
});
