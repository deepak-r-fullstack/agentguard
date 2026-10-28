import { Schema, model, InferSchemaType, Types } from "mongoose";
import { ACTOR_TYPES, AUDIT_EVENT_TYPES } from "../constants";

// Append-only audit trail. The app never updates or deletes these documents.
// (In production you would also block updates at the database-user level.)
const auditEventSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true },
    type: { type: String, enum: AUDIT_EVENT_TYPES, required: true },
    actionId: { type: Schema.Types.ObjectId, ref: "ActionRecord" },
    policyId: { type: Schema.Types.ObjectId, ref: "Policy" },
    actor: {
      type: { type: String, enum: ACTOR_TYPES, required: true },
      id: { type: String, required: true },
      name: { type: String, required: true },
    },
    onBehalfOf: { type: String, default: "" },
    summary: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

auditEventSchema.index({ workspaceId: 1, createdAt: -1 });
auditEventSchema.index({ workspaceId: 1, actionId: 1, createdAt: 1 });

export type AuditEventDoc = InferSchemaType<typeof auditEventSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const AuditEvent = model("AuditEvent", auditEventSchema);
