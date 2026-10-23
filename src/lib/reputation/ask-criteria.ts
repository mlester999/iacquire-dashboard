// Who a review request batch is for. Rule R2: who is asked for a review never depends on how they felt. A batch is chosen by a service that was COMPLETED in a window (an
// appointment a person marked attended, a deal that was won, a customer since a date), and optionally narrowed to the calendar, appointment type or pipeline it happened in.
// The schema below is a strict object: a key it does not list (a rating, a score, a comment, a feedback status, an escalation, a complaint, a lead score, a tag) is refused,
// not ignored, and the database repeats the same list as a check on the criteria column. Pure: the form and the server run the same checks.
import { z } from "zod";

export const BATCH_SOURCES = ["appointments_showed", "deals_won", "customers_since"] as const;
export type BatchSource = (typeof BATCH_SOURCES)[number];

export const BATCH_SOURCE_LABELS: Record<BatchSource, string> = {
  appointments_showed: "Appointments marked attended",
  deals_won: "Deals marked won",
  customers_since: "Customers who became customers",
};

/** The only keys criteria may have. The database check on review_request_batches.criteria lists the same six. */
export const CRITERIA_KEYS = ["source", "from", "to", "calendarIds", "appointmentTypeIds", "pipelineId"] as const;

/** The longest window one batch may cover, in days (both ends included). A longer look-back is several batches. */
export const MAX_WINDOW_DAYS = 366;
export const MAX_FILTER_IDS = 25;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const isRealDay = (s: string) => {
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const dayNumber = (s: string) => Math.round(new Date(`${s}T00:00:00Z`).getTime() / 86_400_000);

const day = (what: string) =>
  z.string({ error: `Choose the ${what} date.` }).regex(DAY_RE, { error: `Choose the ${what} date.` }).refine(isRealDay, { error: `The ${what} date isn't a real date.` });
const idList = (what: string) =>
  z.array(z.string().uuid({ error: `Choose ${what} from the list.` })).min(1, { error: `Choose at least one ${what}, or leave the choice empty.` }).max(MAX_FILTER_IDS, { error: `Choose at most ${MAX_FILTER_IDS} ${what}s.` });

export const criteriaSchema = z
  .strictObject({
    source: z.enum(BATCH_SOURCES, { error: "Choose which completed service this batch is for." }),
    from: day("first"),
    to: day("last"),
    calendarIds: idList("calendar").optional(),
    appointmentTypeIds: idList("appointment type").optional(),
    pipelineId: z.string().uuid({ error: "Choose a pipeline from the list." }).optional(),
  })
  .superRefine((c, ctx) => {
    if (c.from > c.to) ctx.addIssue({ code: "custom", path: ["to"], message: "The last day can't be before the first day." });
    else if (dayNumber(c.to) - dayNumber(c.from) + 1 > MAX_WINDOW_DAYS) ctx.addIssue({ code: "custom", path: ["to"], message: `One batch covers at most ${MAX_WINDOW_DAYS} days. Make two batches for a longer stretch.` });
    if (c.source !== "appointments_showed" && (c.calendarIds || c.appointmentTypeIds)) ctx.addIssue({ code: "custom", path: ["source"], message: "Calendars and appointment types only narrow appointments." });
    if (c.source !== "deals_won" && c.pipelineId) ctx.addIssue({ code: "custom", path: ["source"], message: "A pipeline only narrows deals." });
  });

export type BatchCriteria = z.infer<typeof criteriaSchema>;

const sortedUnique = (ids: string[] | undefined) => (ids?.length ? [...new Set(ids.map((i) => i.toLowerCase()))].sort() : undefined);

/** The same criteria in one canonical shape (ids lower case, sorted, no duplicates, empty lists dropped), so the same choice always hashes the same. */
export function normalizeCriteria(c: BatchCriteria): BatchCriteria {
  const out: BatchCriteria = { source: c.source, from: c.from, to: c.to };
  const calendars = sortedUnique(c.calendarIds);
  const types = sortedUnique(c.appointmentTypeIds);
  if (calendars) out.calendarIds = calendars;
  if (types) out.appointmentTypeIds = types;
  if (c.pipelineId) out.pipelineId = c.pipelineId.toLowerCase();
  return out;
}

const safeKey = (k: string) => k.replace(/[^\w .-]/g, "").slice(0, 40);

/** Reads criteria from anything a form or a stored row may hold: the normalized criteria, or one plain sentence saying what is wrong. */
export function parseCriteria(raw: unknown): { ok: true; criteria: BatchCriteria } | { ok: false; message: string } {
  const r = criteriaSchema.safeParse(raw);
  if (r.success) return { ok: true, criteria: normalizeCriteria(r.data) };
  const issue = r.error.issues[0];
  if (issue?.code === "unrecognized_keys") {
    const keys = (issue as { keys?: string[] }).keys ?? [];
    return { ok: false, message: `A batch is chosen only by when a service was completed, and optionally where. “${safeKey(keys[0] ?? "that")}” isn't a choice: who is asked never depends on how someone felt.` };
  }
  return { ok: false, message: issue?.message ?? "Check who this batch is for." };
}

/** Today's date in a time zone, as YYYY-MM-DD. */
export function dayIn(timezone: string, now: Date): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

/** What is wrong with a window given today's date in the workspace's time zone, or null. A service that has not happened yet cannot be asked about. */
export function criteriaProblem(c: BatchCriteria, today: string): string | null {
  if (c.from > today) return "The first day is in the future. Customers can only be asked about a service that has already happened.";
  if (c.to > today) return "The last day is in the future. Customers can only be asked about a service that has already happened.";
  return null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** 2026-10-05 as "5 Oct 2026". */
export function formatDay(s: string): string {
  if (!DAY_RE.test(s)) return s;
  const [y, m, d] = s.split("-").map(Number);
  return `${d} ${MONTHS[m - 1] ?? ""} ${y}`;
}

export interface CriteriaNames {
  calendars?: ReadonlyMap<string, string>;
  appointmentTypes?: ReadonlyMap<string, string>;
  pipelines?: ReadonlyMap<string, string>;
}

const list = (names: string[]) => (names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);

/** The criteria as a sentence a person can check: "Appointments marked attended from 1 Oct 2026 to 31 Oct 2026, at Front desk." */
export function describeCriteria(c: BatchCriteria, names: CriteriaNames = {}): string {
  const base = `${BATCH_SOURCE_LABELS[c.source]} from ${formatDay(c.from)} to ${formatDay(c.to)}`;
  const where: string[] = [];
  if (c.calendarIds?.length) where.push(`on ${list(c.calendarIds.map((id) => names.calendars?.get(id) ?? "a calendar"))}`);
  if (c.appointmentTypeIds?.length) where.push(`for ${list(c.appointmentTypeIds.map((id) => names.appointmentTypes?.get(id) ?? "an appointment type"))}`);
  if (c.pipelineId) where.push(`in ${names.pipelines?.get(c.pipelineId) ?? "one pipeline"}`);
  return `${base}${where.length ? `, ${where.join(", ")}` : ""}.`;
}
