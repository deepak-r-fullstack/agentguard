import { Types } from "mongoose";
import { z } from "zod";
import { Booking, BookingDoc, Customer, CustomerDoc, Outbox } from "../../models/demo.model";
import { BadRequestError, ConflictError, NotFoundError } from "../../helpers/errors";
import { DEFAULT_CURRENCY, daysBetween, formatDate, formatMoney } from "../../utils/format";
import { MoneyFields } from "./money.service";

// ---------------------------------------------------------------------------
// The action registry: the ONLY list of things an agent may do.
// Each action knows how to:
//   prepare  -> look up trusted facts from the system of record (never trust the agent's numbers)
//   snapshot -> save the state before the change
//   run      -> make the change
//   undo     -> put the snapshot back (a "compensating action"), refusing if the data changed since
// An action with no undo is marked irreversible and always needs a person's approval.
// ---------------------------------------------------------------------------

export interface ActionContext {
  workspaceId: Types.ObjectId;
  // The workspace's currency for the plain-English summary. Only prepare() needs it.
  currency?: string;
}

export interface RuleField {
  path: string; // what a rule condition uses, e.g. "facts.amount"
  label: string; // what a person sees
  type: "number" | "string" | "boolean";
}

export interface PreparedAction {
  facts: Record<string, unknown>;
  summary: string;
}

export interface ActionDefinition<P = any, S = any> {
  key: string;
  label: string;
  description: string;
  irreversible: boolean;
  paramsSchema: z.ZodType<P>;
  ruleFields: RuleField[];
  // Which facts / result fields are money, so agents always get them with their currency.
  moneyFields: MoneyFields;
  exampleParams: P;
  prepare: (params: P, ctx: ActionContext) => Promise<PreparedAction>;
  snapshot?: (params: P, ctx: ActionContext) => Promise<S>;
  run: (params: P, ctx: ActionContext) => Promise<Record<string, unknown>>;
  undo?: (snapshot: S, ctx: ActionContext) => Promise<void>;
}

const COMMON_FIELDS: RuleField[] = [
  { path: "agentName", label: "Agent name", type: "string" },
  { path: "onBehalfOf", label: "Requested by (person)", type: "string" },
];

// ---------- lookups (always scoped to the workspace) ----------

async function findBookingByCode(code: string, ctx: ActionContext): Promise<BookingDoc> {
  const booking = await Booking.findOne({ workspaceId: ctx.workspaceId, code: code.toUpperCase() }).lean<BookingDoc>();
  if (!booking) throw new NotFoundError(`Booking ${code} was not found.`);
  return booking;
}

async function findCustomerByCode(code: string, ctx: ActionContext): Promise<CustomerDoc> {
  const customer = await Customer.findOne({ workspaceId: ctx.workspaceId, code: code.toUpperCase() }).lean<CustomerDoc>();
  if (!customer) throw new NotFoundError(`Customer ${code} was not found.`);
  return customer;
}

async function findCustomerById(id: Types.ObjectId, ctx: ActionContext): Promise<CustomerDoc> {
  const customer = await Customer.findOne({ _id: id, workspaceId: ctx.workspaceId }).lean<CustomerDoc>();
  if (!customer) throw new NotFoundError("The booking's customer was not found.");
  return customer;
}

const STALE_MESSAGE = "The record changed after this action ran, so undo would overwrite newer work.";

// ---------- booking.cancel ----------

const cancelBookingParams = z.object({ bookingCode: z.string().trim().min(1) }).strict();
type CancelBookingParams = z.infer<typeof cancelBookingParams>;
interface CancelBookingSnapshot {
  bookingId: string;
  status: string;
  refundAmount: number;
}

const cancelBooking: ActionDefinition<CancelBookingParams, CancelBookingSnapshot> = {
  key: "booking.cancel",
  label: "Cancel a booking",
  description: "Cancels a confirmed booking and refunds the full amount.",
  irreversible: false,
  paramsSchema: cancelBookingParams,
  exampleParams: { bookingCode: "BK-1001" },
  moneyFields: { facts: ["amount"], result: ["refundAmount"] },
  ruleFields: [
    { path: "facts.amount", label: "Refund amount (₹)", type: "number" },
    { path: "facts.daysUntilStart", label: "Days until the booking starts", type: "number" },
    ...COMMON_FIELDS,
  ],
  async prepare(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    if (booking.status !== "confirmed") throw new BadRequestError(`Booking ${booking.code} is already cancelled.`);
    const customer = await findCustomerById(booking.customerId, ctx);
    return {
      facts: {
        amount: booking.amount,
        daysUntilStart: daysBetween(new Date(), booking.startsAt),
        customerCode: customer.code,
      },
      summary: `Cancel booking ${booking.code} (${booking.title}) for ${customer.name} and refund ${formatMoney(booking.amount, ctx.currency ?? DEFAULT_CURRENCY)}`,
    };
  },
  async snapshot(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    return { bookingId: String(booking._id), status: booking.status, refundAmount: booking.refundAmount };
  },
  async run(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    // The status filter makes this safe if two requests race: only one can cancel.
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, workspaceId: ctx.workspaceId, status: "confirmed" },
      { $set: { status: "cancelled", refundAmount: booking.amount } },
      { new: true }
    );
    if (!updated) throw new ConflictError(`Booking ${booking.code} is no longer confirmed.`);
    return { bookingCode: updated.code, status: updated.status, refundAmount: updated.refundAmount };
  },
  async undo(snapshot, ctx) {
    const restored = await Booking.findOneAndUpdate(
      { _id: snapshot.bookingId, workspaceId: ctx.workspaceId, status: "cancelled" },
      { $set: { status: snapshot.status, refundAmount: snapshot.refundAmount } },
      { new: true }
    );
    if (!restored) throw new ConflictError(STALE_MESSAGE);
  },
};

// ---------- booking.reschedule ----------

const rescheduleBookingParams = z
  .object({
    bookingCode: z.string().trim().min(1),
    newStartDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use the format YYYY-MM-DD"),
  })
  .strict();
type RescheduleBookingParams = z.infer<typeof rescheduleBookingParams>;
interface RescheduleSnapshot {
  bookingId: string;
  startsAt: string;
  newStartsAt: string;
}

function parseStartDate(value: string): Date {
  const date = new Date(`${value}T10:00:00.000Z`);
  if (Number.isNaN(date.getTime())) throw new BadRequestError("The new date is not a real date.");
  return date;
}

const rescheduleBooking: ActionDefinition<RescheduleBookingParams, RescheduleSnapshot> = {
  key: "booking.reschedule",
  label: "Reschedule a booking",
  description: "Moves a confirmed booking to a new start date.",
  irreversible: false,
  paramsSchema: rescheduleBookingParams,
  exampleParams: { bookingCode: "BK-1002", newStartDate: "2026-12-20" },
  moneyFields: { facts: ["amount"], result: [] },
  ruleFields: [
    { path: "facts.amount", label: "Booking amount (₹)", type: "number" },
    { path: "facts.shiftDays", label: "Days moved (+ later, − earlier)", type: "number" },
    { path: "facts.daysUntilNewStart", label: "Days until the new date", type: "number" },
    ...COMMON_FIELDS,
  ],
  async prepare(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    if (booking.status !== "confirmed") throw new BadRequestError(`Booking ${booking.code} is cancelled.`);
    const newStartsAt = parseStartDate(params.newStartDate);
    if (newStartsAt.getTime() <= Date.now()) throw new BadRequestError("The new date must be in the future.");
    const customer = await findCustomerById(booking.customerId, ctx);
    return {
      facts: {
        amount: booking.amount,
        shiftDays: daysBetween(booking.startsAt, newStartsAt),
        daysUntilNewStart: daysBetween(new Date(), newStartsAt),
        customerCode: customer.code,
      },
      summary: `Move booking ${booking.code} for ${customer.name} from ${formatDate(booking.startsAt)} to ${formatDate(newStartsAt)}`,
    };
  },
  async snapshot(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    return {
      bookingId: String(booking._id),
      startsAt: booking.startsAt.toISOString(),
      newStartsAt: parseStartDate(params.newStartDate).toISOString(),
    };
  },
  async run(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    const newStartsAt = parseStartDate(params.newStartDate);
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, workspaceId: ctx.workspaceId, status: "confirmed", startsAt: booking.startsAt },
      { $set: { startsAt: newStartsAt } },
      { new: true }
    );
    if (!updated) throw new ConflictError(`Booking ${booking.code} changed while we were updating it. Please retry.`);
    return { bookingCode: updated.code, startsAt: updated.startsAt.toISOString() };
  },
  async undo(snapshot, ctx) {
    const restored = await Booking.findOneAndUpdate(
      { _id: snapshot.bookingId, workspaceId: ctx.workspaceId, startsAt: new Date(snapshot.newStartsAt) },
      { $set: { startsAt: new Date(snapshot.startsAt) } },
      { new: true }
    );
    if (!restored) throw new ConflictError(STALE_MESSAGE);
  },
};

// ---------- booking.applyDiscount ----------

const applyDiscountParams = z
  .object({
    bookingCode: z.string().trim().min(1),
    percent: z.number().int().min(1).max(100),
  })
  .strict();
type ApplyDiscountParams = z.infer<typeof applyDiscountParams>;
interface DiscountSnapshot {
  bookingId: string;
  amount: number;
  discountPercent: number;
  newAmount: number;
}

const applyDiscount: ActionDefinition<ApplyDiscountParams, DiscountSnapshot> = {
  key: "booking.applyDiscount",
  label: "Give a discount",
  description: "Reduces a confirmed booking's price by a percentage. One discount per booking.",
  irreversible: false,
  paramsSchema: applyDiscountParams,
  exampleParams: { bookingCode: "BK-1003", percent: 10 },
  moneyFields: { facts: ["amount", "discountAmount"], result: ["newAmount"] },
  ruleFields: [
    { path: "facts.percent", label: "Discount (%)", type: "number" },
    { path: "facts.discountAmount", label: "Discount amount (₹)", type: "number" },
    { path: "facts.amount", label: "Booking amount before discount (₹)", type: "number" },
    ...COMMON_FIELDS,
  ],
  async prepare(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    if (booking.status !== "confirmed") throw new BadRequestError(`Booking ${booking.code} is cancelled.`);
    if (booking.discountPercent > 0) throw new BadRequestError(`Booking ${booking.code} already has a discount.`);
    const customer = await findCustomerById(booking.customerId, ctx);
    const discountAmount = Math.round((booking.amount * params.percent) / 100);
    return {
      facts: {
        amount: booking.amount,
        percent: params.percent,
        discountAmount,
        customerCode: customer.code,
      },
      summary: `Give ${customer.name} a ${params.percent}% discount (${formatMoney(discountAmount, ctx.currency ?? DEFAULT_CURRENCY)}) on booking ${booking.code}`,
    };
  },
  async snapshot(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    const discountAmount = Math.round((booking.amount * params.percent) / 100);
    return {
      bookingId: String(booking._id),
      amount: booking.amount,
      discountPercent: booking.discountPercent,
      newAmount: booking.amount - discountAmount,
    };
  },
  async run(params, ctx) {
    const booking = await findBookingByCode(params.bookingCode, ctx);
    const discountAmount = Math.round((booking.amount * params.percent) / 100);
    const updated = await Booking.findOneAndUpdate(
      { _id: booking._id, workspaceId: ctx.workspaceId, status: "confirmed", discountPercent: 0, amount: booking.amount },
      { $set: { amount: booking.amount - discountAmount, discountPercent: params.percent } },
      { new: true }
    );
    if (!updated) throw new ConflictError(`Booking ${booking.code} changed while we were updating it. Please retry.`);
    return { bookingCode: updated.code, newAmount: updated.amount, discountPercent: updated.discountPercent };
  },
  async undo(snapshot, ctx) {
    const restored = await Booking.findOneAndUpdate(
      { _id: snapshot.bookingId, workspaceId: ctx.workspaceId, amount: snapshot.newAmount },
      { $set: { amount: snapshot.amount, discountPercent: snapshot.discountPercent } },
      { new: true }
    );
    if (!restored) throw new ConflictError(STALE_MESSAGE);
  },
};

// ---------- customer.updateEmail ----------

const updateEmailParams = z
  .object({
    customerCode: z.string().trim().min(1),
    email: z.string().trim().toLowerCase().email(),
  })
  .strict();
type UpdateEmailParams = z.infer<typeof updateEmailParams>;
interface UpdateEmailSnapshot {
  customerId: string;
  email: string;
  newEmail: string;
}

const updateCustomerEmail: ActionDefinition<UpdateEmailParams, UpdateEmailSnapshot> = {
  key: "customer.updateEmail",
  label: "Change a customer's email",
  description: "Updates the email address on a customer's profile.",
  irreversible: false,
  paramsSchema: updateEmailParams,
  exampleParams: { customerCode: "CU-101", email: "priya.new@example.com" },
  moneyFields: { facts: [], result: [] },
  ruleFields: [
    { path: "facts.sameDomain", label: "New email has the same domain", type: "boolean" },
    ...COMMON_FIELDS,
  ],
  async prepare(params, ctx) {
    const customer = await findCustomerByCode(params.customerCode, ctx);
    if (customer.email === params.email) throw new BadRequestError("That is already the customer's email.");
    const oldDomain = customer.email.split("@")[1];
    const newDomain = params.email.split("@")[1];
    return {
      facts: { sameDomain: oldDomain === newDomain, customerCode: customer.code },
      summary: `Change the email for ${customer.name} (${customer.code}) to ${params.email}`,
    };
  },
  async snapshot(params, ctx) {
    const customer = await findCustomerByCode(params.customerCode, ctx);
    return { customerId: String(customer._id), email: customer.email, newEmail: params.email };
  },
  async run(params, ctx) {
    const customer = await findCustomerByCode(params.customerCode, ctx);
    const updated = await Customer.findOneAndUpdate(
      { _id: customer._id, workspaceId: ctx.workspaceId, email: customer.email },
      { $set: { email: params.email } },
      { new: true }
    );
    if (!updated) throw new ConflictError("The customer changed while we were updating it. Please retry.");
    return { customerCode: updated.code };
  },
  async undo(snapshot, ctx) {
    const restored = await Customer.findOneAndUpdate(
      { _id: snapshot.customerId, workspaceId: ctx.workspaceId, email: snapshot.newEmail },
      { $set: { email: snapshot.email } },
      { new: true }
    );
    if (!restored) throw new ConflictError(STALE_MESSAGE);
  },
};

// ---------- notification.sendEmail (irreversible) ----------

const sendEmailParams = z
  .object({
    customerCode: z.string().trim().min(1),
    subject: z.string().trim().min(1).max(150),
    body: z.string().trim().min(1).max(5000),
  })
  .strict();
type SendEmailParams = z.infer<typeof sendEmailParams>;

const sendCustomerEmail: ActionDefinition<SendEmailParams> = {
  key: "notification.sendEmail",
  label: "Email a customer",
  description: "Sends an email to a customer. An email cannot be unsent.",
  irreversible: true,
  paramsSchema: sendEmailParams,
  exampleParams: { customerCode: "CU-101", subject: "Your booking", body: "Hello! Your booking is confirmed." },
  moneyFields: { facts: [], result: [] },
  ruleFields: [...COMMON_FIELDS],
  async prepare(params, ctx) {
    const customer = await findCustomerByCode(params.customerCode, ctx);
    return {
      facts: { customerCode: customer.code },
      summary: `Email ${customer.name} (${customer.code}) with the subject "${params.subject}"`,
    };
  },
  async run(params, ctx) {
    const customer = await findCustomerByCode(params.customerCode, ctx);
    const message = await Outbox.create({
      workspaceId: ctx.workspaceId,
      customerId: customer._id,
      subject: params.subject,
      body: params.body,
    });
    return { outboxId: String(message._id) };
  },
};

// ---------- registry ----------

const definitions: ActionDefinition[] = [
  cancelBooking,
  rescheduleBooking,
  applyDiscount,
  updateCustomerEmail,
  sendCustomerEmail,
];

export const actionRegistry: Record<string, ActionDefinition> = Object.fromEntries(
  definitions.map((definition) => [definition.key, definition])
);

export function getActionDefinition(key: string): ActionDefinition {
  const definition = actionRegistry[key];
  if (!definition) throw new BadRequestError(`Unknown action "${key}". Agents may only use registered actions.`);
  return definition;
}

// The full definitions (including each action's params schema). The MCP server turns
// every one of these into a tool, so a new action shows up for MCP clients with no extra work.
export function listActionDefinitions(): ActionDefinition[] {
  return [...definitions];
}

// Public description of the catalog, used by the UI and by the AI rule drafter.
export function describeActionCatalog() {
  return definitions.map((definition) => ({
    key: definition.key,
    label: definition.label,
    description: definition.description,
    irreversible: definition.irreversible,
    canUndo: Boolean(definition.undo),
    ruleFields: definition.ruleFields,
    exampleParams: definition.exampleParams,
  }));
}
