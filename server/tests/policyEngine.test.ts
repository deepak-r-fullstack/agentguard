import { evaluateCondition, evaluatePolicies, getValueAtPath, PolicyRule } from "../src/services/policy/policyEngine";

// Pure unit tests: no database needed.

function rule(overrides: Partial<PolicyRule>): PolicyRule {
  return {
    id: overrides.id || overrides.name || "rule",
    name: "rule",
    action: "booking.cancel",
    effect: "allow",
    conditions: [],
    dailyLimit: null,
    enabled: true,
    ...overrides,
  };
}

const context = (amount: number) => ({ params: { bookingCode: "BK-1" }, facts: { amount }, agentName: "Bot", onBehalfOf: "ravi" });

describe("getValueAtPath", () => {
  it("reads nested values and returns undefined for missing ones", () => {
    expect(getValueAtPath({ facts: { amount: 5 } }, "facts.amount")).toBe(5);
    expect(getValueAtPath({ facts: {} }, "facts.amount")).toBeUndefined();
    expect(getValueAtPath(null, "facts.amount")).toBeUndefined();
  });
});

describe("evaluateCondition", () => {
  const ctx = context(7500);
  it.each([
    ["gt", 5000, true],
    ["gt", 7500, false],
    ["gte", 7500, true],
    ["lt", 7500, false],
    ["lte", 7500, true],
    ["eq", 7500, true],
    ["neq", 7500, false],
  ] as const)("%s %d -> %s", (op, value, expected) => {
    expect(evaluateCondition({ field: "facts.amount", op, value }, ctx)).toBe(expected);
  });

  it("supports lists with in / nin", () => {
    expect(evaluateCondition({ field: "agentName", op: "in", value: ["Bot", "Other"] }, ctx)).toBe(true);
    expect(evaluateCondition({ field: "agentName", op: "nin", value: ["Bot"] }, ctx)).toBe(false);
  });

  it("never matches a missing field or a type mismatch", () => {
    expect(evaluateCondition({ field: "facts.missing", op: "neq", value: 1 }, ctx)).toBe(false);
    expect(evaluateCondition({ field: "agentName", op: "gt", value: 1 }, ctx)).toBe(false);
  });
});

describe("evaluatePolicies", () => {
  const rules: PolicyRule[] = [
    rule({ id: "small", name: "Small is fine", effect: "allow", conditions: [{ field: "facts.amount", op: "lte", value: 5000 }] }),
    rule({ id: "big", name: "Big needs approval", effect: "require_approval", conditions: [{ field: "facts.amount", op: "gt", value: 5000 }] }),
    rule({ id: "cap", name: "Daily cap", effect: "deny", dailyLimit: { scope: "agent", sumField: "facts.amount", max: 20000 } }),
  ];

  it("allows a small action", () => {
    const result = evaluatePolicies(rules, { action: "booking.cancel", context: context(4000), irreversible: false });
    expect(result.decision).toBe("allow");
    expect(result.matchedRuleIds).toEqual(["small"]);
  });

  it("asks a person for a big action", () => {
    const result = evaluatePolicies(rules, { action: "booking.cancel", context: context(7500), irreversible: false });
    expect(result.decision).toBe("require_approval");
  });

  it("denies when the daily total would go over the cap (the split attack)", () => {
    const result = evaluatePolicies(rules, {
      action: "booking.cancel",
      context: context(4900),
      irreversible: false,
      usageByRuleId: { cap: 17400 },
    });
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]).toContain("22,300");
  });

  it("does not trigger the cap while under the limit", () => {
    const result = evaluatePolicies(rules, {
      action: "booking.cancel",
      context: context(2600),
      irreversible: false,
      usageByRuleId: { cap: 17400 },
    });
    expect(result.decision).toBe("allow");
  });

  it("fails closed when the limited amount cannot be measured", () => {
    const result = evaluatePolicies(rules, {
      action: "booking.cancel",
      context: { facts: {} },
      irreversible: false,
    });
    expect(result.decision).toBe("deny");
  });

  it("asks a person by default when no rule covers the action", () => {
    const result = evaluatePolicies(rules, { action: "customer.updateEmail", context: {}, irreversible: false });
    expect(result.decision).toBe("require_approval");
    expect(result.matchedRuleIds).toEqual([]);
  });

  it("never auto-allows an irreversible action", () => {
    const allowAll = [rule({ id: "all", action: "notification.sendEmail", effect: "allow" })];
    const result = evaluatePolicies(allowAll, { action: "notification.sendEmail", context: {}, irreversible: true });
    expect(result.decision).toBe("require_approval");
  });

  it("ignores disabled rules and applies wildcard rules", () => {
    const result = evaluatePolicies(
      [
        rule({ id: "off", effect: "allow", enabled: false }),
        rule({ id: "wild", action: "*", effect: "deny", conditions: [{ field: "agentName", op: "eq", value: "Bot" }] }),
      ],
      { action: "booking.cancel", context: context(100), irreversible: false }
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRuleIds).toEqual(["wild"]);
  });

  it("lets the strictest matching rule win", () => {
    const result = evaluatePolicies(
      [rule({ id: "a", effect: "allow" }), rule({ id: "b", effect: "deny" }), rule({ id: "c", effect: "require_approval" })],
      { action: "booking.cancel", context: context(1), irreversible: false }
    );
    expect(result.decision).toBe("deny");
    expect(result.matchedRuleIds).toEqual(["b"]);
  });
});

describe("daily limit reasons with money", () => {
  const cap = [rule({ id: "cap", name: "Daily cap", effect: "deny", dailyLimit: { scope: "agent", sumField: "facts.amount", max: 20000 } })];
  const input = { action: "booking.cancel", irreversible: false, usageByRuleId: { cap: 17400 }, context: context(4900) };

  it("keeps the plain numbers when no currency is given (as before)", () => {
    const result = evaluatePolicies(cap, input);
    expect(result.reasons[0]).toContain("22,300, over the limit of 20,000");
    expect(result.reasons[0]).not.toContain("₹");
  });

  it("names the currency when the limit adds up a money field", () => {
    const result = evaluatePolicies(cap, { ...input, money: { currency: "INR", fields: ["facts.amount"] } });
    expect(result.reasons[0]).toContain("₹22,300, over the limit of ₹20,000");
  });

  it("does not add a currency to a limit on something that is not money", () => {
    const result = evaluatePolicies(cap, { ...input, money: { currency: "INR", fields: ["facts.discountAmount"] } });
    expect(result.reasons[0]).toContain("22,300, over the limit of 20,000");
    expect(result.reasons[0]).not.toContain("₹");
  });
});
