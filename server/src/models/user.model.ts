import { Schema, model, InferSchemaType, Types } from "mongoose";
import { USER_ROLES } from "../constants";

const userSchema = new Schema(
  {
    workspaceId: { type: Schema.Types.ObjectId, ref: "Workspace", required: true, index: true },
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false }, // never returned by default
    role: { type: String, enum: USER_ROLES, required: true },
    // Turned off = cannot sign in and existing sessions stop working. People are never deleted, so history keeps their name.
    // Users created before this field existed have no value at all, so "active" always means "not false".
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: Types.ObjectId };
export const User = model("User", userSchema);
