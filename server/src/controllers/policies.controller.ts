import { Request, Response } from "express";
import { z } from "zod";
import { successResponse, successResponseWithData } from "../helpers/response";
import { getRequestUser, userActor } from "../middlewares/auth.middleware";
import { describeActionCatalog } from "../services/actions/actionRegistry";
import { createPolicy, deletePolicy, listPolicies, updatePolicy } from "../services/policy/policy.service";
import { PolicyInput } from "../services/policy/policySchemas";
import { draftPolicyFromText } from "../services/llm/ruleDrafter.service";
import { llmDescription } from "../services/llm/llmClient";

export const draftPolicySchema = z.object({
  text: z.string().trim().min(5).max(500),
});

function toPolicyDto(policy: any) {
  return {
    id: String(policy._id),
    name: policy.name,
    action: policy.action,
    effect: policy.effect,
    conditions: policy.conditions || [],
    dailyLimit: policy.dailyLimit || null,
    enabled: policy.enabled,
    sourceText: policy.sourceText || "",
    createdAt: policy.createdAt,
    updatedAt: policy.updatedAt,
  };
}

export async function getPolicies(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const policies = await listPolicies(user.workspaceId);
  return successResponseWithData(res, "Rules.", policies.map(toPolicyDto));
}

export async function getCatalog(_req: Request, res: Response) {
  return successResponseWithData(res, "Actions and AI settings.", {
    actions: describeActionCatalog(),
    ai: llmDescription(),
  });
}

export async function addPolicy(_req: Request, res: Response) {
  const user = getRequestUser(res);
  const policy = await createPolicy(user.workspaceId, res.locals.body as PolicyInput, userActor(user));
  return successResponseWithData(res, "Rule saved. It applies to the next action.", toPolicyDto(policy), 201);
}

export async function editPolicy(req: Request, res: Response) {
  const user = getRequestUser(res);
  const policy = await updatePolicy(user.workspaceId, req.params.id, res.locals.body as PolicyInput, userActor(user));
  return successResponseWithData(res, "Rule updated.", toPolicyDto(policy));
}

export async function removePolicy(req: Request, res: Response) {
  const user = getRequestUser(res);
  await deletePolicy(user.workspaceId, req.params.id, userActor(user));
  return successResponse(res, "Rule deleted.");
}

export async function draftPolicy(_req: Request, res: Response) {
  const { text } = res.locals.body as z.infer<typeof draftPolicySchema>;
  const result = await draftPolicyFromText(text);
  const message = result.valid
    ? "Here is the draft. Check it, then save."
    : "The draft needs fixing before it can be saved.";
  return successResponseWithData(res, message, result);
}
