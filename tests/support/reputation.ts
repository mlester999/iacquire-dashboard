// Synthetic fixtures for the reputation tests (private feedback, its follow-up, settings, jobs). Messages are queued, never dispatched, and nothing contacts a provider.
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { memberActor, type CrmActor } from "@/server/crm/actor";
import { createContact, setContactConsent } from "@/server/crm/contacts";
import { approveTemplate, createTemplate } from "@/server/crm/message-templates";
import { createReviewDestination, hashReviewToken, requestReview, reviewTokenFor, submitReviewFeedback } from "@/server/crm/reviews";
import { messagingOrg, phone, type MessagingOrg } from "./messaging";

export const one = async <T>(sql: string, params: unknown[] = []): Promise<T> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows[0] as T;
export const all = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows as T[];
export const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(sql, params)).n);

export interface ReputationShop {
  m: MessagingOrg;
  owner: CrmActor;
  manager: CrmActor;
  sales: CrmActor;
  support: CrmActor;
  viewer: CrmActor;
  smsTemplate: { id: string; contentHash: string };
  google: string;
  facebook: string;
}

/** Switches satisfaction surveys on (or off) for a workspace, the way a Super Admin does: org_features, feature "reputation_surveys". */
export async function setSurveys(orgId: string, enabled: boolean) {
  await withSystem((db) => db.query(
    "insert into org_features (org_id, feature, enabled) values ($1, 'reputation_surveys', $2) on conflict (org_id, feature) do update set enabled = excluded.enabled",
    [orgId, enabled],
  ));
}

/**
 * A messaging-ready workspace with one approved review-request text template and two active public review links. Surveys are switched on (they are dormant in a new
 * workspace); pass `{ surveys: false }` for one that never had them.
 */
export async function reputationShop(name: string, opts: { surveys?: boolean; credits?: number } = {}): Promise<ReputationShop> {
  const m = await messagingOrg({ name, provider: { sms: "twilio", email: "resend" }, ...(opts.credits === undefined ? {} : { credits: opts.credits }) });
  if (opts.surveys !== false) await setSurveys(m.org.id, true);
  const owner = memberActor(m.ctx("owner"));
  const sms = await createTemplate(owner, { name: "How did we do", channel: "sms", purpose: "service", body: "Hi {{contact.first_name}}, thanks for visiting {{business.name}}. How did we do? {{review.link}}" });
  const approved = await approveTemplate(owner, sms.id, { version: sms.currentVersion, contentHash: sms.contentHash });
  const google = await createReviewDestination(owner, { platform: "google", url: "https://g.page/r/CAbc123xyz/review" });
  const facebook = await createReviewDestination(owner, { platform: "facebook", label: "Review us on Facebook", url: "https://www.facebook.com/exampleshop/reviews" });
  return {
    m, owner, manager: memberActor(m.ctx("manager")), sales: memberActor(m.ctx("sales")), support: memberActor(m.ctx("support")), viewer: memberActor(m.ctx("viewer")),
    smsTemplate: { id: sms.id, contentHash: approved.contentHash }, google: google.id, facebook: facebook.id,
  };
}

/** A customer with a unique phone number, and (by default) consent to service texts. */
export async function shopCustomer(s: ReputationShop, opts: { firstName?: string; consent?: boolean; email?: string; ownerId?: string } = {}): Promise<string> {
  const c = await createContact(s.owner, { firstName: opts.firstName ?? "Maria", lastName: crypto.randomUUID().slice(0, 6), phone: phone(), email: opts.email, ownerId: opts.ownerId });
  if (opts.consent !== false) await setContactConsent(s.owner, c.id, { channel: "sms", purpose: "service", status: "granted", evidence: "Front desk sign-up sheet, 12 Oct." });
  return c.id;
}

/** The customer's token: derived from the request, and checked against the hash the request keeps. */
export async function tokenOf(requestId: string): Promise<string> {
  const r = await one<{ token_hash: string }>("select token_hash from crm_review_requests where id = $1", [requestId]);
  const token = reviewTokenFor(requestId);
  if (hashReviewToken(token) !== r.token_hash) throw new Error("the request's token doesn't match its hash");
  return token;
}

/** Sends a review request to the contact (queued, not dispatched) and returns its ids and the customer's token. */
export async function ask(s: ReputationShop, contactId: string) {
  const r = await requestReview(s.owner, { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false });
  return { ...r, token: await tokenOf(r.requestId) };
}

/** Asks and answers in one go: the customer's private feedback, saved through the real customer-page service. */
export async function giveFeedback(s: ReputationShop, contactId: string, input: { rating?: unknown; comment?: unknown }) {
  const asked = await ask(s, contactId);
  const result = await submitReviewFeedback(asked.token, input);
  return { ...asked, result };
}

/** Sends a survey (a request of kind "survey", on the chosen scale) to the contact: queued, not dispatched. */
export async function askSurvey(s: ReputationShop, contactId: string, scale: "csat5" | "nps10" = "csat5") {
  const r = await requestReview(s.owner, { contactId, templateId: s.smsTemplate.id, contentHash: s.smsTemplate.contentHash, businessHoursOnly: false, kind: "survey", scale });
  return { ...r, token: await tokenOf(r.requestId) };
}

/** Sends a survey and answers it in one go. */
export async function giveSurveyFeedback(s: ReputationShop, contactId: string, scale: "csat5" | "nps10", input: { rating?: unknown; comment?: unknown }) {
  const asked = await askSurvey(s, contactId, scale);
  const result = await submitReviewFeedback(asked.token, input);
  return { ...asked, result };
}

// ---------------------------------------------------------------------------
// Review request batches
// ---------------------------------------------------------------------------

/** Switches review request batches on (or off) for a workspace, the way a Super Admin does: org_features, feature "reputation_batches". */
export async function setBatches(orgId: string, enabled: boolean) {
  await withSystem((db) => db.query(
    "insert into org_features (org_id, feature, enabled) values ($1, 'reputation_batches', $2) on conflict (org_id, feature) do update set enabled = excluded.enabled",
    [orgId, enabled],
  ));
}

/** A day as YYYY-MM-DD, `daysAgo` days before now (UTC, which is every fixture workspace's time zone). */
export const dayAgo = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);

/** A visit a person marked attended, ended `daysAgo` days ago. Returns the appointment's id. */
export async function attend(s: ReputationShop, contactId: string, opts: { daysAgo?: number; status?: string; calendarId?: string | null; typeId?: string | null } = {}): Promise<string> {
  const ends = new Date(Date.now() - (opts.daysAgo ?? 3) * 86_400_000);
  const starts = new Date(ends.getTime() - 30 * 60_000);
  return (await one<{ id: string }>(
    `insert into appointment_refs (org_id, ghl_appointment_id, ghl_calendar_id, title, status, start_at, end_at, contact_id, calendar_ref, appointment_type_id)
     values ($1, $2, 'cal_batch_0001', 'Visit', $3, $4, $5, $6, $7, $8) returning id`,
    [s.m.org.id, `batch_${crypto.randomUUID()}`, opts.status ?? "showed", starts.toISOString(), ends.toISOString(), contactId, opts.calendarId ?? null, opts.typeId ?? null],
  )).id;
}

/** A pipeline of the workspace (the table GoHighLevel and the native CRM share). */
export async function pipelineFor(s: ReputationShop, name = "Sales"): Promise<string> {
  return (await one<{ id: string }>("insert into crm_pipelines (org_id, ghl_pipeline_id, name) values ($1, $2, $3) returning id", [s.m.org.id, `pl_${crypto.randomUUID().slice(0, 12)}`, name])).id;
}

/** A deal marked won `daysAgo` days ago. Returns the deal's id. */
export async function winDeal(s: ReputationShop, contactId: string, opts: { daysAgo?: number; pipelineId?: string | null; status?: string } = {}): Promise<string> {
  const closed = new Date(Date.now() - (opts.daysAgo ?? 3) * 86_400_000);
  return (await one<{ id: string }>(
    `insert into crm_opportunities (org_id, ghl_opportunity_id, name, status, contact_id, pipeline_ref, closed_at) values ($1, $2, 'Deal', $3, $4, $5, $6) returning id`,
    [s.m.org.id, `deal_${crypto.randomUUID().slice(0, 12)}`, opts.status ?? "won", contactId, opts.pipelineId ?? null, closed.toISOString()],
  )).id;
}

/** A calendar and one appointment type on it. */
export async function calendarWithType(s: ReputationShop, name: string, slug: string, typeName = "Check-up"): Promise<{ calendarId: string; typeId: string }> {
  const calendarId = (await one<{ id: string }>(
    "insert into crm_calendars (org_id, name, slug, is_default, public, created_by) values ($1, $2, $3, false, true, $4) returning id", [s.m.org.id, name, slug, s.m.people.owner.id],
  )).id;
  const typeId = (await one<{ id: string }>(
    `insert into crm_appointment_types (org_id, calendar_id, name, slug, duration_minutes, slot_interval_minutes, min_notice_minutes, max_days_ahead, location_kind, public)
     values ($1, $2, $3, $4, 30, 30, 0, 60, 'none', true) returning id`,
    [s.m.org.id, calendarId, typeName, `${slug}-type`],
  )).id;
  return { calendarId, typeId };
}

/** The batch input most tests start from: the last 30 days of attended visits, the shop's template, the standard pace. */
export function batchInput(s: ReputationShop, over: Partial<{ name: string; templateId: string; kind: "review" | "survey"; scale: "csat5" | "nps10"; criteria: unknown; ratePerMinute: number }> = {}) {
  return {
    name: "October visits", templateId: s.smsTemplate.id, criteria: { source: "appointments_showed", from: dayAgo(30), to: dayAgo(0) }, ...over,
  };
}
