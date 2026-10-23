// The batch form's state and what it sends. Pure, so the same rules are tested without a browser: the form can only build the six keys criteria may have (a completed service,
// a window, and where it happened), and only the narrowing that fits the chosen service.
import { BATCH_SOURCES, type BatchCriteria, type BatchSource } from "@/lib/reputation/ask-criteria";
import { DEFAULT_RATE_PER_MINUTE, MAX_RATE_PER_MINUTE } from "@/lib/reputation/batches";
import type { FeedbackScale, RequestKind } from "@/lib/reputation/scores";

export interface BatchDraft {
  name: string;
  templateId: string;
  kind: RequestKind;
  scale: FeedbackScale;
  source: BatchSource;
  from: string;
  to: string;
  calendarIds: string[];
  appointmentTypeIds: string[];
  pipelineId: string;
  rate: number;
}

/** The paces offered. (The service accepts any whole number from 1 to the maximum; these are the ones worth choosing between.) */
export const RATE_CHOICES = [5, 10, 20, 30, MAX_RATE_PER_MINUTE] as const;

const pad = (n: number) => String(n).padStart(2, "0");
const dayString = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

/** A new batch: the last 30 days up to today, the standard pace, nothing narrowed. `today` is the workspace's own date (YYYY-MM-DD). */
export function emptyDraft(today: string): BatchDraft {
  const end = new Date(`${today}T00:00:00Z`);
  const start = new Date(end.getTime() - 29 * 86_400_000);
  return { name: "", templateId: "", kind: "review", scale: "csat5", source: "appointments_showed", from: dayString(start), to: today, calendarIds: [], appointmentTypeIds: [], pipelineId: "", rate: DEFAULT_RATE_PER_MINUTE };
}

export function draftFromBatch(b: { name: string; template: { id: string } | null; kind: RequestKind; scale: FeedbackScale; criteria: BatchCriteria | null; ratePerMinute: number }, today: string): BatchDraft {
  const base = emptyDraft(today);
  const c = b.criteria;
  return {
    ...base, name: b.name, templateId: b.template?.id ?? "", kind: b.kind, scale: b.scale, rate: b.ratePerMinute,
    ...(c ? { source: c.source, from: c.from, to: c.to, calendarIds: c.calendarIds ?? [], appointmentTypeIds: c.appointmentTypeIds ?? [], pipelineId: c.pipelineId ?? "" } : {}),
  };
}

/** Exactly what is sent for the criteria: the service and the window, plus only the narrowing that belongs to that service. */
export function criteriaFromDraft(d: BatchDraft): Record<string, unknown> {
  const c: Record<string, unknown> = { source: d.source, from: d.from, to: d.to };
  if (d.source === "appointments_showed") {
    if (d.calendarIds.length) c.calendarIds = d.calendarIds;
    if (d.appointmentTypeIds.length) c.appointmentTypeIds = d.appointmentTypeIds;
  }
  if (d.source === "deals_won" && d.pipelineId) c.pipelineId = d.pipelineId;
  return c;
}

export function inputFromDraft(d: BatchDraft): { name: string; templateId: string; kind: RequestKind; scale?: FeedbackScale; criteria: Record<string, unknown>; ratePerMinute: number } {
  return { name: d.name.trim(), templateId: d.templateId, kind: d.kind, ...(d.kind === "survey" ? { scale: d.scale } : {}), criteria: criteriaFromDraft(d), ratePerMinute: d.rate };
}

/** What is missing before the form can be saved, in the order it appears, or null. (The service checks everything again.) */
export function draftProblem(d: BatchDraft): string | null {
  if (!d.name.trim()) return "Give the batch a name.";
  if (!d.templateId) return "Choose a message template.";
  if (!(BATCH_SOURCES as readonly string[]).includes(d.source)) return "Choose which completed service this batch is for.";
  if (!d.from || !d.to) return "Choose the first and last day.";
  if (d.from > d.to) return "The last day can't be before the first day.";
  return null;
}
