import request from "supertest";
import { createApp } from "../src/app";
import { AuditEvent } from "../src/models/auditEvent.model";
import { User } from "../src/models/user.model";
import { hashPassword } from "../src/services/auth/auth.service";
import { DEMO_PASSWORD, seedDemoData } from "../src/services/demo/demo.service";
import { changeTeamMemberRole, generateTemporaryPassword, setTeamMemberActive } from "../src/services/team/team.service";
import { startTestDb, stopTestDb } from "./helpers/testDb";

// The Team screen, end to end through the real HTTP API with a real (in-memory) MongoDB.

const app = createApp();

async function loginAs(email: string, password = DEMO_PASSWORD) {
  const res = await request(app).post("/api/auth/login").send({ email, password });
  expect(res.status).toBe(200);
  return res.body.data.token as string;
}

const authed = (token: string) => ({ authorization: `Bearer ${token}` });
const getTeam = (token: string) => request(app).get("/api/team").set(authed(token));
const addPerson = (token: string, body: Record<string, unknown>) => request(app).post("/api/team").set(authed(token)).send(body);
const setRole = (token: string, id: string, role: string) => request(app).put(`/api/team/${id}/role`).set(authed(token)).send({ role });
const deactivate = (token: string, id: string) => request(app).post(`/api/team/${id}/deactivate`).set(authed(token));
const reactivate = (token: string, id: string) => request(app).post(`/api/team/${id}/reactivate`).set(authed(token));

async function idOf(email: string) {
  return String((await User.findOne({ email }).lean())!._id);
}

// Globex has no admin in the demo data, so tests that need one create it.
async function addGlobexAdmin() {
  const manager = await User.findOne({ email: "manager@globex.test" }).lean();
  await User.create({
    workspaceId: manager!.workspaceId,
    name: "Gita Menon",
    email: "admin@globex.test",
    role: "admin",
    passwordHash: await hashPassword(DEMO_PASSWORD),
  });
}

beforeAll(async () => {
  await startTestDb();
});

afterAll(async () => {
  await stopTestDb();
});

beforeEach(async () => {
  await seedDemoData();
});

describe("who may use the Team screen", () => {
  it("is for admins only", async () => {
    for (const email of ["manager@acme.test", "auditor@acme.test"]) {
      const token = await loginAs(email);
      const someone = await idOf("auditor@acme.test");
      expect((await getTeam(token)).status).toBe(403);
      expect((await addPerson(token, { name: "New Person", email: "new@acme.test", role: "manager" })).status).toBe(403);
      expect((await setRole(token, someone, "admin")).status).toBe(403);
      expect((await deactivate(token, someone)).status).toBe(403);
      expect((await reactivate(token, someone)).status).toBe(403);
    }
    expect(await User.countDocuments({ email: "new@acme.test" })).toBe(0);
  });

  it("needs a sign-in", async () => {
    expect((await request(app).get("/api/team")).status).toBe(401);
  });
});

describe("the list", () => {
  it("shows name, email, role and whether the person is active, and never a password", async () => {
    const res = await getTeam(await loginAs("admin@acme.test"));
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(3);
    const meera = res.body.data.find((person: { email: string }) => person.email === "admin@acme.test");
    expect(meera).toMatchObject({ name: "Meera Nair", email: "admin@acme.test", role: "admin", active: true });
    expect(JSON.stringify(res.body)).not.toMatch(/passwordHash|\$2[aby]\$/);
  });

  it("treats people who existed before the 'active' field as active", async () => {
    await User.collection.updateMany({}, { $unset: { active: "" } });
    const token = await loginAs("admin@acme.test"); // can still sign in
    const res = await getTeam(token);
    expect(res.status).toBe(200);
    expect(res.body.data.every((person: { active: boolean }) => person.active === true)).toBe(true);
  });
});

describe("adding a person", () => {
  it("creates them with a temporary password that works, shown once", async () => {
    const admin = await loginAs("admin@acme.test");
    const res = await addPerson(admin, { name: "  Divya Pillai ", email: "Divya@Acme.test ", role: "manager" });
    expect(res.status).toBe(201);
    expect(res.body.data.member).toMatchObject({ name: "Divya Pillai", email: "divya@acme.test", role: "manager", active: true });
    const password = res.body.data.temporaryPassword as string;
    expect(password.length).toBeGreaterThanOrEqual(12);

    // They can sign in with it, as a manager of the same company.
    const login = await request(app).post("/api/auth/login").send({ email: "divya@acme.test", password });
    expect(login.status).toBe(200);
    expect(login.body.data.user).toMatchObject({ role: "manager", workspaceName: "Acme Travels" });

    // It is never shown again, and only a hash is stored.
    const list = await getTeam(admin);
    expect(JSON.stringify(list.body)).not.toContain(password);
    const stored = await User.findOne({ email: "divya@acme.test" }).select("+passwordHash").lean();
    expect(stored!.passwordHash).not.toContain(password);
  });

  it("records it in the audit log", async () => {
    await addPerson(await loginAs("admin@acme.test"), { name: "Divya Pillai", email: "divya@acme.test", role: "auditor" });
    const events = await AuditEvent.find({ type: "user_added" }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].actor).toMatchObject({ type: "user", name: "Meera Nair" });
    expect(events[0].summary).toBe("Added Divya Pillai (divya@acme.test) as Auditor");
  });

  it("gives each person a different password", () => {
    const passwords = new Set(Array.from({ length: 50 }, generateTemporaryPassword));
    expect(passwords.size).toBe(50);
  });

  it("explains a mistake in plain words and creates nothing", async () => {
    const admin = await loginAs("admin@acme.test");
    expect((await addPerson(admin, { name: "A", email: "a@acme.test", role: "manager" })).status).toBe(400);
    expect((await addPerson(admin, { name: "Divya Pillai", email: "not-an-email", role: "manager" })).status).toBe(400);
    expect((await addPerson(admin, { name: "Divya Pillai", email: "divya@acme.test", role: "owner" })).status).toBe(400);
    expect((await addPerson(admin, { name: "Divya Pillai", email: "divya@acme.test" })).status).toBe(400);
    expect(await User.countDocuments({ email: "divya@acme.test" })).toBe(0);
    expect(await AuditEvent.countDocuments({ type: "user_added" })).toBe(0);
  });

  it("refuses an email that is already used, in this company or another, without saying whose it is", async () => {
    const admin = await loginAs("admin@acme.test");
    const same = await addPerson(admin, { name: "Karan Again", email: "manager@acme.test", role: "manager" });
    expect(same.status).toBe(409);
    const other = await addPerson(admin, { name: "Vikram Again", email: "manager@globex.test", role: "manager" });
    expect(other.status).toBe(409);
    expect(other.body.message).toBe(same.body.message);
    expect(other.body.message).not.toMatch(/globex/i);
    expect(await AuditEvent.countDocuments({ type: "user_added" })).toBe(0);
  });
});

describe("changing a role", () => {
  it("changes it, audits it, and takes effect on the person's very next request", async () => {
    const admin = await loginAs("admin@acme.test");
    const managerToken = await loginAs("manager@acme.test");
    const managerId = await idOf("manager@acme.test");
    expect((await request(app).get("/api/actions/stats").set(authed(managerToken))).status).toBe(200);

    const res = await setRole(admin, managerId, "auditor");
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: managerId, role: "auditor" });

    // The token still says "manager", but the person's record now decides.
    const decide = await request(app).post("/api/actions/000000000000000000000001/approve").set(authed(managerToken));
    expect(decide.status).toBe(403);

    const events = await AuditEvent.find({ type: "user_role_changed" }).lean();
    expect(events).toHaveLength(1);
    expect(events[0].summary).toBe("Changed Karan Shah (manager@acme.test) from Manager to Auditor");
  });

  it("does nothing, and records nothing, when the role is already that one", async () => {
    const res = await setRole(await loginAs("admin@acme.test"), await idOf("manager@acme.test"), "manager");
    expect(res.status).toBe(200);
    expect(res.body.message).toContain("already");
    expect(await AuditEvent.countDocuments({ type: "user_role_changed" })).toBe(0);
  });

  it("rejects a role that does not exist", async () => {
    const res = await setRole(await loginAs("admin@acme.test"), await idOf("manager@acme.test"), "owner");
    expect(res.status).toBe(400);
  });

  it("lets an admin make another person an admin, who can then manage the team", async () => {
    const admin = await loginAs("admin@acme.test");
    expect((await setRole(admin, await idOf("manager@acme.test"), "admin")).status).toBe(200);
    const newAdmin = await loginAs("manager@acme.test");
    expect((await getTeam(newAdmin)).status).toBe(200);
  });
});

describe("turning a person off and on", () => {
  it("stops sign-in and kills their existing session on the next request", async () => {
    const admin = await loginAs("admin@acme.test");
    const managerToken = await loginAs("manager@acme.test");
    const managerId = await idOf("manager@acme.test");

    const res = await deactivate(admin, managerId);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: managerId, active: false });

    const oldSession = await request(app).get("/api/actions/stats").set(authed(managerToken));
    expect(oldSession.status).toBe(401);
    expect(oldSession.body.message).toContain("turned off");

    const login = await request(app).post("/api/auth/login").send({ email: "manager@acme.test", password: DEMO_PASSWORD });
    expect(login.status).toBe(401);
    expect(login.body.message).toContain("turned off");
    expect((await getTeam(admin)).body.data.find((person: { id: string }) => person.id === managerId).active).toBe(false);
  });

  it("does not tell a stranger that an account exists (a wrong password gets the usual message)", async () => {
    await deactivate(await loginAs("admin@acme.test"), await idOf("manager@acme.test"));
    const wrong = await request(app).post("/api/auth/login").send({ email: "manager@acme.test", password: "not-the-password" });
    expect(wrong.status).toBe(401);
    expect(wrong.body.message).toBe("Email or password is not correct.");
  });

  it("lets them back in when turned on again, with the same password", async () => {
    const admin = await loginAs("admin@acme.test");
    const managerId = await idOf("manager@acme.test");
    await deactivate(admin, managerId);
    const res = await reactivate(admin, managerId);
    expect(res.status).toBe(200);
    expect(res.body.data.active).toBe(true);
    expect((await request(app).post("/api/auth/login").send({ email: "manager@acme.test", password: DEMO_PASSWORD })).status).toBe(200);
  });

  it("audits both, and nothing when nothing changed", async () => {
    const admin = await loginAs("admin@acme.test");
    const managerId = await idOf("manager@acme.test");
    expect((await reactivate(admin, managerId)).body.message).toContain("already");
    await deactivate(admin, managerId);
    expect((await deactivate(admin, managerId)).body.message).toContain("already");
    await reactivate(admin, managerId);

    const events = await AuditEvent.find({ type: { $in: ["user_deactivated", "user_reactivated"] } }).sort({ createdAt: 1, _id: 1 }).lean();
    expect(events.map((event) => event.type)).toEqual(["user_deactivated", "user_reactivated"]);
    expect(events[0].summary).toBe("Turned off the account of Karan Shah (manager@acme.test)");
    expect(events[1].summary).toBe("Turned on the account of Karan Shah (manager@acme.test)");
  });
});

describe("guards", () => {
  it("an admin cannot turn off or demote themselves", async () => {
    const admin = await loginAs("admin@acme.test");
    const self = await idOf("admin@acme.test");
    // Even with a second admin around, it is still refused.
    await setRole(admin, await idOf("manager@acme.test"), "admin");

    const off = await deactivate(admin, self);
    expect(off.status).toBe(400);
    expect(off.body.message).toContain("your own");
    const down = await setRole(admin, self, "manager");
    expect(down.status).toBe(400);
    expect(down.body.message).toContain("your own");

    expect(await User.findOne({ email: "admin@acme.test" }).lean()).toMatchObject({ role: "admin", active: true });
    expect(await AuditEvent.countDocuments({ type: { $in: ["user_role_changed", "user_deactivated"] } })).toBe(1); // only the promotion above
  });

  it("a company always keeps one active admin (service level, when the person acting is not that admin)", async () => {
    const workspaceId = (await User.findOne({ email: "admin@acme.test" }).lean())!.workspaceId;
    const adminId = await idOf("admin@acme.test");
    const someoneElse = { type: "user" as const, id: await idOf("manager@acme.test"), name: "Karan Shah" };

    await expect(setTeamMemberActive(workspaceId, adminId, false, someoneElse)).rejects.toMatchObject({ statusCode: 409 });
    await expect(changeTeamMemberRole(workspaceId, adminId, "auditor", someoneElse)).rejects.toMatchObject({ statusCode: 409 });
    expect(await User.findOne({ email: "admin@acme.test" }).lean()).toMatchObject({ role: "admin", active: true });
    expect(await AuditEvent.countDocuments({ type: { $in: ["user_role_changed", "user_deactivated"] } })).toBe(0);
  });

  it("does not count a turned-off admin as the one who is left", async () => {
    const admin = await loginAs("admin@acme.test");
    const managerId = await idOf("manager@acme.test");
    await setRole(admin, managerId, "admin");
    const otherAdmin = await loginAs("manager@acme.test");
    // Meera (admin) turns off Karan (admin): fine, Meera is left. Karan's old session is gone.
    expect((await deactivate(admin, managerId)).status).toBe(200);
    expect((await getTeam(otherAdmin)).status).toBe(401);
    // Meera is now the only active admin and nobody else can be asked to remove her.
    const workspaceId = (await User.findOne({ email: "admin@acme.test" }).lean())!.workspaceId;
    const actor = { type: "user" as const, id: managerId, name: "Karan Shah" };
    await expect(setTeamMemberActive(workspaceId, await idOf("admin@acme.test"), false, actor)).rejects.toMatchObject({ statusCode: 409 });
  });

  it("two admins turning each other off at the same moment never leave the company without an admin", async () => {
    const meera = await loginAs("admin@acme.test");
    const karanId = await idOf("manager@acme.test");
    await setRole(meera, karanId, "admin");
    const karan = await loginAs("manager@acme.test");
    const meeraId = await idOf("admin@acme.test");

    await Promise.all([deactivate(meera, karanId), deactivate(karan, meeraId)]);
    const workspaceId = (await User.findOne({ email: "admin@acme.test" }).lean())!.workspaceId;
    expect(await User.countDocuments({ workspaceId, role: "admin", active: { $ne: false } })).toBeGreaterThanOrEqual(1);
  });
});

describe("one company never sees or changes another's people", () => {
  it("lists only its own people", async () => {
    await addGlobexAdmin();
    const res = await getTeam(await loginAs("admin@globex.test"));
    expect(res.status).toBe(200);
    expect(res.body.data.map((person: { email: string }) => person.email).sort()).toEqual(["admin@globex.test", "manager@globex.test"]);
    expect(JSON.stringify(res.body)).not.toContain("acme.test");
  });

  it("cannot change, turn off or turn on another company's person (it looks like they do not exist)", async () => {
    await addGlobexAdmin();
    const globexAdmin = await loginAs("admin@globex.test");
    const acmeManagerId = await idOf("manager@acme.test");

    expect((await setRole(globexAdmin, acmeManagerId, "admin")).status).toBe(404);
    expect((await deactivate(globexAdmin, acmeManagerId)).status).toBe(404);
    expect((await reactivate(globexAdmin, acmeManagerId)).status).toBe(404);
    expect(await User.findOne({ email: "manager@acme.test" }).lean()).toMatchObject({ role: "manager", active: true });
    expect(await AuditEvent.countDocuments({ type: { $in: ["user_role_changed", "user_deactivated", "user_reactivated"] } })).toBe(0);
  });

  it("adds people to its own company only", async () => {
    await addGlobexAdmin();
    const res = await addPerson(await loginAs("admin@globex.test"), { name: "Divya Pillai", email: "divya@globex.test", role: "manager" });
    expect(res.status).toBe(201);
    const globexManager = await User.findOne({ email: "manager@globex.test" }).lean();
    expect((await User.findOne({ email: "divya@globex.test" }).lean())!.workspaceId).toEqual(globexManager!.workspaceId);
    const acmeList = await getTeam(await loginAs("admin@acme.test"));
    expect(acmeList.body.data.map((person: { email: string }) => person.email)).not.toContain("divya@globex.test");
    // The record says which company it happened in.
    expect((await AuditEvent.findOne({ type: "user_added" }).lean())!.workspaceId).toEqual(globexManager!.workspaceId);
  });

  it("answers an id that is not an id like any other missing person", async () => {
    const admin = await loginAs("admin@acme.test");
    expect((await setRole(admin, "not-an-id", "auditor")).status).toBe(404);
    expect((await deactivate(admin, "507f1f77bcf86cd799439011")).status).toBe(404);
  });

  it("a person turned off in one company does not affect another's", async () => {
    await addGlobexAdmin();
    await deactivate(await loginAs("admin@acme.test"), await idOf("manager@acme.test"));
    expect((await request(app).post("/api/auth/login").send({ email: "manager@globex.test", password: DEMO_PASSWORD })).status).toBe(200);
  });
});

describe("Reset demo data", () => {
  it("keeps the people added on the Team screen (and who they are), and the record of adding them", async () => {
    const admin = await loginAs("admin@acme.test");
    const added = await addPerson(admin, { name: "Divya Pillai", email: "divya@acme.test", role: "manager" });
    const password = added.body.data.temporaryPassword as string;
    await deactivate(admin, await idOf("auditor@acme.test"));
    await setRole(admin, added.body.data.member.id, "auditor");

    const reset = await request(app).post("/api/demo/reset").set(authed(admin));
    expect(reset.status).toBe(200);

    const list = await getTeam(admin);
    expect(list.body.data).toHaveLength(4);
    expect(list.body.data.find((person: { email: string }) => person.email === "divya@acme.test")).toMatchObject({ role: "auditor", active: true });
    expect(list.body.data.find((person: { email: string }) => person.email === "auditor@acme.test").active).toBe(false);
    expect((await request(app).post("/api/auth/login").send({ email: "divya@acme.test", password })).status).toBe(200);

    const audit = await request(app).get("/api/audit").set(authed(admin));
    const types = audit.body.data.map((event: { type: string }) => event.type);
    expect(types).toEqual(expect.arrayContaining(["user_added", "user_role_changed", "user_deactivated", "demo_reset"]));
  });
});
