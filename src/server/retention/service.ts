import "server-only";
import { z } from "zod";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { createStandingAuthorization } from "@/server/approvals/service";
import { ensureDefaultPrograms, programHash, type ProgramRow } from "@/server/retention/engine";
import { cancelLinkRequests, cancelRetention } from "@/server/retention/cancel";
import { withdrawAutomaticReviewAsks } from "@/server/retention/hold";
import { withdrawQueuedRemindersForContact } from "@/server/invoices/reminders";
import { releaseReservation } from "@/server/billing/ledger";
import { assertSurveysEnabled } from "@/server/reputation/entitlement";
import { defaultFor, hasFeedbackLink, isProgramKind, MAX_BODY, MAX_STEPS, validateSteps, type ProgramKind, type ProgramState, type ProgramStep, type StepIssue } from "@/lib/retention";
import type { OrgContext } from "@/server/tenancy/context";

export interface ProgramStats {
  enrolled30d: number;
  sent30d: number;
  delivered30d: number;
  held30d: number;
  stopped30d: number;
  replied30d: number;
}

export interface ProgramView {
  id: string;
  kind: ProgramKind;
  name: string;
  description: string;
  audience: string;
  trigger: ProgramRow["trigger"];
  purpose: ProgramRow["purpose"];
  steps: ProgramStep[];
  businessHoursOnly: boolean;
  inactiveDays: number | null;
  enabled: boolean;
  state: ProgramState;
  approvedAt: string | null;
  authorizedUntil: string | null;
  stats: ProgramStats;
}

export async function listPrograms(ctx: OrgContext): Promise<ProgramView[]> {
  if (!ctx.can("retention.view")) return [];
  await withSystem((db) => ensureDefaultPrograms(db, ctx.org.orgId));
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<ProgramRow & { description: string; expires_at: Date | null; approval_status: string | null }>(
      `select p.*, a.expires_at, a.status as approval_status from retention_programs p left join approval_requests a on a.id = p.approval_id and a.org_id = p.org_id
       where p.org_id = $1 order by array_position(array['welcome','onboarding_checkin','service_followup','feedback_request','reengagement'], p.kind)`,
      [ctx.org.orgId],
    );
    const stats = await db.query<{ program_id: string; enrolled: number; sent: number; delivered: number; held: number; stopped: number; replied: number }>(
      `select p.id as program_id,
         (select count(*)::int from retention_enrollments e where e.program_id = p.id and e.started_at > now() - interval '30 days') as enrolled,
         (select count(*)::int from retention_steps s join retention_enrollments e on e.id = s.enrollment_id where e.program_id = p.id and s.status = 'sent' and s.updated_at > now() - interval '30 days') as sent,
         (select count(*)::int from retention_steps s join retention_enrollments e on e.id = s.enrollment_id join conversation_messages m on m.id = s.message_id where e.program_id = p.id and m.status in ('delivered', 'read') and s.updated_at > now() - interval '30 days') as delivered,
         (select count(*)::int from retention_steps s join retention_enrollments e on e.id = s.enrollment_id where e.program_id = p.id and s.status = 'blocked' and s.updated_at > now() - interval '30 days') as held,
         (select count(*)::int from retention_enrollments e where e.program_id = p.id and e.status = 'cancelled' and e.closed_at > now() - interval '30 days') as stopped,
         (select count(*)::int from retention_enrollments e where e.program_id = p.id and e.cancel_reason = 'customer_replied' and e.closed_at > now() - interval '30 days') as replied
       from retention_programs p where p.org_id = $1`,
      [ctx.org.orgId],
    );
    const byProgram = new Map(stats.rows.map((r) => [r.program_id, r]));
    const now = Date.now();
    return rows.map((r): ProgramView => {
      const d = defaultFor(r.kind);
      const authLive = r.approval_status === "approved" && (!r.expires_at || new Date(r.expires_at).getTime() > now);
      const approved = r.approved_hash === r.content_hash;
      const state: ProgramState = !r.enabled ? "off" : !approved ? "needs_approval" : authLive ? "on" : "lapsed";
      const s = byProgram.get(r.id);
      return {
        id: r.id, kind: r.kind, name: r.name, description: r.description, audience: d.audience, trigger: r.trigger, purpose: r.purpose, steps: r.steps, businessHoursOnly: r.business_hours_only,
        inactiveDays: r.inactive_days, enabled: r.enabled, state, approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : null, authorizedUntil: r.expires_at ? new Date(r.expires_at).toISOString() : null,
        stats: { enrolled30d: s?.enrolled ?? 0, sent30d: s?.sent ?? 0, delivered30d: s?.delivered ?? 0, held30d: s?.held ?? 0, stopped30d: s?.stopped ?? 0, replied30d: s?.replied ?? 0 },
      };
    });
  });
}

const stepSchema = z.object({ key: z.string().trim().min(1).max(40), delayDays: z.number().int().min(0).max(365), body: z.string().max(MAX_BODY + 200) });
const saveSchema = z.object({ steps: z.array(stepSchema).min(1).max(MAX_STEPS), businessHoursOnly: z.boolean().optional(), inactiveDays: z.number().int().min(30).max(730).nullable().optional() });

/**
 * Saves new wording or timing. Changing it withdraws the approval: the program stays off (or stops sending, if it was on) until the
 * owner approves exactly these words. The message wording is never written by an AI.
 */
export async function saveProgram(ctx: OrgContext, kindRaw: string, input: z.input<typeof saveSchema>): Promise<{ ok: true } | { ok: false; issues: StepIssue[] }> {
  if (!ctx.can("retention.edit")) throw new AppError("forbidden", "Only owners and managers can change customer programs.");
  if (!isProgramKind(kindRaw)) throw new AppError("not_found", "Program not found.");
  const kind: ProgramKind = kindRaw;
  const data = saveSchema.parse(input);
  return withSystem(async (db) => {
    await ensureDefaultPrograms(db, ctx.org.orgId);
    const { rows } = await db.query<ProgramRow>("select * from retention_programs where org_id = $1 and kind = $2 for update", [ctx.org.orgId, kind]);
    const p = rows[0];
    if (!p) throw new AppError("not_found", "Program not found.");
    const steps = data.steps.map((s) => ({ key: s.key, delayDays: s.delayDays, body: s.body.trim() }));
    const issues = validateSteps(steps, p.purpose, kind);
    if (issues.length) return { ok: false as const, issues };
    // The feedback link starts a survey, which a Super Admin switches on for the workspace first.
    if (steps.some((s) => hasFeedbackLink(s.body))) await assertSurveysEnabled(db, ctx.org.orgId);
    const businessHoursOnly = data.businessHoursOnly ?? p.business_hours_only;
    const inactiveDays = p.trigger === "inactive" ? (data.inactiveDays ?? p.inactive_days) : null;
    const hash = programHash({ kind, trigger: p.trigger, purpose: p.purpose, steps, businessHoursOnly, inactiveDays });
    if (hash === p.content_hash) return { ok: true as const };
    await db.query("update retention_programs set steps = $3::jsonb, business_hours_only = $4, inactive_days = $5, content_hash = $6 where org_id = $1 and kind = $2", [ctx.org.orgId, kind, JSON.stringify(steps), businessHoursOnly, inactiveDays, hash]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "retention.program_edited", targetType: "retention_program", targetId: p.id, result: "success", metadata: { kind, withdrawnApproval: p.approved_hash === p.content_hash } }, db);
    return { ok: true as const };
  });
}

/** Stops everything a program has scheduled or queued. Nothing is sent after this returns. */
async function stopProgramWork(db: Parameters<Parameters<typeof withSystem>[0]>[0], orgId: string, programId: string, reason: string) {
  const open = await db.query<{ contact_id: string }>("select distinct contact_id from retention_enrollments where org_id = $1 and program_id = $2 and status = 'active'", [orgId, programId]);
  for (const c of open.rows) await cancelRetention(db, orgId, c.contact_id, reason);
  // Messages the program already queued or held for approval must not slip out afterwards.
  const pending = await db.query<{ id: string; reservation_id: string | null }>(
    `update conversation_messages m set status = 'blocked', blocked_reason = 'program_off', status_detail = 'Stopped before sending.'
     from retention_steps s join retention_enrollments e on e.id = s.enrollment_id where s.message_id = m.id and e.program_id = $1 and e.org_id = $2 and m.status in ('draft', 'queued') returning m.id, m.reservation_id`,
    [programId, orgId],
  );
  for (const m of pending.rows) if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: "Program switched off" });
  await cancelLinkRequests(db, orgId, pending.rows.map((m) => m.id));
}

/**
 * Switches a program on or off. Switching on is the owner's decision and records their standing authorization for exactly this wording
 * (it expires after 90 days and is checked every time a message goes out). Switching off is available to managers too and takes effect
 * immediately: scheduled steps are cancelled and anything queued is stopped.
 */
export async function setProgramEnabled(ctx: OrgContext, kindRaw: string, enabled: boolean): Promise<void> {
  if (!isProgramKind(kindRaw)) throw new AppError("not_found", "Program not found.");
  const kind: ProgramKind = kindRaw;
  if (enabled && !ctx.can("retention.activate")) throw new AppError("forbidden", "Only the business owner can switch a customer program on.");
  if (!enabled && !ctx.can("retention.edit")) throw new AppError("forbidden", "Only owners and managers can change customer programs.");
  await withSystem(async (db) => {
    await ensureDefaultPrograms(db, ctx.org.orgId);
    const { rows } = await db.query<ProgramRow>("select * from retention_programs where org_id = $1 and kind = $2 for update", [ctx.org.orgId, kind]);
    const p = rows[0];
    if (!p) throw new AppError("not_found", "Program not found.");
    if (!enabled) {
      await db.query("update retention_programs set enabled = false where id = $1", [p.id]);
      await stopProgramWork(db, ctx.org.orgId, p.id, "program_off");
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "retention.program_off", targetType: "retention_program", targetId: p.id, result: "success", metadata: { kind } }, db);
      return;
    }
    const issues = validateSteps(p.steps, p.purpose, kind);
    if (issues.length) throw new AppError("invalid_input", issues[0].message);
    if (p.steps.some((s) => hasFeedbackLink(s.body))) await assertSurveysEnabled(db, ctx.org.orgId);
    const approvalId = await createStandingAuthorization(db, {
      orgId: ctx.org.orgId, userId: ctx.user.id, scopeKey: `retention:${kind}`, days: 90, title: `Send "${p.name}" to customers`,
      reason: `The owner approved the wording of "${p.name}" and switched it on.`,
      expectedEffect: p.purpose === "marketing"
        ? "Customers who agreed to marketing messages and have been quiet for a while get this message, a few people a day, outside quiet hours and never after they opt out."
        : "Eligible customers get these messages at the times shown, outside quiet hours and never after they opt out or reply.",
    });
    await db.query("update retention_programs set enabled = true, approved_hash = content_hash, approval_id = $2, approved_by = $3, approved_at = now() where id = $1", [p.id, approvalId, ctx.user.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "retention.program_on", targetType: "retention_program", targetId: p.id, approvalId, result: "success", metadata: { kind, contentHash: p.content_hash } }, db);
  });
}

const STAGES = ["lead_captured", "validated", "qualified", "follow_up", "appointment", "human_sales", "won", "lost", "customer", "retention"] as const;
export const STAGE_LABEL: Record<(typeof STAGES)[number], string> = {
  lead_captured: "Lead captured", validated: "Validated", qualified: "Qualified", follow_up: "Follow-up", appointment: "Appointment", human_sales: "With sales", won: "Won", lost: "Lost", customer: "Customer", retention: "Retention",
};

export interface LifecycleOverview {
  stages: Array<{ stage: string; label: string; count: number }>;
  customers: Array<{ id: string; name: string; stage: string; since: string | null; paused: boolean; activePrograms: number }>;
}

export async function getLifecycleOverview(ctx: OrgContext): Promise<LifecycleOverview> {
  if (!ctx.can("retention.view") || !ctx.can("contacts.view")) return { stages: [], customers: [] };
  return withUser(ctx.user.id, async (db) => {
    const counts = await db.query<{ stage: string; n: number }>("select lifecycle_stage as stage, count(*)::int as n from contacts where org_id = $1 and deleted_at is null group by lifecycle_stage", [ctx.org.orgId]);
    const byStage = new Map(counts.rows.map((r) => [r.stage, r.n]));
    const customers = await db.query<{ id: string; display_name: string; stage: string; customer_since: Date | null; retention_paused: boolean; active: number }>(
      `select c.id, c.display_name, c.lifecycle_stage as stage, c.customer_since, c.retention_paused,
         (select count(*)::int from retention_enrollments e where e.contact_id = c.id and e.status = 'active') as active
       from contacts c where c.org_id = $1 and c.deleted_at is null and c.lifecycle_stage in ('customer', 'retention') order by c.customer_since desc nulls last limit 50`,
      [ctx.org.orgId],
    );
    return {
      stages: STAGES.map((s) => ({ stage: s, label: STAGE_LABEL[s], count: byStage.get(s) ?? 0 })),
      customers: customers.rows.map((c) => ({ id: c.id, name: c.display_name || "Unnamed contact", stage: c.stage, since: c.customer_since ? new Date(c.customer_since).toISOString() : null, paused: c.retention_paused, activePrograms: c.active })),
    };
  });
}

/** A person marks a contact as a customer (for example after the sale closes). Programs that start at that moment begin from here, not before. */
export async function markCustomer(ctx: OrgContext, contactId: string): Promise<void> {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "You can't change contacts.");
  await withSystem(async (db) => {
    const res = await db.query("update contacts set lifecycle_stage = 'customer' where id = $1 and org_id = $2 and deleted_at is null and lifecycle_stage not in ('customer', 'retention')", [contactId, ctx.org.orgId]);
    if (!res.rowCount) throw new AppError("conflict", "That contact is already a customer, or can't be found.");
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "contact.marked_customer", targetType: "contact", targetId: contactId, result: "success" }, db);
  });
}

/**
 * Keeps one customer out of every automated program, and stops anything already planned for them. It is a person's own, explicit choice (for example during a dispute): nothing sets
 * it from a rating, a complaint or an escalation. It also stops automatic review asks (a workflow, a program, the API) but never a person pressing Send. The reason a person gives
 * is kept in the audit trail, and the Reviews numbers count the asks it held back, so a pattern of exclusions is visible.
 */
export async function setRetentionPaused(ctx: OrgContext, contactId: string, paused: boolean, reason?: string | null): Promise<void> {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "You can't change contacts.");
  const why = (reason ?? "").replace(/\s+/g, " ").trim();
  if (why.length > 200) throw new AppError("invalid_input", "Keep the reason to 200 characters.");
  await withSystem(async (db) => {
    const res = await db.query("update contacts set retention_paused = $3 where id = $1 and org_id = $2 and deleted_at is null", [contactId, ctx.org.orgId, paused]);
    if (!res.rowCount) throw new AppError("not_found", "Contact not found.");
    let withdrawn = { reviewAsks: 0, reminders: 0 };
    if (paused) {
      await cancelRetention(db, ctx.org.orgId, contactId, "contact_excluded");
      // Anything automatic that is already queued for them goes too, not only what has not been made yet: a review ask waiting for a sending window, an invoice reminder
      // waiting out quiet hours. A person's own message is never one of these.
      withdrawn = {
        reviewAsks: await withdrawAutomaticReviewAsks(db, ctx.org.orgId, contactId),
        reminders: await withdrawQueuedRemindersForContact(db, ctx.org.orgId, contactId),
      };
    }
    await recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: paused ? "contact.retention_paused" : "contact.retention_resumed", targetType: "contact", targetId: contactId, result: "success",
      metadata: { ...(why ? { reason: why } : {}), ...(withdrawn.reviewAsks || withdrawn.reminders ? { withdrawnReviewAsks: withdrawn.reviewAsks, withdrawnReminders: withdrawn.reminders } : {}) },
    }, db);
  });
}

export interface RetentionActivityRow {
  id: string;
  program: string;
  contactName: string;
  step: string;
  status: "scheduled" | "queued" | "sent" | "skipped" | "blocked" | "cancelled";
  delivery: string | null;
  reason: string | null;
  at: string;
}

/** What actually happened to each program message: sent, held and why, or stopped. */
export async function recentActivity(ctx: OrgContext, limit = 30): Promise<RetentionActivityRow[]> {
  if (!ctx.can("retention.view") || !ctx.can("contacts.view")) return [];
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; program: string; name: string; step_key: string; status: RetentionActivityRow["status"]; reason: string | null; updated_at: Date; delivery: string | null }>(
      `select s.id, p.name as program, c.display_name as name, s.step_key, s.status, s.reason, s.updated_at, m.status as delivery
       from retention_steps s join retention_enrollments e on e.id = s.enrollment_id join retention_programs p on p.id = e.program_id join contacts c on c.id = e.contact_id
       left join conversation_messages m on m.id = s.message_id where s.org_id = $1 and s.status <> 'scheduled' order by s.updated_at desc limit $2`,
      [ctx.org.orgId, Math.min(100, limit)],
    );
    return rows.map((r) => ({ id: r.id, program: r.program, contactName: r.name || "Unnamed contact", step: r.step_key, status: r.status, delivery: r.delivery, reason: r.reason, at: new Date(r.updated_at).toISOString() }));
  });
}

/** Finds contacts who are not customers yet, to mark as customers. Row-level security decides which contacts this person may see. */
export async function searchNonCustomers(ctx: OrgContext, query: string): Promise<Array<{ id: string; name: string; detail: string; stage: string }>> {
  if (!ctx.can("contacts.edit")) throw new AppError("forbidden", "You can't change contacts.");
  const q = query.trim().slice(0, 80);
  if (q.length < 2) return [];
  // The search characters of LIKE are plain characters here: "%%" is not "everyone". What is left must still be a real search of two characters.
  const text = q.replace(/[%_\\]/g, "");
  if (text.length < 2) return [];
  // Digits only count as a phone search from three on: two typed letters (no digits at all) must not match every phone number on file.
  const digits = q.replace(/[^0-9+]/g, "");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string; display_name: string; email: string | null; phone: string | null; lifecycle_stage: string }>(
      `select id, display_name, email::text, phone, lifecycle_stage from contacts
       where org_id = $1 and deleted_at is null and lifecycle_stage not in ('customer', 'retention') and (display_name ilike $2 or email::text ilike $2 or phone like $3) order by display_name limit 8`,
      [ctx.org.orgId, `%${text}%`, digits.length >= 3 ? `%${digits}%` : null],
    );
    return rows.map((r) => ({ id: r.id, name: r.display_name || "Unnamed contact", detail: r.phone ? `Phone ending ${r.phone.slice(-3)}` : (r.email ?? "No phone or email"), stage: STAGE_LABEL[r.lifecycle_stage as keyof typeof STAGE_LABEL] ?? r.lifecycle_stage }));
  });
}
