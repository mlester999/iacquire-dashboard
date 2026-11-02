import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { renderEmail } from "@/server/email-render";

export type EmailTemplate = "invitation" | "verify_email" | "password_reset" | "support_reply" | "staff_invitation" | "setup_update" | "escalation_alert" | "notification" | "proposal_code" | "demo_link" | "purchase_invitation";

export interface OutgoingEmail {
  to: string;
  template: EmailTemplate;
  subject: string;
  text: string;
  /**
   * What the outbox keeps in place of `text`. Set it when the body carries a bearer link (a purchase link) that must not be written to an ordinary table: the provider still
   * receives the whole `text`, and only this copy is stored.
   */
  storedText?: string;
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
  /** The provider's own id for an accepted message (it is what the provider's later delivery notice names). Only set when status is "sent" and the provider gave one. */
  providerId?: string | null;
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
      [email.to, email.template, email.subject, email.storedText ?? email.text, e.EMAIL_PROVIDER],
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

async function deliverViaResend(id: string, email: OutgoingEmail, db?: Queryable): Promise<{ status: "sent" | "failed"; error: string | null; providerId: string | null }> {
  const e = env();
  let status: "sent" | "failed" = "failed";
  let error: string | null = null;
  let providerId: string | null = null;
  try {
    if (!e.RESEND_API_KEY) throw new Error("RESEND_API_KEY is not configured");
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, "Content-Type": "application/json" },
      // Branded HTML plus the original plain text as the fallback part (multipart/alternative). The tag ties the provider's later delivery notice back to this outbox row.
      body: JSON.stringify({ from: e.EMAIL_FROM, to: [email.to], subject: email.subject, ...renderOutgoing(email), tags: [{ name: "outbox", value: id }] }),
      signal: AbortSignal.timeout(10000),
    });
    if (res.ok) {
      status = "sent";
      providerId = await providerMessageId(res);
    } else error = await providerError(res);
  } catch (err) {
    error = err instanceof Error ? err.message.slice(0, 200) : "delivery failed";
  }
  const record = (q: Queryable) =>
    q.query("update email_outbox set status = $2, error = $3, sent_at = case when $2 = 'sent' then now() end where id = $1", [id, status, error]);
  await (db ? record(db) : withSystem(record)).catch(() => undefined);
  return { status, error, providerId };
}

/** The id the provider gave an accepted message, or null (a missing or odd answer never turns an accepted message into a failure). */
async function providerMessageId(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { id?: unknown };
    return typeof body.id === "string" && /^[A-Za-z0-9_-]{6,120}$/.test(body.id) ? body.id : null;
  } catch {
    return null;
  }
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

export interface EmailReadiness {
  /** Whether a message sent now would actually be handed to an email provider. */
  ready: boolean;
  provider: "resend" | "capture";
  /** The first thing in the way, as a fixed word; null when ready. */
  reason: "email_off" | "email_not_configured" | "sender_not_ready" | null;
  /** The sender as configured (an address, not a secret). */
  sender: string;
  senderDomain: string | null;
  /** What to change, in words naming the environment variable. Empty when ready. */
  problems: string[];
  /** Things that do not stop sending but are worth a look. */
  warnings: string[];
}

const PLACEHOLDER_DOMAIN = /(^|\.)(local|test|invalid|example|localhost)$|^example\.(com|org|net)$/i;

/**
 * Whether email can really leave. It reads configuration only and calls nothing: whether the sending domain is verified is the email provider's to decide, and a message from
 * an unverified domain is refused by it, which the delivery record then says. The browser never sends email: this is checked on the server, before and while sending.
 */
export function emailReadiness(): EmailReadiness {
  const e = env();
  const sender = e.EMAIL_FROM;
  const address = /<([^<>]+)>/.exec(sender)?.[1] ?? sender;
  const domain = /@([^@\s>]+)$/.exec(address.trim())?.[1]?.toLowerCase() ?? null;
  const problems: string[] = [];
  const warnings: string[] = [];
  let reason: EmailReadiness["reason"] = null;
  if (e.EMAIL_PROVIDER !== "resend") {
    reason = "email_off";
    problems.push("EMAIL_PROVIDER is \"capture\", so messages are stored and never sent. Set EMAIL_PROVIDER=resend.");
  }
  if (!e.RESEND_API_KEY) {
    reason ??= "email_not_configured";
    problems.push("RESEND_API_KEY is not set. Create a sending key in the Resend dashboard and add it.");
  }
  if (!domain || PLACEHOLDER_DOMAIN.test(domain)) {
    reason ??= "sender_not_ready";
    problems.push(`EMAIL_FROM is "${sender}", a placeholder. Use an address on a domain verified in Resend, for example iAcquire <no-reply@iacquire.online>.`);
  } else {
    try {
      const host = new URL(e.APP_URL).hostname.toLowerCase();
      if (host !== domain && !host.endsWith(`.${domain}`)) warnings.push(`The sender domain (${domain}) is not the site's domain (${host}). That is fine if ${domain} is verified in Resend; Resend refuses mail from a domain that is not.`);
    } catch {
      /* APP_URL is validated elsewhere */
    }
  }
  return { ready: problems.length === 0, provider: e.EMAIL_PROVIDER, reason, sender, senderDomain: domain, problems, warnings };
}
