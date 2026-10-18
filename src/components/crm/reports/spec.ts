// The CRM reports vocabulary shared by the server and the screen: which sections exist, who may see each, which filters each one honours,
// how a reporting period is chosen in the workspace's own time zone, and how filters travel in the address bar. No I/O here.
import { z } from "zod";
import { CREATED_VIA, CREATED_VIA_LABELS, type CreatedVia } from "@/lib/crm/types";
import type { Permission } from "@/lib/permissions";

export const REPORT_SECTIONS = ["leads", "appointments", "deals", "pipeline", "messaging", "followups", "workload", "ai", "workflows", "integrations", "usage"] as const;
export type ReportSection = (typeof REPORT_SECTIONS)[number];
export const isReportSection = (v: unknown): v is ReportSection => typeof v === "string" && (REPORT_SECTIONS as readonly string[]).includes(v);

export const FILTER_KEYS = ["member", "source", "pipeline", "campaign", "channel"] as const;
export type FilterKey = (typeof FILTER_KEYS)[number];
export const FILTER_LABELS: Record<FilterKey, string> = { member: "Team member", source: "Lead source", pipeline: "Pipeline", campaign: "Campaign", channel: "Channel" };

export const REPORT_CHANNELS = ["email", "sms", "whatsapp"] as const;
export type ReportChannel = (typeof REPORT_CHANNELS)[number];
export const CHANNEL_LABELS: Record<ReportChannel, string> = { email: "Email", sms: "SMS", whatsapp: "WhatsApp" };

export interface SectionInfo {
  label: string;
  description: string;
  /** Every permission listed is needed. A section someone can't see is left out with a reason, never shown as zeros. */
  needs: Permission[];
  /** The filters this section applies. Any other active filter is named on the section as not applying. */
  filters: FilterKey[];
  /** False for a snapshot of the current state (integration health), which no date range changes. */
  dated: boolean;
  /** The tables the numbers are counted from, shown on the section so every number can be traced to rows. */
  sources: string;
}

export const SECTION_INFO: Record<ReportSection, SectionInfo> = {
  leads: {
    label: "Leads & sources",
    description: "Contacts created, how they arrived, their lead status, and form submissions.",
    needs: ["contacts.view"],
    filters: ["member", "source"],
    dated: true,
    sources: "Contacts (created date, created via, lead source, lead status), native form submissions and website form submissions.",
  },
  appointments: {
    label: "Appointments",
    description: "Booked, completed, cancelled and no-show appointments by type, calendar, host and how they were booked.",
    needs: ["appointments.view"],
    filters: ["member", "source"],
    dated: true,
    sources: "iAcquire calendar appointments only (GoHighLevel calendar copies are excluded).",
  },
  deals: {
    label: "Deals & revenue",
    description: "Opportunities created, won and lost, and recorded deal value by currency.",
    needs: ["sales.view"],
    filters: ["member", "source", "pipeline"],
    dated: true,
    sources: "iAcquire CRM opportunities only: created date, closed date and the value recorded on each deal. Currencies are never added together.",
  },
  pipeline: {
    label: "Pipeline conversion",
    description: "Open deals by stage, win rate and how long deals stay in each stage.",
    needs: ["sales.view"],
    filters: ["pipeline"],
    dated: true,
    sources: "iAcquire CRM pipelines, opportunities and their recorded stage history.",
  },
  messaging: {
    label: "Messaging",
    description: "Messages received and sent, delivery and failures by channel and provider, and campaign recipients.",
    needs: ["inbox.view_all"],
    filters: ["member", "source", "channel", "campaign"],
    dated: true,
    sources: "Conversation messages, provider delivery events and campaign recipient records. Internal notes are not counted.",
  },
  followups: {
    label: "Follow-up performance",
    description: "Follow-up sequences started, why they stopped, replies and follow-up messages sent.",
    needs: ["inbox.view_all"],
    filters: ["member", "source", "channel"],
    dated: true,
    sources: "Follow-up plans, their steps and the messages those steps sent.",
  },
  workload: {
    label: "Team workload",
    description: "Open and overdue tasks, tasks completed, and conversations and deals each person owns.",
    needs: ["crm.view", "team.view"],
    filters: ["member"],
    dated: true,
    sources: "Tasks, conversations (current owner) and open iAcquire CRM deals, per active team member.",
  },
  ai: {
    label: "AI actions",
    description: "CRM tool calls by your AI employees and the approvals they asked for.",
    needs: ["activity.view"],
    filters: [],
    dated: true,
    sources: "The audit log of AI employee CRM tool calls and approval requests.",
  },
  workflows: {
    label: "Workflows",
    description: "Workflow runs, completions and failures. Test runs are counted separately.",
    needs: ["workflows.view"],
    filters: [],
    dated: true,
    sources: "Workflow run records.",
  },
  integrations: {
    label: "Integration health",
    description: "The current state of messaging channels, calendar connections, voice providers and webhooks.",
    needs: ["integrations.view"],
    filters: [],
    dated: false,
    sources: "Channel settings, calendar connections, voice connections, webhook subscriptions and recorded connection checks. A saved setting is not shown as a verified connection.",
  },
  usage: {
    label: "Usage costs",
    description: "Metered usage and what it cost, from the billing ledger.",
    needs: ["usage.view"],
    filters: [],
    dated: true,
    sources: "Metered usage events from the billing ledger (amounts in USD, as billed).",
  },
};

/** The sections someone may see, in display order. */
export function visibleSections(can: (p: Permission) => boolean): ReportSection[] {
  return REPORT_SECTIONS.filter((s) => SECTION_INFO[s].needs.every((p) => can(p)));
}

// ---------------------------------------------------------------------------
// Reporting period
// ---------------------------------------------------------------------------

export const RANGE_PRESETS = ["7d", "30d", "90d", "mtd", "last_month", "qtd", "ytd", "custom"] as const;
export type RangePreset = (typeof RANGE_PRESETS)[number];
export const RANGE_LABELS: Record<RangePreset, string> = {
  "7d": "Last 7 days",
  "30d": "Last 30 days",
  "90d": "Last 90 days",
  mtd: "This month",
  last_month: "Last month",
  qtd: "This quarter",
  ytd: "This year",
  custom: "Custom dates",
};
/** The longest period one report covers. */
export const MAX_RANGE_DAYS = 366;

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar date (YYYY-MM-DD) that really exists, or null. */
export function validDate(s: unknown): string | null {
  if (typeof s !== "string" || !DATE.test(s)) return null;
  const [y, m, d] = s.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d && y >= 2000 && y <= 2100 ? s : null;
}

const toUtc = (s: string) => {
  const [y, m, d] = s.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};
const fmt = (t: Date) => t.toISOString().slice(0, 10);
export const addDays = (s: string, n: number) => {
  const t = toUtc(s);
  t.setUTCDate(t.getUTCDate() + n);
  return fmt(t);
};
/** Whole calendar days from `from` to `to`, both included. */
export const daysBetween = (from: string, to: string) => Math.round((toUtc(to).getTime() - toUtc(from).getTime()) / 86_400_000) + 1;

/** Today's date in a time zone, as YYYY-MM-DD. An unknown zone falls back to UTC rather than failing the report. */
export function todayIn(timeZone: string, now: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export interface ResolvedDates {
  from: string;
  to: string;
  days: number;
  label: string;
}

/**
 * The calendar days a period covers, both ends included, counted in the workspace's time zone (the caller passes today's date there).
 * A custom period must be real dates, in order, no longer than MAX_RANGE_DAYS, and may not end after today.
 */
export function resolveDates(f: Pick<ReportFilters, "range" | "from" | "to">, today: string): ResolvedDates {
  const [y, m] = today.split("-").map(Number);
  const pad = (n: number) => String(n).padStart(2, "0");
  let from: string;
  let to = today;
  switch (f.range) {
    case "7d":
      from = addDays(today, -6);
      break;
    case "90d":
      from = addDays(today, -89);
      break;
    case "mtd":
      from = `${y}-${pad(m)}-01`;
      break;
    case "last_month": {
      const first = m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01`;
      from = first;
      to = addDays(`${y}-${pad(m)}-01`, -1);
      break;
    }
    case "qtd":
      from = `${y}-${pad(Math.floor((m - 1) / 3) * 3 + 1)}-01`;
      break;
    case "ytd":
      from = `${y}-01-01`;
      break;
    case "custom": {
      const issue = customRangeIssue(f.from, f.to, today);
      if (issue) throw new RangeError(issue);
      from = f.from as string;
      to = f.to as string;
      break;
    }
    default:
      from = addDays(today, -29);
  }
  const days = daysBetween(from, to);
  return { from, to, days, label: f.range === "custom" ? `${from} to ${to}` : RANGE_LABELS[f.range] };
}

/** Why a custom period can't be used, in words someone can act on, or null when it is fine. */
export function customRangeIssue(from: string | undefined, to: string | undefined, today: string): string | null {
  const f = validDate(from);
  const t = validDate(to);
  if (!f || !t) return "Choose a start and an end date.";
  if (f > t) return "The start date must be on or before the end date.";
  if (t > today) return "The end date can't be in the future.";
  if (daysBetween(f, t) > MAX_RANGE_DAYS) return `A report covers at most ${MAX_RANGE_DAYS} days. Choose a shorter period.`;
  return null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, { error: "That selection isn't valid." });

export const reportFiltersSchema = z.object({
  range: z.enum(RANGE_PRESETS, { error: "Choose a reporting period." }),
  from: z.string().optional(),
  to: z.string().optional(),
  member: uuid.optional(),
  source: z.enum(CREATED_VIA, { error: "Choose a lead source from the list." }).optional(),
  pipeline: uuid.optional(),
  campaign: uuid.optional(),
  channel: z.enum(REPORT_CHANNELS, { error: "Choose email, SMS or WhatsApp." }).optional(),
});
export type ReportFilters = z.infer<typeof reportFiltersSchema>;

export const DEFAULT_FILTERS: ReportFilters = { range: "30d" };

/** What a saved report remembers: its filters and which sections it shows. */
export const reportConfigSchema = z.object({
  filters: reportFiltersSchema,
  sections: z.array(z.enum(REPORT_SECTIONS)).min(1, { error: "Pick at least one section." }).max(REPORT_SECTIONS.length),
});
export type ReportConfig = z.infer<typeof reportConfigSchema>;

/** The filters that are set, in a fixed order. */
export function activeFilters(f: ReportFilters): FilterKey[] {
  return FILTER_KEYS.filter((k) => f[k] !== undefined && f[k] !== "");
}

/** Active filters a section does not apply, so the screen can say so instead of implying they were applied. */
export function ignoredFilters(section: ReportSection, f: ReportFilters): FilterKey[] {
  return activeFilters(f).filter((k) => !SECTION_INFO[section].filters.includes(k));
}

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export interface ParsedReportParams {
  filters: ReportFilters;
  sections: ReportSection[] | null;
  savedId: string | null;
  /** Set when something in the address couldn't be used and a default was shown instead. */
  notice: string | null;
}

/**
 * Reads filters from the address bar. Anything unusable is dropped (and said so) rather than failing the page: an old bookmark should still
 * open a report.
 */
export function parseReportParams(sp: SP, today: string): ParsedReportParams {
  const notices: string[] = [];
  const range = one(sp.range);
  const preset: RangePreset = (RANGE_PRESETS as readonly string[]).includes(range ?? "") ? (range as RangePreset) : "30d";
  const filters: ReportFilters = { range: preset };
  if (preset === "custom") {
    const from = one(sp.from);
    const to = one(sp.to);
    const issue = customRangeIssue(from, to, today);
    if (issue) {
      filters.range = "30d";
      notices.push(`${issue} Showing the last 30 days instead.`);
    } else {
      filters.from = from;
      filters.to = to;
    }
  }
  const pick = <K extends "member" | "pipeline" | "campaign">(k: K) => {
    const v = one(sp[k]);
    if (!v) return;
    if (uuid.safeParse(v).success) filters[k] = v.toLowerCase();
    else notices.push(`The ${FILTER_LABELS[k].toLowerCase()} filter wasn't valid and was removed.`);
  };
  pick("member");
  pick("pipeline");
  pick("campaign");
  const source = one(sp.source);
  if (source) {
    if ((CREATED_VIA as readonly string[]).includes(source)) filters.source = source as CreatedVia;
    else notices.push("The lead source filter wasn't valid and was removed.");
  }
  const channel = one(sp.channel);
  if (channel) {
    if ((REPORT_CHANNELS as readonly string[]).includes(channel)) filters.channel = channel as ReportChannel;
    else notices.push("The channel filter wasn't valid and was removed.");
  }
  const rawSections = one(sp.sections);
  let sections: ReportSection[] | null = null;
  if (rawSections) {
    const list = [...new Set(rawSections.split(",").map((s) => s.trim()).filter(isReportSection))];
    sections = list.length ? REPORT_SECTIONS.filter((s) => list.includes(s)) : null;
  }
  const saved = one(sp.report);
  return { filters, sections, savedId: saved && uuid.safeParse(saved).success ? saved.toLowerCase() : null, notice: notices.length ? notices.join(" ") : null };
}

/** The address-bar form of filters (and optionally sections and a saved report), the inverse of parseReportParams. */
export function reportSearch(f: ReportFilters, extra: { sections?: ReportSection[] | null; savedId?: string | null } = {}): string {
  const p = new URLSearchParams();
  if (f.range !== "30d") p.set("range", f.range);
  if (f.range === "custom") {
    if (f.from) p.set("from", f.from);
    if (f.to) p.set("to", f.to);
  }
  for (const k of FILTER_KEYS) {
    const v = f[k];
    if (v) p.set(k, v);
  }
  if (extra.sections?.length && extra.sections.length < REPORT_SECTIONS.length) p.set("sections", extra.sections.join(","));
  if (extra.savedId) p.set("report", extra.savedId);
  return p.toString();
}

export const SOURCE_OPTIONS: Array<{ value: CreatedVia; label: string }> = CREATED_VIA.map((v) => ({ value: v, label: CREATED_VIA_LABELS[v] }));

/** The `report` column of a saved definition: one section's key, or "overview" for several. */
export function reportKind(sections: ReportSection[]): string {
  return sections.length === 1 ? sections[0] : "overview";
}
