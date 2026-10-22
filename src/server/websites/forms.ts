import { recordFormTouch } from "@/server/attribution/touches";
import "server-only";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles } from "@/server/notifications";
import { recordConsent, resolveContact } from "@/server/messaging/contacts";
import { normalizeEmail, normalizePhone, type Channel } from "@/lib/messaging";
import type { OrgContext } from "@/server/tenancy/context";

const MAX_ATTEMPTS = 5;

export interface SubmissionView {
  id: string; pageSlug: string; name: string; email: string | null; phone: string | null; service: string | null; message: string;
  purpose: "contact" | "consultation" | "lead" | "appointment"; marketingOptIn: boolean; status: "received" | "processed" | "failed" | "spam"; contactId: string | null; createdAt: string; utm: Record<string, string>; referrer: string | null;
}

export async function listSubmissions(ctx: OrgContext, opts: { limit?: number } = {}): Promise<SubmissionView[]> {
  if (!ctx.can("contacts.view")) throw new AppError("forbidden", "You can't view enquiries.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; page_slug: string; name: string; email: string | null; phone: string | null; service: string | null; message: string; purpose: SubmissionView["purpose"]; marketing_opt_in: boolean; status: SubmissionView["status"]; contact_id: string | null; created_at: Date; utm: Record<string, string>; referrer: string | null }>(
      `select id, page_slug, name, email, phone, service, message, purpose, marketing_opt_in, status, contact_id, created_at, utm, referrer
       from website_form_submissions where org_id = $1 order by created_at desc limit $2`,
      [ctx.org.orgId, Math.min(200, opts.limit ?? 50)],
    );
    return rows.map((r) => ({ id: r.id, pageSlug: r.page_slug, name: r.name, email: r.email, phone: r.phone, service: r.service, message: r.message, purpose: r.purpose, marketingOptIn: r.marketing_opt_in, status: r.status, contactId: r.contact_id, createdAt: new Date(r.created_at).toISOString(), utm: r.utm ?? {}, referrer: r.referrer }));
  });
}

export async function markSubmissionSpam(ctx: OrgContext, id: string): Promise<void> {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "You can't change enquiries.");
  const res = await withSystem((db) => db.query("update website_form_submissions set status = 'spam' where id = $1 and org_id = $2 and status in ('received', 'processed', 'failed')", [id, ctx.org.orgId]));
  if (!res.rowCount) throw new AppError("not_found", "Enquiry not found.");
  await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "website.enquiry_marked_spam", targetType: "website_form_submission", targetId: id, result: "success" });
}

const urlCount = (s: string) => (s.match(/https?:\/\/|www\./gi) ?? []).length;
/** Whether the wording of the consent the visitor agreed to covers messages to a phone. Without that, no text-message consent is recorded. */
const coversTexting = (consentText: string) => /\b(text|texts|sms|whatsapp|message)\b/i.test(consentText);

const PURPOSE_LABEL: Record<string, string> = { contact: "Website enquiry", consultation: "Consultation request", lead: "Website lead", appointment: "Appointment request" };

interface Claimed { purpose: string; id: string; org_id: string; website_id: string; name: string; email: string | null; phone: string | null; service: string | null; message: string; marketing_opt_in: boolean; consent_text: string; page_slug: string; host: string; utm: Record<string, string>; referrer: string | null; created_at: Date }

async function processOne(s: Claimed): Promise<"processed" | "spam" | "failed"> {
  if (urlCount(s.message) >= 3 || urlCount(s.name) >= 1) {
    await withSystem((db) => db.query("update website_form_submissions set status = 'spam', processed_at = now() where id = $1", [s.id]));
    return "spam";
  }
  const email = normalizeEmail(s.email);
  const phone = normalizePhone(s.phone);
  if (!email && !phone) {
    await withSystem((db) => db.query("update website_form_submissions set status = 'failed', error = 'No usable email or phone number was given.', processed_at = now() where id = $1", [s.id]));
    await withSystem((db) => notifyOrgRoles(db, s.org_id, ["owner", "admin"], { kind: "system", severity: "warning", title: `A website enquiry from ${s.name || "someone"} couldn't be added automatically`, body: "Their email or phone number wasn't usable. Open the enquiry to follow up by hand.", link: "/website/leads", dedupeKey: `site-enquiry:${s.id}` }));
    return "failed";
  }
  return withSystem(async (db) => {
    const channel: Channel = email ? "email" : "sms";
    const address = (email ?? phone)!;
    // A web form proves nothing about who typed the address, so the identity stays unverified until the person or a human confirms it.
    const { contactId, created } = await resolveContact(db, { orgId: s.org_id, channel, address, name: s.name, source: "website_form" });
    if (email && phone) {
      const other = await db.query("select 1 from contact_identities where org_id = $1 and kind = 'phone' and value = $2", [s.org_id, phone]);
      if (!other.rows.length) await db.query("insert into contact_identities (org_id, contact_id, kind, value, verified) values ($1, $2, 'phone', $3, false)", [s.org_id, contactId, phone]);
    }
    if (created) await db.query("update contacts set lifecycle_stage = 'lead_captured', phone = coalesce(phone, $3) where id = $1 and org_id = $2", [contactId, s.org_id, phone]);
    else if (s.name) await db.query("update contacts set display_name = case when display_name = '' then $3 else display_name end where id = $1 and org_id = $2", [contactId, s.org_id, s.name.slice(0, 200)]);

    // Consent is recorded exactly as far as the words on the form went. Replying to an enquiry is "service"; offers need the separate opt-in.
    const evidence = `Website form (${s.host}): ${s.consent_text}`.slice(0, 500);
    const channels: Channel[] = [];
    if (email) channels.push("email");
    if (phone && coversTexting(s.consent_text)) channels.push("sms");
    for (const ch of channels) {
      await recordConsent(db, { orgId: s.org_id, contactId, channel: ch, purpose: "service", status: "granted", source: "website_form", evidence });
      if (s.marketing_opt_in) await recordConsent(db, { orgId: s.org_id, contactId, channel: ch, purpose: "marketing", status: "granted", source: "website_form", evidence: `${evidence} (marketing opt-in ticked)`.slice(0, 500) });
    }

    // The enquiry appears in the inbox as an internal note: it is not a message the customer sent over a channel, and nothing is sent back.
    const label = PURPOSE_LABEL[s.purpose] ?? "Website enquiry";
    const body = [`${label}${s.service ? ` about ${s.service}` : ""}`, s.message ? `"${s.message.slice(0, 900)}"` : "", phone ? `Phone: ${phone}` : "", email ? `Email: ${email}` : ""].filter(Boolean).join("\n");
    const conv = await db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, status, subject, last_message_at, last_message_preview, unread_count)
       values ($1, $2, $3, 'open', $4, now(), $5, 1)
       on conflict (org_id, contact_id, channel, thread_key) do update set unread_count = conversations.unread_count + 1, last_message_at = now(), last_message_preview = excluded.last_message_preview, status = 'open'
       returning id`,
      [s.org_id, contactId, channel, `${label}${s.service ? `: ${s.service}` : ""}`.slice(0, 300), `${label}: ${s.message || s.name}`.slice(0, 200)],
    );
    await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, dedupe_key) values ($1, $2, 'internal', 'system', $3, 'note', $4) on conflict (org_id, dedupe_key) do nothing", [s.org_id, conv.rows[0].id, body.slice(0, 4900), `web:${s.id}`]);
    await db.query("update website_form_submissions set status = 'processed', contact_id = $2, processed_at = now(), error = null where id = $1", [s.id, contactId]);
    // Where this lead came from: the UTM values and referrer the visit carried, and the page they sent the form from. Once per submission.
    await recordFormTouch(db, { orgId: s.org_id, contactId, kind: "website_form", submissionId: s.id, attribution: { ...s.utm, referrer: s.referrer ?? undefined, landing_page: `/${s.page_slug === "home" ? "" : s.page_slug}` }, occurredAt: s.created_at });
    await notifyOrgRoles(db, s.org_id, ["owner", "admin", "sales_rep", "support"], { kind: "system", severity: "info", title: `New ${label.toLowerCase()} from ${s.name || "a visitor"}`, body: (s.message || `${s.service ?? "General enquiry"}`).slice(0, 200), link: "/inbox", dedupeKey: `site-enquiry:${s.id}` });
    return "processed" as const;
  });
}

/** Turns received enquiries into contacts. Safe to run repeatedly and from several workers: each enquiry is claimed once and retried a bounded number of times. */
export async function processSubmissions(opts: { limit?: number } = {}): Promise<{ processed: number; spam: number; failed: number }> {
  const claimed = await withSystem(async (db) =>
    (await db.query<Claimed>(
      `update website_form_submissions set attempts = attempts + 1 where id in (
         select id from website_form_submissions where status = 'received' and attempts < $2 order by created_at limit $1 for update skip locked)
       returning id, org_id, website_id, name, email, phone, service, message, marketing_opt_in, consent_text, page_slug, host, purpose, utm, referrer, created_at`,
      [Math.min(50, opts.limit ?? 20), MAX_ATTEMPTS],
    )).rows,
  );
  const out = { processed: 0, spam: 0, failed: 0 };
  for (const s of claimed) {
    try {
      out[await processOne(s)] += 1;
    } catch {
      // Leave it received so the next run retries; give up for good after the last attempt.
      await withSystem((db) => db.query("update website_form_submissions set error = 'Processing failed; it will be retried.', status = case when attempts >= $2 then 'failed' else status end where id = $1", [s.id, MAX_ATTEMPTS])).catch(() => undefined);
      out.failed += 1;
    }
  }
  return out;
}
