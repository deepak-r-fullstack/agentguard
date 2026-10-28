import { Schema, model, InferSchemaType, Types } from "mongoose";
import { CONDITION_OPERATORS, DECISIONS, LIMIT_SCOPES } from "../constants";

// A rule the admin writes (in plain English, drafted into this structure by AI,
// then confirmed by a person). The guard evaluates these with plain code only.
const conditionSchema = new Schema(
  {
    field: { type: String, required: true }, // e.g. "facts.amount"
    op: { type: String, enum: CONDITION_OPERATORS, required: true },
    value: { type: Schema.Types.Mixed, required: true },
  },
  { _id: false }
);

const dailyLimitSchema = new Schema(
  {
    scope: { type: String, enum: LIMIT_SCOPES, required: true },
    sumField: { type: String, required: true }, // e.g. "facts.amount"
    max: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const policySchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    action: { type: String, required: true }, // an action key, or "*" for every action
    effect: { type: String, enum: DECISIONS, required: true },
    conditions: { type: [conditionSchema], default: [] },
    dailyLimit: { type: dailyLimitSchema, default: null },
    enabled: { type: Boolean, default: true },
    sourceText: { type: String, default: "" }, // the plain-English sentence it came from
    createdBy: { type: Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export type PolicyDoc = InferSchemaType<typeof policySchema> & { _id: Types.ObjectId };
export const Policy = model("Policy", policySchema);
