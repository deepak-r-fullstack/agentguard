import { Types } from "mongoose";
import { Workspace } from "../../models/workspace.model";
import { User } from "../../models/user.model";
import { Agent } from "../../models/agent.model";
import { Booking, Customer, Outbox } from "../../models/demo.model";
import { Policy } from "../../models/policy.model";
import { ActionRecord } from "../../models/actionRecord.model";
import { AuditEvent } from "../../models/auditEvent.model";
import { generateApiKey, hashPassword } from "../auth/auth.service";
import { PolicyInput } from "../policy/policySchemas";
import { Actor, recordAuditEvent } from "../audit/audit.service";
import { TEAM_AUDIT_EVENT_TYPES } from "../../constants";

// ---------------------------------------------------------------------------
// Demo data: two companies, so the demo can prove one company's agent can never
// touch another company's data. Indian names and rupee amounts, dates relative to today.
// ---------------------------------------------------------------------------

export const DEMO_PASSWORD = "Demo@1234";
export const PLAYGROUND_AGENT_NAME = "Playground Agent";

const DAY_MS = 24 * 60 * 60 * 1000;
function daysFromNow(days: number) {
  const date = new Date(Date.now() + days * DAY_MS);
  date.setUTCHours(10, 0, 0, 0);
  return date;
}

interface DemoCompany {
  slug: string;
  name: string;
  users: { name: string; email: string; role: "admin" | "manager" | "auditor" }[];
  agents: { name: string; description: string }[];
  customers: { code: string; name: string; email: string }[];
  bookings: { code: string; customerCode: string; title: string; inDays: number; amount: number }[];
  policies: PolicyInput[];
}

const ACME: DemoCompany = {
  slug: "acme-travels",
  name: "Acme Travels",
  users: [
    { name: "Meera Nair", email: "admin@acme.test", role: "admin" },
    { name: "Karan Shah", email: "manager@acme.test", role: "manager" },
    { name: "Lakshmi Rao", email: "auditor@acme.test", role: "auditor" },
  ],
  agents: [
    { name: "Support Copilot", description: "Answers customer chats and handles booking changes." },
    { name: PLAYGROUND_AGENT_NAME, description: "Used by the playground screen to try actions." },
  ],
  customers: [
    { code: "CU-101", name: "Priya Sharma", email: "priya.sharma@example.com" },
    { code: "CU-102", name: "Ravi Kumar", email: "ravi.kumar@example.com" },
    { code: "CU-103", name: "Ananya Iyer", email: "ananya.iyer@example.com" },
    { code: "CU-104", name: "Fatima Khan", email: "fatima.khan@example.com" },
    { code: "CU-105", name: "Arjun Mehta", email: "arjun.mehta@example.com" },
    { code: "CU-106", name: "Sneha Reddy", email: "sneha.reddy@example.com" },
  ],
  bookings: [
    { code: "BK-1001", customerCode: "CU-101", title: "Goa beach villa", inDays: 12, amount: 7500 },
    { code: "BK-1002", customerCode: "CU-102", title: "Coorg coffee estate stay", inDays: 20, amount: 4500 },
    { code: "BK-1003", customerCode: "CU-103", title: "Hampi heritage tour", inDays: 9, amount: 3900 },
    { code: "BK-1004", customerCode: "CU-102", title: "Mysuru Dasara package", inDays: 25, amount: 4800 },
    { code: "BK-1005", customerCode: "CU-104", title: "Kerala houseboat", inDays: 40, amount: 18500 },
    { code: "BK-1006", customerCode: "CU-105", title: "Ooty toy train weekend", inDays: 15, amount: 4200 },
    { code: "BK-1007", customerCode: "CU-106", title: "Chikmagalur trek", inDays: 30, amount: 4900 },
    { code: "BK-1008", customerCode: "CU-105", title: "Andaman scuba week", inDays: 60, amount: 42000 },
  ],
  policies: [
    {
      name: "Small cancellations are automatic",
      action: "booking.cancel",
      effect: "allow",
      conditions: [{ field: "facts.amount", op: "lte", value: 5000 }],
      dailyLimit: null,
      enabled: true,
      sourceText: "The agent can cancel bookings of ₹5,000 or less on its own.",
    },
    {
      name: "Big cancellations need a manager",
      action: "booking.cancel",
      effect: "require_approval",
      conditions: [{ field: "facts.amount", op: "gt", value: 5000 }],
      dailyLimit: null,
      enabled: true,
      sourceText: "Cancellations above ₹5,000 need a manager.",
    },
    {
      name: "Daily refund cap per agent",
      action: "booking.cancel",
      effect: "deny",
      conditions: [],
      dailyLimit: { scope: "agent", sumField: "facts.amount", max: 20000 },
      enabled: true,
      sourceText: "No agent may refund more than ₹20,000 in a day.",
    },
    {
      name: "Small discounts are automatic",
      action: "booking.applyDiscount",
      effect: "allow",
      conditions: [{ field: "facts.percent", op: "lte", value: 10 }],
      dailyLimit: null,
      enabled: true,
      sourceText: "The agent can give discounts up to 10% on its own.",
    },
    {
      name: "Never more than 30% off",
      action: "booking.applyDiscount",
      effect: "deny",
      conditions: [{ field: "facts.percent", op: "gt", value: 30 }],
      dailyLimit: null,
      enabled: true,
      sourceText: "Discounts above 30% are never allowed.",
    },
    {
      name: "Reschedules are automatic",
      action: "booking.reschedule",
      effect: "allow",
      conditions: [],
      dailyLimit: null,
      enabled: true,
      sourceText: "The agent can move bookings to a new date on its own.",
    },
  ],
};

const GLOBEX: DemoCompany = {
  slug: "globex-holidays",
  name: "Globex Holidays",
  users: [{ name: "Vikram Joshi", email: "manager@globex.test", role: "manager" }],
  agents: [{ name: "Globex Assistant", description: "Globex's own support agent." }],
  customers: [{ code: "CU-201", name: "Neha Gupta", email: "neha.gupta@example.com" }],
  bookings: [{ code: "BK-2001", customerCode: "CU-201", title: "Rishikesh rafting camp", inDays: 18, amount: 3000 }],
  policies: [
    {
      name: "Cancellations are automatic",
      action: "booking.cancel",
      effect: "allow",
      conditions: [],
      dailyLimit: null,
      enabled: true,
      sourceText: "The agent can cancel any booking on its own.",
    },
  ],
};

export const DEMO_COMPANIES = [ACME, GLOBEX];

async function seedCompanyData(workspaceId: Types.ObjectId, company: DemoCompany) {
  const customers = await Customer.insertMany(company.customers.map((customer) => ({ ...customer, workspaceId })));
  const customerIdByCode = new Map(customers.map((customer) => [customer.code, customer._id]));
  await Booking.insertMany(
    company.bookings.map((booking) => ({
      workspaceId,
      code: booking.code,
      customerId: customerIdByCode.get(booking.customerCode),
      title: booking.title,
      startsAt: daysFromNow(booking.inDays),
      amount: booking.amount,
    }))
  );
  await Policy.insertMany(company.policies.map((policy) => ({ ...policy, workspaceId })));
}

// keepTeamHistory: "Reset demo data" keeps the people, so it also keeps the record of who added or switched them off.
async function clearWorkspaceData(workspaceId: Types.ObjectId, { keepTeamHistory = false } = {}) {
  await Promise.all([
    Customer.deleteMany({ workspaceId }),
    Booking.deleteMany({ workspaceId }),
    Outbox.deleteMany({ workspaceId }),
    Policy.deleteMany({ workspaceId }),
    ActionRecord.deleteMany({ workspaceId }),
    AuditEvent.deleteMany(keepTeamHistory ? { workspaceId, type: { $nin: TEAM_AUDIT_EVENT_TYPES } } : { workspaceId }),
  ]);
}

export interface SeedResult {
  workspaces: { name: string; workspaceId: string }[];
  agentKeys: { workspace: string; agentName: string; agentId: string; apiKey: string }[];
}

/** Wipes every demo company and creates them fresh. Used by `npm run seed` and the tests. */
export async function seedDemoData(): Promise<SeedResult> {
  const result: SeedResult = { workspaces: [], agentKeys: [] };
  const passwordHash = await hashPassword(DEMO_PASSWORD);

  for (const company of DEMO_COMPANIES) {
    const old = await Workspace.findOne({ slug: company.slug });
    if (old) {
      await clearWorkspaceData(old._id);
      await Promise.all([User.deleteMany({ workspaceId: old._id }), Agent.deleteMany({ workspaceId: old._id })]);
      await old.deleteOne();
    }

    const workspace = await Workspace.create({ name: company.name, slug: company.slug });
    await User.insertMany(company.users.map((user) => ({ ...user, workspaceId: workspace._id, passwordHash })));

    for (const agentInfo of company.agents) {
      const { apiKey, apiKeyHash, apiKeyPreview } = generateApiKey();
      const agent = await Agent.create({ ...agentInfo, workspaceId: workspace._id, apiKeyHash, apiKeyPreview });
      result.agentKeys.push({ workspace: company.name, agentName: agent.name, agentId: String(agent._id), apiKey });
    }

    await seedCompanyData(workspace._id, company);
    result.workspaces.push({ name: company.name, workspaceId: String(workspace._id) });
  }
  return result;
}

/** Puts one workspace's company data, rules and history back to the start. Keeps users (including people added on the Team screen) and agent keys. */
export async function resetWorkspaceDemoData(workspaceId: Types.ObjectId, actor: Actor) {
  const workspace = await Workspace.findById(workspaceId).lean();
  const company = DEMO_COMPANIES.find((candidate) => candidate.slug === workspace?.slug);
  if (!company) return false;
  await clearWorkspaceData(workspaceId, { keepTeamHistory: true });
  await seedCompanyData(workspaceId, company);
  await recordAuditEvent({ workspaceId, type: "demo_reset", actor, summary: "Reset the demo data to its starting point" });
  return true;
}
