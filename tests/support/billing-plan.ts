// Fixtures for the maintenance plan's lifecycle tests (renewal notices, lapse, cancellation, entitlements): a plan row in any state, an Automation Studio workflow and a core
// workflow, and the notices a test reads back. Nothing here talks to a provider.
import { withSystem } from "@/server/db";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import type { CrmOrg } from "./crm";
import { uid } from "./fixtures";

export const DAY = 86_400_000;
export const dayText = (d: Date) => d.toISOString().slice(0, 10);
export const inDays = (from: Date, n: number) => dayText(new Date(from.getTime() + n * DAY));

export interface PlanOptions {
  status?: "requested" | "active" | "cancel_requested" | "past_due" | "expired" | "cancelled" | "declined";
  /** YYYY-MM-DD the plan is paid through; null for none. */
  paidThroughOn?: string | null;
  graceEndsAt?: Date;
  pastDueSince?: Date;
  /** How long ago the plan was created (days), for ordering several plans of one workspace. */
  createdDaysAgo?: number;
}

type Owned = { org: { id: string }; people: { owner: { id: string } } };

/** A maintenance plan row written directly, in the shape the database requires for its state. Returns its id. */
export async function planRow(o: Owned, opts: PlanOptions = {}): Promise<string> {
  const status = opts.status ?? "active";
  const open = status !== "requested" && status !== "declined";
  const pastDue = status === "past_due";
  const created = new Date(Date.now() - (opts.createdDaysAgo ?? 0) * DAY).toISOString();
  const { rows } = await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on,
         past_due_since, grace_ends_at, expired_at, cancelled_at, paid_through_on, created_at)
       values ($1, $2, 29900, 4, 'test-terms', $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [
        o.org.id, status, o.people.owner.id,
        open ? new Date(Date.now() - 60 * DAY).toISOString() : null,
        open ? dayText(new Date(Date.now() - 60 * DAY)) : null,
        pastDue ? (opts.pastDueSince ?? new Date(Date.now() - DAY)).toISOString() : null,
        pastDue ? (opts.graceEndsAt ?? new Date(Date.now() + 6 * DAY)).toISOString() : null,
        status === "expired" ? new Date().toISOString() : null,
        status === "cancelled" ? new Date().toISOString() : null,
        opts.paidThroughOn === undefined ? null : opts.paidThroughOn,
        created,
      ],
    ),
  );
  return rows[0].id;
}

export async function planStatus(subscriptionId: string) {
  const { rows } = await withSystem((db) =>
    db.query<{ status: string; past_due_since: Date | null; grace_ends_at: Date | null; paid_through_on: string | null; last_payment_verified_by: string | null }>(
      "select status, past_due_since, grace_ends_at, paid_through_on::text as paid_through_on, last_payment_verified_by from maintenance_subscriptions where id = $1", [subscriptionId],
    ),
  );
  return rows[0];
}

/** A workflow that creates one internal task for each new contact: no outside effect, so no owner approval is involved. */
export const taskDef = (title = "Follow up"): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [{ key: "task", kind: "create_task", config: { title, priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
});

/** A switched-on workflow built in Automation Studio (a premium one). The plan has to be entitled while it is made. */
export async function studioWorkflowFor(o: CrmOrg, opts: { activate?: boolean } = {}) {
  const actor = o.actor("owner");
  const { id } = await createWorkflow(actor, { name: `Studio ${uid()}`, definition: taskDef(), origin: "studio" });
  await publishWorkflow(actor, id);
  if (opts.activate !== false) await setWorkflowStatus(actor, id, "active");
  return id;
}

/** A switched-on workflow built in the ordinary CRM screens (core: never touched by a lapse). */
export async function coreWorkflowFor(o: CrmOrg) {
  const actor = o.actor("owner");
  const { id } = await createWorkflow(actor, { name: `Core ${uid()}`, definition: taskDef("Core task") });
  await publishWorkflow(actor, id);
  await setWorkflowStatus(actor, id, "active");
  return id;
}

export const workflowRow = async (id: string) =>
  (await withSystem((db) => db.query<{ status: string; origin: string; entitlement_paused_at: Date | null }>("select status, origin, entitlement_paused_at from crm_workflows where id = $1", [id]))).rows[0];

/** Notices of a kind in a workspace: who they went to (an audience), with their title, body and dedupe key. */
export const noticesOf = async (orgId: string, kind: string, audience?: "agency" | "client") =>
  (await withSystem((db) =>
    db.query<{ user_id: string; audience: string; title: string; body: string | null; dedupe_key: string | null; severity: string }>(
      "select user_id, audience, title, body, dedupe_key, severity from notifications where org_id = $1 and kind = $2 and ($3::text is null or audience = $3) order by created_at, id",
      [orgId, kind, audience ?? null],
    ),
  )).rows;

export const auditOf = async (orgId: string, action: string) =>
  (await withSystem((db) =>
    db.query<{ actor_kind: string; actor_user_id: string | null; metadata: Record<string, unknown> }>(
      "select actor_kind, actor_user_id, metadata from audit_logs where org_id = $1 and action = $2 order by created_at, id", [orgId, action],
    ),
  )).rows;

export async function setAgencyTimezone(timezone: string) {
  // The database allows one agency workspace; a test file that needs one makes it once and changes its time zone.
  await withSystem(async (db) => {
    const have = await db.query("select 1 from organizations where kind = 'agency'");
    if (have.rows[0]) await db.query("update organizations set timezone = $1 where kind = 'agency'", [timezone]);
    else await db.query("insert into organizations (name, slug, kind, status, timezone) values ('Test Agency', $1, 'agency', 'active', $2)", [`test-agency-${uid()}`, timezone]);
  });
}
