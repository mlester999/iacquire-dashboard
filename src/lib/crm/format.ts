// Display formatting shared by server and client components. No I/O here.

export function money(value: number | null | undefined, currency = "USD") {
  if (value === null || value === undefined) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: value % 1 === 0 ? 0 : 2 }).format(value);
  } catch {
    return `${currency} ${value.toLocaleString("en-US")}`;
  }
}

/** A calendar date (YYYY-MM-DD) for display, without shifting it through a time zone. The year shows only when it isn't this year. */
export function shortDate(isoDate: string | null | undefined): string {
  if (!isoDate) return "";
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  if (!y || !m || !d) return isoDate;
  const sameYear = y === new Date().getFullYear();
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }), timeZone: "UTC" });
}

export function totalsText(totals: Array<{ currency: string; value: number }>) {
  if (!totals.length) return "No values";
  return totals.map((t) => money(t.value, t.currency)).join(" · ");
}
