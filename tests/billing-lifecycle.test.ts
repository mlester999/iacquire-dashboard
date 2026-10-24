// What ends a maintenance plan, and what reactivating a workspace restores (Phase 7, M2): a confirmed cancellation pauses the Automation Studio workflows exactly as an
// expiry does, a client who ends an unpaid plan does the same, and a reactivated workspace gets the activation status its setup implies. Core CRM is never touched.
// Embedded Postgres; no provider is called.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { setTenantStatus } from "@/server/admin/tenants";
import { requestMaintenanceCancellation, resolveMaintenanceSubscription } from "@/server/maintenance/service";
import { expireSubscription } from "@/server/automation-studio/lifecycle";
import { STUDIO_LAPSE_POLICY } from "@/lib/automation-studio/plan";
import { agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import { crmOrg } from "./support/crm";
import { auditOf, coreWorkflowFor, inDays, noticesOf, planRow, planStatus, studioWorkflowFor, workflowRow } from "./support/billing-plan";

let superAdmin: ReturnType<typeof agencyUser>;
beforeAll(async () => {
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
});

describe("a confirmed cancellation lapses the plan like an expiry does", () => {
  it("pauses the Automation Studio workflows, leaves the core ones, and tells the owner once what that means", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "active", paidThroughOn: inDays(new Date(), 20) });
    const studio = await studioWorkflowFor(o);
    const core = await coreWorkflowFor(o);
    const ctx = ctxFor(o.people.owner, o.org, "owner");

    await requestMaintenanceCancellation(ctx, "We are closing the shop");
    expect((await planStatus(sub)).status).toBe("cancel_requested");
    // Until the agency confirms, nothing changes: the plan is still entitled and the workflow still runs.
    expect(await workflowRow(studio)).toMatchObject({ status: "active", entitlement_paused_at: null });

    await resolveMaintenanceSubscription(superAdmin, sub, "confirm_cancellation");
    expect((await planStatus(sub)).status).toBe("cancelled");
    expect(await workflowRow(studio)).toMatchObject({ status: "paused" });
    expect((await workflowRow(studio)).entitlement_paused_at).not.toBeNull();
    expect(await workflowRow(core)).toMatchObject({ status: "active", entitlement_paused_at: null });

    // The owner is told what the lapse does and does not touch, in the words the expiry notice uses.
    const told = (await noticesOf(o.org.id, "maintenance_update", "client")).filter((n) => n.title === "Your maintenance plan is cancelled");
    expect(told.length).toBeGreaterThan(0);
    expect(new Set(told.map((n) => n.dedupe_key)).size).toBe(1);
    for (const sentence of [STUDIO_LAPSE_POLICY.paused, STUDIO_LAPSE_POLICY.kept, STUDIO_LAPSE_POLICY.unaffected]) expect(told[0].body, sentence).toContain(sentence);
    expect((await noticesOf(o.org.id, "maintenance_update", "client")).filter((n) => /Automation Studio workflow was paused/.test(n.title)).length).toBeGreaterThan(0);

    const audit = await auditOf(o.org.id, "maintenance.confirm_cancellation");
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ pausedWorkflows: 1 });

    // Confirming again changes nothing and says nothing more.
    await expect(resolveMaintenanceSubscription(superAdmin, sub, "confirm_cancellation")).rejects.toThrow(/no cancellation to confirm/);
    expect((await noticesOf(o.org.id, "maintenance_update", "client")).filter((n) => n.title === "Your maintenance plan is cancelled").length).toBe(told.length);
  });

  it("behaves the same as ending the plan outright, for the same workflows", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    const subA = await planRow(a, { status: "cancel_requested", paidThroughOn: inDays(new Date(), 10) });
    const subB = await planRow(b, { status: "active", paidThroughOn: inDays(new Date(), 10) });
    const wa = await studioWorkflowFor(a);
    const wb = await studioWorkflowFor(b);
    await resolveMaintenanceSubscription(superAdmin, subA, "confirm_cancellation");
    await expireSubscription(superAdmin, subB);
    expect((await workflowRow(wa)).status).toBe((await workflowRow(wb)).status);
    expect((await workflowRow(wa)).entitlement_paused_at !== null).toBe((await workflowRow(wb)).entitlement_paused_at !== null);
  });

  it("does not pause anything when declining a plan that never started", async () => {
    const o = await crmOrg();
    const sub = await planRow(o, { status: "requested" });
    const core = await coreWorkflowFor(o);
    await resolveMaintenanceSubscription(superAdmin, sub, "decline");
    expect((await planStatus(sub)).status).toBe("declined");
    expect(await workflowRow(core)).toMatchObject({ status: "active" });
  });
});

describe("a client who ends an unpaid plan", () => {
  it("lapses it at once: the plan is over, so the Automation Studio workflows are paused now and not at the next sweep", async () => {
    const o = await crmOrg();
    // A workflow made while the plan was healthy; then a payment fails and the grace period is still running when the client ends the plan.
    const sub = await planRow(o, { status: "active", paidThroughOn: inDays(new Date(), -3) });
    const studio = await studioWorkflowFor(o);
    const core = await coreWorkflowFor(o);
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'past_due', past_due_since = now() - interval '1 day', grace_ends_at = now() + interval '4 days' where id = $1", [sub]));

    await requestMaintenanceCancellation(ctxFor(o.people.owner, o.org, "owner"), "Please stop it");
    expect((await planStatus(sub)).status).toBe("cancelled");
    expect(await workflowRow(studio)).toMatchObject({ status: "paused" });
    expect(await workflowRow(core)).toMatchObject({ status: "active" });
    expect((await auditOf(o.org.id, "maintenance.cancellation_requested"))[0]).toBeDefined();
  });

  it("does nothing to workflows when the plan was only requested", async () => {
    const o = await crmOrg();
    await planRow(o, { status: "requested" });
    const core = await coreWorkflowFor(o);
    await requestMaintenanceCancellation(ctxFor(o.people.owner, o.org, "owner"));
    expect(await workflowRow(core)).toMatchObject({ status: "active" });
  });
});

describe("reactivating a suspended workspace restores its activation status", () => {
  const activation = async (orgId: string) => (await withSystem((db) => db.query<{ activation_status: string; setup_payment_status: string }>("select activation_status, setup_payment_status from billing_accounts where org_id = $1", [orgId]))).rows[0];
  const setupState = (orgId: string, state: "activated" | "in_setup") =>
    withSystem((db) => db.query("insert into client_setup_instances (org_id, state, activated_at) values ($1, $2, case when $2 = 'activated' then now() else null end) on conflict (org_id) do update set state = excluded.state", [orgId, state]));

  it("goes back to active for a workspace whose setup was activated, even when the fee was refunded since (a refund never pauses a running client)", async () => {
    const org = await createOrg();
    await setupState(org.id, "activated");
    await withSystem((db) => db.query("update billing_accounts set activation_status = 'active', setup_payment_status = 'refunded' where org_id = $1", [org.id]));
    await setTenantStatus(superAdmin, org.id, "suspended", "Unpaid invoice outside the portal");
    expect(await activation(org.id)).toMatchObject({ activation_status: "suspended" });
    await setTenantStatus(superAdmin, org.id, "active");
    expect(await activation(org.id)).toEqual({ activation_status: "active", setup_payment_status: "refunded" });
  });

  it("goes back to pending for a workspace that was never activated", async () => {
    const org = await createOrg();
    await setupState(org.id, "in_setup");
    await setTenantStatus(superAdmin, org.id, "suspended", "Pausing while we sort out the contract");
    await setTenantStatus(superAdmin, org.id, "active");
    expect(await activation(org.id)).toMatchObject({ activation_status: "pending" });
  });

  it("leaves a workspace alone that was not suspended, and never invents an activation for one", async () => {
    const org = await createOrg();
    await withSystem((db) => db.query("update billing_accounts set activation_status = 'pending' where org_id = $1", [org.id]));
    await setTenantStatus(superAdmin, org.id, "active");
    expect(await activation(org.id)).toMatchObject({ activation_status: "pending" });
    // No setup instance at all: pending, not active.
    await setTenantStatus(superAdmin, org.id, "suspended", "A reason for the test");
    await setTenantStatus(superAdmin, org.id, "active");
    expect(await activation(org.id)).toMatchObject({ activation_status: "pending" });
  });

  it("is a Super Admin's act only and is audited", async () => {
    const org = await createOrg();
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    await expect(setTenantStatus(manager, org.id, "suspended", "Not mine to do")).rejects.toThrow(/Only super admins/);
    await setTenantStatus(superAdmin, org.id, "suspended", "Suspended for the test");
    await setTenantStatus(superAdmin, org.id, "active");
    expect((await auditOf(org.id, "tenant.reactivated")).length).toBe(1);
  });
});
