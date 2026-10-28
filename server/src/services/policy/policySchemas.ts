import { z } from "zod";
import { CONDITION_OPERATORS, DECISIONS, LIMIT_SCOPES } from "../../constants";
import { actionRegistry } from "../actions/actionRegistry";

// One validation path for every rule, whether a person built it in the form or
// AI drafted it from a sentence. Fields must exist on the chosen action, so a
// typo cannot create a rule that silently never matches.

const FIELD_PATH = /^(facts|params)\.[A-Za-z][A-Za-z0-9]*$|^(agentName|onBehalfOf)$/;

const conditionSchema = z.object({
  field: z.string().regex(FIELD_PATH, "Unknown field"),
  op: z.enum(CONDITION_OPERATORS),
  value: z.union([z.number(), z.string(), z.boolean(), z.array(z.union([z.number(), z.string()])).min(1)]),
});

const dailyLimitSchema = z.object({
  scope: z.enum(LIMIT_SCOPES),
  sumField: z.string().regex(/^facts\.[A-Za-z][A-Za-z0-9]*$/, "Daily limits must add up a number fact"),
  max: z.number().min(0),
});

export const policyInputSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    action: z.string().trim().min(1),
    effect: z.enum(DECISIONS),
    conditions: z.array(conditionSchema).max(10).default([]),
    dailyLimit: dailyLimitSchema.nullable().optional().default(null),
    enabled: z.boolean().optional().default(true),
    sourceText: z.string().trim().max(500).optional().default(""),
  })
  .superRefine((policy, ctx) => {
    if (policy.action === "*") {
      // A rule for every action may only use fields every action has.
      policy.conditions.forEach((condition, index) => {
        if (!["agentName", "onBehalfOf"].includes(condition.field)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["conditions", index, "field"],
            message: "A rule for all actions can only check the agent name or the person it works for.",
          });
        }
      });
      if (policy.dailyLimit) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["dailyLimit"], message: "Daily limits need one specific action." });
      }
      return;
    }

    const definition = actionRegistry[policy.action];
    if (!definition) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["action"], message: `Unknown action "${policy.action}"` });
      return;
    }

    const fieldTypes = new Map(definition.ruleFields.map((field) => [field.path, field.type]));

    policy.conditions.forEach((condition, index) => {
      const fieldType = fieldTypes.get(condition.field);
      if (!fieldType) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conditions", index, "field"],
          message: `"${condition.field}" is not available for ${policy.action}`,
        });
        return;
      }
      const numericOp = ["gt", "gte", "lt", "lte"].includes(condition.op);
      if (numericOp && (fieldType !== "number" || typeof condition.value !== "number")) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conditions", index],
          message: "Greater/less than comparisons need a number field and a number value.",
        });
      }
      const listOp = ["in", "nin"].includes(condition.op);
      if (listOp !== Array.isArray(condition.value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["conditions", index, "value"],
          message: listOp ? "Use a list of values with 'is one of'." : "Use a single value here.",
        });
      }
    });

    if (policy.dailyLimit && fieldTypes.get(policy.dailyLimit.sumField) !== "number") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["dailyLimit", "sumField"],
        message: `"${policy.dailyLimit.sumField}" is not a number field for ${policy.action}`,
      });
    }
  });

export type PolicyInput = z.infer<typeof policyInputSchema>;
