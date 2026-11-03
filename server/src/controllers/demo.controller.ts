import crypto from "crypto";
import { Request, Response } from "express";
import { z } from "zod";
import { successResponseWithData } from "../helpers/response";
import { getRequestUser, userActor } from "../middlewares/auth.middleware";
import { Agent, AgentDoc } from "../models/agent.model";
import { Booking, Customer, Outbox } from "../models/demo.model";
import { NotFoundError, ServiceUnavailableError } from "../helpers/errors";
import { requestAction, toActionDto } from "../services/actions/guard.service";
import { PLAYGROUND_AGENT_NAME, resetWorkspaceDemoData } from "../services/demo/demo.service";
import { planActionsFromInstruction } from "../services/llm/agentPlanner.service";
import { Workspace } from "../models/workspace.model";
import { isAgentReplayConfigured, startPlaygroundRecording } from "../services/replay/agentReplay.service";
import { AppError } from "../helpers/errors";

export const playgroundActionSchema = z.object({
  action: z.string().trim().min(1).max(100),
  params: z.record(z.unknown()).default({}),
  reason: z.string().trim().max(500).optional().default(""),
  onBehalfOf: z.string().trim().min(1).max(200),
});

export const playgroundChatSchema = z.object({
  instruction: z.string().trim().min(3).max(1000),
  onBehalfOf: z.string().trim().min(1).max(200),
});

async function getPlaygroundAgent(workspaceId: unknown): Promise<AgentDoc> {
  const agent = await Agent.findOne({ workspaceId, name: PLAYGROUND_AGENT_NAME, active: true }).lean<AgentDoc>();
  if (!agent) throw new NotFoundError("This workspace has no playground agent. Run the seed script.");
  return agent;
}

// The company's own data, so people can SEE what the agent changed (and that Undo restored it).
export async function getCompanyData(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const [customers, bookings, outbox] = await Promise.all([
    Customer.find({ workspaceId: user.workspaceId }).sort({ code: 1 }).lean(),
    Booking.find({ workspaceId: user.workspaceId }).sort({ code: 1 }).lean(),
    Outbox.find({ workspaceId: user.workspaceId }).sort({ sentAt: -1 }).limit(20).lean(),
  ]);
  const customerById = new Map(customers.map((customer) => [String(customer._id), customer]));
  return successResponseWithData(res, "Company data.", {
    customers: customers.map((customer) => ({
      code: customer.code,
      name: customer.name,
      email: customer.email,
    })),
    bookings: bookings.map((booking) => ({
      code: booking.code,
      title: booking.title,
      customerName: customerById.get(String(booking.customerId))?.name || "",
      customerCode: customerById.get(String(booking.customerId))?.code || "",
      startsAt: booking.startsAt,
      amount: booking.amount,
      status: booking.status,
      refundAmount: booking.refundAmount,
      discountPercent: booking.discountPercent,
      updatedAt: booking.updatedAt,
    })),
    outbox: outbox.map((message) => ({
      id: String(message._id),
      customerName: customerById.get(String(message.customerId))?.name || "",
      subject: message.subject,
      sentAt: message.sentAt,
    })),
  });
}

export async function resetDemo(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const done = await resetWorkspaceDemoData(user.workspaceId, userActor(user));
  if (!done) throw new NotFoundError("This workspace has no demo data to reset.");
  return successResponseWithData(res, "Demo data is back to the start.", { reset: true });
}

// Sends one action through the guard as the playground agent — exactly the same
// path an outside agent uses.
export async function playgroundAct(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const input = res.locals.body as z.infer<typeof playgroundActionSchema>;
  const agent = await getPlaygroundAgent(user.workspaceId);
  // Recorded in AgentReplay only when a key is set; otherwise this does nothing.
  const recording = startPlaygroundRecording({ name: input.action, onBehalfOf: input.onBehalfOf });
  try {
    const record = await requestAction(agent, { ...input, idempotencyKey: crypto.randomUUID() });
    recording.recordAction(input.action, input.params, { record });
    return successResponseWithData(res, "Sent to AgentGuard.", { ...toActionDto(record), ...(recording.link ? { recording: recording.link } : {}) });
  } catch (err) {
    recording.recordAction(input.action, input.params, { errorMessage: err instanceof AppError ? err.message : "The action failed." });
    throw err;
  } finally {
    recording.finish();
  }
}

// An AI agent plans actions from plain words; each planned action still goes through the guard.
export async function playgroundChat(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const { instruction, onBehalfOf } = res.locals.body as z.infer<typeof playgroundChatSchema>;
  const agent = await getPlaygroundAgent(user.workspaceId);
  // Recorded in AgentReplay only when a key is set; otherwise this does nothing.
  const recording = startPlaygroundRecording({ name: instruction, onBehalfOf });
  try {
    const plan = await planActionsFromInstruction(user.workspaceId, instruction, recording);

    const outcomes = [];
    for (const planned of plan.actions) {
      try {
        const record = await requestAction(agent, {
          action: planned.action,
          params: planned.params,
          reason: planned.reason,
          onBehalfOf,
          idempotencyKey: crypto.randomUUID(),
        });
        recording.recordAction(planned.action, planned.params, { record });
        outcomes.push({ planned, outcome: toActionDto(record), error: null });
      } catch (err) {
        // A bad plan step (unknown booking, invalid params) is reported, not fatal.
        if (!(err instanceof AppError) || err instanceof ServiceUnavailableError) throw err;
        recording.recordAction(planned.action, planned.params, { errorMessage: err.message });
        outcomes.push({ planned, outcome: null, error: err.message });
      }
    }
    return successResponseWithData(res, plan.message || "Plan finished.", { message: plan.message, outcomes });
  } finally {
    recording.finish();
  }
}

// Creates only a new practice booking. Existing bookings, rules and history stay intact.
export async function startWalkthrough(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const workspace = await Workspace.findOne({ _id: user.workspaceId, slug: "acme-travels" }).lean();
  if (!workspace) throw new NotFoundError("Use an Acme demo manager account for this walkthrough.");
  const customer = await Customer.findOne({ workspaceId: user.workspaceId, code: "CU-101" }).lean();
  if (!customer) throw new NotFoundError("Practice data is being reset. Please try again shortly.");
  const bookingCode = `DEMO-${crypto.randomUUID().toUpperCase()}`;
  await Booking.create({ workspaceId: user.workspaceId, customerId: customer._id, code: bookingCode, title: "Guided practice booking", amount: 7500, startsAt: new Date(Date.now() + 14 * 86400000) });
  return successResponseWithData(res, "Your practice booking is ready.", { bookingCode }, 201);
}

export async function getRecordingStatus(_req: Request, res: Response) {
  return successResponseWithData(res, "Optional recording status.", { configured: isAgentReplayConfigured() });
}
