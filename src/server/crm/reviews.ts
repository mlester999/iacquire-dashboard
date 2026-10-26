import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { releaseReservation } from "@/server/billing/ledger";
import type { OutgoingEmail } from "@/server/email";
import { consumeRateLimit, type RateLimitRule } from "@/server/security/rate-limit";
import { assertCan, auditActor, crmRead, crmWrite, systemActor, type CrmActor } from "@/server/crm/actor";
import { emitEvent, recordActivity } from "@/server/crm/events";
import { loadApprovedTemplate, tokenValuesFor, type ApprovedTemplateVersion } from "@/server/crm/message-templates";
import { contactAddress, getConsent, isSuppressed } from "@/server/messaging/contacts";
import { evaluateSend, queueOutbound } from "@/server/messaging/send";
import { detectEscalationSignal } from "@/server/messaging/ingest";
import { REVIEW_LINK_PLACEHOLDER } from "@/server/messaging/redact";
import { changeFeedbackFollowUp, followThroughLowFeedback, sendFollowThroughEmails } from "@/server/reputation/feedback";
import { loadSettings, thresholdsOf } from "@/server/reputation/settings";
import { SURVEYS_NOT_ENABLED_MESSAGE, reviewsPublicDisabled, surveysEnabledIn } from "@/server/reputation/entitlement";
import { describeScore, isLowScore, isFeedbackScale, isRequestKind, parseScore, type FeedbackScale, type RequestKind } from "@/lib/reputation/scores";
import { reviewIncentiveFindings } from "@/lib/reputation/incentives";
import { withoutNegatedComplaints } from "@/lib/reputation/signals";
import { describeMissing, extractTokens, renderMessage } from "@/lib/messaging/tokens";
import { CHANNEL_LABELS, type Channel } from "@/lib/messaging";

// Reputation: the business's public review links, review requests sent to its customers, and the private feedback customers choose to
// give. Rules that hold everywhere here:
//
//  * Everyone who is asked sees the same public review links, whatever they tell the business privately. Nothing here (or on the
//    customer's page, src/app/r/[token]) ever hides, delays or reorders the public links because of a rating: feedback never gates who
//    may leave a public review. A low rating only ADDS an internal follow-up for the team (src/server/reputation/feedback.ts); who is asked for a
//    review never depends on how they felt (tests/reputation-gating-guard.test.ts reads this file's ask-selection code to keep it so).
//  * Private feedback stays private (customer_feedback): it is never published, never counted as a review, never shown to customers.
//    iAcquire never writes, invents or counts public reviews; it only knows whether a customer opened the link to a review site.
//  * A request is a service message about something the customer already had, sent through the same gated outbound path as every other
//    message (consent, opt-outs, quiet hours, frequency limits, credits). It is refused, with the reason, unless the contact has given
//    consent to service messages on that channel.
//  * The customer's link carries a token derived from the request id with a server key; only its sha256 is stored (crm_review_requests
//    .token_hash, unreadable by the app role). The queued message keeps {{review.link}}: the dispatcher fills the link in for the provider
//    call only (src/server/messaging/send.ts), so nobody who reads the conversation can answer as the customer.
//  * Google Business Profile reviews are not read or imported: that needs Google's approved API access (docs/voice-and-reviews.md).

export const REVIEW_PLATFORMS = ["google", "facebook", "yelp", "tripadvisor", "trustpilot", "other"] as const;
export type ReviewPlatform = (typeof REVIEW_PLATFORMS)[number];
export const REVIEW_PLATFORM_LABELS: Record<ReviewPlatform, string> = {
  google: "Google", facebook: "Facebook", yelp: "Yelp", tripadvisor: "Tripadvisor", trustpilot: "Trustpilot", other: "Other site",
};
export const isReviewPlatform = (v: unknown): v is ReviewPlatform => typeof v === "string" && (REVIEW_PLATFORMS as readonly string[]).includes(v);

/** crm_review_requests.status. */
export type ReviewRequestStatus = "pending" | "queued" | "sent" | "opened" | "feedback_received" | "review_link_clicked" | "failed" | "cancelled";
/** Where a request came from (crm_review_requests.requested_via). Only a person pressing Send is "manual"; a program step or a batch is automatic like a workflow or the API. */
export type ReviewRequestVia = "manual" | "workflow" | "api" | "program" | "batch";
export type FeedbackFollowUp = "new" | "acknowledged" | "escalated" | "resolved";
export const FEEDBACK_FOLLOW_UPS: readonly FeedbackFollowUp[] = ["new", "acknowledged", "escalated", "resolved"];

/** How long a customer's link accepts feedback. The public review links are shown on the page even after that. */
export const REVIEW_LINK_TTL_DAYS = 60;
/** One review request per contact in this many days (any channel), so nobody is asked again and again. */
export const REVIEW_REQUEST_COOLDOWN_DAYS = 30;
/**
 * The standing default for "low": ratings at or below this need a person's follow-up. A workspace can choose 1 to 3 (reputation_settings); the choice is made when the feedback
 * arrives and stored with it (customer_feedback.low_score). Low feedback never changes what the customer sees.
 */
export const ESCALATE_AT_OR_BELOW = 2;
export const MAX_DESTINATIONS = 10;
export const MAX_ACTIVE_DESTINATIONS = 6;
export const FEEDBACK_COMMENT_MAX = 2000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 32 random bytes, base64url: 43 characters. */
export const REVIEW_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const REVIEW_LINK_TOKEN = /\{\{\s*review\.link\s*\}\}/;
const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

// ---------------------------------------------------------------------------
// Tokens and links
// ---------------------------------------------------------------------------

/** A new random token in the shape of a customer's link (43 characters, base64url). */
export function newReviewToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

function reviewKeyFrom(secret: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("iacquire", "utf8"), Buffer.from("crm-review-link-v1", "utf8"), 32));
}

/** The key review links are derived with now, then retired keys a link queued before a key change may still have been made with. */
function reviewKeys(): Buffer[] {
  const e = env();
  const current = e.APP_ENCRYPTION_KEY;
  // env() refuses to start production without APP_ENCRYPTION_KEY; this fallback only exists for local development and tests.
  if (!current && e.NODE_ENV === "production") throw new Error("APP_ENCRYPTION_KEY is required to issue review links.");
  const previous = (e.APP_ENCRYPTION_KEY_PREVIOUS ?? "").split(",").map((k) => k.trim()).filter(Boolean);
  return [current ?? "iacquire-local-development-only-key", ...previous].map(reviewKeyFrom);
}

const tokenWith = (key: Buffer, requestId: string) => crypto.createHmac("sha256", key).update(`review-request:${requestId}`).digest("base64url");

/**
 * A review request's token: an HMAC of the request id with a server key (43 characters, like a random one). It is never stored: only its
 * sha256 is, and the dispatcher derives it again to put the link into the message just before handing it to the provider.
 */
export function reviewTokenFor(requestId: string): string {
  return tokenWith(reviewKeys()[0], requestId);
}

/**
 * The customer's link for the review request a queued message belongs to, for the provider call only. Derived again from the request id
 * and checked against the stored hash (so a link made with a retired key still matches). Null when the message isn't a review request's,
 * or the request was cancelled.
 */
export async function reviewLinkForMessage(db: Queryable, orgId: string, messageId: string): Promise<string | null> {
  const r = (await db.query<{ id: string; token_hash: string; status: ReviewRequestStatus }>(
    "select id, token_hash, status from crm_review_requests where org_id = $1 and message_id = $2 limit 1",
    [orgId, messageId],
  )).rows[0];
  if (!r || r.status === "cancelled") return null;
  for (const key of reviewKeys()) {
    const token = tokenWith(key, r.id);
    if (hashReviewToken(token) === r.token_hash) return reviewLinkUrl(token);
  }
  return null;
}

/** What is stored for a token: its sha256, hex. The token itself is never stored. */
export function hashReviewToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export const looksLikeReviewToken = (t: unknown): t is string => typeof t === "string" && REVIEW_TOKEN_RE.test(t);

/** The customer's page for a token: <APP_URL>/r/<token>. */
export function reviewLinkUrl(token: string): string {
  return new URL(`/r/${token}`, env().APP_URL).toString();
}

/**
 * True when an approved template's text carries the {{review.link}} token. Only the text counts: the link is filled in there for the
 * provider call, and a subject line (stored with the conversation) must never hold it.
 */
export function hasReviewLinkToken(t: { subject: string | null; body: string }): boolean {
  return REVIEW_LINK_TOKEN.test(t.body) && !(t.subject ? REVIEW_LINK_TOKEN.test(t.subject) : false);
}

/** How far along a request is. The stored status only ever moves forward (opening the page after leaving feedback keeps "feedback received"). */
const RANK: Record<ReviewRequestStatus, number> = { pending: 0, queued: 1, sent: 2, opened: 3, feedback_received: 4, review_link_clicked: 5, failed: -1, cancelled: -1 };

/**
 * The status shown for a request: the stored one, moved on by its message's own delivery state (sent, or failed / blocked) while the
 * customer hasn't opened it yet. Read when listing, so no background job has to copy delivery updates across.
 */
export function effectiveRequestStatus(stored: ReviewRequestStatus, messageStatus: string | null): ReviewRequestStatus {
  if (stored === "cancelled" || stored === "failed" || RANK[stored] >= RANK.opened) return stored;
  if (messageStatus === "sent" || messageStatus === "delivered" || messageStatus === "read") return "sent";
  if (messageStatus === "failed" || messageStatus === "blocked") return "failed";
  return stored;
}

// ---------------------------------------------------------------------------
// Review destinations
// ---------------------------------------------------------------------------

const PLATFORM_HOSTS: Record<Exclude<ReviewPlatform, "other">, RegExp> = {
  google: /(?:^|\.)(?:google\.[a-z]{2,3}(?:\.[a-z]{2})?|g\.page|goo\.gl)$/,
  facebook: /(?:^|\.)(?:facebook\.com|fb\.com|fb\.me)$/,
  yelp: /(?:^|\.)yelp\.[a-z]{2,3}(?:\.[a-z]{2})?$/,
  tripadvisor: /(?:^|\.)tripadvisor\.[a-z]{2,3}(?:\.[a-z]{2})?$/,
  trustpilot: /(?:^|\.)trustpilot\.com$/,
};

/**
 * Checks a public review link: https only, no credentials, a real host name (no IP address, no localhost), at most 500 characters,
 * and for a named platform a host that belongs to that platform, so a link labelled "Google" really goes to Google.
 */
export function validateDestinationUrl(platform: ReviewPlatform, raw: string): string {
  const s = (raw ?? "").trim();
  if (!s) throw new AppError("invalid_input", "Paste the link where customers leave a review.");
  if (s.length > 500) throw new AppError("invalid_input", "That link is too long (500 characters at most).");
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new AppError("invalid_input", "That isn't a full link. It should start with https://.");
  }
  if (u.protocol !== "https:") throw new AppError("invalid_input", "Review links must start with https://.");
  if (u.username || u.password) throw new AppError("invalid_input", "Review links can't contain a user name or password.");
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || /^[0-9.]+$/.test(host) || host.startsWith("[")) {
    throw new AppError("invalid_input", "Use the review site's own address, not an IP address or a local name.");
  }
  if (platform !== "other" && !PLATFORM_HOSTS[platform].test(host)) {
    throw new AppError("invalid_input", `That link isn't on ${REVIEW_PLATFORM_LABELS[platform]} (${host}). Choose the right site, or "Other site".`);
  }
  // Stored as the parser reads it: a lower-case scheme and host ("HTTPS://G.page/…" becomes "https://g.page/…"), as the database's own
  // check expects, so the same link is always stored (and recognised as already on the list) the same way.
  const normalized = u.href;
  if (!normalized.startsWith("https://")) throw new AppError("invalid_input", "Review links must start with https://.");
  if (normalized.length > 500) throw new AppError("invalid_input", "That link is too long (500 characters at most).");
  return normalized;
}

export interface ReviewDestinationView {
  id: string;
  platform: ReviewPlatform;
  label: string;
  url: string;
  active: boolean;
  position: number;
  createdAt: string;
  createdByName: string | null;
}

interface DestinationRow { id: string; platform: ReviewPlatform; label: string; url: string; active: boolean; position: number; created_at: Date; created_by_name: string | null }
const toDestination = (r: DestinationRow): ReviewDestinationView => ({
  id: r.id, platform: r.platform, label: r.label, url: r.url, active: r.active, position: r.position, createdAt: iso(r.created_at)!, createdByName: r.created_by_name,
});
const DESTINATION_SELECT = `select d.id, d.platform, d.label, d.url, d.active, d.position, d.created_at, nullif(u.full_name, '') as created_by_name
  from crm_review_destinations d left join users u on u.id = d.created_by`;

async function activeDestinations(db: Queryable, orgId: string): Promise<DestinationRow[]> {
  return (await db.query<DestinationRow>(`${DESTINATION_SELECT} where d.org_id = $1 and d.active order by d.position, d.created_at`, [orgId])).rows;
}

export async function listReviewDestinations(actor: CrmActor): Promise<ReviewDestinationView[]> {
  assertCan(actor, "crm.view");
  return crmRead(actor, async (db) => (await db.query<DestinationRow>(`${DESTINATION_SELECT} where d.org_id = $1 order by d.position, d.created_at`, [actor.orgId])).rows.map(toDestination));
}

/** Review links are the business's own public listings: someone in the client's own workspace (an owner or a manager) approves each one. */
function assertCanApproveLinks(actor: CrmActor) {
  assertCan(actor, "reviews.manage", "Only owners and managers can manage review links.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Review links are approved by someone in the client's own workspace. iAcquire support can look but not change them.");
}

export interface DestinationInput {
  platform: string;
  label?: string | null;
  url: string;
}

function cleanDestination(input: DestinationInput): { platform: ReviewPlatform; label: string; url: string } {
  if (!isReviewPlatform(input.platform)) throw new AppError("invalid_input", "Choose the review site.");
  const label = (input.label ?? "").replace(/\s+/g, " ").trim() || REVIEW_PLATFORM_LABELS[input.platform];
  if (label.length > 80) throw new AppError("invalid_input", "Keep the button text to 80 characters.");
  return { platform: input.platform, label, url: validateDestinationUrl(input.platform, input.url) };
}

export async function createReviewDestination(actor: CrmActor, input: DestinationInput): Promise<ReviewDestinationView> {
  assertCanApproveLinks(actor);
  const d = cleanDestination(input);
  return crmWrite(actor, async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtext('crm_review_destinations:' || $1))", [actor.orgId]);
    const counts = await db.query<{ total: string; active: string; next: number }>(
      "select count(*)::text as total, count(*) filter (where active)::text as active, coalesce(max(position), -1) + 1 as next from crm_review_destinations where org_id = $1",
      [actor.orgId],
    );
    if (Number(counts.rows[0].total) >= MAX_DESTINATIONS) throw new AppError("conflict", `A workspace can keep up to ${MAX_DESTINATIONS} review links. Remove one first.`);
    const active = Number(counts.rows[0].active) < MAX_ACTIVE_DESTINATIONS;
    const dup = await db.query("select 1 from crm_review_destinations where org_id = $1 and url = $2", [actor.orgId, d.url]);
    if (dup.rows.length) throw new AppError("conflict", "That link is already on the list.");
    const { rows } = await db.query<{ id: string }>(
      "insert into crm_review_destinations (org_id, platform, label, url, active, position, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [actor.orgId, d.platform, d.label, d.url, active, Number(counts.rows[0].next), actor.userId],
    );
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.review_destination_added", targetType: "crm_review_destination", targetId: rows[0].id, result: "success", metadata: { platform: d.platform, host: new URL(d.url).hostname, active } }, db);
    return toDestination((await db.query<DestinationRow>(`${DESTINATION_SELECT} where d.id = $1 and d.org_id = $2`, [rows[0].id, actor.orgId])).rows[0]);
  });
}

async function loadDestination(db: Queryable, orgId: string, id: string, lock = false): Promise<DestinationRow> {
  if (!UUID.test(id)) throw new AppError("not_found", "Review link not found.");
  if (lock) await db.query("select 1 from crm_review_destinations where id = $1 and org_id = $2 for update", [id, orgId]);
  const r = (await db.query<DestinationRow>(`${DESTINATION_SELECT} where d.id = $1 and d.org_id = $2`, [id, orgId])).rows[0];
  if (!r) throw new AppError("not_found", "Review link not found.");
  return r;
}

export async function updateReviewDestination(actor: CrmActor, id: string, input: DestinationInput): Promise<ReviewDestinationView> {
  assertCanApproveLinks(actor);
  const d = cleanDestination(input);
  return crmWrite(actor, async (db) => {
    await loadDestination(db, actor.orgId, id, true);
    const dup = await db.query("select 1 from crm_review_destinations where org_id = $1 and url = $2 and id <> $3", [actor.orgId, d.url, id]);
    if (dup.rows.length) throw new AppError("conflict", "That link is already on the list.");
    await db.query("update crm_review_destinations set platform = $3, label = $4, url = $5 where id = $1 and org_id = $2", [id, actor.orgId, d.platform, d.label, d.url]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.review_destination_changed", targetType: "crm_review_destination", targetId: id, result: "success", metadata: { platform: d.platform, host: new URL(d.url).hostname } }, db);
    return toDestination(await loadDestination(db, actor.orgId, id));
  });
}

export async function setReviewDestinationActive(actor: CrmActor, id: string, active: boolean): Promise<ReviewDestinationView> {
  assertCanApproveLinks(actor);
  return crmWrite(actor, async (db) => {
    const cur = await loadDestination(db, actor.orgId, id, true);
    if (cur.active === active) return toDestination(cur);
    if (active) {
      const n = await db.query<{ n: string }>("select count(*)::text as n from crm_review_destinations where org_id = $1 and active", [actor.orgId]);
      if (Number(n.rows[0].n) >= MAX_ACTIVE_DESTINATIONS) throw new AppError("conflict", `Customers see at most ${MAX_ACTIVE_DESTINATIONS} review links. Hide one first.`);
    }
    await db.query("update crm_review_destinations set active = $3 where id = $1 and org_id = $2", [id, actor.orgId, active]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: active ? "crm.review_destination_shown" : "crm.review_destination_hidden", targetType: "crm_review_destination", targetId: id, result: "success" }, db);
    return toDestination(await loadDestination(db, actor.orgId, id));
  });
}

/** Moves a link one place up or down in the order customers see them. */
export async function moveReviewDestination(actor: CrmActor, id: string, direction: "up" | "down"): Promise<void> {
  assertCanApproveLinks(actor);
  await crmWrite(actor, async (db) => {
    await db.query("select pg_advisory_xact_lock(hashtext('crm_review_destinations:' || $1))", [actor.orgId]);
    const all = (await db.query<{ id: string }>("select id from crm_review_destinations where org_id = $1 order by position, created_at", [actor.orgId])).rows.map((r) => r.id);
    const i = all.indexOf(id);
    if (i < 0) throw new AppError("not_found", "Review link not found.");
    const j = direction === "up" ? i - 1 : i + 1;
    if (j < 0 || j >= all.length) return;
    [all[i], all[j]] = [all[j], all[i]];
    for (const [pos, rid] of all.entries()) await db.query("update crm_review_destinations set position = $3 where id = $1 and org_id = $2", [rid, actor.orgId, pos]);
  });
}

export async function deleteReviewDestination(actor: CrmActor, id: string): Promise<void> {
  assertCanApproveLinks(actor);
  await crmWrite(actor, async (db) => {
    const cur = await loadDestination(db, actor.orgId, id, true);
    await db.query("delete from crm_review_destinations where id = $1 and org_id = $2", [id, actor.orgId]);
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.review_destination_removed", targetType: "crm_review_destination", targetId: id, result: "success", metadata: { platform: cur.platform } }, db);
  });
}

// ---------------------------------------------------------------------------
// Review request templates and preview
// ---------------------------------------------------------------------------

export interface ReviewTemplateOption {
  id: string;
  name: string;
  channel: Channel;
  version: number;
  subject: string | null;
  body: string;
  contentHash: string;
  purpose: "service" | "marketing";
}

/** Approved templates whose approved wording has {{review.link}}: the only ones a review request can be sent with. */
export async function listReviewTemplates(actor: CrmActor): Promise<ReviewTemplateOption[]> {
  assertCan(actor, "crm.view");
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; name: string; channel: Channel; version: number; subject: string | null; body: string; content_hash: string; purpose: "service" | "marketing" }>(
      `select t.id, t.name, t.channel, v.version, v.subject, v.body, v.content_hash, t.purpose
       from crm_message_templates t join crm_message_template_versions v on v.template_id = t.id and v.org_id = t.org_id and v.version = t.approved_version
       where t.org_id = $1 and t.kind = 'template' and t.status = 'approved' and t.archived_at is null and t.channel is not null order by lower(t.name)`,
      [actor.orgId],
    );
    return rows
      .filter((r) => hasReviewLinkToken(r))
      .map((r) => ({ id: r.id, name: r.name, channel: r.channel, version: r.version, subject: r.subject, body: r.body, contentHash: r.content_hash, purpose: r.purpose }));
  });
}

export interface ReviewRequestCheck {
  label: string;
  ok: boolean;
  detail: string;
}

export interface ReviewRequestPreview {
  contact: { id: string; name: string };
  template: { id: string; name: string; channel: Channel; version: number };
  subject: string | null;
  /** The message with "[review link]" where the customer's own link goes (it is only created when the request is sent). */
  body: string;
  checks: ReviewRequestCheck[];
  canSend: boolean;
  /** Why it can't be sent, when it can't. */
  problem: string | null;
}

/**
 * The most recent request to this customer (a review request or a survey, from any source) that still counts against the cool-down, or null. A request that never reached
 * the customer (cancelled, or its message failed or was blocked) doesn't count. One place, so a person's request, a workflow's and a program's all wait the same time.
 */
export async function recentReviewRequest(db: Queryable, orgId: string, contactId: string, now: Date): Promise<{ created_at: Date } | null> {
  const r = (await db.query<{ created_at: Date }>(
    `select r.created_at from crm_review_requests r left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
     where r.org_id = $1 and r.contact_id = $2 and r.status not in ('failed', 'cancelled') and coalesce(m.status, '') not in ('failed', 'blocked')
       and r.created_at > $3::timestamptz - make_interval(days => $4::int) order by r.created_at desc limit 1`,
    [orgId, contactId, now.toISOString(), REVIEW_REQUEST_COOLDOWN_DAYS],
  )).rows[0];
  return r ?? null;
}

interface Prepared {
  /** paused: a person's own hold on automated messages to this customer (contacts.retention_paused). It stops automated asks, never a person pressing Send. */
  contact: { id: string; name: string; ownerId: string | null; paused: boolean };
  template: ApprovedTemplateVersion;
  address: string | null;
  checks: ReviewRequestCheck[];
  problem: { reason: string; detail: string } | null;
}

/**
 * The checks every review request passes before anything is created, in the order a person reads them: the contact, the template, the
 * review links, the contact's address, opt-outs, consent and how recently they were asked. Quiet hours, frequency limits, the channel and
 * credits are decided by the send path itself.
 */
async function prepareRequest(db: Queryable, orgId: string, input: { contactId: string; templateId: string; contentHash?: string | null; kind?: RequestKind; now: Date }): Promise<Prepared> {
  if (!UUID.test(input.contactId)) throw new AppError("not_found", "Contact not found.");
  const c = (await db.query<{ id: string; display_name: string; assigned_user_id: string | null; archived_at: Date | null; retention_paused: boolean }>(
    "select id, display_name, assigned_user_id, archived_at, retention_paused from contacts where id = $1 and org_id = $2 and deleted_at is null",
    [input.contactId, orgId],
  )).rows[0];
  if (!c) throw new AppError("not_found", "Contact not found.");
  const template = await loadApprovedTemplate(db, orgId, { id: input.templateId, contentHash: input.contentHash ?? undefined });
  if (!template) throw new AppError("conflict", "That template isn't approved (or its approved wording changed). Choose an approved template.");
  const name = c.display_name || "This contact";
  const checks: ReviewRequestCheck[] = [];
  let problem: Prepared["problem"] = null;
  const fail = (reason: string, detail: string) => {
    problem ??= { reason, detail };
  };
  const channelLabel = CHANNEL_LABELS[template.channel];

  // A survey is dormant until a Super Admin switches surveys on for the workspace (src/server/reputation/entitlement.ts). Review requests are not affected.
  if (input.kind === "survey" && !(await surveysEnabledIn(db, orgId))) {
    checks.push({ label: "Surveys", ok: false, detail: SURVEYS_NOT_ENABLED_MESSAGE });
    fail("surveys_not_enabled", SURVEYS_NOT_ENABLED_MESSAGE);
  }

  const linkOk = hasReviewLinkToken(template);
  checks.push({ label: "Review link in the message", ok: linkOk, detail: linkOk ? "The template has {{review.link}}, which becomes this customer's own link." : "The template doesn't have {{review.link}}, so the customer would get no link." });
  if (!linkOk) fail("no_review_link", "The template doesn't contain {{review.link}}. Add it to the template and approve it again.");
  if (template.purpose !== "service") fail("marketing_template", "Review requests are service messages. Choose a template whose purpose is service, not marketing.");
  // Rule R4: nothing offered in return for feedback or a review, and no asking for a particular rating. Templates can't be saved that way; this stops one that got through
  // (an older template, or wording changed some other way) from being sent.
  const wording = reviewIncentiveFindings(`${template.subject ?? ""}\n${template.body}`);
  if (wording.length) {
    checks.push({ label: "Wording", ok: false, detail: wording[0].message });
    fail("incentive_wording", `${wording[0].message} Edit the template and approve it again.`);
  }

  // A survey may go to customers of a business with no review site yet: the page then shows only the private questions. A review request needs the links it is for.
  const dests = await activeDestinations(db, orgId);
  const needsLinks = input.kind !== "survey";
  checks.push({ label: "Public review links", ok: dests.length > 0 || !needsLinks, detail: dests.length ? dests.map((d) => d.label).join(", ") : needsLinks ? "No review links are switched on yet." : "None switched on: the page shows only the questions." });
  if (!dests.length && needsLinks) fail("no_destinations", "Add at least one public review link first. Every customer you ask sees the same links.");

  if (c.archived_at) {
    checks.push({ label: "Contact", ok: false, detail: `${name} is archived.` });
    fail("contact_archived", `${name} is archived. Restore the contact to ask for a review.`);
  }

  const address = await contactAddress(db, orgId, c.id, template.channel);
  checks.push({ label: `${channelLabel} address`, ok: Boolean(address), detail: address ?? `There is no ${template.channel === "email" ? "email address" : "phone number"} on file.` });
  if (!address) fail("contact_unreachable", `${name} has no ${template.channel === "email" ? "email address" : "phone number"} on file.`);
  else if (await isSuppressed(db, orgId, template.channel, address)) {
    checks.push({ label: "Opted out", ok: false, detail: `${address} opted out or bounced.` });
    fail("suppressed", `${address} opted out or bounced, so nothing can be sent to it.`);
  }

  const consent = await getConsent(db, orgId, c.id, template.channel, "service");
  checks.push({
    label: `Consent to ${channelLabel} messages`,
    ok: consent === "granted",
    detail: consent === "granted" ? "Recorded." : consent === "revoked" ? "Withdrawn." : "Nothing on record.",
  });
  if (consent === "revoked") fail("no_consent", `${name} withdrew consent to ${channelLabel} messages, so they can't be asked for a review this way.`);
  else if (consent !== "granted") fail("no_consent", `There is no consent on record for ${name} to receive ${channelLabel} messages. Record their consent on the contact first, or use another channel they agreed to.`);

  const recent = await recentReviewRequest(db, orgId, c.id, input.now);
  const again = recent ? new Date(new Date(recent.created_at).getTime() + REVIEW_REQUEST_COOLDOWN_DAYS * 86_400_000) : null;
  checks.push({ label: "Not asked recently", ok: !recent, detail: recent ? `Asked on ${new Date(recent.created_at).toISOString().slice(0, 10)}.` : `No request in the last ${REVIEW_REQUEST_COOLDOWN_DAYS} days.` });
  if (recent) fail("recently_requested", `${name} was already asked for a review on ${new Date(recent.created_at).toISOString().slice(0, 10)}. They can be asked again from ${again!.toISOString().slice(0, 10)}.`);

  return { contact: { id: c.id, name, ownerId: c.assigned_user_id, paused: c.retention_paused }, template, address, checks, problem };
}

/**
 * Read-only: why a review request to this contact with this template would be refused before it reaches the send path (no review link,
 * no public links, no address, opted out, no consent, asked recently), or null. Quiet hours, limits and credits are decided when it sends.
 */
export async function reviewRequestProblem(db: Queryable, orgId: string, input: { contactId: string; templateId: string; contentHash?: string | null; kind?: RequestKind; now?: Date }): Promise<{ reason: string; detail: string } | null> {
  try {
    return (await prepareRequest(db, orgId, { ...input, now: input.now ?? new Date() })).problem;
  } catch (err) {
    if (err instanceof AppError) return { reason: err.code === "not_found" ? "not_found" : "template_changed", detail: err.message };
    throw err;
  }
}

/** What a review request to this contact would say and whether it can be sent, before anything is created. */
export async function previewReviewRequest(actor: CrmActor, input: { contactId: string; templateId: string; kind?: RequestKind }): Promise<ReviewRequestPreview> {
  assertCan(actor, "reviews.manage", "Sending review requests needs the review management permission.");
  assertCan(actor, "contacts.view");
  // The person can open this contact (checked under their own access first); the rest is read with trusted access.
  await crmRead(actor, async (db) => {
    if (!UUID.test(input.contactId) || !(await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contactId, actor.orgId])).rows.length) {
      throw new AppError("not_found", "Contact not found.");
    }
  });
  return withSystem(async (db) => {
    const now = new Date();
    const p = await prepareRequest(db, actor.orgId, { contactId: input.contactId, templateId: input.templateId, kind: input.kind, now });
    const values = await tokenValuesFor(db, actor.orgId, { contactId: p.contact.id, senderUserId: actor.userId, timezone: actor.timezone, now });
    values.values["review.link"] = "[review link]";
    const out = renderMessage({ subject: p.template.subject, body: p.template.body }, values.values, { customValues: values.customValues });
    const checks = [...p.checks];
    let problem = p.problem?.detail ?? null;
    if (!out.ok) {
      const detail = describeMissing(out.missing, out.unknown, values.customValues);
      checks.push({ label: "Message details", ok: false, detail });
      problem ??= detail;
    }
    return {
      contact: { id: p.contact.id, name: p.contact.name },
      template: { id: p.template.templateId, name: p.template.name, channel: p.template.channel, version: p.template.version },
      subject: out.subject,
      body: out.body,
      checks,
      canSend: !problem,
      problem,
    };
  });
}

// ---------------------------------------------------------------------------
// Sending a review request
// ---------------------------------------------------------------------------

export interface ReviewRequestInput {
  contactId: string;
  templateId: string;
  /** The approved wording the caller saw (or a workflow was published with). When it changed since, nothing is sent. */
  contentHash?: string | null;
  appointmentId?: string | null;
  opportunityId?: string | null;
  /** Hold the message until business hours (quiet hours always apply). Default true. */
  businessHoursOnly?: boolean;
  /** A review request (the default) or a survey: the same page and the same send path. */
  kind?: RequestKind;
  /** The scale the page asks on: one to five (the default) or zero to ten. */
  scale?: FeedbackScale;
}

export type ReviewRequestResult =
  | { status: "queued"; requestId: string; messageId: string; duplicate?: boolean }
  | { status: "blocked"; reason: string; detail: string; requestId?: string | null; messageId?: string | null };

/**
 * Creates one review request and queues its message, inside the caller's transaction. Every refusal is reported with its reason; when
 * `throwOnRefusal` is set (a person pressing Send) it is thrown instead, and nothing at all is left behind.
 *
 * The message goes through queueOutbound as a "system" send acting on the person's (or the approved workflow's) recorded decision, with
 * scope "retention" (the same frequency limit as other customer program messages, business hours by default) and purpose "service".
 */
export async function queueReviewRequestInTx(
  db: Queryable,
  actor: CrmActor,
  input: ReviewRequestInput,
  opts: { via: ReviewRequestVia; requestedBy: string | null; dedupeKey?: string | null; causedBy?: { eventId: number; depth: number } | null; throwOnRefusal?: boolean; now?: Date; batchId?: string | null },
): Promise<ReviewRequestResult> {
  const now = opts.now ?? new Date();
  const orgId = actor.orgId;
  const refuse = (reason: string, detail: string): ReviewRequestResult => {
    if (opts.throwOnRefusal) throw new AppError("conflict", detail);
    return { status: "blocked", reason, detail };
  };
  if (input.kind !== undefined && !isRequestKind(input.kind)) throw new AppError("invalid_input", "Choose a review request or a survey.");
  if (input.scale !== undefined && !isFeedbackScale(input.scale)) throw new AppError("invalid_input", "Choose a scale of one to five or zero to ten.");
  const kind: RequestKind = input.kind ?? "review";
  const scale: FeedbackScale = input.scale ?? "csat5";
  // A retry of the same workflow step (or a double submit with the same key) gets the request it already made.
  if (opts.dedupeKey) {
    const prior = (await db.query<{ id: string; request_id: string | null }>(
      "select m.id, r.id as request_id from conversation_messages m left join crm_review_requests r on r.message_id = m.id and r.org_id = m.org_id where m.org_id = $1 and m.dedupe_key = $2",
      [orgId, opts.dedupeKey],
    )).rows[0];
    if (prior?.request_id) return { status: "queued", requestId: prior.request_id, messageId: prior.id, duplicate: true };
  }
  // One request per contact at a time: concurrent requests for the same person queue up here, so the cool-down can't be raced.
  await db.query("select 1 from contacts where id = $1 and org_id = $2 for update", [UUID.test(input.contactId) ? input.contactId : "00000000-0000-0000-0000-000000000000", orgId]);
  const p = await prepareRequest(db, orgId, { contactId: input.contactId, templateId: input.templateId, contentHash: input.contentHash, kind, now });
  if (p.problem) return refuse(p.problem.reason, p.problem.detail);
  // A person's own hold on automated messages to this customer (for example during a dispute) stops an automated ask: a workflow, a program or the API. It is that
  // person's explicit choice, audited when it was set and counted here; nothing sets it automatically, and a person pressing Send is not stopped by it.
  if (opts.via !== "manual" && p.contact.paused) {
    await recordAudit({ orgId, ...auditActor(actor), action: "crm.review_request_held", targetType: "contact", targetId: p.contact.id, result: "denied", metadata: { via: opts.via, reason: "held_by_person" } }, db);
    return refuse("held_by_person", `${p.contact.name} is excluded from automatic messages by a person on your team, so this automatic review request was not sent.`);
  }
  const t = p.template;
  for (const [table, id, what] of [["appointment_refs", input.appointmentId, "Appointment"], ["crm_opportunities", input.opportunityId, "Deal"]] as const) {
    if (id && (!UUID.test(id) || !(await db.query(`select 1 from ${table} where id = $1 and org_id = $2`, [id, orgId])).rows.length)) throw new AppError("not_found", `${what} not found.`);
  }

  // The request's id comes first: the customer's token is derived from it. The message is rendered with a link of the real length (so
  // nothing is laid out for a shorter text), and that link is then replaced by {{review.link}}: the stored message never holds it, and
  // the dispatcher fills it in for the provider call only.
  const requestId = crypto.randomUUID();
  const token = reviewTokenFor(requestId);
  const sizing = reviewLinkUrl("x".repeat(43));
  const values = await tokenValuesFor(db, orgId, { contactId: p.contact.id, senderUserId: opts.requestedBy, timezone: actor.timezone, now });
  values.values["review.link"] = sizing;
  const filled = renderMessage({ subject: t.subject, body: t.body }, values.values, { customValues: values.customValues });
  if (!filled.ok) return refuse("missing_values", `${describeMissing(filled.missing, filled.unknown, values.customValues)} The review request wasn't sent.`);
  // The text must carry the customer's own link (a template can't lose it on the way), and the subject never does.
  if (!filled.body.includes(sizing) || (filled.subject ?? "").includes(sizing)) return refuse("no_review_link", "The message text wouldn't contain the customer's review link, so it wasn't sent.");
  if (extractTokens(filled.body).length) return refuse("missing_values", "The message still has placeholders, so it wasn't sent.");
  const rendered = { subject: filled.subject, body: filled.body.split(sizing).join(REVIEW_LINK_PLACEHOLDER) };

  // Everything below is undone together if the send path refuses the message.
  await db.query("savepoint crm_review_request");
  try {
    const existing = (await db.query<{ id: string }>(
      "select id from conversations where org_id = $1 and contact_id = $2 and channel = $3 and status <> 'closed' order by last_message_at desc nulls last, created_at limit 1",
      [orgId, p.contact.id, t.channel],
    )).rows[0];
    // A new conversation is the team's, not an AI employee's: a customer who replies to a review request reaches a person.
    const conversationId = existing?.id ?? (await db.query<{ id: string }>(
      `insert into conversations (org_id, contact_id, channel, status, subject, owner_kind) values ($1, $2, $3, 'open', $4, 'unassigned')
       on conflict (org_id, contact_id, channel, thread_key) do update set updated_at = now() returning id`,
      [orgId, p.contact.id, t.channel, (rendered.subject ?? t.name).slice(0, 300)],
    )).rows[0].id;
    const send = {
      orgId, conversationId, scope: "retention" as const, purpose: "service" as const, actor: { kind: "system" as const, userId: opts.requestedBy },
      body: rendered.body, now, businessHoursOnly: input.businessHoursOnly !== false, templateId: t.channel === "whatsapp" ? t.whatsappTemplateId : null,
    };
    const decision = await evaluateSend(db, send);
    const waiting = !decision.allow && Boolean(decision.retryAt) && !decision.permanent;
    if (!decision.allow && !waiting) {
      await db.query("rollback to savepoint crm_review_request");
      return refuse(decision.reason, decision.detail);
    }
    await db.query(
      `insert into crm_review_requests (id, org_id, contact_id, channel, template_id, token_hash, status, appointment_id, opportunity_id, requested_by, requested_via, created_at, expires_at, kind, scale, batch_id)
       values ($12, $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10::timestamptz, $10::timestamptz + make_interval(days => $11::int), $13, $14, $15)`,
      [orgId, p.contact.id, t.channel, t.templateId, hashReviewToken(token), input.appointmentId ?? null, input.opportunityId ?? null, opts.requestedBy, opts.via, now.toISOString(), REVIEW_LINK_TTL_DAYS, requestId, kind, scale, opts.batchId ?? null],
    );
    const queued = await queueOutbound(db, { ...send, dedupeKey: opts.dedupeKey ?? `review:${requestId}` });
    if (queued.status !== "queued") {
      await db.query("rollback to savepoint crm_review_request");
      return refuse(queued.reason ?? "blocked", queued.detail ?? "The message couldn't be queued.");
    }
    await db.query("update crm_review_requests set status = 'queued', message_id = $3 where id = $1 and org_id = $2", [requestId, orgId, queued.messageId]);
    await db.query("release savepoint crm_review_request");
    await emitEvent(db, actor, {
      type: "review.requested", entityType: "review_request", entityId: requestId, contactId: p.contact.id,
      payload: { requestId, channel: t.channel, templateId: t.templateId, templateVersion: t.version, via: opts.via, kind, scale, appointmentId: input.appointmentId ?? null, opportunityId: input.opportunityId ?? null },
      dedupeKey: `review.requested:${requestId}`, causedBy: opts.causedBy ?? null,
    });
    await recordActivity(db, actor, {
      kind: "review.requested", summary: `${kind === "survey" ? "Survey" : "Review"} requested by ${CHANNEL_LABELS[t.channel]}${waiting ? " (waiting for the next sending window)" : ""}`, contactId: p.contact.id,
      opportunityId: input.opportunityId ?? null, refType: "review_request", refId: requestId, metadata: { template: t.name, version: t.version, via: opts.via, kind },
    });
    await recordAudit({ orgId, ...auditActor(actor), action: "crm.review_requested", targetType: "crm_review_request", targetId: requestId, result: "success", metadata: { channel: t.channel, templateId: t.templateId, version: t.version, via: opts.via, kind, scale } }, db);
    return { status: "queued", requestId, messageId: queued.messageId };
  } catch (err) {
    await db.query("rollback to savepoint crm_review_request").catch(() => undefined);
    throw err;
  }
}

/** A person asks one customer for a review. Refusals (no consent, opted out, asked recently, quiet-hours aside) are thrown with the reason. */
export async function requestReview(actor: CrmActor, input: ReviewRequestInput): Promise<{ requestId: string; messageId: string }> {
  assertCan(actor, "reviews.manage", "Sending review requests needs the review management permission.");
  assertCan(actor, "contacts.view");
  // Messaging a customer is the client's own decision: iAcquire support never sends on their behalf.
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Review requests are sent by someone in the client's own workspace. iAcquire support can't send them.");
  await crmRead(actor, async (db) => {
    if (!UUID.test(input.contactId) || !(await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [input.contactId, actor.orgId])).rows.length) {
      throw new AppError("not_found", "Contact not found.");
    }
  });
  const r = await crmWrite(actor, (db) => queueReviewRequestInTx(db, actor, input, { via: "manual", requestedBy: actor.userId, throwOnRefusal: true }));
  if (r.status !== "queued") throw new AppError("conflict", r.detail);
  return { requestId: r.requestId, messageId: r.messageId };
}

/**
 * Cancels a request whose message hasn't gone out yet: the queued message is withdrawn (its credit hold released) and the link stops
 * accepting feedback. A request that was already sent can't be called back.
 */
export async function cancelReviewRequest(actor: CrmActor, id: string): Promise<void> {
  assertCan(actor, "reviews.manage", "Cancelling review requests needs the review management permission.");
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Only someone in the client's own workspace can cancel a review request.");
  if (!UUID.test(id)) throw new AppError("not_found", "Review request not found.");
  await crmWrite(actor, async (db) => {
    const r = (await db.query<{ status: ReviewRequestStatus; message_id: string | null; contact_id: string }>("select status, message_id, contact_id from crm_review_requests where id = $1 and org_id = $2 for update", [id, actor.orgId])).rows[0];
    if (!r) throw new AppError("not_found", "Review request not found.");
    if (r.status === "cancelled") return;
    if (r.status !== "pending" && r.status !== "queued") throw new AppError("conflict", "This request was already sent, so it can't be cancelled.");
    if (r.message_id) {
      // Only a message still waiting can be withdrawn; the dispatcher claims messages with the same status check, so exactly one side wins.
      const m = (await db.query<{ reservation_id: string | null }>(
        "update conversation_messages set status = 'blocked', blocked_reason = 'cancelled', status_detail = 'The review request was cancelled before it was sent.' where id = $1 and org_id = $2 and status = 'queued' returning reservation_id",
        [r.message_id, actor.orgId],
      )).rows[0];
      if (!m) throw new AppError("conflict", "The message is already on its way, so this request can't be cancelled.");
      if (m.reservation_id) await releaseReservation(db, { orgId: actor.orgId, reservationId: m.reservation_id, reason: "Review request cancelled" });
    }
    await db.query("update crm_review_requests set status = 'cancelled' where id = $1 and org_id = $2", [id, actor.orgId]);
    await recordActivity(db, actor, { kind: "review.cancelled", summary: "Review request cancelled before it was sent", contactId: r.contact_id, refType: "review_request", refId: id });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "crm.review_request_cancelled", targetType: "crm_review_request", targetId: id, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Lists and reporting
// ---------------------------------------------------------------------------

export interface FeedbackSummary {
  id: string;
  /** The one-to-five rating; null when the answer was on the zero-to-ten scale or was only a comment. */
  rating: number | null;
  /** The zero-to-ten score; null on the other scale or for a comment alone. */
  npsScore: number | null;
  scale: FeedbackScale;
  comment: string | null;
  receivedAt: string;
  followUpStatus: FeedbackFollowUp;
  escalatedTaskId: string | null;
  /** Whether it was low when it arrived, by the workspace's settings of that moment. */
  lowScore: boolean;
}

export interface ReviewRequestView {
  id: string;
  contact: { id: string; name: string } | null;
  channel: Channel;
  templateName: string | null;
  /** A review request or a survey, and the scale it asks on. */
  kind: RequestKind;
  scale: FeedbackScale;
  status: ReviewRequestStatus;
  requestedVia: ReviewRequestVia;
  requestedByName: string | null;
  createdAt: string;
  sentAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  expiresAt: string;
  expired: boolean;
  messageDetail: string | null;
  feedback: FeedbackSummary | null;
}

interface RequestRow {
  id: string; contact_id: string | null; contact_name: string | null; channel: Channel; template_name: string | null; status: ReviewRequestStatus; requested_via: ReviewRequestVia;
  requested_by_name: string | null; created_at: Date; sent_at: Date | null; opened_at: Date | null; clicked_at: Date | null; expires_at: Date; message_status: string | null;
  message_sent_at: Date | null; message_detail: string | null; f_id: string | null; f_rating: number | null; f_comment: string | null; f_received_at: Date | null; f_follow_up: FeedbackFollowUp | null; f_task: string | null;
  f_low: boolean | null; f_nps: number | null; f_scale: FeedbackScale | null; kind: RequestKind; scale: FeedbackScale;
}

export const REQUEST_FILTERS = ["all", "waiting", "sent", "opened", "feedback", "clicked", "failed"] as const;
export type RequestFilter = (typeof REQUEST_FILTERS)[number];

/**
 * Review requests, newest first, with their effective status and any feedback. Read with trusted access after the permission check, so
 * every reader sees the same delivery state (the message itself sits in a conversation they may not be able to open).
 */
export async function listReviewRequests(actor: CrmActor, opts: { filter?: RequestFilter; contactId?: string; page?: number; pageSize?: number } = {}): Promise<{ rows: ReviewRequestView[]; total: number; page: number; pageSize: number }> {
  assertCan(actor, "contacts.view");
  const pageSize = Math.min(100, Math.max(5, opts.pageSize ?? 25));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const filter: RequestFilter = (REQUEST_FILTERS as readonly string[]).includes(opts.filter ?? "") ? (opts.filter as RequestFilter) : "all";
  if (opts.contactId && !UUID.test(opts.contactId)) throw new AppError("not_found", "Contact not found.");
  return withSystem(async (db) => {
    const where = ["r.org_id = $1", "($2::uuid is null or r.contact_id = $2)"];
    const delivered = "m.status in ('sent', 'delivered', 'read')";
    if (filter === "waiting") where.push(`r.status in ('pending', 'queued') and coalesce(m.status, 'queued') in ('queued', 'sending', 'draft')`);
    if (filter === "sent") where.push(`(r.status in ('sent', 'opened', 'feedback_received', 'review_link_clicked') or (r.status = 'queued' and ${delivered}))`);
    if (filter === "opened") where.push("r.opened_at is not null");
    if (filter === "feedback") where.push("f.id is not null");
    if (filter === "clicked") where.push("r.clicked_at is not null");
    if (filter === "failed") where.push(`(r.status = 'failed' or (r.status in ('pending', 'queued') and m.status in ('failed', 'blocked')))`);
    const from = `from crm_review_requests r
      left join contacts c on c.id = r.contact_id and c.org_id = r.org_id and c.deleted_at is null
      left join crm_message_templates t on t.id = r.template_id and t.org_id = r.org_id
      left join users u on u.id = r.requested_by
      left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
      left join lateral (select id, rating, nps_score, scale, comment, received_at, follow_up_status, escalated_task_id, low_score from customer_feedback f where f.org_id = r.org_id and f.review_request_id = r.id order by received_at limit 1) f on true
      where ${where.join(" and ")}`;
    const total = Number((await db.query<{ n: string }>(`select count(*)::text as n ${from}`, [actor.orgId, opts.contactId ?? null])).rows[0].n);
    const { rows } = await db.query<RequestRow>(
      `select r.id, c.id as contact_id, c.display_name as contact_name, r.channel, t.name as template_name, r.status, r.requested_via, r.kind, r.scale, nullif(u.full_name, '') as requested_by_name,
              r.created_at, r.sent_at, r.opened_at, r.clicked_at, r.expires_at, m.status as message_status, m.sent_at as message_sent_at, m.status_detail as message_detail,
              f.id as f_id, f.rating as f_rating, f.nps_score as f_nps, f.scale as f_scale, f.comment as f_comment, f.received_at as f_received_at, f.follow_up_status as f_follow_up, f.escalated_task_id as f_task, f.low_score as f_low
       ${from} order by r.created_at desc, r.id limit $3 offset $4`,
      [actor.orgId, opts.contactId ?? null, pageSize, (page - 1) * pageSize],
    );
    const now = Date.now();
    return {
      total, page, pageSize,
      rows: rows.map((r) => {
        const status = effectiveRequestStatus(r.status, r.message_status);
        return {
          id: r.id, contact: r.contact_id ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null, channel: r.channel, templateName: r.template_name, kind: r.kind, scale: r.scale, status,
          requestedVia: r.requested_via, requestedByName: r.requested_by_name, createdAt: iso(r.created_at)!, sentAt: iso(r.sent_at ?? r.message_sent_at), openedAt: iso(r.opened_at),
          clickedAt: iso(r.clicked_at), expiresAt: iso(r.expires_at)!, expired: new Date(r.expires_at).getTime() < now,
          messageDetail: status === "failed" ? r.message_detail : null,
          feedback: r.f_id ? { id: r.f_id, rating: r.f_rating, npsScore: r.f_nps, scale: r.f_scale ?? "csat5", comment: r.f_comment, receivedAt: iso(r.f_received_at)!, followUpStatus: r.f_follow_up ?? "new", escalatedTaskId: r.f_task, lowScore: Boolean(r.f_low) } : null,
        };
      }),
    };
  });
}

export interface FeedbackView extends FeedbackSummary {
  contact: { id: string; name: string } | null;
  /**
   * A survey answer typed next to an existing customer's email or phone that nobody has verified: it may be theirs, and nothing was done for them. A person confirms or dismisses
   * it (src/server/reputation/survey-feedback.ts). Null for every answer that is attributed, anonymous or already decided.
   */
  possibleContact: { id: string; name: string } | null;
  source: "manual" | "review_request" | "survey" | "import";
  reviewRequestId: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  resolvedAt: string | null;
  resolvedByName: string | null;
  resolutionNote: string | null;
  /** The inbox conversation its escalation lives in, when there is one. */
  conversationId: string | null;
  /** Its follow-up task is assigned to the person looking: they may mark it acknowledged or resolved even without the review management permission. */
  assignedToYou: boolean;
}

export const FEEDBACK_FILTERS = ["open", "low", "all"] as const;
export type FeedbackFilter = (typeof FEEDBACK_FILTERS)[number];

/**
 * "Low" in lists and counts: low when it arrived (customer_feedback.low_score), or hand-recorded on the Retention page with a rating at or below the standing default (those
 * rows never go through the follow-through, so they carry no stored decision).
 */
const lowFeedbackSql = (a = "") => `(${a}low_score or (${a}source = 'manual' and ${a}rating <= ${ESCALATE_AT_OR_BELOW}))`;

/** Private feedback from customers (every source), newest first. "open": not acknowledged or resolved yet; "low": it was low when it arrived (by the workspace's level at that time). */
export async function listFeedback(actor: CrmActor, opts: { filter?: FeedbackFilter; page?: number; pageSize?: number } = {}): Promise<{ rows: FeedbackView[]; total: number; page: number; pageSize: number }> {
  assertCan(actor, "contacts.view");
  const pageSize = Math.min(100, Math.max(5, opts.pageSize ?? 25));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const filter: FeedbackFilter = (FEEDBACK_FILTERS as readonly string[]).includes(opts.filter ?? "") ? (opts.filter as FeedbackFilter) : "all";
  return withSystem(async (db) => {
    const where = ["f.org_id = $1"];
    if (filter === "open") where.push("f.follow_up_status in ('new', 'escalated')");
    if (filter === "low") where.push(lowFeedbackSql("f."));
    const from = `from customer_feedback f left join contacts c on c.id = f.contact_id and c.org_id = f.org_id and c.deleted_at is null
      left join human_escalations e on e.id = f.escalation_id and e.org_id = f.org_id
      left join tasks t on t.id = f.escalated_task_id and t.org_id = f.org_id
      left join lateral (select coalesce((select m.kept_contact_id from contact_merges m where m.merged_contact_id = f.possible_contact_id and m.org_id = f.org_id order by m.created_at desc limit 1), f.possible_contact_id) as id) pk on f.possible_contact_id is not null
      left join contacts pc on pc.id = pk.id and pc.org_id = f.org_id and pc.deleted_at is null
      left join users ua on ua.id = f.acknowledged_by left join users ur on ur.id = f.resolved_by where ${where.join(" and ")}`;
    const total = Number((await db.query<{ n: string }>(`select count(*)::text as n ${from}`, [actor.orgId])).rows[0].n);
    const { rows } = await db.query<{
      id: string; rating: number | null; nps_score: number | null; scale: FeedbackScale; comment: string | null; received_at: Date; follow_up_status: FeedbackFollowUp; escalated_task_id: string | null; low_score: boolean;
      contact_id: string | null; contact_name: string | null; possible_id: string | null; possible_name: string | null; source: FeedbackView["source"]; review_request_id: string | null; acknowledged_at: Date | null; acknowledged_by_name: string | null;
      resolved_at: Date | null; resolved_by_name: string | null; resolution_note: string | null; conversation_id: string | null; assigned_to_you: boolean;
    }>(
      `select f.id, f.rating, f.nps_score, f.scale, f.comment, f.received_at, f.follow_up_status, f.escalated_task_id, f.low_score, c.id as contact_id, c.display_name as contact_name, pc.id as possible_id, pc.display_name as possible_name, f.source, f.review_request_id,
              f.acknowledged_at, nullif(ua.full_name, '') as acknowledged_by_name, f.resolved_at, nullif(ur.full_name, '') as resolved_by_name, f.resolution_note, e.conversation_id,
              (t.assigned_user_id is not null and t.assigned_user_id = $4::uuid) as assigned_to_you
       ${from} order by f.received_at desc, f.id limit $2 offset $3`,
      [actor.orgId, pageSize, (page - 1) * pageSize, actor.kind === "member" ? actor.userId : null],
    );
    return {
      total, page, pageSize,
      rows: rows.map((r) => ({
        id: r.id, rating: r.rating, npsScore: r.nps_score, scale: r.scale, comment: r.comment, receivedAt: iso(r.received_at)!, followUpStatus: r.follow_up_status, escalatedTaskId: r.escalated_task_id, lowScore: r.low_score,
        contact: r.contact_id ? { id: r.contact_id, name: r.contact_name || "Unnamed contact" } : null, possibleContact: r.possible_id ? { id: r.possible_id, name: r.possible_name || "Unnamed contact" } : null,
        source: r.source, reviewRequestId: r.review_request_id,
        acknowledgedAt: iso(r.acknowledged_at), acknowledgedByName: r.acknowledged_by_name, resolvedAt: iso(r.resolved_at), resolvedByName: r.resolved_by_name, resolutionNote: r.resolution_note,
        conversationId: r.conversation_id, assignedToYou: r.assigned_to_you,
      })),
    };
  });
}

/**
 * Marks where the team is with a piece of feedback. Escalated is set by the escalation itself, not by hand. Owners and managers can; so can the person the
 * follow-up task is assigned to (src/server/reputation/feedback.ts). Finishing that task resolves the feedback by itself.
 */
export async function setFeedbackFollowUp(actor: CrmActor, id: string, status: FeedbackFollowUp, note?: string | null): Promise<void> {
  if (status !== "new" && status !== "acknowledged" && status !== "resolved") throw new AppError("invalid_input", "Choose new, acknowledged or resolved.");
  await changeFeedbackFollowUp(actor, id, { status, note });
}

export interface ReviewStats {
  days: number;
  since: string;
  /** Review requests created in the period (cancelled ones not counted), and how far those same requests got. */
  requests: { created: number; waiting: number; sent: number; opened: number; clicked: number; feedback: number; failed: number };
  /** Automatic asks stopped in the period because a person on the team had excluded that customer from automatic messages. Shown so a pattern is visible. */
  heldByPerson: number;
  /** Private feedback received in the period, from every source. Never public reviews. */
  feedback: { count: number; rated: number; average: number | null; byRating: Record<1 | 2 | 3 | 4 | 5, number>; low: number; open: number; npsAnswers: number };
  /** Customers who opened a review site's link from their page, by site. Opening a link isn't leaving a review: the sites don't tell us that. */
  clicksByPlatform: Array<{ platform: ReviewPlatform; label: string; clicks: number }>;
}

/** Counts for the Reviews screen, computed from this workspace's own records only. */
export async function getReviewStats(actor: CrmActor, opts: { days?: number; now?: Date } = {}): Promise<ReviewStats> {
  assertCan(actor, "contacts.view");
  const days = [7, 30, 90, 365].includes(opts.days ?? 30) ? (opts.days ?? 30) : 30;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - days * 86_400_000);
  return withSystem(async (db) => {
    const r = (await db.query<Record<string, string>>(
      `select count(*)::text as created,
              count(*) filter (where r.status in ('pending', 'queued') and coalesce(m.status, 'queued') in ('queued', 'sending', 'draft'))::text as waiting,
              count(*) filter (where r.status in ('sent', 'opened', 'feedback_received', 'review_link_clicked') or m.status in ('sent', 'delivered', 'read'))::text as sent,
              count(*) filter (where r.opened_at is not null)::text as opened,
              count(*) filter (where r.clicked_at is not null)::text as clicked,
              count(*) filter (where exists (select 1 from customer_feedback f where f.org_id = r.org_id and f.review_request_id = r.id))::text as feedback,
              count(*) filter (where r.status = 'failed' or (r.status in ('pending', 'queued') and m.status in ('failed', 'blocked')))::text as failed
       from crm_review_requests r left join conversation_messages m on m.id = r.message_id and m.org_id = r.org_id
       where r.org_id = $1 and r.created_at >= $2 and r.status <> 'cancelled'`,
      [actor.orgId, since.toISOString()],
    )).rows[0];
    const f = (await db.query<{ count: string; rated: string; nps: string; average: string | null; low: string; open: string; r1: string; r2: string; r3: string; r4: string; r5: string }>(
      `select count(*)::text as count, count(rating)::text as rated, count(nps_score)::text as nps, round(avg(rating)::numeric, 2)::text as average,
              count(*) filter (where ${lowFeedbackSql()})::text as low, count(*) filter (where follow_up_status in ('new', 'escalated'))::text as open,
              count(*) filter (where rating = 1)::text as r1, count(*) filter (where rating = 2)::text as r2, count(*) filter (where rating = 3)::text as r3,
              count(*) filter (where rating = 4)::text as r4, count(*) filter (where rating = 5)::text as r5
       from customer_feedback where org_id = $1 and received_at >= $2`,
      [actor.orgId, since.toISOString()],
    )).rows[0];
    const clicks = (await db.query<{ platform: string; clicks: string }>(
      `select coalesce(metadata->>'platform', 'other') as platform, count(*)::text as clicks from crm_activities
       where org_id = $1 and kind = 'review.link_clicked' and occurred_at >= $2 group by 1 order by 2 desc`,
      [actor.orgId, since.toISOString()],
    )).rows;
    const held = (await db.query<{ n: string }>("select count(*)::text as n from audit_logs where org_id = $1 and action = 'crm.review_request_held' and created_at >= $2", [actor.orgId, since.toISOString()])).rows[0];
    return {
      days, since: since.toISOString(),
      requests: { created: Number(r.created), waiting: Number(r.waiting), sent: Number(r.sent), opened: Number(r.opened), clicked: Number(r.clicked), feedback: Number(r.feedback), failed: Number(r.failed) },
      heldByPerson: Number(held.n),
      feedback: {
        count: Number(f.count), rated: Number(f.rated), average: f.average === null ? null : Number(f.average),
        byRating: { 1: Number(f.r1), 2: Number(f.r2), 3: Number(f.r3), 4: Number(f.r4), 5: Number(f.r5) }, low: Number(f.low), open: Number(f.open), npsAnswers: Number(f.nps),
      },
      clicksByPlatform: clicks.map((c) => {
        const platform = isReviewPlatform(c.platform) ? c.platform : "other";
        return { platform, label: REVIEW_PLATFORM_LABELS[platform], clicks: Number(c.clicks) };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// The customer's page (/r/<token>): no session, the token is the only authorization
// ---------------------------------------------------------------------------

const PAGE_VIEWS: RateLimitRule = { name: "reviews:page:token", limit: 60, windowSeconds: 3600 };
const FEEDBACK_POSTS: RateLimitRule = { name: "reviews:feedback:token", limit: 10, windowSeconds: 3600 };
const CLICKS: RateLimitRule = { name: "reviews:click:token", limit: 60, windowSeconds: 3600 };
/** Rate-limit keys are a hash of the token's hash, never the token. */
const limitKey = (token: string) => hashReviewToken(`rl:${hashReviewToken(token)}`).slice(0, 40);

export interface PublicReviewDestination {
  id: string;
  platform: ReviewPlatform;
  label: string;
  /** The review site's address, for a plain link when the request can no longer record clicks. */
  url: string;
}

export interface ReviewPageView {
  /** open: feedback can be given. closed: the link expired or the request was cancelled (the public links still work). disabled: the platform-wide switch is on (REVIEWS_PUBLIC_DISABLED). */
  state: "open" | "closed" | "invalid" | "rate_limited" | "disabled";
  closedReason: "expired" | "cancelled" | null;
  /** What the request is (a review request or a survey) and the scale its question is asked on. Neither changes which public links are shown. */
  kind: RequestKind;
  scale: FeedbackScale;
  business: { name: string; brandColor: string | null; contactEmail: string | null; contactPhone: string | null } | null;
  /**
   * Every active public review link, in the business's order. The same for every customer and every state but invalid: it never depends
   * on whether they left feedback or what rating they gave.
   */
  destinations: PublicReviewDestination[];
  /**
   * The private feedback already given through this link, if any (only its one-to-five rating: the comment isn't shown back; null on the zero-to-ten scale). `followUp` says a
   * person on the team will follow up privately; it is the only thing that differs between a low and a high answer, and the page words it as an offer, never as something to
   * do before posting a review.
   */
  feedback: { rating: number | null; followUp: boolean } | null;
}

interface PublicRequestRow {
  id: string; org_id: string; contact_id: string; status: ReviewRequestStatus; expires_at: Date; opened_at: Date | null; clicked_at: Date | null; message_id: string | null;
  kind: RequestKind; scale: FeedbackScale;
  org_name: string; org_timezone: string; brand_color: string | null; contact_email: string | null; contact_phone: string | null;
}

async function requestByToken(db: Queryable, token: string, lock = false): Promise<PublicRequestRow | null> {
  const { rows } = await db.query<PublicRequestRow>(
    `select r.id, r.org_id, r.contact_id, r.status, r.expires_at, r.opened_at, r.clicked_at, r.message_id, r.kind, r.scale, o.name as org_name, o.timezone as org_timezone,
            p.brand_color, p.contact_email, p.contact_phone
     from crm_review_requests r join organizations o on o.id = r.org_id left join company_profiles p on p.org_id = r.org_id
     where r.token_hash = $1${lock ? " for update of r" : ""}`,
    [hashReviewToken(token)],
  );
  return rows[0] ?? null;
}

const closedReason = (r: PublicRequestRow, now: Date): ReviewPageView["closedReason"] => (r.status === "cancelled" ? "cancelled" : new Date(r.expires_at).getTime() < now.getTime() ? "expired" : null);

/** Moves the stored status forward (never back) and fills the time the message went out from its delivery record. */
async function advance(db: Queryable, r: PublicRequestRow, to: ReviewRequestStatus, extra: "opened_at" | "clicked_at" | null, now: Date) {
  const next = RANK[r.status] >= 0 && RANK[to] > RANK[r.status] ? to : r.status;
  await db.query(
    `update crm_review_requests set status = $3,
       opened_at = coalesce(opened_at, $4::timestamptz),
       clicked_at = case when $5::boolean then coalesce(clicked_at, $4::timestamptz) else clicked_at end,
       sent_at = coalesce(sent_at, (select m.sent_at from conversation_messages m where m.id = crm_review_requests.message_id and m.org_id = crm_review_requests.org_id), $4::timestamptz)
     where id = $1 and org_id = $2`,
    [r.id, r.org_id, next, now.toISOString(), extra === "clicked_at"],
  );
}

const customerActor = (r: PublicRequestRow) => systemActor({ id: r.org_id, name: r.org_name, timezone: r.org_timezone }, "Customer");

/**
 * What the customer's page shows for a token, recording that it was opened (the first time, while the link is open). Opening counts
 * link opens, which can include an email security scanner following the link; it never changes anything else.
 */
export async function loadReviewPage(token: string, opts: { now?: Date } = {}): Promise<ReviewPageView> {
  const empty = (state: ReviewPageView["state"]): ReviewPageView => ({ state, closedReason: null, kind: "review", scale: "csat5", business: null, destinations: [], feedback: null });
  // The emergency switch comes first: nothing is read, counted or recorded, whatever the address.
  if (reviewsPublicDisabled()) return empty("disabled");
  if (!looksLikeReviewToken(token)) return empty("invalid");
  if (!(await consumeRateLimit(PAGE_VIEWS, limitKey(token))).allowed) return empty("rate_limited");
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const r = await requestByToken(db, token, true);
    if (!r) return empty("invalid");
    const reason = closedReason(r, now);
    if (!reason && !r.opened_at) {
      await advance(db, r, "opened", "opened_at", now);
      await recordActivity(db, customerActor(r), { kind: "review.opened", summary: "Opened their review request", contactId: r.contact_id, refType: "review_request", refId: r.id, occurredAt: now });
    }
    const fb = (await db.query<{ rating: number | null; low_score: boolean }>("select rating, low_score from customer_feedback where org_id = $1 and review_request_id = $2 order by received_at limit 1", [r.org_id, r.id])).rows[0];
    return {
      state: reason ? "closed" : "open",
      closedReason: reason,
      kind: r.kind,
      scale: r.scale,
      business: { name: r.org_name, brandColor: r.brand_color, contactEmail: r.contact_email, contactPhone: r.contact_phone },
      destinations: (await activeDestinations(db, r.org_id)).map((d) => ({ id: d.id, platform: d.platform, label: d.label, url: d.url })),
      feedback: fb ? { rating: fb.rating, followUp: fb.low_score } : null,
    };
  });
}

export type FeedbackOutcome = "saved" | "already" | "closed" | "invalid" | "empty" | "rate_limited" | "unavailable";

/** Plain text a customer typed: control characters removed, line breaks kept, at most FEEDBACK_COMMENT_MAX characters. */
export function cleanFeedbackComment(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return s ? s.slice(0, FEEDBACK_COMMENT_MAX) : null;
}

/** A one-to-five rating from the form: a whole number from 1 to 5, or null when none was chosen. Anything else is refused as invalid input. */
export function parseRating(v: unknown): number | null | "invalid" {
  return parseScore("csat5", v);
}

/**
 * Saves the private feedback a customer chose to give through their link, once per link. The question is the one the request was made with: one to five, or zero to ten
 * ("how likely are you to recommend us"); which one applies comes from the request, never from the form. A score at or below the workspace's low level (2 of 5, or 6 of 10,
 * unless it chose otherwise), or a comment with no score that plainly raises a complaint, is LOW: it opens a follow-up for the team (a task, a notice, an inbox escalation, and
 * the customer's remaining automatic program messages stop; see src/server/reputation/feedback.ts). Whether it was low is decided now and stored with it. Nothing about it
 * changes what the customer sees: the page shows the same public review links before and after, whatever the score.
 */
export async function submitReviewFeedback(token: string, input: { rating?: unknown; comment?: unknown }, opts: { now?: Date } = {}): Promise<{ outcome: FeedbackOutcome; escalated?: boolean; feedbackId?: string }> {
  if (reviewsPublicDisabled()) return { outcome: "unavailable" };
  if (!looksLikeReviewToken(token)) return { outcome: "invalid" };
  // The form's number is checked for shape here, and for range once the request (and so its scale) is known.
  const chosen = parseScore("nps10", input.rating);
  if (chosen === "invalid") return { outcome: "invalid" };
  const comment = cleanFeedbackComment(input.comment);
  if (chosen === null && !comment) return { outcome: "empty" };
  if (!(await consumeRateLimit(FEEDBACK_POSTS, limitKey(token))).allowed) return { outcome: "rate_limited" };
  const now = opts.now ?? new Date();
  let emails: OutgoingEmail[] = [];
  const out = await withSystem(async (db) => {
    const r = await requestByToken(db, token, true);
    if (!r) return { outcome: "invalid" as const };
    if (closedReason(r, now)) return { outcome: "closed" as const };
    const prior = await db.query("select 1 from customer_feedback where org_id = $1 and review_request_id = $2", [r.org_id, r.id]);
    if (prior.rows.length) return { outcome: "already" as const };
    const score = chosen === null ? null : parseScore(r.scale, chosen);
    if (score === "invalid") return { outcome: "invalid" as const };
    const actor = customerActor(r);
    // Low is decided here, from the workspace's own settings, and stored. A comment with no score is judged by what it says (the same blunt words the inbox acts on,
    // with "no complaints at all" not counting); a comment next to a score is judged by the score alone.
    const settings = await loadSettings(db, r.org_id);
    const signal = score === null && comment ? detectEscalationSignal(withoutNegatedComplaints(comment)) : null;
    const low = score !== null ? isLowScore(r.scale, score, thresholdsOf(settings)) : Boolean(signal);
    const rating = r.scale === "csat5" ? score : null;
    const npsScore = r.scale === "nps10" ? score : null;
    const { rows } = await db.query<{ id: string }>(
      `insert into customer_feedback (org_id, rating, nps_score, comment, received_at, contact_id, review_request_id, source, follow_up_status, scale, low_score)
       values ($1, $2, $3, $4, $5, $6, $7, 'review_request', 'new', $8, $9) returning id`,
      [r.org_id, rating, npsScore, comment, now.toISOString(), r.contact_id, r.id, r.scale, low],
    );
    const feedbackId = rows[0].id;
    await advance(db, r, "feedback_received", "opened_at", now);
    const contact = (await db.query<{ display_name: string; assigned_user_id: string | null }>("select display_name, assigned_user_id from contacts where id = $1 and org_id = $2", [r.contact_id, r.org_id])).rows[0];
    const name = contact?.display_name || "A customer";
    const scoreText = describeScore(r.scale, score);
    await emitEvent(db, actor, {
      type: "feedback.received", entityType: "customer_feedback", entityId: feedbackId, contactId: r.contact_id,
      payload: { feedbackId, reviewRequestId: r.id, rating, scale: r.scale, npsScore, hasComment: Boolean(comment), source: "review_request" }, dedupeKey: `feedback.received:${feedbackId}`, byContact: true,
    });
    await recordActivity(db, actor, {
      kind: "feedback.received", summary: scoreText ? `Left private feedback: ${scoreText}` : "Left private feedback", contactId: r.contact_id, refType: "customer_feedback", refId: feedbackId,
      metadata: { rating, scale: r.scale, npsScore, reviewRequestId: r.id }, occurredAt: now,
    });
    if (low) {
      const followUp = await followThroughLowFeedback(db, actor, {
        feedbackId, reviewRequestId: r.id, contact: { id: r.contact_id, name, assigneeId: contact?.assigned_user_id ?? null }, requestMessageId: r.message_id,
        scoreText, comment, category: signal?.category, settings, now,
      });
      emails = followUp.emails;
    }
    return { outcome: "saved" as const, escalated: low, feedbackId };
  });
  // The emails an escalation produces are sent only now, after everything above committed; one that fails never undoes the customer's saved feedback.
  if (emails.length) await sendFollowThroughEmails(emails);
  return out;
}

/**
 * The review site a customer chose from their page: records that they opened it (while the link is open) and returns where to send
 * them. The address always comes from the business's own active list, never from the request. Null for an unknown token or link.
 */
export async function recordReviewClick(token: string, destinationId: string, opts: { now?: Date } = {}): Promise<{ url: string } | null> {
  if (reviewsPublicDisabled() || !looksLikeReviewToken(token) || !UUID.test(destinationId)) return null;
  const now = opts.now ?? new Date();
  const allowed = (await consumeRateLimit(CLICKS, limitKey(token))).allowed;
  return withSystem(async (db) => {
    const r = await requestByToken(db, token, true);
    if (!r) return null;
    const d = (await db.query<{ url: string; platform: ReviewPlatform; label: string }>("select url, platform, label from crm_review_destinations where id = $1 and org_id = $2 and active", [destinationId, r.org_id])).rows[0];
    if (!d) return null;
    if (allowed && !closedReason(r, now)) {
      await advance(db, r, "review_link_clicked", "clicked_at", now);
      const seen = await db.query(
        "select 1 from crm_activities where org_id = $1 and kind = 'review.link_clicked' and ref_type = 'review_request' and ref_id = $2 and metadata->>'destinationId' = $3 limit 1",
        [r.org_id, r.id, destinationId],
      );
      if (!seen.rows.length) {
        await recordActivity(db, customerActor(r), {
          kind: "review.link_clicked", summary: `Opened the ${d.label} review link`, contactId: r.contact_id, refType: "review_request", refId: r.id,
          metadata: { destinationId, platform: d.platform }, occurredAt: now,
        });
      }
    }
    return { url: d.url };
  });
}
