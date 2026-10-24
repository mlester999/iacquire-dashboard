import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { renderEmail } from "@/server/email-render";

export type EmailTemplate = "invitation" | "verify_email" | "password_reset" | "support_reply" | "staff_invitation" | "setup_update" | "escalation_alert" | "notification" | "proposal_code" | "demo_link";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  subject: string;
  text: string;
  /** Optional presentation hints (the text part stays complete without them): severity tints the header, tag names the category. */
  tone?: "info" | "success" | "warning" | "critical";
  tag?: string;
}

export type EmailStatus = "queued" | "captured" | "sent" | "failed";

export interface EmailDelivery {
  id: string;
  status: EmailStatus;
  /** Provider failure reason; only set when status is "failed". */
  error?: string | null;
}

/**
 * Queues an email in the outbox and delivers it through the configured provider.
 * With EMAIL_PROVIDER=capture (the default), messages are stored but not sent; in development
 * they can be read at /dev/mailbox. Delivery status is recorded truthfully either way.
 *
 * By default delivery is fire-and-forget. Pass `{ wait: true }` when the caller reports the outcome to a
 * person (for example "invitation sent"): the provider call is awaited and the final status is returned.
 * Callers that pass `db` from an open transaction should still prefer to send after it commits.
 */
export async function sendEmail(email: OutgoingEmail, db?: Queryable, opts: { wait?: boolean } = {}): Promise<EmailDelivery> {
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

  if (opts.wait) {
    const outcome = await deliverViaResend(id, email, db);
    return { id, ...outcome };
  }

  // Delivery happens outside the caller's transaction so a slow provider never holds locks.
  queueMicrotask(() => {
    void deliverViaResend(id, email);
  });
  return { id, status: "queued" };
}

async function deliverViaResend(id: string, email: OutgoingEmail, db?: Queryable): Promise<{ status: "sent" | "failed"; error: string | null }> {
  const e = env();
  let status: "sent" | "failed" = "failed";
  let error: string | null = null;
  try {
    if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
      // Branded HTML plus the original plain text as the fallback part (multipart/alternative).
      body: JSON.stringify({ from: e.EMAIL_FROM, to: [email.to], subject: email.subject, ...renderOutgoing(email) }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) status = "sent";
    else error = await providerError(res);
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : "delivery failed";
  }
  const record = (q: Queryable) =>
    q.query("update email_outbox set status = $2, error = $3, sent_at = case when $2 = 'sent' then now() end where id = $1", [id, status, error]);
  await (db ? record(db) : withSystem(record)).catch(() => undefined);
  return { status, error };
}

function renderOutgoing(email: OutgoingEmail) {
  const { html, text } = renderEmail(email, { baseUrl: env().APP_URL });
  return { html, text };
}

/** The provider explains rejections (for example an unverified sending domain); surface that, never the request. */
async function providerError(res: Response): Promise<string> {
  let detail = "";
  try {
    const body = (await res.json()) as { message?: unknown };
    if (typeof body.message === "string") detail = body.message.replace(/\s+/g, " ").trim();
  } catch {
    // Non-JSON error bodies fall back to the status code alone.
  }
  return `Provider responded ${res.status}${detail ? `: ${detail}` : ""}`.slice(0, 300);
}

export function appUrl(pathname: string): string {
  return new URL(pathname, env().APP_URL).toString();
}
