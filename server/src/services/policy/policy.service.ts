import { Types } from "mongoose";
import { Policy, PolicyDoc } from "../../models/policy.model";
import { NotFoundError } from "../../helpers/errors";
import { Actor, recordAuditEvent } from "../audit/audit.service";
import { PolicyRule } from "./policyEngine";
import { PolicyInput } from "./policySchemas";

export function toPolicyRule(policy: PolicyDoc): PolicyRule {
  return {
    id: String(policy._id),
    name: policy.name,
    action: policy.action,
    effect: policy.effect,
    conditions: (policy.conditions || []).map((condition) => ({
      field: condition.field,
      op: condition.op,
      value: condition.value,
    })),
    dailyLimit: policy.dailyLimit
      ? { scope: policy.dailyLimit.scope, sumField: policy.dailyLimit.sumField, max: policy.dailyLimit.max }
      : null,
    enabled: policy.enabled,
  };
}

export async function getEnabledRules(workspaceId: Types.ObjectId): Promise<PolicyRule[]> {
  const policies = await Policy.find({ workspaceId, enabled: true }).lean<PolicyDoc[]>();
  return policies.map(toPolicyRule);
}

// ---------- CRUD (every change is audited) ----------

export async function listPolicies(workspaceId: Types.ObjectId) {
  return Policy.find({ workspaceId }).sort({ createdAt: -1 }).lean<PolicyDoc[]>();
}

export async function createPolicy(workspaceId: Types.ObjectId, input: PolicyInput, actor: Actor) {
  const policy = await Policy.create({ ...input, workspaceId, createdBy: actor.id });
  await recordAuditEvent({
    workspaceId,
    type: "policy_created",
    policyId: policy._id,
    actor,
    summary: `Created rule "${policy.name}" (${policy.effect.replace("_", " ")} for ${policy.action})`,
  });
  return policy.toObject();
}

export async function updatePolicy(
  workspaceId: Types.ObjectId,
  policyId: string,
  input: PolicyInput,
  actor: Actor
) {
  const policy = await Policy.findOneAndUpdate({ _id: policyId, workspaceId }, { $set: input }, { new: true });
  if (!policy) throw new NotFoundError("That rule was not found.");
  await recordAuditEvent({
    workspaceId,
    type: "policy_updated",
    policyId: policy._id,
    actor,
    summary: `Updated rule "${policy.name}"${policy.enabled ? "" : " (now turned off)"}`,
  });
  return policy.toObject();
}

export async function deletePolicy(workspaceId: Types.ObjectId, policyId: string, actor: Actor) {
  const policy = await Policy.findOneAndDelete({ _id: policyId, workspaceId });
  if (!policy) throw new NotFoundError("That rule was not found.");
  await recordAuditEvent({
    workspaceId,
    type: "policy_deleted",
    policyId: policy._id,
    actor,
    summary: `Deleted rule "${policy.name}"`,
  });
}
