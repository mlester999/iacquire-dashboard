// A final check is re-run on what it depends on, not only on the employee's configuration version: a change to the host's hours or the appointment types asks for a new Appointment Setter
// check and nobody else's, a change to the targeting asks for the Lead Hunter's, a change to the pipeline stages asks for the Sales Assistant's and the CRM Manager's, and a knowledge edit
// asks for nobody's. A check recorded before digests existed still counts for its own version. Test database only.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { checkCoversInputs, launchVerificationInput, launchVerificationKey, verificationInputs } from "@/lib/launch-verification";
import { setHostAvailability } from "@/server/calendars/setup";
import { saveKnowledgeSection } from "@/server/knowledge/service";
import { employeeInputsDigest, getLaunchReadiness } from "@/server/setup/launch-readiness";
import { startLaunchVerification } from "@/server/setup/launch-intents";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { WEEKDAYS, checkJobs, itemOf, readyClient, settled } from "./support/launch";

describe("what each role's check reads", () => {
  it("lists the setup each check depends on, and nothing for the roles that read none", () => {
    expect(Object.fromEntries(AGENT_ROLE_KEYS.map((role) => [role, verificationInputs(role)]))).toEqual({
      operations_manager: [],
      lead_hunter: ["targeting_criteria"],
      appointment_setter: ["calendar_types", "host_rules"],
      sales_assistant: ["pipeline_stages"],
      crm_manager: ["pipeline_stages"],
      performance_analyst: [],
    });
  });

  it("records a digest in the job only when there is one, and keeps the old shape and key without it", () => {
    expect(launchVerificationInput(3)).toEqual({ launchVerification: true, configVersion: 3 });
    expect(launchVerificationInput(3, null)).toEqual({ launchVerification: true, configVersion: 3 });
    expect(launchVerificationInput(3, "a".repeat(64))).toEqual({ launchVerification: true, configVersion: 3, inputsDigest: "a".repeat(64) });
    const base = { orgId: "org", role: "appointment_setter" as AgentRoleKey, configVersion: 3, round: 0 };
    expect(launchVerificationKey(base)).toBe("launch-check:org:appointment_setter:v3:r0");
    const one = launchVerificationKey({ ...base, inputsDigest: "a".repeat(64) });
    const two = launchVerificationKey({ ...base, inputsDigest: "b".repeat(64) });
    expect(one).not.toBe(two);
    expect(one).toBe(`launch-check:org:appointment_setter:v3:d${"a".repeat(12)}:r0`);
  });

  it("covers the current setup when the digests match, and when a check was recorded without one", () => {
    const d = "a".repeat(64);
    expect(checkCoversInputs(d, d)).toBe(true);
    expect(checkCoversInputs(d, "b".repeat(64))).toBe(false);
    expect(checkCoversInputs(null, d)).toBe(true);
    expect(checkCoversInputs(undefined, d)).toBe(true);
    expect(checkCoversInputs(d, null)).toBe(true);
    expect(checkCoversInputs(null, null)).toBe(true);
  });
});

/** A client whose six checks all passed. */
async function checkedClient(name: string, timezone = "America/Chicago") {
  const c = await readyClient({ name, timezone });
  expect((await sweepLaunchVerification(c.org.id)).queued.sort()).toEqual([...AGENT_ROLE_KEYS].sort());
  await settled(c.org.id, 6);
  expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
  return c;
}

const stalenessOf = async (c: Awaited<ReturnType<typeof checkedClient>>) => {
  const r = (await getLaunchReadiness(c.ctx))!;
  return { r, stale: r.blocking.map((i) => i.key).sort() };
};
const digests = async (orgId: string) => Object.fromEntries(await Promise.all(AGENT_ROLE_KEYS.map(async (role) => [role, await withSystem((db) => employeeInputsDigest(db, orgId, role))] as const)));

describe("a check goes stale only for the roles that read what changed", () => {
  it("stamps each check with the digest of what it read, and none for the roles that read nothing", async () => {
    const c = await checkedClient("Digest Stamp Roofing");
    const jobs = await withSystem((db) => db.query<{ role_key: AgentRoleKey; digest: string | null }>(
      "select a.role_key, j.input ->> 'inputsDigest' as digest from ai_work_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and j.input ->> 'launchVerification' = 'true'", [c.org.id]));
    const now = await digests(c.org.id);
    for (const j of jobs.rows) expect(j.digest, j.role_key).toBe(now[j.role_key]);
    expect(now.operations_manager).toBeNull();
    expect(now.performance_analyst).toBeNull();
    expect(now.appointment_setter).toMatch(/^[a-f0-9]{64}$/);
    // The two pipeline roles read the same stages, so they share one digest; the others differ.
    expect(now.sales_assistant).toBe(now.crm_manager);
    expect(new Set([now.appointment_setter, now.lead_hunter, now.sales_assistant]).size).toBe(3);
  }, 180_000);

  it("host availability: only the Appointment Setter is stale, the sweep re-queues only it, and 100% comes back", async () => {
    const c = await checkedClient("Digest Hours Roofing");
    const before = await digests(c.org.id);
    await setHostAvailability(c.actor("owner"), c.people.owner.id, { timezone: "America/Chicago", rules: WEEKDAYS.slice(0, 4) });
    const after = await digests(c.org.id);
    expect(after.appointment_setter).not.toBe(before.appointment_setter);
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "appointment_setter")) expect(after[role], role).toBe(before[role]);

    const { r, stale } = await stalenessOf(c);
    expect(stale).toEqual(["verification.appointment_setter"]);
    expect(r.state).toBe("action_required");
    expect(r.percent).toBeLessThan(100);
    expect(itemOf(r, "verification.appointment_setter")).toMatchObject({ state: "action_required", detail: expect.stringContaining("appointment types or host hours changed"), action: { intent: "run_checks" } });
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual(["appointment_setter"]);
    await settled(c.org.id, 7);
    expect(await checkJobs(c.org.id)).toBe(7);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
    // Nothing more is queued for the same setup.
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
  }, 180_000);

  it("an appointment type's notice reaches only the Appointment Setter, and the button starts only that check", async () => {
    const c = await checkedClient("Digest Notice Roofing");
    await withSystem((db) => db.query("update crm_appointment_types set min_notice_minutes = 180 where org_id = $1", [c.org.id]));
    expect((await stalenessOf(c)).stale).toEqual(["verification.appointment_setter"]);
    const pressed = await startLaunchVerification(c.ctx);
    expect(pressed.started).toEqual(["appointment_setter"]);
    await settled(c.org.id, 7);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch" });
  }, 180_000);

  it("lead targeting: only the Lead Hunter", async () => {
    const c = await checkedClient("Digest Targeting Roofing");
    await withSystem((db) => db.query("update lead_targeting_profiles set criteria = $2::jsonb where org_id = $1", [c.org.id, JSON.stringify({ industries: ["Plumbers"], countries: ["US"] })]));
    const { r, stale } = await stalenessOf(c);
    expect(stale).toEqual(["verification.lead_hunter"]);
    expect(itemOf(r, "verification.lead_hunter").detail).toContain("lead targeting changed");
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual(["lead_hunter"]);
    await settled(c.org.id, 7);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
  }, 180_000);

  it("pipeline stages: only the Sales Assistant and the CRM Manager", async () => {
    const c = await checkedClient("Digest Stages Roofing");
    await withSystem((db) => db.query(
      `update crm_pipeline_stages set name = name || ' (new)' where id = (select id from crm_pipeline_stages where org_id = $1 and archived_at is null and kind = 'open' order by position limit 1)`, [c.org.id]));
    const { r, stale } = await stalenessOf(c);
    expect(stale).toEqual(["verification.crm_manager", "verification.sales_assistant"]);
    expect(itemOf(r, "verification.sales_assistant").detail).toContain("pipeline stages changed");
    expect((await sweepLaunchVerification(c.org.id)).queued.sort()).toEqual(["crm_manager", "sales_assistant"]);
    await settled(c.org.id, 8);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
  }, 180_000);

  it("saving a knowledge section starts nothing and makes nothing stale", async () => {
    const c = await checkedClient("Digest Knowledge Roofing");
    const before = await digests(c.org.id);
    await saveKnowledgeSection(c.ctx, "faq", "We answer every enquiry within one working day.");
    expect(await digests(c.org.id)).toEqual(before);
    expect((await stalenessOf(c)).stale).toEqual([]);
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    expect(await checkJobs(c.org.id)).toBe(6);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
  }, 180_000);
});

describe("older checks and other clients", () => {
  it("reads a check recorded without a digest as passed for its version, whatever changes afterwards", async () => {
    const c = await checkedClient("Digest Legacy Roofing");
    await withSystem((db) => db.query("update ai_work_jobs set input = input - 'inputsDigest' where org_id = $1 and input ->> 'launchVerification' = 'true'", [c.org.id]));
    await setHostAvailability(c.actor("owner"), c.people.owner.id, { timezone: "America/Chicago", rules: WEEKDAYS.slice(0, 3) });
    await withSystem((db) => db.query("update lead_targeting_profiles set criteria = $2::jsonb where org_id = $1", [c.org.id, JSON.stringify({ industries: ["Plumbers"], countries: ["US"] })]));
    expect((await stalenessOf(c)).stale).toEqual([]);
    expect(await getLaunchReadiness(c.ctx)).toMatchObject({ state: "ready_to_launch", percent: 100 });
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    expect((await startLaunchVerification(c.ctx)).started).toEqual([]);
    expect(await checkJobs(c.org.id)).toBe(6);
  }, 180_000);

  it("keeps two clients apart: a change in one makes nothing stale and queues nothing in the other", async () => {
    const a = await checkedClient("Digest Apart A", "Asia/Manila");
    const b = await checkedClient("Digest Apart B", "America/Denver");
    await setHostAvailability(a.actor("owner"), a.people.owner.id, { timezone: "Asia/Manila", rules: WEEKDAYS.slice(0, 4) });
    expect((await stalenessOf(a)).stale).toEqual(["verification.appointment_setter"]);
    expect((await stalenessOf(b)).stale).toEqual([]);
    expect((await sweepLaunchVerification(b.org.id)).queued).toEqual([]);
    expect(await checkJobs(b.org.id)).toBe(6);
  }, 240_000);

  it("never re-runs a check that failed for the same setup, and runs a new one for changed setup", async () => {
    const c = await readyClient({ name: "Digest Failed Roofing", timezone: "Europe/London", noticeMinutes: 10 * 24 * 60 });
    await sweepLaunchVerification(c.org.id);
    await settled(c.org.id, 6);
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "verification.appointment_setter").state).toBe("failed");
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual([]);
    // The client shortens the notice: the setup the check read is not the setup there is, so a new check starts (and now finds a time).
    await withSystem((db) => db.query("update crm_appointment_types set min_notice_minutes = 60 where org_id = $1", [c.org.id]));
    expect((await sweepLaunchVerification(c.org.id)).queued).toEqual(["appointment_setter"]);
    await settled(c.org.id, 7);
    expect(itemOf((await getLaunchReadiness(c.ctx))!, "verification.appointment_setter").state).toBe("done");
  }, 180_000);
});
