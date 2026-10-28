// Formatting helpers for the plain-English sentences people read.

export const DEFAULT_CURRENCY = "INR";

export function formatMoney(amount: number, currency = DEFAULT_CURRENCY): string {
  try {
    return new Intl.NumberFormat("en-IN", {
      style: "currency",
      currency,
      maximumFractionDigits: 0,
    }).format(amount);
  } catch {
    // Workspace.currency is free text. An unknown code must never fail a request or hide the unit,
    // so show the code itself ("XYZ 3,900") instead of guessing a symbol.
    return `${currency} ${amount.toLocaleString("en-IN")}`;
  }
}

export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short", year: "numeric" }).format(date);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / DAY_MS);
}
