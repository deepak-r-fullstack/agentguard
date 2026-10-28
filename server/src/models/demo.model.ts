import { Schema, model, InferSchemaType, Types } from "mongoose";

// ---------------------------------------------------------------------------
// Demo "company system". In a real deployment these would be the customer's own
// APIs (CRM, booking system, billing). They live here so the demo runs anywhere
// with one command. AgentGuard only touches them through the action registry.
// ---------------------------------------------------------------------------

const customerSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    code: { type: String, required: true }, // human-friendly id, e.g. "CU-104"
    name: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
  },
  { timestamps: true }
);
customerSchema.index({ workspaceId: 1, code: 1 }, { unique: true });

export const BOOKING_STATUSES = ["confirmed", "cancelled"] as const;

const bookingSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    code: { type: String, required: true }, // e.g. "BK-1042"
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    title: { type: String, required: true },
    startsAt: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 }, // in whole rupees
    status: { type: String, enum: BOOKING_STATUSES, default: "confirmed" },
    refundAmount: { type: Number, default: 0 },
    discountPercent: { type: Number, default: 0 },
  },
  { timestamps: true }
);
bookingSchema.index({ workspaceId: 1, code: 1 }, { unique: true });

// Emails are "sent" by writing to an outbox. Once written, they count as sent:
// this is the demo's example of an action that cannot be undone.
const outboxSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer", required: true },
    subject: { type: String, required: true },
    body: { type: String, required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: Types.ObjectId };
export type BookingDoc = InferSchemaType<typeof bookingSchema> & { _id: Types.ObjectId };

export const Customer = model("Customer", customerSchema);
export const Booking = model("Booking", bookingSchema);
export const Outbox = model("Outbox", outboxSchema);
