import { BLOCK_REASON_LABELS } from "@/lib/messaging";
import { reminderSchedule, type ReminderStep } from "@/lib/invoices/reminders";
import { REMINDER_AUTHORIZATION_DAYS } from "@/lib/invoices/reminder-text";
import type { InvoicePaymentStatus, InvoiceStatus } from "@/lib/invoices/state";

// When a reminder may be sent, and when it must not be. Pure: src/server/invoices/reminders.ts reads the facts, asks here, and does what the answer says.
//
// Only the owner's authorization, the state of the invoice, the state of the workspace and the send chain's own rules (consent, opt-outs, quiet hours, credits) decide.
// Money arriving, a void or a write-off stops every reminder that has not gone out yet, and nothing is ever sent late: a reminder that missed its day by more than a
// day is skipped, not sent.

export type ReminderRowStatus = "scheduled" | "queued" | "blocked" | "skipped" | "cancelled";

/** A reminder that missed its time by more than this is skipped. It is a proposal, not an approved policy. */
export const LATE_GRACE_HOURS = 24;

export type AuthorizationProblem = "reminders_off" | "never_authorized" | "wording_changed" | "expired" | "authorizer_gone";

export const AUTHORIZATION_PROBLEM_TEXT: Record<AuthorizationProblem, string> = {
  reminders_off: "Reminders are switched off.",
  never_authorized: "The owner has not authorized the reminders yet.",
  wording_changed: "The wording, the days, the channels or the most reminders per invoice changed since the owner authorized them.",
  expired: `The owner's authorization is older than ${REMINDER_AUTHORIZATION_DAYS} days and needs to be given again.`,
  authorizer_gone: "The person who authorized the reminders is no longer an owner of this workspace.",
};

export interface AuthorizationFacts {
  enabled: boolean;
  authorizedAt: Date | null;
  /** The fingerprint stored when the owner authorized (customer_invoice_settings.reminders_body_hash). */
  storedHash: string | null;
  /** The fingerprint of what the product would send now. */
  currentHash: string;
  /** The person who authorized still holds the owner's permission in this workspace. */
  authorizerIsOwner: boolean;
  now: Date;
}

export function authorizationProblem(f: AuthorizationFacts): AuthorizationProblem | null {
  if (!f.enabled) return "reminders_off";
  if (!f.authorizedAt || !f.storedHash) return "never_authorized";
  if (f.storedHash !== f.currentHash) return "wording_changed";
  if (f.now.getTime() - f.authorizedAt.getTime() > REMINDER_AUTHORIZATION_DAYS * 86_400_000) return "expired";
  if (!f.authorizerIsOwner) return "authorizer_gone";
  return null;
}

/** Why a reminder did not go, in words a business owner reads. The send chain's own reasons keep the wording the inbox uses for them. */
export const REMINDER_REASON_TEXT: Record<string, string> = {
  ...BLOCK_REASON_LABELS,
  invoicing_off: "Customer invoices are switched off for this workspace.",
  invoice_not_issued: "The invoice is not issued.",
  invoice_voided: "The invoice was voided.",
  paid: "The invoice was paid.",
  written_off: "The invoice was written off.",
  disputed: "The customer disputed a payment on this invoice.",
  nothing_owed: "Nothing is owed on the invoice.",
  reminders_off: "Reminders were switched off.",
  schedule_changed: "The reminder days changed.",
  no_customer: "The invoice has no customer to remind.",
  held_by_person: "A person on your team excluded this customer from automatic messages.",
  no_due_date: "The invoice has no due date.",
  too_late: `It missed its time by more than ${LATE_GRACE_HOURS} hours, so it was not sent late.`,
  cap_reached: "The most reminders allowed for one invoice were already sent.",
  already_past: "The invoice was issued after this reminder's time.",
  authorization_needed: "Waiting for the owner to authorize the reminders again.",
  automation_paused: "Automatic messages are paused for this workspace.",
  invoice_changed: "The invoice changed before the reminder was sent.",
  invoice_link_unavailable: "The invoice can no longer be paid online, so the reminder was not sent.",
  no_channel_allowed: "No channel is allowed for reminders.",
};

export const reminderReasonText = (code: string | null | undefined): string => (code ? REMINDER_REASON_TEXT[code] ?? "It could not be sent." : "");

export interface InvoiceFacts {
  status: InvoiceStatus;
  paymentStatus: InvoicePaymentStatus;
  writtenOff: boolean;
  balanceMinor: number;
  dueOn: string | null;
  hasCustomer: boolean;
}

/** Why no further reminder should ever be made for the invoice, or null when it still owes and can be reminded about. */
export function invoiceStopReason(i: InvoiceFacts): "invoice_not_issued" | "invoice_voided" | "paid" | "written_off" | "disputed" | "nothing_owed" | "no_customer" | "no_due_date" | null {
  if (i.status === "void") return "invoice_voided";
  if (i.status !== "issued") return "invoice_not_issued";
  if (i.writtenOff) return "written_off";
  if (i.paymentStatus === "paid") return "paid";
  if (i.paymentStatus === "disputed") return "disputed";
  if (i.balanceMinor <= 0) return "nothing_owed";
  if (!i.hasCustomer) return "no_customer";
  if (!i.dueOn) return "no_due_date";
  return null;
}

export interface DecisionFacts {
  now: Date;
  /** When this reminder was due. */
  dueAt: Date;
  invoice: InvoiceFacts;
  invoicingEnabled: boolean;
  remindersEnabled: boolean;
  /** The step is still one of the days the workspace's settings call for. */
  stepStillPlanned: boolean;
  /** A person on the team excluded this customer from automatic messages (for example during a dispute). Nothing automatic is sent to them while that stands. */
  customerHeld: boolean;
  authorization: AuthorizationProblem | null;
  workspaceRunnable: boolean;
  /** Reminders of this invoice already handed to the send chain (not counting this one). */
  alreadyQueued: number;
  max: number;
}

export type ReminderDecision =
  | { action: "send" }
  /** Nothing is wrong with the reminder itself: a pause or a lapsed authorization holds it back, and it goes out if that ends in time. */
  | { action: "wait"; reason: "authorization_needed" | "automation_paused" }
  /** The reminder will never be sent. cancel: the world made it pointless. skip: it was due but is not wanted now. */
  | { action: "cancel" | "skip"; reason: string };

export function decideReminder(f: DecisionFacts): ReminderDecision {
  if (!f.invoicingEnabled) return { action: "cancel", reason: "invoicing_off" };
  const stop = invoiceStopReason(f.invoice);
  if (stop === "disputed") return { action: "skip", reason: stop };
  if (stop) return { action: "cancel", reason: stop };
  if (!f.remindersEnabled) return { action: "cancel", reason: "reminders_off" };
  if (!f.stepStillPlanned) return { action: "cancel", reason: "schedule_changed" };
  if (f.customerHeld) return { action: "skip", reason: "held_by_person" };
  if (f.now.getTime() - f.dueAt.getTime() > LATE_GRACE_HOURS * 3_600_000) return { action: "skip", reason: "too_late" };
  if (f.alreadyQueued >= f.max) return { action: "skip", reason: "cap_reached" };
  if (f.authorization) return { action: "wait", reason: "authorization_needed" };
  if (!f.workspaceRunnable) return { action: "wait", reason: "automation_paused" };
  return { action: "send" };
}

// ---------------------------------------------------------------------------
// Planning the reminder rows of one invoice
// ---------------------------------------------------------------------------

export interface ExistingReminder {
  stepKey: string;
  status: ReminderRowStatus;
  /** Why it has its outcome, when it has one. */
  reason?: string | null;
}

export type PlanOp =
  | { op: "insert"; stepKey: string; dueAt: Date; status: "scheduled" | "skipped"; reason: string | null }
  | { op: "cancel"; stepKey: string; reason: string }
  /** A reminder cancelled only because reminders were off or the days changed, for a day that is wanted again and not more than the grace period behind. */
  | { op: "reopen"; stepKey: string; dueAt: Date };

/** Cancellations that the owner's own choice caused and a later choice can undo. A payment, a void or a write-off is final. */
const REOPENABLE = new Set(["reminders_off", "schedule_changed"]);

export interface PlanInput {
  remindersEnabled: boolean;
  offsetsDays: readonly number[];
  max: number;
  tz: string;
  now: Date;
  invoice: InvoiceFacts;
  existing: readonly ExistingReminder[];
}

/**
 * What to do to an invoice's reminder rows so they match the invoice and the workspace's settings. An invoice that can no longer be reminded about, or a workspace with
 * reminders off, loses its scheduled reminders. Otherwise every planned day has a row: one already past when the plan is made is stored as skipped (never sent late), the
 * others as scheduled; a scheduled row for a day that is no longer planned is cancelled. A row that already has an outcome is never touched. Applying the plan twice does nothing.
 */
export function planReminders(p: PlanInput): PlanOp[] {
  const ops: PlanOp[] = [];
  const stop = invoiceStopReason(p.invoice);
  const scheduled = p.existing.filter((e) => e.status === "scheduled");
  if (stop || !p.remindersEnabled || !p.invoice.dueOn) {
    const reason = stop ?? (p.remindersEnabled ? "no_due_date" : "reminders_off");
    return scheduled.map((e) => ({ op: "cancel", stepKey: e.stepKey, reason }));
  }
  const steps: ReminderStep[] = reminderSchedule({ dueOn: p.invoice.dueOn, offsets: p.offsetsDays, max: p.max, tz: p.tz, now: p.now });
  const wanted = new Set(steps.map((s) => s.stepKey));
  const have = new Map(p.existing.map((e) => [e.stepKey, e]));
  for (const e of scheduled) if (!wanted.has(e.stepKey)) ops.push({ op: "cancel", stepKey: e.stepKey, reason: "schedule_changed" });
  for (const s of steps) {
    const e = have.get(s.stepKey);
    if (e) {
      // Reopened while it is still ahead or no more than the grace period behind (a reminder held back is sent that late and no later); otherwise it stays cancelled.
      if (e.status === "cancelled" && REOPENABLE.has(e.reason ?? "") && s.dueAt.getTime() > p.now.getTime() - LATE_GRACE_HOURS * 3_600_000) ops.push({ op: "reopen", stepKey: s.stepKey, dueAt: s.dueAt });
      continue;
    }
    ops.push(s.past ? { op: "insert", stepKey: s.stepKey, dueAt: s.dueAt, status: "skipped", reason: "already_past" } : { op: "insert", stepKey: s.stepKey, dueAt: s.dueAt, status: "scheduled", reason: null });
  }
  return ops;
}
