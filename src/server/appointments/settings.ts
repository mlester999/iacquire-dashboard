import "server-only";
import { z } from "zod";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { createStandingAuthorization } from "@/server/approvals/service";
import { loadPolicy, type AppointmentPolicy } from "@/server/appointments/availability";
import { resyncAllReminders } from "@/server/appointments/reminders";
import type { OrgContext } from "@/server/tenancy/context";

export const policySchema = z.object({
  defaultCalendarId: z.string().trim().max(80).nullable().optional(),
  slotMinutes: z.number().int().min(5).max(480).optional(),
  minNoticeMinutes: z.number().int().min(0).max(20160).optional(),
  maxDaysAhead: z.number().int().min(1).max(31).optional(),
  lateCancelHours: z.number().int().min(0).max(168).nullable().optional(),
  aiBookingEnabled: z.boolean().optional(),
  remindersEnabled: z.boolean().optional(),
  reminderOffsetsMinutes: z.array(z.number().int().min(15).max(20160)).max(3).optional(),
});

export interface PolicyView extends AppointmentPolicy {
  calendars: string[];
  remindersAuthorization: "none" | "active" | "expired";
  remindersAuthorizedUntil: string | null;
}

export async function getPolicyView(ctx: OrgContext): Promise<PolicyView> {
  const { policy, auth, until } = await withUser(ctx.user.id, async (db) => {
    const policy = await loadPolicy(db, ctx.org.orgId);
    let auth: PolicyView["remindersAuthorization"] = "none";
    let until: string | null = null;
    if (policy.remindersApprovalId) {
      const a = await db.query<{ status: string; expires_at: Date | null }>("select status, expires_at from approval_requests where id = $1 and org_id = $2", [policy.remindersApprovalId, ctx.org.orgId]);
      const row = a.rows[0];
      if (row) {
        const live = row.status === "approved" && (!row.expires_at || new Date(row.expires_at) > new Date());
        auth = live ? "active" : "expired";
        until = row.expires_at ? new Date(row.expires_at).toISOString() : null;
      }
    }
    return { policy, auth, until };
  });
  // The CRM mapping holds credential references, so the application role cannot read it; the server reads the calendar ids on the viewer's behalf.
  const map = await withSystem((db) => db.query<{ calendar_ids: string[] }>("select calendar_ids from ghl_location_mappings where org_id = $1", [ctx.org.orgId]));
  return { ...policy, calendars: map.rows[0]?.calendar_ids ?? [], remindersAuthorization: auth, remindersAuthorizedUntil: until };
}

/**
 * Saves the workspace's booking rules. Letting the AI book on its own is the owner's decision (it is a step toward autonomy), and
 * switching reminders on records the owner's standing authorization, which expires and is checked every time one is sent. The clock is an argument so a test can
 * replay a policy change at a fixed moment; production omits it.
 */
export async function savePolicy(ctx: OrgContext, input: z.input<typeof policySchema>, now = new Date()): Promise<void> {
  if (!ctx.can("appointments.manage")) throw new AppError("forbidden", "Only owners and managers can change booking rules.");
  const p = policySchema.parse(input);
  if (p.aiBookingEnabled !== undefined && !ctx.can("automation.go_autonomous")) throw new AppError("forbidden", "Only the business owner can let the Appointment Setter book on its own.");
  const offsets = p.reminderOffsetsMinutes ? [...new Set(p.reminderOffsetsMinutes)].sort((a, b) => b - a) : undefined;

  const resync = await withSystem(async (db) => {
    const current = await loadPolicy(db, ctx.org.orgId);
    const map = await db.query<{ calendar_ids: string[] }>("select calendar_ids from ghl_location_mappings where org_id = $1 and status <> 'disabled'", [ctx.org.orgId]);
    const calendars = map.rows[0]?.calendar_ids ?? [];
    if (p.defaultCalendarId && !calendars.includes(p.defaultCalendarId)) throw new AppError("invalid_input", "Choose one of the calendars connected to your workspace.");
    const next: AppointmentPolicy = {
      ...current,
      ...(p.defaultCalendarId !== undefined ? { defaultCalendarId: p.defaultCalendarId } : {}),
      ...(p.slotMinutes !== undefined ? { slotMinutes: p.slotMinutes } : {}),
      ...(p.minNoticeMinutes !== undefined ? { minNoticeMinutes: p.minNoticeMinutes } : {}),
      ...(p.maxDaysAhead !== undefined ? { maxDaysAhead: p.maxDaysAhead } : {}),
      ...(p.lateCancelHours !== undefined ? { lateCancelHours: p.lateCancelHours } : {}),
      ...(p.aiBookingEnabled !== undefined ? { aiBookingEnabled: p.aiBookingEnabled } : {}),
      ...(p.remindersEnabled !== undefined ? { remindersEnabled: p.remindersEnabled } : {}),
      ...(offsets ? { reminderOffsetsMinutes: offsets } : {}),
    };
    let approvalId = current.remindersApprovalId;
    if (next.remindersEnabled && !current.remindersEnabled) {
      approvalId = await createStandingAuthorization(db, {
        orgId: ctx.org.orgId, userId: ctx.user.id, scopeKey: "appointment_reminders", days: 90,
        title: "Send appointment reminders to customers",
        reason: "The owner switched on automatic appointment reminders.",
        expectedEffect: "Customers with an upcoming appointment get a short reminder at the times you chose, only where they have not opted out and outside quiet hours.",
      });
    }
    await db.query(
      `insert into appointment_settings (org_id, default_calendar_id, slot_minutes, min_notice_minutes, max_days_ahead, late_cancel_hours, ai_booking_enabled, reminders_enabled, reminder_offsets_minutes, reminders_approval_id, updated_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       on conflict (org_id) do update set default_calendar_id = excluded.default_calendar_id, slot_minutes = excluded.slot_minutes, min_notice_minutes = excluded.min_notice_minutes,
         max_days_ahead = excluded.max_days_ahead, late_cancel_hours = excluded.late_cancel_hours, ai_booking_enabled = excluded.ai_booking_enabled, reminders_enabled = excluded.reminders_enabled,
         reminder_offsets_minutes = excluded.reminder_offsets_minutes, reminders_approval_id = excluded.reminders_approval_id, updated_by = excluded.updated_by`,
      [ctx.org.orgId, next.defaultCalendarId, next.slotMinutes, next.minNoticeMinutes, next.maxDaysAhead, next.lateCancelHours, next.aiBookingEnabled, next.remindersEnabled, next.reminderOffsetsMinutes, approvalId, ctx.user.id],
    );
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "appointments.policy_changed", targetType: "appointment_settings", targetId: ctx.org.orgId, result: "success",
      metadata: { aiBooking: next.aiBookingEnabled, reminders: next.remindersEnabled, offsets: next.reminderOffsetsMinutes } }, db);
    return p.remindersEnabled !== undefined || offsets !== undefined;
  });
  if (resync) await resyncAllReminders(ctx.org.orgId, now);
}

/**
 * Renews the reminder authorization before it lapses. Without it, an employee that normally asks first holds reminders back
 * instead of sending them.
 */
export async function renewRemindersAuthorization(ctx: OrgContext): Promise<void> {
  if (!ctx.can("appointments.manage")) throw new AppError("forbidden", "Only owners and managers can do this.");
  await withSystem(async (db) => {
    const policy = await loadPolicy(db, ctx.org.orgId);
    if (!policy.remindersEnabled) throw new AppError("conflict", "Reminders are switched off.");
    const id = await createStandingAuthorization(db, {
      orgId: ctx.org.orgId, userId: ctx.user.id, scopeKey: "appointment_reminders", days: 90, title: "Send appointment reminders to customers",
      reason: "The owner renewed automatic appointment reminders.", expectedEffect: "Customers with an upcoming appointment keep getting reminders at the times you chose.",
    });
    await db.query("update appointment_settings set reminders_approval_id = $2, updated_by = $3 where org_id = $1", [ctx.org.orgId, id, ctx.user.id]);
  });
}
