import { PipelineStage, Types } from "mongoose";
import { Policy, PolicyDoc } from "../../models/policy.model";
import { ActionRecord } from "../../models/actionRecord.model";
import { STATUSES_COUNTING_TOWARDS_LIMITS } from "../../constants";
import { NotFoundError } from "../../helpers/errors";
import { Actor, recordAuditEvent } from "../audit/audit.service";
import { PolicyRule } from "./policyEngine";
import { PolicyInput } from "./policySchemas";

const DAY_MS = 24 * 60 * 60 * 1000;

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

/**
 * For each rule with a daily limit, add up what was already used in the last
 * 24 hours (rolling window). Pending requests count too, so an agent cannot
 * queue ten small requests to get around a limit.
 */
export async function getUsageByRuleId(
  workspaceId: Types.ObjectId,
  rules: PolicyRule[],
  agentId: Types.ObjectId
): Promise<Record<string, number>> {
  const usage: Record<string, number> = {};
  const since = new Date(Date.now() - DAY_MS);

  for (const rule of rules) {
    if (!rule.dailyLimit) continue;
    // sumField is validated as "facts.<name>" (see policySchemas), so it is safe to use as a field path.
    const pipeline: PipelineStage[] = [
      {
        $match: {
          workspaceId,
          action: rule.action,
          status: { $in: STATUSES_COUNTING_TOWARDS_LIMITS },
          createdAt: { $gte: since },
          ...(rule.dailyLimit.scope === "agent" ? { agentId } : {}),
        },
      },
      { $group: { _id: null, total: { $sum: `$${rule.dailyLimit.sumField}` } } },
    ];
    const [result] = await ActionRecord.aggregate<{ total: number }>(pipeline);
    usage[rule.id] = result?.total || 0;
  }
  return usage;
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
