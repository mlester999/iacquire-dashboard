import "server-only";
import crypto from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { notifyAgency, notifyOrgRoles, sendAgencySlackAlert } from "@/server/notifications";
import { uploadPrivateFile, signPrivateFile, removePrivateFile } from "@/server/storage/private";
import type { OrgContext } from "@/server/tenancy/context";
import { firstName } from "@/lib/utils";
import { BUDGET_BANDS, QUOTE_ACKNOWLEDGEMENT, suggestServices, type ProjectStatus, type ServiceView } from "@/lib/projects";
import { todayIn } from "@/lib/invoices/state";
import {
  REQUEST_COLUMNS, iso, quoteContentHash, toQuoteView, toRequestView,
  type DeliveryView, type FileView, type MessageView, type MilestoneView, type PrerequisiteView, type ProjectDetail, type QuoteRow, type RequestRow, type RequestView, type UpdateView,
} from "@/server/projects/shared";
import { loadSupportSettings } from "@/server/support/settings";
import { loadChangeOrders } from "@/server/projects/change-orders";
import { seedDefaultPrerequisites } from "@/server/projects/prerequisites";

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface ProjectListItem extends RequestView {
  agreedPriceCents: number | null;
  currency: string | null;
  milestonesDone: number;
  milestonesTotal: number;
  quoteWaiting: boolean;
  approvalsWaiting: number;
  infoRequested: boolean;
}

export async function listProjects(ctx: OrgContext): Promise<ProjectListItem[]> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<RequestRow & { agreed_price_cents: number | null; currency: string | null; ms_done: number; ms_total: number; quote_waiting: boolean; approvals_waiting: number; info_requested: boolean }>(
      `select ${REQUEST_COLUMNS},
         cp.agreed_price_cents, cp.currency,
         (select count(*)::int from project_milestones m where m.request_id = r.id and m.status = 'completed') as ms_done,
         (select count(*)::int from project_milestones m where m.request_id = r.id) as ms_total,
         exists (select 1 from project_quotes q where q.request_id = r.id and q.status = 'sent') as quote_waiting,
         (select count(*)::int from project_milestones m where m.request_id = r.id and m.status = 'awaiting_approval') as approvals_waiting,
         (r.status = 'discovery_needed') as info_requested
       from client_project_requests r
       left join service_catalog s on s.id = r.service_id
       left join client_projects cp on cp.request_id = r.id
       where r.org_id = $1 order by r.last_activity_at desc limit 200`,
      [ctx.org.orgId],
    );
    return rows.map((r) => ({
      ...toRequestView(r),
      agreedPriceCents: r.agreed_price_cents,
      currency: r.currency,
      milestonesDone: r.ms_done,
      milestonesTotal: r.ms_total,
      quoteWaiting: r.quote_waiting,
      approvalsWaiting: r.approvals_waiting,
      infoRequested: r.info_requested,
    }));
  });
}

/** The team shows to a client by first name only, as in Support; a colleague on the client's side shows by name, and the team sees everyone in full. */
function shownName(name: string | null, platformRole: string | null, teamView: boolean): string | null {
  if (teamView || !platformRole || platformRole === "none") return name;
  return firstName(name) || "iAcquire team";
}

/**
 * Loads one project with everything the viewer is allowed to see. `internal` is true only for trusted agency
 * code; client calls run under row-level security and never receive internal notes, drafts or staff names.
 */
export async function loadProjectDetail(db: Queryable, requestId: string, opts: { internal: boolean; orgId?: string; timeZone?: string }): Promise<ProjectDetail | null> {
  const { rows } = await db.query<RequestRow>(
    `select ${REQUEST_COLUMNS} from client_project_requests r left join service_catalog s on s.id = r.service_id where r.id = $1 and ($2::uuid is null or r.org_id = $2)`,
    [requestId, opts.orgId ?? null],
  );
  if (!rows[0]) return null;
  const internal = opts.internal;
  const requirements = await db.query<{ key: string; label: string; answer: string }>("select key, label, answer from project_requirements where request_id = $1 order by sort_order", [requestId]);
  const quotes = await db.query<QuoteRow>(
    `select q.id, q.version, q.status, q.project_name, q.scope, q.deliverables, q.included_integrations, q.exclusions, q.timeline_text,
            q.estimated_weeks_min, q.estimated_weeks_max, q.one_time_cents, q.ongoing_monthly_cents, q.ongoing_description, q.revision_terms,
            q.payment_terms, q.warranty_terms, q.currency, q.valid_until::text as valid_until, q.content_hash, q.sent_at, q.first_viewed_at, q.created_at,
            a.decision, a.note as decision_note, a.decided_at, du.full_name as decided_by_name
     from project_quotes q left join quote_approvals a on a.quote_id = q.id left join users du on du.id = a.decided_by
     where q.request_id = $1 and ($2::boolean or q.status <> 'draft') order by q.version desc`,
    [requestId, internal],
  );
  const delivery = (await db.query<{
    agreed_price_cents: number; ongoing_monthly_cents: number | null; currency: string; scope: string; deliverables: string[]; timeline_text: string; agreed_at: Date; started_at: Date | null;
    expected_completion_on: string | null; completed_at: Date | null; handover_notes: string | null; warranty_days: number | null; warranty_ends_on: string | null; revisions_included: number | null;
    revisions_used: number;
  }>(
    `select agreed_price_cents, ongoing_monthly_cents, currency, scope, deliverables, timeline_text, agreed_at, started_at, expected_completion_on::text as expected_completion_on, completed_at, handover_notes,
            warranty_days, warranty_ends_on::text as warranty_ends_on, revisions_included, revisions_used
     from client_projects where request_id = $1`,
    [requestId],
  )).rows[0];
  const milestones = await db.query<{ id: string; title: string; description: string | null; sort_order: number; status: MilestoneView["status"]; due_on: string | null; requires_client_approval: boolean; client_approved_at: Date | null; client_note: string | null; completed_at: Date | null }>(
    "select id, title, description, sort_order, status, due_on::text as due_on, requires_client_approval, client_approved_at, client_note, completed_at from project_milestones where request_id = $1 order by sort_order, created_at",
    [requestId],
  );
  const updates = await db.query<{ id: string; kind: string; body: string; visibility: "client" | "internal"; author_name: string | null; author_role: string | null; created_at: Date }>(
    `select u.id, u.kind, u.body, u.visibility, au.full_name as author_name, au.platform_role as author_role, u.created_at from project_updates u left join users au on au.id = u.author_id
     where u.request_id = $1 and ($2::boolean or u.visibility = 'client') order by u.created_at desc`,
    [requestId, internal],
  );
  const files = await db.query<{ id: string; filename: string; mime_type: string; size_bytes: number; kind: string; visibility: "client" | "internal"; description: string | null; uploaded_by_kind: "client" | "agency"; created_at: Date }>(
    `select f.id, pf.filename, pf.mime_type, pf.size_bytes, f.kind, f.visibility, f.description, f.uploaded_by_kind, f.created_at
     from project_files f join private_files pf on pf.id = f.private_file_id
     where f.request_id = $1 and pf.status = 'ready' and ($2::boolean or f.visibility = 'client') order by f.created_at desc`,
    [requestId, internal],
  );
  const messages = await db.query<{ id: string; author_kind: "client" | "agency" | "system"; author_name: string | null; author_role: string | null; kind: MessageView["kind"]; body: string; internal: boolean; created_at: Date; change_order_id: string | null }>(
    `select m.id, m.author_kind, au.full_name as author_name, au.platform_role as author_role, m.kind, m.body, m.internal, m.created_at, m.change_order_id from project_messages m left join users au on au.id = m.author_id
     where m.request_id = $1 and ($2::boolean or not m.internal) order by m.created_at asc`,
    [requestId, internal],
  );
  const tickets = await db.query<{ id: string; ref: string; subject: string; status: string }>(
    "select id, ref, subject, status from support_tickets where project_id = $1 order by created_at desc",
    [requestId],
  );
  const today = todayIn(new Date(), opts.timeZone ?? "UTC");
  const { changes, amendments } = await loadChangeOrders(db, requestId, { internal, today });
  // What is asked before work starts. A client sees what is asked and whether it is done, never the team's evidence or who confirmed it; a change's confirmation shows once that change was accepted.
  const prereq = await db.query<{
    id: string; kind: PrerequisiteView["kind"]; label: string; required: boolean; blocks: PrerequisiteView["blocks"]; status: PrerequisiteView["status"]; satisfied_at: Date | null; waived_at: Date | null;
    change_order_id: string | null; change_status: string | null; evidence_note?: string | null; waived_reason?: string | null; recorded_by_name?: string | null;
  }>(
    `select p.id, p.kind, p.label, p.required, p.blocks, p.status, p.satisfied_at, p.waived_at, p.change_order_id, c.status as change_status${internal ? ", p.evidence_note, p.waived_reason, coalesce(su.full_name, wu.full_name) as recorded_by_name" : ""}
     from project_prerequisites p left join project_change_orders c on c.id = p.change_order_id${internal ? " left join users su on su.id = p.satisfied_by left join users wu on wu.id = p.waived_by" : ""}
     where p.request_id = $1 order by p.created_at, p.kind, p.id`,
    [requestId],
  );
  return {
    request: toRequestView(rows[0]),
    requirements: requirements.rows,
    quotes: quotes.rows.map(toQuoteView),
    delivery: delivery
      ? ({
          agreedPriceCents: delivery.agreed_price_cents,
          ongoingMonthlyCents: delivery.ongoing_monthly_cents,
          currency: delivery.currency,
          scope: delivery.scope,
          deliverables: delivery.deliverables,
          timelineText: delivery.timeline_text,
          agreedAt: iso(delivery.agreed_at)!,
          startedAt: iso(delivery.started_at),
          expectedCompletionOn: delivery.expected_completion_on,
          completedAt: iso(delivery.completed_at),
          handoverNotes: delivery.handover_notes,
          warrantyDays: delivery.warranty_days,
          warrantyEndsOn: delivery.warranty_ends_on,
          revisionsIncluded: delivery.revisions_included,
          revisionsUsed: delivery.revisions_used,
        } satisfies DeliveryView)
      : null,
    milestones: milestones.rows.map((m) => ({ id: m.id, title: m.title, description: m.description, sortOrder: m.sort_order, status: m.status, dueOn: m.due_on, requiresClientApproval: m.requires_client_approval, clientApprovedAt: iso(m.client_approved_at), clientNote: m.client_note, completedAt: iso(m.completed_at) }) satisfies MilestoneView),
    updates: updates.rows.map((u) => ({ id: u.id, kind: u.kind, body: u.body, visibility: u.visibility, authorName: shownName(u.author_name, u.author_role, internal), createdAt: iso(u.created_at)! }) satisfies UpdateView),
    files: files.rows.map((f) => ({ id: f.id, filename: f.filename, mimeType: f.mime_type, sizeBytes: f.size_bytes, kind: f.kind, visibility: f.visibility, description: f.description, uploadedByKind: f.uploaded_by_kind, createdAt: iso(f.created_at)! }) satisfies FileView),
    messages: messages.rows.map((m) => ({ id: m.id, authorKind: m.author_kind, authorName: shownName(m.author_name, m.author_role, internal), kind: m.kind, body: m.body, internal: m.internal, createdAt: iso(m.created_at)!, changeOrderId: m.change_order_id }) satisfies MessageView),
    tickets: tickets.rows,
    changes,
    amendments,
    prerequisites: prereq.rows
      .filter((p) => internal || p.kind !== "change" || p.change_status === "accepted" || p.change_status === "applied")
      .map((p) => ({
        id: p.id, kind: p.kind, label: p.label, required: p.required, blocks: p.blocks, status: p.status, satisfiedAt: iso(p.satisfied_at), waivedAt: iso(p.waived_at),
        changeOrderId: p.change_order_id, changeStatus: p.change_status,
        ...(internal ? { evidenceNote: p.evidence_note ?? null, waivedReason: p.waived_reason ?? null, recordedByName: p.recorded_by_name ?? null } : {}),
      }) satisfies PrerequisiteView),
  };
}

export async function getProject(ctx: OrgContext, requestId: string): Promise<ProjectDetail | null> {
  if (!z.string().uuid().safeParse(requestId).success) return null;
  return withUser(ctx.user.id, (db) => loadProjectDetail(db, requestId, { internal: false, orgId: ctx.org.orgId, timeZone: ctx.org.timezone }));
}

// ---------------------------------------------------------------------------
// Submitting a request
// ---------------------------------------------------------------------------

export const projectRequestSchema = z.object({
  title: z.string().trim().min(3, "Tell us what you'd like us to build.").max(160),
  problem: z.string().trim().min(10, "Describe the business problem in a sentence or two.").max(2000),
  currentProcess: z.string().trim().min(10, "Describe how this works today.").max(2000),
  desiredOutcome: z.string().trim().min(10, "Describe what the new system should do.").max(2000),
  tools: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
  preferredDeadline: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid date.").nullable().optional(),
  budgetRange: z.enum(BUDGET_BANDS).nullable().optional(),
  serviceSlug: z.string().max(80).nullable().optional(),
  /** The form's retry key: sending the same form twice (a double click, a dropped connection) makes one request. */
  idempotencyKey: z.string().min(8).max(80).optional(),
});
export type ProjectRequestInput = z.input<typeof projectRequestSchema>;

async function suggestionsFor(db: Queryable, text: string, tools: string[]): Promise<string[]> {
  const { rows } = await db.query<{ id: string; slug: string; name: string; kind: ServiceView["kind"]; keywords: string[]; platforms: string[]; availability: ServiceView["availability"]; visible: boolean }>(
    "select id, slug, name, kind, keywords, platforms, availability, visible from service_catalog where visible and kind <> 'maintenance_plan'",
  );
  const services = rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, kind: r.kind, keywords: r.keywords, platforms: r.platforms, availability: r.availability, visible: r.visible }) as unknown as ServiceView);
  return suggestServices(text, tools, services).map((s) => s.service.id);
}

/** Saves the request, files it under the authenticated tenant, and creates the agency's review task. Never charges. */
export async function createProjectRequest(ctx: OrgContext, input: ProjectRequestInput): Promise<{ id: string; ref: string; existing?: boolean }> {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't request projects. Ask a workspace owner or admin.");
  const d = projectRequestSchema.parse(input);
  if (d.preferredDeadline && d.preferredDeadline < new Date().toISOString().slice(0, 10)) throw new AppError("invalid_input", "Choose a deadline that is today or later.");
  // A retry of the same submission returns the request that already exists, before it counts against the rate limit or announces anything again.
  if (d.idempotencyKey) {
    const found = (await withSystem((db) => db.query<{ id: string; ref: string }>("select id, ref from client_project_requests where org_id = $1 and created_by = $2 and idempotency_key = $3", [ctx.org.orgId, ctx.user.id, d.idempotencyKey]))).rows[0];
    if (found) return { ...found, existing: true };
  }
  const limit = await consumeRateLimit(RATE_LIMITS.projectRequestByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You've sent several project requests recently. Please add details to an existing one.", { retryAfterSeconds: limit.retryAfterSeconds });

  const created = await withSystem(async (db) => {
    let serviceId: string | null = null;
    let serviceName: string | null = null;
    if (d.serviceSlug) {
      const s = (await db.query<{ id: string; name: string; availability: string }>("select id, name, availability from service_catalog where slug = $1 and visible and kind <> 'maintenance_plan'", [d.serviceSlug])).rows[0];
      if (!s) throw new AppError("not_found", "That service isn't available to request.");
      if (s.availability !== "available") throw new AppError("conflict", `${s.name} isn't open for requests right now. You can still describe a custom project.`);
      serviceId = s.id;
      serviceName = s.name;
    }
    const suggestions = await suggestionsFor(db, `${d.title} ${d.problem} ${d.desiredOutcome} ${d.currentProcess}`, d.tools);
    const { rows } = await db.query<{ id: string; ref: string }>(
      `insert into client_project_requests (org_id, created_by, service_id, title, summary, tools_used, preferred_deadline, budget_range, suggested_service_ids, idempotency_key)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       on conflict (org_id, created_by, idempotency_key) where idempotency_key is not null do nothing returning id, ref`,
      [ctx.org.orgId, ctx.user.id, serviceId, d.title, d.problem, d.tools, d.preferredDeadline ?? null, d.budgetRange ?? null, suggestions, d.idempotencyKey ?? null],
    );
    const r = rows[0];
    if (!r) {
      // Two identical submissions arrived together; the other one won, and it announced the request.
      const won = (await db.query<{ id: string; ref: string }>("select id, ref from client_project_requests where org_id = $1 and created_by = $2 and idempotency_key = $3", [ctx.org.orgId, ctx.user.id, d.idempotencyKey ?? null])).rows[0];
      return { ...won, serviceName, existing: true };
    }
    const answers: Array<[string, string, string]> = [
      ["build", "What would you like us to build?", d.title],
      ["problem", "What business problem are you trying to solve?", d.problem],
      ["current_process", "How does your current process work?", d.currentProcess],
      ["desired_outcome", "What would you like the new system to do?", d.desiredOutcome],
      ["tools", "Which tools do you currently use?", d.tools.join(", ")],
      ["deadline", "Do you have a preferred deadline?", d.preferredDeadline ?? ""],
      ["budget", "Do you have a budget range?", d.budgetRange ?? ""],
    ];
    for (const [i, [key, label, answer]] of answers.entries()) {
      await db.query("insert into project_requirements (request_id, org_id, key, label, answer, sort_order) values ($1,$2,$3,$4,$5,$6)", [r.id, ctx.org.orgId, key, label, answer, i]);
    }
    // Two days unless the Super Admin set a review target: the team is told when this passes (projectReviewOverdue), and a client hears of it only if that was chosen.
    const reviewHours = (await loadSupportSettings(db)).projectReviewTargetHours ?? 48;
    await db.query("insert into project_review_tasks (request_id, org_id, kind, title, due_at) values ($1,$2,'initial_review',$3, now() + make_interval(hours => $4::int))", [r.id, ctx.org.orgId, `Review ${r.ref}: ${d.title}`.slice(0, 200), reviewHours]);
    await db.query("insert into project_updates (request_id, org_id, author_id, kind, body) values ($1,$2,$3,'system','Request submitted. The iAcquire team will review it and reply here.')", [r.id, ctx.org.orgId, ctx.user.id]);
    await notifyAgency(db, ctx.org.orgId, { kind: "project_submitted", title: `${r.ref}: ${d.title}`, body: `${ctx.org.name} · ${serviceName ?? "Custom project"}`, link: `/admin/projects/${r.id}`, dedupeKey: `project:${r.id}:submitted` }, { permission: "projects.view" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "project.request_submitted", targetType: "project_request", targetId: r.id, result: "success", metadata: { ref: r.ref, service: d.serviceSlug ?? null } }, db);
    return { ...r, serviceName, existing: false };
  });
  if (created.existing) return { id: created.id, ref: created.ref, existing: true };
  // External alerts carry no request content: only the reference and the workspace name.
  await sendAgencySlackAlert(`New iAcquire project request ${created.ref} from ${ctx.org.name}.`);
  return { id: created.id, ref: created.ref };
}

// ---------------------------------------------------------------------------
// Conversation and files
// ---------------------------------------------------------------------------

async function ownRequest(db: Queryable, ctx: OrgContext, requestId: string) {
  const r = (await db.query<{ id: string; ref: string; title: string; status: ProjectStatus }>("select id, ref, title, status from client_project_requests where id = $1 and org_id = $2", [requestId, ctx.org.orgId])).rows[0];
  if (!r) throw new AppError("not_found", "Project not found.");
  return r;
}

/** `clientMessageId` is the form's retry id: the same message sent twice (a double click, a dropped connection) is saved and announced once. */
export async function postClientMessage(ctx: OrgContext, requestId: string, body: string, clientMessageId?: string): Promise<{ id: string; existing: boolean }> {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't message about projects.");
  const text = body.trim();
  if (!text || text.length > 5000) throw new AppError("invalid_input", "Messages can be up to 5,000 characters.");
  if (clientMessageId !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(clientMessageId)) throw new AppError("invalid_input", "That message could not be read. Please try again.");
  if (clientMessageId) {
    const dup = (await withSystem((db) => db.query<{ id: string }>("select id from project_messages where request_id = $1 and org_id = $2 and client_message_id = $3", [requestId, ctx.org.orgId, clientMessageId]))).rows[0];
    if (dup) return { id: dup.id, existing: true };
  }
  const limit = await consumeRateLimit(RATE_LIMITS.projectActivityByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You're sending messages quickly. Give it a moment.");
  return withSystem(async (db) => {
    const r = await ownRequest(db, ctx, requestId);
    if (r.status === "cancelled" || r.status === "completed") throw new AppError("conflict", "This project is closed. Start a new request or open a support request.");
    const answering = r.status === "discovery_needed";
    const inserted = await db.query<{ id: string }>(
      `insert into project_messages (request_id, org_id, author_id, author_kind, kind, body, client_message_id) values ($1,$2,$3,'client',$4,$5,$6)
       on conflict (request_id, client_message_id) where client_message_id is not null do nothing returning id`,
      [requestId, ctx.org.orgId, ctx.user.id, answering ? "info_response" : "message", text, clientMessageId ?? null],
    );
    if (!inserted.rows[0]) {
      // Two identical sends arrived together; the other one won and announced it.
      const won = (await db.query<{ id: string }>("select id from project_messages where request_id = $1 and client_message_id = $2", [requestId, clientMessageId ?? null])).rows[0];
      return { id: won.id, existing: true };
    }
    const message = inserted.rows[0];
    // Answering a question moves the project back to the agency's review queue.
    await db.query("update client_project_requests set last_activity_at = now(), status = case when status = 'discovery_needed' then 'under_review' else status end where id = $1", [requestId]);
    await db.query("insert into project_review_tasks (request_id, org_id, kind, title, due_at) values ($1,$2,'respond_to_client',$3, now() + interval '1 day')", [requestId, ctx.org.orgId, `Reply to ${ctx.org.name} on ${r.ref}`.slice(0, 200)]);
    await notifyAgency(db, ctx.org.orgId, { kind: "project_message", title: `${r.ref}: ${answering ? "information provided" : "new message"} from ${ctx.org.name}`, link: `/admin/projects/${requestId}`, dedupeKey: `project:${requestId}:message:${message.id}` }, { permission: "projects.view" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "project.client_message", targetType: "project_request", targetId: requestId, result: "success", metadata: { answeringQuestion: answering } }, db);
    return { id: message.id, existing: false };
  });
}

const FILE_MIMES: Record<string, string> = { pdf: "application/pdf", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", txt: "text/plain", md: "text/markdown", csv: "text/csv" };

export function projectFileType(name: string): { filename: string; mime: string } {
  const filename = path.basename(name).replace(/[^\w.\- ()]+/g, "_").slice(0, 200) || "file";
  const mime = FILE_MIMES[filename.split(".").at(-1)?.toLowerCase() ?? ""];
  if (!mime) throw new AppError("invalid_input", "Choose a PDF, Word, image, text, Markdown or CSV file.");
  return { filename, mime };
}

/** Stores a file privately against a project. Used by clients (requirement/reference files) and agency staff (deliverables). */
export async function storeProjectFile(input: {
  userId: string;
  orgId: string;
  requestId: string;
  file: { name: string; bytes: Buffer };
  by: "client" | "agency";
  kind: "requirement" | "reference" | "deliverable" | "handover";
  visibility?: "client" | "internal";
  description?: string | null;
}) {
  const { filename, mime } = projectFileType(input.file.name);
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser, input.userId);
  if (!limit.allowed) throw new AppError("rate_limited", "Upload limit reached. Try again later.");
  const visibility = input.visibility ?? "client";
  const stored = await uploadPrivateFile({ userId: input.userId, orgId: input.orgId, bucket: "project-uploads", path: `${input.orgId}/${crypto.randomUUID()}/${filename}`, bytes: input.file.bytes, contentType: mime, filename, visibility });
  try {
    return await withSystem(async (db) => {
      const r = await db.query<{ id: string }>(
        "insert into project_files (request_id, org_id, private_file_id, kind, visibility, description, uploaded_by, uploaded_by_kind) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id",
        [input.requestId, input.orgId, stored.id, input.kind, visibility, input.description?.slice(0, 300) ?? null, input.userId, input.by],
      );
      await db.query("update client_project_requests set last_activity_at = now() where id = $1", [input.requestId]);
      await recordAudit({ orgId: input.orgId, actorUserId: input.userId, actorKind: input.by === "agency" ? "agency" : "user", action: "project.file_added", targetType: "project_request", targetId: input.requestId, result: "success", metadata: { kind: input.kind, visibility, size: input.file.bytes.length } }, db);
      return { id: r.rows[0].id, filename };
    });
  } catch (error) {
    await removePrivateFile({ userId: input.userId, orgId: input.orgId, bucket: stored.bucket, path: stored.storageKey }).catch(() => undefined);
    throw error;
  }
}

export async function attachClientFile(ctx: OrgContext, requestId: string, file: { name: string; bytes: Buffer }, description?: string | null) {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't add project files.");
  await withSystem((db) => ownRequest(db, ctx, requestId));
  return storeProjectFile({ userId: ctx.user.id, orgId: ctx.org.orgId, requestId, file, by: "client", kind: "requirement", visibility: "client", description });
}

/** Downloads are re-authorized by row-level security on every request. */
export async function projectFileDownload(userId: string, fileId: string): Promise<string> {
  if (!z.string().uuid().safeParse(fileId).success) throw new AppError("not_found", "File not found.");
  const f = await withUser(userId, async (db) => (await db.query<{ org_id: string; storage_key: string }>(
    "select f.org_id, pf.storage_key from project_files f join private_files pf on pf.id = f.private_file_id where f.id = $1 and pf.status = 'ready'", [fileId],
  )).rows[0]);
  if (!f) throw new AppError("not_found", "File not found.");
  return signPrivateFile({ userId, orgId: f.org_id, bucket: "project-uploads", path: f.storage_key });
}

// ---------------------------------------------------------------------------
// Milestones and quotes
// ---------------------------------------------------------------------------

export async function respondToMilestone(ctx: OrgContext, milestoneId: string, decision: "approve" | "request_changes", note?: string) {
  if (!ctx.can("projects.request")) throw new AppError("forbidden", "Your role can't approve project deliverables.");
  const clean = (note ?? "").trim().slice(0, 1000);
  if (decision === "request_changes" && clean.length < 3) throw new AppError("invalid_input", "Tell us what needs to change.");
  const limit = await consumeRateLimit(RATE_LIMITS.projectActivityByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Slow down for a moment and try again.");
  await withSystem(async (db) => {
    const m = (await db.query<{ id: string; request_id: string; title: string; status: string; ref: string }>(
      `select m.id, m.request_id, m.title, m.status, r.ref from project_milestones m join client_project_requests r on r.id = m.request_id
       where m.id = $1 and m.org_id = $2 for update of m`,
      [milestoneId, ctx.org.orgId],
    )).rows[0];
    if (!m) throw new AppError("not_found", "Milestone not found.");
    if (m.status !== "awaiting_approval") throw new AppError("conflict", "This milestone isn't waiting for your approval.");
    if (decision === "approve") {
      await db.query("update project_milestones set status='completed', completed_at=now(), client_approved_by=$2, client_approved_at=now(), client_note=$3 where id=$1", [milestoneId, ctx.user.id, clean || null]);
    } else {
      await db.query("update project_milestones set status='in_progress', client_note=$2 where id=$1", [milestoneId, clean]);
    }
    const update = (await db.query<{ id: string }>("insert into project_updates (request_id, org_id, author_id, kind, body) values ($1,$2,$3,'milestone',$4) returning id", [m.request_id, ctx.org.orgId, ctx.user.id, decision === "approve" ? `Approved: ${m.title}` : `Changes requested on: ${m.title}`])).rows[0];
    await db.query("update client_project_requests set last_activity_at = now() where id = $1", [m.request_id]);
    await notifyAgency(db, ctx.org.orgId, { kind: "project_decision", severity: decision === "approve" ? "success" : "warning", title: `${m.ref}: ${decision === "approve" ? "deliverable approved" : "changes requested"} by ${ctx.org.name}`, body: m.title, link: `/admin/projects/${m.request_id}`, dedupeKey: `project:${m.request_id}:update:${update.id}` }, { permission: "projects.view" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: decision === "approve" ? "project.milestone_approved" : "project.milestone_changes_requested", targetType: "project_milestone", targetId: milestoneId, result: "success" }, db);
  });
}

/** Opening the quote moves "Quote Sent" to "Awaiting Approval". Idempotent. */
export async function markQuoteViewed(ctx: OrgContext, quoteId: string) {
  await withSystem(async (db) => {
    const q = (await db.query<{ request_id: string; first_viewed_at: Date | null; status: string }>(
      "select request_id, first_viewed_at, status from project_quotes where id = $1 and org_id = $2 and status = 'sent'", [quoteId, ctx.org.orgId],
    )).rows[0];
    if (!q || q.first_viewed_at) return;
    await db.query("update project_quotes set first_viewed_at = now() where id = $1", [quoteId]);
    await db.query("update client_project_requests set status = 'awaiting_approval', last_activity_at = now() where id = $1 and status = 'quote_sent'", [q.request_id]);
  });
}

export type QuoteDecision = "accepted" | "changes_requested" | "declined";

/**
 * Records the client's decision against the exact terms that were sent (checked by content hash).
 * Accepting creates the project record and moves it to Approved. Nothing is charged and no payment is started.
 */
export async function decideQuote(ctx: OrgContext, quoteId: string, decision: QuoteDecision, note?: string, ipHash: string | null = null) {
  if (decision === "changes_requested" ? !ctx.can("projects.request") : !ctx.can("projects.approve_quote")) {
    throw new AppError("forbidden", decision === "changes_requested" ? "Your role can't respond to quotes." : "Only a workspace owner can accept or decline a quote.");
  }
  const clean = (note ?? "").trim().slice(0, 2000);
  if (decision === "changes_requested" && clean.length < 3) throw new AppError("invalid_input", "Tell us what you'd like changed.");
  const limit = await consumeRateLimit(RATE_LIMITS.quoteDecisionByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Too many quote actions. Please wait a little and try again.");
  return withSystem(async (db) => {
    const q = (await db.query<QuoteRow & { request_id: string; ref: string; title: string; request_status: string }>(
      `select q.id, q.request_id, q.version, q.status, q.project_name, q.scope, q.deliverables, q.included_integrations, q.exclusions, q.timeline_text,
              q.estimated_weeks_min, q.estimated_weeks_max, q.one_time_cents, q.ongoing_monthly_cents, q.ongoing_description, q.revision_terms, q.payment_terms,
              q.warranty_terms, q.currency, q.valid_until::text as valid_until, q.content_hash, q.sent_at, q.first_viewed_at, q.created_at, r.ref, r.title, r.status as request_status
       from project_quotes q join client_project_requests r on r.id = q.request_id where q.id = $1 and q.org_id = $2 for update of q`,
      [quoteId, ctx.org.orgId],
    )).rows[0];
    if (!q) throw new AppError("not_found", "Quote not found.");
    if (q.status !== "sent") throw new AppError("conflict", "This quote is no longer open for a decision. Refresh to see the latest version.");
    // Staff can hold or cancel a project while its quote is still marked sent; accepting it then would bring a closed project back to Approved.
    if (!["quote_sent", "awaiting_approval"].includes(q.request_status)) {
      throw new AppError("conflict", q.request_status === "on_hold" ? "This project is on hold, so the quote can't be decided right now. Ask iAcquire to resume it first." : "This project is no longer waiting for a quote decision. Ask iAcquire if you still want to go ahead.");
    }
    const view = toQuoteView(q);
    if (!q.content_hash || quoteContentHash(view) !== q.content_hash) throw new AppError("conflict", "This quote changed after it was sent. Ask iAcquire to resend it.");
    if (decision === "accepted" && q.valid_until && q.valid_until < new Date().toISOString().slice(0, 10)) throw new AppError("conflict", "This quote has expired. Ask iAcquire for an updated quote.");

    const ack = decision === "accepted" ? QUOTE_ACKNOWLEDGEMENT : decision === "declined" ? "I decline this quote." : "I'm requesting changes to this quote.";
    await db.query("insert into quote_approvals (quote_id, request_id, org_id, decision, note, decided_by, content_hash, acknowledgement, ip_hash) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [quoteId, q.request_id, ctx.org.orgId, decision, clean || null, ctx.user.id, q.content_hash, ack, ipHash]);
    await db.query("update project_quotes set status = $2 where id = $1", [quoteId, decision]);

    if (decision === "accepted") {
      await db.query(
        `insert into client_projects (request_id, org_id, quote_id, agreed_price_cents, ongoing_monthly_cents, currency, scope, deliverables, timeline_text)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) on conflict (request_id) do update set quote_id = excluded.quote_id, agreed_price_cents = excluded.agreed_price_cents,
           ongoing_monthly_cents = excluded.ongoing_monthly_cents, currency = excluded.currency, scope = excluded.scope, deliverables = excluded.deliverables, timeline_text = excluded.timeline_text, agreed_at = now()`,
        [q.request_id, ctx.org.orgId, quoteId, q.one_time_cents, q.ongoing_monthly_cents, q.currency, q.scope, q.deliverables, q.timeline_text],
      );
      await db.query("update client_project_requests set status = 'approved', last_activity_at = now() where id = $1", [q.request_id]);
      await db.query("insert into project_review_tasks (request_id, org_id, kind, title, due_at) values ($1,$2,'review_decision',$3, now() + interval '2 days')", [q.request_id, ctx.org.orgId, `Quote accepted on ${q.ref}: confirm the written agreement and schedule the start`]);
      // Where the Super Admin switched it on, work does not start until a person confirms the agreement and the payment the quote's terms describe (never detected, never charged).
      await seedDefaultPrerequisites(db, { id: q.request_id, org_id: ctx.org.orgId }, q.payment_terms);
    } else if (decision === "changes_requested") {
      await db.query("update client_project_requests set status = 'quote_preparing', last_activity_at = now() where id = $1", [q.request_id]);
      await db.query("insert into project_messages (request_id, org_id, author_id, author_kind, body) values ($1,$2,$3,'client',$4)", [q.request_id, ctx.org.orgId, ctx.user.id, `Requested changes to quote v${q.version}: ${clean}`]);
      await db.query("insert into project_review_tasks (request_id, org_id, kind, title, due_at) values ($1,$2,'prepare_quote',$3, now() + interval '2 days')", [q.request_id, ctx.org.orgId, `Revise the quote for ${q.ref}`]);
    } else {
      await db.query("update client_project_requests set status = 'cancelled', cancel_reason = $2, closed_at = now(), last_activity_at = now() where id = $1", [q.request_id, clean || "Quote declined by the client."]);
    }
    await db.query("insert into project_updates (request_id, org_id, author_id, kind, body) values ($1,$2,$3,'system',$4)", [q.request_id, ctx.org.orgId, ctx.user.id, `Quote v${q.version} ${decision === "accepted" ? "accepted" : decision === "declined" ? "declined" : "returned with requested changes"}.`]);
    // A quote is decided once (quote_approvals is unique per quote), so the quote and its decision name the event.
    await notifyAgency(db, ctx.org.orgId, { kind: "project_decision", severity: decision === "accepted" ? "success" : "warning", title: `${q.ref}: quote ${decision.replace("_", " ")} by ${ctx.org.name}`, body: q.project_name, link: `/admin/projects/${q.request_id}`, dedupeKey: `project:${q.request_id}:quote:${quoteId}:${decision}` }, { permission: "projects.view" });
    await notifyOrgRoles(db, ctx.org.orgId, ["owner"], { kind: "project_decision", title: `Your decision on ${q.ref} was recorded`, body: decision === "accepted" ? "Next: iAcquire will confirm the written agreement and payment terms." : undefined, link: `/projects/${q.request_id}`, dedupeKey: `project:${q.request_id}:quote:${quoteId}:${decision}:owner` });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "project.quote_decided", targetType: "project_quote", targetId: quoteId, result: "success", metadata: { decision, version: q.version, ref: q.ref, oneTimeCents: q.one_time_cents } }, db);
    return { decision, requestId: q.request_id };
  });
}

/** Opens a support request tied to this project so it lands in the existing agency inbox. */
export async function linkableProject(ctx: OrgContext, requestId: string): Promise<{ id: string; ref: string; title: string } | null> {
  return withUser(ctx.user.id, async (db) => (await db.query<{ id: string; ref: string; title: string }>("select id, ref, title from client_project_requests where id = $1 and org_id = $2", [requestId, ctx.org.orgId])).rows[0] ?? null);
}

/** Providers already connected on this workspace (lowercase keys). Only used to personalise suggestions. */
export async function connectedProviders(ctx: OrgContext): Promise<string[]> {
  const { rows } = await withSystem((db) => db.query<{ provider: string }>("select provider from integration_status where org_id = $1 and status = 'connected'", [ctx.org.orgId]));
  return rows.map((r) => r.provider.toLowerCase());
}
