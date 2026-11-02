// Autonomy is asked for again when what a customer reads from an employee changes, and an employee cannot be let loose on a check that ran for older settings. The re-confirmation is a
// workspace switch (org_features autonomy_reconfirm, off unless a Super Admin turns it on); the check requirement applies to a client's own, real workspace with or without it, and never
// to the internal agency tier or a sample workspace. Test database only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import type { AgentRoleKey } from "@/lib/agents";
import { LAUNCH_VERIFICATION_CAPABILITY, launchVerificationInput } from "@/lib/launch-verification";
import { createConfigVersion, currentSettings, decideHeldVersion } from "@/server/workforce/service";
import { autonomousBlocker, setAgentMode } from "@/server/automation/controls";
import { employeeInputsDigest } from "@/server/setup/launch-readiness";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { makeRuntimeReady } from "./support/runtime-ready";

type Fixture = Awaited<ReturnType<typeof workspace>>;

/** A workspace whose employee is ready, in the mode asked for, with setup activated, the way a client that finished onboarding looks. */
// The platform allows exactly one internal agency workspace, so every test that needs it shares this one.
let sharedAgency: Awaited<ReturnType<typeof createOrg>> | null = null;

async function workspace(opts: { name: string; role?: AgentRoleKey; kind?: "agency" | "client"; demo?: boolean; mode?: "autonomous" | "approval_required" | "paused"; feature?: boolean }) {
  const org = opts.kind === "agency" ? (sharedAgency ??= await createOrg({ name: opts.name, kind: "agency" })) : await createOrg({ name: opts.name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const admin = await createUser();
  await addMember(org.id, admin.id, "admin");
  const role = opts.role ?? "lead_hunter";
  const agent = await agentId(org.id, role);
  await makeRuntimeReady(agent, org.id, owner.id);
  await withSystem(async (db) => {
    await db.query("insert into client_setup_instances (org_id, state, activated_at) values ($1, 'activated', now()) on conflict (org_id) do update set state = 'activated', activated_at = now()", [org.id]);
    if (opts.demo) await db.query("update organizations set is_demo = true where id = $1", [org.id]);
    await db.query("update agent_instances set mode = $2 where id = $1", [agent, opts.mode ?? "autonomous"]);
    if (opts.feature !== undefined) await db.query("insert into org_features (org_id, feature, enabled) values ($1, 'autonomy_reconfirm', $2) on conflict (org_id, feature) do update set enabled = excluded.enabled", [org.id, opts.feature]);
  });
  return { org, owner, admin, agent, role, kind: opts.kind ?? "client", ctx: ctxFor(owner, org, "owner") };
}

/** Turns the workspace switch on and puts the employee in autonomous mode, after whatever baseline a test needed was applied without either. */
async function arm(f: Fixture) {
  await withSystem(async (db) => {
    await db.query("insert into org_features (org_id, feature, enabled) values ($1, 'autonomy_reconfirm', true) on conflict (org_id, feature) do update set enabled = true", [f.org.id]);
    await db.query("update agent_instances set mode = 'autonomous' where id = $1", [f.agent]);
  });
}

const modeOf = async (f: Fixture) => (await withSystem((db) => db.query<{ mode: string; mode_reason: string | null }>("select mode, mode_reason from agent_instances where id = $1", [f.agent]))).rows[0];
const versionOf = async (f: Fixture) => Number((await withSystem((db) => db.query<{ version: number }>("select v.version from agent_config_versions v join agent_instances a on a.active_config_version_id = v.id where a.id = $1", [f.agent]))).rows[0].version);

/** A client edit of this employee, applied the way the Configure screen applies it (it may be held for review, and then is not applied). */
async function edit(f: Fixture, patch: Record<string, unknown>) {
  const current = (await withSystem((db) => currentSettings(db, f.agent, f.org.id))).settings;
  // The internal tier has no client to edit: its own staff configure it.
  return withSystem((db) => createConfigVersion(db, { orgId: f.org.id, agentId: f.agent, settings: { ...current, ...patch } as typeof current, source: f.kind === "agency" ? "agency" : "client_edit", userId: f.owner.id, apply: true }));
}

/** A final-check job in the state asked for, as the launch panel and the sweep record it. */
async function checkJob(f: Fixture, over: { version: number | null; status?: string; digest?: string | null }) {
  await withSystem((db) => db.query(
    `insert into ai_work_jobs (org_id, agent_instance_id, capability, title, status, input, idempotency_key, result_count)
     values ($1, $2, $3, 'Launch check', $4, $5::jsonb, $6, 1)`,
    [f.org.id, f.agent, LAUNCH_VERIFICATION_CAPABILITY[f.role], over.status ?? "completed", JSON.stringify(launchVerificationInput(over.version, over.digest ?? null)), `test-check-${f.agent}-${Math.random()}`],
  ));
}

const audits = async (f: Fixture) => (await withSystem((db) => db.query<{ metadata: { via?: string; fields?: string[]; from?: string; to?: string } }>(
  "select metadata from audit_logs where org_id = $1 and action = 'agent.mode_changed' and metadata ->> 'via' = 'autonomy_reconfirm'", [f.org.id]))).rows;
const changedBy = async (f: Fixture) => (await withSystem((db) => db.query<{ mode_changed_by: string | null; actor_user_id: string | null; actor_kind: string }>(
  `select a.mode_changed_by, l.actor_user_id, l.actor_kind from agent_instances a
     join audit_logs l on l.org_id = a.org_id and l.agent_instance_id = a.id and l.action = 'agent.mode_changed' and l.metadata ->> 'via' = 'autonomy_reconfirm'
    where a.id = $1 and a.org_id = $2`, [f.agent, f.org.id]))).rows[0];
const notices = async (f: Fixture) => (await withSystem((db) => db.query<{ user_id: string; title: string }>(
  "select user_id, title from notifications where org_id = $1 and dedupe_key like 'autonomy-reconfirm:%'", [f.org.id]))).rows;

describe("autonomy is confirmed again after a customer-facing change (workspace switch on)", () => {
  it("drops an autonomous employee to approval-required, says why, audits it and tells the owner only", async () => {
    const f = await workspace({ name: "Reconfirm Tone Roofing", feature: true });
    const version = await edit(f, { tone: "professional" });
    expect(version.status).toBe("applied");
    expect(await modeOf(f)).toMatchObject({ mode: "approval_required", mode_reason: expect.stringContaining("tone") });
    expect((await modeOf(f)).mode_reason).toContain(`version ${version.version}`);
    const trail = await audits(f);
    expect(trail).toHaveLength(1);
    expect(trail[0].metadata).toMatchObject({ from: "autonomous", to: "approval_required", fields: ["tone"] });
    // The system applied the rule, and the person whose edit caused it is on both records.
    expect(await changedBy(f)).toEqual({ mode_changed_by: f.owner.id, actor_user_id: f.owner.id, actor_kind: "system" });
    // The owner is told, once; an admin is not the one who agreed to autonomy.
    expect(await notices(f)).toEqual([{ user_id: f.owner.id, title: expect.stringContaining("asks for approval again") }]);
    // A second change while it already asks for approval changes nothing and tells nobody again.
    await edit(f, { replyLength: "detailed" });
    expect((await audits(f)).length).toBe(1);
    expect((await notices(f)).length).toBe(1);
  }, 120_000);

  it("drops it when a client's first company rules are saved, and names them", async () => {
    const f = await workspace({ name: "Reconfirm First Rules Roofing", feature: true });
    expect((await edit(f, { companyRules: "Be polite to every customer." })).status).toBe("applied");
    expect(await modeOf(f)).toMatchObject({ mode: "approval_required", mode_reason: expect.stringContaining("company rules") });
    expect(await notices(f)).toHaveLength(1);
  }, 120_000);

  it("drops it when the reviewer approves a held company-rules edit, not while the edit only waits", async () => {
    // Company rules that already exist and are then rewritten (not extended) are a guardrail change, which the reviewer has to approve.
    const f = await workspace({ name: "Reconfirm Rules Roofing", mode: "approval_required" });
    expect((await edit(f, { companyRules: "Be polite to every customer." })).status).toBe("applied");
    await arm(f);
    const held = await edit(f, { companyRules: "Always greet customers by name and offer a call-back." });
    expect(held.status).toBe("pending_agency_review");
    // Waiting for review changes nothing the employee runs on, so it still works the way the owner agreed.
    expect((await modeOf(f)).mode).toBe("autonomous");
    expect(await notices(f)).toEqual([]);
    const reviewer = await createUser({ platformRole: "agency_super_admin" });
    await withSystem((db) => decideHeldVersion(db, { orgId: f.org.id, versionId: held.versionId, approve: true, agencyUserId: reviewer.id }));
    expect(await modeOf(f)).toMatchObject({ mode: "approval_required", mode_reason: expect.stringContaining("company rules") });
    expect((await audits(f))[0].metadata.fields).toEqual(["companyRules"]);
    expect(await notices(f)).toHaveLength(1);
    // An agency approval names the agency reviewer who applied the version.
    expect(await changedBy(f)).toEqual({ mode_changed_by: reviewer.id, actor_user_id: reviewer.id, actor_kind: "system" });
  }, 120_000);

  it("keeps the mode for a change a customer never reads, and for a rejected review", async () => {
    const f = await workspace({ name: "Reconfirm Quiet Roofing", mode: "approval_required" });
    expect((await edit(f, { companyRules: "Be polite to every customer." })).status).toBe("applied");
    await arm(f);
    expect((await edit(f, { characterTraits: "Calm and tidy.", goals: "More booked visits." })).status).toBe("applied");
    expect((await edit(f, { displayName: "Scout" })).status).toBe("applied");
    expect((await modeOf(f)).mode).toBe("autonomous");
    const held = await edit(f, { companyRules: "Always greet customers by name and offer a call-back." });
    expect(held.status).toBe("pending_agency_review");
    const reviewer = await createUser({ platformRole: "agency_super_admin" });
    await withSystem((db) => decideHeldVersion(db, { orgId: f.org.id, versionId: held.versionId, approve: false, agencyUserId: reviewer.id }));
    expect((await modeOf(f)).mode).toBe("autonomous");
    expect(await audits(f)).toEqual([]);
    expect(await notices(f)).toEqual([]);
  }, 120_000);

  it("leaves a paused or approval-required employee as it is, and another workspace's autonomous employee alone", async () => {
    const paused = await workspace({ name: "Reconfirm Paused Roofing", feature: true, mode: "paused" });
    const asking = await workspace({ name: "Reconfirm Asking Roofing", feature: true, mode: "approval_required" });
    const mine = await workspace({ name: "Reconfirm Mine Roofing", feature: true });
    const theirs = await workspace({ name: "Reconfirm Theirs Roofing", feature: true });
    for (const f of [paused, asking]) {
      await edit(f, { tone: "casual" });
      expect((await modeOf(f)).mode).toBe(f === paused ? "paused" : "approval_required");
      expect(await audits(f)).toEqual([]);
    }
    await edit(mine, { tone: "premium" });
    expect((await modeOf(mine)).mode).toBe("approval_required");
    expect((await modeOf(theirs)).mode).toBe("autonomous");
    expect(await notices(theirs)).toEqual([]);
  }, 180_000);
});

describe("with the switch off, or outside a client's real workspace, the mode is untouched", () => {
  it("does nothing when the switch was never turned on or was turned off", async () => {
    const never = await workspace({ name: "Reconfirm Never Roofing" });
    const off = await workspace({ name: "Reconfirm Off Roofing", feature: false });
    for (const f of [never, off]) {
      expect((await edit(f, { tone: "professional" })).status).toBe("applied");
      expect((await modeOf(f)).mode).toBe("autonomous");
      expect(await audits(f)).toEqual([]);
      expect(await notices(f)).toEqual([]);
    }
  }, 120_000);

  it("never re-confirms for the internal agency tier or a sample workspace, even with the switch on", async () => {
    const agency = await workspace({ name: "Internal Agency", kind: "agency", feature: true });
    const demo = await workspace({ name: "Reconfirm Demo Roofing", demo: true, feature: true });
    for (const f of [agency, demo]) {
      expect((await edit(f, { tone: "professional" })).status).toBe("applied");
      expect((await modeOf(f)).mode).toBe("autonomous");
      expect(await audits(f)).toEqual([]);
    }
  }, 120_000);
});

describe("an employee cannot go autonomous until its check passed for its current settings", () => {
  it("refuses with no check, a failed, running or stale check, and a check that read other setup, then allows it once the current one passed", async () => {
    // The switch is off on purpose: this half of the rule applies without it.
    const f = await workspace({ name: "Blocker Roofing", role: "sales_assistant", mode: "approval_required" });
    const go = () => setAgentMode(f.ctx, { agentId: f.agent, mode: "autonomous", confirmAutonomous: true });
    await expect(go()).rejects.toThrow(/final check has not passed/i);
    expect(await withSystem((db) => autonomousBlocker(db, f.org.id, { enabled: true, status: "online", last_health_ok: true, display_name: "Sales Assistant", id: f.agent }))).toMatch(/final check has not passed/i);

    const v1 = await versionOf(f);
    await checkJob(f, { version: v1, status: "failed" });
    await expect(go()).rejects.toThrow(/final check has not passed/i);
    await checkJob(f, { version: v1, status: "running" });
    await expect(go()).rejects.toThrow(/final check has not passed/i);

    // A check that read other pipeline stages than the client has now is stale, even for this very version.
    const digest = (await withSystem((db) => employeeInputsDigest(db, f.org.id, "sales_assistant")))!;
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    await checkJob(f, { version: v1, digest: "b".repeat(64) });
    await expect(go()).rejects.toThrow(/final check has not passed/i);

    // One for the current version and the current setup lets it through.
    await checkJob(f, { version: v1, digest });
    expect(await go()).toEqual({ mode: "autonomous", changed: true });
  }, 120_000);

  it("treats a check for an older version as stale, and a check recorded without a digest as valid for its own version", async () => {
    const f = await workspace({ name: "Stale Blocker Roofing", role: "sales_assistant", mode: "approval_required" });
    const go = () => setAgentMode(f.ctx, { agentId: f.agent, mode: "autonomous", confirmAutonomous: true });
    const v1 = await versionOf(f);
    await checkJob(f, { version: v1 });
    expect((await edit(f, { characterTraits: "Plain and exact." })).status).toBe("applied");
    expect(await versionOf(f)).toBe(v1 + 1);
    await expect(go()).rejects.toThrow(/final check has not passed/i);
    await checkJob(f, { version: v1 + 1 });
    expect(await go()).toMatchObject({ mode: "autonomous" });
  }, 120_000);

  it("lets the owner confirm again after a re-confirmation drop, once the new version has its own passed check", async () => {
    const f = await workspace({ name: "Confirm Again Roofing", role: "lead_hunter", feature: true });
    const dropped = await edit(f, { tone: "professional" });
    expect((await modeOf(f)).mode).toBe("approval_required");
    const go = () => setAgentMode(f.ctx, { agentId: f.agent, mode: "autonomous", confirmAutonomous: true });
    await expect(go()).rejects.toThrow(/final check has not passed/i);
    const digest = await withSystem((db) => employeeInputsDigest(db, f.org.id, "lead_hunter"));
    await checkJob(f, { version: dropped.version, digest });
    expect(await go()).toEqual({ mode: "autonomous", changed: true });
    // The reason of the drop is cleared by the owner's own change of mode.
    expect((await modeOf(f)).mode_reason).toBeNull();
  }, 120_000);

  it("does not ask an Appointment Setter for a check that can never exist when the client does not book appointments, and still asks every other employee", async () => {
    const answer = (orgId: string, value: boolean) => withSystem((db) => db.query("insert into onboarding_answers (org_id, question_id, value) values ($1, 'b.appointments', $2::jsonb)", [orgId, JSON.stringify(value)]));
    const setterNo = await workspace({ name: "No Appointments Setter Dental", role: "appointment_setter", mode: "approval_required" });
    const assistantNo = await workspace({ name: "No Appointments Assistant Dental", role: "sales_assistant", mode: "approval_required" });
    const setterYes = await workspace({ name: "Appointments Setter Roofing", role: "appointment_setter", mode: "approval_required" });
    await answer(setterNo.org.id, false);
    await answer(assistantNo.org.id, false);
    await answer(setterYes.org.id, true);
    const go = (f: Fixture) => setAgentMode(f.ctx, { agentId: f.agent, mode: "autonomous", confirmAutonomous: true });
    // The panel never starts a check for it (nothing to prepare), so the gate must not wait for one.
    expect(await go(setterNo)).toEqual({ mode: "autonomous", changed: true });
    // The same client's other employees still need theirs, and a client that does book appointments still needs the Appointment Setter's.
    await expect(go(assistantNo)).rejects.toThrow(/final check has not passed/i);
    await expect(go(setterYes)).rejects.toThrow(/final check has not passed/i);
  }, 120_000);

  it("does not hold the internal agency tier or a sample workspace to a launch check, and a call without an employee id is judged as before", async () => {
    const agency = await workspace({ name: "Internal Agency", kind: "agency", mode: "approval_required" });
    const demo = await workspace({ name: "Blocker Demo Roofing", demo: true, mode: "approval_required" });
    for (const f of [agency, demo]) {
      expect(await setAgentMode(f.ctx, { agentId: f.agent, mode: "autonomous", confirmAutonomous: true })).toEqual({ mode: "autonomous", changed: true });
    }
    const real = await workspace({ name: "Blocker Legacy Call Roofing", mode: "approval_required" });
    // Without `id` only the earlier conditions can be judged, which the Configure screen's own read still does.
    expect(await withSystem((db) => autonomousBlocker(db, real.org.id, { enabled: true, status: "online", last_health_ok: true, display_name: "Lead Hunter" }))).toBeNull();
  }, 120_000);
});
