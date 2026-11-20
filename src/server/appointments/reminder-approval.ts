import "server-only";
import type { Queryable } from "@/server/db";
import { partnerFirstAgentSql } from "@/server/workforce/partner-runtime";

const REMINDER_EFFECT = /^reminder:([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}):([1-9][0-9]{0,4}):([0-9]{1,15})$/i;

/** A standing reminder grant covers only this scheduled occurrence and its persisted message. */
export async function reminderMessageApproved(db: Queryable, input: {
  effectKey: string;
  orgId: string;
  contactId: string;
  agentId: string | null;
  approvalId: string | null;
  purpose?: "service" | "marketing";
  dispatchMessageId?: string;
  now: Date;
}): Promise<boolean> {
  const effect = REMINDER_EFFECT.exec(input.effectKey);
  if (!effect || !input.agentId || !input.approvalId || input.purpose !== "service") return false;

  const [, appointmentId, offset, dueMillis] = effect;
  const { rows } = await db.query(
    `select 1
       from appointment_reminders r
       join appointment_refs a on a.id = r.appointment_id and a.org_id = r.org_id
       join appointment_settings p on p.org_id = r.org_id
       join approval_requests approval on approval.id = p.reminders_approval_id and approval.org_id = p.org_id
      where r.appointment_id = $1 and r.org_id = $2 and a.contact_id = $3
        and r.offset_minutes = $6 and r.offset_minutes = any(p.reminder_offsets_minutes)
        and r.status = 'queued' and r.message_id is not distinct from $9::uuid
        and r.due_at = $7 and r.due_at <= $8
        and r.due_at = date_trunc('milliseconds', a.start_at) - make_interval(mins => r.offset_minutes)
        and a.start_at > $8 and a.status in ('new', 'confirmed') and not (a.provider = 'native' and a.status = 'new')
        and (${partnerFirstAgentSql("r.org_id", "appointment_setter")}) = $5
        and p.reminders_enabled and approval.id = $4 and approval.status = 'approved'
        and approval.kind = 'standing_authorization' and approval.target_type = 'standing_authorization'
        and approval.target_id = 'appointment_reminders' and approval.action->>'scope' = approval.target_id
        and (approval.expires_at is null or approval.expires_at > $8)`,
    [appointmentId, input.orgId, input.contactId, input.approvalId, input.agentId, Number(offset), new Date(Number(dueMillis)).toISOString(), input.now.toISOString(), input.dispatchMessageId ?? null],
  );
  return rows.length > 0;
}
