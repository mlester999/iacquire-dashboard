import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { isSetupPaymentCleared } from "@/server/billing/clearance";

/**
 * When a client may switch customer-facing activity ON. The five switches below are the places a client makes something reach THEIR customers (a reply, a chat window, a reminder, an AI
 * booking, a public booking page); each calls `assertCustomerFacingAllowed` before it turns the activity on. With the deployment switch CLIENT_CUSTOMER_FACING_GATE_ENABLED off, which
 * is the default, nothing here asks a question or refuses anything, so every switch behaves exactly as it always has.
 *
 * With it on, a CLIENT workspace may switch an activity on only when the setup payment is cleared (paid or waived: the one definition, app.setup_payment_cleared) and, for the
 * activities that need a calendar (reminders, AI booking, the public booking page), when the workspace has an active calendar that passes every activation check. The agency's own
 * workspace and demo workspaces are never held back. Only a switch-ON is judged: switching an activity OFF, and saving anything else, are never refused here, and nothing already
 * queued or sent is touched.
 *
 * Reads only, every query names the workspace, so another workspace's state can never decide this one's answer.
 */

export const CUSTOMER_FACING_ACTIVITIES = ["auto_reply", "webchat_widget", "appointment_reminders", "ai_booking", "public_booking_page"] as const;
export type CustomerFacingActivity = (typeof CUSTOMER_FACING_ACTIVITIES)[number];

/** The activities that need a verified calendar as well as the cleared setup payment. */
export const CALENDAR_DEPENDENT_ACTIVITIES: readonly CustomerFacingActivity[] = ["appointment_reminders", "ai_booking", "public_booking_page"];

const LABEL: Record<CustomerFacingActivity, string> = {
  auto_reply: "Automatic replies",
  webchat_widget: "The website chat",
  appointment_reminders: "Appointment reminders",
  ai_booking: "Letting the AI book appointments",
  public_booking_page: "The public booking page",
};

export interface CustomerFacingDecision {
  allowed: boolean;
  /** Whether the deployment switch is on. With it off the answer is always "allowed" and nothing was read. */
  gateOn: boolean;
  /** Why not, in words a person can act on. It starts "Finish setup first:". Null when allowed. */
  reason: string | null;
  /** What is missing. Null when allowed (and for a workspace that does not exist). */
  missing: "payment" | "calendar" | null;
}

/** Whether the deployment switch is on. A caller that must read the current state to see whether a switch really goes OFF to ON asks first, so with the switch off it reads nothing extra. */
export const customerFacingGateOn = (): boolean => env().CLIENT_CUSTOMER_FACING_GATE_ENABLED;

const ALLOWED_OFF: CustomerFacingDecision = { allowed: true, gateOn: false, reason: null, missing: null };
const allowed = (): CustomerFacingDecision => ({ allowed: true, gateOn: true, reason: null, missing: null });

/**
 * Why no calendar could take a customer yet, or null when one can. With `calendarId` it is that calendar (the public booking page is one calendar's page); without, it is whether the
 * workspace has any active calendar that passes every activation check. Loaded when needed: activation.ts imports the calendar setup module, which imports this one.
 */
async function calendarProblem(db: Queryable, orgId: string, calendarId?: string): Promise<string | null> {
  const { verifyCalendarInTx } = await import("@/server/calendars/activation");
  if (calendarId) {
    const v = await verifyCalendarInTx(db, orgId, calendarId);
    if (v.status !== "active") return `${v.calendarName} is still a draft. Check and activate it first.`;
    const failed = v.checks.find((c) => !c.ok);
    return failed ? `${v.calendarName} has not passed its checks yet: ${failed.detail}` : null;
  }
  const { rows } = await db.query<{ id: string }>("select id from crm_calendars where org_id = $1 and archived_at is null and status = 'active' order by is_default desc, created_at", [orgId]);
  if (!rows.length) return "There is no active calendar yet. Create one, give it a host with working hours and an appointment type, and let it pass its checks.";
  let first: string | null = null;
  for (const row of rows) {
    const v = await verifyCalendarInTx(db, orgId, row.id);
    if (v.ok) return null;
    first ??= `${v.calendarName} has not passed its checks yet: ${v.checks.find((c) => !c.ok)?.detail ?? "a check failed"}`;
  }
  return first;
}

/** The answer without a refusal, for a screen or a control that wants to say why a switch is held. Never throws for a workspace that is simply not ready. */
export async function customerFacingAllowed(db: Queryable, orgId: string, activity: CustomerFacingActivity, opts: { calendarId?: string } = {}): Promise<CustomerFacingDecision> {
  if (!env().CLIENT_CUSTOMER_FACING_GATE_ENABLED) return ALLOWED_OFF;
  const org = (await db.query<{ kind: string; is_demo: boolean }>("select kind, is_demo from organizations where id = $1", [orgId])).rows[0];
  if (!org) return { allowed: false, gateOn: true, reason: "This workspace was not found.", missing: null };
  // The agency's own workspace and demo workspaces are never held back.
  if (org.kind !== "client" || org.is_demo) return allowed();
  if (!(await isSetupPaymentCleared(db, orgId))) {
    return { allowed: false, gateOn: true, missing: "payment", reason: `Finish setup first: your setup payment has not been confirmed yet. ${LABEL[activity]} can be switched on once it is.` };
  }
  if (CALENDAR_DEPENDENT_ACTIVITIES.includes(activity)) {
    const problem = await calendarProblem(db, orgId, activity === "public_booking_page" ? opts.calendarId : undefined);
    if (problem) return { allowed: false, gateOn: true, missing: "calendar", reason: `Finish setup first: ${LABEL[activity]} needs a working calendar. ${problem}` };
  }
  return allowed();
}

/** Refuses a switch-ON with the reason, and writes nothing. Call it inside the transaction that would turn the activity on, only for a real OFF to ON change. */
export async function assertCustomerFacingAllowed(db: Queryable, orgId: string, activity: CustomerFacingActivity, opts: { calendarId?: string } = {}): Promise<void> {
  const decision = await customerFacingAllowed(db, orgId, activity, opts);
  if (!decision.allowed) throw new AppError("conflict", decision.reason ?? "Finish setup first.");
}
