import "server-only";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { env } from "@/server/env";
import { notifyUser } from "@/server/notifications";
import { applyDraftVersion, loadConnection } from "@/server/workforce/service";
import { resolveRunApproval } from "@/server/integrations/hermes/client";
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
  | "standing_authorization";
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
    const { rows } = await db.query<{ id: string }>(
      `update approval_requests set status = 'expired'
       where org_id = $1 and status = 'pending' and expires_at is not null and expires_at <= now() returning id`,
      [orgId],
    );
    for (const r of rows) {
      await db.query("insert into approval_events (approval_id, org_id, actor_kind, event) values ($1, $2, 'system', 'expired')", [r.id, orgId]);
    }
  });
}

const LIST_SQL = `
  select a.id, a.kind, a.title, a.target_type, a.target_label, a.reason, a.expected_effect, a.risk, a.status,
         a.execution_status, a.execution_detail, a.expires_at, a.decided_at, a.decision_note, a.created_at,
         ai.role_key as agent_role, ru.full_name as requested_by_name, du.full_name as decided_by_name
  from approval_requests a
  left join agent_instances ai on ai.id = a.agent_instance_id
  left join users ru on ru.id = a.requested_by
  left join users du on du.id = a.decided_by`;

export async function listApprovals(ctx: OrgContext, filter: "pending" | "history" | "all" = "pending"): Promise<ApprovalRow[]> {
  await expireStale(ctx.org.orgId);
  return withUser(ctx.user.id, async (db) => {
    const where =
      filter === "pending" ? "a.status = 'pending'" : filter === "history" ? "a.status <> 'pending'" : "true";
    const { rows } = await db.query<ApprovalRow>(
      `${LIST_SQL} where a.org_id = $1 and ${where} order by a.created_at desc limit 200`,
      [ctx.org.orgId],
    );
    return rows;
  });
}

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
        const res = await db.query(
          `insert into company_knowledge (org_id, section, content, updated_by, applied_at)
           values ($1, $2, $3, $4, now())
           on conflict (org_id, section) do update set content = excluded.content, version = company_knowledge.version + 1,
             updated_by = excluded.updated_by, updated_at = now(), applied_at = now(), review_status = 'approved', risk_flags = '{}'`,
          [orgId, section, content.slice(0, 12000), actorUserId],
        );
        return res.rowCount ? { status: "succeeded" as const, detail: "Knowledge updated. AI employees use it from their next message." } : { status: "failed" as const, detail: "Knowledge section not updated." };
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
      const leadIds = Array.isArray(a.action.leadIds) ? a.action.leadIds.filter((x): x is string => typeof x === "string") : [];
      const writesEnabled = env().GHL_WRITES_ENABLED;
      const connected = await withSystem(async (db) => {
        const { rows } = await db.query("select 1 from ghl_location_mappings where org_id = $1 and status = 'connected'", [orgId]);
        return rows.length > 0;
      });
      await withSystem((db) =>
        db.query(
          `update leads set review_status = 'approved', reviewed_by = $3, reviewed_at = now(),
             crm_sync_status = case when crm_sync_status = 'synced' then 'synced' else 'blocked' end
           where org_id = $1 and id = any($2::uuid[])`,
          [orgId, leadIds, actorUserId],
        ),
      );
      if (!connected) return { status: "blocked", detail: "Leads approved in iAcquire. CRM import is waiting for your CRM connection." };
      if (!writesEnabled) return { status: "blocked", detail: "Leads approved in iAcquire. CRM sync hasn't been enabled by the iAcquire team yet, so nothing was written to your CRM." };
      return { status: "blocked", detail: "Leads approved. CRM import runs through a reviewed sync job that is not active yet." };
    }
    case "crm_update":
      return { status: "blocked", detail: "Approved, but CRM writes aren't enabled for this workspace yet. Nothing was changed in your CRM." };
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
    case "standing_authorization":
      // The decision is the whole effect: the approval itself is what later automated messages are checked against.
      return { status: "succeeded", detail: "Recorded. Routine automated messages covered by this authorization can now be sent." };
    case "outreach":
    case "campaign_activation":
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
