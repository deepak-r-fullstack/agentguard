import { formatMoney } from "../src/utils/format";
import { withMoneyFields } from "../src/services/actions/money.service";

// Pure unit tests: no database needed.

describe("formatMoney", () => {
  it("uses Indian grouping and the rupee by default", () => {
    expect(formatMoney(3900)).toBe("₹3,900");
    expect(formatMoney(1250000)).toBe("₹12,50,000");
  });

  it("formats other currencies", () => {
    expect(formatMoney(3900, "USD")).toBe("$3,900");
  });

  it("spells out a currency code it does not know instead of failing", () => {
    expect(formatMoney(3900, "RUPEES")).toBe("RUPEES 3,900");
  });
});

describe("withMoneyFields", () => {
  it("adds the currency and a formatted string next to each money field, and keeps everything else", () => {
    const result = withMoneyFields({ bookingCode: "BK-1", refundAmount: 3900 }, ["refundAmount"], "INR");
    expect(result).toEqual({ bookingCode: "BK-1", refundAmount: 3900, currency: "INR", refundAmountFormatted: "₹3,900" });
  });

  it("formats every listed field that is present", () => {
    const result = withMoneyFields({ amount: 3900, discountAmount: 390, percent: 10 }, ["amount", "discountAmount", "missing"], "INR");
    expect(result).toEqual({
      amount: 3900,
      discountAmount: 390,
      percent: 10,
      currency: "INR",
      amountFormatted: "₹3,900",
      discountAmountFormatted: "₹390",
    });
  });

  it("returns values with no money in them unchanged, and does not change the original", () => {
    const original = { bookingCode: "BK-1", amount: 5 };
    expect(withMoneyFields(original, [], "INR")).toBe(original);
    withMoneyFields(original, ["amount"], "INR");
    expect(original).toEqual({ bookingCode: "BK-1", amount: 5 });
  });

  it("passes null and undefined through", () => {
    expect(withMoneyFields(null, ["amount"], "INR")).toBeNull();
    expect(withMoneyFields(undefined, ["amount"], "INR")).toBeUndefined();
  });
});
