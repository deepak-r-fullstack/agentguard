import { Schema, model, InferSchemaType, Types } from "mongoose";
import { ACTION_STATUSES, DECISIONS } from "../constants";

// One document per action an agent asked for. It holds everything needed to
// explain the decision later and to undo the change.
const actionRecordSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    agentId: { type: Schema.Types.ObjectId, ref: "Agent", required: true },
    agentName: { type: String, required: true },
    onBehalfOf: { type: String, required: true }, // the human the agent is working for
    action: { type: String, required: true }, // e.g. "booking.cancel"
    params: { type: Schema.Types.Mixed, required: true }, // what the agent sent
    facts: { type: Schema.Types.Mixed, default: {} }, // what we looked up ourselves (trusted)
    summary: { type: String, required: true }, // plain-English sentence shown to people
    reason: { type: String, default: "" }, // the agent's own explanation
    decision: { type: String, enum: DECISIONS, required: true },
    decisionReasons: { type: [String], default: [] },
    matchedPolicyIds: { type: [Schema.Types.ObjectId], default: [] },
    irreversible: { type: Boolean, default: false },
    status: { type: String, enum: ACTION_STATUSES, required: true },
    beforeSnapshot: { type: Schema.Types.Mixed, default: null }, // state before the change, used by undo
    result: { type: Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: "" },
    approvedBy: { type: String, default: "" },
    rejectedBy: { type: String, default: "" },
    undoneBy: { type: String, default: "" },
    decidedAt: { type: Date },
    executedAt: { type: Date },
    undoneAt: { type: Date },
    // Where the Slack approval message lives, so it can be updated once someone decides.
    slackChannelId: { type: String, default: "" },
    slackMessageTs: { type: String, default: "" },
    // Same key twice = same action. Unique per workspace + agent.
    idempotencyKey: { type: String, required: true },
  },
  { timestamps: true }
);

actionRecordSchema.index({ workspaceId: 1, agentId: 1, idempotencyKey: 1 }, { unique: true });
actionRecordSchema.index({ workspaceId: 1, status: 1, createdAt: -1 });
actionRecordSchema.index({ workspaceId: 1, action: 1, createdAt: -1 });

export type ActionRecordDoc = InferSchemaType<typeof actionRecordSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
};
export const ActionRecord = model("ActionRecord", actionRecordSchema);
