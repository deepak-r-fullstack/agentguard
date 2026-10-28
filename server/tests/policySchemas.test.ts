import { policyInputSchema } from "../src/services/policy/policySchemas";

// The same validation runs for rules built by hand and rules drafted by AI.

const base = {
  name: "Test rule",
  action: "booking.cancel",
  effect: "allow",
  conditions: [{ field: "facts.amount", op: "lte", value: 5000 }],
};

describe("policyInputSchema", () => {
  it("accepts a valid rule and fills defaults", () => {
    const result = policyInputSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.dailyLimit).toBeNull();
    }
  });

  it("rejects an unknown action", () => {
    expect(policyInputSchema.safeParse({ ...base, action: "bank.transferAll" }).success).toBe(false);
  });

  it("rejects a field the action does not have (an AI could invent one)", () => {
    const result = policyInputSchema.safeParse({
      ...base,
      conditions: [{ field: "facts.customerMood", op: "eq", value: "angry" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a number comparison on a text value", () => {
    const result = policyInputSchema.safeParse({
      ...base,
      conditions: [{ field: "facts.amount", op: "gt", value: "5000" }],
    });
    expect(result.success).toBe(false);
  });

  it("requires a list for 'in'", () => {
    const result = policyInputSchema.safeParse({
      ...base,
      conditions: [{ field: "agentName", op: "in", value: "Bot" }],
    });
    expect(result.success).toBe(false);
  });

  it("only allows daily limits on number facts", () => {
    const ok = policyInputSchema.safeParse({
      ...base,
      effect: "deny",
      conditions: [],
      dailyLimit: { scope: "agent", sumField: "facts.amount", max: 20000 },
    });
    const bad = policyInputSchema.safeParse({
      ...base,
      effect: "deny",
      conditions: [],
      dailyLimit: { scope: "agent", sumField: "params.bookingCode", max: 1 },
    });
    expect(ok.success).toBe(true);
    expect(bad.success).toBe(false);
  });

  it("limits wildcard rules to fields every action has", () => {
    expect(
      policyInputSchema.safeParse({ ...base, action: "*", conditions: [{ field: "agentName", op: "eq", value: "Bot" }] }).success
    ).toBe(true);
    expect(policyInputSchema.safeParse({ ...base, action: "*" }).success).toBe(false);
  });
});
