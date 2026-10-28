import { Schema, model, InferSchemaType } from "mongoose";
import { DEFAULT_APPROVAL_EXPIRY_HOURS } from "../constants";

// A workspace is one customer company. Every other document carries its
// workspaceId, and every query filters by it, so companies never see each other's data.
const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    currency: { type: String, default: "INR" },
    // Slack channel (e.g. "C0123456789") that gets approval requests. Empty = Slack is not used.
    slackChannelId: { type: String, default: "", trim: true },
    // How long a request may wait for a person before it expires. Admins change it on the Rules screen.
    approvalExpiryHours: { type: Number, default: DEFAULT_APPROVAL_EXPIRY_HOURS },
  },
  { timestamps: true }
);

export type WorkspaceDoc = InferSchemaType<typeof workspaceSchema>;
export const Workspace = model("Workspace", workspaceSchema);
