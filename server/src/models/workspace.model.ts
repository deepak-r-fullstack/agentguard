import { Schema, model, InferSchemaType } from "mongoose";

// A workspace is one customer company. Every other document carries its
// workspaceId, and every query filters by it, so companies never see each other's data.
const workspaceSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true },
    currency: { type: String, default: "INR" },
  },
  { timestamps: true }
);

export type WorkspaceDoc = InferSchemaType<typeof workspaceSchema>;
export const Workspace = model("Workspace", workspaceSchema);
