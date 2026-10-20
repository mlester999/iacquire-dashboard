// Automation Studio foundation, part 2: the server-side gates (building, publishing, switching on, testing, running), the engine's own checks
// (a run of a premium workflow is refused or held while the plan is inactive; CRM workflows never are), the fair-use limits and counters,
// the plan's lifecycle (payment failed, verified, expired) and what a lapse does and does not touch. External effects are not involved:
// every workflow here only creates internal tasks, and nothing leaves the machine.
import crypto from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { crmEventDispatch } from "@/server/crm/dispatch";
import { decideApproval } from "@/server/approvals/service";
import { cloneWorkflow, createWorkflow, getWorkflow, listWorkflows, publishWorkflow, requestWorkflowApproval, restoreVersionAsDraft, saveWorkflowDraft, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import { startManualRun, startTestRun } from "@/server/crm/workflows/runs";
import { processWorkflowRuns } from "@/server/crm/workflows/runner";
import { handleInboundWebhook, inboundToken } from "@/server/crm/workflows/inbound";
import { JOBS } from "@/server/ops/tick";
import { studioEntitlement } from "@/server/automation-studio/entitlement";
import { expireSubscription, pauseWorkflowsForLapse, recordPaymentFailed, recordVerifiedPayment, sweepStudioEntitlements } from "@/server/automation-studio/lifecycle";
import { addStudioUsage, studioLimits, studioUsageSnapshot } from "@/server/automation-studio/usage";
import { PAYMENT_GRACE_DAYS, STUDIO_DEFAULT_LIMITS } from "@/lib/automation-studio/plan";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { agencyUser, ctxFor, uid, createUser } from "./support/fixtures";
import { crmOrg, type CrmOrg } from "./support/crm";

const DAY = 86_400_000;

// The sweeper looks at every workspace, and the test database is shared by the whole file, so each test starts with the premium workflows
// that earlier tests left behind out of the way. (Archiving also clears the plan-pause marker, which only a paused workflow may carry.)
beforeEach(async () => {
  await withSystem((db) => db.query("update crm_workflows set status = 'archived', archived_at = now(), entitlement_paused_at = null where origin = 'studio' and status <> 'archived'"));
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A workflow that creates one internal task for each new contact (no outside effect, so no owner approval is involved). */
const taskDef = (title = "Follow up"): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [{ key: "task", kind: "create_task", config: { title, priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
});

/** The same, but it waits a day first, so its runs stay unfinished. */
const waitingDef = (): WorkflowDefinition => ({
  trigger: { type: "contact.created" },
  steps: [
    { key: "pause", kind: "wait", config: { mode: "duration", amount: 1, unit: "days" }, next: "task" },
    { key: "task", kind: "create_task", config: { title: "After the wait", priority: "normal", assignee: "none" }, next: null },
  ] as WorkflowStep[],
});

async function grantPlan(o: CrmOrg, status: "active" | "cancel_requested" | "past_due" | "expired" = "active", opts: { graceEndsAt?: Date } = {}) {
  const grace = opts.graceEndsAt ?? new Date(Date.now() + 3 * DAY);
  await withSystem((db) =>
    db.query(
      `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_at, billing_start_on, past_due_since, grace_ends_at, expired_at)
       values ($1, $2, 29900, 4, 'test', $3, now() - interval '30 days', current_date - 30, $4, $5, $6)`,
      [o.org.id, status, o.people.owner.id, status === "past_due" ? new Date(Date.now() - DAY).toISOString() : null, status === "past_due" ? grace.toISOString() : null, status === "expired" ? new Date().toISOString() : null],
    ),
  );
}

const setPlanStatus = (o: CrmOrg, status: string) =>
  withSystem((db) => db.query("update maintenance_subscriptions set status = $2, expired_at = case when $2 = 'expired' then now() else expired_at end where org_id = $1 and status in ('active', 'cancel_requested', 'past_due', 'expired')", [o.org.id, status]));

async function studioWorkflow(o: CrmOrg, definition: WorkflowDefinition = taskDef(), opts: { activate?: boolean } = {}) {
  const actor = o.actor("owner");
  const { id } = await createWorkflow(actor, { name: `Studio ${uid()}`, definition, origin: "studio" });
  const published = await publishWorkflow(actor, id);
  if (opts.activate !== false) await setWorkflowStatus(actor, id, "active");
  return { id, published };
}

async function crmWorkflow(o: CrmOrg, definition: WorkflowDefinition = taskDef("Core task")) {
  const actor = o.actor("owner");
  const { id } = await createWorkflow(actor, { name: `Core ${uid()}`, definition });
  await publishWorkflow(actor, id);
  await setWorkflowStatus(actor, id, "active");
  return id;
}

async function newContact(o: CrmOrg) {
  return (await createContact(o.actor("owner"), { firstName: "Lead", lastName: uid() })).id;
}

/** Dispatches events and advances runs until nothing is left to do at `now`. */
async function settle(now?: Date) {
  for (let i = 0; i < 25; i++) {
    const d = await crmEventDispatch({ now });
    const r = await processWorkflowRuns({ now });
    if (!d.claimed && !r.claimed && !r.scheduled) return;
  }
}

async function runsOf(workflowId: string) {
  return (await withSystem((db) =>
    db.query<{ id: string; status: string; context: Record<string, unknown>; last_error: string | null; current_step: string | null }>(
      "select id, status, context, last_error, current_step from crm_workflow_runs where workflow_id = $1 order by created_at, id",
      [workflowId],
    ),
  )).rows;
}

const wf = async (id: string) => (await withSystem((db) => db.query<{ status: string; origin: string; entitlement_paused_at: Date | null }>("select status, origin, entitlement_paused_at from crm_workflows where id = $1", [id]))).rows[0];
const usage = async (o: CrmOrg, at = new Date()) => (await withSystem((db) => studioUsageSnapshot(db, o.org.id, at)));
const setLimits = (o: CrmOrg, cols: Record<string, number | boolean>) =>
  withSystem((db) => {
    const names = Object.keys(cols);
    return db.query(
      `insert into automation_studio_limits (org_id, ${names.join(", ")}) values ($1, ${names.map((_, i) => `$${i + 2}`).join(", ")})
       on conflict (org_id) do update set ${names.map((n, i) => `${n} = $${i + 2}`).join(", ")}`,
      [o.org.id, ...names.map((n) => cols[n])],
    );
  });
/** The notices of a kind sent to the workspace, once each (the same notice goes to every owner and manager). */
const notices = async (o: CrmOrg, kind: string) =>
  (await withSystem((db) => db.query<{ title: string; dedupe_key: string | null }>("select distinct on (coalesce(dedupe_key, id::text)) title, dedupe_key from notifications where org_id = $1 and kind = $2 order by coalesce(dedupe_key, id::text), created_at", [o.org.id, kind]))).rows;
const tasksOf = async (o: CrmOrg) => Number((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from tasks where org_id = $1", [o.org.id]))).rows[0].n);

const superAdmin = async () => agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
const subId = async (o: CrmOrg) => (await withSystem((db) => db.query<{ id: string }>("select id from maintenance_subscriptions where org_id = $1 order by created_at desc limit 1", [o.org.id]))).rows[0].id;

// ---------------------------------------------------------------------------
// The gates
// ---------------------------------------------------------------------------

describe("building in Automation Studio needs the plan, on the server", () => {
  it("refuses to create, and creates nothing, without the plan", async () => {
    const o = await crmOrg();
    await expect(createWorkflow(o.actor("owner"), { name: "Studio draft", origin: "studio" })).rejects.toMatchObject({ code: "plan_required" });
    expect((await listWorkflows(o.actor("owner"))).length).toBe(0);
  });

  it("creates it with the plan, marked as built in Automation Studio, and freezes that into the published version", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id, published } = await studioWorkflow(o, taskDef(), { activate: false });
    expect(await wf(id)).toMatchObject({ origin: "studio", status: "draft" });
    const detail = await getWorkflow(o.actor("owner"), id);
    expect(detail).toMatchObject({ origin: "studio", premiumFeatures: ["studio_workflow"], pausedForPlan: false });
    expect(published.created).toBe(true);
    const v = (await withSystem((db) => db.query<{ premium_features: string[] }>("select premium_features from crm_workflow_versions where workflow_id = $1", [id]))).rows[0];
    expect(v.premium_features).toEqual(["studio_workflow"]);
  });

  it("leaves everything built in the CRM screens exactly as it was: no plan needed, not premium", async () => {
    const o = await crmOrg();
    const id = await crmWorkflow(o);
    expect(await wf(id)).toMatchObject({ origin: "crm", status: "active" });
    expect(await getWorkflow(o.actor("owner"), id)).toMatchObject({ origin: "crm", premiumFeatures: [] });
    await newContact(o);
    await settle();
    expect((await runsOf(id)).map((r) => r.status)).toEqual(["completed"]);
    expect(await tasksOf(o)).toBe(1);
    // Core workflows are neither metered nor limited.
    expect((await usage(o)).counters.runs_started.quantity).toBe(0);
  });

  it("refuses every way of changing or starting a premium workflow once the plan lapses, but never reading, pausing or archiving", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o);
    const actor = o.actor("owner");
    await setPlanStatus(o, "expired");

    const { draftRevision } = await getWorkflow(actor, id);
    await expect(saveWorkflowDraft(actor, id, { definition: taskDef("Changed"), expectedRevision: draftRevision })).rejects.toMatchObject({ code: "plan_required" });
    await expect(publishWorkflow(actor, id)).rejects.toMatchObject({ code: "plan_required" });
    await expect(cloneWorkflow(actor, id)).rejects.toMatchObject({ code: "plan_required" });
    await expect(startManualRun(actor, id, { contactId: await newContact(o) })).rejects.toMatchObject({ code: "plan_required" });
    await expect(startTestRun(actor, id, { source: "published", contactId: await newContact(o) })).rejects.toMatchObject({ code: "plan_required" });
    await expect(startTestRun(actor, id, { source: "draft", contactId: await newContact(o) })).rejects.toMatchObject({ code: "plan_required" });
    const versionId = (await getWorkflow(actor, id)).versions[0].id;
    await expect(restoreVersionAsDraft(actor, id, versionId)).rejects.toMatchObject({ code: "plan_required" });

    // Reading and getting out stay available.
    expect((await listWorkflows(actor)).map((w) => w.id)).toContain(id);
    await expect(setWorkflowStatus(actor, id, "paused")).resolves.toMatchObject({ status: "paused" });
    await expect(setWorkflowStatus(actor, id, "active")).rejects.toMatchObject({ code: "plan_required" });
    await expect(setWorkflowStatus(actor, id, "archived")).resolves.toMatchObject({ status: "archived" });
  });

  it("does not let a CRM workflow gain premium status by being saved without the plan", async () => {
    const o = await crmOrg();
    const id = await crmWorkflow(o);
    const actor = o.actor("owner");
    const { draftRevision } = await getWorkflow(actor, id);
    await expect(saveWorkflowDraft(actor, id, { definition: taskDef("Edited"), expectedRevision: draftRevision })).resolves.toMatchObject({ revision: draftRevision + 1 });
  });

  it("copies a premium workflow only with the plan, and the copy is premium too", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o, taskDef(), { activate: false });
    const copy = await cloneWorkflow(o.actor("owner"), id);
    expect(await wf(copy.id)).toMatchObject({ origin: "studio", status: "draft" });
    const crmId = await crmWorkflow(o);
    expect(await wf((await cloneWorkflow(o.actor("owner"), crmId)).id)).toMatchObject({ origin: "crm" });
  });
});

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

describe("the engine and the plan", () => {
  it("runs a premium workflow under the plan and counts what it did", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o);
    await newContact(o);
    await settle();
    expect((await runsOf(id)).map((r) => r.status)).toEqual(["completed"]);
    const u = await usage(o);
    expect(u.counters.runs_started.quantity).toBe(1);
    expect(u.counters.steps_executed.quantity).toBe(1);
    expect(u.counters.step_failures.quantity).toBe(0);
    expect(u.lines.find((l) => l.key === "monthlyRuns")).toMatchObject({ used: 1, limit: STUDIO_DEFAULT_LIMITS.monthlyRuns, custom: false, state: "ok" });
  });

  it("starts nothing for a premium workflow whose plan lapsed, records the refusal, and leaves the CRM workflows running", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o);
    const core = await crmWorkflow(o);
    await setPlanStatus(o, "expired"); // the plan lapsed; the sweeper has not paused anything yet
    await newContact(o);
    await settle();
    expect(await runsOf(id)).toEqual([]);
    expect((await runsOf(core)).map((r) => r.status)).toEqual(["completed"]);
    expect((await usage(o)).counters.runs_refused.quantity).toBe(1);
  });

  it("holds a run in progress when the plan lapses, never failing it, and finishes it once a person turns the workflow back on", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o, waitingDef());
    await newContact(o);
    await settle();
    const [run] = await runsOf(id);
    expect(run.status).toBe("waiting");

    // The plan lapses and the wait is over, but nobody has paused the workflow yet: the engine's own check holds the run.
    await setPlanStatus(o, "expired");
    const later = new Date(Date.now() + 2 * DAY);
    await processWorkflowRuns({ now: later });
    expect((await runsOf(id))[0]).toMatchObject({ status: "waiting" });
    expect((await runsOf(id))[0].last_error).toMatch(/^On hold: Automation Studio isn't active/);
    expect(await tasksOf(o)).toBe(0);

    // The sweeper pauses the workflow (nothing failed, nothing cancelled).
    const swept = await sweepStudioEntitlements(later);
    expect(swept).toMatchObject({ workspacesLapsed: 1, workflowsPaused: 1 });
    expect(await wf(id)).toMatchObject({ status: "paused" });
    expect((await wf(id)).entitlement_paused_at).not.toBeNull();
    expect((await getWorkflow(o.actor("owner"), id)).pausedForPlan).toBe(true);
    await processWorkflowRuns({ now: new Date(later.getTime() + DAY) });
    expect((await runsOf(id))[0].status).toBe("waiting");

    // The plan comes back (an agency member verified a payment): nothing switches itself on.
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'active', expired_at = null where org_id = $1", [o.org.id]));
    await sweepStudioEntitlements(later);
    await processWorkflowRuns({ now: new Date(later.getTime() + DAY) });
    expect(await wf(id)).toMatchObject({ status: "paused" });
    expect((await runsOf(id))[0].status).toBe("waiting");

    // A person checks it and turns it on: validated again, the plan marker cleared, and the run carries on.
    await setWorkflowStatus(o.actor("owner"), id, "active");
    expect(await wf(id)).toMatchObject({ status: "active", entitlement_paused_at: null });
    await processWorkflowRuns({ now: new Date(later.getTime() + DAY) });
    expect((await runsOf(id))[0].status).toBe("completed");
    expect(await tasksOf(o)).toBe(1);
  });

  it("answers an inbound webhook for a lapsed premium workflow with 409 before it can create a contact", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const nonce = crypto.randomBytes(18).toString("base64url");
    const def: WorkflowDefinition = {
      trigger: { type: "inbound_webhook", inbound: { nonce, match: "email_or_phone", createContact: true } },
      steps: [{ key: "task", kind: "create_task", config: { title: "From the webhook", priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
    };
    const { id } = await studioWorkflow(o, def);
    const token = inboundToken(id, nonce);
    const email = `lead-${uid()}@example.test`;
    await setPlanStatus(o, "expired");
    const res = await handleInboundWebhook({ token, body: { email, name: "Webhook Lead" } });
    expect(res.httpStatus).toBe(409);
    expect(JSON.stringify(res.body)).toMatch(/Automation Studio/);
    const created = await withSystem((db) => db.query("select 1 from contacts where org_id = $1 and email = $2", [o.org.id, email]));
    expect(created.rows.length).toBe(0);
    // With the plan back, the same call is accepted.
    await setPlanStatus(o, "active");
    expect((await handleInboundWebhook({ token, body: { email, name: "Webhook Lead" } })).httpStatus).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// Limits and counters
// ---------------------------------------------------------------------------

describe("fair-use limits", () => {
  it("stops new runs at the monthly limit, records each refusal as a run that wasn't started, and tells the owners once", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    await setLimits(o, { monthly_runs: 2 });
    const { id } = await studioWorkflow(o);
    for (let i = 0; i < 4; i++) await newContact(o);
    await settle();
    const runs = await runsOf(id);
    expect(runs.map((r) => r.status).sort()).toEqual(["cancelled", "cancelled", "completed", "completed"]);
    const refused = runs.filter((r) => r.status === "cancelled");
    expect(refused.every((r) => r.context.outcome === "quota_exceeded" && /monthly limit of Automation Studio workflow runs/.test(r.last_error ?? ""))).toBe(true);
    expect((await usage(o)).counters).toMatchObject({ runs_started: { quantity: 2 }, runs_refused: { quantity: 2 } });
    expect(await tasksOf(o)).toBe(2);
    const sent = await notices(o, "usage_limit_approaching");
    expect(sent.length).toBe(1);
    expect(sent[0].title).toMatch(/limit reached/i);
    // A refused run doesn't count against the workflow's hourly limit, and the page lists it as refused, not as a run.
    const summary = (await listWorkflows(o.actor("owner"))).find((w) => w.id === id)!;
    expect(summary.runsToday).toBe(2);
  });

  it("warns at the threshold without stopping anything", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    await setLimits(o, { monthly_runs: 5, warn_at_percent: 80 });
    const { id } = await studioWorkflow(o);
    for (let i = 0; i < 5; i++) await newContact(o);
    await settle();
    expect((await runsOf(id)).map((r) => r.status)).toEqual(Array(5).fill("completed"));
    const sent = await notices(o, "usage_limit_approaching");
    expect(sent.map((n) => n.title)).toEqual([expect.stringMatching(/at 80% of/)]);
  });

  it("only warns, and starts every run, when the workspace's limits are set not to stop work", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    await setLimits(o, { monthly_runs: 1, hard_stop: false });
    const { id } = await studioWorkflow(o);
    await newContact(o);
    await newContact(o);
    await settle();
    expect((await runsOf(id)).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect((await notices(o, "usage_limit_approaching")).length).toBe(1);
  });

  it("limits the runs in progress at once", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    await setLimits(o, { max_live_runs: 1 });
    const { id } = await studioWorkflow(o, waitingDef());
    await newContact(o);
    await settle();
    await newContact(o);
    await settle();
    expect((await runsOf(id)).map((r) => r.status)).toEqual(["waiting", "cancelled"]);
    expect((await runsOf(id))[1].last_error).toMatch(/too many Automation Studio runs in progress/);
  });

  it("limits how many premium workflows can be switched on, and never limits switching one off or any CRM workflow", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    await setLimits(o, { max_active_workflows: 1, monthly_runs: 0 });
    await studioWorkflow(o);
    const second = await studioWorkflow(o, taskDef("Second"), { activate: false });
    await expect(setWorkflowStatus(o.actor("owner"), second.id, "active")).rejects.toMatchObject({ code: "usage_limit" });
    // CRM workflows are outside both limits (a monthly limit of zero stops every premium run, and none of theirs).
    const core = await crmWorkflow(o);
    await newContact(o);
    await settle();
    expect((await runsOf(core)).map((r) => r.status)).toEqual(["completed"]);
  });

  it("falls back to finite platform defaults and reports which limits are the workspace's own", async () => {
    const o = await crmOrg();
    const defaults = await withSystem((db) => studioLimits(db, o.org.id));
    expect(defaults.limits).toEqual(STUDIO_DEFAULT_LIMITS);
    expect(defaults).toMatchObject({ overrides: {}, hardStop: true, warnAtPercent: 80 });
    await setLimits(o, { monthly_steps: 10 });
    const own = await withSystem((db) => studioLimits(db, o.org.id));
    expect(own.overrides).toEqual({ monthlySteps: 10 });
    expect(own.limits.monthlyRuns).toBe(STUDIO_DEFAULT_LIMITS.monthlyRuns);
    expect((await usage(o)).lines.find((l) => l.key === "monthlySteps")).toMatchObject({ custom: true, limit: 10 });
  });

  it("counts per workspace and per month, and refuses a negative or fractional quantity", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    const october = new Date("2026-10-15T00:00:00Z");
    await withSystem(async (db) => {
      await addStudioUsage(db, a.org.id, "builder_messages", 3, { at: october, costMicros: 1500 });
      await addStudioUsage(db, a.org.id, "builder_messages", 2, { at: october, costMicros: 500 });
      await addStudioUsage(db, a.org.id, "integration_calls", 7, { at: new Date("2026-11-02T00:00:00Z") });
    });
    const oct = await usage(a, october);
    expect(oct.counters.builder_messages).toEqual({ quantity: 5, costMicros: 2000 });
    expect(oct.counters.integration_calls.quantity).toBe(0);
    expect(oct.estimatedCostMicros).toBe(2000);
    expect((await usage(a, new Date("2026-11-20T00:00:00Z"))).counters.integration_calls.quantity).toBe(7);
    expect((await usage(b, october)).counters.builder_messages.quantity).toBe(0);
    await expect(withSystem((db) => addStudioUsage(db, a.org.id, "test_runs", -1))).rejects.toThrow(/non-negative whole number/);
    await expect(withSystem((db) => addStudioUsage(db, a.org.id, "test_runs", 1.5))).rejects.toThrow(/non-negative whole number/);
  });

  it("counts a test run of a premium workflow, and not a CRM workflow's", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o);
    const contactId = await newContact(o);
    await startTestRun(o.actor("owner"), id, { source: "published", contactId });
    await startTestRun(o.actor("owner"), id, { source: "draft", contactId });
    await startTestRun(o.actor("owner"), await crmWorkflow(o), { source: "published", contactId });
    expect((await usage(o)).counters.test_runs.quantity).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The plan's lifecycle
// ---------------------------------------------------------------------------

describe("the plan's lifecycle", () => {
  it("keeps Automation Studio working through a payment failure's grace period, then pauses it, and brings it back on a verified payment", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o);
    const core = await crmWorkflow(o);
    const admin = await superAdmin();
    const sub = await subId(o);
    const now = new Date();

    const failed = await recordPaymentFailed(admin, sub, now);
    expect(new Date(failed.graceEndsAt).getTime() - now.getTime()).toBe(PAYMENT_GRACE_DAYS * DAY);
    expect(await withSystem((db) => studioEntitlement(db, o.org.id, now))).toMatchObject({ entitled: true, state: "past_due" });
    expect((await notices(o, "maintenance_update")).map((n) => n.title)).toContain("A payment for your maintenance plan didn't go through");
    await expect(recordPaymentFailed(admin, sub, now)).rejects.toThrow(/can't be marked as past due/);

    // Inside the grace period nothing is paused.
    expect(await sweepStudioEntitlements(new Date(now.getTime() + 3 * DAY))).toMatchObject({ expired: 0, workflowsPaused: 0 });
    expect(await wf(id)).toMatchObject({ status: "active" });

    // The grace period ends: the plan expires, the premium workflow is paused, the CRM workflow is untouched.
    const after = new Date(now.getTime() + (PAYMENT_GRACE_DAYS + 1) * DAY);
    expect(await sweepStudioEntitlements(after)).toMatchObject({ expired: 1, workspacesLapsed: 1, workflowsPaused: 1 });
    expect(await wf(id)).toMatchObject({ status: "paused" });
    expect(await wf(core)).toMatchObject({ status: "active", entitlement_paused_at: null });
    expect((await notices(o, "maintenance_update")).map((n) => n.title)).toContain("An Automation Studio workflow was paused");
    // Running the sweep again changes nothing and says nothing more.
    expect(await sweepStudioEntitlements(after)).toMatchObject({ expired: 0, workspacesLapsed: 0, workflowsPaused: 0 });

    // A verified payment reactivates the plan; the paused workflow waits for a person.
    const back = await recordVerifiedPayment(admin, sub, { paidThroughOn: new Date(after.getTime() + 30 * DAY).toISOString().slice(0, 10) }, after);
    expect(back).toEqual({ reactivated: true, workflowsWaiting: 1 });
    expect(await withSystem((db) => studioEntitlement(db, o.org.id, after))).toMatchObject({ entitled: true, state: "active" });
    expect(await wf(id)).toMatchObject({ status: "paused" });
    expect((await notices(o, "maintenance_update")).map((n) => n.title)).toContain("Your maintenance plan is active again");
    const row = (await withSystem((db) => db.query<{ status: string; past_due_since: Date | null; grace_ends_at: Date | null; expired_at: Date | null; last_payment_verified_by: string | null; paid_through_on: string | null }>(
      "select status, past_due_since, grace_ends_at, expired_at, last_payment_verified_by, paid_through_on::text as paid_through_on from maintenance_subscriptions where id = $1", [sub]))).rows[0];
    expect(row).toMatchObject({ status: "active", past_due_since: null, grace_ends_at: null, expired_at: null, last_payment_verified_by: admin.id });
    expect(row.paid_through_on).toBeTruthy();
    // And the sweeper tells the owners, once, that the paused workflow is waiting.
    expect(await sweepStudioEntitlements(after)).toMatchObject({ workspacesRestored: 1 });
    await sweepStudioEntitlements(after);
    expect((await notices(o, "maintenance_update")).filter((n) => /waiting for you/.test(n.title)).length).toBe(1);
    await setWorkflowStatus(o.actor("owner"), id, "active");
    expect(await wf(id)).toMatchObject({ status: "active", entitlement_paused_at: null });
  });

  it("lets an agency member verify a payment on an active plan without changing its state, and validates the date", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const admin = await superAdmin();
    const sub = await subId(o);
    const now = new Date();
    const through = new Date(now.getTime() + 30 * DAY).toISOString().slice(0, 10);
    await expect(recordVerifiedPayment(admin, sub, { paidThroughOn: "tomorrow" }, now)).rejects.toThrow(/valid date/);
    await expect(recordVerifiedPayment(admin, sub, { paidThroughOn: "2020-01-01" }, now)).rejects.toThrow(/already ended/);
    await expect(recordVerifiedPayment(admin, sub, { paidThroughOn: "2031-01-01" }, now)).rejects.toThrow(/about a year/);
    expect(await recordVerifiedPayment(admin, sub, { paidThroughOn: through }, now)).toEqual({ reactivated: false, workflowsWaiting: 0 });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from maintenance_subscriptions where id = $1", [sub]))).rows[0].status).toBe("active");
  });

  it("will not reactivate an expired plan when the client has already asked for a new one", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const admin = await superAdmin();
    const sub = await subId(o);
    await expireSubscription(admin, sub);
    await withSystem((db) => db.query("insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by) values ($1, 'requested', 29900, 4, 'test', $2)", [o.org.id, o.people.owner.id]));
    await expect(recordVerifiedPayment(admin, sub, { paidThroughOn: new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10) })).rejects.toThrow(/newer plan request/);
    expect((await withSystem((db) => db.query<{ status: string }>("select status from maintenance_subscriptions where id = $1", [sub]))).rows[0].status).toBe("expired");
  });

  it("expires a plan on request, pausing only the premium workflows, and keeps the AI employees and pauses of the workspace as they were", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const { id } = await studioWorkflow(o);
    const core = await crmWorkflow(o);
    const before = (await withSystem((db) => db.query("select id, enabled, status, mode from agent_instances where org_id = $1 order by id", [o.org.id]))).rows;
    const pausesBefore = (await withSystem((db) => db.query("select count(*)::int as n from automation_pauses where org_id = $1", [o.org.id]))).rows[0];
    const admin = await superAdmin();
    expect(await expireSubscription(admin, await subId(o))).toEqual({ pausedWorkflows: 1 });
    expect(await wf(id)).toMatchObject({ status: "paused" });
    expect(await wf(core)).toMatchObject({ status: "active" });
    expect((await withSystem((db) => db.query("select id, enabled, status, mode from agent_instances where org_id = $1 order by id", [o.org.id]))).rows).toEqual(before);
    expect((await withSystem((db) => db.query("select count(*)::int as n from automation_pauses where org_id = $1", [o.org.id]))).rows[0]).toEqual(pausesBefore);
    await expect(expireSubscription(admin, await subId(o))).rejects.toThrow(/can't be expired/);
  });

  it("switches a plan-paused workflow on when its new version is approved, once the plan is back (the plan marker is cleared with the pause)", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const hook = (await withSystem((db) =>
      db.query<{ id: string }>("insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint) values ($1, 'Zapier', 'https://hooks.example.test/in', '{note.added}', 'v1.synthetic', 'abcd') returning id", [o.org.id]),
    )).rows[0].id;
    const definition = (includeContact: boolean): WorkflowDefinition => ({
      trigger: { type: "contact.created" },
      steps: [{ key: "hook", kind: "webhook", config: { subscriptionId: hook, includeContact }, next: null }] as WorkflowStep[],
    });
    const actor = o.actor("owner");
    const owner = ctxFor(o.people.owner, o.org, "owner");
    const { id } = await createWorkflow(actor, { name: `Hooked ${uid()}`, definition: definition(false), origin: "studio" });
    const approve = async () => {
      const req = await requestWorkflowApproval(actor, id, null, { activate: true });
      expect(req.status).toBe("requested");
      expect((await decideApproval(owner, req.approvalId!, "approve")).outcome?.status).toBe("succeeded");
    };
    expect((await publishWorkflow(actor, id)).needsApproval).toBe(true);
    await approve();
    expect(await wf(id)).toMatchObject({ status: "active" });

    // The plan lapses and the sweeper pauses it; then the plan is back and a new version is published and approved.
    await setPlanStatus(o, "expired");
    await sweepStudioEntitlements();
    expect((await wf(id)).entitlement_paused_at).not.toBeNull();
    await setPlanStatus(o, "active");
    const { draftRevision } = await getWorkflow(actor, id);
    await saveWorkflowDraft(actor, id, { definition: definition(true), expectedRevision: draftRevision });
    expect((await publishWorkflow(actor, id)).version).toBe(2);
    expect(await wf(id)).toMatchObject({ status: "paused" });
    await approve();
    expect(await wf(id)).toMatchObject({ status: "active", entitlement_paused_at: null });
  });

  it("approves a version but does not switch it on while the plan is inactive", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const hook = (await withSystem((db) =>
      db.query<{ id: string }>("insert into crm_webhook_subscriptions (org_id, name, url, event_types, secret_ciphertext, secret_hint) values ($1, 'Zapier', 'https://hooks.example.test/in', '{note.added}', 'v1.synthetic', 'abcd') returning id", [o.org.id]),
    )).rows[0].id;
    const actor = o.actor("owner");
    const { id } = await createWorkflow(actor, {
      name: `Hooked ${uid()}`, origin: "studio",
      definition: { trigger: { type: "contact.created" }, steps: [{ key: "hook", kind: "webhook", config: { subscriptionId: hook, includeContact: false }, next: null }] as WorkflowStep[] },
    });
    await publishWorkflow(actor, id);
    const req = await requestWorkflowApproval(actor, id, null, { activate: true });
    await setPlanStatus(o, "expired");
    const decided = await decideApproval(ctxFor(o.people.owner, o.org, "owner"), req.approvalId!, "approve");
    expect(decided.outcome?.status).toBe("succeeded");
    expect(decided.outcome?.detail).toMatch(/It wasn't switched on: Your plan has expired/);
    expect(await wf(id)).toMatchObject({ status: "draft" });
  });

  it("does not mistake a person's own pause for a plan pause", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const mine = await studioWorkflow(o);
    const other = await studioWorkflow(o);
    await setWorkflowStatus(o.actor("owner"), mine.id, "paused");
    await withSystem((db) => pauseWorkflowsForLapse(db, o.org.id));
    expect(await wf(mine.id)).toMatchObject({ status: "paused", entitlement_paused_at: null });
    expect((await wf(other.id)).entitlement_paused_at).not.toBeNull();
  });

  it("keeps one workspace's lapse away from another's", async () => {
    const a = await crmOrg();
    const b = await crmOrg();
    await grantPlan(a);
    await grantPlan(b);
    const wa = await studioWorkflow(a);
    const wb = await studioWorkflow(b);
    await setPlanStatus(a, "expired");
    await sweepStudioEntitlements();
    expect(await wf(wa.id)).toMatchObject({ status: "paused" });
    expect(await wf(wb.id)).toMatchObject({ status: "active" });
    expect((await usage(b)).counters.runs_refused.quantity).toBe(0);
  });

  it("only lets agency members with maintenance access change a plan, and only for the workspaces they can see", async () => {
    const o = await crmOrg();
    await grantPlan(o);
    const sub = await subId(o);
    const client = agencyUser(o.people.owner, "agency_staff");
    // A client's owner dressed up as nothing: platformRole "none" is refused outright.
    await expect(recordPaymentFailed({ ...client, platformRole: "none" }, sub)).rejects.toThrow(/Agency access is required/);
    // Agency staff who aren't assigned to the workspace can't see its plan.
    const unassigned = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    await expect(recordPaymentFailed(unassigned, sub)).rejects.toThrow(/not found/i);
    await expect(recordVerifiedPayment(unassigned, sub, { paidThroughOn: new Date(Date.now() + 5 * DAY).toISOString().slice(0, 10) })).rejects.toThrow(/not found/i);
    await expect(expireSubscription(unassigned, sub)).rejects.toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// Version history and rollback
// ---------------------------------------------------------------------------

describe("restoring an earlier version", () => {
  it("puts the old content back as a draft without touching what is published", async () => {
    const o = await crmOrg();
    const actor = o.actor("owner");
    const { id } = await createWorkflow(actor, { name: `History ${uid()}`, definition: taskDef("Version one") });
    await publishWorkflow(actor, id);
    let d = await getWorkflow(actor, id);
    await saveWorkflowDraft(actor, id, { definition: taskDef("Version two"), expectedRevision: d.draftRevision });
    const v2 = await publishWorkflow(actor, id);
    expect(v2.version).toBe(2);
    d = await getWorkflow(actor, id);
    const v1 = d.versions.find((v) => v.version === 1)!;

    const restored = await restoreVersionAsDraft(actor, id, v1.id, { expectedRevision: d.draftRevision });
    expect(restored).toMatchObject({ version: 1, revision: d.draftRevision + 1 });
    const after = await getWorkflow(actor, id);
    expect((after.draft.steps[0].config as { title: string }).title).toBe("Version one");
    expect(after.publishedVersion).toBe(2);
    expect(after.unpublishedChanges).toBe(true);
    // Publishing it makes a new version 3 with version 1's content (and so its hash).
    const v3 = await publishWorkflow(actor, id);
    expect(v3).toMatchObject({ version: 3, created: true, contentHash: v1.contentHash });
  });

  it("refuses stale revisions, other workflows' versions, and anyone without the automations permission", async () => {
    const o = await crmOrg();
    const actor = o.actor("owner");
    const { id } = await createWorkflow(actor, { name: `History ${uid()}`, definition: taskDef() });
    await publishWorkflow(actor, id);
    const other = await createWorkflow(actor, { name: `Other ${uid()}`, definition: taskDef("Other") });
    await publishWorkflow(actor, other.id);
    const d = await getWorkflow(actor, id);
    const otherVersion = (await getWorkflow(actor, other.id)).versions[0].id;
    await expect(restoreVersionAsDraft(actor, id, d.versions[0].id, { expectedRevision: d.draftRevision + 5 })).rejects.toMatchObject({ code: "conflict" });
    await expect(restoreVersionAsDraft(actor, id, otherVersion)).rejects.toMatchObject({ code: "not_found" });
    await expect(restoreVersionAsDraft(actor, "not-a-uuid", d.versions[0].id)).rejects.toMatchObject({ code: "not_found" });
    await expect(restoreVersionAsDraft(o.actor("viewer"), id, d.versions[0].id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(restoreVersionAsDraft(o.actor("support"), id, d.versions[0].id)).rejects.toMatchObject({ code: "forbidden" });
  });

  it("does not bring a retired inbound webhook URL back to life", async () => {
    const o = await crmOrg();
    const actor = o.actor("owner");
    const nonce = crypto.randomBytes(18).toString("base64url");
    const def: WorkflowDefinition = {
      trigger: { type: "inbound_webhook", inbound: { nonce, match: "none", createContact: false } },
      steps: [{ key: "task", kind: "create_task", config: { title: "Hook", priority: "normal", assignee: "none" }, next: null }] as WorkflowStep[],
    };
    const { id } = await createWorkflow(actor, { name: `Hook ${uid()}`, definition: def });
    await publishWorkflow(actor, id);
    const d = await getWorkflow(actor, id);
    await restoreVersionAsDraft(actor, id, d.versions[0].id);
    const after = await getWorkflow(actor, id);
    expect(after.draft.trigger.inbound?.nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    expect(after.draft.trigger.inbound?.nonce).not.toBe(nonce);
  });
});

// ---------------------------------------------------------------------------
// The scheduler
// ---------------------------------------------------------------------------

describe("the scheduler job", () => {
  it("is registered, runs on every tick without help from the interval helper, and reports what it did", async () => {
    const job = JOBS.find((j) => j.name === "studioEntitlementSweep");
    expect(job).toBeDefined();
    expect(job!.run.toString()).not.toMatch(/withinInterval/);
    const o = await crmOrg();
    await grantPlan(o);
    await studioWorkflow(o);
    await setPlanStatus(o, "expired");
    expect(await job!.run()).toBeGreaterThanOrEqual(1);
    expect(await job!.run()).toBe(0);
  });
});
