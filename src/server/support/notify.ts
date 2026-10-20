import "server-only";
import { after } from "next/server";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { sendEmail } from "@/server/email";
import { parseEmailPreference, sanitizeErrorText } from "@/lib/ops";
import { EVENT_NOTIFICATION_KIND, SUPPORT_EVENT_INFO, modeSendsEmail, modeSendsInApp, type SupportEvent } from "@/lib/support/lifecycle";
import { loadNotificationModes } from "@/server/support/settings";

// Delivery of Support & Requests updates. The Super Admin chooses, per event, in-app only / email only / both / off
// (support_notification_rules). Every (event, person, channel) is claimed in support_notification_log before anything is sent, so
// the same event handled twice still notifies each person once, and the log says what really happened:
//   in-app  -> "delivered" (a row exists in the person's notification list)
//   email   -> "queued", then "sent" (accepted by the email provider; not a delivery receipt) or "failed", or "captured" in development
//   anything not sent -> "skipped" with the reason

export type Audience = "client" | "agency";
export interface Recipient { userId: string; audience: Audience }

export interface SupportNotice {
  event: SupportEvent;
  ticket: { id: string; org_id: string; ref: string; subject: string };
  /** Identifies this occurrence of the event. Handling the same key again notifies nobody twice. */
  eventKey: string;
  recipients: Recipient[];
  title: string;
  body?: string;
  severity?: "info" | "success" | "warning" | "critical";
}

export interface DispatchResult { delivered: number; queuedEmail: number; skipped: number; duplicates: number }

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A client's own people see the request in their workspace; the team opens it in the agency queue. */
export const noticeLink = (audience: Audience, ticketId: string) => (audience === "client" ? `/support/${ticketId}` : `/admin/support/${ticketId}`);

// ---------------------------------------------------------------------------
// Who hears about it
// ---------------------------------------------------------------------------

const dedupe = (rows: Array<{ id: string }>, audience: Audience, exclude?: string | null): Recipient[] =>
  [...new Set(rows.map((r) => r.id))].filter((id) => id !== exclude).map((userId) => ({ userId, audience }));

/** The person who opened the request and anyone on the client's side who has replied to it, while they are still active workspace members. */
export async function clientParticipants(db: Queryable, ticketId: string, orgId: string, excludeUserId?: string | null): Promise<Recipient[]> {
  const { rows } = await db.query<{ id: string }>(
    `select distinct u.id from users u
     join organization_memberships m on m.user_id = u.id and m.org_id = $2 and m.status = 'active'
     where u.status = 'active'
       and exists (select 1 from role_permissions rp where rp.role = m.role and rp.permission = 'support.use')
       and (u.id = (select created_by from support_tickets where id = $1)
            or exists (select 1 from support_messages sm where sm.ticket_id = $1 and sm.author_id = u.id and sm.author_kind = 'client'))`,
    [ticketId, orgId],
  );
  return dedupe(rows, "client", excludeUserId);
}

/** Agency people who can read this client's support queue and work requests. Used while a request has nobody assigned. */
export async function agencyQueueRecipients(db: Queryable, orgId: string, excludeUserId?: string | null): Promise<Recipient[]> {
  const { rows } = await db.query<{ id: string }>(
    `select u.id from users u
     where u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
       and app.user_can_access_org(u.id, $1)
       and coalesce(app.user_has_agency_permission(u.id, 'agency.support.view'), false)
       and coalesce(app.user_has_agency_permission(u.id, 'agency.support.queue'), false)`,
    [orgId],
  );
  return dedupe(rows, "agency", excludeUserId);
}

/** The assigned team member while they can still work the request, otherwise the people watching the queue. */
export async function agencyHandlers(db: Queryable, ticket: { org_id: string; assigned_to: string | null }, excludeUserId?: string | null): Promise<Recipient[]> {
  if (ticket.assigned_to) {
    const { rows } = await db.query<{ id: string }>(
      `select u.id from users u where u.id = $1 and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
         and app.user_can_access_org(u.id, $2) and coalesce(app.user_has_agency_permission(u.id, 'agency.support.view'), false)`,
      [ticket.assigned_to, ticket.org_id],
    );
    if (rows.length) return dedupe(rows, "agency", excludeUserId);
  }
  return agencyQueueRecipients(db, ticket.org_id, excludeUserId);
}

/** The assignee plus the people who manage priorities for this client (for escalations and overdue requests). */
export async function agencyManagers(db: Queryable, ticket: { org_id: string; assigned_to: string | null }, excludeUserId?: string | null): Promise<Recipient[]> {
  const { rows } = await db.query<{ id: string }>(
    `select u.id from users u
     where u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
       and app.user_can_access_org(u.id, $1)
       and coalesce(app.user_has_agency_permission(u.id, 'agency.support.view'), false)
       and (u.id = $2 or coalesce(app.user_has_agency_permission(u.id, 'agency.support.priority'), false))`,
    [ticket.org_id, ticket.assigned_to],
  );
  return dedupe(rows, "agency", excludeUserId);
}

// ---------------------------------------------------------------------------
// Dispatch (runs inside the caller's transaction; nothing here talks to the network)
// ---------------------------------------------------------------------------

export async function dispatchSupportNotice(db: Queryable, notice: SupportNotice): Promise<DispatchResult> {
  const result: DispatchResult = { delivered: 0, queuedEmail: 0, skipped: 0, duplicates: 0 };
  if (!notice.recipients.length) return result;
  const mode = (await loadNotificationModes(db))[notice.event];
  const kind = EVENT_NOTIFICATION_KIND[notice.event];
  const base = env().APP_URL.replace(/\/$/, "");
  const seen = new Set<string>();

  const claim = async (r: Recipient, channel: "in_app" | "email", status: string, detail: string | null, subject?: string, body?: string) => {
    const { rows } = await db.query<{ id: string }>(
      `insert into support_notification_log (ticket_id, org_id, event_kind, event_key, recipient_user_id, channel, status, detail, subject, body_text, claimed_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, null)
       on conflict (event_key, recipient_user_id, channel) do nothing returning id`,
      [notice.ticket.id, notice.ticket.org_id, notice.event, notice.eventKey, r.userId, channel, status, detail, subject ?? null, body ?? null],
    );
    return rows[0]?.id ?? null;
  };

  for (const r of notice.recipients) {
    if (seen.has(r.userId)) continue;
    seen.add(r.userId);
    if (mode === "disabled") {
      const id = await claim(r, "in_app", "skipped", "This notification is turned off in the support settings.");
      if (id) result.skipped += 1;
      else result.duplicates += 1;
      continue;
    }
    const link = noticeLink(r.audience, notice.ticket.id);
    if (modeSendsInApp(mode)) {
      const logId = await claim(r, "in_app", "delivered", null);
      if (!logId) result.duplicates += 1;
      else {
        const n = await db.query<{ id: string }>(
          `insert into notifications (org_id, user_id, kind, severity, title, body, link, dedupe_key) values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (user_id, dedupe_key) where dedupe_key is not null do update set dedupe_key = notifications.dedupe_key returning id`,
          [r.audience === "client" ? notice.ticket.org_id : null, r.userId, kind, notice.severity ?? "info", clip(notice.title, 200), notice.body ? clip(notice.body, 1000) : null, link, `support:${notice.eventKey}`],
        );
        await db.query("update support_notification_log set notification_id = $2 where id = $1", [logId, n.rows[0]?.id ?? null]);
        result.delivered += 1;
      }
    }
    if (modeSendsEmail(mode)) {
      // The body is only what the person is entitled to read in the portal anyway; replies from the client are never put in team email.
      const lines = [notice.title, notice.body && r.audience === "client" ? `\n${clip(notice.body, 300)}` : "", `\nOpen in iAcquire: ${base}${link}`, r.audience === "client" ? "\nPlease reply inside iAcquire; replies to this email are not read." : ""];
      const id = await claim(r, "email", "queued", null, clip(notice.title, 150), lines.filter(Boolean).join("\n"));
      if (id) result.queuedEmail += 1;
      else result.duplicates += 1;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Email delivery (after the transaction; also run by the scheduler, which is the retry)
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 3;
const RETRY_AFTER_MINUTES = 10;
const STALE_CLAIM_MINUTES = 5;

interface Claimed {
  id: string;
  event_kind: SupportEvent;
  recipient_user_id: string;
  subject: string | null;
  body_text: string | null;
  attempts: number;
  org_id: string;
}

export interface EmailFlushResult { sent: number; captured: number; failed: number; skipped: number }

/**
 * Sends queued support emails and retries failed ones (up to three attempts, ten minutes apart). A row is claimed before the
 * provider is called, so two overlapping runs never send the same email twice. Honours the recipient's own "email off" choice.
 */
export async function flushSupportEmails(opts: { ticketId?: string; limit?: number } = {}): Promise<EmailFlushResult> {
  const out: EmailFlushResult = { sent: 0, captured: 0, failed: 0, skipped: 0 };
  const claimed = await withSystem(async (db) => {
    const { rows } = await db.query<Claimed>(
      `update support_notification_log l set status = 'queued', claimed_at = now(), attempts = case when l.status = 'failed' or l.claimed_at is not null then l.attempts + 1 else l.attempts end
       where l.id in (
         select c.id from support_notification_log c
         where c.channel = 'email' and ($2::uuid is null or c.ticket_id = $2)
           and ((c.status = 'queued' and (c.claimed_at is null or c.claimed_at < now() - make_interval(mins => $3)))
             or (c.status = 'failed' and c.attempts < $4 and c.updated_at < now() - make_interval(mins => $5)))
         order by c.created_at limit $1 for update skip locked)
       returning l.id, l.event_kind, l.recipient_user_id, l.subject, l.body_text, l.attempts, l.org_id`,
      [Math.min(200, opts.limit ?? 50), opts.ticketId ?? null, STALE_CLAIM_MINUTES, MAX_ATTEMPTS, RETRY_AFTER_MINUTES],
    );
    return rows;
  });

  for (const row of claimed) {
    const settle = (status: "sent" | "captured" | "failed" | "skipped", detail: string | null, outboxId: string | null) =>
      withSystem((db) =>
        db.query(
          `update support_notification_log set status = $2, detail = $3, email_outbox_id = $4, claimed_at = null, updated_at = now(),
             body_text = case when $2 in ('sent', 'captured', 'skipped') then null else body_text end
           where id = $1`,
          [row.id, status, detail, outboxId],
        ),
      );
    const person = await withSystem(async (db) =>
      (await db.query<{ email: string; status: string; prefs: Record<string, unknown> | null }>(
        `select u.email::text as email, u.status, p.prefs from users u left join notification_preferences p on p.user_id = u.id and p.org_id = $2 where u.id = $1`,
        [row.recipient_user_id, row.org_id],
      )).rows[0],
    );
    if (!person || person.status !== "active") {
      await settle("skipped", "The recipient is no longer an active user.", null);
      out.skipped += 1;
      continue;
    }
    // A client who turned email off for their workspace is not emailed about routine updates.
    if (parseEmailPreference(person.prefs) === "off" && SUPPORT_EVENT_INFO[row.event_kind]) {
      await settle("skipped", "The recipient turned email notifications off.", null);
      out.skipped += 1;
      continue;
    }
    try {
      const sent = await sendEmail({ to: person.email, template: "notification", subject: row.subject ?? "iAcquire support update", text: row.body_text ?? "", tag: "Support" }, undefined, { wait: true });
      if (sent.status === "failed") {
        await settle("failed", sanitizeErrorText(sent.error ?? "The email provider rejected it.", 280), sent.id);
        out.failed += 1;
      } else if (sent.status === "captured") {
        await settle("captured", "Captured in the development mailbox; no email left this server.", sent.id);
        out.captured += 1;
      } else {
        await settle("sent", "Accepted by the email provider.", sent.id);
        out.sent += 1;
      }
    } catch (err) {
      await settle("failed", sanitizeErrorText(err, 280), null);
      out.failed += 1;
    }
  }
  return out;
}

/**
 * Runs the email send after the response when called from a request (so the person never waits on the provider), and right away
 * otherwise (tests, scripts). Whatever it cannot finish stays queued for the scheduler.
 */
export async function sendQueuedSupportEmails(ticketId?: string): Promise<void> {
  const run = async () => {
    try {
      await flushSupportEmails({ ticketId, limit: 25 });
    } catch {
      // Left queued; the scheduled job retries.
    }
  };
  try {
    after(run);
  } catch {
    await run();
  }
}
