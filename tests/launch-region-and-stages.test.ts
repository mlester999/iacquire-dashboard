// The client-confirmed refinements of a new workspace in the guided launch setup (currency and phone country from the time zone, the client's own sales steps as a pipeline, asking the
// automatic CRM setup to run again) and the "waiting for capacity" state of an employee. What it proves: each one is offered as an optional step that never moves the percentage; a
// button writes only when a person with the right permission presses it, after the questionnaire is submitted and the setup payment confirmed, never for a sample workspace and never
// on answers the client has not approved; a second press changes nothing; another workspace is untouched; and the panel's "waiting for capacity" agrees with the claim that really
// holds the job. Test database only: nothing is sent, booked or connected.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { deriveLaunchReadiness } from "@/lib/launch-readiness";
import type { AgentRoleKey } from "@/lib/agents";
import { defaultSettings } from "@/server/workforce/compiler";
import { createConfigVersion } from "@/server/workforce/service";
import { claimHermesProvisionerJob, completeHermesProvisionerJob } from "@/server/workforce/hermes-provisioner";
import { requestProvisioning } from "@/server/workforce/provisioning";
import { getLaunchReadiness, loadLaunchFacts, loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";
import { runLaunchIntent } from "@/server/setup/launch-intents";
import { readPendingAnswerChanges } from "@/server/onboarding/pending-changes";
import { updateWorkspaceSettings } from "@/server/crm/workspace";
import { addMember, agencyUser, createOrg, createUser, ctxFor, uid } from "./support/fixtures";
import { crmOrg, type CrmOrg, type CrmWho, CRM_ROLES } from "./support/crm";
import { clearSetupPayment } from "./support/billing";
import { itemOf, markSubmitted } from "./support/launch";

const STEPS = "1. Enquiry. 2. Qualify. 3. Free inspection. 4. Quote. 5. Book the job.";
// A workspace nobody has changed: the database defaults.
const STARTING = { default_currency: "USD", default_calling_code: null };
const STEP_NAMES = ["Enquiry", "Qualify", "Free inspection", "Quote", "Book the job", "Won", "Lost"];

const flag = (on: boolean) => {
  process.env.CLIENT_CRM_AUTO_SETUP_ENABLED = on ? "true" : "false";
  resetEnvCache();
};
const before = process.env.CLIENT_CRM_AUTO_SETUP_ENABLED;
beforeAll(() => flag(false));
afterEach(() => {
  flag(false);
  vi.unstubAllEnvs();
  resetEnvCache();
});
afterAll(() => {
  if (before === undefined) delete process.env.CLIENT_CRM_AUTO_SETUP_ENABLED;
  else process.env.CLIENT_CRM_AUTO_SETUP_ENABLED = before;
  resetEnvCache();
});

const q = async <T>(sql: string, params: unknown[]) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const auditCount = async (orgId: string, action: string) => Number((await q<{ n: string }>("select count(*)::text as n from audit_logs where org_id = $1 and action = $2", [orgId, action]))[0].n);
const workspace = async (orgId: string) => (await q<{ default_currency: string; default_calling_code: string | null }>("select default_currency, default_calling_code from crm_workspaces where org_id = $1", [orgId]))[0];
const pipelines = (orgId: string) => q<{ id: string; name: string; is_default: boolean; archived_at: Date | null }>("select id, name, is_default, archived_at from crm_pipelines where org_id = $1 and archived_at is null order by created_at", [orgId]);

async function client(opts: { name: string; timezone?: string; answers?: Record<string, unknown>; submitted?: boolean; paid?: boolean; creatorId?: string | null }): Promise<CrmOrg & { ctx: ReturnType<typeof ctxFor>; of: (who: CrmWho) => ReturnType<typeof ctxFor> }> {
  const c = await crmOrg({ name: opts.name, timezone: opts.timezone });
  await withSystem(async (db) => {
    await db.query("update organizations set onboarding_completed_at = case when $2::boolean then now() end, created_by = $3 where id = $1", [c.org.id, opts.submitted !== false, opts.creatorId ?? null]);
    for (const [id, value] of Object.entries(opts.answers ?? {})) await db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, $2, $3::jsonb)", [c.org.id, id, JSON.stringify(value)]);
  });
  if (opts.paid !== false) await clearSetupPayment(c.org.id);
  const of = (who: CrmWho) => ctxFor(c.people[who], c.org, CRM_ROLES[who]);
  return { ...c, ctx: of("owner"), of };
}

/**
 * Marks the questionnaire approved, and lets the clock move on before the caller edits an answer. A trigger stamps an edited answer with the time of the edit, so editing in the same
 * instant as the approval would read as not edited.
 */
async function approvedJustNow(orgId: string) {
  await markSubmitted(orgId);
  await new Promise((resolve) => setTimeout(resolve, 40));
}

const manila = (name: string, extra: Record<string, unknown> = {}) => client({ name, timezone: "Asia/Manila", answers: { "a.timezone": "Asia/Manila", ...extra } });

describe("currency and phone country from the client's time zone", () => {
  it("is offered for a Manila workspace as an optional step, applied only when the owner presses it, and a second press changes nothing", async () => {
    const c = await manila("Region Manila Dental");
    const offered = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(offered, "crm.region")).toMatchObject({ state: "action_required", required: false, owner: "you", action: { label: "Use PHP and +63", intent: "confirm_region_defaults" } });
    expect(itemOf(offered, "crm.region").detail).toContain("Philippines");
    // Offering is not applying.
    expect(await workspace(c.org.id)).toEqual(STARTING);

    const res = await runLaunchIntent(c.ctx, "confirm_region_defaults");
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining("PHP and +63") });
    expect(await workspace(c.org.id)).toEqual({ default_currency: "PHP", default_calling_code: "63" });
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(1);
    expect((await q<{ actor_user_id: string }>("select actor_user_id from audit_logs where org_id = $1 and action = 'onboarding.region_defaults_applied'", [c.org.id]))[0].actor_user_id).toBe(c.people.owner.id);
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "crm.region")).toMatchObject({ state: "done", required: false });

    const again = await runLaunchIntent(c.ctx, "confirm_region_defaults");
    expect(again).toMatchObject({ ok: true, message: expect.stringContaining("Nothing was changed") });
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(1);
  });

  it("never moves the percentage, the state or the checks counted, whether it is on offer or in place", async () => {
    const c = await manila("Region Percent Dental");
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.crm.region).toMatchObject({ state: "offer", currency: "PHP", callingCode: "63", canConfirm: true });
    const withOffer = deriveLaunchReadiness(facts);
    const without = deriveLaunchReadiness({ ...facts, crm: { ...facts.crm, region: undefined, pipelineDraft: undefined } });
    expect([withOffer.state, withOffer.percent, withOffer.passed, withOffer.total]).toEqual([without.state, without.percent, without.passed, without.total]);
    expect(withOffer.blocking.map((i) => i.key)).toEqual(without.blocking.map((i) => i.key));
  });

  it("is closed for good once somebody set a value, and the button then says it was left alone", async () => {
    const c = await manila("Region Edited Dental");
    await updateWorkspaceSettings(c.actor("owner"), { defaultCurrency: "EUR" });
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.crm.region).toBeUndefined();
    expect(await runLaunchIntent(c.ctx, "confirm_region_defaults")).toMatchObject({ ok: false, message: expect.stringContaining("left alone") });
    expect((await workspace(c.org.id))!.default_currency).toBe("EUR");
    expect(await auditCount(c.org.id, "onboarding.region_defaults_applied")).toBe(0);
  });

  it("is not offered when the time zone points to no one country", async () => {
    const c = await client({ name: "Region Unknown Dental", timezone: "UTC", answers: { "a.timezone": "UTC" } });
    expect((await loadLaunchFacts(c.ctx))!.crm.region).toBeUndefined();
    expect(await runLaunchIntent(c.ctx, "confirm_region_defaults")).toMatchObject({ ok: false, message: expect.stringContaining("one country") });
  });

  it("is refused, with nothing written, for a role that cannot change the workspace profile, before the questionnaire, before the payment, in a sample workspace, and on unapproved answers", async () => {
    const c = await manila("Region Refusals Dental");
    for (const who of ["sales", "support", "viewer", "setter"] as const) await expect(runLaunchIntent(c.of(who), "confirm_region_defaults"), who).rejects.toThrow(/owner or admin/i);

    const early = await manila("Region Early Dental");
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [early.org.id]));
    await expect(runLaunchIntent(early.ctx, "confirm_region_defaults")).rejects.toThrow(/Submit your company information/i);

    const unpaid = await manila("Region Unpaid Dental");
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [unpaid.org.id]));
    await expect(runLaunchIntent(unpaid.ctx, "confirm_region_defaults")).rejects.toThrow(/setup payment is not confirmed/i);

    const demo = await manila("Region Sample Dental");
    demo.ctx.org.isDemo = true;
    await expect(runLaunchIntent(demo.ctx, "confirm_region_defaults")).rejects.toThrow(/sample workspace/i);

    const waiting = await manila("Region Unapproved Dental");
    await approvedJustNow(waiting.org.id);
    await withSystem((db) => db.query("update onboarding_answers set value = to_jsonb('Asia/Tokyo'::text), updated_at = now() + interval '1 minute' where org_id = $1 and question_id = 'a.timezone'", [waiting.org.id]));
    expect((await withSystem((db) => readPendingAnswerChanges(db, waiting.org.id))).pending).toBe(true);
    expect((await loadLaunchFacts(waiting.ctx))!.crm.region).toBeUndefined();
    await expect(runLaunchIntent(waiting.ctx, "confirm_region_defaults")).rejects.toThrow(/not approved/i);

    for (const x of [c, early, unpaid, demo, waiting]) {
      expect(await workspace(x.org.id)).toEqual(STARTING);
      expect(await auditCount(x.org.id, "onboarding.region_defaults_applied")).toBe(0);
    }
  });

  it("keeps two workspaces apart, and offers an admin the same step as the owner", async () => {
    const a = await manila("Region Apart A");
    const b = await manila("Region Apart B");
    expect((await runLaunchIntent(a.of("manager"), "confirm_region_defaults")).ok).toBe(true);
    expect(await workspace(a.org.id)).toEqual({ default_currency: "PHP", default_calling_code: "63" });
    expect(await workspace(b.org.id)).toEqual(STARTING);
    expect((await loadLaunchFacts(b.ctx))!.crm.region).toMatchObject({ state: "offer" });
  });
});

describe("the client's own sales steps as a pipeline", () => {
  const withSteps = (name: string, extra: Record<string, unknown> = {}) => client({ name, timezone: "America/Chicago", answers: { "a.timezone": "America/Chicago", "d.sales_process": STEPS, ...extra } });

  it("is offered with the client's own words, added as a new pipeline once, and the starting pipeline is the only thing it may replace", async () => {
    const c = await withSteps("Stages Roofing");
    const offered = itemOf((await getLaunchReadiness(c.ctx))!, "crm.stages");
    expect(offered).toMatchObject({ state: "action_required", required: false, owner: "you", action: { label: "Add my sales steps", intent: "apply_pipeline_stages" } });
    expect(offered.detail).toContain("Enquiry, Qualify, Free inspection, Quote, Book the job, Won, Lost");
    expect(await pipelines(c.org.id)).toHaveLength(0);

    const res = await runLaunchIntent(c.ctx, "apply_pipeline_stages");
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining("7 stages") });
    const made = (await pipelines(c.org.id)).filter((p) => p.name === "Your sales process");
    expect(made).toHaveLength(1);
    expect((await q<{ name: string }>("select name from crm_pipeline_stages where pipeline_id = $1 order by position", [made[0].id])).map((s) => s.name)).toEqual(STEP_NAMES);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(1);
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "crm.stages")).toMatchObject({ state: "done", required: false });

    expect(await runLaunchIntent(c.ctx, "apply_pipeline_stages")).toMatchObject({ ok: true, message: expect.stringContaining("already in your CRM") });
    expect((await pipelines(c.org.id)).filter((p) => p.name === "Your sales process")).toHaveLength(1);
    expect(await auditCount(c.org.id, "onboarding.pipeline_stages_applied")).toBe(1);
  });

  it("never moves the percentage, and is not offered for an answer that is not a clear list of steps", async () => {
    const c = await withSteps("Stages Percent Roofing");
    const facts = (await loadLaunchFacts(c.ctx))!;
    expect(facts.crm.pipelineDraft).toMatchObject({ state: "offer", stages: STEP_NAMES, canApply: true });
    const a = deriveLaunchReadiness(facts);
    const b = deriveLaunchReadiness({ ...facts, crm: { ...facts.crm, pipelineDraft: undefined, region: undefined } });
    expect([a.state, a.percent, a.passed, a.total]).toEqual([b.state, b.percent, b.passed, b.total]);

    const prose = await client({ name: "Stages Prose Roofing", answers: { "d.sales_process": "We talk to the customer, look at the roof and send a quote when we can. Then we hope they say yes." } });
    expect((await loadLaunchFacts(prose.ctx))!.crm.pipelineDraft).toBeUndefined();
    expect(await runLaunchIntent(prose.ctx, "apply_pipeline_stages")).toMatchObject({ ok: false, message: expect.stringContaining("not a clear list") });
    expect(await pipelines(prose.org.id)).toHaveLength(0);
  });

  it("is refused, with nothing written, for roles without pipeline access, before the questionnaire or the payment, in a sample workspace and on unapproved answers; an admin may", async () => {
    const c = await withSteps("Stages Refusals Roofing");
    for (const who of ["support", "viewer", "setter"] as const) await expect(runLaunchIntent(c.of(who), "apply_pipeline_stages"), who).rejects.toThrow(/role doesn.t allow this/i);

    const early = await withSteps("Stages Early Roofing");
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [early.org.id]));
    await expect(runLaunchIntent(early.ctx, "apply_pipeline_stages")).rejects.toThrow(/Submit your company information/i);

    const unpaid = await withSteps("Stages Unpaid Roofing");
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [unpaid.org.id]));
    await expect(runLaunchIntent(unpaid.ctx, "apply_pipeline_stages")).rejects.toThrow(/setup payment is not confirmed/i);

    const demo = await withSteps("Stages Sample Roofing");
    demo.ctx.org.isDemo = true;
    await expect(runLaunchIntent(demo.ctx, "apply_pipeline_stages")).rejects.toThrow(/sample workspace/i);

    const waiting = await withSteps("Stages Unapproved Roofing");
    await approvedJustNow(waiting.org.id);
    await withSystem((db) => db.query("update onboarding_answers set value = to_jsonb($2::text), updated_at = now() + interval '1 minute' where org_id = $1 and question_id = 'd.sales_process'", [waiting.org.id, "1. Call. 2. Visit. 3. Quote. 4. Close."]));
    await expect(runLaunchIntent(waiting.ctx, "apply_pipeline_stages")).rejects.toThrow(/not approved/i);

    for (const x of [c, early, unpaid, demo, waiting]) expect((await pipelines(x.org.id)).filter((p) => p.name === "Your sales process")).toHaveLength(0);
    expect((await runLaunchIntent(c.of("manager"), "apply_pipeline_stages")).ok).toBe(true);
  });

  it("keeps two workspaces apart", async () => {
    const a = await withSteps("Stages Apart A");
    const b = await withSteps("Stages Apart B");
    await runLaunchIntent(a.ctx, "apply_pipeline_stages");
    expect((await pipelines(a.org.id)).some((p) => p.name === "Your sales process")).toBe(true);
    expect((await pipelines(b.org.id)).some((p) => p.name === "Your sales process")).toBe(false);
    expect((await loadLaunchFacts(b.ctx))!.crm.pipelineDraft).toMatchObject({ state: "offer" });
  });
});

describe("asking the automatic CRM setup to run again", () => {
  const superAdmin = async () => {
    const user = await createUser({ platformRole: "agency_super_admin", name: "Agency Admin" });
    return { ...agencyUser(user, "agency_super_admin"), id: user.id };
  };
  const ROOFING = { "a.business_name": "Brightside Roofing", "a.industry": "home_services", "a.timezone": "America/Chicago", "b.appointments": false };
  const applications = async (orgId: string) => Number((await q<{ n: string }>("select count(*)::text as n from crm_blueprint_applications where org_id = $1", [orgId]))[0].n);

  it("does nothing while the automatic setup is off, and offers no button", async () => {
    flag(false);
    const creator = await superAdmin();
    const c = await client({ name: "Retry Off Roofing", creatorId: creator.id, answers: ROOFING });
    expect((await loadLaunchFacts(c.ctx))!.crm.canRetry).toBeUndefined();
    expect(await runLaunchIntent(c.ctx, "retry_crm_setup")).toMatchObject({ ok: false, message: expect.stringContaining("switched off") });
    expect(await applications(c.org.id)).toBe(0);
  });

  it("applies the industry CRM once when it is on, says what happened, and a second press changes nothing", async () => {
    flag(true);
    const creator = await superAdmin();
    const c = await client({ name: "Retry On Roofing", creatorId: creator.id, answers: ROOFING });
    expect((await loadLaunchFacts(c.ctx))!.crm.canRetry).toBe(true);
    const res = await runLaunchIntent(c.ctx, "retry_crm_setup");
    expect(res).toMatchObject({ ok: true, message: expect.stringContaining("Nothing was sent") });
    expect(await applications(c.org.id)).toBe(1);
    expect(await auditCount(c.org.id, "crm.auto_setup_applied")).toBe(1);
    const trigger = (await q<{ metadata: { trigger: string } }>("select metadata from audit_logs where org_id = $1 and action = 'crm.auto_setup_applied'", [c.org.id]))[0].metadata.trigger;
    expect(trigger).toBe("launch_retry");
    // Nothing customer-facing came with it.
    expect(await q("select 1 from crm_message_templates where org_id = $1 and status <> 'draft'", [c.org.id])).toHaveLength(0);

    const again = await runLaunchIntent(c.ctx, "retry_crm_setup");
    expect(again).toMatchObject({ ok: true, message: expect.stringContaining("already set up") });
    expect(await applications(c.org.id)).toBe(1);
    expect(await auditCount(c.org.id, "crm.auto_setup_applied")).toBe(1);
    // With the setup in place there is nothing to retry.
    expect((await loadLaunchFacts(c.ctx))!.crm.canRetry).toBeUndefined();
  });

  it("writes nothing and says a person must apply it when the agency person who created the client can no longer do it", async () => {
    flag(true);
    const c = await client({ name: "Retry Orphan Roofing", creatorId: null, answers: ROOFING });
    const res = await runLaunchIntent(c.ctx, "retry_crm_setup");
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("person at iAcquire") });
    expect(await applications(c.org.id)).toBe(0);
    await runLaunchIntent(c.ctx, "retry_crm_setup");
    expect(await auditCount(c.org.id, "crm.auto_setup_waiting_for_person")).toBe(1);
    // Waiting for a person is iAcquire's, so no button is offered for it.
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "crm.blueprint").action).toBeUndefined();
  });

  it("waits for the client to approve an edit of their answers: no button, a refused press, nothing installed from the unapproved industry; approving opens it", async () => {
    flag(true);
    const creator = await superAdmin();
    const c = await client({ name: "Retry Unapproved Roofing", creatorId: creator.id, answers: ROOFING });
    await approvedJustNow(c.org.id);
    expect((await loadLaunchFacts(c.ctx))!.crm.canRetry).toBe(true);
    // The owner changes the industry and has not approved it.
    await withSystem((db) => db.query("update onboarding_answers set value = to_jsonb('professional_services'::text), updated_at = now() + interval '1 minute' where org_id = $1 and question_id = 'a.industry'", [c.org.id]));
    expect((await withSystem((db) => readPendingAnswerChanges(db, c.org.id))).pending).toBe(true);
    expect((await loadLaunchFacts(c.ctx))!.crm.canRetry).toBeUndefined();
    await expect(runLaunchIntent(c.ctx, "retry_crm_setup")).rejects.toThrow(/not approved/i);
    expect(await applications(c.org.id)).toBe(0);
    expect(await auditCount(c.org.id, "crm.auto_setup_failed")).toBe(0);
    // Approving the change opens the step again, and it then runs on what was approved.
    await withSystem((db) => db.query("update onboarding_responses set submitted_at = now() + interval '2 minutes' where org_id = $1", [c.org.id]));
    expect((await withSystem((db) => readPendingAnswerChanges(db, c.org.id))).pending).toBe(false);
    expect((await loadLaunchFacts(c.ctx))!.crm.canRetry).toBe(true);
    expect(await runLaunchIntent(c.ctx, "retry_crm_setup")).toMatchObject({ ok: true });
    expect(await applications(c.org.id)).toBe(1);
  });

  it("does not say everything is set up when the application landed only in part", async () => {
    flag(true);
    const creator = await superAdmin();
    const c = await client({ name: "Retry Partial Roofing", creatorId: creator.id, answers: ROOFING });
    expect(await runLaunchIntent(c.ctx, "retry_crm_setup")).toMatchObject({ ok: true, message: expect.stringContaining("is set up") });
    await withSystem((db) => db.query("update crm_blueprint_applications set status = 'partially_applied' where org_id = $1", [c.org.id]));
    const again = await runLaunchIntent(c.ctx, "retry_crm_setup");
    expect(again).toMatchObject({ ok: false, message: expect.stringContaining("Part of your industry setup was applied") });
    expect(again.message).not.toContain("is set up");
  });

  it("is refused for a role that cannot manage the workspace, before the questionnaire or the payment, and in a sample workspace, with nothing written", async () => {
    flag(true);
    const creator = await superAdmin();
    const c = await client({ name: "Retry Refusals Roofing", creatorId: creator.id, answers: ROOFING });
    for (const who of ["sales", "support", "viewer", "setter"] as const) await expect(runLaunchIntent(c.of(who), "retry_crm_setup"), who).rejects.toThrow(/owner or admin/i);
    const early = await client({ name: "Retry Early Roofing", creatorId: creator.id, answers: ROOFING, submitted: false });
    await expect(runLaunchIntent(early.ctx, "retry_crm_setup")).rejects.toThrow(/Submit your company information/i);
    const unpaid = await client({ name: "Retry Unpaid Roofing", creatorId: creator.id, answers: ROOFING, paid: false });
    await expect(runLaunchIntent(unpaid.ctx, "retry_crm_setup")).rejects.toThrow(/setup payment is not confirmed/i);
    const demo = await client({ name: "Retry Sample Roofing", creatorId: creator.id, answers: ROOFING });
    demo.ctx.org.isDemo = true;
    await expect(runLaunchIntent(demo.ctx, "retry_crm_setup")).rejects.toThrow(/sample workspace/i);
    for (const x of [c, early, unpaid, demo]) expect(await applications(x.org.id)).toBe(0);
  });
});

describe("waiting for capacity", () => {
  const gatewayId = randomUUID();
  const setMax = (max: number) => {
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    vi.stubEnv("HERMES_PROVISIONER_MAX_PROFILES", String(max));
    resetEnvCache();
  };

  /** A paid, onboarded client with a verified owner and `roles` employees that each have an approved configuration and a queued profile job. */
  async function team(label: string, roles: number) {
    const org = await createOrg({ name: `${label} ${uid()}` });
    await clearSetupPayment(org.id);
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [org.id]));
    const agents = (await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey }>("select id, role_key from agent_instances where org_id = $1 order by role_key", [org.id]))).rows;
    await withSystem(async (db) => {
      for (const agent of agents.slice(0, roles)) await createConfigVersion(db, { orgId: org.id, agentId: agent.id, settings: defaultSettings(agent.role_key), source: "onboarding", userId: owner.id, apply: true });
      for (const agent of agents.slice(roles)) await db.query("update agent_instances set enabled = false where id = $1", [agent.id]);
    });
    await withSystem((db) => requestProvisioning(db, org.id, owner.id));
    return { org, owner };
  }

  // Both tests need the pinned gateway, so it is made once for the group: neither depends on the other having run.
  beforeAll(async () => {
    await withSystem((db) => db.query(
      "insert into hermes_gateways (id, label, environment, base_url, gateway_type, status, profile_creation_status, provisioner_isolation_verified_at) values ($1, 'Launch capacity test runtime', 'development', $2, 'multiplexed_profiles', 'connected', 'restricted_service_verified', now()) on conflict (id) do nothing",
      [gatewayId, `https://client-${gatewayId.replaceAll("-", "")}.hermes.test`],
    ));
  });

  it("reads the same hold the claim computes: waiting, never failed, announced to the agency, and released when there is room", async () => {
    setMax(5);
    const admin = await createUser({ platformRole: "agency_super_admin" });
    const first = await team("Capacity First", 5);
    const second = await team("Capacity Second", 5);
    const heldRoles = async (orgId: string) => (await loadLaunchFactsForOrg(orgId))!.employees.filter((e) => e.capacityHeld).length;

    // Nothing has begun: both teams fit, so the panel says nothing is held.
    expect(await heldRoles(first.org.id)).toBe(0);
    expect(await heldRoles(second.org.id)).toBe(0);

    // The first team begins and takes the room; the second must wait as a whole.
    const claimed: string[] = [];
    for (let i = 0; i < 5; i += 1) claimed.push((await claimHermesProvisionerJob(gatewayId))!.orgId);
    expect(new Set(claimed)).toEqual(new Set([first.org.id]));
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    expect(await heldRoles(second.org.id)).toBe(5);
    expect(await heldRoles(first.org.id)).toBe(0);

    const facts = (await loadLaunchFactsForOrg(second.org.id))!;
    const now = new Date(Date.now() + 5 * 60_000);
    const young = deriveLaunchReadiness(facts, now);
    for (const e of facts.employees.filter((x) => x.entitled)) {
      const item = itemOf(young, `employees.${e.role}`);
      expect(item.state, e.role).toBe("in_progress");
      expect(item.owner).toBe("iacquire");
      expect(item.detail).toContain("Waiting for capacity (iAcquire)");
      expect(item.stages?.map((s) => `${s.key}:${s.state}`)).toEqual(["queued:done", "profile:pending", "verified:pending", "tools:pending", "ready:pending"]);
    }
    expect(young.state).not.toBe("ready_to_launch");
    expect(young.blocking.filter((i) => i.key.startsWith("employees."))).toEqual([]);
    // The first team's employees are an ordinary queue, not a capacity hold.
    expect(itemOf(deriveLaunchReadiness((await loadLaunchFactsForOrg(first.org.id))!, now), "employees.crm_manager").detail).not.toContain("capacity");

    // The claim told the agency, and the panel says so only because a notice really exists; a long hold is iAcquire's to look at.
    const notices = await q<{ id: string }>("select id from notifications where user_id = $1 and dedupe_key like 'provisioner-capacity:%'", [admin.id]);
    expect(notices).toHaveLength(1);
    expect(facts.employees.filter((e) => e.entitled).every((e) => e.stallAlerted === true)).toBe(true);
    const old = deriveLaunchReadiness(facts, new Date(Date.now() + 90 * 60_000));
    const oldItem = itemOf(old, "employees.crm_manager");
    expect(oldItem).toMatchObject({ state: "action_required", owner: "iacquire", stalled: true });
    expect(oldItem.detail).toContain("iAcquire has been alerted");

    // Raising the limit releases the second team, and the panel stops saying it is held.
    setMax(10);
    expect(await heldRoles(second.org.id)).toBe(0);
    const orgs = new Set<string>();
    for (let i = 0; i < 5; i += 1) orgs.add((await claimHermesProvisionerJob(gatewayId))!.orgId);
    expect(orgs.has(second.org.id)).toBe(true);
  }, 120_000);

  it("is never a hold when there is no ceiling or no pinned gateway, or when the setup payment is not confirmed", async () => {
    vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gatewayId);
    vi.stubEnv("HERMES_PROVISIONER_MAX_PROFILES", "");
    resetEnvCache();
    const c = await team("Capacity Unset", 2);
    expect((await loadLaunchFactsForOrg(c.org.id))!.employees.some((e) => e.capacityHeld)).toBe(false);
    setMax(1);
    expect((await loadLaunchFactsForOrg(c.org.id))!.employees.some((e) => e.capacityHeld)).toBe(true);
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [c.org.id]));
    expect((await loadLaunchFactsForOrg(c.org.id))!.employees.some((e) => e.capacityHeld)).toBe(false);
  }, 60_000);

  const heldOf = async (orgId: string) => (await loadLaunchFactsForOrg(orgId))!.employees.filter((e) => e.capacityHeld).map((e) => e.role);
  const jobOf = async (orgId: string, role: AgentRoleKey) => (await q<{ id: string; status: string; detail: string | null }>(
    "select j.id, j.status, j.detail from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and a.role_key = $2 and j.kind = 'provision' order by j.created_at desc limit 1", [orgId, role]))[0];

  it("shows the hold when the worker answered capacity_exceeded, by the sentence the failure really stores, and for a failed job whose retry is due", async () => {
    setMax(1000);
    const c = await team("Capacity Answered", 2);
    // Earlier tests of this group left queued jobs of their own: take claims until the one for this workspace comes up.
    let manifest = await claimHermesProvisionerJob(gatewayId);
    for (let i = 0; manifest && manifest.orgId !== c.org.id && i < 30; i += 1) manifest = await claimHermesProvisionerJob(gatewayId);
    if (!manifest || manifest.orgId !== c.org.id) throw new Error("the claim never reached this workspace's job");
    await completeHermesProvisionerJob({ ok: false, jobId: manifest.jobId, leaseToken: manifest.leaseToken, gatewayId, code: "capacity_exceeded" }, gatewayId);
    const failed = await jobOf(c.org.id, manifest.role as AgentRoleKey);
    // The stored detail is a sentence that contains the code, never the bare code.
    expect(failed).toMatchObject({ status: "failed", detail: expect.stringContaining("(capacity_exceeded)") });
    expect(failed.detail).not.toBe("capacity_exceeded");
    // Its retry is five minutes away, so the claim is not holding it yet; the answer itself is still a hold, never a failure.
    expect(await heldOf(c.org.id)).toContain(manifest.role);
    const item = itemOf((await getLaunchReadiness(ctxFor(c.owner, c.org, "owner")))!, `employees.${manifest.role}`);
    expect(item.detail).toContain("Waiting for capacity (iAcquire)");
    // Once the retry is due and the runtime is still full, the claim itself holds it (a failed job, not only a requested one).
    await withSystem((db) => db.query("update agent_provisioning_jobs set next_retry_at = now() - interval '1 second' where id = $1", [failed.id]));
    setMax(1);
    await expect(claimHermesProvisionerJob(gatewayId)).resolves.toBeNull();
    expect(await heldOf(c.org.id)).toContain(manifest.role);
    expect(await heldOf(c.org.id)).toHaveLength(2);
  }, 120_000);

  it("is not a hold when something other than room keeps the job from being claimed: an agency pause, an unverified owner", async () => {
    setMax(1);
    const c = await team("Capacity Other Reason", 2);
    expect(await heldOf(c.org.id)).toHaveLength(2);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active) values ($1, 'agency', true)", [c.org.id]));
    expect(await heldOf(c.org.id)).toEqual([]);
    await withSystem((db) => db.query("delete from automation_pauses where org_id = $1", [c.org.id]));
    expect(await heldOf(c.org.id)).toHaveLength(2);
    await withSystem((db) => db.query("update users set email_verified_at = null where id = $1", [c.owner.id]));
    expect(await heldOf(c.org.id)).toEqual([]);
  }, 120_000);
});
