import crypto from "crypto";
import request from "supertest";
import { AgentReplay, init, startRun } from "@sritarak/agentreplay";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { Booking } from "../src/models/demo.model";
import { ActionRecord } from "../src/models/actionRecord.model";
import * as llmClient from "../src/services/llm/llmClient";
import { DEMO_PASSWORD, seedDemoData, SeedResult } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The same layer is counted, not replaced: the real SDK still runs, so these tests see what it would really send.
jest.mock("@sritarak/agentreplay", () => {
  const actual = jest.requireActual("@sritarak/agentreplay");
  return {
    ...actual,
    AgentReplay: jest.fn((...args: unknown[]) => new actual.AgentReplay(...args)),
    init: jest.fn(actual.init),
    startRun: jest.fn(actual.startRun),
  };
});

// Deep links to one action, the optional AgentReplay recording of playground runs, and "agents can never undo".

const app = createApp();
let seed: SeedResult;
let acmeAgentKey: string;
let globexAgentKey: string;

const mutableEnv = env as { AGENTREPLAY_API_KEY: string; AGENTREPLAY_URL: string };
const INGEST_URL = "https://replay.example.test/api/ingest";
const INSTRUCTION = "Cancel BK-1002, BK-1001 and give BK-1003 a 40% discount";

interface IngestStep {
  type: string;
  name: string;
  input: string;
  output: string;
  error: string;
  externalRef?: { system: string; id: string; url: string };
}
interface IngestRun {
  id: string;
  name?: string;
  userRef?: string;
  status?: string;
}

let ingestCalls: { url: string; body: { runs: IngestRun[]; steps: IngestStep[] } }[] = [];
let fetchSpy: jest.SpyInstance;
let planSpy: jest.SpyInstance | undefined;

async function loginAs(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

function agentRequest(key: string, body: Record<string, unknown>) {
  return request(app)
    .post("/api/agent/actions")
    .set("x-agent-key", key)
    .send({ onBehalfOf: "Ravi (support team)", reason: "Customer asked in chat", idempotencyKey: crypto.randomUUID(), ...body });
}

// A plan the demo AI agent "made": one action that runs, one that waits for a person, one that is refused.
function planWith(actions: { action: string; params: Record<string, unknown> }[]) {
  planSpy = jest.spyOn(llmClient, "completeJson").mockResolvedValue({
    message: "On it.",
    actions: actions.map((planned) => ({ ...planned, reason: "Customer asked" })),
  });
}

const PLAN = [
  { action: "booking.cancel", params: { bookingCode: "BK-1002" } }, // small: runs on its own
  { action: "booking.cancel", params: { bookingCode: "BK-1001" } }, // big: waits for a person
  { action: "booking.applyDiscount", params: { bookingCode: "BK-1003", percent: 40 } }, // never allowed
];

async function playgroundChat(token: string) {
  return request(app)
    .post("/api/demo/playground/chat")
    .set("authorization", `Bearer ${token}`)
    .send({ instruction: INSTRUCTION, onBehalfOf: "Ravi (support team)" });
}

// Recording is sent in the background, so wait for it to arrive.
async function waitForIngest() {
  for (let attempt = 0; attempt < 100 && ingestCalls.length === 0; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    steps: ingestCalls.flatMap((call) => call.body.steps),
    runs: ingestCalls.flatMap((call) => call.body.runs),
  };
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
  ingestCalls = [];
  jest.mocked(AgentReplay).mockClear();
  jest.mocked(init).mockClear();
  jest.mocked(startRun).mockClear();
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(async (input, init) => {
    ingestCalls.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return new Response("{}", { status: 200 });
  });
});

afterEach(() => {
  // Only the spies made here are put back; the counting wrapper around the SDK must keep working.
  fetchSpy.mockRestore();
  planSpy?.mockRestore();
  planSpy = undefined;
  mutableEnv.AGENTREPLAY_API_KEY = "";
  mutableEnv.AGENTREPLAY_URL = "";
});

describe("deep link to one action", () => {
  it("opens an action of the signed-in person's own company", async () => {
    const created = await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" } });
    const token = await loginAs("manager@acme.test");
    const res = await request(app).get(`/api/actions/${created.body.data.actionId}`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(created.body.data.actionId);
    expect(res.body.data.timeline.length).toBeGreaterThan(0);
  });

  it("says not found for another company's action, a made-up id and a malformed id", async () => {
    const globex = await agentRequest(globexAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-2001" } });
    const token = await loginAs("manager@acme.test");
    const otherCompany = await request(app).get(`/api/actions/${globex.body.data.actionId}`).set("authorization", `Bearer ${token}`);
    expect(otherCompany.status).toBe(404);
    // Nothing of the other company's action leaks into the answer.
    expect(JSON.stringify(otherCompany.body)).not.toContain("BK-2001");

    const madeUp = await request(app).get("/api/actions/64b7f0f0f0f0f0f0f0f0f0f0").set("authorization", `Bearer ${token}`);
    expect(madeUp.status).toBe(404);
    const malformed = await request(app).get("/api/actions/not-an-id").set("authorization", `Bearer ${token}`);
    expect(malformed.status).toBe(404);
  });

  it("needs a signed-in person", async () => {
    const created = await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" } });
    const res = await request(app).get(`/api/actions/${created.body.data.actionId}`);
    expect(res.status).toBe(401);
  });
});

describe("recording playground runs in AgentReplay", () => {
  it("is off without a key: nothing is created, sent or started", async () => {
    planWith(PLAN);
    const token = await loginAs("manager@acme.test");
    const res = await playgroundChat(token);

    expect(res.status).toBe(200);
    expect(res.body.data.outcomes).toHaveLength(3);
    expect(AgentReplay).not.toHaveBeenCalled();
    expect(init).not.toHaveBeenCalled();
    expect(startRun).not.toHaveBeenCalled();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(ingestCalls).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("with a key, records one run with an AI step and a linked step for each guarded action", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "ar_test_key_for_tests";
    mutableEnv.AGENTREPLAY_URL = "https://replay.example.test/";
    planWith(PLAN);
    const token = await loginAs("manager@acme.test");
    const res = await playgroundChat(token);
    expect(res.status).toBe(200);

    const { steps, runs } = await waitForIngest();
    expect(ingestCalls[0].url).toBe(INGEST_URL);

    // One run for the request, named after it, for the person the agent worked for.
    expect(new Set(runs.map((run) => run.id)).size).toBe(1);
    expect(runs[0].name).toBe(INSTRUCTION);
    expect(runs[0].userRef).toBe("Ravi (support team)");
    expect(runs.some((run) => run.status === "ok")).toBe(true);

    // The AI planning call, then one tool step per action, in order.
    expect(steps.map((step) => step.type)).toEqual(["llm", "tool", "tool", "tool"]);
    const [, small, big, refused] = steps;

    const outcomes = res.body.data.outcomes as { outcome: { id: string; status: string } }[];
    expect(outcomes.map((item) => item.outcome.status)).toEqual(["done", "pending_approval", "denied"]);
    [small, big, refused].forEach((step, index) => {
      const id = outcomes[index].outcome.id;
      expect(step.externalRef).toEqual({
        system: "agentguard",
        id,
        url: `${env.CLIENT_ORIGIN}/activity?action=${id}`,
      });
    });

    expect(small.name).toBe("booking.cancel");
    expect(JSON.parse(small.output)).toMatchObject({ status: "done", result: { refundAmount: 4500 } });
    expect(JSON.parse(big.output)).toMatchObject({ status: "pending_approval" });
    expect(JSON.parse(refused.output)).toMatchObject({ status: "denied" });
  });

  it("records a single playground action as its own run", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "ar_test_key_for_tests";
    const token = await loginAs("manager@acme.test");
    const res = await request(app)
      .post("/api/demo/playground/act")
      .set("authorization", `Bearer ${token}`)
      .send({ action: "booking.cancel", params: { bookingCode: "BK-1002" }, onBehalfOf: "Ravi (support team)" });
    expect(res.status).toBe(200);

    const { steps, runs } = await waitForIngest();
    expect(runs[0].name).toBe("booking.cancel");
    expect(steps).toHaveLength(1);
    expect(steps[0].externalRef?.id).toBe(res.body.data.id);
  });

  it("reports a plan step that was refused as a failed step, without a link", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "ar_test_key_for_tests";
    planWith([{ action: "booking.cancel", params: { bookingCode: "BK-9999" } }]);
    const token = await loginAs("manager@acme.test");
    const res = await playgroundChat(token);
    expect(res.status).toBe(200);
    expect(res.body.data.outcomes[0].error).toBeTruthy();

    const { steps, runs } = await waitForIngest();
    expect(steps).toHaveLength(2); // the AI step and the step that did not work
    expect(steps[1].error).not.toBe("");
    expect(steps[1].externalRef).toBeUndefined();
    expect(runs.some((run) => run.status === "failed")).toBe(true);
  });

  it("never lets a recording problem break or slow the playground when AgentReplay cannot be reached", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "ar_test_key_for_tests";
    const token = await loginAs("manager@acme.test");

    // 1. The connection is refused.
    planWith(PLAN);
    fetchSpy.mockImplementation(async () => {
      throw new Error("connect ECONNREFUSED");
    });
    const refused = await playgroundChat(token);
    expect(refused.status).toBe(200);
    expect(refused.body.data.outcomes.map((item: { outcome: { status: string } }) => item.outcome.status)).toEqual([
      "done",
      "pending_approval",
      "denied",
    ]);
    expect((await Booking.findOne({ code: "BK-1002" }).lean())?.status).toBe("cancelled");

    // 2. The server accepts the connection and then never answers: the playground must not wait for it.
    fetchSpy.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const silent = await request(app)
      .post("/api/demo/playground/act")
      .set("authorization", `Bearer ${token}`)
      .send({ action: "booking.cancel", params: { bookingCode: "BK-1004" }, onBehalfOf: "Ravi (support team)" });
    expect(silent.status).toBe(200);
    expect(silent.body.data.status).toBe("done");
    expect(Date.now() - started).toBeLessThan(2000); // the SDK itself would wait up to 3 seconds
  });

  it("does not hide the AI service being unavailable, and the run is still closed", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "ar_test_key_for_tests";
    const token = await loginAs("manager@acme.test");
    // LLM_PROVIDER is "none" in tests, so the real planner reports that AI is not set up.
    const res = await playgroundChat(token);
    expect(res.status).toBe(503);

    const { steps, runs } = await waitForIngest();
    expect(steps).toHaveLength(1);
    expect(steps[0].type).toBe("llm");
    expect(steps[0].error).not.toBe("");
    expect(runs.some((run) => run.status === "failed")).toBe(true);
  });
});

describe("agents and keys can never undo", () => {
  it("refuses undo for every kind of key, and leaves the action done", async () => {
    const created = await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" } });
    const actionId = created.body.data.actionId as string;
    expect(created.body.data.status).toBe("done");

    const keys = [acmeAgentKey, globexAgentKey, "ar_test_key_for_tests"];
    for (const key of keys) {
      // As an agent key in the agent header, in the Authorization header, and as a person's token.
      for (const headers of [{ "x-agent-key": key }, { authorization: `Bearer ${key}` }]) {
        const res = await request(app).post(`/api/actions/${actionId}/undo`).set(headers);
        expect(res.status).toBe(401);
      }
      expect((await request(app).post(`/api/agent/actions/${actionId}/undo`).set("x-agent-key", key)).status).toBe(404);
      expect((await request(app).post(`/api/agent/actions/${actionId}`).set("x-agent-key", key)).status).toBe(404);
    }

    expect((await ActionRecord.findById(actionId).lean())?.status).toBe("done");
    expect((await Booking.findOne({ code: "BK-1002" }).lean())?.status).toBe("cancelled");
  });

  it("offers no undo tool over MCP", async () => {
    const res = await request(app)
      .post("/api/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("authorization", `Bearer ${acmeAgentKey}`)
      .send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const names = (res.body.result.tools as { name: string }[]).map((tool) => tool.name);
    expect(names.some((name) => /undo|revert|rollback/i.test(name))).toBe(false);

    const call = await request(app)
      .post("/api/mcp")
      .set("accept", "application/json, text/event-stream")
      .set("authorization", `Bearer ${acmeAgentKey}`)
      .send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "undo_action", arguments: {} } });
    expect(call.body.error ?? call.body.result?.isError).toBeTruthy();
  });

  it("still lets a manager undo, and records who did it", async () => {
    const created = await agentRequest(acmeAgentKey, { action: "booking.cancel", params: { bookingCode: "BK-1002" } });
    const token = await loginAs("manager@acme.test");
    const res = await request(app).post(`/api/actions/${created.body.data.actionId}/undo`).set("authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe("undone");
    expect(res.body.data.undoneBy).toBe("Karan Shah");
  });
});
