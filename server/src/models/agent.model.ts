import { Schema, model, InferSchemaType, Types } from "mongoose";

// An AI agent that is allowed to call AgentGuard. Agents authenticate with an
// API key; only its SHA-256 hash is stored, so a database leak does not leak keys.
const agentSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, default: "" },
    apiKeyHash: { type: String, required: true, unique: true, select: false },
    apiKeyPreview: { type: String, required: true }, // e.g. "agk_3f9c…" so people can tell keys apart
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export type AgentDoc = InferSchemaType<typeof agentSchema> & { _id: Types.ObjectId };
export const Agent = model("Agent", agentSchema);
