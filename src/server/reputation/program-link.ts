import "server-only";
import crypto from "node:crypto";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { auditActor, systemActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { hashReviewToken, recentReviewRequest, reviewTokenFor, REVIEW_LINK_TTL_DAYS } from "@/server/crm/reviews";
import { contactAddress, getConsent, isSuppressed } from "@/server/messaging/contacts";
import { queueOutreach, type OutreachResult } from "@/server/messaging/outreach";
import { REVIEW_LINK_PLACEHOLDER } from "@/server/messaging/redact";
import { hasFeedbackLink, programMayCarryLink, renderLinkedStep, type ProgramKind, type ProgramPurpose } from "@/lib/retention";
import { SURVEYS_NOT_ENABLED_MESSAGE, surveysEnabledIn } from "@/server/reputation/entitlement";
import { reviewIncentiveFindings } from "@/lib/reputation/incentives";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";

// A retention program message that carries the customer's own private feedback link ({feedback_link}). It is an ordinary program message in every way (the same
// owner-approved wording, the same rule chain, the same frequency limits) with three additions, all about the link:
//  * it goes only by a channel the customer agreed to service messages on (consent exactly "granted" on that channel, not merely allowed by the send rules), to an address that
//    has not opted out;
//  * nobody is asked again inside the cool-down every review request and survey shares;
//  * the request behind the link is created in the same transaction as the queued message, so the message can never be dispatched without its link, and a message that is
//    withdrawn takes its request with it (src/server/retention/cancel.ts).
// Who is asked never depends on how the customer felt: this file reads the customer's contact details, their conversations, consent and opt-outs, and the requests already made.
// The guard test (tests/reputation-gating-guard.test.ts) reads this whole file to keep it so.

const CHANNEL_ORDER: Channel[] = ["sms", "whatsapp", "email"];
const blocked = (reason: string, detail: string): OutreachResult => ({ status: "blocked", reason, detail });

export interface LinkedStepInput {
  orgId: string;
  orgName: string;
  orgTimezone: string;
  contactId: string;
  contactName: string;
  agentId: string | null;
  programKind: ProgramKind;
  purpose: ProgramPurpose;
  /** The approved wording, with {feedback_link} where the link goes. */
  body: string;
  businessHoursOnly: boolean;
  approvalId: string | null;
  stepId: string;
  /** The attended appointment that started the program, when it did. */
  triggerRef: string | null;
  now: Date;
}

/** Where the customer could be reached, in the order the send path prefers: channels they wrote on lately first, then phone, WhatsApp and email. A website chat is never one. */
async function candidateChannels(db: Queryable, orgId: string, contactId: string): Promise<Channel[]> {
  const open = await db.query<{ channel: string }>(
    "select channel from conversations where org_id = $1 and contact_id = $2 and status <> 'closed' order by last_inbound_at desc nulls last, created_at",
    [orgId, contactId],
  );
  const out: Channel[] = [];
  for (const c of [...open.rows.map((r) => r.channel), ...CHANNEL_ORDER]) if ((CHANNEL_ORDER as string[]).includes(c) && !out.includes(c as Channel)) out.push(c as Channel);
  return out;
}

/**
 * The channels a private link may go by: an address on file that has not opted out, and service consent exactly "granted" on that channel. When there are none, the reason
 * that matters most: an address opted out (the customer's program ends), no address at all, or no consent on the channels that could be used.
 */
export async function linkChannels(db: Queryable, orgId: string, contactId: string): Promise<{ channels: Channel[]; reason: string; detail: string }> {
  const channels: Channel[] = [];
  let withAddress = 0;
  let optedOut = 0;
  for (const channel of await candidateChannels(db, orgId, contactId)) {
    const address = await contactAddress(db, orgId, contactId, channel);
    if (!address) continue;
    withAddress += 1;
    if (await isSuppressed(db, orgId, channel, address)) {
      optedOut += 1;
      continue;
    }
    if ((await getConsent(db, orgId, contactId, channel, "service")) === "granted") channels.push(channel);
  }
  if (channels.length) return { channels, reason: "", detail: "" };
  if (!withAddress) return { channels, reason: "no_contact_channel", detail: "There is no phone number or email address on file for this customer." };
  // An opt-out with no channel left that they agreed to is an answer: the customer's program ends rather than trying their other addresses.
  if (optedOut > 0) return { channels, reason: "suppressed", detail: "An address on file opted out or bounced, and there is no other channel they agreed to, so nothing can be sent." };
  return { channels, reason: "link_needs_consent", detail: "A private link is only sent to someone who agreed to service messages on that channel, and there is no such consent on record." };
}

/**
 * Queues one program message that carries the customer's own feedback link, inside the caller's transaction. Returns what the send path returned (queued, held as a draft, or
 * blocked with a reason). On queued or draft the request behind the link exists, linked to the message; on blocked nothing is left behind.
 */
export async function queueFeedbackLinkStep(db: Queryable, i: LinkedStepInput): Promise<OutreachResult> {
  if (!hasFeedbackLink(i.body) || !programMayCarryLink(i.programKind, i.purpose)) return blocked("link_not_allowed", "This program can't carry a private feedback link.");
  // The link starts a survey, which is dormant until a Super Admin switches surveys on for the workspace (src/server/reputation/entitlement.ts).
  if (!(await surveysEnabledIn(db, i.orgId))) return blocked("surveys_not_enabled", SURVEYS_NOT_ENABLED_MESSAGE);
  // The wording was checked when it was saved; checked again here so wording that got in some other way is never sent.
  const wording = reviewIncentiveFindings(i.body)[0];
  if (wording) return blocked("incentive_wording", wording.message);

  // A step that was already queued (the same transaction retried) keeps the request it has.
  const prior = (await db.query<{ id: string; has_request: boolean }>(
    "select m.id, exists (select 1 from crm_review_requests r where r.org_id = m.org_id and r.message_id = m.id) as has_request from conversation_messages m where m.org_id = $1 and m.dedupe_key = $2",
    [i.orgId, `retention:${i.stepId}`],
  )).rows[0];
  if (prior?.has_request) return { status: "queued", messageId: prior.id };

  const recent = await recentReviewRequest(db, i.orgId, i.contactId, i.now);
  if (recent) return blocked("recently_requested", `${i.contactName || "This customer"} was already asked on ${new Date(recent.created_at).toISOString().slice(0, 10)}, so no second link was sent.`);

  const picked = await linkChannels(db, i.orgId, i.contactId);
  if (!picked.channels.length) return blocked(picked.reason, picked.detail);

  const requestId = crypto.randomUUID();
  const token = reviewTokenFor(requestId);
  const body = renderLinkedStep(i.body, { name: i.contactName, business: i.orgName }, REVIEW_LINK_PLACEHOLDER);
  const appointmentId = i.triggerRef && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(i.triggerRef) ? i.triggerRef : null;

  let first: OutreachResult | null = null;
  for (const channel of picked.channels) {
    await db.query("savepoint program_link");
    const res = await queueOutreach(db, {
      orgId: i.orgId, contactId: i.contactId, agentId: i.agentId, scope: "retention", purpose: "service", channel, subject: i.orgName, approvalId: i.approvalId, now: i.now,
      body, dedupeKey: `retention:${i.stepId}`, disclose: true, businessHoursOnly: i.businessHoursOnly,
    });
    if (res.status === "blocked" || !res.messageId) {
      await db.query("rollback to savepoint program_link");
      await db.query("release savepoint program_link");
      first ??= res.status === "blocked" ? res : blocked("blocked", "The message couldn't be queued.");
      continue;
    }
    // The request is created with the message, so the dispatcher always finds it. It starts a survey: the customer's page, with the business's public review links
    // (whenever it has any) and a private question.
    await db.query(
      `insert into crm_review_requests (id, org_id, contact_id, channel, template_id, token_hash, status, message_id, appointment_id, requested_by, requested_via, created_at, expires_at, kind, scale)
       values ($1, $2, $3, $4, null, $5, 'queued', $6, (select a.id from appointment_refs a where a.id = $7::uuid and a.org_id = $2), null, 'program', $8::timestamptz,
               $8::timestamptz + make_interval(days => $9::int), 'survey', 'csat5')`,
      [requestId, i.orgId, i.contactId, channel, hashReviewToken(token), res.messageId, appointmentId, i.now.toISOString(), REVIEW_LINK_TTL_DAYS],
    );
    await db.query("release savepoint program_link");
    const actor = systemActor({ id: i.orgId, name: i.orgName, timezone: i.orgTimezone }, "Customer program");
    await emitEvent(db, actor, {
      type: "review.requested", entityType: "review_request", entityId: requestId, contactId: i.contactId,
      payload: { requestId, channel, templateId: null, templateVersion: null, via: "program", kind: "survey", scale: "csat5", appointmentId, opportunityId: null },
      dedupeKey: `review.requested:${requestId}`,
    });
    await recordActivity(db, actor, {
      kind: "review.requested", summary: `Survey requested by ${CHANNEL_LABELS[channel]}${res.status === "draft" ? " (held for approval)" : ""}`, contactId: i.contactId,
      refType: "review_request", refId: requestId, metadata: { via: "program", kind: "survey", program: i.programKind },
    });
    await recordAudit({
      orgId: i.orgId, ...auditActor(actor), action: "crm.review_requested", targetType: "crm_review_request", targetId: requestId, result: "success",
      metadata: { channel, via: "program", kind: "survey", scale: "csat5", program: i.programKind },
    }, db);
    return res;
  }
  return first ?? blocked("no_contact_channel", "There is no phone number or email address on file for this customer.");
}
