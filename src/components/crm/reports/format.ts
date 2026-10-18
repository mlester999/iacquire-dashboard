// Display helpers for CRM reports. Pure functions: no I/O, safe on the server and in the browser.
import { addDays } from "@/components/crm/reports/spec";
import type { Money } from "@/components/crm/reports/types";
import { money } from "@/lib/crm/format";

/** Every calendar day from `from` to `to` (both YYYY-MM-DD, both included), with the recorded value or 0. Days are already in the workspace's zone. */
export function fillDays<T extends { day: string }>(rows: T[], from: string, to: string, pick: (r: T) => number): Array<{ x: string; y: number }> {
  const byDay = new Map(rows.map((r) => [r.day, pick(r)]));
  const out: Array<{ x: string; y: number }> = [];
  for (let d = from, guard = 0; d <= to && guard < 400; d = addDays(d, 1), guard++) out.push({ x: d, y: byDay.get(d) ?? 0 });
  return out;
}

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/** A YYYY-MM-DD day as "Oct 7" (it is already a date in the workspace's zone, so it is formatted as a plain date). */
export function dayLabel(day: string, withYear = false): string {
  const t = new Date(`${day}T12:00:00Z`);
  return Number.isNaN(t.getTime()) ? day : (withYear ? DAY_YEAR : DAY).format(t);
}

/** "Oct 1 – 30, 2026" style period text. */
export function periodText(from: string, to: string): string {
  if (from === to) return dayLabel(from, true);
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${sameYear ? dayLabel(from) : dayLabel(from, true)} – ${dayLabel(to, true)}`;
}

/** Amounts per currency, never added together: "$1,200 · ₱50,000". Null when there is nothing recorded. */
export function moneyText(values: Money[] | null | undefined): string | null {
  if (!values?.length) return null;
  return values.map((v) => money(v.value, v.currency)).join(" · ");
}

export const count = (n: number | null | undefined) => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));
export const percent = (n: number | null | undefined) => (n === null || n === undefined ? "—" : `${n.toLocaleString("en-US", { maximumFractionDigits: 1 })}%`);
/** part ÷ whole as a percentage with one decimal, or null when the whole is zero. */
export const share = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1000) / 10 : null);
export const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
