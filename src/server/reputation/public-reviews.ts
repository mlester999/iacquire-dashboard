import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { assertCan, auditActor, crmRead, type CrmActor } from "@/server/crm/actor";
import { assertManageSites, assertViewReviews, replyPostable } from "@/server/reputation/connections";
import { externalReviewsEnabledIn } from "@/server/reputation/entitlement";
import { loadSettings } from "@/server/reputation/settings";
import {
  PROVIDER_LABELS, PROVIDER_REVIEW_WORD, agoText, isLowPublicReview, ratingText, summarizeMirror, syncedAgainstReported, weeklyCounts,
  type ConnectionStatus, type MirrorSummary, type ReviewFilter, type ReviewProvider as Site, type WeekBucket,
} from "@/lib/reputation/external";
import type { ReplyStatus } from "@/lib/reputation/reply-state";

// Reading the mirror of a review site's reviews for the Public reviews screen. Everything here is read from this workspace's own stored rows; nothing contacts a site. The numbers
// are computed from the reviews actually stored and are always shown with how many that is, which site they came from and when they were read; what a site says about its own
// totals is carried apart and shown beside them.

export const REVIEWS_PAGE_SIZE = 20;

export interface ReplyEventView {
  id: number;
  at: string;
  kind: string;
  actorName: string | null;
  actorKind: "user" | "ai" | "system";
}

export interface ReplyView {
  id: string;
  version: number;
  body: string;
  origin: "human" | "ai";
  status: ReplyStatus;
  approvedVersion: number | null;
  approvedByName: string | null;
  approvedAt: string | null;
  decisionNote: string | null;
  authorId: string | null;
  authorName: string | null;
  postedAt: string | null;
  postedVia: "provider" | "person" | null;
  verifiedAt: string | null;
  failureMessage: string | null;
  /** What the AI assist reports about its own draft: the knowledge sections it used and the warnings it found. Never the review's words. */
  ai: { knowledgeSections: string[]; warnings: string[] } | null;
  updatedAt: string;
  events: ReplyEventView[];
}

export interface PublicReviewView {
  id: string;
  connectionId: string;
  provider: Site;
  providerLabel: string;
  /** What the site calls it: a review, or on Facebook a recommendation. */
  word: string;
  connectionName: string;
  simulated: boolean;
  rating: number | null;
  recommends: boolean | null;
  ratingText: string;
  /** As the site gave it; null for an anonymous reviewer. */
  reviewerName: string | null;
  comment: string | null;
  /** When the reviewer wrote it, or when it was first read if the site did not say. */
  at: string;
  removedAt: string | null;
  providerReply: { text: string; at: string | null } | null;
  /** Set by hand by a person; a reviewer is never matched to a customer automatically. */
  contactId: string | null;
  contactName: string | null;
  low: boolean;
  /** Still on the site and its connection works, so it can be answered. */
  live: boolean;
  postable: { ok: true } | { ok: false; reason: string };
  reply: ReplyView | null;
}

export interface ConnectionSummary {
  connectionId: string;
  provider: Site;
  label: string;
  name: string;
  simulated: boolean;
  status: ConnectionStatus;
  statusDetail: string | null;
  summary: MirrorSummary;
  /** "Google reports 12 reviews; 9 read so far." */
  line: string;
  reportedRating: number | null;
  reportedCount: number | null;
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastCompleteAt: string | null;
  /** "read 3 hours ago" */
  ago: string;
}

export interface ReplyFacts {
  userId: string | null;
  canDraft: boolean;
  canPublish: boolean;
  canAi: boolean;
  aiEnabled: boolean;
}

export interface PublicReviewsPage {
  rows: PublicReviewView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PublicReviewsData {
  filter: ReviewFilter;
  page: PublicReviewsPage;
  counts: Record<ReviewFilter, number>;
  summaries: ConnectionSummary[];
  weekly: WeekBucket[];
  facts: ReplyFacts;
  alertAtOrBelow: number;
  /** A review opened by its address (?review=), when it is not on this page. */
  focus: PublicReviewView | null;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Whether the workspace has public reviews switched on, and whether it has anything to show anyway (connections or reviews stay visible after a switch-off). */
export async function publicReviewsStatus(actor: CrmActor): Promise<{ enabled: boolean; any: boolean }> {
  assertViewReviews(actor);
  const enabled = await withSystem((db) => externalReviewsEnabledIn(db, actor.orgId));
  const any = await crmRead(actor, async (db) => {
    const r = await db.query<{ any: boolean }>(
      "select (exists (select 1 from review_connections where org_id = $1) or exists (select 1 from external_reviews where org_id = $1)) as any", [actor.orgId],
    );
    return r.rows[0]?.any === true;
  });
  return { enabled, any };
}

/** What this person may do with replies. A support session can write in a write session and never approve or post; the AI assist is the client's own team's. */
export async function replyFactsFor(actor: CrmActor): Promise<ReplyFacts> {
  const aiEnabled = (await withSystem((db) => loadSettings(db, actor.orgId))).aiRepliesEnabled;
  const member = actor.kind === "member";
  const canDraft = member ? actor.can("reviews.respond") : actor.kind === "agency" && actor.supportMode === "write" && actor.can("reviews.manage");
  return { userId: actor.userId, canDraft, canPublish: member && actor.can("reviews.reply_publish"), canAi: member && actor.can("reviews.respond") && aiEnabled, aiEnabled };
}

const OPEN = "('draft', 'pending_approval', 'changes_requested', 'approved', 'posting', 'failed', 'needs_reconciliation')";
const POSTED = "exists (select 1 from review_replies pp where pp.review_id = r.id and pp.org_id = r.org_id and pp.status = 'posted')";
const FILTER_SQL: Record<ReviewFilter, string> = {
  all: "r.removed_at is null",
  needs_reply: `r.removed_at is null and r.provider_reply_text is null and not ${POSTED}`,
  low: "r.removed_at is null and ((r.rating is not null and r.rating <= $2) or r.recommends = false)",
  replied: `r.removed_at is null and (r.provider_reply_text is not null or ${POSTED})`,
  removed: "r.removed_at is not null",
};

interface Row {
  id: string;
  connection_id: string;
  provider: Site;
  adapter: "google" | "meta" | "simulated";
  connection_name: string;
  connection_status: ConnectionStatus;
  can_reply: boolean;
  simulated: boolean;
  rating: number | null;
  recommends: boolean | null;
  reviewer_name: string | null;
  reviewer_anonymous: boolean;
  comment: string | null;
  at: Date;
  removed_at: Date | null;
  provider_reply_text: string | null;
  provider_reply_at: Date | null;
  contact_id: string | null;
  contact_name: string | null;
  rp_id: string | null;
}

interface ReplyRowX {
  id: string;
  review_id: string;
  version: number;
  body: string;
  origin: "human" | "ai";
  ai_meta: { knowledgeSections?: unknown; warnings?: unknown } | null;
  status: ReplyStatus;
  approved_version: number | null;
  approved_by_name: string | null;
  approved_at: Date | null;
  decision_note: string | null;
  author_id: string | null;
  author_name: string | null;
  posted_at: Date | null;
  posted_via: "provider" | "person" | null;
  verified_at: Date | null;
  failure_message: string | null;
  updated_at: Date;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 12) : []);

const REVIEW_SELECT = `r.id, r.connection_id, c.provider, c.adapter, c.name as connection_name, c.status as connection_status, c.can_reply, r.simulated, r.rating, r.recommends, r.reviewer_name, r.reviewer_anonymous,
  r.comment, coalesce(r.provider_created_at, r.first_seen_at) as at, r.removed_at, r.provider_reply_text, r.provider_reply_at, r.contact_id, k.display_name as contact_name, cur.id as rp_id`;
const REVIEW_FROM = `from external_reviews r join review_connections c on c.id = r.connection_id and c.org_id = r.org_id
  left join contacts k on k.id = r.contact_id and k.org_id = r.org_id and k.deleted_at is null
  left join lateral (select p.id from review_replies p where p.review_id = r.id and p.org_id = r.org_id order by (p.status in ${OPEN}) desc, p.created_at desc limit 1) cur on true`;

async function replyViews(db: Queryable, orgId: string, ids: string[]): Promise<Map<string, ReplyView>> {
  const out = new Map<string, ReplyView>();
  if (!ids.length) return out;
  const { rows } = await db.query<ReplyRowX>(
    `select p.id, p.review_id, p.version, p.body, p.origin, p.ai_meta, p.status, p.approved_version, au.full_name as approved_by_name, p.approved_at, p.decision_note, p.author_id, wu.full_name as author_name,
            p.posted_at, p.posted_via, p.verified_at, p.failure_message, p.updated_at
     from review_replies p left join users au on au.id = p.approved_by left join users wu on wu.id = p.author_id where p.org_id = $1 and p.id = any($2::uuid[])`,
    [orgId, ids],
  );
  const events = await db.query<{ id: string; reply_id: string; at: Date; kind: string; actor_kind: "user" | "ai" | "system"; full_name: string | null }>(
    `select e.id::text as id, e.reply_id, e.at, e.kind, e.actor_kind, u.full_name from review_reply_events e left join users u on u.id = e.actor_id
     where e.org_id = $1 and e.reply_id = any($2::uuid[]) order by e.id`,
    [orgId, ids],
  );
  const by = new Map<string, ReplyEventView[]>();
  for (const e of events.rows) by.set(e.reply_id, [...(by.get(e.reply_id) ?? []), { id: Number(e.id), at: new Date(e.at).toISOString(), kind: e.kind, actorName: e.full_name, actorKind: e.actor_kind }]);
  for (const r of rows) {
    out.set(r.id, {
      id: r.id, version: r.version, body: r.body, origin: r.origin, status: r.status, approvedVersion: r.approved_version, approvedByName: r.approved_by_name, approvedAt: iso(r.approved_at), decisionNote: r.decision_note,
      authorId: r.author_id, authorName: r.author_name, postedAt: iso(r.posted_at), postedVia: r.posted_via, verifiedAt: iso(r.verified_at), failureMessage: r.failure_message,
      ai: r.origin === "ai" ? { knowledgeSections: strings(r.ai_meta?.knowledgeSections), warnings: strings(r.ai_meta?.warnings) } : null,
      updatedAt: new Date(r.updated_at).toISOString(), events: (by.get(r.id) ?? []).slice(-12),
    });
  }
  return out;
}

function toView(r: Row, reply: ReplyView | null, alertAtOrBelow: number): PublicReviewView {
  const live = r.removed_at === null && r.connection_status === "connected";
  return {
    id: r.id, connectionId: r.connection_id, provider: r.provider, providerLabel: PROVIDER_LABELS[r.provider], word: PROVIDER_REVIEW_WORD[r.provider], connectionName: r.connection_name, simulated: r.simulated,
    rating: r.rating, recommends: r.recommends, ratingText: ratingText(r.rating, r.recommends), reviewerName: r.reviewer_anonymous ? null : r.reviewer_name, comment: r.comment, at: new Date(r.at).toISOString(),
    removedAt: iso(r.removed_at), providerReply: r.provider_reply_text ? { text: r.provider_reply_text, at: iso(r.provider_reply_at) } : null, contactId: r.contact_id, contactName: r.contact_name,
    low: isLowPublicReview(r, alertAtOrBelow), live, postable: replyPostable({ adapter: r.adapter, provider: r.provider, status: r.connection_status, can_reply: r.can_reply }), reply,
  };
}

/** One page of the mirror, newest first, with the reply each review has in progress (or the latest). */
export async function listPublicReviews(actor: CrmActor, opts: { filter?: ReviewFilter; page?: number; pageSize?: number } = {}): Promise<{ page: PublicReviewsPage; counts: Record<ReviewFilter, number>; alertAtOrBelow: number }> {
  assertViewReviews(actor);
  const filter: ReviewFilter = opts.filter ?? "all";
  const pageSize = Math.min(50, Math.max(1, opts.pageSize ?? REVIEWS_PAGE_SIZE));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const alertAtOrBelow = (await withSystem((db) => loadSettings(db, actor.orgId))).publicReviewAlertAtOrBelow;
  return crmRead(actor, async (db) => {
    const counts = (await db.query<Record<ReviewFilter, string>>(
      `select ${(Object.keys(FILTER_SQL) as ReviewFilter[]).map((k) => `count(*) filter (where ${FILTER_SQL[k]})::text as ${k}`).join(", ")} from external_reviews r where r.org_id = $1`,
      [actor.orgId, alertAtOrBelow],
    )).rows[0];
    const total = Number(counts?.[filter] ?? 0);
    const { rows } = await db.query<Row>(
      `select ${REVIEW_SELECT} ${REVIEW_FROM} where r.org_id = $1 and $2::int is not null and ${FILTER_SQL[filter]} order by coalesce(r.provider_created_at, r.first_seen_at) desc, r.id limit $3 offset $4`,
      [actor.orgId, alertAtOrBelow, pageSize, (page - 1) * pageSize],
    );
    const replies = await replyViews(db, actor.orgId, rows.map((r) => r.rp_id).filter((x): x is string => Boolean(x)));
    return {
      page: { rows: rows.map((r) => toView(r, r.rp_id ? replies.get(r.rp_id) ?? null : null, alertAtOrBelow)), total, page, pageSize },
      counts: Object.fromEntries((Object.keys(FILTER_SQL) as ReviewFilter[]).map((k) => [k, Number(counts?.[k] ?? 0)])) as Record<ReviewFilter, number>,
      alertAtOrBelow,
    };
  });
}

/** One review of this workspace by id (a link in a notice opens it), or null. */
export async function getPublicReview(actor: CrmActor, id: string): Promise<PublicReviewView | null> {
  assertViewReviews(actor);
  if (!UUID.test(id)) return null;
  const alertAtOrBelow = (await withSystem((db) => loadSettings(db, actor.orgId))).publicReviewAlertAtOrBelow;
  return crmRead(actor, async (db) => {
    const { rows } = await db.query<Row>(`select ${REVIEW_SELECT} ${REVIEW_FROM} where r.org_id = $1 and r.id = $2`, [actor.orgId, id]);
    const r = rows[0];
    if (!r) return null;
    const replies = await replyViews(db, actor.orgId, r.rp_id ? [r.rp_id] : []);
    return toView(r, r.rp_id ? replies.get(r.rp_id) ?? null : null, alertAtOrBelow);
  });
}

/** Per connection: the numbers computed from the stored reviews, beside what the site reports, with when they were read. */
export async function getConnectionSummaries(actor: CrmActor): Promise<{ summaries: ConnectionSummary[]; weekly: WeekBucket[] }> {
  assertViewReviews(actor);
  return crmRead(actor, async (db) => {
    const conns = await db.query<{
      id: string; provider: Site; adapter: string; name: string; status: ConnectionStatus; status_detail: string | null; reported_rating: string | null; reported_review_count: number | null;
      last_sync_at: Date | null; last_success_at: Date | null; last_complete_at: Date | null;
    }>(
      `select id, provider, adapter, name, status, status_detail, reported_rating::text as reported_rating, reported_review_count, last_sync_at, last_success_at, last_complete_at
       from review_connections c where org_id = $1 and (status <> 'disconnected' or exists (select 1 from external_reviews r where r.connection_id = c.id and r.org_id = c.org_id)) order by connected_at desc`,
      [actor.orgId],
    );
    const groups = await db.query<{ connection_id: string; rating: number | null; recommends: boolean | null; removed: boolean; n: number }>(
      "select connection_id, rating, recommends, (removed_at is not null) as removed, count(*)::int as n from external_reviews where org_id = $1 group by 1, 2, 3, 4", [actor.orgId],
    );
    const dates = await db.query<{ at: Date }>(
      "select coalesce(provider_created_at, first_seen_at) as at from external_reviews where org_id = $1 and removed_at is null and coalesce(provider_created_at, first_seen_at) >= now() - interval '90 days' order by 1 desc limit 5000", [actor.orgId],
    );
    const summaries = conns.rows.map((c): ConnectionSummary => {
      const summary = summarizeMirror(groups.rows.filter((g) => g.connection_id === c.id).map((g) => ({ rating: g.rating, recommends: g.recommends, removed: g.removed, n: Number(g.n) })));
      return {
        connectionId: c.id, provider: c.provider, label: PROVIDER_LABELS[c.provider], name: c.name, simulated: c.adapter === "simulated", status: c.status, statusDetail: c.status_detail, summary,
        line: syncedAgainstReported(PROVIDER_LABELS[c.provider], PROVIDER_REVIEW_WORD[c.provider], summary.live, c.reported_review_count), reportedRating: c.reported_rating === null ? null : Number(c.reported_rating),
        reportedCount: c.reported_review_count, lastSyncAt: iso(c.last_sync_at), lastSuccessAt: iso(c.last_success_at), lastCompleteAt: iso(c.last_complete_at), ago: agoText(iso(c.last_success_at)),
      };
    });
    return { summaries, weekly: weeklyCounts(dates.rows.map((d) => d.at), new Date(), 12) };
  });
}

/** Everything the Public reviews tab shows. */
export async function publicReviewsData(actor: CrmActor, opts: { filter?: ReviewFilter; page?: number; focusId?: string | null } = {}): Promise<PublicReviewsData> {
  const [list, sums, facts] = await Promise.all([listPublicReviews(actor, opts), getConnectionSummaries(actor), replyFactsFor(actor)]);
  const inPage = opts.focusId ? list.page.rows.some((r) => r.id === opts.focusId) : true;
  const focus = opts.focusId && !inPage ? await getPublicReview(actor, opts.focusId) : null;
  return { filter: opts.filter ?? "all", page: list.page, counts: list.counts, summaries: sums.summaries, weekly: sums.weekly, facts, alertAtOrBelow: list.alertAtOrBelow, focus };
}

/**
 * A person links a review to one of their customers, or removes the link. This is the only way a review ever gets a contact: a reviewer's name is never matched to a customer
 * automatically (two people can share a name, and a stranger's review is not evidence of who they are). Recorded with who did it, and audited.
 */
export async function linkReviewContact(actor: CrmActor, reviewId: string, contactId: string | null): Promise<void> {
  const userId = assertManageSites(actor);
  assertCan(actor, "contacts.view");
  await withSystem(async (db) => {
    const review = (await db.query<{ contact_id: string | null }>("select contact_id from external_reviews where id = $1 and org_id = $2 for update", [reviewId, actor.orgId])).rows[0];
    if (!review) throw new AppError("not_found", "That review was not found.");
    if (contactId) {
      const ok = await db.query("select 1 from contacts where id = $1 and org_id = $2 and deleted_at is null", [contactId, actor.orgId]);
      if (!ok.rows[0]) throw new AppError("invalid_input", "Choose one of your customers.");
      await db.query("update external_reviews set contact_id = $3, contact_linked_by = $4, contact_linked_at = now() where id = $1 and org_id = $2", [reviewId, actor.orgId, contactId, userId]);
    } else {
      await db.query("update external_reviews set contact_id = null, contact_linked_by = null, contact_linked_at = null where id = $1 and org_id = $2", [reviewId, actor.orgId]);
    }
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: contactId ? "reputation.review_linked" : "reputation.review_unlinked", targetType: "external_review", targetId: reviewId, result: "success", metadata: { contactId } }, db);
  });
}
