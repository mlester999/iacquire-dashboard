import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { releaseReservation } from "@/server/billing/ledger";
import { notifyOrgRoles } from "@/server/notifications";
import { queueOutreach } from "@/server/messaging/outreach";
import { formatSlot, reminderSchedule } from "@/lib/appointments";

const LIVE = ["new", "confirmed"];

/**
 * Brings an appointment's reminders in line with the appointment as it is now: created when it is booked, moved when it is
 * rescheduled, and withdrawn when it is cancelled, finished or reminders are off. A reminder already queued for the old time
 * is stopped, so a customer is never told a time that no longer applies.
 */
export async function syncRemindersFor(db: Queryable, orgId: string, appointmentId: string, now = new Date()) {
  const { rows } = await db.query<{ status: string; start_at: Date; contact_id: string | null; reminders_enabled: boolean | null; offsets: number[] | null }>(
    `select a.status, a.start_at, a.contact_id, s.reminders_enabled, s.reminder_offsets_minutes as offsets
     from appointment_refs a left join appointment_settings s on s.org_id = a.org_id where a.id = $1 and a.org_id = $2`,
    [appointmentId, orgId],
  );
  const a = rows[0];
  if (!a) return;
  const upcoming = LIVE.includes(a.status) && new Date(a.start_at).getTime() > now.getTime();
  const wanted = upcoming && a.reminders_enabled && a.contact_id ? reminderSchedule(new Date(a.start_at), a.offsets ?? [], now) : [];
  const keep = new Set(wanted.map((w) => w.offsetMinutes));

  const existing = await db.query<{ id: string; offset_minutes: number; due_at: Date; status: string; message_id: string | null }>(
    "select id, offset_minutes, due_at, status, message_id from appointment_reminders where appointment_id = $1 and org_id = $2 for update",
    [appointmentId, orgId],
  );
  const why = !upcoming ? "The appointment is no longer upcoming." : !a.reminders_enabled ? "Reminders are switched off." : !a.contact_id ? "There is no contact to remind." : "That reminder time was removed.";
  for (const r of existing.rows) {
    if (keep.has(r.offset_minutes) || ["sent", "cancelled", "skipped"].includes(r.status)) continue;
    await stopMessage(db, orgId, r.message_id, "appointment_changed");
    await db.query("update appointment_reminders set status = 'cancelled', reason = $2 where id = $1", [r.id, why]);
  }
  for (const w of wanted) {
    const prior = existing.rows.find((r) => r.offset_minutes === w.offsetMinutes);
    if (prior && new Date(prior.due_at).getTime() !== w.dueAt.getTime()) await stopMessage(db, orgId, prior.message_id, "appointment_changed");
    await db.query(
      `insert into appointment_reminders (org_id, appointment_id, offset_minutes, due_at) values ($1, $2, $3, $4)
       on conflict (appointment_id, offset_minutes) do update set
         status = case when appointment_reminders.due_at is distinct from excluded.due_at or appointment_reminders.status = 'cancelled' then 'scheduled' else appointment_reminders.status end,
         reason = case when appointment_reminders.due_at is distinct from excluded.due_at or appointment_reminders.status = 'cancelled' then null else appointment_reminders.reason end,
         message_id = case when appointment_reminders.due_at is distinct from excluded.due_at then null else appointment_reminders.message_id end,
         due_at = excluded.due_at`,
      [orgId, appointmentId, w.offsetMinutes, w.dueAt.toISOString()],
    );
  }
}

async function stopMessage(db: Queryable, orgId: string, messageId: string | null, reason: string) {
  if (!messageId) return;
  const res = await db.query<{ reservation_id: string | null }>(
    "update conversation_messages set status = 'blocked', blocked_reason = $3, status_detail = 'Stopped before sending.' where id = $1 and org_id = $2 and status in ('draft', 'queued') returning reservation_id",
    [messageId, orgId, reason],
  );
  const hold = res.rows[0]?.reservation_id;
  if (hold) await releaseReservation(db, { orgId, reservationId: hold, reason: `Stopped: ${reason}` });
}

/** Re-plans every upcoming appointment's reminders after the workspace changes its reminder settings. */
export async function resyncAllReminders(orgId: string, now = new Date()): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string }>("select id from appointment_refs where org_id = $1 and start_at > $2 and status in ('new', 'confirmed')", [orgId, now.toISOString()]);
    for (const r of rows) await syncRemindersFor(db, orgId, r.id, now);
    return rows.length;
  });
}

interface Due {
  id: string;
  org_id: string;
  appointment_id: string;
  offset_minutes: number;
  due_at: Date;
  title: string;
  start_at: Date;
  meeting_link: string | null;
  contact_id: string;
  contact_name: string;
  contact_tz: string | null;
  org_tz: string;
  org_name: string;
  approval_id: string | null;
  approval_live: boolean | null;
  agent_id: string | null;
}

/** The AI employee that owns appointment work for a workspace. */
export async function appointmentSetterId(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'appointment_setter'", [orgId]);
  return rows[0]?.id ?? null;
}

export function reminderText(d: { orgName: string; title: string; startAt: Date; timeZone: string; link: string | null; contactName: string }): string {
  const first = d.contactName.trim().split(/\s+/)[0];
  const hello = first ? `Hi ${first}, ` : "";
  return `${hello}a reminder from ${d.orgName}: "${d.title}" is on ${formatSlot(d.startAt.toISOString(), d.timeZone)}.${d.link ? ` Join here: ${d.link}.` : ""} Reply here if you need to change it.`.slice(0, 600);
}

/**
 * Sends reminders that have come due. Each goes through the same gate as every other customer message: consent, opt-outs, quiet
 * hours, the pause switches, a human taking over, the AI employee's mode and the customer's credit balance. A reminder that cannot
 * go is recorded with the reason rather than forced through, and one for an appointment that has since changed is never sent.
 */
export async function sendDueReminders(opts: { now?: Date; limit?: number } = {}): Promise<{ queued: number; blocked: number; reconciled: number }> {
  const now = opts.now ?? new Date();
  const out = { queued: 0, blocked: 0, reconciled: 0 };

  // Settle reminders whose message has since been sent or has failed, and put back any that were claimed by a worker that then died.
  out.reconciled = await withSystem(async (db) => {
    await db.query("update appointment_reminders set status = 'scheduled' where status = 'queued' and message_id is null and updated_at < $1::timestamptz - interval '10 minutes'", [now.toISOString()]);
    const done = await db.query(
      `update appointment_reminders r set status = case when m.status in ('sent', 'delivered', 'read') then 'sent' else 'blocked' end,
         reason = case when m.status in ('sent', 'delivered', 'read') then null else coalesce(m.blocked_reason, 'The message could not be sent.') end
       from conversation_messages m where m.id = r.message_id and r.status = 'queued' and m.status in ('sent', 'delivered', 'read', 'failed', 'blocked')`,
    );
    return done.rowCount;
  });

  const claimed = await withSystem(async (db) => {
    // A reminder is never sent after its appointment has started, or for one that is no longer upcoming.
    await db.query(
      `update appointment_reminders r set status = 'skipped', reason = 'The appointment is no longer upcoming.'
       from appointment_refs a where a.id = r.appointment_id and r.status = 'scheduled' and r.due_at <= $1 and (a.status <> all($2::text[]) or a.start_at <= $1)`,
      [now.toISOString(), LIVE],
    );
    const res = await db.query<Due>(
      `update appointment_reminders set status = 'queued' where id in (
         select r.id from appointment_reminders r where r.status = 'scheduled' and r.due_at <= $1 order by r.due_at limit $2 for update skip locked)
       returning id, org_id, appointment_id, offset_minutes, due_at,
         (select title from appointment_refs where id = appointment_id) as title, (select start_at from appointment_refs where id = appointment_id) as start_at,
         (select meeting_link from appointment_refs where id = appointment_id) as meeting_link, (select contact_id from appointment_refs where id = appointment_id) as contact_id,
         (select display_name from contacts k where k.id = (select contact_id from appointment_refs where id = appointment_id)) as contact_name,
         (select timezone from contacts k where k.id = (select contact_id from appointment_refs where id = appointment_id)) as contact_tz,
         (select timezone from organizations o where o.id = org_id) as org_tz, (select name from organizations o where o.id = org_id) as org_name,
         (select reminders_approval_id from appointment_settings s where s.org_id = appointment_reminders.org_id) as approval_id,
         (select a.status = 'approved' and (a.expires_at is null or a.expires_at > now()) from approval_requests a
           where a.id = (select reminders_approval_id from appointment_settings s where s.org_id = appointment_reminders.org_id)) as approval_live,
         (select id from agent_instances g where g.org_id = appointment_reminders.org_id and g.role_key = 'appointment_setter') as agent_id`,
      [now.toISOString(), Math.min(100, opts.limit ?? 25)],
    );
    return res.rows;
  });

  for (const d of claimed) {
    await withSystem(async (db) => {
      // Reminders go out under the owner's standing authorization. When it has lapsed, nothing is sent and the owner is asked to renew.
      if (!d.approval_live) {
        await db.query("update appointment_reminders set status = 'blocked', reason = 'authorization_needed' where id = $1", [d.id]);
        await notifyOrgRoles(db, d.org_id, ["owner", "admin"], { kind: "booking_needs_action", severity: "warning", title: "Renew your appointment reminders", body: "Reminders are paused until you confirm them again in Appointments → Booking rules.", link: "/appointments", dedupeKey: `reminders-auth:${d.org_id}:${now.toISOString().slice(0, 10)}` });
        out.blocked += 1;
        return;
      }
      const text = reminderText({ orgName: d.org_name, title: d.title, startAt: new Date(d.start_at), timeZone: d.contact_tz ?? d.org_tz, link: d.meeting_link, contactName: d.contact_name });
      const res = await queueOutreach(db, {
        orgId: d.org_id, contactId: d.contact_id, agentId: d.agent_id, scope: "reminder", body: text, subject: "Appointment reminder", approvalId: d.approval_id, now,
        dedupeKey: `reminder:${d.appointment_id}:${d.offset_minutes}:${new Date(d.due_at).getTime()}`,
      });
      await db.query("update appointment_reminders set status = $2, reason = $3, message_id = $4 where id = $1", [d.id, res.status === "blocked" ? "blocked" : "queued", res.reason ?? null, res.messageId ?? null]);
      if (res.status === "blocked") out.blocked += 1;
      else out.queued += 1;
    });
  }
  return out;
}
