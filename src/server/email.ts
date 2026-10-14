import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";

export type EmailTemplate = "invitation" | "verify_email" | "password_reset" | "support_reply" | "staff_invitation" | "setup_update" | "escalation_alert" | "notification";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  subject: string;
  text: string;
}

/**
 * Queues an email in the outbox and delivers it through the configured provider.
 * With EMAIL_PROVIDER=capture (the default), messages are stored but not sent; in development
 * they can be read at /dev/mailbox. Delivery status is recorded truthfully either way.
 */
export async function sendEmail(email: OutgoingEmail, db?: Queryable): Promise<{ id: string; status: string }> {
  const e = env();
  const insert = (q: Queryable) =>
    q.query<{ id: string }>(
      `insert into email_outbox (to_email, template, subject, body_text, status, provider)
       values ($1, $2, $3, $4, 'queued', $5) returning id`,
      [email.to, email.template, email.subject, email.text, e.EMAIL_PROVIDER],
    );
  const { rows } = db ? await insert(db) : await withSystem(insert);
  const id = rows[0].id;

  if (e.EMAIL_PROVIDER === "capture") {
    const mark = (q: Queryable) => q.query("update email_outbox set status = 'captured' where id = $1", [id]);
    if (db) await mark(db);
    else await withSystem(mark);
    return { id, status: "captured" };
  }

  // Delivery happens outside the caller's transaction so a slow provider never holds locks.
  queueMicrotask(() => {
    void deliverViaResend(id, email);
  });
  return { id, status: "queued" };
}

async function deliverViaResend(id: string, email: OutgoingEmail) {
  const e = env();
  let status: "sent" | "failed" = "failed";
  let error: string | null = null;
  try {
    if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: e.EMAIL_FROM, to: [email.to], subject: email.subject, text: email.text }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) status = "sent";
    else error = `Provider responded ${res.status}`;
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : "delivery failed";
  }
  await withSystem((db) =>
    db.query("update email_outbox set status = $2, error = $3, sent_at = case when $2 = 'sent' then now() end where id = $1", [
      id,
      status,
      error,
    ]),
  ).catch(() => undefined);
}

export function appUrl(pathname: string): string {
  return new URL(pathname, env().APP_URL).toString();
}
