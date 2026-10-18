// Follow-up sequence rules shared by the Follow-up Sequences screen and the server that saves it. Pure: no I/O, no React, so the preview
// the person sees and the check the server makes are the same code. The schedule itself comes from buildSchedule (src/lib/messaging.ts),
// which the follow-up planner uses too.
import {
  buildSchedule, DEFAULT_FOLLOWUP_TEXT, FOLLOW_UP_PRESETS, nextSendWindow, smsSegments,
  type BusinessHours, type Channel, type CustomFollowUp, type FollowUpPreset,
} from "@/lib/messaging";

/** iAcquire's agency-wide limits (messaging_policy). A workspace can choose a style inside them, never beyond. */
export interface FollowUpLimits {
  maxAttempts: number;
  maxPer30Days: number;
  minHoursBetween: number;
  quietHoursStart: string;
  quietHoursEnd: string;
  whatsappWindowHours: number;
}

export interface FollowUpStyle {
  value: FollowUpPreset;
  label: string;
  description: string;
}

export const FOLLOW_UP_STYLES: FollowUpStyle[] = [
  { value: "off", label: "Off", description: "No automatic follow-ups. People already in a sequence stop." },
  { value: "gentle", label: FOLLOW_UP_PRESETS.gentle.label, description: "At most two follow-ups: day 1 and day 4." },
  { value: "balanced", label: FOLLOW_UP_PRESETS.balanced.label, description: FOLLOW_UP_PRESETS.balanced.description },
  { value: "persistent", label: FOLLOW_UP_PRESETS.persistent.label, description: "Up to five follow-ups: days 1, 2, 4, 7 and 10." },
  { value: "custom", label: "Custom", description: "Your own number of attempts, spacing and channel, inside iAcquire's limits." },
];

export const FOLLOW_UP_PRESET_VALUES: readonly FollowUpPreset[] = ["off", "gentle", "balanced", "persistent", "custom"];
export const isFollowUpPreset = (v: unknown): v is FollowUpPreset => typeof v === "string" && (FOLLOW_UP_PRESET_VALUES as readonly string[]).includes(v);

export const CUSTOM_CHANNELS: ReadonlyArray<CustomFollowUp["channel"]> = ["same", "sms", "whatsapp", "email"];
export const MAX_GAP_DAYS = 30;
/** How many different gaps a custom sequence can list; the last one repeats for later attempts. */
export const MAX_GAPS = 10;

/** The most attempts a custom sequence may have: the agency's per-sequence maximum and its 30-day allowance, whichever is lower. */
export function maxCustomAttempts(limits: FollowUpLimits): number {
  return Math.max(0, Math.min(10, limits.maxAttempts, limits.maxPer30Days));
}

/** The shortest gap, in whole days, that keeps the agency's minimum time between two follow-ups. */
export function minGapDays(limits: FollowUpLimits): number {
  return Math.max(1, Math.ceil(limits.minHoursBetween / 24));
}

/**
 * Whether two custom sequences are the same, field by field. The saved one comes back from the database's JSON with its keys in another
 * order and may list fewer gaps than attempts (the last gap repeats), so comparing serialized text would always say "changed".
 */
export function sameCustomFollowUp(a: CustomFollowUp | null | undefined, b: CustomFollowUp | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  const gaps = (c: CustomFollowUp) => Array.from({ length: Math.max(1, c.attempts || 1) }, (_, i) => c.daysBetween[Math.min(i, c.daysBetween.length - 1)]);
  return a.attempts === b.attempts && a.channel === b.channel && a.businessHoursOnly === b.businessHoursOnly && gaps(a).join(",") === gaps(b).join(",");
}

/** Everything wrong with a custom sequence, in words a person can act on. Empty means it can be saved. */
export function customFollowUpIssues(c: Partial<CustomFollowUp> | null | undefined, limits: FollowUpLimits): string[] {
  const issues: string[] = [];
  const max = maxCustomAttempts(limits);
  const minGap = minGapDays(limits);
  if (!c) return ["Set up the custom sequence first."];
  if (max < 1) issues.push("iAcquire's limits don't allow any follow-ups at the moment.");
  else if (!Number.isInteger(c.attempts) || (c.attempts as number) < 1 || (c.attempts as number) > max) issues.push(`Choose between 1 and ${max} follow-ups.`);
  const gaps = Array.isArray(c.daysBetween) ? c.daysBetween : [];
  if (!gaps.length) issues.push("Add how many days to wait before each follow-up.");
  else if (gaps.length > MAX_GAPS) issues.push(`List at most ${MAX_GAPS} gaps; the last one repeats.`);
  else if (gaps.some((d) => !Number.isInteger(d) || d < minGap || d > MAX_GAP_DAYS)) {
    issues.push(minGap > 1 ? `Each gap must be a whole number of days from ${minGap} to ${MAX_GAP_DAYS} (follow-ups are at least ${limits.minHoursBetween} hours apart).` : `Each gap must be a whole number of days from 1 to ${MAX_GAP_DAYS}.`);
  }
  if (!CUSTOM_CHANNELS.includes(c.channel as CustomFollowUp["channel"])) issues.push("Choose a channel.");
  if (typeof c.businessHoursOnly !== "boolean") issues.push("Choose whether follow-ups wait for business hours.");
  return issues;
}

/** The days (after the last message the customer received) on which each follow-up falls due, inside every limit. */
export function effectiveDays(preset: FollowUpPreset, custom: CustomFollowUp | null, limits: FollowUpLimits): number[] {
  const schedule = buildSchedule(preset, custom, limits.maxAttempts);
  if (!schedule) return [];
  // The 30-day allowance is per person across every channel, so a sequence never plans more than it allows.
  return schedule.days.slice(0, Math.max(0, limits.maxPer30Days));
}

export interface PreviewStep {
  step: number;
  day: number;
  /** When the follow-up falls due. */
  dueAt: string;
  /** The first moment it may go out: after quiet hours and, when required, inside business hours. */
  sendAt: string;
  /** Whether quiet hours or business hours hold it back from the moment it falls due. */
  held: boolean;
}

/**
 * The schedule a customer would get if they stopped replying at `start`, with each step moved to the first time the rules allow
 * (quiet hours, and business hours when the sequence waits for them). Uses the workspace's time zone for both.
 */
export function previewSchedule(input: {
  preset: FollowUpPreset;
  custom: CustomFollowUp | null;
  limits: FollowUpLimits;
  start: Date;
  timeZone: string;
  businessHours: BusinessHours | null;
}): { steps: PreviewStep[]; channel: Channel | "same"; businessHoursOnly: boolean } {
  const schedule = buildSchedule(input.preset, input.custom, input.limits.maxAttempts);
  if (!schedule) return { steps: [], channel: "same", businessHoursOnly: true };
  const days = effectiveDays(input.preset, input.custom, input.limits);
  const steps = days.map((day, i) => {
    const due = new Date(input.start.getTime() + day * 86_400_000);
    const send = nextSendWindow({ from: due, timeZone: input.timeZone, quietStart: input.limits.quietHoursStart, quietEnd: input.limits.quietHoursEnd, businessHours: input.businessHours, businessHoursOnly: schedule.businessHoursOnly });
    return { step: i + 1, day, dueAt: due.toISOString(), sendAt: send.toISOString(), held: send.getTime() - due.getTime() > 15 * 60_000 };
  });
  return { steps, channel: schedule.channel, businessHoursOnly: schedule.businessHoursOnly };
}

/** Billable units for each follow-up of a sequence on a channel: SMS segments of the standard follow-up text, otherwise one message. */
export function followUpUnits(channel: Channel, businessName: string, steps: number): number[] {
  return Array.from({ length: steps }, (_, i) => (channel === "sms" ? Math.max(1, smsSegments(DEFAULT_FOLLOWUP_TEXT(businessName || "our team", i + 1))) : 1));
}

/**
 * What a full sequence would cost one person on a channel, in micro-dollars of service credit, from the rate iAcquire published for that
 * channel's provider. Null when no rate is published: no price is ever assumed.
 */
export function estimateSequenceMicros(clientMicrosPerUnit: number | null, channel: Channel, businessName: string, steps: number): number | null {
  if (clientMicrosPerUnit === null || !Number.isFinite(clientMicrosPerUnit)) return null;
  return followUpUnits(channel, businessName, steps).reduce((sum, units) => sum + Math.ceil(clientMicrosPerUnit * units), 0);
}
