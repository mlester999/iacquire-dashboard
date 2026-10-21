// Premium operations: what an agency member can record about a plan (and that nothing is inferred or invented), what the agency listing shows of the
// plan's money side, and that the plan's lifecycle reaches queued and running work without touching the core AI employees' schedules.
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ user: null as null | { id: string; platformRole: "agency_super_admin" | "agency_staff"; email: string; fullName: string }, revalidated: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => state.revalidated.push(p) }));
vi.mock("@/server/tenancy/context", async () => {
  const { AppError } = await import("@/server/errors");
  return {
    requireAgencyOrThrow: async () => {
      if (!state.user) throw new AppError("unauthenticated", "Sign in to continue.");
      return state.user;
    },
  };
});

import { withSystem } from "@/server/db";
import { listAgencyMaintenance } from "@/server/maintenance/service";
import { expireSubscriptionAction, recordPaymentFailedAction, recordVerifiedPaymentAction } from "@/app/(admin)/admin/maintenance/actions";
import { sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { JOBS, runScheduledJobs } from "@/server/ops/tick";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import type { WorkflowStep } from "@/lib/crm/workflow/spec";
import { agencyUser, createUser } from "./support/fixtures";
import { crmOrg } from "./support/crm";

const DAY = 86_400_000;
const task = (title: string): WorkflowStep[] => [{ key: "task", kind: "create_task", config: { title, priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[];

async function plan(status: "active" | "past_due" | "expired" = "active", name?: string) {
  const o = await crmOrg(name ? { name } : {});
  const row = (await withSystem((db) =>
    db.query<{ id: string }>(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on, past_due_since, grace_ends_at, expired_at)
       values ($1, $2, 29900, 4, 'test', $3, now() - interval '30 days', current_date - 30, $4, $5, $6) returning id`,
      [o.org.id, status, o.people.owner.id, status === "past_due" ? new Date(Date.now() - DAY).toISOString() : null, status === "past_due" ? new Date(Date.now() + 6 * DAY).toISOString() : null, status === "expired" ? new Date().toISOString() : null],
    ),
  )).rows[0];
  return { o, id: row.id };
}
const statusOf = async (id: string) => (await withSystem((db) => db.query<{ status: string; paid_through_on: string | null }>("select status, paid_through_on::text as paid_through_on from maintenance_subscriptions where id = $1", [id]))).rows[0];
const audits = async (orgId: string, action: string) => (await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = $2", [orgId, action]))).rows;

beforeEach(async () => {
  const u = await createUser({ platformRole: "agency_super_admin", name: "Agency Admin" });
  state.user = { id: u.id, platformRole: "agency_super_admin", email: u.email, fullName: "Agency Admin" };
  state.revalidated = [];
  await withSystem((db) => db.query("update crm_workflows set status = 'archived', archived_at = now(), entitlement_paused_at = null where origin = 'studio' and status <> 'archived'"));
});

describe("the agency's plan controls record what a person knows and nothing else", () => {
  it("records a failed payment with a grace period the agency chooses, and tells the owners the date", async () => {
    const { o, id } = await plan("active");
    expect(await recordPaymentFailedAction(id, 10)).toMatchObject({ ok: true, data: { graceDays: 10 } });
    expect(await statusOf(id)).toMatchObject({ status: "past_due" });
    const ent = await withSystem((db) => studioEntitlement(db, o.org.id));
    expect(ent).toMatchObject({ entitled: true, state: "past_due" });
    expect(Math.round((new Date(ent.graceEndsAt!).getTime() - Date.now()) / DAY)).toBe(10);
    expect((await audits(o.org.id, "maintenance.payment_failed"))[0].metadata).toMatchObject({ graceDays: 10 });
    expect(state.revalidated).toContain("/admin/maintenance");
    // The grace period is bounded, and an account that is already past due can't be put there again.
    expect(await recordPaymentFailedAction(id, 10)).toMatchObject({ ok: false });
    const other = await plan("active");
    expect(await recordPaymentFailedAction(other.id, 0)).toMatchObject({ ok: false });
    expect(await recordPaymentFailedAction(other.id, 31)).toMatchObject({ ok: false });
    expect(await statusOf(other.id)).toMatchObject({ status: "active" });
  });

  it("never records a payment the person didn't confirm, and never one the data doesn't allow", async () => {
    const { o, id } = await plan("past_due");
    const through = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    // Without the confirmation nothing changes, however the request is made.
    expect(await recordVerifiedPaymentAction(id, through, false)).toMatchObject({ ok: false, error: expect.stringMatching(/Confirm that you verified/) });
    expect(await recordVerifiedPaymentAction(id, through, undefined as unknown as boolean)).toMatchObject({ ok: false });
    expect(await statusOf(id)).toMatchObject({ status: "past_due", paid_through_on: null });
    expect(await audits(o.org.id, "maintenance.payment_verified")).toEqual([]);
    // A date that isn't a date, in the past or far ahead is refused.
    for (const bad of ["tomorrow", "2020-01-01", new Date(Date.now() + 800 * DAY).toISOString().slice(0, 10)]) expect(await recordVerifiedPaymentAction(id, bad, true), bad).toMatchObject({ ok: false });
    expect(await statusOf(id)).toMatchObject({ status: "past_due" });

    expect(await recordVerifiedPaymentAction(id, through, true)).toMatchObject({ ok: true, data: { reactivated: true } });
    expect(await statusOf(id)).toMatchObject({ status: "active", paid_through_on: through });
    const [a] = await audits(o.org.id, "maintenance.payment_verified");
    expect(a.metadata).toMatchObject({ paidThroughOn: through, reactivated: true });
  });

  it("brings an expired plan back only on a verified payment, and keeps each paused workflow paused until a person turns it on", async () => {
    const { o, id } = await plan("active");
    const owner = o.actor("owner");
    const wf = (await createWorkflow(owner, { name: "Studio task", definition: { trigger: { type: "contact.created" }, steps: task("Follow up") }, origin: "studio" })).id;
    await publishWorkflow(owner, wf);
    await setWorkflowStatus(owner, wf, "active");

    expect(await expireSubscriptionAction(id)).toMatchObject({ ok: true, data: { pausedWorkflows: 1 } });
    const paused = (await withSystem((db) => db.query<{ status: string; entitlement_paused_at: Date | null }>("select status, entitlement_paused_at from crm_workflows where id = $1", [wf]))).rows[0];
    expect(paused.status).toBe("paused");
    expect(paused.entitlement_paused_at).not.toBeNull();

    const through = new Date(Date.now() + 30 * DAY).toISOString().slice(0, 10);
    expect(await recordVerifiedPaymentAction(id, through, true)).toMatchObject({ ok: true, data: { reactivated: true, workflowsWaiting: 1 } });
    await sweepStudioEntitlements();
    // Reactivating the plan does not switch anything on by itself.
    expect((await withSystem((db) => db.query<{ status: string }>("select status from crm_workflows where id = $1", [wf]))).rows[0].status).toBe("paused");
    await setWorkflowStatus(owner, wf, "active");
    expect((await withSystem((db) => db.query<{ status: string }>("select status from crm_workflows where id = $1", [wf]))).rows[0].status).toBe("active");
  });

  it("needs a signed-in agency member with access to that workspace", async () => {
    const { id } = await plan("active");
    state.user = null;
    expect(await recordPaymentFailedAction(id)).toMatchObject({ ok: false });
    expect(await expireSubscriptionAction(id)).toMatchObject({ ok: false });
    expect(await statusOf(id)).toMatchObject({ status: "active" });
    // Staff who aren't assigned to the client can't see or change its plan.
    const staff = await createUser({ platformRole: "agency_staff", name: "Unassigned" });
    state.user = { id: staff.id, platformRole: "agency_staff", email: staff.email, fullName: "Unassigned" };
    expect(await recordPaymentFailedAction(id)).toMatchObject({ ok: false });
    expect(await statusOf(id)).toMatchObject({ status: "active" });
  });
});

describe("the agency listing", () => {
  it("shows where the money side stands, as recorded by people, and what a lapse would touch", async () => {
    const { o, id } = await plan("active", "Listing Co");
    const owner = o.actor("owner");
    const wf = (await createWorkflow(owner, { name: "Studio task", definition: { trigger: { type: "contact.created" }, steps: task("Follow up") }, origin: "studio" })).id;
    await publishWorkflow(owner, wf);
    await setWorkflowStatus(owner, wf, "active");
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const before = (await listAgencyMaintenance(admin)).subscriptions.find((s) => s.id === id)!;
    expect(before.lifecycle).toMatchObject({ paidThroughOn: null, lastPaymentVerifiedAt: null, studioWorkflows: 1, studioPaused: 0, graceEndsAt: null, expiredAt: null });

    state.user = { id: admin.id, platformRole: "agency_super_admin", email: admin.email, fullName: "Verifier" };
    const through = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    await recordVerifiedPaymentAction(id, through, true);
    await recordPaymentFailedAction(id, 5);
    const failed = (await listAgencyMaintenance(admin)).subscriptions.find((s) => s.id === id)!;
    expect(failed.status).toBe("past_due");
    expect(failed.lifecycle).toMatchObject({ paidThroughOn: through, lastPaymentVerifiedBy: expect.any(String) });
    expect(failed.lifecycle.graceEndsAt).not.toBeNull();

    await expireSubscriptionAction(id);
    const expired = (await listAgencyMaintenance(admin)).subscriptions.find((s) => s.id === id)!;
    expect(expired.status).toBe("expired");
    expect(expired.lifecycle).toMatchObject({ studioWorkflows: 1, studioPaused: 1 });
    expect(expired.lifecycle.expiredAt).not.toBeNull();
  });

  it("hides an expired plan once the client has a newer one, and plans of workspaces the viewer can't reach", async () => {
    const { o, id } = await plan("expired", "Replaced Co");
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    expect((await listAgencyMaintenance(admin)).subscriptions.map((s) => s.id)).toContain(id);
    await withSystem((db) => db.query(`insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by) values ($1, 'requested', 29900, 4, 'test', $2)`, [o.org.id, o.people.owner.id]));
    expect((await listAgencyMaintenance(admin)).subscriptions.map((s) => s.id)).not.toContain(id);
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    expect((await listAgencyMaintenance(staff)).subscriptions.map((s) => s.orgId)).not.toContain(o.org.id);
  });
});

describe("a lapse reaches queued and running work, and nothing else", () => {
  it("stops a queued Studio run and a Studio run mid-wait, but never the CRM workflows or the AI employees' own schedules", async () => {
    const { o } = await plan("active", "Lapse Co");
    const owner = o.actor("owner");
    const studio = (await createWorkflow(owner, { name: "Studio", definition: { trigger: { type: "contact.created" }, steps: task("Studio task") }, origin: "studio" })).id;
    const core = (await createWorkflow(owner, { name: "Core", definition: { trigger: { type: "contact.created" }, steps: task("Core task") } })).id;
    for (const id of [studio, core]) {
      await publishWorkflow(owner, id);
      await setWorkflowStatus(owner, id, "active");
    }
    for (let i = 0; i < 3; i++) await crmEventDispatch();
    // The plan lapses before anything has run: the Studio run is queued and must wait; the core workflow's run must not.
    await createContact(owner, { firstName: "Lapse", lastName: "Contact" });
    await crmEventDispatch();
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'expired', expired_at = now() where org_id = $1", [o.org.id]));
    await processWorkflowRuns({});
    const tasks = (await withSystem((db) => db.query<{ title: string }>("select title from tasks where org_id = $1 order by title", [o.org.id]))).rows.map((r) => r.title);
    expect(tasks).toEqual(["Core task"]);

    // Every other scheduled job (the AI employees' follow-ups, replies and briefings, reminders, messaging, webhooks, the CRM's own workflows) runs
    // exactly as before for a workspace whose plan lapsed: none fails, none pauses an employee, and only Studio workflows are marked as paused for the plan.
    const employeesBefore = (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_instances where org_id = $1 and enabled", [o.org.id]))).rows[0].n;
    const result = await runScheduledJobs(new Date(), JOBS.filter((j) => j.name !== "studioEntitlementSweep"));
    for (const [name, outcome] of Object.entries(result)) expect(typeof outcome, `${name}: ${outcome}`).toBe("number");
    expect(Object.keys(result)).toEqual(expect.arrayContaining(["followUpsPrepared", "repliesChecked", "crmWorkflowRuns", "aqiOperationsBriefings", "retentionPrograms"]));
    const employeesAfter = (await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from agent_instances where org_id = $1 and enabled", [o.org.id]))).rows[0].n;
    expect(employeesAfter).toBe(employeesBefore);
    const pausedForPlan = (await withSystem((db) => db.query<{ id: string }>("select id from crm_workflows where org_id = $1 and entitlement_paused_at is not null", [o.org.id]))).rows.map((r) => r.id);
    expect(pausedForPlan).toEqual([]); // only the sweep pauses for the plan, and it hasn't run
    await sweepStudioEntitlements();
    const after = (await withSystem((db) => db.query<{ id: string; origin: string; status: string }>("select id, origin, status from crm_workflows where org_id = $1 and entitlement_paused_at is not null", [o.org.id]))).rows;
    expect(after).toEqual([{ id: studio, origin: "studio", status: "paused" }]);
  });
});
