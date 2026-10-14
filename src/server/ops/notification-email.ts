import "server-only";
import { withSystem } from "@/server/db";
import { env } from "@/server/env";
import { sendEmail } from "@/server/email";
import { emailIncludesBody, emailedElsewhere, parseEmailPreference, shouldEmail } from "@/lib/ops";
import { isQuietHours } from "@/lib/messaging";

/** Notifications older than this are no longer worth an email (they stay in the app). */
const MAX_AGE_HOURS = 48;
/** Non-critical email waits out these local hours, so nobody is woken by a routine notice. */
const QUIET_START = "21:00";
const QUIET_END = "07:00";

interface Pending {
  id: string;
  org_id: string | null;
  user_id: string;
  kind: string;
  severity: string;
  title: string;
  body: string | null;
  link: string | null;
  created_at: Date;
  email: string;
  timezone: string | null;
  prefs: Record<string, unknown> | null;
}

/**
 * Emails the notifications people should not miss. Every decision is recorded in notification_deliveries (sent, queued or skipped
 * with the reason), so "did they get it?" has an answer, and the same notification is never emailed twice.
 * Customer content stays in the portal: those kinds are emailed as a title and a link only.
 */
export async function deliverNotificationEmails(opts: { now?: Date; limit?: number } = {}): Promise<{ queued: number; skipped: number; deferred: number }> {
  const now = opts.now ?? new Date();
  const out = { queued: 0, skipped: 0, deferred: 0 };
  const { rows } = await withSystem((db) =>
    db.query<Pending>(
      `select n.id, n.org_id, n.user_id, n.kind, n.severity, n.title, n.body, n.link, n.created_at, u.email::text as email, u.timezone, p.prefs
       from notifications n join users u on u.id = n.user_id and u.status = 'active'
       left join notification_preferences p on p.user_id = n.user_id and p.org_id = n.org_id
       where n.created_at > $1::timestamptz - make_interval(hours => $2)
         and not exists (select 1 from notification_deliveries d where d.notification_id = n.id and d.channel = 'email')
       order by n.created_at limit $3`,
      [now.toISOString(), MAX_AGE_HOURS, Math.min(200, opts.limit ?? 100)],
    ),
  );
  const base = env().APP_URL.replace(/\/$/, "");
  for (const n of rows) {
    if (emailedElsewhere(n.kind)) continue;
    const record = (status: "queued" | "sent" | "skipped", reason: string | null, outboxId: string | null) =>
      withSystem((db) =>
        db.query(
          `insert into notification_deliveries (notification_id, org_id, user_id, channel, status, skip_reason, email_outbox_id) values ($1, $2, $3, 'email', $4, $5, $6)
           on conflict (notification_id, channel) do nothing`,
          [n.id, n.org_id, n.user_id, status, reason, outboxId],
        ),
      );
    const preference = parseEmailPreference(n.prefs);
    if (!shouldEmail(n.kind, n.severity, preference)) {
      await record("skipped", preference === "off" ? "Email notifications are turned off." : "Not an email-worthy notification for this person's settings.", null);
      out.skipped += 1;
      continue;
    }
    // Wait out quiet hours for anything that is not critical. The notification stays pending and is retried on the next run.
    if (n.severity !== "critical" && isQuietHours(QUIET_START, QUIET_END, now, n.timezone || "UTC")) {
      out.deferred += 1;
      continue;
    }
    const link = n.link ? new URL(n.link, base).toString() : `${base}/notifications`;
    const text = [n.title, emailIncludesBody(n.kind) && n.body ? `\n${n.body}` : "", `\nOpen in iAcquire: ${link}`, "\nYou can change which notifications are emailed in Settings → Notifications."].filter(Boolean).join("\n");
    try {
      const sent = await sendEmail({ to: n.email, template: "notification", subject: n.title.slice(0, 150), text });
      await record(sent.status === "failed" ? "skipped" : "queued", sent.status === "failed" ? "The email provider rejected it." : null, sent.id);
      out.queued += 1;
    } catch {
      // Leave it unrecorded so the next run tries again.
    }
  }
  return out;
}

export async function notificationDeliveryStats(): Promise<{ sent24h: number; skipped24h: number; failed24h: number }> {
  const { rows } = await withSystem((db) =>
    db.query<{ sent: number; skipped: number; failed: number }>(
      `select count(*) filter (where d.status = 'queued' and (o.status in ('sent', 'captured') or o.status is null))::int as sent,
              count(*) filter (where d.status = 'skipped')::int as skipped,
              count(*) filter (where o.status = 'failed')::int as failed
       from notification_deliveries d left join email_outbox o on o.id = d.email_outbox_id where d.created_at > now() - interval '1 day'`,
    ),
  );
  return { sent24h: rows[0].sent, skipped24h: rows[0].skipped, failed24h: rows[0].failed };
}
