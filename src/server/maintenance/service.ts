import "server-only";
import { z } from "zod";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { notifyAgency, notifyOrgRoles, notifyUser } from "@/server/notifications";
import { createTicket } from "@/server/support/service";
import { applyStatusChange } from "@/server/support/lifecycle";
import type { TicketCore } from "@/server/support/access";
import { canTransition, isActiveStatus, isDoneStatus, type TicketStatus } from "@/lib/support/lifecycle";
import { getMaintenancePlan } from "@/server/catalog/service";
import type { OrgContext } from "@/server/tenancy/context";
import type { SessionUser } from "@/server/auth/service";
import { roleHasPermission } from "@/lib/permissions";
import { MAINTENANCE_TERMS_VERSION, type MaintenanceStatus, type ServiceView } from "@/lib/projects";
import { paidThroughProblem } from "@/lib/automation-studio/plan";
import { MAINTENANCE_PAYMENT_NOTE } from "@/lib/billing-clearance";
import { daysUntil, paidPeriodEnded } from "@/lib/billing-renewal";
import { agencyToday } from "@/server/entitlements";
import { applyVerifiedPayment } from "@/server/maintenance/payment";
import { noticeCancelled, pauseWorkflowsForLapse } from "@/server/maintenance/lapse";
import { iso } from "@/server/projects/shared";

export interface MaintenanceSubscriptionView {
  id: string;
  status: MaintenanceStatus;
  monthlyPriceCents: number;
  currency: string;
  monthlyRequestAllowance: number;
  termsVersion: string;
  acceptedAt: string;
  activatedAt: string | null;
  billingStartOn: string | null;
  renewalOn: string | null;
  cancelRequestedAt: string | null;
}

export interface MaintenanceRequestView {
  id: string;
  ref: string;
  kind: "core_defect" | "managed_change";
  title: string;
  description: string;
  status: string;
  ticketId: string | null;
  countsAgainstAllowance: boolean;
  resolutionNote: string | null;
  createdAt: string;
  closedAt: string | null;
}

export interface MaintenanceOverview {
  eligible: boolean;
  /** Why the plan can't be started yet, in plain language. Null when eligible. */
  eligibilityNote: string | null;
  plan: (ServiceView & { monthlyRequestAllowance: number }) | null;
  subscription: MaintenanceSubscriptionView | null;
  allowance: { total: number; used: number; remaining: number; month: string } | null;
  requests: MaintenanceRequestView[];
}

type SubRow = {
  id: string;
  status: MaintenanceStatus;
  monthly_price_cents: number;
  currency: string;
  monthly_request_allowance: number;
  terms_version: string;
  accepted_at: Date;
  activated_at: Date | null;
  billing_start_on: string | null;
  renewal_on: string | null;
  cancel_requested_at: Date | null;
};

const SUB_COLUMNS = `id, status, monthly_price_cents, currency, monthly_request_allowance, terms_version, accepted_at, activated_at,
  billing_start_on::text as billing_start_on, renewal_on::text as renewal_on, cancel_requested_at`;

/** Next monthly anniversary of the billing start date (display only; nothing is billed by this portal). */
export function nextRenewal(billingStartOn: string | null, today = new Date()): string | null {
  if (!billingStartOn) return null;
  const [y, m, d] = billingStartOn.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  let n = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, Math.min(d, 28)));
  const t = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  while (n.getTime() <= t) n = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + 1, Math.min(d, 28)));
  return n.toISOString().slice(0, 10);
}

const toSub = (r: SubRow): MaintenanceSubscriptionView => ({
  id: r.id,
  status: r.status,
  monthlyPriceCents: r.monthly_price_cents,
  currency: r.currency,
  monthlyRequestAllowance: r.monthly_request_allowance,
  termsVersion: r.terms_version,
  acceptedAt: iso(r.accepted_at)!,
  activatedAt: iso(r.activated_at),
  billingStartOn: r.billing_start_on,
  renewalOn: r.renewal_on ?? nextRenewal(r.billing_start_on),
  cancelRequestedAt: iso(r.cancel_requested_at),
});

/**
 * Eligibility begins only after the core system is fully set up, verified and activated by iAcquire, and the setup payment is confirmed (paid or waived). The two paid
 * products are linked: a plan is never started for a client that never paid for, or was never waived from, the setup.
 */
export async function maintenanceEligibility(orgId: string): Promise<{ eligible: boolean; note: string | null }> {
  const { rows } = await withSystem((db) =>
    db.query<{ kind: string; state: string | null; cleared: boolean }>(
      "select o.kind, (select i.state from client_setup_instances i where i.org_id = o.id) as state, app.setup_payment_cleared(o.id) as cleared from organizations o where o.id = $1",
      [orgId],
    ),
  );
  const r = rows[0];
  if (!r || r.kind !== "client") return { eligible: false, note: "Managed maintenance is for client workspaces." };
  if (r.state !== "activated") return { eligible: false, note: "Maintenance becomes available after your core iAcquire system has been fully set up, verified and activated. You don't need it to use what's already included." };
  if (r.cleared !== true) return { eligible: false, note: MAINTENANCE_PAYMENT_NOTE };
  return { eligible: true, note: null };
}

export async function getMaintenanceOverview(ctx: OrgContext): Promise<MaintenanceOverview> {
  const [plan, elig, data] = await Promise.all([
    getMaintenancePlan(ctx.user.id),
    maintenanceEligibility(ctx.org.orgId),
    withUser(ctx.user.id, async (db) => {
      const sub = (await db.query<SubRow>(`select ${SUB_COLUMNS} from maintenance_subscriptions where org_id = $1 order by (status in ('requested','active','past_due','cancel_requested')) desc, created_at desc limit 1`, [ctx.org.orgId])).rows[0];
      const reqs = (await db.query<{ id: string; ref: string; kind: "core_defect" | "managed_change"; title: string; description: string; status: string; ticket_id: string | null; counts_against_allowance: boolean; resolution_note: string | null; created_at: Date; closed_at: Date | null }>(
        "select id, ref, kind, title, description, status, ticket_id, counts_against_allowance, resolution_note, created_at, closed_at from maintenance_requests where org_id = $1 order by created_at desc limit 100",
        [ctx.org.orgId],
      )).rows;
      const used = sub && ["active", "past_due", "cancel_requested"].includes(sub.status)
        ? (await db.query<{ n: number }>("select count(*)::int as n from maintenance_requests where subscription_id = $1 and kind = 'managed_change' and counts_against_allowance and status <> 'declined' and period_month = date_trunc('month', now())::date", [sub.id])).rows[0]?.n ?? 0
        : 0;
      return { sub, reqs, used };
    }),
  ]);
  const sub = data.sub ? toSub(data.sub) : null;
  const active = sub && ["active", "past_due", "cancel_requested"].includes(sub.status);
  return {
    eligible: elig.eligible,
    eligibilityNote: elig.note,
    plan,
    subscription: sub,
    allowance: active && sub ? { total: sub.monthlyRequestAllowance, used: data.used, remaining: Math.max(0, sub.monthlyRequestAllowance - data.used), month: new Date().toISOString().slice(0, 7) } : null,
    requests: data.reqs.map((r) => ({ id: r.id, ref: r.ref, kind: r.kind, title: r.title, description: r.description, status: r.status, ticketId: r.ticket_id, countsAgainstAllowance: r.counts_against_allowance, resolutionNote: r.resolution_note, createdAt: iso(r.created_at)!, closedAt: iso(r.closed_at) })),
  };
}

/**
 * This month's managed-request allowance, or null when the workspace has no active plan (or the person may not see it). Request a Change shows it so a client knows what
 * their plan covers. The number is the plan's own setting, read as it was accepted; nothing is assumed for a workspace without one.
 */
export async function getMaintenanceAllowance(ctx: OrgContext): Promise<NonNullable<MaintenanceOverview["allowance"]> | null> {
  return withUser(ctx.user.id, async (db) => {
    const sub = (await db.query<{ id: string; monthly_request_allowance: number }>(
      "select id, monthly_request_allowance from maintenance_subscriptions where org_id = $1 and status in ('active','past_due','cancel_requested') order by created_at desc limit 1", [ctx.org.orgId],
    )).rows[0];
    if (!sub) return null;
    const used = (await db.query<{ n: number }>("select count(*)::int as n from maintenance_requests where subscription_id = $1 and kind = 'managed_change' and counts_against_allowance and status <> 'declined' and period_month = date_trunc('month', now())::date", [sub.id])).rows[0]?.n ?? 0;
    return { total: sub.monthly_request_allowance, used, remaining: Math.max(0, sub.monthly_request_allowance - used), month: new Date().toISOString().slice(0, 7) };
  });
}

/** The client explicitly accepts the plan's terms. Nothing is billed here: billing starts only once iAcquire activates the plan. */
export async function requestMaintenanceEnrollment(ctx: OrgContext, input: { acceptTerms: boolean; note?: string }) {
  if (!ctx.can("maintenance.manage_plan")) throw new AppError("forbidden", "Only a workspace owner can enroll in managed maintenance.");
  if (!input.acceptTerms) throw new AppError("invalid_input", "Confirm that you've read the plan's scope and price.");
  const elig = await maintenanceEligibility(ctx.org.orgId);
  if (!elig.eligible) throw new AppError("conflict", elig.note ?? "Managed maintenance isn't available yet.");
  const plan = await getMaintenancePlan(ctx.user.id);
  if (!plan || !plan.price || plan.price.minCents === null) throw new AppError("integration_unavailable", "The maintenance plan isn't published right now.");
  const note = (input.note ?? "").trim().slice(0, 1000) || null;
  const priceCents = plan.price.minCents;
  const currency = plan.price.currency;
  const allowance = plan.monthlyRequestAllowance;
  await withSystem(async (db) => {
    const open = await db.query("select 1 from maintenance_subscriptions where org_id = $1 and status in ('requested','active','past_due','cancel_requested')", [ctx.org.orgId]);
    if (open.rows[0]) throw new AppError("conflict", "You already have a maintenance request or plan.");
    await db.query(
      `insert into maintenance_subscriptions (org_id, plan_service_id, status, monthly_price_cents, currency, monthly_request_allowance, terms_version, accepted_by, request_note)
       values ($1,$2,'requested',$3,$4,$5,$6,$7,$8)`,
      [ctx.org.orgId, plan.id, priceCents, currency, allowance, MAINTENANCE_TERMS_VERSION, ctx.user.id, note],
    );
    await notifyAgency(db, ctx.org.orgId, { kind: "maintenance_update", title: `${ctx.org.name} requested managed maintenance`, body: "Review and activate to start the plan.", link: "/admin/maintenance" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "maintenance.enrollment_requested", targetType: "maintenance_subscription", result: "success", metadata: { priceCents, allowance, terms: MAINTENANCE_TERMS_VERSION } }, db);
  });
}

export async function requestMaintenanceCancellation(ctx: OrgContext, note?: string) {
  if (!ctx.can("maintenance.manage_plan")) throw new AppError("forbidden", "Only a workspace owner can change the maintenance plan.");
  const clean = (note ?? "").trim().slice(0, 1000) || null;
  await withSystem(async (db) => {
    const s = (await db.query<{ id: string; status: string }>("select id, status from maintenance_subscriptions where org_id = $1 and status in ('requested','active','past_due') for update", [ctx.org.orgId])).rows[0];
    if (!s) throw new AppError("not_found", "There's no plan to cancel.");
    if (s.status === "requested" || s.status === "past_due") {
      // Never activated, or already unpaid (it would expire when its grace period ends): nothing more will be billed, so end it outright.
      await db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now(), cancel_note = $2, cancel_requested_by = $3, cancel_requested_at = now() where id = $1", [s.id, clean, ctx.user.id]);
      // An unpaid plan that ends is a lapse like any other: its Automation Studio workflows are paused now, not at the next sweep. A plan that was only requested has none.
      if (s.status === "past_due") await pauseWorkflowsForLapse(db, ctx.org.orgId);
    } else {
      await db.query("update maintenance_subscriptions set status = 'cancel_requested', cancel_note = $2, cancel_requested_by = $3, cancel_requested_at = now() where id = $1", [s.id, clean, ctx.user.id]);
    }
    await notifyAgency(db, ctx.org.orgId, { kind: "maintenance_update", severity: "warning", title: `${ctx.org.name} ${s.status === "active" ? "requested to cancel" : "withdrew"} managed maintenance`, link: "/admin/maintenance" });
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "maintenance.cancellation_requested", targetType: "maintenance_subscription", targetId: s.id, result: "success" }, db);
  });
}

export const maintenanceRequestSchema = z.object({
  kind: z.enum(["core_defect", "managed_change"]),
  title: z.string().trim().min(3, "Add a short title.").max(160),
  description: z.string().trim().min(10, "Tell us a little more.").max(4000),
});

/**
 * Core defects need no plan and never use the allowance. Managed changes need an active plan and
 * count against this month's request allowance. Both land in the existing agency support inbox.
 */
export async function createMaintenanceRequest(ctx: OrgContext, input: z.input<typeof maintenanceRequestSchema>) {
  if (!ctx.can("maintenance.request")) throw new AppError("forbidden", "Your role can't open maintenance requests.");
  const d = maintenanceRequestSchema.parse(input);
  const limit = await consumeRateLimit(RATE_LIMITS.maintenanceByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "You've sent several requests recently. Please add to an existing one.");
  // The slot is taken first, in one transaction under a lock on the plan's row: two requests made together are counted one after the other, so the
  // plan's allowance (its own setting, never a constant here) cannot be passed. The ticket follows; if it cannot be made the slot is given back.
  const reserved = await withSystem(async (db) => {
    let subscriptionId: string | null = null;
    if (d.kind === "managed_change") {
      const s = (await db.query<{ id: string; monthly_request_allowance: number }>("select id, monthly_request_allowance from maintenance_subscriptions where org_id = $1 and status in ('active','past_due','cancel_requested') for update", [ctx.org.orgId])).rows[0];
      if (!s) throw new AppError("conflict", "Managed maintenance requests need an active maintenance plan. Basic help is always available through Support.");
      const n = (await db.query<{ n: number }>("select count(*)::int as n from maintenance_requests where subscription_id = $1 and kind = 'managed_change' and counts_against_allowance and status <> 'declined' and period_month = date_trunc('month', now())::date", [s.id])).rows[0]?.n ?? 0;
      if (n >= s.monthly_request_allowance) throw new AppError("conflict", `You've used all ${s.monthly_request_allowance} maintenance requests for this month. Larger changes can be quoted as a custom project.`);
      subscriptionId = s.id;
    }
    const r = await db.query<{ id: string; ref: string }>(
      "insert into maintenance_requests (org_id, subscription_id, kind, title, description, counts_against_allowance, created_by) values ($1,$2,$3,$4,$5,$6,$7) returning id, ref",
      [ctx.org.orgId, subscriptionId, d.kind, d.title, d.description, d.kind === "managed_change", ctx.user.id],
    );
    return r.rows[0];
  });
  let ticket: Awaited<ReturnType<typeof createTicket>>;
  try {
    // A defect in the original setup is an issue report, so the Issue reports view and the analytics find it. A managed change is an ordinary request.
    ticket = await createTicket(ctx, d.kind === "core_defect"
      ? { requestType: "issue", subject: `Defect report: ${d.title}`.slice(0, 160), message: d.description, category: "feature_not_working", priority: "normal" }
      : { subject: `Maintenance request: ${d.title}`.slice(0, 160), message: d.description, category: "maintenance", priority: "normal" });
  } catch (error) {
    await withSystem((db) => db.query("delete from maintenance_requests where id = $1", [reserved.id])).catch(() => undefined);
    throw error;
  }
  return withSystem(async (db) => {
    await db.query("update maintenance_requests set ticket_id = $2 where id = $1", [reserved.id, ticket.id]);
    await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "maintenance.request_created", targetType: "maintenance_request", targetId: reserved.id, result: "success", metadata: { kind: d.kind, ref: reserved.ref } }, db);
    return { id: reserved.id, ref: reserved.ref, ticketId: ticket.id };
  });
}

/** The ticket status a maintenance status stands for. */
const TICKET_STATUS_FOR = { open: "open", in_progress: "in_progress", waiting_for_client: "waiting_for_client", completed: "resolved", declined: "closed" } as const;

/**
 * Keeps the request's ticket in step with the maintenance record, through the one place a request changes status. It is quiet (no thread line, no second
 * notice: the maintenance update already tells the owner), and it never fails the maintenance update: a ticket the team already closed is left as it is.
 */
async function mirrorOntoTicket(db: Queryable, ticketId: string, target: TicketStatus, userId: string) {
  const read = async () => (await db.query<TicketCore>(
    `select id, ref, org_id, created_by, subject, request_type, category, status, priority, assigned_to, feedback_stage, first_responded_at, resolved_at, reopened_count
     from support_tickets where id = $1 for update`, [ticketId],
  )).rows[0];
  const cur = await read();
  if (!cur || cur.status === target) return;
  const actor = { userId, kind: "agency" as const };
  if (isDoneStatus(cur.status) && isActiveStatus(target)) {
    // Work resumed on a finished request: it comes back through "open", the one move the lifecycle allows from there.
    await applyStatusChange(db, cur, "open", actor, { silent: true });
    const reread = await read();
    if (reread && target !== "open" && canTransition("open", target)) await applyStatusChange(db, reread, target, actor, { silent: true });
    return;
  }
  if (!canTransition(cur.status, target)) return;
  await applyStatusChange(db, cur, target, actor, { silent: true });
}

// ---------------------------------------------------------------------------
// Agency
// ---------------------------------------------------------------------------

export function assertManage(user: SessionUser) {
  if (user.platformRole === "none" || !roleHasPermission(user.platformRole, "maintenance.manage")) throw new AppError("forbidden", "Agency access is required.");
}

export interface AgencyMaintenanceRow {
  subscription: (MaintenanceSubscriptionView & { orgId: string; orgName: string; used: number; requestNote: string | null; cancelNote: string | null; eligible: boolean }) | null;
}

export async function listAgencyMaintenance(user: SessionUser) {
  assertManage(user);
  return withSystem(async (db) => {
    const subs = (await db.query<SubRow & {
      org_id: string; org_name: string; request_note: string | null; cancel_note: string | null; internal_notes: string | null; state: string | null; cleared: boolean; used: number;
      past_due_since: Date | null; grace_ends_at: Date | null; expired_at: Date | null; paid_through_on: string | null; last_payment_verified_at: Date | null; verified_by_name: string | null;
      studio_workflows: number; studio_paused: number;
    }>(
      `select s.id, s.status, s.monthly_price_cents, s.currency, s.monthly_request_allowance, s.terms_version, s.accepted_at, s.activated_at,
         s.billing_start_on::text as billing_start_on, s.renewal_on::text as renewal_on, s.cancel_requested_at,
         s.org_id, o.name as org_name, s.request_note, s.cancel_note, s.internal_notes,
         s.past_due_since, s.grace_ends_at, s.expired_at, s.paid_through_on::text as paid_through_on, s.last_payment_verified_at,
         (select coalesce(nullif(u.full_name, ''), u.email::text) from users u where u.id = s.last_payment_verified_by) as verified_by_name,
         (select count(*)::int from crm_workflows w where w.org_id = s.org_id and w.origin = 'studio' and w.status <> 'archived') as studio_workflows,
         (select count(*)::int from crm_workflows w where w.org_id = s.org_id and w.status = 'paused' and w.entitlement_paused_at is not null) as studio_paused,
         (select i.state from client_setup_instances i where i.org_id = s.org_id) as state, app.setup_payment_cleared(s.org_id) as cleared,
         (select count(*)::int from maintenance_requests m where m.subscription_id = s.id and m.kind = 'managed_change' and m.counts_against_allowance and m.status <> 'declined' and m.period_month = date_trunc('month', now())::date) as used
       from maintenance_subscriptions s join organizations o on o.id = s.org_id
       where (s.status in ('requested','active','past_due','cancel_requested')
              or (s.status = 'expired' and s.expired_at > now() - interval '180 days'
                  and not exists (select 1 from maintenance_subscriptions n where n.org_id = s.org_id and n.id <> s.id and n.status in ('requested','active','past_due','cancel_requested'))))
         and app.user_can_access_org($1,s.org_id)
       order by case s.status when 'requested' then 0 when 'past_due' then 1 when 'cancel_requested' then 2 when 'active' then 3 else 4 end, o.name`,
      [user.id],
    )).rows;
    const reqs = (await db.query<{ id: string; ref: string; kind: string; title: string; description: string; status: string; counts_against_allowance: boolean; org_id: string; org_name: string; ticket_id: string | null; created_at: Date; internal_notes: string | null }>(
      `select m.id, m.ref, m.kind, m.title, m.description, m.status, m.counts_against_allowance, m.org_id, o.name as org_name, m.ticket_id, m.created_at, m.internal_notes
       from maintenance_requests m join organizations o on o.id = m.org_id
       where m.status not in ('completed','declined') and app.user_can_access_org($1,m.org_id)
       order by m.created_at desc limit 200`,
      [user.id],
    )).rows;
    // The paid-through day is the agency's own day, so "ended N days ago" is counted in the agency's time zone.
    const today = await agencyToday(db);
    return {
      subscriptions: subs.map((s) => ({
        ...toSub(s), orgId: s.org_id, orgName: s.org_name, used: s.used, requestNote: s.request_note, cancelNote: s.cancel_note, eligible: s.state === "activated" && s.cleared === true,
        // Which of the two conditions holds the plan back, so the agency is sent to the right place (the setup, or the client's billing tab).
        blockedBy: s.state !== "activated" ? ("setup" as const) : s.cleared !== true ? ("setup_payment" as const) : null,
        // What the agency needs to run the plan: where the money side stands (as recorded by people, never detected) and what a lapse would touch.
        lifecycle: {
          pastDueSince: iso(s.past_due_since), graceEndsAt: iso(s.grace_ends_at), expiredAt: iso(s.expired_at), paidThroughOn: s.paid_through_on,
          lastPaymentVerifiedAt: iso(s.last_payment_verified_at), lastPaymentVerifiedBy: s.verified_by_name, studioWorkflows: s.studio_workflows, studioPaused: s.studio_paused,
          // Days since the day the plan was paid through, while it is still running and nobody has recorded a payment since (information only: nothing changes by itself).
          periodEndedDaysAgo: paidPeriodEnded(s.status, s.paid_through_on, today) ? -(daysUntil(s.paid_through_on, today) ?? 0) : null,
        },
      })),
      requests: reqs.map((r) => ({ id: r.id, ref: r.ref, kind: r.kind as "core_defect" | "managed_change", title: r.title, description: r.description, status: r.status, countsAgainstAllowance: r.counts_against_allowance, orgId: r.org_id, orgName: r.org_name, ticketId: r.ticket_id, createdAt: iso(r.created_at)!, internalNotes: r.internal_notes })),
    };
  });
}

export async function subscriptionForAgency(db: Parameters<Parameters<typeof withSystem>[0]>[0], user: SessionUser, id: string) {
  const s = (await db.query<{ id: string; org_id: string; status: string }>("select id, org_id, status from maintenance_subscriptions where id = $1 for update", [id])).rows[0];
  const ok = s && (await db.query<{ allowed: boolean }>("select app.user_can_access_org($1,$2) as allowed", [user.id, s.org_id])).rows[0]?.allowed === true;
  if (!s || !ok) throw new AppError("not_found", "Maintenance plan not found.");
  return s;
}

/**
 * What a person confirms before a plan starts: they checked, in their own billing records, that the payment arrived, and the date it pays for.
 * iAcquire doesn't charge cards or detect payments, so a plan never starts on a click alone.
 */
export interface ActivationPayment {
  verified: boolean;
  paidThroughOn: string;
}

/**
 * Activation is agency-confirmed. It re-checks that the core system is activated and that the person who activates has verified the payment (recorded
 * with who and when, like any later payment: see recordVerifiedPayment). It never charges anything.
 */
export async function activateMaintenance(user: SessionUser, subscriptionId: string, opts: { billingStartOn?: string; payment: ActivationPayment }) {
  assertManage(user);
  const start = opts.billingStartOn ?? new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) throw new AppError("invalid_input", "Use a valid billing start date.");
  if (opts.payment?.verified !== true) throw new AppError("invalid_input", "Confirm that you verified the payment in your billing records before the plan starts.");
  const problem = paidThroughProblem(opts.payment.paidThroughOn);
  if (problem) throw new AppError("invalid_input", problem);
  await withSystem(async (db) => {
    const s = await subscriptionForAgency(db, user, subscriptionId);
    await applyVerifiedPayment(db, { subscription: s, mode: "activate", actor: { kind: "agency", userId: user.id }, billingStartOn: start, paidThroughOn: opts.payment.paidThroughOn });
  });
}

export async function resolveMaintenanceSubscription(user: SessionUser, subscriptionId: string, action: "decline" | "confirm_cancellation") {
  assertManage(user);
  await withSystem(async (db) => {
    const s = await subscriptionForAgency(db, user, subscriptionId);
    let pausedWorkflows = 0;
    if (action === "decline") {
      if (s.status !== "requested") throw new AppError("conflict", "Only a requested plan can be declined.");
      await db.query("update maintenance_subscriptions set status = 'declined' where id = $1", [subscriptionId]);
      await notifyOrgRoles(db, s.org_id, ["owner"], { kind: "maintenance_update", title: "Your maintenance request wasn't activated", link: "/maintenance" });
    } else {
      if (s.status !== "cancel_requested") throw new AppError("conflict", "There is no cancellation to confirm.");
      await db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where id = $1", [subscriptionId]);
      // The plan has ended, so its Automation Studio workflows are paused now, exactly as when it expires, and the owner is told what that means. Without this they would keep
      // showing as switched on until the scheduler's sweep (which has never run in production) found them; the engine refuses their runs either way.
      pausedWorkflows = await pauseWorkflowsForLapse(db, s.org_id);
      await noticeCancelled(db, s.org_id, subscriptionId);
    }
    await recordAudit({ orgId: s.org_id, actorUserId: user.id, actorKind: "agency", action: `maintenance.${action}`, targetType: "maintenance_subscription", targetId: subscriptionId, result: "success", ...(action === "confirm_cancellation" ? { metadata: { pausedWorkflows } } : {}) }, db);
  });
}

export async function updateMaintenanceRequest(user: SessionUser, requestId: string, changes: { status?: "open" | "in_progress" | "waiting_for_client" | "completed" | "declined"; resolutionNote?: string; waiveAllowance?: boolean; internalNotes?: string }) {
  assertManage(user);
  const d = z.object({ status: z.enum(["open", "in_progress", "waiting_for_client", "completed", "declined"]).optional(), resolutionNote: z.string().trim().max(2000).optional(), waiveAllowance: z.boolean().optional(), internalNotes: z.string().trim().max(4000).optional() }).parse(changes);
  await withSystem(async (db) => {
    const m = (await db.query<{ org_id: string; kind: string; title: string; ref: string; ticket_id: string | null }>("select org_id, kind, title, ref, ticket_id from maintenance_requests where id = $1 for update", [requestId])).rows[0];
    const ok = m && (await db.query<{ allowed: boolean }>("select app.user_can_access_org($1,$2) as allowed", [user.id, m.org_id])).rows[0]?.allowed === true;
    if (!m || !ok) throw new AppError("not_found", "Request not found.");
    if (d.waiveAllowance && m.kind !== "managed_change") throw new AppError("conflict", "Only managed requests use the allowance.");
    await db.query(
      `update maintenance_requests set status = coalesce($2, status), resolution_note = coalesce($3, resolution_note), internal_notes = coalesce($4, internal_notes),
         counts_against_allowance = case when $5::boolean then false else counts_against_allowance end,
         closed_at = case when $2 in ('completed','declined') then now() when $2 is not null then null else closed_at end where id = $1`,
      [requestId, d.status ?? null, d.resolutionNote ?? null, d.internalNotes ?? null, Boolean(d.waiveAllowance)],
    );
    if (d.status && m.ticket_id) await mirrorOntoTicket(db, m.ticket_id, TICKET_STATUS_FOR[d.status], user.id);
    if (d.status && ["completed", "declined", "in_progress"].includes(d.status)) {
      await notifyOrgRoles(db, m.org_id, ["owner", "admin"], { kind: "maintenance_update", title: `${m.ref} is now ${d.status.replace("_", " ")}`, body: m.title, link: "/maintenance" });
    }
    await recordAudit({ orgId: m.org_id, actorUserId: user.id, actorKind: "agency", action: "maintenance.request_updated", targetType: "maintenance_request", targetId: requestId, result: "success", metadata: { status: d.status, waived: d.waiveAllowance } }, db);
  });
}

/**
 * Gives a maintenance request to a team member, or takes it away. This replaces the silent claim updateMaintenanceRequest used to make: touching a request no longer makes the
 * person its owner, so nobody's workload moves unless someone chose it. The person must be an active agency account that can open the client and may operate maintenance.
 * Giving it to the person who already has it changes nothing and announces nothing (a double click, a retry).
 */
export async function assignMaintenanceRequest(user: SessionUser, requestId: string, assigneeId: string | null) {
  assertManage(user);
  const id = z.string().uuid();
  if (!id.safeParse(requestId).success) throw new AppError("not_found", "Request not found.");
  if (assigneeId !== null && !id.safeParse(assigneeId).success) throw new AppError("invalid_input", "Choose a team member.");
  await withSystem(async (db) => {
    // The session names who the person is; the database says whether they still are, and whether they still may.
    const me = (await db.query<{ ok: boolean }>(
      "select (status = 'active' and platform_role = $2 and coalesce(app.user_has_agency_permission(id, 'maintenance.manage'), false)) as ok from users where id = $1", [user.id, user.platformRole],
    )).rows[0];
    if (!me?.ok) throw new AppError("forbidden", "Agency access is required; authorization has changed.");
    const m = (await db.query<{ org_id: string; ref: string; title: string; status: string; assigned_to: string | null }>("select org_id, ref, title, status, assigned_to from maintenance_requests where id = $1 for update", [requestId])).rows[0];
    const reach = m && (await db.query<{ allowed: boolean }>("select app.user_can_access_org($1, $2) as allowed", [user.id, m.org_id])).rows[0]?.allowed === true;
    if (!m || !reach) throw new AppError("not_found", "Request not found.");
    if (!["open", "in_progress", "waiting_for_client"].includes(m.status)) throw new AppError("conflict", "A request that is finished cannot be given to someone.");
    if (assigneeId) {
      const eligible = (await db.query<{ ok: boolean }>(
        `select exists (select 1 from users u where u.id = $1 and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
           and app.user_can_access_org(u.id, $2) and coalesce(app.user_has_agency_permission(u.id, 'maintenance.manage'), false)) as ok`, [assigneeId, m.org_id],
      )).rows[0]?.ok === true;
      if (!eligible) throw new AppError("invalid_input", "Choose a team member who works on this client's maintenance.");
    }
    const changed = await db.query<{ updated_at: Date }>("update maintenance_requests set assigned_to = $2 where id = $1 and assigned_to is distinct from $2 returning updated_at", [requestId, assigneeId]);
    if (!changed.rows[0]) return;
    // The moment of the change names this assignment, so handing it back and forth is announced each time and only once each.
    if (assigneeId && assigneeId !== user.id) {
      await notifyUser(db, assigneeId, m.org_id, { kind: "maintenance_update", title: `${m.ref} was assigned to you`, body: m.title, link: "/admin/maintenance", dedupeKey: `maintenance:${requestId}:assigned:${assigneeId}:${new Date(changed.rows[0].updated_at).getTime()}` });
    }
    await recordAudit({ orgId: m.org_id, actorUserId: user.id, actorKind: "agency", action: assigneeId ? "maintenance.assigned" : "maintenance.unassigned", targetType: "maintenance_request", targetId: requestId, result: "success", metadata: { from: m.assigned_to, to: assigneeId } }, db);
  });
}
