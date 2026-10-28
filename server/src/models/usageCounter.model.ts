import { Schema, model, InferSchemaType, Types } from "mongoose";

// How much of a daily limit has been used (or held for a waiting request) so far today.
// One document per company + rule + agent + UTC day. Requests reserve room with ONE conditional
// update on this document, so two requests arriving at the same instant can never both fit.
const usageCounterSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    ruleId: { type: Schema.Types.ObjectId, ref: "Policy", required: true },
    action: { type: String, required: true },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", default: null }, // null = the whole company
    field: { type: String, required: true }, // action + field are the rule's, so editing the rule starts a fresh count
    day: { type: String, required: true }, // UTC day, e.g. "2026-10-28"
    total: { type: Number, required: true, default: 0 },
    expiresAt: { type: Date, required: true }, // old days clean themselves up
  },
  { timestamps: false }
);

usageCounterSchema.index({ workspaceId: 1, ruleId: 1, action: 1, agentId: 1, field: 1, day: 1 }, { unique: true });
usageCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export type UsageCounterDoc = InferSchemaType<typeof usageCounterSchema> & { _id: Types.ObjectId };
export const UsageCounter = model("UsageCounter", usageCounterSchema);
