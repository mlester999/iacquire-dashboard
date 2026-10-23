import { addDays, isValidTimeZone, zonedToInstant } from "@/lib/calendars/slots";

// When invoice reminders would go out, for an invoice with a due date. Pure. Reminders are off until the owner authorizes the exact wording (src/server/invoices),
// and every one still passes the consent-gated send chain; this only says WHEN.

/** Three days before, on the day, three and ten days after. The owner can change it; nothing here is a legal requirement. */
export const DEFAULT_REMINDER_OFFSETS: readonly number[] = [-3, 0, 3, 10];
export const DEFAULT_REMINDER_MAX = 4;
export const MIN_OFFSET_DAYS = -30;
export const MAX_OFFSET_DAYS = 60;
/** Local hour of day a reminder is due: a morning message, not one in the middle of the night. */
export const REMINDER_HOUR = 9;

export function offsetsProblem(offsets: readonly number[], max: number): string | null {
  if (offsets.length > 8) return "Choose at most eight reminder days.";
  for (const o of offsets) if (!Number.isInteger(o) || o < MIN_OFFSET_DAYS || o > MAX_OFFSET_DAYS) return `Reminder days run from ${-MIN_OFFSET_DAYS} days before the due date to ${MAX_OFFSET_DAYS} days after.`;
  if (new Set(offsets).size !== offsets.length) return "Each reminder day can be chosen once.";
  if (offsets.length > max) return `You chose ${offsets.length} reminder days but allow at most ${max} reminders per invoice.`;
  return null;
}

/** The key one reminder of an invoice is stored under: before_due:-3, on_due:0, after_due:3. */
export const stepKeyFor = (offsetDays: number) => `${offsetDays < 0 ? "before_due" : offsetDays === 0 ? "on_due" : "after_due"}:${offsetDays}`;

export function stepLabel(offsetDays: number): string {
  if (offsetDays < 0) return `${-offsetDays} day${offsetDays === -1 ? "" : "s"} before the due date`;
  if (offsetDays === 0) return "On the due date";
  return `${offsetDays} day${offsetDays === 1 ? "" : "s"} after the due date`;
}

export interface ReminderStep {
  stepKey: string;
  offsetDays: number;
  dueAt: Date;
  /** Already in the past when the schedule was made (an invoice issued two days before its due date has no "three days before"). Stored as skipped, not sent late. */
  past: boolean;
}

/** The reminders for a due date: sorted by day, no more than `max`, each at 9:00 in the workspace's time zone. */
export function reminderSchedule(input: { dueOn: string; offsets: readonly number[]; max: number; tz: string; now: Date }): ReminderStep[] {
  const tz = isValidTimeZone(input.tz) ? input.tz : "UTC";
  const days = [...new Set(input.offsets)].filter((o) => Number.isInteger(o) && o >= MIN_OFFSET_DAYS && o <= MAX_OFFSET_DAYS).sort((a, b) => a - b).slice(0, Math.max(input.max, 0));
  return days.map((offsetDays) => {
    const dueAt = new Date(zonedToInstant(addDays(input.dueOn, offsetDays), REMINDER_HOUR * 60, tz));
    return { stepKey: stepKeyFor(offsetDays), offsetDays, dueAt, past: dueAt.getTime() <= input.now.getTime() };
  });
}
