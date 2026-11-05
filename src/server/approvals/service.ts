import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyUser } from "@/server/notifications";
import { systemActor } from "@/server/crm/actor";
import { createCompanyInTx } from "@/server/crm/companies";
import { createContactInTx } from "@/server/crm/contacts";
import { writeKnowledgeTextTx } from "@/server/knowledge/write";
import { sanitizeClientText } from "@/server/workforce/compiler";
import { applyDraftVersion, loadConnection } from "@/server/workforce/service";
import { appendWorkEvent } from "@/server/workforce/jobs";
import { resolveRunApproval } from "@/server/integrations/hermes/client";
import { classifyApproval, type EvidenceMarker } from "@/lib/evidence-class";
import type { OrgContext } from "@/server/tenancy/context";

export type ApprovalKind =
  | "lead_import"
  | "outreach"
  | "follow_up_message"
  | "crm_update"
  | "campaign_activation"
  | "knowledge_change"
  | "tool_action"
  | "config_change"
  | "appointment_booking"
  | "appointment_change"
  | "standing_authorization"
  | "workflow_activation"
  | "workflow_action";
export type Risk = "low" | "medium" | "high" | "critical";

export interface ApprovalRow {
  id: string;
  kind: ApprovalKind;
  title: string;
  target_type: string | null;
  target_label: string | null;
  reason: string;
  expected_effect: string;
  risk: Risk;
  status: "pending" | "approved" | "rejected" | "changes_requested" | "expired" | "cancelled";
  execution_status: "not_started" | "queued" | "running" | "succeeded" | "failed" | "blocked";
  execution_detail: string | null;
  expires_at: Date | null;
  decided_at: Date | null;
  decision_note: string | null;
  created_at: Date;
  agent_role: string | null;
  requested_by_name: string | null;
  decided_by_name: string | null;
  /** follow_up_message only: the drafted message's own status right now (queued, sent, blocked ...). Null for any other kind, or when the message cannot be found. */
  downstream_status: string | null;
  /** Why the message was blocked or failed, in the words iAcquire recorded for it. */
  downstream_detail: string | null;
  /** What kind of thing this approval is, computed from its own row every time it is read (nothing is stored). */
  evidence: EvidenceMarker;
  /** What happened after the decision, in words that do not claim more than the records show. Null until a person has approved it. */
  outcome: ApprovalOutcome | null;
}

export type ApprovalOutcomeTone = "success" | "warning" | "danger" | "neutral";
export interface ApprovalOutcome {
  label: string;
  tone: ApprovalOutcomeTone;
  detail: string | null;
}

/** Kinds whose approval ends in a message to a customer, so "not sent" is the honest wording when it does not go out. */
const MESSAGE_KINDS: ReadonlySet<ApprovalKind> = new Set<ApprovalKind>(["follow_up_message", "outreach"]);

const LEAD_IMPORT_JOB_CAPABILITY = "crm_lead_import";

function leadImportIds(action: Record<string, unknown>): string[] {
  if (!Array.isArray(action.leadIds)) return [];
  return [...new Set(action.leadIds.filter((id): id is string => typeof id === "string" && UUID.test(id)))].slice(0, 100);
}

function insertLeadImportNotice(db: Queryable, input: { orgId: string; conversationId: string | null; workJobId: string; approvalId: string; content: string }) {
  if (!input.conversationId) return Promise.resolve();
  return db.query(
    `insert into chat_messages (conversation_id, org_id, role, content, status, work_job_id, evidence, client_message_id)
     select c.id, $2, 'notice', $5, 'complete', $3, $6::jsonb, $4
       from chat_conversations c
      where c.id = $1 and c.org_id = $2 and c.growth_partner_id is not null and c.deleted_at is null
     on conflict (conversation_id, client_message_id) do nothing`,
    [input.conversationId, input.orgId, input.workJobId, `lead-import-${input.approvalId}`, input.content,
      JSON.stringify({ v: 1, class: "approved_write", ledger: { kind: "work_job", id: input.workJobId } })],
  ).then(async (result) => {
    if (result.rowCount) await db.query("update chat_conversations set last_message_at = now() where id = $1 and org_id = $2", [input.conversationId, input.orgId]);
  });
}

/** Settles the Work Board item when an import is rejected, expires, or cannot be applied. */
async function settleLeadImportWithoutWrite(
  db: Queryable,
  input: { orgId: string; approvalId: string; action: Record<string, unknown>; outcome: "rejected" | "changes_requested" | "expired" | "blocked" | "failed"; detail: string },
) {
  const workJobId = typeof input.action.workJobId === "string" && UUID.test(input.action.workJobId) ? input.action.workJobId : null;
  const leadIds = leadImportIds(input.action);
  const message = input.detail.slice(0, 500);
  const status = input.outcome === "rejected" || input.outcome === "expired" ? "cancelled" : input.outcome === "changes_requested" || input.outcome === "blocked" ? "blocked" : "failed";
  const stage = status;
  const crmStatus = status === "blocked" ? "blocked" : status === "cancelled" ? "blocked" : "failed";

  if (leadIds.length) {
    await db.query(
      `update leads set crm_sync_status = $3
        where org_id = $1 and id = any($2::uuid[]) and crm_sync_status = 'awaiting_approval'`,
      [input.orgId, leadIds, crmStatus],
    );
  }
  if (!workJobId) return;

  const { rows } = await db.query<{ conversation_id: string | null }>(
    `update ai_work_jobs
        set status = $3, stage = $4, result_summary = $5, failure_code = case when $3 in ('blocked','failed') then 'lead_import_not_applied' else null end,
            failure_message = case when $3 in ('blocked','failed') then $5 else null end, finished_at = now()
      where id = $1 and org_id = $2 and capability = $6 and status = 'waiting_for_approval'
      returning conversation_id`,
    [workJobId, input.orgId, status, stage, message, LEAD_IMPORT_JOB_CAPABILITY],
  );
  if (!rows[0]) return;
  await appendWorkEvent(db, { jobId: workJobId, orgId: input.orgId, kind: status === "failed" ? "error" : "notice", stage, message });
  await insertLeadImportNotice(db, {
    orgId: input.orgId,
    conversationId: rows[0].conversation_id,
    workJobId,
    approvalId: input.approvalId,
    content: `${message} No CRM records were created and no customer message was sent.`,
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function textValue(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return clean ? clean.slice(0, max) : null;
}

function companyLocation(value: string | null): { city?: string; region?: string; country?: string } {
  if (!value) return {};
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 1 && parts[0]!.length <= 100) return { city: parts[0] };
  if (parts.length < 2 || parts.length > 3) return {};
  const last = parts.at(-1)!.toLowerCase();
  const hasUsCountry = ["us", "usa", "united states", "united states of america"].includes(last);
  const stateOrRegion = hasUsCountry ? parts[1] : parts[1];
  return {
    city: parts[0]!.slice(0, 100),
    region: stateOrRegion.slice(0, 100),
    ...(hasUsCountry ? { country: "US" } : {}),
  };
}

async function executeApprovedLeadImport(input: {
  orgId: string;
  approvalId: string;
  action: Record<string, unknown>;
  actorUserId: string;
}): Promise<ExecOutcome> {
  const leadIds = leadImportIds(input.action);
  const workJobId = typeof input.action.workJobId === "string" && UUID.test(input.action.workJobId) ? input.action.workJobId : null;
  if (!leadIds.length || !workJobId) return { status: "failed", detail: "The reviewed CRM import request is incomplete. No CRM records were changed." };

  return withSystem(async (db) => {
    const { rows: jobs } = await db.query<{ id: string; status: string; conversation_id: string | null }>(
      `select id, status, conversation_id from ai_work_jobs
        where id = $1 and org_id = $2 and capability = $3 for update`,
      [workJobId, input.orgId, LEAD_IMPORT_JOB_CAPABILITY],
    );
    if (!jobs[0] || jobs[0].status !== "waiting_for_approval") {
      return { status: "blocked", detail: "This CRM import is no longer waiting for approval. No CRM records were changed." };
    }

    const { rows: leads } = await db.query<{
      id: string; business_name: string; website: string | null; domain: string | null; industry: string | null; location: string | null;
      qualification_summary: string | null; qualification_state: string; duplicate_status: string; review_status: string; crm_sync_status: string;
      public_contact: unknown; score: number | null; crm_company_id: string | null; crm_contact_id: string | null; org_name: string; timezone: string;
    }>(
      `select l.id, l.business_name, l.website, l.domain, l.industry, l.location, l.qualification_summary,
              l.qualification_state, l.duplicate_status, l.review_status, l.crm_sync_status, l.public_contact, l.score,
              l.crm_company_id, l.crm_contact_id, o.name as org_name, o.timezone
         from leads l join organizations o on o.id = l.org_id
        where l.org_id = $1 and l.id = any($2::uuid[])
        order by l.id for update of l`,
      [input.orgId, leadIds],
    );
    const eligible = leads.length === leadIds.length && leads.every((lead) =>
      lead.review_status === "approved" && lead.qualification_state === "evidence_backed" && lead.duplicate_status === "no_match"
      && ["awaiting_approval", "synced"].includes(lead.crm_sync_status));
    if (!eligible) return { status: "blocked", detail: "One or more leads no longer meet the approved, evidence-backed, non-duplicate import rules. No CRM records were changed." };

    const actor = systemActor({ id: input.orgId, name: leads[0]?.org_name, timezone: leads[0]?.timezone }, "AI Growth Partner approved CRM import");
    let contactCount = 0;
    let reusedCompanies = 0;
    for (const lead of leads) {
      const location = companyLocation(lead.location);
      const company = lead.crm_company_id
        ? { id: lead.crm_company_id, created: false }
        : await createCompanyInTx(db, actor, {
            name: lead.business_name,
            domain: lead.domain,
            website: lead.website,
            industry: lead.industry,
            ...location,
            description: lead.qualification_summary,
          }, "import", { onDuplicate: "return_existing" });
      if (!company.created) reusedCompanies += 1;

      const publicContact = recordValue(lead.public_contact);
      const name = textValue(publicContact.name, 200);
      const email = textValue(publicContact.email, 320);
      const phone = textValue(publicContact.phone, 40);
      const role = textValue(publicContact.role, 120);
      let contactId = lead.crm_contact_id;
      if (!contactId && (name || email || phone)) {
        const contact = await createContactInTx(db, actor, {
          displayName: name ?? email ?? phone,
          email,
          phone,
          source: "lead_research",
          leadStatus: "new",
          leadScore: lead.score,
          companyId: company.id,
          companyTitle: role,
        }, { via: "import", onDuplicate: "return_existing", enforceRequiredFields: false });
        contactId = contact.id;
        if (contact.created) contactCount += 1;
      }

      await db.query(
        `update leads set crm_company_id = $3, crm_contact_id = $4, crm_imported_by = $5, crm_imported_at = coalesce(crm_imported_at, now()), crm_sync_status = 'synced'
          where id = $1 and org_id = $2`,
        [lead.id, input.orgId, company.id, contactId, input.actorUserId],
      );
      await recordAudit({
        orgId: input.orgId,
        actorUserId: input.actorUserId,
        actorKind: "user",
        action: "leads.crm_imported",
        targetType: "lead",
        targetId: lead.id,
        approvalId: input.approvalId,
        result: "success",
        metadata: { companyId: company.id, contactId, companyCreated: company.created, workJobId },
      }, db);
    }

    const reusedCount = reusedCompanies;
    const detail = `${leads.length} company record${leads.length === 1 ? " is" : "s are"} now linked in the native CRM${contactCount ? `, with ${contactCount} public contact record${contactCount === 1 ? "" : "s"}` : ""}. ${reusedCount} existing company record${reusedCount === 1 ? " was" : "s were"} reused. No customer message was sent.`;
    await db.query(
      `update ai_work_jobs
          set status = 'completed', stage = 'completed', result = $3::jsonb, result_summary = $4, result_count = $5,
              started_at = coalesce(started_at, now()), finished_at = now(), failure_code = null, failure_message = null
        where id = $1 and org_id = $2 and status = 'waiting_for_approval'`,
      [workJobId, input.orgId, JSON.stringify({ approvalId: input.approvalId, imported: leads.length, publicContactsCreated: contactCount, companiesReused: reusedCount }), detail.slice(0, 1000), leads.length],
    );
    await appendWorkEvent(db, { jobId: workJobId, orgId: input.orgId, kind: "evidence", stage: "completed", message: detail });
    await insertLeadImportNotice(db, { orgId: input.orgId, conversationId: jobs[0]!.conversation_id, workJobId, approvalId: input.approvalId, content: `CRM import approved and completed. ${detail}` });
    return { status: "succeeded", detail };
  });
}

/**
 * What an approved request has actually come to, from its own row and, for a drafted message, the message's current status. "Completed" is only for a booking or an appointment
 * change, whose executor writes to the calendar before it reports success; "Sent" only once the message itself is sent or delivered; a queued draft is "waiting to send" and a
 * blocked or failed one is "not sent". Everything else a person approved is "applied" in iAcquire's own records, or says exactly what was handed on (a resumed run, a released step).
 */
export function approvalOutcome(row: Pick<ApprovalRow, "kind" | "status" | "execution_status" | "execution_detail" | "downstream_status" | "downstream_detail"> & { appointment_status?: "new" | "confirmed" | null }): ApprovalOutcome | null {
  if (row.status !== "approved") return null;
  const detail = row.execution_detail;
  const messaging = MESSAGE_KINDS.has(row.kind);
  switch (row.execution_status) {
    case "not_started":
      return null;
    case "queued":
    case "running":
      return { label: "Approved, waiting to run", tone: "neutral", detail };
    case "failed":
      return { label: messaging ? "Approved, but not sent" : "Approved, but it couldn't run", tone: "danger", detail };
    case "blocked":
      return { label: messaging ? "Approved, but not sent" : "Approved, but held", tone: "warning", detail };
    case "succeeded":
      break;
  }
  switch (row.kind) {
    case "appointment_booking":
      // The time is on the calendar, but the appointment type says a person confirms it and nobody has yet.
      if (row.appointment_status === "new") return { label: "Approved and applied", tone: "neutral", detail: detail ?? "On the calendar, waiting for the host to confirm." };
      return { label: "Completed", tone: "success", detail };
    case "appointment_change":
      return { label: "Completed", tone: "success", detail };
    case "lead_import":
      return { label: "Imported to CRM", tone: "success", detail };
    case "follow_up_message": {
      const downstream = row.downstream_status;
      if (downstream === "sent" || downstream === "delivered" || downstream === "read") return { label: "Sent", tone: "success", detail };
      if (downstream === "blocked" || downstream === "failed") return { label: "Approved, but not sent", tone: "danger", detail: row.downstream_detail ?? detail };
      return { label: "Approved, waiting to send", tone: "neutral", detail };
    }
    case "tool_action":
      return { label: "Approved, resumed", tone: "neutral", detail };
    case "workflow_action":
      return { label: "Approved, step released", tone: "neutral", detail };
    case "campaign_activation":
      return { label: "Approved, scheduled", tone: "neutral", detail };
    case "standing_authorization":
      return { label: "Approved, recorded", tone: "neutral", detail };
    default:
      return { label: "Approved and applied", tone: "neutral", detail };
  }
}

export async function createApproval(
  db: Queryable,
  a: {
    orgId: string;
    agentId?: string | null;
    requestedBy?: string | null;
    kind: ApprovalKind;
    title: string;
    action: Record<string, unknown>;
    targetType?: string;
    targetId?: string;
    targetLabel?: string;
    reason: string;
    expectedEffect: string;
    risk: Risk;
    expiresInHours?: number;
    idempotencyKey?: string;
    actorKind?: "user" | "agent" | "system";
  },
): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>(
    `insert into approval_requests (org_id, agent_instance_id, requested_by, kind, title, action, target_type, target_id,
       target_label, reason, expected_effect, risk, expires_at, idempotency_key)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       case when $13::int is null then null else now() + make_interval(hours => $13::int) end, $14)
     on conflict (idempotency_key) do nothing returning id`,
    [
      a.orgId, a.agentId ?? null, a.requestedBy ?? null, a.kind, a.title.slice(0, 200), JSON.stringify(a.action),
      a.targetType ?? null, a.targetId ?? null, a.targetLabel?.slice(0, 200) ?? null, a.reason.slice(0, 2000),
      a.expectedEffect.slice(0, 2000), a.risk, a.expiresInHours ?? 168, a.idempotencyKey ?? null,
    ],
  );
  const id = rows[0]?.id ?? null;
  if (id) {
    await db.query(
      "insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event) values ($1, $2, $3, $4, 'created')",
      [id, a.orgId, a.requestedBy ?? null, a.actorKind ?? "user"],
    );
  }
  return id;
}

async function expireStale(orgId: string) {
  await withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; kind: ApprovalKind; action: Record<string, unknown> }>(
      `update approval_requests set status = 'expired'
       where org_id = $1 and status = 'pending' and expires_at is not null and expires_at <= now() returning id, kind, action`,
      [orgId],
    );
    for (const r of rows) {
      await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'system', 'expired')", [r.id, orgId]);
      if (r.kind === "lead_import") await settleLeadImportWithoutWrite(db, {
        orgId,
        approvalId: r.id,
        action: r.action,
        outcome: "expired",
        detail: "The CRM import approval expired before a decision was made.",
      });
    }
  });
}

const LIST_SQL = `
  select a.id, a.kind, a.title, a.target_type, a.target_label, a.reason, a.expected_effect, a.risk, a.status,
         a.execution_status, a.execution_detail, a.expires_at, a.decided_at, a.decision_note, a.created_at,
         ai.role_key as agent_role, ru.full_name as requested_by_name, du.full_name as decided_by_name,
         case when a.kind = 'follow_up_message' then a.action ->> 'messageId' end as message_id,
         case when a.kind = 'appointment_booking' then a.action ->> 'bookingId' end as booking_id
  from approval_requests a
  left join agent_instances ai on ai.id = a.agent_instance_id
  left join users ru on ru.id = a.requested_by
  left join users du on du.id = a.decided_by`;

export async function listApprovals(ctx: OrgContext, filter: "pending" | "history" | "all" = "pending"): Promise<ApprovalRow[]> {
  await expireStale(ctx.org.orgId);
  const listed = await withUser(ctx.user.id, async (db) => {
    const where =
      filter === "pending" ? "a.status = 'pending'" : filter === "history" ? "a.status <> 'pending'" : "true";
    const { rows } = await db.query<Omit<ApprovalRow, "downstream_status" | "downstream_detail" | "evidence" | "outcome"> & { message_id: string | null; booking_id: string | null }>(
      `${LIST_SQL} where a.org_id = $1 and ${where} order by a.created_at desc limit 200`,
      [ctx.org.orgId],
    );
    return rows;
  });

  // A drafted message's status lives in the message, not the approval: an approved draft is only queued until the message itself is sent. Only the status and the recorded reason are
  // read (never the body), and only for messages of this workspace, so an id from somewhere else finds nothing.
  const messageIds = [...new Set(listed.map((row) => row.message_id).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  const downstream = new Map<string, { status: string; detail: string | null }>();
  if (messageIds.length) {
    const { rows } = await withSystem((db) =>
      db.query<{ id: string; status: string; blocked_reason: string | null; status_detail: string | null }>(
        "select id, status, blocked_reason, status_detail from conversation_messages where org_id = $1 and id = any($2::uuid[])",
        [ctx.org.orgId, messageIds],
      ),
    );
    for (const row of rows) downstream.set(row.id, { status: row.status, detail: (row.status_detail ?? row.blocked_reason)?.slice(0, 300) ?? null });
  }

  // A booking's own state (the appointment waits for the host, or is confirmed), read only for bookings of this workspace.
  const bookingIds = [...new Set(listed.map((row) => row.booking_id).filter((id): id is string => typeof id === "string" && UUID.test(id)))];
  const appointmentStatuses = new Map<string, "new" | "confirmed">();
  if (bookingIds.length) {
    const { rows } = await withSystem((db) =>
      db.query<{ id: string; status: string }>(
        "select b.id, r.status from appointment_bookings b join appointment_refs r on r.id = b.appointment_id and r.org_id = b.org_id where b.org_id = $1 and b.id = any($2::uuid[])",
        [ctx.org.orgId, bookingIds],
      ),
    );
    for (const row of rows) appointmentStatuses.set(row.id, row.status === "new" ? "new" : "confirmed");
  }

  return listed.map(({ message_id, booking_id, ...row }) => {
    const message = message_id ? downstream.get(message_id) : undefined;
    const appointment_status = booking_id ? appointmentStatuses.get(booking_id) ?? null : null;
    const base = { ...row, downstream_status: message?.status ?? null, downstream_detail: message?.detail ?? null };
    const kind = classifyApproval({ kind: row.kind, status: row.status, execution_status: row.execution_status, downstream: base.downstream_status, appointmentStatus: appointment_status });
    const evidence: EvidenceMarker = { v: 1, class: kind.class, ledger: { kind: "approval", id: row.id } };
    return { ...base, evidence, outcome: approvalOutcome({ ...base, appointment_status }) };
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function getApprovalEvents(ctx: OrgContext, approvalId: string) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ event: string; note: string | null; created_at: Date; actor_kind: string; actor_name: string | null }>(
      `select e.event, e.note, e.created_at, e.actor_kind, u.full_name as actor_name
       from approval_events e left join users u on u.id = e.actor_user_id
       where e.approval_id = $1 and e.org_id = $2 order by e.created_at asc`,
      [approvalId, ctx.org.orgId],
    );
    return rows;
  });
}

export async function pendingApprovalCount(ctx: OrgContext): Promise<number> {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ n: string }>(
      "select count(*)::text as n from approval_requests where org_id = $1 and status = 'pending' and (expires_at is null or expires_at > now())",
      [ctx.org.orgId],
    );
    return Number(rows[0]?.n ?? 0);
  });
}

export type Decision = "approve" | "reject" | "request_changes";

/**
 * Records a decision with an atomic compare-and-set on status = 'pending', so double clicks,
 * concurrent approvers and expired requests can never cause a second execution.
 */
export async function decideApproval(ctx: OrgContext, approvalId: string, decision: Decision, note?: string) {
  if (!ctx.can("approvals.decide")) throw new AppError("forbidden", "Only workspace owners and admins can decide approvals.");
  const cleanNote = note?.trim().slice(0, 1000) || null;
  if (decision === "request_changes" && !cleanNote) throw new AppError("invalid_input", "Tell the team what should change.");

  const decided = await withSystem(async (db) => {
    const { rows: current } = await db.query<{ risk: Risk; status: string; expires_at: Date | null }>(
      "select risk, status, expires_at from approval_requests where id = $1 and org_id = $2",
      [approvalId, ctx.org.orgId],
    );
    const row = current[0];
    if (!row) throw new AppError("not_found", "Approval not found.");
    if ((row.risk === "high" || row.risk === "critical") && decision === "approve" && !ctx.can("approvals.decide_high")) {
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "approval.decide", targetType: "approval", targetId: approvalId, approvalId, result: "denied", metadata: { reason: "owner_required" } }, db);
      throw new AppError("forbidden", "High-risk actions need approval from the workspace owner.");
    }
    const newStatus = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested";
    const { rows } = await db.query<{ id: string; kind: ApprovalKind; action: Record<string, unknown>; agent_instance_id: string | null; requested_by: string | null; title: string }>(
      `update approval_requests
       set status = $3, decided_by = $4, decided_at = now(), decision_note = $5,
           execution_status = case when $3 = 'approved' then 'queued' else execution_status end
       where id = $1 and org_id = $2 and status = 'pending' and (expires_at is null or expires_at > now())
       returning id, kind, action, agent_instance_id, requested_by, title`,
      [approvalId, ctx.org.orgId, newStatus, ctx.user.id, cleanNote],
    );
    const updated = rows[0];
    if (!updated) {
      if (row.status === "pending" && row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
        // Commit the expiry (returning instead of throwing keeps this transaction from rolling back).
        await db.query("update approval_requests set status = 'expired' where id = $1 and status = 'pending'", [approvalId]);
        await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'system', 'expired')", [approvalId, ctx.org.orgId]);
        return "expired" as const;
      }
      throw new AppError("conflict", "This approval was already decided.");
    }
    const event = decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes_requested";
    await db.query(
      "insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event, note) values ($1, $2, $3, 'user', $4, $5)",
      [approvalId, ctx.org.orgId, ctx.user.id, event, cleanNote],
    );
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", agentInstanceId: updated.agent_instance_id, action: `approval.${event}`, targetType: "approval", targetId: approvalId, approvalId, result: "success", metadata: { kind: updated.kind } },
      db,
    );
    if (updated.kind === "lead_import" && decision !== "approve") {
      await settleLeadImportWithoutWrite(db, {
        orgId: ctx.org.orgId,
        approvalId,
        action: updated.action,
        outcome: decision === "reject" ? "rejected" : "changes_requested",
        detail: decision === "reject" ? "The CRM import was not approved." : `The CRM import was returned for changes: ${cleanNote}`,
      });
    }
    if (updated.requested_by && updated.requested_by !== ctx.user.id) {
      await notifyUser(db, updated.requested_by, ctx.org.orgId, {
        kind: "approval_decided",
        severity: decision === "approve" ? "success" : "info",
        title: `${updated.title} — ${decision === "approve" ? "approved" : decision === "reject" ? "rejected" : "changes requested"}`,
        link: "/approvals",
      });
    }
    return updated;
  });

  if (decided === "expired") throw new AppError("conflict", "This approval expired before a decision was made, so it won't run.");
  let outcome: ExecOutcome | null = null;
  if (decision === "approve") outcome = await executeApproval(ctx.org.orgId, decided.id, ctx.user.id);
  else if (decided.kind === "tool_action") await releaseRejectedToolAction(ctx.org.orgId, decided.agent_instance_id, decided.action);
  else if (decided.kind === "appointment_booking" && typeof decided.action.bookingId === "string") {
    // A rejected proposal releases the held time so someone else can have it.
    const { releaseRejectedBooking } = await import("@/server/appointments/booking");
    await releaseRejectedBooking(ctx.org.orgId, decided.action.bookingId);
  } else if (decided.kind === "workflow_activation" || decided.kind === "workflow_action") {
    // A rejected workflow version keeps running nothing; a rejected step cancels its run, so it never acts later.
    const { releaseRejectedWorkflowApproval } = await import("@/server/crm/workflows/approvals");
    await releaseRejectedWorkflowApproval(ctx.org.orgId, decided.id, decided.kind, decided.action, ctx.user.id);
  } else if (decided.kind === "campaign_activation") {
    // A campaign that isn't approved goes back to draft with the owner's note; nothing about it is sent.
    const { releaseRejectedCampaignApproval } = await import("@/server/crm/campaigns");
    await releaseRejectedCampaignApproval(ctx.org.orgId, decided.id, decided.action, ctx.user.id, cleanNote);
  } else if (decided.kind === "follow_up_message" && typeof decided.action.messageId === "string") {
    // Rejecting a draft discards it, so it can never be sent later.
    await withSystem((db) => db.query("update conversation_messages set status = 'blocked', blocked_reason = 'discarded', status_detail = 'Rejected in the Approval Center.' where org_id = $1 and id = $2 and status = 'draft'", [ctx.org.orgId, decided.action.messageId]));
  }
  // The execution outcome is returned so the UI can say what actually happened (e.g. held, not sent).
  return { id: decided.id, outcome };
}

async function releaseRejectedToolAction(orgId: string, agentId: string | null, action: Record<string, unknown>) {
  // Tell Hermes to block the step so the run doesn't wait for its own timeout.
  if (!agentId || typeof action.hermesRunId !== "string") return;
  const conn = await withSystem((db) => loadConnection(db, agentId));
  if (!conn) return;
  await resolveRunApproval(conn, action.hermesRunId, "deny", typeof action.hermesApprovalId === "string" ? action.hermesApprovalId : undefined).catch(() => undefined);
}

export type ExecOutcome = { status: "succeeded" | "failed" | "blocked"; detail: string };

const BLOCKED_MESSAGING =
  "Approved, but not sent: customer messaging isn't enabled for this workspace. iAcquire only sends messages through a verified, approved messaging integration.";

/** Claims the queued execution exactly once, then runs the kind-specific executor. */
export async function executeApproval(orgId: string, approvalId: string, actorUserId: string): Promise<ExecOutcome | null> {
  const claimed = await withSystem(async (db) => {
    const { rows } = await db.query<{ kind: ApprovalKind; action: Record<string, unknown>; agent_instance_id: string | null; target_id: string | null }>(
      `update approval_requests set execution_status = 'running'
       where id = $1 and org_id = $2 and status = 'approved' and execution_status = 'queued'
       returning kind, action, agent_instance_id, target_id`,
      [approvalId, orgId],
    );
    if (rows[0]) {
      await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event) values ($1, $2, $3, 'system', 'execution_started')", [approvalId, orgId, actorUserId]);
    }
    return rows[0] ?? null;
  });
  if (!claimed) return null;

  let outcome: ExecOutcome;
  try {
    outcome = await runExecutor(orgId, approvalId, claimed, actorUserId);
  } catch (err) {
    outcome = { status: "failed", detail: err instanceof AppError ? err.message : "The action failed to run. Nothing was changed." };
  }

  await withSystem(async (db) => {
    await db.query(
      "update approval_requests set execution_status = $3, execution_detail = $4, executed_at = case when $3 = 'succeeded' then now() end where id = $1 and org_id = $2",
      [approvalId, orgId, outcome.status, outcome.detail.slice(0, 1000)],
    );
    const event = outcome.status === "succeeded" ? "execution_succeeded" : outcome.status === "blocked" ? "execution_blocked" : "execution_failed";
    await db.query("insert into approval_events (approval_id, org_id, actor_kind, event, note) values ($1, $2, 'system', $3, $4)", [
      approvalId,
      orgId,
      event,
      outcome.detail.slice(0, 1000),
    ]);
    await recordAudit(
      { orgId, actorUserId, actorKind: "system", agentInstanceId: claimed.agent_instance_id, action: `approval.${event}`, targetType: "approval", targetId: approvalId, approvalId, result: outcome.status === "succeeded" ? "success" : "failure", metadata: { kind: claimed.kind } },
      db,
    );
    if (claimed.kind === "lead_import" && outcome.status !== "succeeded") {
      await settleLeadImportWithoutWrite(db, {
        orgId,
        approvalId,
        action: claimed.action,
        outcome: outcome.status,
        detail: outcome.detail,
      });
    }
  });
  return outcome;
}

async function runExecutor(
  orgId: string,
  approvalId: string,
  a: { kind: ApprovalKind; action: Record<string, unknown>; agent_instance_id: string | null },
  actorUserId: string,
): Promise<ExecOutcome> {
  switch (a.kind) {
    case "knowledge_change": {
      const section = String(a.action.section ?? "");
      const content = String(a.action.content ?? "");
      return withSystem(async (db) => {
        // The same writer as the Knowledge Center: a clean text becomes the approved text with a history row, and a flagged one is held for the agency
        // instead of replacing approved text, so approving a proposal never skips the safety scan.
        const written = await writeKnowledgeTextTx(db, { orgId, section, text: sanitizeClientText(content, 12000), userId: actorUserId, source: "client" });
        if (written.held) {
          const { rows: org } = await db.query<{ name: string }>("select name from organizations where id = $1", [orgId]);
          await notifyAgency(db, orgId, {
            kind: "knowledge_update_ready",
            severity: "warning",
            title: `${org[0]?.name ?? "A client"}: knowledge update needs review`,
            body: `Section "${section}" was held because it may conflict with AI safety policy. The previous approved text is still in use.`,
            link: `/admin/clients/${orgId}?tab=reviews`,
          });
          return { status: "blocked" as const, detail: "Held for iAcquire review because the text may conflict with AI safety policy. The previous approved text is still in use." };
        }
        return { status: "succeeded" as const, detail: "Knowledge updated. The AI Growth Partner and any retained profiles use it from their next message." };
      });
    }
    case "config_change": {
      const versionId = String(a.action.versionId ?? "");
      return withSystem(async (db) => {
        await applyDraftVersion(db, orgId, versionId, actorUserId);
        return { status: "succeeded" as const, detail: "Configuration applied. New conversations use it immediately." };
      });
    }
    case "tool_action": {
      if (!a.agent_instance_id || typeof a.action.hermesRunId !== "string") return { status: "failed", detail: "The paused run could not be identified." };
      const conn = await withSystem((db) => loadConnection(db, a.agent_instance_id as string));
      if (!conn) return { status: "failed", detail: "The employee is no longer connected, so the step was not run." };
      await resolveRunApproval(conn, a.action.hermesRunId, "once", typeof a.action.hermesApprovalId === "string" ? a.action.hermesApprovalId : undefined);
      return { status: "succeeded", detail: "Hermes accepted the approval and resumed the run." };
    }
    case "lead_import": {
      return executeApprovedLeadImport({ orgId, approvalId, action: a.action, actorUserId });
    }
    case "crm_update": {
      // A change a client's own AI employee asked to make through the CRM tools: re-validated and carried out now, as that employee.
      // Any other CRM update (for example one meant for an external CRM) still has no executor.
      const { executeApprovedAgentToolCall, isAgentToolApproval } = await import("@/server/crm/agent-tools/service");
      if (isAgentToolApproval(a.action)) return executeApprovedAgentToolCall({ orgId, approvalId, agentInstanceId: a.agent_instance_id, action: a.action });
      return { status: "blocked", detail: "Approved, but CRM writes aren't enabled for this workspace yet. Nothing was changed in your CRM." };
    }
    case "follow_up_message": {
      // An AI draft from the inbox: queue it through the full send rule chain. Any other follow-up stays held.
      const messageId = typeof a.action.messageId === "string" ? a.action.messageId : null;
      if (!messageId) return { status: "blocked", detail: BLOCKED_MESSAGING };
      const { queueApprovedDraft } = await import("@/server/messaging/inbox");
      return withSystem((db) => queueApprovedDraft(db, { orgId, messageId, approvalId }));
    }
    case "appointment_booking": {
      const bookingId = typeof a.action.bookingId === "string" ? a.action.bookingId : null;
      if (!bookingId) return { status: "failed", detail: "The booking could not be identified." };
      const { executeApprovedBooking } = await import("@/server/appointments/booking");
      return executeApprovedBooking(orgId, approvalId, bookingId);
    }
    case "appointment_change": {
      const { executeApprovedAppointmentChange } = await import("@/server/appointments/changes");
      return executeApprovedAppointmentChange(orgId, approvalId, a.action, actorUserId, a.agent_instance_id);
    }
    case "workflow_activation": {
      // Binds the approval to the exact version content an owner looked at, and switches the workflow on when that was asked for.
      const { executeWorkflowActivation } = await import("@/server/crm/workflows/approvals");
      return executeWorkflowActivation(orgId, approvalId, a.action, actorUserId);
    }
    case "workflow_action": {
      // Only marks the waiting step approved and makes its run due: the scheduler runs the step, never this request.
      const { executeWorkflowAction } = await import("@/server/crm/workflows/approvals");
      return executeWorkflowAction(orgId, approvalId, a.action);
    }
    case "standing_authorization":
      // The decision is the whole effect: the approval itself is what later automated messages are checked against.
      return { status: "succeeded", detail: "Recorded. Routine automated messages covered by this authorization can now be sent." };
    case "campaign_activation": {
      // The owner approved one campaign's exact channel, audience, message version, schedule and pace; re-checked, then scheduled.
      const { executeCampaignActivation } = await import("@/server/crm/campaigns");
      return executeCampaignActivation(orgId, approvalId, a.action, actorUserId);
    }
    case "outreach":
      return { status: "blocked", detail: BLOCKED_MESSAGING };
    default:
      return { status: "failed", detail: `No executor for ${approvalId}.` };
  }
}

/**
 * Records a person's standing permission for a kind of routine automated message (appointment reminders, a retention program).
 * It is an approval that is already decided by the person making it, so an employee that normally asks first can send those
 * messages. It expires, is checked every time one is sent, and covers only what its title says.
 */
export async function createStandingAuthorization(
  db: Queryable,
  a: { orgId: string; userId: string; title: string; reason: string; expectedEffect: string; scopeKey: string; days?: number },
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into approval_requests (org_id, requested_by, kind, title, action, target_type, target_id, reason, expected_effect, risk, status, execution_status, expires_at, decided_by, decided_at, executed_at, idempotency_key)
     values ($1, $2, 'standing_authorization', $3, $4, 'standing_authorization', $5, $6, $7, 'low', 'approved', 'succeeded', now() + make_interval(days => $8::int), $2, now(), now(), $9) returning id`,
    [a.orgId, a.userId, a.title.slice(0, 200), JSON.stringify({ scope: a.scopeKey }), a.scopeKey.slice(0, 120), a.reason.slice(0, 2000), a.expectedEffect.slice(0, 2000), a.days ?? 90, `standing:${a.orgId}:${a.scopeKey}:${Date.now()}`],
  );
  const id = rows[0].id;
  await db.query("insert into approval_events (approval_id, org_id, actor_user_id, actor_kind, event) values ($1, $2, $3, 'user', 'created'), ($1, $2, $3, 'user', 'approved')", [id, a.orgId, a.userId]);
  await recordAudit({ orgId: a.orgId, actorUserId: a.userId, actorKind: "user", action: "approval.standing_authorization", targetType: "approval", targetId: id, approvalId: id, result: "success", metadata: { scope: a.scopeKey } }, db);
  return id;
}

/** Marks every pending approval whose time has run out as expired. Safe to run repeatedly; it never decides anything. */
export async function expireAllStaleApprovals(): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string }>(
      "update approval_requests set status = 'expired' where status = 'pending' and expires_at is not null and expires_at <= now() returning id, org_id",
    );
    for (const r of rows) await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'system', 'expired')", [r.id, r.org_id]);
    return rows.length;
  });
}
