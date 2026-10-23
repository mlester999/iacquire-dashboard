import "server-only";
import { z } from "zod";
import { withSystem, type Queryable } from "@/server/db";
import { env } from "@/server/env";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { cancelRetention } from "@/server/retention/cancel";
import { releaseReservation } from "@/server/billing/ledger";
import { disconnectIntegration } from "@/server/integrations/manager";
import { disconnectWorkspaceAccounts } from "@/server/social/accounts";
import { removeStoredObjectTrusted, type PrivateBucket } from "@/server/storage/private";
import type { SessionUser } from "@/server/auth/service";
import type { OrgContext } from "@/server/tenancy/context";

export const MIN_RETENTION_DAYS = 30;
export const DEFAULT_RETENTION_DAYS = 90;

/**
 * Records that survive a client's departure: money (payments, the credit ledger, usage and fees), the audit trail, the offboarding record
 * itself, and the agency's own books. Everything else that carries the client's data is purged, and nothing in this list is ever touched.
 */
export const PURGE_RETAINS = new Set([
  "audit_logs", "payments", "credit_accounts", "credit_ledger_entries", "metered_usage_events", "usage_reservations", "provider_fees", "billing_accounts", "billing_settings",
  "offboarding_requests", "offboarding_events", "account_activity_reviews", "agency_finance_entries", "incidents", "incident_events", "organization_memberships", "staff_assignments",
]);

type Status = "requested" | "shutdown" | "retention" | "deleted" | "cancelled";

interface RequestRow {
  id: string;
  org_id: string;
  status: Status;
  requested_by: string | null;
  requested_by_kind: "client" | "agency";
  reason: string | null;
  requested_at: Date;
  retention_days: number;
  website_plan: "keep_until_deletion" | "unpublish_now";
  credit_balance_micros: string | null;
  billing_closed_at: Date | null;
  billing_note: string | null;
  export_downloaded_at: Date | null;
  shutdown_at: Date | null;
  delete_after: Date | null;
  deleted_at: Date | null;
  cancelled_at: Date | null;
}

export interface OffboardingStep {
  key: string;
  ok: boolean;
  text: string;
}

export interface OffboardingView {
  id: string;
  orgId: string;
  status: Status;
  requestedAt: string;
  requestedByKind: "client" | "agency";
  reason: string | null;
  retentionDays: number;
  websitePlan: "keep_until_deletion" | "unpublish_now";
  deleteAfter: string | null;
  exportDownloadedAt: string | null;
  billingClosedAt: string | null;
  shutdownAt: string | null;
  creditBalanceMicros: number | null;
  steps: OffboardingStep[];
  timeline: Array<{ kind: string; detail: string | null; at: string }>;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

async function addEvent(db: Queryable, requestId: string, orgId: string, kind: string, detail: string | null, actor: string | null = null) {
  await db.query("insert into offboarding_events (request_id, org_id, kind, detail, actor_user_id) values ($1, $2, $3, $4, $5)", [requestId, orgId, kind, detail?.slice(0, 600) ?? null, actor]);
}

async function toView(db: Queryable, r: RequestRow): Promise<OffboardingView> {
  const events = await db.query<{ kind: string; detail: string | null; created_at: Date }>("select kind, detail, created_at from offboarding_events where request_id = $1 order by seq", [r.id]);
  const steps: OffboardingStep[] = [];
  for (const e of events.rows) {
    if (e.kind !== "shutdown_step" || !e.detail) continue;
    try {
      const p = JSON.parse(e.detail) as { k: string; ok: boolean; t: string };
      steps.push({ key: p.k, ok: p.ok, text: p.t });
    } catch {
      /* ignore malformed */
    }
  }
  return {
    id: r.id, orgId: r.org_id, status: r.status, requestedAt: iso(r.requested_at)!, requestedByKind: r.requested_by_kind, reason: r.reason, retentionDays: r.retention_days, websitePlan: r.website_plan,
    deleteAfter: iso(r.delete_after), exportDownloadedAt: iso(r.export_downloaded_at), billingClosedAt: iso(r.billing_closed_at), shutdownAt: iso(r.shutdown_at),
    creditBalanceMicros: r.credit_balance_micros === null ? null : Number(r.credit_balance_micros), steps,
    timeline: events.rows.filter((e) => e.kind !== "shutdown_step").map((e) => ({ kind: e.kind, detail: e.detail, at: iso(e.created_at)! })),
  };
}

const ACTIVE = "('requested', 'shutdown', 'retention')";

/** The workspace's current or most recent offboarding, for the owner (or agency staff assigned to it). */
export async function getOffboarding(orgId: string): Promise<OffboardingView | null> {
  return withSystem(async (db) => {
    const { rows } = await db.query<RequestRow>("select * from offboarding_requests where org_id = $1 order by requested_at desc limit 1", [orgId]);
    return rows[0] ? toView(db, rows[0]) : null;
  });
}

export async function getOffboardingForOwner(ctx: OrgContext): Promise<OffboardingView | null> {
  if (!ctx.can("offboarding.view")) return null;
  return getOffboarding(ctx.org.orgId);
}

/**
 * The owner asks to leave. Nothing is switched off by asking: they keep everything while they take their data, and they can change their mind.
 * They must type the workspace name, so a stray click can never start it.
 */
export async function requestOffboarding(ctx: OrgContext, input: { reason?: string; confirmName: string }): Promise<OffboardingView> {
  if (!ctx.can("offboarding.request")) throw new AppError("forbidden", "Only the business owner can ask to close the workspace.");
  if (input.confirmName.trim().toLowerCase() !== ctx.org.name.trim().toLowerCase()) throw new AppError("invalid_input", "Type your workspace name exactly to confirm.");
  return create(ctx.org.orgId, "client", ctx.user.id, input.reason ?? null);
}

export async function requestOffboardingAsAgency(user: Pick<SessionUser, "id" | "platformRole">, orgId: string, reason: string | null): Promise<OffboardingView> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can start offboarding for a client.");
  return create(orgId, "agency", user.id, reason);
}

async function create(orgId: string, kind: "client" | "agency", userId: string, reason: string | null): Promise<OffboardingView> {
  return withSystem(async (db) => {
    const org = (await db.query<{ name: string; kind: string }>("select name, kind from organizations where id = $1", [orgId])).rows[0];
    if (!org || org.kind !== "client") throw new AppError("not_found", "Workspace not found.");
    const dup = await db.query(`select 1 from offboarding_requests where org_id = $1 and status in ${ACTIVE}`, [orgId]);
    if (dup.rows[0]) throw new AppError("conflict", "Closing this workspace has already been requested.");
    const { rows } = await db.query<RequestRow>("insert into offboarding_requests (org_id, requested_by, requested_by_kind, reason) values ($1, $2, $3, $4) returning *", [orgId, userId, kind, reason?.trim().slice(0, 500) || null]);
    const r = rows[0];
    await addEvent(db, r.id, orgId, "requested", kind === "client" ? "The owner asked to close the workspace." : "iAcquire started closing the workspace.", userId);
    await db.query("update account_activity_reviews set status = 'offboarding', closed_at = now(), closed_note = 'Offboarding started.' where org_id = $1 and status = 'open'", [orgId]);
    await recordAudit({ orgId, actorUserId: userId, actorKind: kind === "client" ? "user" : "agency", action: "offboarding.requested", targetType: "offboarding_request", targetId: r.id, result: "success" }, db);
    await notifyOrgRoles(db, orgId, ["owner"], {
      kind: "offboarding_update", severity: "info", title: "We've received your request to close your workspace",
      body: "Nothing has been switched off. Download your data any time from Settings → Your data, and tell us if you change your mind.", link: "/settings/data", dedupeKey: `offboarding:${r.id}:requested`,
    });
    await notifyAgency(db, orgId, { kind: "offboarding_update", severity: "warning", title: `${org.name} asked to leave`, body: kind === "client" ? "Review the plan, make sure they can take their data and domains, then shut down." : "Offboarding was started by the agency.", link: `/admin/clients/${orgId}`, dedupeKey: `offboarding-agency:${r.id}` });
    return toView(db, r);
  });
}

/** Changing their mind. While nothing has been shut down this simply cancels; afterwards an agency super admin reverses it. */
export async function cancelOffboarding(actor: { user: Pick<SessionUser, "id" | "platformRole">; orgId: string; viaOwner: boolean }, note: string): Promise<void> {
  const why = note.trim().slice(0, 300) || "Cancelled.";
  await withSystem(async (db) => {
    const r = (await db.query<RequestRow>(`select * from offboarding_requests where org_id = $1 and status in ${ACTIVE} for update`, [actor.orgId])).rows[0];
    if (!r) throw new AppError("not_found", "There's no closing request to cancel.");
    if (actor.viaOwner && r.status !== "requested") throw new AppError("forbidden", "The workspace has already been closed down. Ask iAcquire to bring it back.");
    if (!actor.viaOwner && actor.user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can cancel this.");
    await db.query("update offboarding_requests set status = 'cancelled', cancelled_at = now(), cancelled_by = $2, cancel_note = $3 where id = $1", [r.id, actor.user.id, why]);
    if (r.status !== "requested") {
      // Bring back what shutdown stopped: the agency pause, and the messaging and outbound pauses it set. Staff access and message channels
      // are re-enabled by the owner on purpose, so nothing starts talking to customers again by surprise.
      await db.query("update automation_pauses set active = false where org_id = $1 and active", [actor.orgId]);
    }
    await addEvent(db, r.id, actor.orgId, "cancelled", why, actor.user.id);
    await recordAudit({ orgId: actor.orgId, actorUserId: actor.user.id, actorKind: actor.viaOwner ? "user" : "agency", action: "offboarding.cancelled", targetType: "offboarding_request", targetId: r.id, result: "success" }, db);
    await notifyOrgRoles(db, actor.orgId, ["owner"], { kind: "offboarding_update", severity: "success", title: "Closing your workspace was cancelled", body: r.status === "requested" ? "Nothing changed." : "Automation stays paused until you switch it back on in Settings. Re-invite any staff whose access was removed, and connect your Facebook and Instagram accounts again in Social media.", link: "/overview", dedupeKey: `offboarding:${r.id}:cancelled` });
  });
}

/** Records that the owner downloaded their data, against any open request. Called by the export route. */
export async function recordExport(orgId: string, userId: string): Promise<void> {
  await withSystem(async (db) => {
    const r = (await db.query<{ id: string }>(`update offboarding_requests set export_downloaded_at = now(), export_downloaded_by = $2 where org_id = $1 and status in ${ACTIVE} returning id`, [orgId, userId])).rows[0];
    if (r) await addEvent(db, r.id, orgId, "export_downloaded", "The data export was downloaded.", userId);
    await recordAudit({ orgId, actorUserId: userId, actorKind: "user", action: "data.exported", targetType: "organization", targetId: orgId, result: "success" }, db);
  });
}

const shutdownSchema = z.object({ websitePlan: z.enum(["keep_until_deletion", "unpublish_now"]).default("keep_until_deletion"), retentionDays: z.number().int().min(MIN_RETENTION_DAYS).max(730).default(DEFAULT_RETENTION_DAYS) });

/**
 * Closes the workspace down safely: customer-facing automation stops and everything already queued is cancelled, messaging is disconnected, staff
 * (not the owner) lose access, the services and social media accounts connected for this client are disconnected, and the retention clock starts. Each step is recorded
 * with its outcome; a step that fails is shown as failed, never hidden. The owner keeps access, so they can still download their data.
 */
export async function shutdownClient(user: SessionUser, requestId: string, input: z.input<typeof shutdownSchema> = {}): Promise<OffboardingView> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can shut a workspace down.");
  const d = shutdownSchema.parse(input);
  const r0 = (await withSystem((db) => db.query<RequestRow>("select * from offboarding_requests where id = $1", [requestId]))).rows[0];
  if (!r0) throw new AppError("not_found", "Request not found.");
  if (r0.status !== "requested") throw new AppError("conflict", "This workspace has already been shut down, or the request is closed.");
  const orgId = r0.org_id;
  const record = (k: string, ok: boolean, t: string) => withSystem((db) => addEvent(db, requestId, orgId, "shutdown_step", JSON.stringify({ k, ok, t }), user.id));

  // 1. Stop everything that talks to customers or acts on its own, and cancel what is already waiting.
  await withSystem(async (db) => {
    for (const scope of ["agency", "messaging", "outbound"]) {
      await db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, $2, true, null, $3, now()) on conflict (org_id, scope) do update set active = true, set_by = $3, set_at = now()", [orgId, scope, user.id]);
    }
    await db.query("update agent_instances set mode = 'paused', mode_changed_by = $2, mode_changed_at = now(), mode_reason = 'Workspace is closing.' where org_id = $1", [orgId, user.id]);
    const msgs = await db.query<{ reservation_id: string | null }>(
      "update conversation_messages set status = 'blocked', blocked_reason = 'offboarding', status_detail = 'Stopped before sending.' where org_id = $1 and direction = 'outbound' and status in ('draft', 'queued') returning reservation_id",
      [orgId],
    );
    for (const m of msgs.rows) if (m.reservation_id) await releaseReservation(db, { orgId, reservationId: m.reservation_id, reason: "Workspace is closing" });
    await db.query("update follow_up_steps set status = 'cancelled', reason = 'offboarding' where org_id = $1 and status in ('scheduled', 'queued')", [orgId]);
    await db.query("update follow_up_plans set status = 'cancelled', cancel_reason = 'offboarding', closed_at = now() where org_id = $1 and status = 'active'", [orgId]);
    const people = await db.query<{ contact_id: string }>("select distinct contact_id from retention_enrollments where org_id = $1 and status = 'active'", [orgId]);
    for (const p of people.rows) await cancelRetention(db, orgId, p.contact_id, "offboarding");
    await db.query("update appointment_reminders set status = 'cancelled', reason = 'The workspace is closing.' where org_id = $1 and status in ('scheduled', 'queued')", [orgId]);
    await db.query("update appointment_bookings set status = 'cancelled', failure_reason = 'The workspace is closing.' where org_id = $1 and status in ('awaiting_approval', 'requested', 'needs_manual')", [orgId]);
    await db.query("update retention_programs set enabled = false where org_id = $1", [orgId]);
    await db.query("update approval_requests set status = 'cancelled' where org_id = $1 and status = 'pending'", [orgId]);
    await db.query("update messaging_channels set enabled = false where org_id = $1", [orgId]);
  });
  await record("automation", true, "Stopped all AI employees and cancelled queued messages, follow-ups, reminders, bookings and customer programs.");
  await record("messaging", true, "Disconnected SMS, WhatsApp and email sending.");

  // 2. The services connected for this client. A failure here is reported, not swallowed: a live token would still be live.
  const conns = await withSystem((db) => db.query<{ provider: "hermes" | "ghl" | "n8n" | "google_calendar" | "email" | "domain" | "supabase" | "external" }>("select provider from integration_connections where org_id = $1 and status not in ('not_configured', 'disconnected')", [orgId]));
  const failed: string[] = [];
  for (const c of conns.rows) {
    try {
      await disconnectIntegration(user, orgId, c.provider as never);
    } catch {
      failed.push(c.provider);
    }
  }
  await record("integrations", failed.length === 0, failed.length ? `Could not disconnect: ${failed.join(", ")}. Disconnect these by hand and revoke their tokens at the provider.` : `Disconnected ${conns.rows.length} connected service${conns.rows.length === 1 ? "" : "s"}. Revoke any upstream tokens at the provider too.`);

  // 2b. Facebook Pages and Instagram accounts. They are not integration connections, but they hold the same kind of live token (a Page's long-lived token) and
  // have posts waiting to go out, so they are disconnected exactly as their owner would: the token is deleted and what was queued is stopped.
  const social = await disconnectWorkspaceAccounts(orgId, user.id);
  const socialOk = social.failed.length === 0;
  await record(
    "social", socialOk,
    social.failed.length
      ? `Could not disconnect social media accounts: ${social.failed.join(", ")}. Disconnect them by hand and have the iAcquire app removed on the platform.`
      : social.disconnected
        ? `Disconnected ${social.disconnected} social media account${social.disconnected === 1 ? "" : "s"} and deleted their sign-in tokens${social.stopped ? `; ${social.stopped} post${social.stopped === 1 ? "" : "s"} waiting to publish ${social.stopped === 1 ? "was" : "were"} stopped` : ""}. The app can also be removed on the platform.`
        : "No social media accounts were connected.",
  );

  // 3. Access: staff lose it, the owner keeps it to download their data.
  const revoked = await withSystem(async (db) => {
    const res = await db.query("update organization_memberships set status = 'revoked' where org_id = $1 and status = 'active' and role <> 'owner'", [orgId]);
    await db.query("update invitations set revoked_at = now() where org_id = $1 and accepted_at is null and revoked_at is null", [orgId]);
    return res.rowCount;
  });
  await record("access", true, `Removed access for ${revoked} team member${revoked === 1 ? "" : "s"}. The owner keeps access to download their data.`);

  // 4. The website: kept until deletion, or taken down now, as agreed.
  await withSystem(async (db) => {
    if (d.websitePlan === "unpublish_now") {
      await db.query("update website_publications set status = 'superseded' where org_id = $1 and status = 'live'", [orgId]);
      await db.query("update websites set published_publication_id = null where org_id = $1", [orgId]);
    }
  });
  await record("website", true, d.websitePlan === "unpublish_now" ? "Unpublished the website." : "The website stays live until deletion, as agreed. The client's own domains stay theirs.");

  // 5. Money: note what is left, so billing can be closed knowingly.
  const result = await withSystem(async (db) => {
    const bal = (await db.query<{ b: string }>("select coalesce(balance_micros, 0)::text as b from credit_accounts where org_id = $1", [orgId])).rows[0]?.b ?? "0";
    const res = await db.query<RequestRow>(
      `update offboarding_requests set status = 'retention', shutdown_at = now(), shutdown_by = $2, retention_days = $3, website_plan = $4, credit_balance_micros = $5, delete_after = now() + make_interval(days => $3) where id = $1 returning *`,
      [requestId, user.id, d.retentionDays, d.websitePlan, bal],
    );
    await addEvent(db, requestId, orgId, "shutdown", `Workspace shut down. Data is kept for ${d.retentionDays} days. Remaining prepaid credit: $${(Number(bal) / 1_000_000).toFixed(2)}.`, user.id);
    await addEvent(db, requestId, orgId, "retention_started", `Deletion can be scheduled after ${d.retentionDays} days.`, user.id);
    await recordAudit({ orgId, actorUserId: user.id, actorKind: "agency", action: "offboarding.shutdown", targetType: "offboarding_request", targetId: requestId, result: failed.length || !socialOk ? "failure" : "success", metadata: { retentionDays: d.retentionDays, websitePlan: d.websitePlan, failedDisconnects: failed, failedSocialDisconnects: social.failed } }, db);
    await notifyOrgRoles(db, orgId, ["owner"], {
      kind: "offboarding_update", severity: "info", title: "Your workspace has been closed down",
      body: `Automation and messaging are off. You can download your data until ${new Date(res.rows[0].delete_after!).toISOString().slice(0, 10)}. Your domains are yours to keep.`, link: "/settings/data", dedupeKey: `offboarding:${requestId}:shutdown`,
    });
    return toView(db, res.rows[0]);
  });
  return result;
}

/** The agency confirms the final billing is settled: remaining credit refunded or waived, and nothing left to invoice. A precondition for deletion. */
export async function closeBilling(user: Pick<SessionUser, "id" | "platformRole">, requestId: string, note: string): Promise<void> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can close billing.");
  const text = note.trim();
  if (text.length < 3 || text.length > 500) throw new AppError("invalid_input", "Say how remaining credit and charges were settled, in 3 to 500 characters.");
  await withSystem(async (db) => {
    const r = (await db.query<{ org_id: string }>(`update offboarding_requests set billing_closed_at = now(), billing_closed_by = $2, billing_note = $3 where id = $1 and status in ${ACTIVE} returning org_id`, [requestId, user.id, text])).rows[0];
    if (!r) throw new AppError("not_found", "Request not found.");
    await addEvent(db, requestId, r.org_id, "billing_closed", text, user.id);
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "offboarding.billing_closed", targetType: "offboarding_request", targetId: requestId, result: "success" }, db);
  });
}

// ---------------------------------------------------------------------------
// Deletion
// ---------------------------------------------------------------------------

export interface DeletionPlan {
  purge: Array<{ table: string; rows: number }>;
  retain: Array<{ table: string; rows: number }>;
  files: number;
  totalPurgeRows: number;
}

async function tenantTables(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ relname: string }>(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
  );
  return rows.map((r) => r.relname);
}

/** What deleting would remove and what it would keep, with row counts. Reads only. */
export async function planDeletion(user: Pick<SessionUser, "id" | "platformRole">, requestId: string): Promise<DeletionPlan> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can plan a deletion.");
  return withSystem(async (db) => {
    const r = (await db.query<RequestRow>("select * from offboarding_requests where id = $1", [requestId])).rows[0];
    if (!r) throw new AppError("not_found", "Request not found.");
    const plan: DeletionPlan = { purge: [], retain: [], files: 0, totalPurgeRows: 0 };
    for (const t of await tenantTables(db)) {
      const n = Number((await db.query<{ n: string }>(`select count(*)::text as n from "${t}" where org_id = $1`, [r.org_id])).rows[0].n);
      if (n === 0) continue;
      (PURGE_RETAINS.has(t) ? plan.retain : plan.purge).push({ table: t, rows: n });
    }
    plan.files = Number((await db.query<{ n: string }>("select count(*)::text as n from private_files where org_id = $1 and status <> 'deleted'", [r.org_id])).rows[0].n);
    plan.totalPurgeRows = plan.purge.reduce((s, p) => s + p.rows, 0);
    await addEvent(db, requestId, r.org_id, "deletion_planned", `Plan: remove ${plan.totalPurgeRows} rows across ${plan.purge.length} tables and ${plan.files} files; keep ${plan.retain.length} financial and audit tables.`, user.id);
    return plan;
  });
}

/**
 * Permanently removes a departed client's data. Every guard must hold: the purge switch is on for this environment, the request is in retention
 * and past its date, the data was downloaded (or the agency records why not), billing is closed, and the confirmation matches the workspace name.
 * It runs in one transaction, so it either removes everything listed or nothing. Payments, the credit ledger, usage, fees and the audit trail
 * are kept. It cannot be undone, which is why a plan is always shown first.
 */
export async function executeDeletion(user: Pick<SessionUser, "id" | "platformRole">, requestId: string, input: { confirmName: string; waiveExportReason?: string }): Promise<{ purgedRows: number; files: number; orphanedFiles: number }> {
  if (user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only super admins can delete a workspace's data.");
  if (!env().OFFBOARDING_PURGE_ENABLED) throw new AppError("forbidden", "Permanent deletion is switched off in this environment. It is enabled deliberately, per environment, after a backup has been taken and restored once.");
  const r = (await withSystem((db) => db.query<RequestRow & { org_name: string }>("select r.*, o.name as org_name from offboarding_requests r join organizations o on o.id = r.org_id where r.id = $1", [requestId]))).rows[0];
  if (!r) throw new AppError("not_found", "Request not found.");
  if (r.status !== "retention") throw new AppError("conflict", "Data can be deleted only after the workspace has been shut down and the retention period has begun.");
  if (!r.delete_after || new Date(r.delete_after).getTime() > Date.now()) throw new AppError("conflict", `The retention period isn't over yet. Deletion is possible after ${r.delete_after ? new Date(r.delete_after).toISOString().slice(0, 10) : "it has been set"}.`);
  if (!r.billing_closed_at) throw new AppError("conflict", "Close billing first, so nothing owed is lost.");
  if (!r.export_downloaded_at && !(input.waiveExportReason && input.waiveExportReason.trim().length >= 10)) throw new AppError("conflict", "The client hasn't downloaded their data. Make sure they can, or record why this isn't needed.");
  if (input.confirmName.trim() !== r.org_name.trim()) throw new AppError("invalid_input", "Type the workspace name exactly to confirm.");

  // Remember which stored files belong to this client, but remove them only AFTER the database purge has committed: if the purge fails, nothing may
  // already be gone. (A file that then can't be removed is reported, not hidden.)
  const stored = (await withSystem((db) => db.query<{ bucket: PrivateBucket; storage_key: string }>("select bucket, storage_key from private_files where org_id = $1 and status <> 'deleted'", [r.org_id]))).rows;
  const purged = await withSystem(async (db) => {
    await db.query("select set_config('iaq.purge', 'on', true)");
    let remaining = (await tenantTables(db)).filter((t) => !PURGE_RETAINS.has(t));
    let rows = 0;
    for (let pass = 0; pass < 12 && remaining.length; pass += 1) {
      const next: string[] = [];
      for (const t of remaining) {
        await db.query("savepoint purge_step");
        try {
          const res = await db.query(`delete from "${t}" where org_id = $1`, [r.org_id]);
          rows += res.rowCount;
          await db.query("release savepoint purge_step");
        } catch {
          // A table another one still points at: leave it for a later pass, after the dependants are gone.
          await db.query("rollback to savepoint purge_step");
          next.push(t);
        }
      }
      if (next.length === remaining.length) throw new AppError("internal", `Deletion stopped because ${next.join(", ")} could not be removed. Nothing was deleted.`);
      remaining = next;
    }
    if (remaining.length) throw new AppError("internal", `Deletion stopped because ${remaining.join(", ")} could not be removed. Nothing was deleted.`);
    await db.query("update organization_memberships set status = 'revoked' where org_id = $1", [r.org_id]);
    await db.query("update organizations set status = 'archived', website = null, industry = null, region = null, suspended_reason = 'Closed at the client''s request. Data deleted.' where id = $1", [r.org_id]);
    await db.query("update offboarding_requests set status = 'deleted', deleted_at = now(), deleted_by = $2 where id = $1", [requestId, user.id]);
    await addEvent(db, requestId, r.org_id, "deleted", `Deleted ${rows} rows and ${stored.length} files. Payments, the credit ledger, usage, fees and the audit trail were kept.${input.waiveExportReason ? ` Export waived: ${input.waiveExportReason.trim().slice(0, 200)}` : ""}`, user.id);
    await recordAudit({ orgId: r.org_id, actorUserId: user.id, actorKind: "agency", action: "offboarding.deleted", targetType: "offboarding_request", targetId: requestId, result: "success", metadata: { rows, files: stored.length } }, db);
    return rows;
  });

  let orphaned = 0;
  for (const f of stored) {
    try {
      await removeStoredObjectTrusted({ orgId: r.org_id, bucket: f.bucket, storageKey: f.storage_key });
    } catch {
      orphaned += 1;
    }
  }
  if (orphaned) {
    await withSystem(async (db) => {
      await addEvent(db, requestId, r.org_id, "note", `${orphaned} stored file${orphaned === 1 ? "" : "s"} could not be removed from storage and need removing by hand (bucket/path under ${r.org_id}/).`, user.id);
      await notifyAgency(db, null, { kind: "offboarding_update", severity: "warning", title: `${r.org_name}: ${orphaned} stored file${orphaned === 1 ? "" : "s"} still need removing`, body: "The data was deleted from the database, but these files could not be removed from storage.", link: `/admin/clients/${r.org_id}`, dedupeKey: `offboarding-orphans:${requestId}` });
    });
  }
  return { purgedRows: purged, files: stored.length - orphaned, orphanedFiles: orphaned };
}

/** Reminds the owner before the retention period ends, so nothing is ever deleted as a surprise. Each reminder is sent once. */
export async function sendDeletionReminders(now = new Date()): Promise<number> {
  return withSystem(async (db) => {
    const { rows } = await db.query<{ id: string; org_id: string; delete_after: Date }>("select id, org_id, delete_after from offboarding_requests where status = 'retention' and delete_after is not null and delete_after > $1", [now.toISOString()]);
    let sent = 0;
    for (const r of rows) {
      const days = Math.ceil((new Date(r.delete_after).getTime() - now.getTime()) / 86_400_000);
      const window = days <= 3 ? "3d" : days <= 14 ? "14d" : null;
      if (!window) continue;
      await notifyOrgRoles(db, r.org_id, ["owner"], {
        kind: "offboarding_update", severity: window === "3d" ? "warning" : "info", title: `Your data will be deleted in ${days} day${days === 1 ? "" : "s"}`,
        body: "Download your data now from Settings → Your data. If you want your workspace back, tell us before then.", link: "/settings/data", dedupeKey: `offboarding:${r.id}:${window}`,
      });
      await addEvent(db, r.id, r.org_id, "reminder", `Reminded the owner: ${days} days left.`);
      sent += 1;
    }
    return sent;
  });
}
