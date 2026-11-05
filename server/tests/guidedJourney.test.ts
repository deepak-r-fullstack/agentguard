import crypto from "crypto";
import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { ActionRecord } from "../src/models/actionRecord.model";
import { Booking } from "../src/models/demo.model";
import { Policy } from "../src/models/policy.model";
import { DEMO_PASSWORD, seedDemoData } from "../src/services/demo/demo.service";
import { clearRecordingLookupCache, RECORDING_CONFIRM_WINDOW_MS } from "../src/services/replay/guidedJourney.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The guided booking journey that connects AgentGuard and AgentReplay:
//   start a practice booking -> the agent asks to cancel -> AgentGuard explains why a person must approve ->
//   a manager approves -> the journey is recorded in AgentReplay -> "View recording" -> Undo here.
// AgentReplay is faked at the network edge (fetch), so the real SDK still builds what it would really send.

const app = createApp();
const mutableEnv = env as { AGENTREPLAY_API_KEY: string; AGENTREPLAY_URL: string };
const SDK_KEY = `ar_${"ab12".repeat(12)}`;
const REPLAY_URL = "https://replay.example.test";

interface SentStep {
  runId: string;
  index: number;
  name: string;
  type: string;
  input: string;
  output: string;
  error: string;
  externalRef?: { system: string; id: string; url: string };
}
interface SentRun {
  id: string;
  name?: string;
  userRef?: string;
  status?: string;
}

// How the fake AgentReplay behaves.
let ingestMode: "ok" | "down" = "ok";
let lookupMode: "real" | "down" | "missing" = "real";
let sentRuns: SentRun[] = [];
let sentSteps: SentStep[] = [];
let ingestCalls = 0;
let lookupCalls: { url: string; key: string | null }[] = [];
let fetchSpy: jest.SpyInstance;

function fakeAgentReplay(input: unknown, init?: RequestInit): Promise<Response> {
  const url = String(input);
  if (url === `${REPLAY_URL}/api/ingest`) {
    ingestCalls += 1;
    if (ingestMode === "down") return Promise.reject(new Error("connect ECONNREFUSED"));
    const body = JSON.parse(String(init?.body)) as { runs: SentRun[]; steps: SentStep[] };
    sentRuns.push(...body.runs);
    sentSteps.push(...body.steps);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }
  const lookup = url.match(/^https:\/\/replay\.example\.test\/api\/ingest\/runs\/([^?]+)\?ref=(.+)$/);
  if (lookup) {
    lookupCalls.push({ url, key: new Headers(init?.headers).get("x-api-key") });
    if (lookupMode === "down") return Promise.reject(new Error("connect ETIMEDOUT"));
    const [, runId, ref] = lookup.map(decodeURIComponent);
    const steps = sentSteps.filter((step) => step.runId === runId);
    if (lookupMode === "missing" || steps.length === 0) return Promise.resolve(new Response("{}", { status: 404 }));
    const linked = steps.some((step) => step.externalRef?.system === "agentguard" && step.externalRef.id === ref);
    return Promise.resolve(new Response(JSON.stringify({ data: { externalId: runId, status: "ok", stepCount: steps.length, linked } }), { status: 200 }));
  }
  return Promise.reject(new Error(`Unexpected request in a test: ${url}`));
}

async function waitFor(check: () => Promise<boolean> | boolean, what: string) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

async function login(email: string) {
  const res = await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD });
  return res.body.data.token as string;
}

const as = (token: string) => ({
  start: (attemptId?: string) => request(app).post("/api/demo/walkthrough").set("authorization", `Bearer ${token}`).send(attemptId ? { attemptId } : {}),
  ask: (bookingCode: string) => request(app).post("/api/demo/walkthrough/request").set("authorization", `Bearer ${token}`).send({ bookingCode }),
  recording: (actionId: string) => request(app).get(`/api/demo/walkthrough/actions/${actionId}/recording`).set("authorization", `Bearer ${token}`),
  approve: (actionId: string) => request(app).post(`/api/actions/${actionId}/approve`).set("authorization", `Bearer ${token}`),
  reject: (actionId: string) => request(app).post(`/api/actions/${actionId}/reject`).set("authorization", `Bearer ${token}`).send({}),
  undo: (actionId: string) => request(app).post(`/api/actions/${actionId}/undo`).set("authorization", `Bearer ${token}`),
  detail: (actionId: string) => request(app).get(`/api/actions/${actionId}`).set("authorization", `Bearer ${token}`),
});

let manager: ReturnType<typeof as>;

// Prepares a booking and has the agent ask to cancel it. Returns the waiting action.
async function preparedRequest() {
  const started = await manager.start(crypto.randomUUID());
  const asked = await manager.ask(started.body.data.bookingCode);
  expect(asked.status).toBe(200);
  return { bookingCode: started.body.data.bookingCode as string, actionId: asked.body.data.id as string, asked };
}

const recordingSent = (actionId: string) => async () => (await ActionRecord.findById(actionId).lean())?.replayRecording?.state === "sent";
const stepsOf = (runId: string) => sentSteps.filter((step) => step.runId === runId).sort((a, b) => a.index - b.index);

beforeAll(startTestDb);
afterAll(stopTestDb);

beforeEach(async () => {
  await seedDemoData();
  manager = as(await login("manager@acme.test"));
  mutableEnv.AGENTREPLAY_API_KEY = SDK_KEY;
  mutableEnv.AGENTREPLAY_URL = REPLAY_URL;
  ingestMode = "ok";
  lookupMode = "real";
  sentRuns = [];
  sentSteps = [];
  ingestCalls = 0;
  lookupCalls = [];
  clearRecordingLookupCache();
  fetchSpy = jest.spyOn(global, "fetch").mockImplementation(fakeAgentReplay as typeof fetch);
});

afterEach(() => {
  fetchSpy.mockRestore();
  mutableEnv.AGENTREPLAY_API_KEY = "";
  mutableEnv.AGENTREPLAY_URL = "";
});

describe("the complete journey", () => {
  it("explains the approval, records the decided journey, links it to the action, and Undo restores the booking", async () => {
    const { bookingCode, actionId, asked } = await preparedRequest();

    // AgentGuard paused the request and says why, in plain words.
    expect(asked.body.data).toMatchObject({ status: "pending_approval", decision: "require_approval", guidedDemo: true });
    expect(asked.body.data.decisionReasons.join(" ")).toMatch(/Big cancellations need a manager/);
    expect((await Booking.findOne({ code: bookingCode }).lean())?.status).toBe("confirmed");
    // Nothing is recorded before a person decides.
    expect((await manager.recording(actionId)).body.data).toMatchObject({ state: "waiting" });
    expect(ingestCalls).toBe(0);

    const approved = await manager.approve(actionId);
    expect(approved.body.data.status).toBe("done");
    expect(await Booking.findOne({ code: bookingCode }).lean()).toMatchObject({ status: "cancelled", refundAmount: 7500 });

    await waitFor(recordingSent(actionId), "the recording to be sent");
    const runId = (await ActionRecord.findById(actionId).lean())!.replayRecording!.runId;
    const ready = await manager.recording(actionId);
    expect(ready.body.data).toEqual({
      state: "available",
      message: expect.stringContaining("ready"),
      url: `${REPLAY_URL}/runs?externalId=${runId}`,
    });

    // The recording is this journey: four steps, each linking back to this action, named after this booking.
    const run = sentRuns.find((candidate) => candidate.id === runId && candidate.name);
    expect(run).toMatchObject({ name: `Guided demo: cancel booking ${bookingCode}`, userRef: "Demo support visitor" });
    const steps = stepsOf(runId);
    expect(steps.map((step) => step.name)).toEqual([
      "Agent asks to cancel the booking",
      "AgentGuard checks the company rules",
      "A manager approves in AgentGuard",
      "AgentGuard cancels the booking",
    ]);
    for (const step of steps) expect(step.externalRef).toEqual({ system: "agentguard", id: actionId, url: expect.stringContaining(`/activity?action=${actionId}`) });
    expect(steps[1].output).toMatch(/Needs a manager's approval/);
    expect(steps[2].output).toMatch(/Karan Shah/);
    expect(steps[3].output).toMatch(/7500/);

    // Undo happens here, and the booking is back the way it was.
    expect((await manager.undo(actionId)).body.data.status).toBe("undone");
    expect(await Booking.findOne({ code: bookingCode }).lean()).toMatchObject({ status: "confirmed", refundAmount: 0 });
    expect((await manager.recording(actionId)).body.data.state).toBe("available");
    const history = await manager.detail(actionId);
    expect(history.body.data.timeline.map((event: { type: string }) => event.type)).toEqual([
      "action_requested",
      "approval_requested",
      "action_approved",
      "action_executed",
      "action_undone",
    ]);
  });

  it("keeps the SDK key on the server: the browser sees only the viewing link", async () => {
    const { actionId } = await preparedRequest();
    await manager.approve(actionId);
    await waitFor(recordingSent(actionId), "the recording to be sent");
    const status = await manager.recording(actionId);
    expect(JSON.stringify(status.body)).not.toContain(SDK_KEY);
    expect(JSON.stringify((await manager.detail(actionId)).body)).not.toContain(SDK_KEY);
    // The check itself carries the key, server to server.
    expect(lookupCalls.length).toBeGreaterThan(0);
    expect(lookupCalls.every((call) => call.key === SDK_KEY)).toBe(true);
  });

  it("records a rejected journey too, without a result step", async () => {
    const { actionId, bookingCode } = await preparedRequest();
    expect((await manager.reject(actionId)).body.data.status).toBe("rejected");
    await waitFor(recordingSent(actionId), "the recording to be sent");
    const runId = (await ActionRecord.findById(actionId).lean())!.replayRecording!.runId;
    expect(stepsOf(runId).map((step) => step.name)).toEqual(["Agent asks to cancel the booking", "AgentGuard checks the company rules", "A manager rejects in AgentGuard"]);
    expect((await Booking.findOne({ code: bookingCode }).lean())?.status).toBe("confirmed");
  });

  it("records a request that the rules refused straight away", async () => {
    await Policy.updateOne({ name: "Big cancellations need a manager" }, { $set: { effect: "deny" } });
    const started = await manager.start(crypto.randomUUID());
    const asked = await manager.ask(started.body.data.bookingCode);
    expect(asked.body.data.status).toBe("denied");
    await waitFor(recordingSent(asked.body.data.id), "the recording to be sent");
    const runId = (await ActionRecord.findById(asked.body.data.id).lean())!.replayRecording!.runId;
    expect(stepsOf(runId)).toHaveLength(2);
    expect(stepsOf(runId)[1].output).toMatch(/Refused/);
  });
});

describe("repeated clicks and retries", () => {
  it("makes one booking per attempt, however often the same attempt is sent", async () => {
    const attemptId = crypto.randomUUID();
    const before = await Booking.countDocuments();
    const replies = await Promise.all(Array.from({ length: 6 }, () => manager.start(attemptId)));
    const codes = new Set(replies.map((reply) => reply.body.data.bookingCode));
    expect(replies.every((reply) => reply.status === 201)).toBe(true);
    expect(codes.size).toBe(1);
    expect(await Booking.countDocuments()).toBe(before + 1);
    // A new attempt is a new booking, and another person's attempt with the same id is theirs alone.
    expect((await manager.start(crypto.randomUUID())).body.data.bookingCode).not.toBe([...codes][0]);
    const admin = as(await login("admin@acme.test"));
    expect((await admin.start(attemptId)).body.data.bookingCode).not.toBe([...codes][0]);
  });

  it("asks once per booking: simultaneous and repeated requests return the same action", async () => {
    const started = await manager.start(crypto.randomUUID());
    const code = started.body.data.bookingCode;
    const replies = await Promise.all(Array.from({ length: 6 }, () => manager.ask(code)));
    expect(new Set(replies.map((reply) => reply.body.data.id)).size).toBe(1);
    expect(await ActionRecord.countDocuments({ "params.bookingCode": code })).toBe(1);
    // Asking again later still finds the same request.
    expect((await manager.ask(code)).body.data.id).toBe(replies[0].body.data.id);
  });

  it("approves once, records once and undoes once, however many clicks arrive together", async () => {
    const { actionId, bookingCode } = await preparedRequest();
    const approvals = await Promise.all(Array.from({ length: 5 }, () => manager.approve(actionId)));
    expect(approvals.filter((reply) => reply.status === 200)).toHaveLength(1);
    expect(approvals.filter((reply) => reply.status === 409)).toHaveLength(4);
    await waitFor(recordingSent(actionId), "the recording to be sent");
    // Status checks from several tabs never record the journey a second time.
    await Promise.all(Array.from({ length: 5 }, () => manager.recording(actionId)));
    expect(new Set(sentSteps.map((step) => step.runId)).size).toBe(1);
    expect(sentSteps).toHaveLength(4);

    const undos = await Promise.all(Array.from({ length: 5 }, () => manager.undo(actionId)));
    expect(undos.filter((reply) => reply.status === 200)).toHaveLength(1);
    expect(await Booking.findOne({ code: bookingCode }).lean()).toMatchObject({ status: "confirmed", refundAmount: 0 });
  });
});

describe("when recording fails or is slow", () => {
  it("still approves when AgentReplay is down, says pending at first and unavailable once the wait is over", async () => {
    ingestMode = "down";
    lookupMode = "missing";
    const { actionId, bookingCode } = await preparedRequest();
    const approved = await manager.approve(actionId);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe("done");
    expect((await Booking.findOne({ code: bookingCode }).lean())?.status).toBe("cancelled");
    await waitFor(recordingSent(actionId), "the recording attempt");
    await waitFor(() => ingestCalls > 0, "the send attempt");

    const early = await manager.recording(actionId);
    expect(early.body.data).toMatchObject({ state: "pending" });
    expect(early.body.data.url).toBeUndefined();

    await ActionRecord.updateOne({ _id: actionId }, { $set: { "replayRecording.sentAt": new Date(Date.now() - RECORDING_CONFIRM_WINDOW_MS - 1000) } });
    clearRecordingLookupCache();
    const late = await manager.recording(actionId);
    expect(late.body.data).toMatchObject({ state: "unavailable", message: expect.stringContaining("did not receive") });
    expect(late.body.data.url).toBeUndefined();
    // Undo is not affected.
    expect((await manager.undo(actionId)).body.data.status).toBe("undone");
  });

  it("turns from pending to available when a delayed recording arrives, even after the wait", async () => {
    lookupMode = "missing";
    const { actionId } = await preparedRequest();
    await manager.approve(actionId);
    await waitFor(recordingSent(actionId), "the recording to be sent");
    expect((await manager.recording(actionId)).body.data.state).toBe("pending");

    await ActionRecord.updateOne({ _id: actionId }, { $set: { "replayRecording.sentAt": new Date(Date.now() - RECORDING_CONFIRM_WINDOW_MS - 1000) } });
    lookupMode = "real";
    clearRecordingLookupCache();
    expect((await manager.recording(actionId)).body.data.state).toBe("available");
    // Once confirmed, AgentReplay is not asked again.
    const calls = lookupCalls.length;
    lookupMode = "down";
    expect((await manager.recording(actionId)).body.data.state).toBe("available");
    expect(lookupCalls.length).toBe(calls);
  });

  it("says pending while AgentReplay cannot be reached to confirm, then that it could not be confirmed", async () => {
    lookupMode = "down";
    const { actionId } = await preparedRequest();
    await manager.approve(actionId);
    await waitFor(recordingSent(actionId), "the recording to be sent");
    expect((await manager.recording(actionId)).body.data.state).toBe("pending");
    await ActionRecord.updateOne({ _id: actionId }, { $set: { "replayRecording.sentAt": new Date(Date.now() - RECORDING_CONFIRM_WINDOW_MS - 1000) } });
    clearRecordingLookupCache();
    expect((await manager.recording(actionId)).body.data).toMatchObject({ state: "unavailable", message: expect.stringContaining("could not be reached") });
  });

  it("never offers a recording that does not link to this action", async () => {
    const { actionId } = await preparedRequest();
    await manager.approve(actionId);
    await waitFor(recordingSent(actionId), "the recording to be sent");
    // AgentReplay holds a run with that id, but its steps point at a different action.
    for (const step of sentSteps) step.externalRef = { system: "agentguard", id: "64b7f0f0f0f0f0f0f0f0f0f0", url: "https://example.test" };
    const status = await manager.recording(actionId);
    expect(status.body.data.state).toBe("pending");
    expect(status.body.data.url).toBeUndefined();
  });

  it("works exactly as before with recording turned off: nothing is sent, and the state says so", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "";
    const { actionId } = await preparedRequest();
    expect((await manager.approve(actionId)).body.data.status).toBe("done");
    expect((await manager.recording(actionId)).body.data).toMatchObject({ state: "unavailable", message: expect.stringContaining("not turned on") });
    expect((await manager.undo(actionId)).body.data.status).toBe("undone");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recovers a decided journey that was never recorded (for example after a restart) on the next status check", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "";
    const { actionId } = await preparedRequest();
    await manager.approve(actionId);
    mutableEnv.AGENTREPLAY_API_KEY = SDK_KEY;

    expect((await manager.recording(actionId)).body.data.state).toBe("pending");
    await waitFor(recordingSent(actionId), "the recovered recording to be sent");
    expect((await manager.recording(actionId)).body.data.state).toBe("available");
    expect(new Set(sentSteps.map((step) => step.runId)).size).toBe(1);
  });

  it("records a recovered journey once, even when several status checks arrive together", async () => {
    mutableEnv.AGENTREPLAY_API_KEY = "";
    const { actionId } = await preparedRequest();
    await manager.approve(actionId);
    mutableEnv.AGENTREPLAY_API_KEY = SDK_KEY;

    await Promise.all(Array.from({ length: 6 }, () => manager.recording(actionId)));
    await waitFor(recordingSent(actionId), "the recovered recording to be sent");
    await waitFor(() => sentSteps.length >= 4, "the recording to arrive");
    await new Promise((resolve) => setTimeout(resolve, 100)); // room for any second recording to show up
    expect(new Set(sentSteps.map((step) => step.runId)).size).toBe(1);
    expect(sentSteps).toHaveLength(4);
  });

  it("says an expired request has nothing to record", async () => {
    const { actionId } = await preparedRequest();
    await ActionRecord.updateOne({ _id: actionId }, { $set: { status: "expired" } });
    expect((await manager.recording(actionId)).body.data.state).toBe("unavailable");
    expect(ingestCalls).toBe(0);
  });
});

describe("who can do what", () => {
  it("needs a signed-in person for every step", async () => {
    const { actionId } = await preparedRequest();
    expect((await request(app).post("/api/demo/walkthrough")).status).toBe(401);
    expect((await request(app).post("/api/demo/walkthrough/request").send({ bookingCode: "DEMO-ABCDEFGHJK" })).status).toBe(401);
    expect((await request(app).get(`/api/demo/walkthrough/actions/${actionId}/recording`)).status).toBe(401);
  });

  it("lets an auditor look at the recording state but not start, ask or approve", async () => {
    const { actionId } = await preparedRequest();
    const auditor = as(await login("auditor@acme.test"));
    expect((await auditor.start(crypto.randomUUID())).status).toBe(403);
    expect((await auditor.ask("DEMO-ABCDEFGHJK")).status).toBe(403);
    expect((await auditor.approve(actionId)).status).toBe(403);
    expect((await auditor.recording(actionId)).status).toBe(200);
  });

  it("keeps each company's journey to itself", async () => {
    const { actionId, bookingCode } = await preparedRequest();
    await manager.approve(actionId);
    await waitFor(recordingSent(actionId), "the recording to be sent");
    const globex = as(await login("manager@globex.test"));
    const foreign = await globex.recording(actionId);
    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.body)).not.toContain("externalId");
    // Another company cannot ask about, approve or undo Acme's practice booking either.
    expect((await globex.ask(bookingCode)).status).toBe(404);
    expect((await globex.undo(actionId)).status).toBe(404);
    expect((await Booking.findOne({ code: bookingCode }).lean())?.status).toBe("cancelled");
  });

  it("only uses practice bookings, and says not found for made-up and malformed ids", async () => {
    expect((await manager.ask("BK-1001")).status).toBe(400);
    expect((await manager.ask("DEMO-DOESNOTEXIST")).status).toBe(404);
    expect((await manager.recording("64b7f0f0f0f0f0f0f0f0f0f0")).status).toBe(404);
    expect((await manager.recording("not-an-id")).status).toBe(404);
    expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("confirmed");
  });

  it("says an ordinary playground action has no journey recording", async () => {
    const created = await request(app)
      .post("/api/demo/playground/act")
      .set("authorization", `Bearer ${await login("manager@acme.test")}`)
      .send({ action: "booking.cancel", params: { bookingCode: "BK-1002" }, onBehalfOf: "Ravi" });
    const status = await manager.recording(created.body.data.id);
    expect(status.body.data).toMatchObject({ state: "unavailable", message: expect.stringContaining("not part of the guided demo") });
  });

  it("is off outside demo mode", async () => {
    const { actionId } = await preparedRequest();
    env.DEMO_MODE = false;
    try {
      expect((await manager.ask("DEMO-ABCDEFGHJK")).status).toBe(404);
      expect((await manager.recording(actionId)).status).toBe(404);
    } finally {
      env.DEMO_MODE = true;
    }
  });
});
