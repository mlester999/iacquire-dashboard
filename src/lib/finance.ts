// Agency finance vocabulary: reporting periods and the categories an entry can be filed under. Pure; nothing here reads the database.

export const ENTRY_KINDS = ["direct_cost", "overhead", "tax_set_aside", "reserve_set_aside", "reserve_used"] as const;
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const KIND_LABEL: Record<EntryKind, string> = {
  direct_cost: "Direct cost",
  overhead: "Overhead",
  tax_set_aside: "Tax set aside",
  reserve_set_aside: "Reserve set aside",
  reserve_used: "Reserve used",
};

export const KIND_HELP: Record<EntryKind, string> = {
  direct_cost: "Money spent that belongs to one client, such as a domain bought for them or a provider fee you absorbed.",
  overhead: "Money spent to run the agency that isn't one client's: hosting, software, accounting.",
  tax_set_aside: "Money you moved aside for tax. The portal does not guess a rate; you decide how much.",
  reserve_set_aside: "Money moved into the operating reserve. A recommended amount is shown for each setup payment.",
  reserve_used: "Money taken out of the operating reserve to cover an obligation.",
};

export const CATEGORIES: Record<EntryKind, string[]> = {
  direct_cost: ["Provider subscription", "Domain", "Contractor", "Tools", "Other"],
  overhead: ["Hosting", "Software", "Accounting and legal", "Insurance", "Marketing", "Salaries", "Other"],
  tax_set_aside: ["Income tax", "Sales tax or VAT", "Other"],
  reserve_set_aside: ["Operating reserve"],
  reserve_used: ["Operating expense", "Client remediation", "Other"],
};

export const MAX_ENTRY_USD = 1_000_000;

export type PeriodKey = "this_month" | "last_month" | "last_90_days" | "year_to_date" | "all_time";
export const PERIOD_LABEL: Record<PeriodKey, string> = { this_month: "This month", last_month: "Last month", last_90_days: "Last 90 days", year_to_date: "Year to date", all_time: "All time" };
export const isPeriodKey = (v: unknown): v is PeriodKey => typeof v === "string" && v in PERIOD_LABEL;

export interface Period {
  key: PeriodKey;
  label: string;
  /** Inclusive, as an ISO instant. */
  from: string;
  /** Exclusive, as an ISO instant. */
  to: string;
}

const utc = (y: number, m: number, d = 1) => new Date(Date.UTC(y, m, d));

/** Reporting windows are in UTC calendar terms so every report for the same period gives the same numbers, whoever opens it. */
export function resolvePeriod(key: PeriodKey, now = new Date()): Period {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let from: Date;
  let to: Date;
  switch (key) {
    case "this_month":
      from = utc(y, m);
      to = utc(y, m + 1);
      break;
    case "last_month":
      from = utc(y, m - 1);
      to = utc(y, m);
      break;
    case "last_90_days":
      to = new Date(utc(y, m, now.getUTCDate()).getTime() + 86_400_000);
      from = new Date(to.getTime() - 90 * 86_400_000);
      break;
    case "year_to_date":
      from = utc(y, 0);
      to = utc(y, m + 1);
      break;
    default:
      from = new Date(Date.UTC(2020, 0, 1));
      to = utc(y + 1, 0);
  }
  return { key, label: PERIOD_LABEL[key], from: from.toISOString(), to: to.toISOString() };
}

/** Whole-dollar display of micro-dollars with a sign, for report lines. */
export const signedUsd = (micros: number) => `${micros < 0 ? "−" : ""}$${(Math.abs(micros) / 1_000_000).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
