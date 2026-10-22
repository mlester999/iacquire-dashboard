import "server-only";
import type { Queryable } from "@/server/db";
import { contactAddress, getConsent, isSuppressed } from "@/server/messaging/contacts";
import { detectOptKeyword, isQuietHours, isWithinBusinessHours, nextSendWindow, validateBusinessHours, type BusinessHours } from "@/lib/messaging";
import type { EligibilityFacts, ChannelFacts } from "@/lib/missed-calls/eligibility";
import type { MissedCallPolicy } from "@/lib/missed-calls/policy";
import type { CaseRow } from "@/server/missed-calls/cases";

// Reads the current state of the world for one case. Called inside the engine's transaction, right before a decision and again right before
// an action, so the answer is never older than the moment it is used. It only reads.

export async function loadEligibilityFacts(db: Queryable, c: CaseRow, policy: MissedCallPolicy, now: Date): Promise<EligibilityFacts> {
  const orgId = c.org_id;
  const org = (await db.query<{ status: string; timezone: string }>("select status, timezone from organizations where id = $1", [orgId])).rows[0];
  const contact = c.contact_id
    ? (await db.query<{ deleted_at: Date | null; timezone: string | null }>("select deleted_at, timezone from contacts where id = $1 and org_id = $2", [c.contact_id, orgId])).rows[0] ?? null
    : null;

  const channels: ChannelFacts[] = [];
  for (const name of policy.messageChannels) {
    const row = (await db.query<{ enabled: boolean }>("select enabled from messaging_channels where org_id = $1 and channel = $2", [orgId, name])).rows[0];
    const address = c.contact_id && contact && !contact.deleted_at ? await contactAddress(db, orgId, c.contact_id, name) : null;
    channels.push({
      name,
      connected: Boolean(row?.enabled),
      hasAddress: Boolean(address),
      consent: c.contact_id ? await getConsent(db, orgId, c.contact_id, name, "service") : "unknown",
      suppressed: address ? await isSuppressed(db, orgId, name, address) : false,
    });
  }

  const owner = c.conversation_id
    ? (await db.query<{ owner_kind: "ai" | "human" | "unassigned" }>("select owner_kind from conversations where id = $1 and org_id = $2", [c.conversation_id, orgId])).rows[0]?.owner_kind ?? null
    : null;

  const since = c.last_called_at;
  const after = { customerReplied: false, callbackCompleted: false, personMessaged: false, appointmentBooked: false };
  if (c.contact_id) {
    // A reply of "STOP" is the caller writing back, but it is an opt-out, not a recovery: only another kind of message counts as a reply.
    const inbound = await db.query<{ body: string }>(
      `select m.body from conversation_messages m join conversations v on v.id = m.conversation_id and v.org_id = m.org_id
       where m.org_id = $1 and v.contact_id = $2 and m.direction = 'inbound' and m.created_at > $3 order by m.created_at limit 10`,
      [orgId, c.contact_id, since],
    );
    after.customerReplied = inbound.rows.some((m) => detectOptKeyword(m.body) !== "stop");
    after.personMessaged = (await db.query(
      `select 1 from conversation_messages m join conversations v on v.id = m.conversation_id and v.org_id = m.org_id
       where m.org_id = $1 and v.contact_id = $2 and m.direction = 'outbound' and m.author_kind = 'human' and m.status in ('queued', 'sending', 'sent', 'delivered', 'read') and m.created_at > $3 limit 1`,
      [orgId, c.contact_id, since],
    )).rows.length > 0;
    // A booking in progress (a request, an approval, one a person must make by hand) or an appointment on a calendar that was made after the call or is still ahead.
    after.appointmentBooked =
      (await db.query(
        `select 1 from appointment_bookings where org_id = $1 and contact_id = $2 and status in ('awaiting_approval', 'requested', 'booked', 'needs_manual') and (created_at >= $3 or start_at > $4) limit 1`,
        [orgId, c.contact_id, since, now],
      )).rows.length > 0 ||
      (await db.query(
        `select 1 from appointment_refs where org_id = $1 and contact_id = $2 and status in ('new', 'confirmed') and (created_at >= $3 or start_at > $4) limit 1`,
        [orgId, c.contact_id, since, now],
      )).rows.length > 0;
  }
  after.callbackCompleted = (await db.query(
    `select 1 from crm_call_records where org_id = $1 and direction = 'outbound' and status = 'completed' and coalesce(duration_seconds, 0) > 0
       and ((contact_id is not null and contact_id = $2) or (to_number is not null and to_number = $3)) and coalesce(started_at, created_at) >= $4 limit 1`,
    [orgId, c.contact_id, c.caller_number, since],
  )).rows.length > 0;

  const countedCalls = Number((await db.query<{ n: string }>("select count(*)::text as n from missed_call_case_calls where org_id = $1 and case_id = $2 and counted", [orgId, c.id])).rows[0].n);

  const quiet = (await db.query<{ quiet_hours_start: string; quiet_hours_end: string; min_hours_between_followups: number }>(
    "select quiet_hours_start, quiet_hours_end, min_hours_between_followups from messaging_policy limit 1",
  )).rows[0] ?? { quiet_hours_start: "21:00", quiet_hours_end: "08:00", min_hours_between_followups: 20 };
  const lastFollowUp = c.contact_id
    ? (await db.query<{ last: Date | null }>(
        `select max(m.sent_at) as last from conversation_messages m join conversations v on v.id = m.conversation_id and v.org_id = m.org_id
         where m.org_id = $1 and v.contact_id = $2 and m.scope = 'followup' and m.status in ('sent', 'delivered', 'read')`,
        [orgId, c.contact_id],
      )).rows[0]?.last ?? null
    : null;
  const hoursRow = (await db.query<{ business_hours: unknown }>("select business_hours from messaging_settings where org_id = $1", [orgId])).rows[0];
  const hours = validateBusinessHours(hoursRow?.business_hours ?? {}) as BusinessHours | null;
  const orgTz = org?.timezone ?? "UTC";
  // Quiet hours follow the customer's own time zone when the CRM has one, as the send chain does; opening hours are the business's own.
  const tz = contact?.timezone ?? orgTz;

  return {
    now,
    orgActive: org?.status === "active",
    policy,
    case: {
      state: c.state, paused: Boolean(c.paused_at), attempts: c.attempts, lastAttemptAt: c.last_attempt_at, firstCalledAt: c.first_called_at, lastCalledAt: c.last_called_at,
      callerNumber: c.caller_number, afterHours: c.after_hours, classification: c.classification, countedCalls, ownerKind: c.owner_kind,
    },
    contact: c.contact_id ? { deleted: !contact || Boolean(contact.deleted_at) } : null,
    channels,
    conversationOwner: owner,
    after,
    timing: {
      platformGapMinutes: quiet.min_hours_between_followups * 60,
      lastFollowUpSentAt: lastFollowUp ? new Date(lastFollowUp) : null,
      quietHours: isQuietHours(quiet.quiet_hours_start, quiet.quiet_hours_end, now, tz),
      withinBusinessHours: isWithinBusinessHours(hours, now, orgTz),
      nextOpen: nextSendWindow({ from: now, timeZone: tz, quietStart: quiet.quiet_hours_start, quietEnd: quiet.quiet_hours_end, businessHours: hours, businessHoursOnly: true }),
      nextOutsideQuiet: nextSendWindow({ from: now, timeZone: tz, quietStart: quiet.quiet_hours_start, quietEnd: quiet.quiet_hours_end, businessHours: hours, businessHoursOnly: false }),
    },
  };
}
