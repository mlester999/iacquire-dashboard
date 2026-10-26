import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyOrgRoles, notifyUser } from "@/server/notifications";
import { auditActor, type CrmActor } from "@/server/crm/actor";
import { widgetKnowledge } from "@/server/webchat/generator";
import { unsupportedClaims } from "@/server/social/claims";
import { assertExternalReviewsEnabled } from "@/server/reputation/entitlement";
import { connectionCredentials, markRepliesNotAllowed, recordProviderFailure, replyPostable, type ConnectionRow } from "@/server/reputation/connections";
import { PROVIDER_LABELS } from "@/lib/reputation/external";
import { reviewProviderFor } from "@/server/reputation/providers";
import { ProviderError, squashReply, within, type ReplyRead, type ReviewProvider } from "@/server/reputation/providers/types";
import { replyApprovalHash, reviewFingerprint } from "@/server/reputation/reply-hash";
import { cleanReplyBody, replyProblems } from "@/lib/reputation/reply-rules";
import { REPLY_KNOWLEDGE_SECTIONS } from "@/lib/reputation/reply-draft";
import { POSTING_STALE_MINUTES, canTransitionReply, isEditableReply, type ReplyStatus } from "@/lib/reputation/reply-state";

// A reply to a public review, from the first words to the moment it is on the review site. The rules that hold at every step:
//
//   * A reply is written by a person, or drafted by the AI assist for a person (reply-ai.ts). Either way it is a draft until someone with the right to answer for the business
//     (reviews.reply_publish: the client's owner or a manager) approves ONE VERSION of it. Any change to the words sends it back to a draft and voids the approval.
//   * The approval is a hash of the review (its site id and what it said), the version and the exact words. It is made again at the moment of posting, from the review and the
//     words as they are then, and the reply is posted only if the two are equal.
//   * The intent to post is written (status "posting", sending_at) BEFORE the request leaves. If the answer is lost, or the worker dies, the reply is CHECKED against the site;
//     it is never sent a second time on a guess, and a person settles what the check cannot.
//   * Nothing here runs without a person: no setting, job or AI posts a reply. The scheduler only checks the outcome of a reply a person already started posting.
//   * iAcquire support can look and, in a write session, draft; it never approves or posts. A reply that cannot be posted from here (the site's reply switch is off, or the access
//     lacks it) can be approved and then marked posted by a person who put it on the site themselves.

export const RECONCILE_GRACE_MINUTES = 10;
/** After this long without a way to check, the owner and managers are told to look at the site themselves. */
export const RECONCILE_GIVE_UP_HOURS = 24;
export const RECONCILE_BATCH = 25;

export interface ReplyRow {
  id: string;
  org_id: string;
  review_id: string;
  version: number;
  body: string;
  origin: "human" | "ai";
  ai_meta: Record<string, unknown> | null;
  author_id: string | null;
  status: ReplyStatus;
  approved_version: number | null;
  approved_hash: string | null;
  approved_by: string | null;
  approved_at: Date | null;
  decision_note: string | null;
  sending_at: Date | null;
  posted_at: Date | null;
  posted_by: string | null;
  posted_via: "provider" | "person" | null;
  verified_at: Date | null;
  failure_code: string | null;
  failure_message: string | null;
  created_at: Date;
  updated_at: Date;
}

const REPLY_COLUMNS = `p.id, p.org_id, p.review_id, p.version, p.body, p.origin, p.ai_meta, p.author_id, p.status, p.approved_version, p.approved_hash, p.approved_by, p.approved_at, p.decision_note,
  p.sending_at, p.posted_at, p.posted_by, p.posted_via, p.verified_at, p.failure_code, p.failure_message, p.created_at, p.updated_at`;

export interface ReplyContext {
  reply: ReplyRow;
  review: { id: string; provider_review_id: string; rating: number | null; recommends: boolean | null; comment: string | null; removed_at: Date | null; connection_id: string };
  connection: ConnectionRow;
}

async function loadContext(db: Queryable, orgId: string, replyId: string, lock = false): Promise<ReplyContext | null> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(replyId)) return null;
  const { rows } = await db.query<ReplyRow & Extra>(
    `select ${REPLY_COLUMNS},
       r.provider_review_id, r.rating, r.recommends, r.comment, r.removed_at, r.connection_id,
       c.provider, c.adapter, c.external_account_id, c.external_location_id, c.name as connection_name, c.social_account_id, c.credentials, c.status as connection_status, c.can_reply, c.sync_cursor, c.last_complete_at
     from review_replies p join external_reviews r on r.id = p.review_id and r.org_id = p.org_id
     join review_connections c on c.id = r.connection_id and c.org_id = r.org_id
     where p.id = $1 and p.org_id = $2${lock ? " for update of p" : ""}`,
    [replyId, orgId],
  );
  const x = rows[0];
  if (!x) return null;
  const {
    provider_review_id, rating, recommends, comment, removed_at, connection_id, provider, adapter, external_account_id, external_location_id, connection_name, social_account_id, credentials,
    connection_status, can_reply, sync_cursor, last_complete_at, ...reply
  } = x;
  return {
    reply,
    review: { id: reply.review_id, provider_review_id, rating, recommends, comment, removed_at, connection_id },
    connection: {
      id: connection_id, org_id: reply.org_id, provider, adapter, external_account_id, external_location_id, name: connection_name, social_account_id, credentials, status: connection_status, can_reply,
      sync_cursor: sync_cursor ?? {}, last_complete_at,
    },
  };
}

/** The columns of the review and its connection that come with a reply. */
interface Extra {
  provider_review_id: string;
  rating: number | null;
  recommends: boolean | null;
  comment: string | null;
  removed_at: Date | null;
  connection_id: string;
  provider: ConnectionRow["provider"];
  adapter: ConnectionRow["adapter"];
  external_account_id: string | null;
  external_location_id: string;
  connection_name: string;
  social_account_id: string | null;
  credentials: string | null;
  connection_status: ConnectionRow["status"];
  can_reply: boolean;
  sync_cursor: ConnectionRow["sync_cursor"] | null;
  last_complete_at: Date | null;
}

async function addEvent(db: Queryable, orgId: string, replyId: string, kind: string, actor: { id: string | null; kind: "user" | "ai" | "system" }, detail: Record<string, unknown> = {}): Promise<void> {
  await db.query("insert into review_reply_events (org_id, reply_id, kind, actor_id, actor_kind, detail) values ($1, $2, $3, $4, $5, $6::jsonb)", [orgId, replyId, kind.slice(0, 40), actor.id, actor.kind, JSON.stringify(detail)]);
}

// ---------------------------------------------------------------------------
// Who may do what
// ---------------------------------------------------------------------------

/** Writing and sending for approval: the client's own people with reviews.respond, and iAcquire support only in a write session. */
export function assertDrafter(actor: CrmActor): string {
  const may = actor.kind === "member" ? actor.can("reviews.respond") : actor.kind === "agency" && actor.supportMode === "write" && actor.can("reviews.manage");
  if (!may || !actor.userId) {
    throw new AppError("forbidden", actor.kind === "agency" ? "A support session can write a reply only when it is a write session. It can never approve or post one." : "Your role can't write replies to reviews.");
  }
  return actor.userId;
}

/** Approving and posting: the client's owner and managers, in the client's own workspace. Never iAcquire support. */
export function assertPublisher(actor: CrmActor): string {
  if (actor.kind !== "member" || !actor.userId) throw new AppError("forbidden", "Replies go out under the business's name. Only the client's own owner or a manager can approve or post one; iAcquire support can't.");
  if (!actor.can("reviews.reply_publish")) throw new AppError("forbidden", "Only the owner or a manager can approve and post replies to reviews.");
  return actor.userId;
}

const actorOf = (actor: CrmActor) => ({ id: actor.userId, kind: "user" as const });

function liveOrThrow(ctx: ReplyContext, what: string) {
  if (ctx.review.removed_at) throw new AppError("conflict", `This review is no longer on the review site, so it can't be ${what}.`);
  if (ctx.connection.status !== "connected") throw new AppError("conflict", `The connection to the review site needs attention, so the reply can't be ${what} until it is fixed.`);
}

const canTouch = (actor: CrmActor, r: ReplyRow) => r.author_id === actor.userId || (actor.kind === "member" && actor.can("reviews.reply_publish"));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The approved company information an AI draft is checked against: the same sections it was given, and only when the reply is an AI draft (a person's own words are their own
 * responsibility). Read BEFORE a transaction opens, because reading it opens one of its own.
 */
async function claimsBasis(orgId: string, replyId: string): Promise<string> {
  if (!UUID.test(replyId)) return "";
  const origin = (await withSystem((db) => db.query<{ origin: string }>("select origin from review_replies where id = $1 and org_id = $2", [replyId, orgId]))).rows[0]?.origin;
  return origin === "ai" ? (await widgetKnowledge(orgId, REPLY_KNOWLEDGE_SECTIONS)).text : "";
}

/** The rules a reply is held to: its words, and for an AI draft also the claims the business's approved information does not back. Returns the first problem's message, or null. */
function problemFor(ctx: ReplyContext, body: string, basis: string): string | null {
  const claims = ctx.reply.origin === "ai" ? unsupportedClaims(body, basis) : [];
  return replyProblems(body, { claims })[0]?.message ?? null;
}

function approvalHashFor(ctx: ReplyContext, version: number, body: string): string {
  return replyApprovalHash({
    orgId: ctx.reply.org_id, connectionId: ctx.connection.id, reviewId: ctx.review.id, providerReviewId: ctx.review.provider_review_id,
    fingerprint: reviewFingerprint(ctx.review), version, body,
  });
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** Puts a new draft on a review. Used for a person's own words and, by reply-ai.ts, for what the AI assist drafted for a person. The caller has made its permission checks. */
export async function insertReply(
  db: Queryable, input: { orgId: string; reviewId: string; body: string; origin: "human" | "ai"; authorId: string; aiMeta?: Record<string, unknown> | null },
): Promise<string> {
  const body = cleanReplyBody(input.body);
  const review = (await db.query<{ removed_at: Date | null; status: string }>(
    `select r.removed_at, c.status from external_reviews r join review_connections c on c.id = r.connection_id and c.org_id = r.org_id where r.id = $1 and r.org_id = $2 for update of r`,
    [input.reviewId, input.orgId],
  )).rows[0];
  if (!review) throw new AppError("not_found", "That review was not found.");
  if (review.removed_at) throw new AppError("conflict", "This review is no longer on the review site, so it can't be answered.");
  if (review.status !== "connected") throw new AppError("conflict", "The connection to the review site needs attention, so reviews can't be answered until it is fixed.");
  const open = await db.query("select 1 from review_replies where review_id = $1 and org_id = $2 and status in ('draft', 'pending_approval', 'changes_requested', 'approved', 'posting', 'failed', 'needs_reconciliation')", [input.reviewId, input.orgId]);
  if (open.rows[0]) throw new AppError("conflict", "This review already has a reply in progress. Open it, or cancel it to start another.");
  const { rows } = await db.query<{ id: string }>(
    "insert into review_replies (org_id, review_id, body, origin, ai_meta, author_id) values ($1, $2, $3, $4, $5::jsonb, $6) returning id",
    [input.orgId, input.reviewId, body, input.origin, input.aiMeta ? JSON.stringify(input.aiMeta) : null, input.authorId],
  );
  return rows[0].id;
}

/** Starts a reply to a review, in a person's own words. */
export async function startReply(actor: CrmActor, reviewId: string, input: { body: string }): Promise<{ id: string }> {
  const userId = assertDrafter(actor);
  const body = cleanReplyBody(input.body);
  const bad = replyProblems(body)[0];
  if (bad) throw new AppError("invalid_input", bad.message);
  return withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const id = await insertReply(db, { orgId: actor.orgId, reviewId, body, origin: "human", authorId: userId });
    await addEvent(db, actor.orgId, id, "created", actorOf(actor), { origin: "human" });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_created", targetType: "review_reply", targetId: id, result: "success", metadata: { origin: "human" } }, db);
    return { id };
  });
}

/** Changes the words of a reply. The version goes up and any approval is void: what a person approved is exactly what they read. */
export async function editReply(actor: CrmActor, replyId: string, input: { body: string; expectedVersion: number }): Promise<{ version: number }> {
  assertDrafter(actor);
  const body = cleanReplyBody(input.body);
  const bad = replyProblems(body)[0];
  if (bad) throw new AppError("invalid_input", bad.message);
  return withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const ctx = await loadContext(db, actor.orgId, replyId, true);
    if (!ctx) throw new AppError("not_found", "That reply was not found.");
    const r = ctx.reply;
    if (!canTouch(actor, r)) throw new AppError("forbidden", "Only the person who wrote this reply, or the owner or a manager, can change it.");
    if (r.version !== input.expectedVersion) throw new AppError("conflict", "Someone changed this reply. Reload to see their changes, then try again.");
    if (!isEditableReply(r.status)) throw new AppError("conflict", r.status === "posted" ? "A posted reply can't be edited. Start a new reply to replace it." : "This reply can't be edited right now.");
    liveOrThrow(ctx, "changed");
    if (body === r.body) return { version: r.version };
    await db.query(
      `update review_replies set body = $3, version = version + 1, status = 'draft', approved_version = null, approved_hash = null, approved_by = null, approved_at = null,
         decision_note = null, failure_code = null, failure_message = null where id = $1 and org_id = $2`,
      [replyId, actor.orgId, body],
    );
    await addEvent(db, actor.orgId, replyId, "edited", actorOf(actor), { fromVersion: r.version, approvalVoided: r.approved_version !== null });
    return { version: r.version + 1 };
  });
}

/** Asks the owner or a manager to approve this version. Blocking problems stop it here, so nobody is asked to read something that could not be posted. */
export async function submitReply(actor: CrmActor, replyId: string, input: { version: number }): Promise<void> {
  assertDrafter(actor);
  const basis = await claimsBasis(actor.orgId, replyId);
  await withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const ctx = await loadContext(db, actor.orgId, replyId, true);
    if (!ctx) throw new AppError("not_found", "That reply was not found.");
    const r = ctx.reply;
    if (!canTouch(actor, r)) throw new AppError("forbidden", "Only the person who wrote this reply, or the owner or a manager, can send it for approval.");
    if (r.version !== input.version) throw new AppError("conflict", "Someone changed this reply. Reload to see their changes, then try again.");
    if (!canTransitionReply(r.status, "pending_approval")) throw new AppError("conflict", "This reply can't be sent for approval from where it is now.");
    liveOrThrow(ctx, "sent for approval");
    const bad = problemFor(ctx, r.body, basis);
    if (bad) throw new AppError("invalid_input", bad);
    await db.query("update review_replies set status = 'pending_approval', decision_note = null where id = $1 and org_id = $2", [replyId, actor.orgId]);
    await addEvent(db, actor.orgId, replyId, "submitted", actorOf(actor), { version: r.version });
    await notifyOrgRoles(db, actor.orgId, ["owner", "admin"], {
      kind: "review_reply_requested", severity: "info", title: "A reply to a review is waiting for your approval",
      body: `${ctx.connection.name}: a reply was written and needs a person to read it before it can be posted.`, link: `/crm/reviews?tab=public&review=${r.review_id}`, dedupeKey: `review-reply-req:${replyId}:${r.version}`,
    });
  });
}

export type ReplyDecision = "approve" | "request_changes" | "reject";

/** The owner's or a manager's decision on one version. Approving makes the hash the posting will be checked against. */
export async function decideReply(actor: CrmActor, replyId: string, input: { decision: ReplyDecision; version: number; note?: string | null }): Promise<void> {
  const userId = assertPublisher(actor);
  const note = input.note?.trim().slice(0, 600) || null;
  if (input.decision === "request_changes" && !note) throw new AppError("invalid_input", "Say what should change.");
  const basis = await claimsBasis(actor.orgId, replyId);
  await withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const ctx = await loadContext(db, actor.orgId, replyId, true);
    if (!ctx) throw new AppError("not_found", "That reply was not found.");
    const r = ctx.reply;
    if (r.status !== "pending_approval") throw new AppError("conflict", "This reply is not waiting for approval.");
    if (r.version !== input.version) throw new AppError("conflict", "The reply changed while you were reading it. Read the new version.");
    if (input.decision === "approve") {
      liveOrThrow(ctx, "approved");
      const bad = problemFor(ctx, r.body, basis);
      if (bad) throw new AppError("invalid_input", bad);
      await db.query(
        "update review_replies set status = 'approved', approved_version = version, approved_hash = $3, approved_by = $4, approved_at = now(), decision_note = $5 where id = $1 and org_id = $2",
        [replyId, actor.orgId, approvalHashFor(ctx, r.version, r.body), userId, note],
      );
    } else {
      const to: ReplyStatus = input.decision === "reject" ? "rejected" : "changes_requested";
      await db.query("update review_replies set status = $3, decision_note = $4, approved_version = null, approved_hash = null, approved_by = null, approved_at = null where id = $1 and org_id = $2", [replyId, actor.orgId, to, note]);
    }
    const kind = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "changes_requested";
    await addEvent(db, actor.orgId, replyId, kind, actorOf(actor), { version: r.version, note, origin: r.origin });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: `reputation.reply_${kind}`, targetType: "review_reply", targetId: replyId, result: "success", metadata: { version: r.version, origin: r.origin } }, db);
    if (r.author_id && r.author_id !== userId) {
      await notifyUser(db, r.author_id, actor.orgId, {
        kind: "review_reply_decided", severity: "info",
        title: input.decision === "approve" ? "Your reply to a review was approved" : input.decision === "reject" ? "Your reply to a review was rejected" : "Changes were requested on your reply to a review",
        body: note ?? undefined, link: `/crm/reviews?tab=public&review=${r.review_id}`, dedupeKey: `review-reply-decided:${replyId}:${r.version}:${kind}`,
      });
    }
  });
}

/** Cancels a reply that has not been posted. A reply that is being sent, or may have been sent, is never cancelled quietly. */
export async function cancelReply(actor: CrmActor, replyId: string): Promise<void> {
  assertDrafter(actor);
  await withSystem(async (db) => {
    const ctx = await loadContext(db, actor.orgId, replyId, true);
    if (!ctx) throw new AppError("not_found", "That reply was not found.");
    const r = ctx.reply;
    if (!canTouch(actor, r)) throw new AppError("forbidden", "Only the person who wrote this reply, or the owner or a manager, can cancel it.");
    if (r.status === "posting" || r.status === "needs_reconciliation") throw new AppError("conflict", "This reply is being sent or checked, so it can't be cancelled now. If it appears on the review site, remove it there.");
    if (!canTransitionReply(r.status, "cancelled")) throw new AppError("conflict", "This reply can't be cancelled.");
    await db.query("update review_replies set status = 'cancelled', approved_version = null, approved_hash = null, approved_by = null, approved_at = null where id = $1 and org_id = $2", [replyId, actor.orgId]);
    await addEvent(db, actor.orgId, replyId, "cancelled", actorOf(actor));
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_cancelled", targetType: "review_reply", targetId: replyId, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Posting
// ---------------------------------------------------------------------------

export interface PostDeps {
  provider?: ReviewProvider;
  now?: Date;
  /** Epoch milliseconds after which the review site is no longer waited on (the scheduler's budget). Reads only: a post is never abandoned. */
  deadline?: number;
}

const trim400 = (s: string) => s.slice(0, 400);

/**
 * Posts an approved reply. The steps: check everything while holding the reply's row (the approval is of this version, the hash still matches the review and the words, the rules
 * still pass, the connection works and can post), write "posting" and the time BEFORE the request leaves, ask the site, then record what it answered. An answer that did not come
 * back leaves the reply "being checked"; the reply is never sent a second time until the check says it was not posted and a person presses Post again.
 */
export async function postReply(actor: CrmActor, replyId: string, deps: PostDeps = {}): Promise<{ status: ReplyStatus }> {
  const userId = assertPublisher(actor);
  const now = deps.now ?? new Date();
  const basis = await claimsBasis(actor.orgId, replyId);
  const prepared = await withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const ctx = await loadContext(db, actor.orgId, replyId, true);
    if (!ctx) throw new AppError("not_found", "That reply was not found.");
    const r = ctx.reply;
    if (r.status !== "approved" && r.status !== "failed") throw new AppError("conflict", r.status === "posted" ? "This reply is already posted." : r.status === "posting" || r.status === "needs_reconciliation" ? "This reply is being sent or checked. It is not sent again until that is known." : "This reply has not been approved.");
    if (r.approved_version === null || r.approved_version !== r.version || !r.approved_hash) throw new AppError("conflict", "The approval is for an earlier version of this reply. Send it for approval again.");
    // The words and the review as they are now must produce the hash the approval was made with.
    if (approvalHashFor(ctx, r.approved_version, r.body) !== r.approved_hash) {
      throw new AppError("conflict", "The review or the reply changed after it was approved, so it was not posted. Send the reply for approval again.");
    }
    liveOrThrow(ctx, "posted");
    const bad = problemFor(ctx, r.body, basis);
    if (bad) throw new AppError("invalid_input", bad);
    const can = replyPostable(ctx.connection);
    if (!can.ok) throw new AppError("unavailable", can.reason);
    const creds = await connectionCredentials(db, ctx.connection);
    // A connection whose saved sign-in can't be used is recorded as needing to be reconnected, outside this transaction (a refusal below would undo it).
    if (!creds.ok) return { ctx, creds: null, problem: creds.reason };
    await db.query("update review_replies set status = 'posting', sending_at = $3, failure_code = null, failure_message = null where id = $1 and org_id = $2", [replyId, actor.orgId, now]);
    await addEvent(db, actor.orgId, replyId, "posting", actorOf(actor), { version: r.version });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_posting", targetType: "review_reply", targetId: replyId, result: "success", metadata: { version: r.version, origin: r.origin, provider: ctx.connection.provider } }, db);
    return { ctx, creds: creds.creds, problem: null };
  });
  const { ctx } = prepared;
  if (!prepared.creds) {
    await withSystem((db) => recordProviderFailure(db, ctx.connection, new ProviderError("auth", prepared.problem as string, { needsReauth: true }), now));
    throw new AppError("unavailable", prepared.problem as string);
  }
  const creds = prepared.creds;
  const provider = deps.provider ?? reviewProviderFor(ctx.connection.adapter);
  const loc = { provider: ctx.connection.provider, accountId: ctx.connection.external_account_id, locationId: ctx.connection.external_location_id };
  let postedAt: Date | null = null;
  try {
    const sent = await provider.postReply(creds, loc, ctx.review.provider_review_id, ctx.reply.body);
    postedAt = sent.postedAt ?? now;
  } catch (e) {
    const err = e instanceof ProviderError ? e : new ProviderError("unknown_outcome", "The review site did not confirm whether it took the reply. It is being checked and will not be sent again until that is known.");
    return withSystem(async (db) => {
      if (err.kind === "unknown_outcome") {
        await db.query("update review_replies set status = 'needs_reconciliation', failure_code = 'unknown_outcome', failure_message = $3 where id = $1 and org_id = $2", [replyId, actor.orgId, trim400(err.message)]);
        await addEvent(db, actor.orgId, replyId, "outcome_unknown", { id: null, kind: "system" }, { message: err.message });
        return { status: "needs_reconciliation" as ReplyStatus };
      }
      // Replying is the optional part of a connection. A site that refuses a reply for lack of permission has not stopped accepting the sign-in: only replies are switched off,
      // reading carries on, and the connection is not marked as needing to be reconnected. A sign-in the site rejects (kind auth) still is.
      const noPermission = err.kind === "permission";
      const message = noPermission ? `${PROVIDER_LABELS[ctx.connection.provider]} did not allow this reply with the access it was given. Reconnect with permission to reply, or post the reply there yourself.` : err.message;
      await db.query("update review_replies set status = 'failed', failure_code = $3, failure_message = $4 where id = $1 and org_id = $2", [replyId, actor.orgId, err.kind.slice(0, 60), trim400(message)]);
      await addEvent(db, actor.orgId, replyId, "failed", { id: null, kind: "system" }, { code: err.kind });
      if (noPermission) await markRepliesNotAllowed(db, ctx.connection);
      else if (err.needsReauth || err.kind === "auth") await recordProviderFailure(db, ctx.connection, err, now);
      await notifyFailure(db, actor.orgId, ctx, `${ctx.reply.id}:${ctx.reply.version}:${now.getTime()}`, message);
      return { status: "failed" as ReplyStatus };
    });
  }
  const at = postedAt;
  await withSystem(async (db) => {
    await db.query(
      "update review_replies set status = 'posted', posted_at = $3, posted_by = $4, posted_via = 'provider', failure_code = null, failure_message = null where id = $1 and org_id = $2",
      [replyId, actor.orgId, at, userId],
    );
    await db.query("update external_reviews set provider_reply_text = $3, provider_reply_at = $4 where id = $1 and org_id = $2", [ctx.review.id, actor.orgId, ctx.reply.body, at]);
    await addEvent(db, actor.orgId, replyId, "posted", actorOf(actor), { version: ctx.reply.version, via: "provider" });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_posted", targetType: "review_reply", targetId: replyId, result: "success", metadata: { version: ctx.reply.version, origin: ctx.reply.origin, provider: ctx.connection.provider } }, db);
  });
  // The site is asked once whether it shows the reply. A site that cannot answer leaves the reply "posted, not yet confirmed": it is confirmed the next time the reviews are read.
  try {
    const seen = await provider.readReply(creds, loc, ctx.review.provider_review_id, ctx.reply.body);
    if (seen.state === "found" && squashReply(seen.text) === squashReply(ctx.reply.body)) {
      await withSystem((db) => db.query("update review_replies set verified_at = $3 where id = $1 and org_id = $2 and verified_at is null", [replyId, actor.orgId, now]));
    }
  } catch {
    // Not confirmed yet; nothing to undo.
  }
  return { status: "posted" };
}

async function notifyFailure(db: Queryable, orgId: string, ctx: ReplyContext, key: string, message: string): Promise<void> {
  const note = {
    kind: "review_reply_failed" as const, severity: "warning" as const, title: "A reply to a review was not posted",
    body: `${ctx.connection.name}: ${message}`.slice(0, 300), link: `/crm/reviews?tab=public&review=${ctx.reply.review_id}`, dedupeKey: `review-reply-fail:${key}`,
  };
  await notifyOrgRoles(db, orgId, ["owner", "admin"], note);
  if (ctx.reply.author_id) await notifyUser(db, ctx.reply.author_id, orgId, note);
}

// ---------------------------------------------------------------------------
// Settling a reply whose outcome is not known
// ---------------------------------------------------------------------------

export type ReconcileOutcome = "posted" | "failed" | "waiting" | "needs_person" | "skipped";

/**
 * After RECONCILE_GIVE_UP_HOURS without an answer, the owner and managers are asked to look at the review site themselves, once for this version of the reply. Whatever stopped the
 * answer (a site that cannot say, one that is down or refuses, a sign-in that cannot be opened, a connection a person ended) does not matter: the day-clock runs without the read.
 * Returns whether the day has passed.
 */
async function askPersonToCheck(db: Queryable, orgId: string, ctx: ReplyContext, now: Date, sendingAt: Date): Promise<boolean> {
  if (now.getTime() - sendingAt.getTime() < RECONCILE_GIVE_UP_HOURS * 3_600_000) return false;
  const { id, version } = ctx.reply;
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "review_reply_failed", severity: "warning", title: "Check whether a reply was posted", body: `${ctx.connection.name}: iAcquire could not tell whether the reply went out. Look at the review on the site, then say here whether it is there.`,
    link: `/crm/reviews?tab=public&review=${ctx.reply.review_id}`, dedupeKey: `review-reply-check:${id}:${version}`,
  });
  const told = await db.query("select 1 from review_reply_events where reply_id = $1 and org_id = $2 and kind = 'check_requested' and detail->>'version' = $3 limit 1", [id, orgId, String(version)]);
  if (!told.rows[0]) await addEvent(db, orgId, id, "check_requested", { id: null, kind: "system" }, { version });
  return true;
}

/** The site could not be asked, or did not say. Nothing is settled on a guess, but the day-clock still runs. */
async function settleWithoutAnswer(orgId: string, replyId: string, now: Date): Promise<ReconcileOutcome> {
  return withSystem(async (db) => {
    const cur = await loadContext(db, orgId, replyId, true);
    // A person settled it, or another pass did, in the meantime.
    if (!cur || cur.reply.status !== "needs_reconciliation") return "skipped";
    const sendingAt = cur.reply.sending_at ? new Date(cur.reply.sending_at) : now;
    return (await askPersonToCheck(db, orgId, cur, now, sendingAt)) ? "needs_person" : "waiting";
  });
}

/**
 * Asks the review site whether a reply it may have taken is there. Found word for word: posted. Found with other words: not posted (someone else's reply is there; posting again
 * would replace it, which is a person's decision). Not found: still waiting until the grace period has passed, then not posted. A site that cannot say, cannot be reached or cannot be
 * asked at all: waiting, and after a day the owner and managers are asked to look at the site themselves. A reply stuck in "posting" because its worker died is first moved to "checking".
 */
export async function reconcileReply(orgId: string, replyId: string, deps: PostDeps = {}): Promise<ReconcileOutcome> {
  const now = deps.now ?? new Date();
  const loaded = await withSystem(async (db) => {
    const ctx = await loadContext(db, orgId, replyId, true);
    if (!ctx) return null;
    const r = ctx.reply;
    if (r.status === "posting" && r.sending_at && now.getTime() - new Date(r.sending_at).getTime() >= POSTING_STALE_MINUTES * 60_000) {
      await db.query("update review_replies set status = 'needs_reconciliation', failure_code = 'unknown_outcome', failure_message = 'Sending was interrupted before the review site answered.' where id = $1 and org_id = $2", [replyId, orgId]);
      await addEvent(db, orgId, replyId, "posting_interrupted", { id: null, kind: "system" });
      r.status = "needs_reconciliation";
    }
    if (r.status !== "needs_reconciliation") return null;
    // A connection a person ended cannot be asked, but the reply is still unsettled: it is not skipped for good.
    if (ctx.connection.status === "disconnected") return { ctx, creds: null };
    const creds = await connectionCredentials(db, ctx.connection);
    return creds.ok ? { ctx, creds: creds.creds } : { ctx, creds: null };
  });
  if (!loaded) return "skipped";
  const { ctx, creds } = loaded;
  if (!creds) return settleWithoutAnswer(orgId, replyId, now);
  const provider = deps.provider ?? reviewProviderFor(ctx.connection.adapter);
  const loc = { provider: ctx.connection.provider, accountId: ctx.connection.external_account_id, locationId: ctx.connection.external_location_id };
  const sendingAt = ctx.reply.sending_at ? new Date(ctx.reply.sending_at) : now;
  let seen: ReplyRead;
  try {
    seen = await within(() => provider.readReply(creds, loc, ctx.review.provider_review_id, ctx.reply.body), deps.deadline);
  } catch (e) {
    if (e instanceof ProviderError && (e.needsReauth || e.kind === "auth" || e.kind === "permission")) await withSystem((db) => recordProviderFailure(db, ctx.connection, e, now));
    // No answer, for whatever reason (the site failed, or the pass ran out of time waiting): nothing is settled, and the day-clock still runs.
    return settleWithoutAnswer(orgId, replyId, now);
  }
  return withSystem(async (db) => {
    const cur = await loadContext(db, orgId, replyId, true);
    // A person settled it, or it was posted by another pass, while the site was being asked.
    if (!cur || cur.reply.status !== "needs_reconciliation") return "skipped" as ReconcileOutcome;
    const ours = squashReply(ctx.reply.body);
    if (seen.state === "found" && squashReply(seen.text) === ours) {
      await db.query(
        "update review_replies set status = 'posted', posted_at = coalesce($3::timestamptz, sending_at), posted_via = 'provider', verified_at = $4, failure_code = null, failure_message = null where id = $1 and org_id = $2",
        [replyId, orgId, seen.at, now],
      );
      await db.query("update external_reviews set provider_reply_text = $3, provider_reply_at = coalesce($4::timestamptz, $5::timestamptz) where id = $1 and org_id = $2", [ctx.review.id, orgId, ctx.reply.body, seen.at, now]);
      await addEvent(db, orgId, replyId, "posted_confirmed", { id: null, kind: "system" }, { via: "check" });
      await recordAudit({ orgId, actorKind: "system", action: "reputation.reply_posted", targetType: "review_reply", targetId: replyId, result: "success", metadata: { version: ctx.reply.version, via: "check", provider: ctx.connection.provider } }, db);
      return "posted" as ReconcileOutcome;
    }
    if (seen.state === "found") {
      await db.query("update review_replies set status = 'failed', failure_code = 'different_reply_on_site', failure_message = 'The review site shows a different reply, so this one was not posted. Posting it would replace the one that is there.' where id = $1 and org_id = $2", [replyId, orgId]);
      await addEvent(db, orgId, replyId, "not_posted", { id: null, kind: "system" }, { reason: "different_reply_on_site" });
      await notifyFailure(db, orgId, ctx, `${replyId}:${ctx.reply.version}:other`, "The review site shows a different reply, so this one was not posted.");
      return "failed" as ReconcileOutcome;
    }
    const waitedMs = now.getTime() - sendingAt.getTime();
    if (seen.state === "absent" && waitedMs >= RECONCILE_GRACE_MINUTES * 60_000) {
      await db.query("update review_replies set status = 'failed', failure_code = 'not_found_after_send', failure_message = 'The review site does not show this reply, so it is treated as not posted. You can try again.' where id = $1 and org_id = $2", [replyId, orgId]);
      await addEvent(db, orgId, replyId, "not_posted", { id: null, kind: "system" }, { reason: "not_found_after_send" });
      await notifyFailure(db, orgId, ctx, `${replyId}:${ctx.reply.version}:absent`, "The review site does not show the reply, so it was not posted.");
      return "failed" as ReconcileOutcome;
    }
    return (await askPersonToCheck(db, orgId, cur, now, sendingAt)) ? ("needs_person" as ReconcileOutcome) : ("waiting" as ReconcileOutcome);
  });
}

export interface ReconcileSummary {
  checked: number;
  posted: number;
  failed: number;
  waiting: number;
}

/**
 * The scheduler's pass over replies being checked, and over replies stuck in "posting". It never posts anything. `budgetMs` is the time the pass may take: no reply is started once it
 * is used up, and a site that is still being waited on then is abandoned (the reply stays as it was). Replies the owner and managers were already asked to look at come last, so a
 * few that stay stuck cannot crowd the others out of the batch.
 */
export async function reconcileDueReplies(opts: { now?: Date; limit?: number; provider?: ReviewProvider; budgetMs?: number } = {}): Promise<ReconcileSummary> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const deadline = opts.budgetMs === undefined ? undefined : started + opts.budgetMs;
  const ids = (await withSystem((db) => db.query<{ id: string; org_id: string }>(
    `select p.id, p.org_id from review_replies p
     join organizations o on o.id = p.org_id and o.status not in ('suspended', 'archived')
     where (p.status = 'needs_reconciliation' or (p.status = 'posting' and p.sending_at <= $1::timestamptz - make_interval(mins => $3::int)))
     order by exists (select 1 from review_reply_events e where e.reply_id = p.id and e.org_id = p.org_id and e.kind = 'check_requested' and e.detail->>'version' = p.version::text),
              p.sending_at nulls first limit $2`,
    [now.toISOString(), opts.limit ?? RECONCILE_BATCH, POSTING_STALE_MINUTES],
  ))).rows;
  const out: ReconcileSummary = { checked: 0, posted: 0, failed: 0, waiting: 0 };
  for (const r of ids) {
    if (deadline !== undefined && Date.now() >= deadline) break;
    const o = await reconcileReply(r.org_id, r.id, { now, provider: opts.provider, deadline });
    if (o === "skipped") continue;
    out.checked += 1;
    if (o === "posted") out.posted += 1;
    else if (o === "failed") out.failed += 1;
    else out.waiting += 1;
  }
  return out;
}

/**
 * A person says what happened on the review site, in their own words. "I posted it" is allowed for an approved reply that cannot be posted from here (the site's reply switch is
 * off), and for a reply whose result is being checked; "it was not posted" only for the second. Both are the person's word, recorded as such and audited; neither is described
 * as something iAcquire verified.
 */
export async function resolveReply(actor: CrmActor, replyId: string, input: { outcome: "posted" | "not_posted" }): Promise<void> {
  const userId = assertPublisher(actor);
  await withSystem(async (db) => {
    await assertExternalReviewsEnabled(db, actor.orgId);
    const ctx = await loadContext(db, actor.orgId, replyId, true);
    if (!ctx) throw new AppError("not_found", "That reply was not found.");
    const r = ctx.reply;
    const checking = r.status === "needs_reconciliation";
    if (input.outcome === "posted") {
      const approvedHere = r.status === "approved" && !replyPostable(ctx.connection).ok;
      if (!checking && !approvedHere) throw new AppError("conflict", "This reply can't be marked as posted from where it is now.");
      if (r.status === "approved" && approvalHashFor(ctx, r.approved_version ?? 0, r.body) !== r.approved_hash) {
        throw new AppError("conflict", "The review or the reply changed after it was approved. Send it for approval again before you post it.");
      }
      await db.query("update review_replies set status = 'posted', posted_at = now(), posted_by = $3, posted_via = 'person', failure_code = null, failure_message = null where id = $1 and org_id = $2", [replyId, actor.orgId, userId]);
    } else {
      if (!checking) throw new AppError("conflict", "Only a reply whose result is being checked can be marked as not posted.");
      await db.query("update review_replies set status = 'failed', failure_code = 'confirmed_not_posted', failure_message = 'A person confirmed this was not posted. You can try again.' where id = $1 and org_id = $2", [replyId, actor.orgId]);
    }
    await addEvent(db, actor.orgId, replyId, "resolved_by_person", actorOf(actor), { outcome: input.outcome });
    await recordAudit({ orgId: actor.orgId, ...auditActor(actor), action: "reputation.reply_resolved", targetType: "review_reply", targetId: replyId, result: "success", metadata: { outcome: input.outcome } }, db);
  });
}

