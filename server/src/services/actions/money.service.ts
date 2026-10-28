import { Types } from "mongoose";
import { Workspace } from "../../models/workspace.model";
import { DEFAULT_CURRENCY, formatMoney } from "../../utils/format";

// ---------------------------------------------------------------------------
// Money that AI agents cannot misread. A bare "3900" could be rupees, dollars or
// cents, and an agent will guess. So every amount an agent receives is
// accompanied by the workspace currency and a ready-to-read string:
//   { refundAmount: 3900, currency: "INR", refundAmountFormatted: "₹3,900" }
// Fields are only ever ADDED next to the existing ones, so current clients keep working.
// ---------------------------------------------------------------------------

// Which fields of an action's facts / result hold money. Each registered action declares its own.
export interface MoneyFields {
  facts: string[];
  result: string[];
}

export async function getWorkspaceCurrency(workspaceId: Types.ObjectId): Promise<string> {
  const workspace = await Workspace.findById(workspaceId).select("currency").lean();
  return workspace?.currency?.trim().toUpperCase() || DEFAULT_CURRENCY;
}

/**
 * Returns a copy with `currency` and a "<field>Formatted" string next to each money field.
 * Computed on every read (never stored), so records written before this change get them too.
 * Values with no money in them come back unchanged.
 */
export function withMoneyFields(
  values: Record<string, unknown> | null | undefined,
  moneyKeys: string[],
  currency: string
): Record<string, unknown> | null | undefined {
  if (!values) return values;
  const present = moneyKeys.filter((key) => typeof values[key] === "number");
  if (present.length === 0) return values;
  const enriched: Record<string, unknown> = { ...values, currency };
  for (const key of present) enriched[`${key}Formatted`] = formatMoney(values[key] as number, currency);
  return enriched;
}
