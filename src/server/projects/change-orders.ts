import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { notifyAgency, notifyOrgRoles, type NotificationInput } from "@/server/notifications";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { assertRequestChangesEnabled } from "@/server/support/change-feature";
import { CLIENT_ROLES, addUpdate, authorizeRequest, closeTasks, finishChangeReviewTask, firstLookHours, isStaff, orgToday, type LockedProject } from "@/server/projects/access";
import { changeQuoteHash, iso, type ChangeDecisionView, type ChangeOrderView, type ScopeAmendmentView } from "@/server/projects/shared";
import { freeTextProblem } from "@/lib/invoices/guards";
import { formatMinor, isCurrency } from "@/lib/money";
import {
  CHANGE_ACCEPT_ACKNOWLEDGEMENT, CHANGE_DECLINE_ACKNOWLEDGEMENT, MAX_OPEN_CHANGE_ORDERS, amendmentScope, canMoveChangeOrder, canUseRevision, changeQuoteCanonical,
  describeQuote, isOpenChange, isQuoteExpired, projectTakesChangeOrder, validateChangeQuote, type ChangeOrderClassification, type ChangeOrderStatus, type ChangeQuoteInput,
} from "@/lib/project-change-orders";

// Change orders: what a client asks for after a custom project was agreed, and how the team answers. Staff classify it (a revision the agreement includes, or something outside
// it), and for the second kind write a quote: a price, estimated weeks and terms, all their own words and numbers. Nothing is priced from here and no date is promised. The
// client's owner accepts or declines that exact quote; the answer is kept for good, and an accepted change is added to the agreed scope as an amendment (the original scope is
// never rewritten). Declined and withdrawn changes stay on the project's list.
//
// The database holds the order of writes (supabase/migrations/0098_requests_completion.sql): a quote is sent in one statement, a decision is recorded against the waiting
// quote's version and hash, the status follows it, and the amendment follows that, all in one transaction. Every path here locks the project, then the change.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ChangeRow {
  id: string;
  ref: string;
  org_id: string;
  request_id: string;
  ticket_id: string | null;
  title: string;
  description: string;
  status: ChangeOrderStatus;
  classification: ChangeOrderClassification;
  quote_version: number;
  additional_cents: number | null;
  currency: string | null;
  additional_weeks_min: number | null;
  additional_weeks_max: number | null;
  terms_text: string | null;
  valid_until: string | null;
  content_hash: string | null;
  requested_by: string | null;
}

const CHANGE_COLUMNS = `id, ref, org_id, request_id, ticket_id, title, description, status, classification, quote_version, additional_cents, currency, additional_weeks_min,
  additional_weeks_max, terms_text, valid_until::text as valid_until, content_hash, requested_by`;

interface ProjectRow { id: string; org_id: string; ref: string; title: string; status: string }

const key = (requestId: string, changeId: string, ...rest: Array<string | number>) => ["project", requestId, "change", changeId, ...rest].join(":");

/** Tells the people on the client's side who can act on it. The body never carries what anyone typed: email is outside the portal's access controls. */
const tellClient = (db: Queryable, orgId: string, n: Omit<NotificationInput, "kind">) => notifyOrgRoles(db, orgId, CLIENT_ROLES, { kind: "project_change_order", ...n });
/** Tells the team members who work on the client and may see projects. */
const tellTeam = (db: Queryable, orgId: string, n: Omit<NotificationInput, "kind">) => notifyAgency(db, orgId, { kind: "project_change_order", ...n }, { permission: "projects.view" });

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

/**
 * The changes of one project, with each quote's recorded answers, and what accepted changes added to the agreed scope. `internal` is true only for trusted agency code: a
 * client's session never selects the team's notes (the column is not granted to them).
 */
export async function loadChangeOrders(db: Queryable, requestId: string, opts: { internal: boolean; today: string }): Promise<{ changes: ChangeOrderView[]; amendments: ScopeAmendmentView[] }> {
  const orders = (await db.query<{
    id: string; ref: string; title: string; description: string; status: ChangeOrderStatus; classification: ChangeOrderClassification; quote_version: number;
    additional_cents: number | null; currency: string | null; additional_weeks_min: number | null; additional_weeks_max: number | null; terms_text: string | null;
    valid_until: string | null; ticket_id: string | null; requested_at: Date; requested_by_name: string | null; quoted_at: Date | null; decided_at: Date | null; applied_at: Date | null;
    internal_notes?: string | null;
  }>(
    `select c.id, c.ref, c.title, c.description, c.status, c.classification, c.quote_version, c.additional_cents, c.currency, c.additional_weeks_min, c.additional_weeks_max,
            c.terms_text, c.valid_until::text as valid_until, c.ticket_id, c.requested_at, ru.full_name as requested_by_name, c.quoted_at, c.decided_at, c.applied_at${opts.internal ? ", c.internal_notes" : ""}
     from project_change_orders c left join users ru on ru.id = c.requested_by where c.request_id = $1 order by c.requested_at desc, c.ref desc`,
    [requestId],
  )).rows;
  const ids = orders.map((o) => o.id);
  const decisions = ids.length
    ? (await db.query<{ change_order_id: string; quote_version: number; decision: "accepted" | "declined"; note: string | null; decided_at: Date; decided_by_name: string | null }>(
        `select d.change_order_id, d.quote_version, d.decision, d.note, d.decided_at, du.full_name as decided_by_name
         from project_change_order_decisions d left join users du on du.id = d.decided_by where d.change_order_id = any($1::uuid[]) order by d.quote_version`,
        [ids],
      )).rows
    : [];
  const byOrder = new Map<string, ChangeDecisionView[]>();
  for (const d of decisions) {
    const list = byOrder.get(d.change_order_id) ?? [];
    list.push({ quoteVersion: d.quote_version, decision: d.decision, note: d.note, decidedAt: iso(d.decided_at)!, decidedByName: d.decided_by_name });
    byOrder.set(d.change_order_id, list);
  }
  const amendments = (await db.query<{
    id: string; change_order_id: string; ref: string; title: string; added_scope: string; added_cents: number; currency: string; added_weeks_min: number | null; added_weeks_max: number | null; agreed_at: Date;
  }>(
    `select a.id, a.change_order_id, c.ref, c.title, a.added_scope, a.added_cents, a.currency, a.added_weeks_min, a.added_weeks_max, a.agreed_at
     from project_scope_amendments a join project_change_orders c on c.id = a.change_order_id where a.request_id = $1 order by a.agreed_at, c.ref`,
    [requestId],
  )).rows;
  return {
    changes: orders.map((o) => ({
      id: o.id, ref: o.ref, title: o.title, description: o.description, status: o.status, classification: o.classification, quoteVersion: o.quote_version,
      additionalCents: o.additional_cents, currency: o.currency, weeksMin: o.additional_weeks_min, weeksMax: o.additional_weeks_max, termsText: o.terms_text, validUntil: o.valid_until,
      expired: o.status === "quoted" && isQuoteExpired(o.valid_until, opts.today), ticketId: o.ticket_id, requestedAt: iso(o.requested_at)!, requestedByName: o.requested_by_name,
      quotedAt: iso(o.quoted_at), decidedAt: iso(o.decided_at), appliedAt: iso(o.applied_at), decisions: byOrder.get(o.id) ?? [],
      ...(opts.internal ? { internalNotes: o.internal_notes ?? null } : {}),
    })),
    amendments: amendments.map((a) => ({
      id: a.id, changeOrderId: a.change_order_id, changeRef: a.ref, changeTitle: a.title, addedScope: a.added_scope, addedCents: a.added_cents, currency: a.currency,
      weeksMin: a.added_weeks_min, weeksMax: a.added_weeks_max, agreedAt: iso(a.agreed_at)!,
    })),
  };
}

// ---------------------------------------------------------------------------
// The client asks
// ---------------------------------------------------------------------------

export const changeOrderSchema = z.object({
  title: z.string().trim().min(3, "Give the change a short title.").max(160, "The title can be up to 160 characters."),
  description: z.string().trim().min(10, "Describe the change you'd like in a sentence or two.").max(4000, "The description can be up to 4,000 characters."),
  idempotencyKey: z.string().min(8).max(80).optional(),
});
export type ChangeOrderInput = z.input<typeof changeOrderSchema>;

export interface NewChangeOrder { id: string; ref: string; existing: boolean }

/**
 * Files a change on an agreed project inside the caller's transaction (also used when a Request a Change request names a project, so the request and the change are one
 * record). The caller has checked the person's permission and that the feature is on. The project row is locked here.
 */
export async function createChangeOrderTx(
  db: Queryable,
  actor: { orgId: string; orgName: string; userId: string },
  requestId: string,
  input: { title: string; description: string; idempotencyKey?: string | null; ticketId?: string | null },
): Promise<NewChangeOrder> {
  const project = (await db.query<ProjectRow>("select id, org_id, ref, title, status from client_project_requests where id = $1 and org_id = $2 for update", [requestId, actor.orgId])).rows[0];
  if (!project) throw new AppError("not_found", "Project not found.");
  const takes = projectTakesChangeOrder(project.status);
  if (!takes.ok) throw new AppError("conflict", takes.reason);
  const agreed = await db.query("select 1 from client_projects where request_id = $1", [requestId]);
  if (!agreed.rows[0]) throw new AppError("conflict", "Changes can be asked for once the project is agreed.");
  const open = (await db.query<{ n: number }>("select count(*)::int as n from project_change_orders where request_id = $1 and status in ('submitted','under_review','needs_info','quoted')", [requestId])).rows[0].n;
  if (open >= MAX_OPEN_CHANGE_ORDERS) throw new AppError("conflict", `This project already has ${MAX_OPEN_CHANGE_ORDERS} changes waiting. Wait for the team to answer some of them first.`);
  const inserted = await db.query<{ id: string; ref: string }>(
    `insert into project_change_orders (org_id, request_id, ticket_id, title, description, requested_by, idempotency_key) values ($1,$2,$3,$4,$5,$6,$7)
     on conflict (org_id, requested_by, idempotency_key) where idempotency_key is not null do nothing returning id, ref`,
    [actor.orgId, requestId, input.ticketId ?? null, input.title, input.description, actor.userId, input.idempotencyKey ?? null],
  );
  if (!inserted.rows[0]) {
    // A retry of the same submission (double click, dropped connection): the change that already exists is the answer, and nobody is told twice.
    const again = (await db.query<{ id: string; ref: string; request_id: string }>(
      "select id, ref, request_id from project_change_orders where org_id = $1 and requested_by = $2 and idempotency_key = $3", [actor.orgId, actor.userId, input.idempotencyKey ?? null],
    )).rows[0];
    if (!again || again.request_id !== requestId) throw new AppError("conflict", "That submission was already used for something else. Reload the page and try again.");
    return { id: again.id, ref: again.ref, existing: true };
  }
  const c = inserted.rows[0];
  // Nobody has looked at it yet: the team's first-look task, due by the same review target as a new project request's, so the overdue-review job notices if it sits.
  await db.query(
    "insert into project_review_tasks (request_id, org_id, kind, title, due_at, change_order_id) values ($1,$2,'review_change',$3, now() + make_interval(hours => $4::int), $5)",
    [requestId, actor.orgId, `Review ${c.ref}: ${input.title}`.slice(0, 200), await firstLookHours(db), c.id],
  );
  await addUpdate(db, project, actor.userId, "system", `Change ${c.ref} requested: ${input.title}`);
  await tellTeam(db, actor.orgId, { title: `${project.ref}: change ${c.ref} requested by ${actor.orgName}`, link: `/admin/projects/${requestId}`, dedupeKey: key(requestId, c.id, "submitted") });
  await recordAudit({ orgId: actor.orgId, actorUserId: actor.userId, actorKind: "user", action: "project.change_submitted", targetType: "project_change_order", targetId: c.id, result: "success", metadata: { ref: c.ref, project: project.ref, fromRequest: Boolean(input.ticketId) } }, db);
  return { id: c.id, ref: c.ref, existing: false };
}

export async function submitChangeOrder(ctx: OrgContext, requestId: string, input: ChangeOrderInput): Promise<NewChangeOrder> {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't ask for changes to a project. Ask a workspace owner or admin.");
  if (!UUID.test(requestId)) throw new AppError("not_found", "Project not found.");
  const parsed = changeOrderSchema.safeParse(input);
  if (!parsed.success) throw new AppError("invalid_input", parsed.error.issues[0]?.message ?? "Check the form and try again.");
  const limit = await consumeRateLimit(RATE_LIMITS.projectActivityByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're sending requests quickly. Give it a moment.", { retryAfterSeconds: limit.retryAfterSeconds });
  return withSystem(async (db) => {
    await assertRequestChangesEnabled(db, ctx);
    return createChangeOrderTx(db, { orgId: ctx.org.orgId, orgName: ctx.org.name, userId: ctx.user.id }, requestId, parsed.data);
  });
}

/** Finds a change in the caller's workspace and locks its project, then the change itself. */
async function lockOwnChange(db: Queryable, orgId: string, changeId: string): Promise<{ change: ChangeRow; project: ProjectRow }> {
  if (!UUID.test(changeId)) throw new AppError("not_found", "Change request not found.");
  const head = (await db.query<{ request_id: string }>("select request_id from project_change_orders where id = $1 and org_id = $2", [changeId, orgId])).rows[0];
  if (!head) throw new AppError("not_found", "Change request not found.");
  const project = (await db.query<ProjectRow>("select id, org_id, ref, title, status from client_project_requests where id = $1 and org_id = $2 for update", [head.request_id, orgId])).rows[0];
  const change = (await db.query<ChangeRow>(`select ${CHANGE_COLUMNS} from project_change_orders where id = $1 for update`, [changeId])).rows[0];
  if (!project || !change) throw new AppError("not_found", "Change request not found.");
  return { change, project };
}

/** The client takes a request back. Allowed while the change is still open, a waiting quote included; the request stays on the project's list as withdrawn. */
export async function withdrawChangeOrder(ctx: OrgContext, changeId: string): Promise<void> {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't change requests. Ask a workspace owner or admin.");
  const limit = await consumeRateLimit(RATE_LIMITS.projectActivityByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Slow down for a moment and try again.");
  await withSystem(async (db) => {
    const { change, project } = await lockOwnChange(db, ctx.org.orgId, changeId);
    if (!isOpenChange(change.status)) throw new AppError("conflict", "This change is no longer open, so it can't be withdrawn.");
    await db.query("update project_change_orders set status = 'withdrawn', decided_at = now() where id = $1", [change.id]);
    await db.query("delete from project_prerequisites where change_order_id = $1 and status = 'pending'", [change.id]);
    // Nobody on the team looked at it: the client took it back.
    await finishChangeReviewTask(db, change.id, null);
    await addUpdate(db, project, ctx.user.id, "system", `Change ${change.ref} was withdrawn.`);
    await tellTeam(db, project.org_id, { severity: "warning", title: `${project.ref}: ${ctx.org.name} withdrew change ${change.ref}`, link: `/admin/projects/${project.id}`, dedupeKey: key(project.id, change.id, "withdrawn") });
    await recordAudit({ orgId: project.org_id, actorUserId: ctx.user.id, actorKind: "user", action: "project.change_withdrawn", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref, from: change.status } }, db);
  });
}

/** The client writes to the team about one change (an answer to a question, or something to add). The message is on the project's conversation, tagged with the change. */
export async function postChangeMessage(ctx: OrgContext, changeId: string, body: string, clientMessageId?: string): Promise<{ id: string; existing: boolean }> {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't message about projects.");
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Messages can be up to 5,000 characters.");
  if (clientMessageId !== undefined && !UUID.test(clientMessageId)) throw new AppError("invalid_input", "That message could not be read. Please try again.");
  const limit = await consumeRateLimit(RATE_LIMITS.projectActivityByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're sending messages quickly. Give it a moment.");
  return withSystem(async (db) => {
    const { change, project } = await lockOwnChange(db, ctx.org.orgId, changeId);
    if (!isOpenChange(change.status) && change.status !== "accepted") throw new AppError("conflict", "This change is closed. Start a new change request if there is more.");
    const answering = change.status === "needs_info";
    const inserted = await db.query<{ id: string }>(
      `insert into project_messages (request_id, org_id, author_id, author_kind, kind, body, client_message_id, change_order_id) values ($1,$2,$3,'client',$4,$5,$6,$7)
       on conflict (request_id, client_message_id) where client_message_id is not null do nothing returning id`,
      [project.id, project.org_id, ctx.user.id, answering ? "info_response" : "message", text, clientMessageId ?? null, change.id],
    );
    if (!inserted.rows[0]) {
      const again = (await db.query<{ id: string }>("select id from project_messages where request_id = $1 and client_message_id = $2", [project.id, clientMessageId ?? null])).rows[0];
      return { id: again?.id ?? "", existing: true };
    }
    const messageId = inserted.rows[0].id;
    // Answering the team's question hands the change back to the team.
    if (answering) await db.query("update project_change_orders set status = 'under_review' where id = $1", [change.id]);
    await db.query("update client_project_requests set last_activity_at = now() where id = $1", [project.id]);
    // A reply is owed, as for any message on the project: one open reply task at a time, settled by the team's next reply (a question on a change, or a message in the conversation).
    await db.query(
      `insert into project_review_tasks (request_id, org_id, kind, title, due_at)
       select $1::uuid, $2::uuid, 'respond_to_client', $3::text, now() + interval '1 day'
       where not exists (select 1 from project_review_tasks where request_id = $1::uuid and kind = 'respond_to_client' and status = 'open')`,
      [project.id, project.org_id, `Reply to ${ctx.org.name} on ${project.ref} (${change.ref})`.slice(0, 200)],
    );
    await tellTeam(db, project.org_id, { title: `${project.ref}: ${ctx.org.name} ${answering ? "answered a question about" : "wrote about"} change ${change.ref}`, link: `/admin/projects/${project.id}`, dedupeKey: key(project.id, change.id, "message", messageId) });
    await recordAudit({ orgId: project.org_id, actorUserId: ctx.user.id, actorKind: "user", action: "project.change_message", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref, answeringQuestion: answering } }, db);
    return { id: messageId, existing: false };
  });
}

/**
 * The owner's answer to the quote that is waiting. Recorded against the exact version and hash that were sent, once; an accepted change is added to the agreed scope in the
 * same transaction. Refused when the quote changed, expired (accepting only), the project is no longer live, or someone else answered first. Nothing is charged.
 */
export async function decideChangeOrder(ctx: OrgContext, changeId: string, decision: "accepted" | "declined", note?: string, ipHash: string | null = null): Promise<{ decision: "accepted" | "declined"; requestId: string }> {
  if (!ctx.can("projects.approve_quote")) throw new AppError("forbidden", "Only a workspace owner can accept or decline a change.");
  const clean = (note ?? "").trim().slice(0, 2000);
  const problem = freeTextProblem("The note", clean);
  if (problem) throw new AppError("invalid_input", problem);
  const limit = await consumeRateLimit(RATE_LIMITS.quoteDecisionByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many quote actions. Please wait a little and try again.");
  return withSystem(async (db) => {
    const { change, project } = await lockOwnChange(db, ctx.org.orgId, changeId);
    if (change.status !== "quoted") throw new AppError("conflict", "This change is no longer waiting for a decision. Refresh to see the latest.");
    // The project may have been held or cancelled after the quote was sent; accepting then would add work to a project nobody is doing.
    const live = projectTakesChangeOrder(project.status);
    if (!live.ok) throw new AppError("conflict", project.status === "on_hold" ? "This project is on hold, so the change can't be decided right now. Ask iAcquire to resume it first." : "This project is no longer taking changes. Ask iAcquire if you still want this change.");
    if (change.additional_cents === null || !change.currency || !change.content_hash || change.terms_text === null) throw new AppError("conflict", "This quote is incomplete. Ask iAcquire to resend it.");
    const expected = changeQuoteHash(changeQuoteCanonical({
      changeId: change.id, version: change.quote_version, title: change.title, description: change.description, additionalMinor: change.additional_cents, currency: change.currency,
      weeksMin: change.additional_weeks_min, weeksMax: change.additional_weeks_max, termsText: change.terms_text, validUntil: change.valid_until,
    }));
    if (expected !== change.content_hash) throw new AppError("conflict", "This quote changed after it was sent. Ask iAcquire to resend it.");
    if (decision === "accepted" && isQuoteExpired(change.valid_until, await orgToday(db, ctx.org.orgId))) throw new AppError("conflict", "This quote has expired. Ask iAcquire for an updated one.");

    await db.query(
      `insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, note, decided_by, content_hash, acknowledgement, ip_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [change.id, change.org_id, change.quote_version, decision, clean || null, ctx.user.id, change.content_hash, decision === "accepted" ? CHANGE_ACCEPT_ACKNOWLEDGEMENT : CHANGE_DECLINE_ACKNOWLEDGEMENT, ipHash],
    );
    await db.query("update project_change_orders set status = $2, decided_at = now() where id = $1", [change.id, decision]);
    if (decision === "accepted") {
      await db.query(
        `insert into project_scope_amendments (org_id, request_id, change_order_id, added_scope, added_cents, currency, added_weeks_min, added_weeks_max, agreed_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [change.org_id, change.request_id, change.id, amendmentScope(change.title, change.terms_text), change.additional_cents, change.currency, change.additional_weeks_min, change.additional_weeks_max, ctx.user.id],
      );
    } else {
      await db.query("delete from project_prerequisites where change_order_id = $1 and status = 'pending'", [change.id]);
    }
    const money = isCurrency(change.currency) ? (change.additional_cents === 0 ? "no extra charge" : formatMinor(change.additional_cents, change.currency, "symbol")) : "";
    await addUpdate(db, project, ctx.user.id, "system", decision === "accepted" ? `Change ${change.ref} accepted (${money}). It is now part of what was agreed.` : `Change ${change.ref} was declined.`);
    // A quote version is decided once (the decision table is unique per version), so the version and the answer name the event.
    await tellTeam(db, project.org_id, {
      severity: decision === "accepted" ? "success" : "warning", title: `${project.ref}: ${ctx.org.name} ${decision} change ${change.ref}`, link: `/admin/projects/${project.id}`,
      dedupeKey: key(project.id, change.id, "quote", change.quote_version, decision),
    });
    await tellClient(db, project.org_id, {
      title: `Your decision on ${change.ref} was recorded`, body: decision === "accepted" ? "Next: iAcquire will confirm how and when this change is paid." : undefined, link: `/projects/${project.id}`,
      dedupeKey: key(project.id, change.id, "quote", change.quote_version, decision, "client"),
    });
    await recordAudit({
      orgId: project.org_id, actorUserId: ctx.user.id, actorKind: "user", action: "project.change_decided", targetType: "project_change_order", targetId: change.id, result: "success",
      metadata: { ref: change.ref, decision, version: change.quote_version, additionalCents: change.additional_cents, currency: change.currency, hash: change.content_hash.slice(0, 12) },
    }, db);
    return { decision, requestId: project.id };
  });
}

// ---------------------------------------------------------------------------
// The team answers
// ---------------------------------------------------------------------------

async function lockAgencyChange(db: Queryable, user: SessionUser, changeId: string, permission: "projects.manage" | "quotes.manage"): Promise<{ change: ChangeRow; project: LockedProject }> {
  if (!isStaff(user)) throw new AppError("forbidden", "Agency access is required.");
  if (!UUID.test(changeId)) throw new AppError("not_found", "Change request not found.");
  const head = (await db.query<{ request_id: string }>("select request_id from project_change_orders where id = $1", [changeId])).rows[0];
  if (!head) throw new AppError("not_found", "Change request not found.");
  const project = await authorizeRequest(db, user, head.request_id, permission);
  const change = (await db.query<ChangeRow>(`select ${CHANGE_COLUMNS} from project_change_orders where id = $1 for update`, [changeId])).rows[0];
  if (!change) throw new AppError("not_found", "Change request not found.");
  return { change, project };
}

const move = (c: Pick<ChangeRow, "status">, to: ChangeOrderStatus) => {
  if (!canMoveChangeOrder(c.status, to)) throw new AppError("conflict", `A change that is ${c.status.replace("_", " ")} can't move to ${to.replace("_", " ")}.`);
};

/** Marks a received change as being looked at. */
export async function startChangeReview(user: SessionUser, changeId: string): Promise<void> {
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    if (change.status === "under_review") return;
    move(change, "under_review");
    await db.query("update project_change_orders set status = 'under_review' where id = $1", [change.id]);
    await finishChangeReviewTask(db, change.id, user.id);
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_review_started", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref } }, db);
  });
}

/**
 * Decides which kind of change this is: a revision the agreement includes, or something outside it. Changeable until a quote was sent. The team's note stays on the agency's
 * side. Classifying a received change also starts its review.
 */
export async function classifyChangeOrder(user: SessionUser, changeId: string, input: { classification: "in_scope_revision" | "out_of_scope"; internalNotes?: string | null }): Promise<void> {
  if (input.classification !== "in_scope_revision" && input.classification !== "out_of_scope") throw new AppError("invalid_input", "Choose whether this is a revision or outside what was agreed.");
  const notes = input.internalNotes === undefined ? undefined : (input.internalNotes ?? "").trim().slice(0, 4000) || null;
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    if (change.status !== "submitted" && change.status !== "under_review") throw new AppError("conflict", "Only a change that is received or being reviewed can be classified.");
    if (change.quote_version > 0) throw new AppError("conflict", "A quote was already sent for this change, so how it is classified can't change. Pull the quote back and decline it, or send a new quote.");
    if (change.status === "submitted") await db.query("update project_change_orders set status = 'under_review' where id = $1", [change.id]);
    await db.query("update project_change_orders set classification = $2, internal_notes = case when $3::boolean then $4 else internal_notes end where id = $1", [change.id, input.classification, notes !== undefined, notes ?? null]);
    await finishChangeReviewTask(db, change.id, user.id);
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_classified", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref, classification: input.classification } }, db);
  });
}

/**
 * Saves the team's notes on one change. `expected` is the notes as the person read them: when it is given and the notes have changed since (a colleague saved in between),
 * nothing is written and the person is told, so one person's edit never silently replaces another's. Left out, the notes are written as they are.
 */
export async function saveChangeInternalNotes(user: SessionUser, changeId: string, notes: string, expected?: string | null): Promise<void> {
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    if (expected !== undefined) {
      const current = (await db.query<{ internal_notes: string | null }>("select internal_notes from project_change_orders where id = $1", [change.id])).rows[0]?.internal_notes ?? "";
      if (current !== (expected ?? "")) throw new AppError("conflict", "Someone else changed these notes while you were editing. Nothing was saved. Their version is shown above your text.");
    }
    await db.query("update project_change_orders set internal_notes = $2 where id = $1", [change.id, notes.trim().slice(0, 4000) || null]);
    // The audit entry records that notes changed, never their contents.
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_notes_saved", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref } }, db);
  });
}

/** Asks the client a question about one change. The change waits in "needs more from you" until they answer. */
export async function requestChangeInfo(user: SessionUser, changeId: string, body: string): Promise<void> {
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Questions can be up to 5,000 characters.");
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    if (change.status === "submitted") {
      await db.query("update project_change_orders set status = 'under_review' where id = $1", [change.id]);
      change.status = "under_review";
    }
    move(change, "needs_info");
    const message = (await db.query<{ id: string }>(
      "insert into project_messages (request_id, org_id, author_id, author_kind, kind, body, internal, change_order_id) values ($1,$2,$3,'agency','info_request',$4,false,$5) returning id",
      [project.id, project.org_id, user.id, text, change.id],
    )).rows[0];
    await db.query("update project_change_orders set status = 'needs_info' where id = $1", [change.id]);
    await finishChangeReviewTask(db, change.id, user.id);
    // Asking the client a question is a reply to whatever they last wrote.
    await closeTasks(db, project.id, ["respond_to_client"], user.id);
    await db.query("update client_project_requests set last_activity_at = now(), assigned_to = coalesce(assigned_to, $2) where id = $1", [project.id, user.id]);
    await tellClient(db, project.org_id, { title: `${project.ref}: iAcquire has a question about change ${change.ref}`, link: `/projects/${project.id}`, dedupeKey: key(project.id, change.id, "needs_info", message.id) });
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_info_requested", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref } }, db);
  });
}

/** The team answers a change the agreement already covers: it is made as one of the included revisions, and the count of revisions used goes up by one. */
export async function applyInScopeRevision(user: SessionUser, changeId: string, note?: string): Promise<void> {
  const text = (note ?? "").trim().slice(0, 1000);
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    if (change.status !== "under_review") throw new AppError("conflict", "Only a change that is being reviewed can be marked as done.");
    if (change.classification !== "in_scope_revision") throw new AppError("conflict", "Classify this change as a revision first. A change outside what was agreed needs a quote.");
    const cp = (await db.query<{ revisions_included: number | null; revisions_used: number }>("select revisions_included, revisions_used from client_projects where request_id = $1 for update", [project.id])).rows[0];
    if (!cp) throw new AppError("conflict", "This project has no agreed quote.");
    // A revision beyond the number the agreement includes is not free: it needs a quote.
    if (!canUseRevision(cp.revisions_included, cp.revisions_used)) {
      throw new AppError("conflict", `All ${cp.revisions_included} included revisions are used. Classify this change as outside what was agreed and send a quote.`);
    }
    await db.query("update client_projects set revisions_used = revisions_used + 1 where request_id = $1", [project.id]);
    await db.query("update project_change_orders set status = 'applied', applied_by = $2, applied_at = now(), decided_at = now() where id = $1", [change.id, user.id]);
    await finishChangeReviewTask(db, change.id, user.id);
    const used = cp.revisions_used + 1;
    await addUpdate(db, project, user.id, "system", `Change ${change.ref} was made as one of the included revisions${cp.revisions_included !== null ? ` (${used} of ${cp.revisions_included} used)` : ""}.${text ? ` ${text}` : ""}`);
    await tellClient(db, project.org_id, { severity: "success", title: `${project.ref}: change ${change.ref} was made`, link: `/projects/${project.id}`, dedupeKey: key(project.id, change.id, "applied") });
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_applied", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref, kind: "revision", revisionsUsed: used, revisionsIncluded: cp.revisions_included } }, db);
  });
}

/**
 * Sends the client a quote for a change outside what was agreed. The price, the estimated extra weeks and the terms are the staff's own; the hash binds the client's answer to them.
 * One quote waits at a time on a project. Optionally names something a person must confirm first (a deposit, say); it binds only once the change is accepted.
 */
export async function sendChangeQuote(user: SessionUser, changeId: string, input: ChangeQuoteInput): Promise<{ version: number }> {
  return withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "quotes.manage");
    if (change.status !== "under_review") throw new AppError("conflict", "Only a change that is being reviewed can be quoted.");
    if (change.classification !== "out_of_scope") throw new AppError("conflict", "Classify this change as outside what was agreed before quoting it.");
    const live = projectTakesChangeOrder(project.status);
    if (!live.ok) throw new AppError("conflict", live.reason);
    const cp = (await db.query<{ currency: string }>("select currency from client_projects where request_id = $1", [project.id])).rows[0];
    if (!cp) throw new AppError("conflict", "This project has no agreed quote.");
    const other = await db.query("select 1 from project_change_orders where request_id = $1 and status = 'quoted' and id <> $2", [project.id, change.id]);
    if (other.rows[0]) throw new AppError("conflict", "Another change on this project has a quote waiting for the client's answer. Wait for the answer or pull that quote back first.");
    const checked = validateChangeQuote(input, await orgToday(db, project.org_id), cp.currency);
    if (!checked.ok) throw new AppError("invalid_input", checked.error);
    const q = checked.value;
    const version = change.quote_version + 1;
    const hash = changeQuoteHash(changeQuoteCanonical({
      changeId: change.id, version, title: change.title, description: change.description, additionalMinor: q.additionalMinor, currency: q.currency,
      weeksMin: q.weeksMin, weeksMax: q.weeksMax, termsText: q.termsText, validUntil: q.validUntil,
    }));
    // One statement writes the status, the version and every term, as the database requires.
    await db.query(
      `update project_change_orders set status = 'quoted', quote_version = $2, quoted_by = $3, quoted_at = now(), additional_cents = $4, currency = $5, additional_weeks_min = $6,
         additional_weeks_max = $7, terms_text = $8, valid_until = $9, content_hash = $10 where id = $1`,
      [change.id, version, user.id, q.additionalMinor, q.currency, q.weeksMin, q.weeksMax, q.termsText, q.validUntil, hash],
    );
    await finishChangeReviewTask(db, change.id, user.id);
    // A person confirms this before the change counts as agreed work. It is kept pending (and hidden from the client) until the change is accepted, and removed if it is not.
    await db.query("delete from project_prerequisites where change_order_id = $1 and status = 'pending'", [change.id]);
    if (q.prerequisiteLabel) {
      await db.query(
        "insert into project_prerequisites (request_id, org_id, kind, label, required, blocks, change_order_id, created_by) values ($1,$2,'change',$3,true,'handover',$4,$5)",
        [project.id, project.org_id, q.prerequisiteLabel, change.id, user.id],
      );
    }
    await db.query("update client_project_requests set last_activity_at = now(), assigned_to = coalesce(assigned_to, $2) where id = $1", [project.id, user.id]);
    await addUpdate(db, project, user.id, "system", `A quote for change ${change.ref} is ready for your decision (${describeQuote({ additionalCents: q.additionalMinor, currency: q.currency, weeksMin: q.weeksMin, weeksMax: q.weeksMax })}).`);
    await tellClient(db, project.org_id, { severity: "warning", title: `${project.ref}: a quote for change ${change.ref} is ready`, link: `/projects/${project.id}`, dedupeKey: key(project.id, change.id, "quote", version, "sent") });
    await recordAudit({
      orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_quote_sent", targetType: "project_change_order", targetId: change.id, result: "success",
      metadata: { ref: change.ref, version, additionalCents: q.additionalMinor, currency: q.currency, hash: hash.slice(0, 12) },
    }, db);
    return { version };
  });
}

/** Takes a waiting quote back for revision. The client's change goes back to review and a new quote (a new version) can be sent. */
export async function pullBackChangeQuote(user: SessionUser, changeId: string): Promise<void> {
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "quotes.manage");
    if (change.status !== "quoted") throw new AppError("conflict", "There is no quote waiting for this change.");
    await db.query("update project_change_orders set status = 'under_review' where id = $1", [change.id]);
    await addUpdate(db, project, user.id, "system", `The quote for change ${change.ref} was taken back to be revised. A new one will follow.`);
    await tellClient(db, project.org_id, { title: `${project.ref}: the quote for change ${change.ref} was taken back`, link: `/projects/${project.id}`, dedupeKey: key(project.id, change.id, "pulled", change.quote_version) });
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_quote_pulled_back", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref, version: change.quote_version } }, db);
  });
}

/** The team will not make a change. The reason is shown to the client. A change with a quote waiting is pulled back first. */
export async function declineChangeOrder(user: SessionUser, changeId: string, reason: string): Promise<void> {
  const text = reason.trim();
  if (text.length < 3 || text.length > 500) throw new AppError("invalid_input", "Tell the client why in a sentence (3 to 500 characters).");
  const problem = freeTextProblem("The reason", text);
  if (problem) throw new AppError("invalid_input", problem);
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    if (change.status === "quoted") throw new AppError("conflict", "A quote is waiting for the client's answer. Take it back first, then decline.");
    move(change, "declined");
    await db.query("update project_change_orders set status = 'declined', decided_at = now() where id = $1", [change.id]);
    await db.query("delete from project_prerequisites where change_order_id = $1 and status = 'pending'", [change.id]);
    await finishChangeReviewTask(db, change.id, user.id);
    await addUpdate(db, project, user.id, "system", `Change ${change.ref} will not be made: ${text}`);
    await tellClient(db, project.org_id, { title: `${project.ref}: change ${change.ref} will not be made`, link: `/projects/${project.id}`, dedupeKey: key(project.id, change.id, "declined") });
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_declined", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref } }, db);
  });
}

/** The work for an accepted change is done. */
export async function markChangeApplied(user: SessionUser, changeId: string, note?: string): Promise<void> {
  const text = (note ?? "").trim().slice(0, 1000);
  await withSystem(async (db) => {
    const { change, project } = await lockAgencyChange(db, user, changeId, "projects.manage");
    // Only a change the client accepted is made this way; one that is being reviewed is a revision, which has its own count.
    if (change.status !== "accepted") throw new AppError("conflict", "Only a change the client accepted can be marked as made.");
    await db.query("update project_change_orders set status = 'applied', applied_by = $2, applied_at = now() where id = $1", [change.id, user.id]);
    await finishChangeReviewTask(db, change.id, user.id);
    await addUpdate(db, project, user.id, "system", `Change ${change.ref} was made.${text ? ` ${text}` : ""}`);
    await tellClient(db, project.org_id, { severity: "success", title: `${project.ref}: change ${change.ref} was made`, link: `/projects/${project.id}`, dedupeKey: key(project.id, change.id, "applied") });
    await recordAudit({ orgId: project.org_id, actorUserId: user.id, actorKind: "agency", action: "project.change_applied", targetType: "project_change_order", targetId: change.id, result: "success", metadata: { ref: change.ref, kind: "accepted_change" } }, db);
  });
}

/**
 * Cancelling a project closes the changes still open on it (a waiting quote included), so the client is not left with a quote nobody can act on. They stay on the list as
 * withdrawn, and the confirmations they were waiting for are removed. Returns how many were closed. The caller holds the project's lock.
 */
export async function withdrawOpenChangeOrders(db: Queryable, project: { id: string; org_id: string; ref: string }, userId: string): Promise<number> {
  const closed = await db.query<{ id: string }>(
    "update project_change_orders set status = 'withdrawn', decided_at = now() where request_id = $1 and status in ('submitted','under_review','needs_info','quoted') returning id", [project.id],
  );
  if (!closed.rows.length) return 0;
  await db.query("delete from project_prerequisites where change_order_id = any($1::uuid[]) and status = 'pending'", [closed.rows.map((r) => r.id)]);
  await db.query("update project_review_tasks set status = 'done', completed_at = now(), completed_by = $2 where change_order_id = any($1::uuid[]) and status = 'open'", [closed.rows.map((r) => r.id), userId]);
  await recordAudit({ orgId: project.org_id, actorUserId: userId, actorKind: "agency", action: "project.changes_closed_with_project", targetType: "project_request", targetId: project.id, result: "success", metadata: { ref: project.ref, closed: closed.rows.length } }, db);
  return closed.rows.length;
}
