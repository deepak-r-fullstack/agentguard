import request from "supertest";
import { createApp } from "../src/app";
import { env } from "../src/config/env";
import { Booking } from "../src/models/demo.model";
import { DEMO_PASSWORD, seedDemoData } from "../src/services/demo/demo.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

const app = createApp();
let token: string;
async function login(email: string) {
  return (await request(app).post("/api/auth/login").send({ email, password: DEMO_PASSWORD })).body.data.token as string;
}
const post = (path: string) =>
  request(app)
    .post(path)
    .set("Authorization", "Bearer " + token);
beforeAll(startTestDb);
afterAll(stopTestDb);
beforeEach(async () => {
  await seedDemoData();
  token = await login("manager@acme.test");
});

test("a separate practice booking completes request, approval, undo and audit", async () => {
  const prepared = await post("/api/demo/walkthrough");
  expect(prepared.status).toBe(201);
  const code = prepared.body.data.bookingCode;
  const sent = await post("/api/demo/playground/act").send({ action: "booking.cancel", params: { bookingCode: code }, onBehalfOf: "Demo support visitor" });
  expect(sent.body.data.status).toBe("pending_approval");
  expect((await Booking.findOne({ code }).lean())?.status).toBe("confirmed");
  const id = sent.body.data.id;
  expect((await post("/api/actions/" + id + "/approve")).body.data.status).toBe("done");
  expect(await Booking.findOne({ code }).lean()).toMatchObject({ status: "cancelled", refundAmount: 7500 });
  expect((await post("/api/actions/" + id + "/undo")).body.data.status).toBe("undone");
  expect(await Booking.findOne({ code }).lean()).toMatchObject({ status: "confirmed", refundAmount: 0 });
  expect((await Booking.findOne({ code: "BK-1001" }).lean())?.status).toBe("confirmed");
  const history = await request(app)
    .get("/api/actions/" + id)
    .set("Authorization", "Bearer " + token);
  expect(history.body.data.timeline.map((e: { type: string }) => e.type)).toEqual([
    "action_requested",
    "approval_requested",
    "action_approved",
    "action_executed",
    "action_undone"
  ]);
});

test("visitors get separate bookings without resetting existing data", async () => {
  const a = await post("/api/demo/walkthrough");
  const b = await post("/api/demo/walkthrough");
  expect(a.body.data.bookingCode).not.toBe(b.body.data.bookingCode);
  expect(await Booking.countDocuments()).toBe(11);
});

test("creation requires a manager in the intended demo company", async () => {
  expect((await request(app).post("/api/demo/walkthrough")).status).toBe(401);
  token = await login("auditor@acme.test");
  expect((await post("/api/demo/walkthrough")).status).toBe(403);
  token = await login("manager@globex.test");
  expect((await post("/api/demo/walkthrough")).status).toBe(404);
});

test("creation is unavailable outside demo mode", async () => {
  env.DEMO_MODE = false;
  try {
    expect((await post("/api/demo/walkthrough")).status).toBe(404);
  } finally {
    env.DEMO_MODE = true;
  }
});

test("recording status exposes no credentials", async () => {
  env.AGENTREPLAY_API_KEY = "ar_test_secret";
  try {
    const response = await request(app)
      .get("/api/demo/recording")
      .set("Authorization", "Bearer " + token);
    expect(response.body.data).toEqual({ configured: true });
    expect(JSON.stringify(response.body)).not.toContain("ar_test_secret");
  } finally {
    env.AGENTREPLAY_API_KEY = "";
  }
});
