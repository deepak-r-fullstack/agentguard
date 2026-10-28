import { Schema, model, InferSchemaType, Types } from "mongoose";
import { ACTOR_TYPES, AUDIT_EVENT_TYPES } from "../constants";

// Append-only audit trail. The app never updates or deletes these documents.
// (In production you would also block updates at the database-user level.)
// Each company's events form a hash chain: `seq` counts 1, 2, 3... and `hash` covers the event
// plus the previous event's hash, so changing or removing an old entry breaks every hash after it.
// Entries written before the chain existed have no seq/hash and sit outside it.
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
    seq: { type: Number },
    prevHash: { type: String },
    hash: { type: String },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Two writers can never take the same number. Partial, because older entries have no seq.
auditEventSchema.index({ workspaceId: 1, seq: 1 }, { unique: true, partialFilterExpression: { seq: { $exists: true } } });
auditEventSchema.index({ workspaceId: 1, createdAt: -1 });
auditEventSchema.index({ workspaceId: 1, actionId: 1, createdAt: 1 });

export type AuditEventDoc = InferSchemaType<typeof auditEventSchema> & {
  _id: Types.ObjectId;
  createdAt: Date;
};
export const AuditEvent = model("AuditEvent", auditEventSchema);
