import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { releaseReservation } from "@/server/billing/ledger";
import { notifyOrgRoles } from "@/server/notifications";
import { queueOutreach } from "@/server/messaging/outreach";
import { env } from "@/server/env";
import { MANAGE_LINK_PLACEHOLDER } from "@/server/messaging/redact";
import { formatSlot, reminderSchedule } from "@/lib/appointments";
import { absoluteUrl, manageUrl } from "@/lib/calendars/urls";

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

/** A reminder as claimed for sending, with what its text needs. */
export interface ClaimedReminder {
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
  provider: string | null;
  location: string | null;
  invitee_tz: string | null;
  allow_changes: boolean | null;
  change_cutoff_minutes: number | null;
}

/** The AI employee that owns appointment work for a workspace. */
export async function appointmentSetterId(db: Queryable, orgId: string): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>("select id from agent_instances where org_id = $1 and role_key = 'appointment_setter'", [orgId]);
  return rows[0]?.id ?? null;
}

const MAX_REMINDER = 600;

/**
 * The reminder a customer reads. With a place it says where; with a manage link it says how to reschedule or cancel instead of asking
 * for a reply. When it would run long, the title and place are shortened first: a link is never cut, because a cut link is a broken one.
 */
export function reminderText(d: { orgName: string; title: string; startAt: Date; timeZone: string; link: string | null; contactName: string; location?: string | null; manageLink?: string | null }): string {
  const first = d.contactName.trim().split(/\s+/)[0];
  const hello = first ? `Hi ${first}, ` : "";
  const head = `${hello}a reminder from ${d.orgName}: "${d.title}" is on ${formatSlot(d.startAt.toISOString(), d.timeZone)}.`;
  if (!d.location && !d.manageLink) return `${head}${d.link ? ` Join here: ${d.link}.` : ""} Reply here if you need to change it.`.slice(0, MAX_REMINDER);
  const change = d.manageLink ? ` To reschedule or cancel: ${d.manageLink}` : " Reply here if you need to change it.";
  let join = d.link ? ` Join here: ${d.link}.` : "";
  // A very long meeting link gives way to the manage link, which leads to the meeting details too.
  if (d.manageLink && head.length + join.length + change.length > MAX_REMINDER) join = "";
  const place = d.location?.replace(/\s+/g, " ").trim();
  let where = place ? ` Where: ${place.length > 160 ? `${place.slice(0, 159)}…` : place}.` : "";
  if (head.length + where.length + join.length + change.length > MAX_REMINDER) where = "";
  const room = MAX_REMINDER - where.length - join.length - change.length;
  const shortHead = head.length > room ? `${head.slice(0, Math.max(0, room - 1))}…` : head;
  return `${shortHead}${where}${join}${change}`;
}

/** A reminder's manage link lasts until a week after the appointment, so it still shows what happened afterwards. */
function reminderLinkMinutes(startAt: Date, now: Date): number {
  return Math.min(400 * 24 * 60, Math.max(60, Math.ceil((startAt.getTime() - now.getTime()) / 60_000) + 7 * 24 * 60));
}

/** Manage-link tokens are 24 random bytes in base64url (issueManageLink), so a link of this shape is exactly as long as a real one. */
const SIZING_TOKEN = "x".repeat(32);

/**
 * The reminder text as it is stored: where the customer's manage link goes it holds {{appointment.manage_link}}, never a working link
 * (anyone who can read the inbox, a timeline or an export could otherwise use it). The text is laid out with a link of real length, so
 * nothing gets cut when the dispatcher fills the link in for the provider call.
 */
export function reminderTemplate(d: Parameters<typeof reminderText>[0] & { withManageLink: boolean; appUrl: string }): string {
  if (!d.withManageLink) return reminderText({ ...d, manageLink: null });
  const sizing = absoluteUrl(manageUrl(SIZING_TOKEN), d.appUrl);
  return reminderText({ ...d, manageLink: sizing }).split(sizing).join(MANAGE_LINK_PLACEHOLDER);
}

/**
 * Issues the manage link for one attempt to send a reminder message, inside the dispatcher's transaction: a fresh link (issued for
 * "reminder", lasting until a week after the appointment) when the booking can still be changed online, otherwise null. Only the link's
 * hash is stored; the raw link exists in the provider payload alone.
 */
export async function issueReminderManageLink(db: Queryable, orgId: string, messageId: string, now: Date): Promise<{ url: string; token: string; appointmentId: string } | null> {
  const { rows } = await db.query<{ appointment_id: string; provider: string; status: string; start_at: Date; appointment_type_id: string | null }>(
    `select a.id as appointment_id, a.provider, a.status, a.start_at, a.appointment_type_id from appointment_reminders r
     join appointment_refs a on a.id = r.appointment_id and a.org_id = r.org_id where r.org_id = $1 and r.message_id = $2 limit 1`,
    [orgId, messageId],
  );
  const a = rows[0];
  if (!a || a.provider !== "native" || !a.appointment_type_id) return null;
  const { customerChangeBlock, issueManageLink, loadCustomerRules } = await import("@/server/calendars/booking");
  const start = new Date(a.start_at);
  const rules = await loadCustomerRules(db, orgId, a.appointment_type_id);
  if (customerChangeBlock({ status: a.status, startAt: start }, rules, now)) return null;
  const token = await issueManageLink(db, orgId, a.appointment_id, "reminder", reminderLinkMinutes(start, now), now);
  return { url: absoluteUrl(manageUrl(token), env().APP_URL), token, appointmentId: a.appointment_id };
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

  const claimed = await claimDueReminders(now, opts.limit);
  for (const d of claimed) {
    const r = await queueClaimedReminder(d, now);
    if (r === "blocked") out.blocked += 1;
    else if (r === "queued") out.queued += 1;
  }
  return out;
}

/**
 * Claims reminders that have come due (status queued, no message yet), skipping any whose appointment is no longer upcoming. The claim is
 * its own transaction; each claimed reminder is then queued, after being checked again, by queueClaimedReminder.
 */
export async function claimDueReminders(now: Date, limit?: number): Promise<ClaimedReminder[]> {
  return withSystem(async (db) => {
    // A reminder is never sent after its appointment has started, or for one that is no longer upcoming.
    await db.query(
      `update appointment_reminders r set status = 'skipped', reason = 'The appointment is no longer upcoming.'
       from appointment_refs a where a.id = r.appointment_id and r.status = 'scheduled' and r.due_at <= $1 and (a.status <> all($2::text[]) or a.start_at <= $1)`,
      [now.toISOString(), LIVE],
    );
    const res = await db.query<ClaimedReminder>(
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
         (select id from agent_instances g where g.org_id = appointment_reminders.org_id and g.role_key = 'appointment_setter') as agent_id,
         (select provider from appointment_refs where id = appointment_id) as provider, (select location from appointment_refs where id = appointment_id) as location,
         (select invitee_timezone from appointment_refs where id = appointment_id) as invitee_tz,
         (select t.allow_customer_changes from crm_appointment_types t where t.id = (select appointment_type_id from appointment_refs where id = appointment_id)) as allow_changes,
         (select t.change_cutoff_minutes from crm_appointment_types t where t.id = (select appointment_type_id from appointment_refs where id = appointment_id)) as change_cutoff_minutes`,
      [now.toISOString(), Math.min(100, limit ?? 25)],
    );
    return res.rows;
  });
}

/**
 * Queues the message for one claimed reminder. The claim happened in an earlier transaction, so the reminder is locked and checked again
 * first: anything that changed it since (a reschedule, a cancellation, another worker) wins, and nothing is queued for the old time.
 */
export async function queueClaimedReminder(d: ClaimedReminder, now: Date): Promise<"queued" | "blocked" | "skipped"> {
  return withSystem(async (db) => {
    // The claim happened in an earlier transaction. Lock the reminder (rescheduling and cancelling lock it too, in syncRemindersFor) and
    // go on only if it is still the reminder that was claimed, for an appointment that is still upcoming at the same time.
    const dueAt = new Date(d.due_at);
    const startAt = new Date(d.start_at);
    const { rows: current } = await db.query<{ status: string; due_at: Date; message_id: string | null; appt_status: string; start_at: Date }>(
      `select r.status, r.due_at, r.message_id, a.status as appt_status, a.start_at from appointment_reminders r
       join appointment_refs a on a.id = r.appointment_id and a.org_id = r.org_id where r.id = $1 for update of r`,
      [d.id],
    );
    const c = current[0];
    if (!c || c.status !== "queued" || c.message_id || new Date(c.due_at).getTime() !== dueAt.getTime()) return "skipped";
    if (!LIVE.includes(c.appt_status) || new Date(c.start_at).getTime() <= now.getTime()) {
      await db.query("update appointment_reminders set status = 'skipped', reason = 'The appointment is no longer upcoming.' where id = $1 and status = 'queued' and due_at = $2", [d.id, dueAt]);
      return "skipped";
    }
    // The appointment moved but its reminders were not re-planned yet: put this one back, so it is claimed again with the new time.
    if (new Date(c.start_at).getTime() !== startAt.getTime()) {
      await db.query("update appointment_reminders set status = 'scheduled' where id = $1 and status = 'queued' and due_at = $2 and message_id is null", [d.id, dueAt]);
      return "skipped";
    }
    // Reminders go out under the owner's standing authorization. When it has lapsed, nothing is sent and the owner is asked to renew.
    if (!d.approval_live) {
      await db.query("update appointment_reminders set status = 'blocked', reason = 'authorization_needed' where id = $1 and status = 'queued' and due_at = $2", [d.id, dueAt]);
      await notifyOrgRoles(db, d.org_id, ["owner", "admin"], { kind: "booking_needs_action", severity: "warning", title: "Renew your appointment reminders", body: "Reminders are paused until you confirm them again in Appointments → Booking rules.", link: "/appointments", dedupeKey: `reminders-auth:${d.org_id}:${now.toISOString().slice(0, 10)}` });
      return "blocked";
    }
    // A native booking whose type lets customers change it says how to: the stored text holds a placeholder, and the dispatcher issues a
    // link of its own for the provider call (so no working link is ever stored with the message).
    const withManageLink = d.provider === "native" && Boolean(d.allow_changes) && now.getTime() < startAt.getTime() - (d.change_cutoff_minutes ?? 0) * 60_000;
    const text = reminderTemplate({
      orgName: d.org_name, title: d.title, startAt, timeZone: (d.provider === "native" ? d.invitee_tz : null) ?? d.contact_tz ?? d.org_tz, link: d.meeting_link, contactName: d.contact_name,
      location: d.location, withManageLink, appUrl: env().APP_URL,
    });
    const res = await queueOutreach(db, {
      orgId: d.org_id, contactId: d.contact_id, agentId: d.agent_id, scope: "reminder", body: text, subject: "Appointment reminder", approvalId: d.approval_id, now,
      dedupeKey: `reminder:${d.appointment_id}:${d.offset_minutes}:${dueAt.getTime()}`,
    });
    const done = await db.query(
      "update appointment_reminders set status = $2, reason = $3, message_id = $4 where id = $1 and status = 'queued' and due_at = $5 and message_id is null",
      [d.id, res.status === "blocked" ? "blocked" : "queued", res.reason ?? null, res.messageId ?? null, dueAt],
    );
    if (!done.rowCount) return "skipped";
    return res.status === "blocked" ? "blocked" : "queued";
  });
}
