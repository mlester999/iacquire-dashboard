// The final checks start by themselves: nobody presses a button for an employee that is ready to prove itself, a changed configuration is re-checked without being asked, a failed check
// is never retried behind the client's back, and only reviewed read-only work can start this way. Test database only; no Hermes writes beyond the mock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { sweepLaunchVerification, sweepLaunchVerificationAfter } from "@/server/setup/launch-sweep";
import { LAUNCH_LEDGER_ACTION } from "@/server/setup/launch-ledger";
import { getLaunchReadiness } from "@/server/setup/launch-readiness";
import { runLaunchIntent, startLaunchVerification } from "@/server/setup/launch-intents";
import { dispatchSystemCapabilityJob } from "@/server/workforce/capability-dispatch";
import { connectHermesProfile, createConfigVersion, currentSettings, runHealthCheck } from "@/server/workforce/service";
import { agentId, createUser } from "./support/fixtures";
import { startMockHermes, type MockHermes } from "./support/mock-hermes";
import { checkJobs, itemOf, readyClient, settled } from "./support/launch";

const KEY = "a".repeat(40);

describe("the launch sweep", () => {
  it("starts one read-only check per ready employee, once, and reaches 100% without a click", async () => {
    const c = await readyClient({ name: "Sweep Roofing", timezone: "Asia/Manila" });
    const first = await sweepLaunchVerification(c.org.id);
    expect(first.queued.sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    await settled(c.org.id, 6);
    expect((await getLaunchReadiness(c.ctx))!).toMatchObject({ state: "ready_to_launch", percent: 100 });
    // Asking again starts nothing, and a second sweep running at the same moment makes no second job.
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    const [a, b] = await Promise.all([sweepLaunchVerification(c.org.id), sweepLaunchVerification(c.org.id)]);
    expect(a.queued.concat(b.queued)).toEqual([]);
    expect(await checkJobs(c.org.id)).toBe(6);
    // Every job names the accountable owner and says setup started it; the audit says the system did, and for whom.
    const jobs = await withSystem((db) => db.query<{ requested_by: string | null; input: { startedBy?: string } }>("select requested_by, input from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true'", [c.org.id]));
    expect(jobs.rows.every((j) => j.requested_by === c.people.owner.id && j.input.startedBy === "iacquire_setup")).toBe(true);
    const audit = await withSystem((db) => db.query<{ actor_kind: string; metadata: { onBehalfOf?: string } }>("select actor_kind, metadata from audit_logs where org_id = $1 and action = 'workforce.capability_dispatched'", [c.org.id]));
    expect(audit.rows).toHaveLength(6);
    expect(audit.rows.every((r) => r.actor_kind === "system" && r.metadata.onBehalfOf === c.people.owner.id)).toBe(true);
  }, 180_000);

  it("re-checks only the employee whose configuration changed, without being asked", async () => {
    const c = await readyClient({ name: "Sweep Reconfigure", timezone: "America/Chicago" });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    const analyst = await agentId(c.org.id, "performance_analyst");
    const current = (await withSystem((db) => currentSettings(db, analyst, c.org.id))).settings;
    await withSystem((db) => createConfigVersion(db, { orgId: c.org.id, agentId: analyst, settings: { ...current, personality: "Plain and exact." }, source: "client_edit", userId: c.people.owner.id, apply: true }));
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("action_required");
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual(["performance_analyst"]);
    await settled(c.org.id, 7);
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("ready_to_launch");
  }, 180_000);

  it("starts one new check for the role whose input changed, however many sweeps run at once, and none for the rest", async () => {
    const c = await readyClient({ name: "Sweep Inputs Roofing", timezone: "America/Chicago" });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    await withSystem((db) => db.query("update lead_targeting_profiles set criteria = $2::jsonb where org_id = $1", [c.org.id, JSON.stringify({ industries: ["Plumbers"], countries: ["US"] })]));
    const [a, b] = await Promise.all([sweepLaunchVerification(c.org.id), sweepLaunchVerification(c.org.id)]);
    expect(a.queued.concat(b.queued)).toEqual(["lead_hunter"]);
    expect(await checkJobs(c.org.id)).toBe(7);
    await settled(c.org.id, 7);
    // The new job records the digest it read, so the same sweep again starts nothing.
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    const digests = await withSystem((db) => db.query<{ d: string | null }>("select input ->> 'inputsDigest' as d from ai_work_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and a.role_key = 'lead_hunter' order by j.created_at", [c.org.id]));
    expect(digests.rows).toHaveLength(2);
    expect(digests.rows[0].d).not.toBe(digests.rows[1].d);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
  }, 180_000);

  it("never retries a check that ran and failed: the client fixes what it names and runs it again", async () => {
    const c = await readyClient({ name: "Sweep Failing", timezone: "Europe/London", noticeMinutes: 10 * 24 * 60 });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "verification.appointment_setter").state).toBe("failed");
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    expect(await checkJobs(c.org.id)).toBe(6);
  }, 180_000);

  it("starts no check for an employee whose connection check failed, and shows it as iAcquire's to look at", async () => {
    const c = await readyClient({ name: "Sweep Health Failed", timezone: "UTC" });
    const sales = await agentId(c.org.id, "sales_assistant");
    await withSystem((db) => db.query("update agent_instances set last_health_ok = false, last_health_detail = 'The gateway did not answer.', last_health_check_at = now() where id = $1", [sales]));
    const swept = await sweepLaunchVerification(c.org.id);
    expect(swept.queued).not.toContain("sales_assistant");
    await settled(c.org.id, 5);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "action_required", owner: "iacquire" });
    expect(itemOf(r, "employees.sales_assistant").detail).not.toContain("gateway");
    expect(r.state).toBe("action_required");
    expect(await checkJobs(c.org.id)).toBe(5);
  }, 180_000);

  it("starts nothing before the questionnaire is submitted, before the setup payment is confirmed, or for a paused or not-ready employee", async () => {
    const c = await readyClient({ name: "Sweep Gates", timezone: "UTC" });
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'invoiced', waiver_reason = null, waived_at = null where org_id = $1", [c.org.id]));
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    await withSystem((db) => db.query("update billing_accounts set setup_payment_status = 'waived', waiver_reason = 'Test fixture: cleared again', waived_at = now() where org_id = $1", [c.org.id]));
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = null where id = $1", [c.org.id]));
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    await withSystem((db) => db.query("update organizations set onboarding_completed_at = now() where id = $1", [c.org.id]));

    // One employee is paused (not in the plan), one is not healthy: neither is checked, the other four are.
    await withSystem(async (db) => {
      await db.query("update agent_instances set enabled = false where org_id = $1 and role_key = 'lead_hunter'", [c.org.id]);
      await db.query("update agent_instances set last_health_ok = false, status = 'offline' where org_id = $1 and role_key = 'sales_assistant'", [c.org.id]);
    });
    expect((await sweepLaunchVerification(c.org.id)).queued.sort()).toEqual(["appointment_setter", "crm_manager", "operations_manager", "performance_analyst"]);
    const r = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(r, "employees.lead_hunter").state).toBe("not_applicable");
    expect(itemOf(r, "verification.lead_hunter").state).toBe("not_applicable");
    expect(r.state).not.toBe("ready_to_launch");
  }, 180_000);

  it("does not check a workspace that is a demo or suspended, and keeps two clients apart", async () => {
    const demo = await readyClient({ name: "Sweep Demo", timezone: "UTC" });
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    expect((await sweepLaunchVerification(demo.org.id)).queued).toEqual([]);
    const suspended = await readyClient({ name: "Sweep Suspended", timezone: "UTC" });
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]));
    expect((await sweepLaunchVerification(suspended.org.id)).queued).toEqual([]);

    const a = await readyClient({ name: "Sweep Apart A", timezone: "Asia/Manila" });
    const b = await readyClient({ name: "Sweep Apart B", timezone: "America/Denver" });
    await sweepLaunchVerification(a.org.id);
    await settled(a.org.id, 6);
    expect(await checkJobs(b.org.id)).toBe(0);
    expect((await getLaunchReadiness(b.ctx))!.state).toBe("action_required");
    expect((await getLaunchReadiness(a.ctx))!.state).toBe("ready_to_launch");
  }, 180_000);
});

describe("work started without a person", () => {
  it("refuses anything that is not read-only, an unknown capability, another role's capability, and an employee that cannot take work", async () => {
    const c = await readyClient({ name: "System Dispatch Roofing", timezone: "UTC" });
    const base = { orgId: c.org.id, onBehalfOf: c.people.owner.id, title: "Test", idempotencyKey: `system-test-${c.org.id}` };
    // A capability that writes drafts for a person to send needs a person.
    await expect(dispatchSystemCapabilityJob({ ...base, agentRole: "sales_assistant", capability: "pipeline_followup_drafts" })).rejects.toThrow(/read-only/i);
    await expect(dispatchSystemCapabilityJob({ ...base, agentRole: "sales_assistant", capability: "lead_research" })).rejects.toThrow(/read-only|role/i);
    await expect(dispatchSystemCapabilityJob({ ...base, agentRole: "crm_manager", capability: "performance_snapshot" })).rejects.toThrow(/role/i);
    await expect(dispatchSystemCapabilityJob({ ...base, agentRole: "crm_manager", capability: "not_a_capability" as never })).rejects.toThrow(/not available/i);
    await withSystem((db) => db.query("update agent_instances set enabled = false where org_id = $1 and role_key = 'crm_manager'", [c.org.id]));
    await expect(dispatchSystemCapabilityJob({ ...base, agentRole: "crm_manager", capability: "crm_quality_review" })).rejects.toThrow(/paused/i);
    expect(await checkJobs(c.org.id)).toBe(0);
    // A read-only capability for a ready role starts, and the same key returns the same job.
    const one = await dispatchSystemCapabilityJob({ ...base, agentRole: "performance_analyst", capability: "performance_snapshot" });
    const two = await dispatchSystemCapabilityJob({ ...base, agentRole: "performance_analyst", capability: "performance_snapshot" });
    expect(one.created).toBe(true);
    expect(two).toMatchObject({ created: false, jobId: one.jobId });
  }, 180_000);
});

describe("the Appointment Setter's check waits for the booking calendar", () => {
  it("starts no Appointment Setter check, and shows none as due, while its calendar is a draft, then starts it once the calendar is active", async () => {
    const c = await readyClient({ name: "Sweep Calendar Later", timezone: "America/Chicago" });
    // The client's calendar goes back to a draft (not yet verified): it takes no bookings, so there is nothing real for the setter to prove itself on.
    await withSystem((db) => db.query("update crm_calendars set status = 'draft', public = false, is_default = false where id = $1", [c.calendarId]));
    const first = await sweepLaunchVerification(c.org.id);
    expect(first.queued.sort()).toEqual(AGENT_ROLE_KEYS.filter((role) => role !== "appointment_setter").sort());
    await settled(c.org.id, 5);
    const waiting = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(waiting, "verification.appointment_setter")).toMatchObject({ state: "in_progress", owner: "you", detail: expect.stringContaining("calendar is active") });
    expect(itemOf(waiting, "verification.appointment_setter").action).toBeUndefined();
    // Pressing the button for the final checks starts nothing for it either, and says why.
    const pressed = await startLaunchVerification(c.ctx);
    expect(pressed.started).toEqual([]);
    expect(pressed.skipped!.some((s) => s.role === "appointment_setter")).toBe(true);
    expect(await checkJobs(c.org.id)).toBe(5);

    // Activating the calendar is what makes it start: one check, and the workspace reaches 100% without another click.
    expect(await runLaunchIntent(c.ctx, "activate_calendar")).toMatchObject({ ok: true });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    expect(await checkJobs(c.org.id)).toBe(6);
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("ready_to_launch");
  }, 180_000);
});

describe("the sweep as an event leaves the launch ledger a row", () => {
  it("records the state the event left once it ran, and the way to ready once the checks settle", async () => {
    const c = await readyClient({ name: "Ledger Sweep Roofing", timezone: "Asia/Manila" });
    const trail = async () => (await withSystem((db) => db.query<{ metadata: { to: string } }>("select metadata from audit_logs where org_id = $1 and action = $2 order by id", [c.org.id, LAUNCH_LEDGER_ACTION]))).rows.map((r) => r.metadata.to);
    const base = (await trail()).length;
    await sweepLaunchVerificationAfter(c.org.id, "a test event");
    await settled(c.org.id, 6);
    await sweepLaunchVerificationAfter(c.org.id, "a test event");
    const after = (await trail()).slice(base);
    expect(after.at(-1)).toBe("ready_to_launch");
    expect(after.slice(0, -1).includes("ready_to_launch")).toBe(false);
    // The same event again changes nothing, so nothing more is written.
    const length = (await trail()).length;
    await sweepLaunchVerificationAfter(c.org.id, "a test event");
    expect((await trail()).length).toBe(length);
  }, 180_000);
});

describe("started by a passing health check", () => {
  let mock: MockHermes;
  const PROFILE = "c-sweep-health-appointment-setter";
  beforeAll(async () => { mock = await startMockHermes({ [PROFILE]: { key: KEY } }); });
  afterAll(async () => { await mock.close(); });

  it("queues the checks of a workspace the moment its last employee passes its health check", async () => {
    const c = await readyClient({ name: "Health Sweep Dental", timezone: "Asia/Manila" });
    const setter = await agentId(c.org.id, "appointment_setter");
    // Five employees are ready; the Appointment Setter has not connected yet, so nothing can be checked as a whole... yet each ready one is, as soon as any health check passes.
    await withSystem((db) => db.query("update agent_instances set status = 'provisioning', last_health_ok = null, last_health_check_at = null, credential_id = null where id = $1", [setter]));
    await withSystem((db) => db.query("update agent_instances set tool_inventory_digest = null, tool_inventory_verified_at = null, tool_inventory_expires_at = null where id = $1", [setter]));
    const admin = await createUser({ platformRole: "agency_super_admin", name: "Sweep Admin" });
    await connectHermesProfile({ agentId: setter, baseUrl: mock.url, profile: PROFILE, apiKey: KEY, agencyUserId: admin.id });
    expect(await checkJobs(c.org.id)).toBe(0);
    expect(await runHealthCheck(setter, { userId: admin.id, kind: "agency" })).toMatchObject({ ok: true, status: "online" });
    const jobs = await withSystem((db) => db.query<{ n: string }>("select count(*) as n from ai_work_jobs where org_id = $1 and input ->> 'launchVerification' = 'true'", [c.org.id]));
    expect(Number(jobs.rows[0].n)).toBe(6);
    await settled(c.org.id, 6);
    expect((await getLaunchReadiness(c.ctx))!.state).toBe("ready_to_launch");
  }, 180_000);
});

describe("the sweep only ever runs checks", () => {
  it("never applies the refinements the client confirms, never invites the listed team and never asks the CRM setup to run", async () => {
    const c = await readyClient({
      name: "Sweep Offers Roofing", timezone: "Asia/Manila",
      extraAnswers: { "d.sales_process": "1. Enquiry. 2. Qualify. 3. Quote. 4. Book the job.", "d.team": [{ name: "Ana Cruz", email: "ana-sweep@client.example", role: "sales_rep" }] },
    });
    const offered = (await getLaunchReadiness(c.ctx))!;
    expect(itemOf(offered, "crm.region").action).toMatchObject({ intent: "confirm_region_defaults" });
    expect(itemOf(offered, "crm.stages").action).toMatchObject({ intent: "apply_pipeline_stages" });
    expect(itemOf(offered, "knowledge.team").action).toMatchObject({ intent: "send_team_invitations" });

    expect((await sweepLaunchVerification(c.org.id)).queued.length).toBe(6);
    await settled(c.org.id, 6);
    await sweepLaunchVerificationAfter(c.org.id, "a test event");
    // Offered, and still only offered: the client has not pressed anything.
    const q = async (sql: string) => Number((await withSystem((db) => db.query<{ n: string }>(sql, [c.org.id]))).rows[0].n);
    expect(await q("select count(*) as n from crm_workspaces where org_id = $1 and (default_currency <> 'USD' or default_calling_code is not null)")).toBe(0);
    expect(await q("select count(*) as n from crm_pipelines where org_id = $1 and name = 'Your sales process'")).toBe(0);
    expect(await q("select count(*) as n from invitations where org_id = $1")).toBe(0);
    expect(await q("select count(*) as n from audit_logs where org_id = $1 and action in ('onboarding.region_defaults_applied', 'onboarding.pipeline_stages_applied', 'team.invited', 'crm.auto_setup_applied', 'crm.auto_setup_failed')")).toBe(0);
    // The optional lines never held up the state: the client is at 100% with all three still on offer.
    const after = (await getLaunchReadiness(c.ctx))!;
    expect(after).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect(itemOf(after, "knowledge.team").state).toBe("action_required");
  }, 180_000);
});
