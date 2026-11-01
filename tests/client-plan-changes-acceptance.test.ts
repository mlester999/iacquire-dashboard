// A plan change on a client that is already at 100% Ready to Launch, through the product's own code. The dental practice in Manila (no Sales Assistant in its plan) adds the Sales
// Assistant: it is configured from the practice's own answers and never the Chicago roofing company's, one setup request opens however often the change is made, the launch panel
// moves from "not applicable" to "in progress" and says it again at 100% only once the new employee has passed its own check, removing it again cancels the open request, and none of
// it reaches the other client or the other five employees. Test database only; the Hermes runtime is simulated by the recorded state a verified employee has.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import type { LaunchReadiness } from "@/lib/launch-readiness";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { saveOnboardingStep, submitOnboarding } from "@/server/onboarding/service";
import { afterSetupCleared } from "@/server/billing/after-clearing";
import { setAgentEnabled } from "@/server/admin/tenants";
import { employeeSyncState } from "@/server/onboarding/employee-sync";
import { getLaunchReadiness } from "@/server/setup/launch-readiness";
import { pickUpSetupEvidence } from "@/server/setup/evidence-pickup";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { addMember, agencyUser, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { clearSetupPayment } from "./support/billing";
import { makeRuntimeReady } from "./support/runtime-ready";
import { applyRealBlueprint, itemOf, settled } from "./support/launch";

interface Spec {
  name: string;
  industry: string;
  timezone: string;
  description: string;
  services: string;
  territories: string;
  customers: string;
  entitled: readonly AgentRoleKey[];
}

const roofing: Spec = {
  name: "Brightside Roofing Co", industry: "home_services", timezone: "America/Chicago", description: "We repair residential roofs after hail and storm damage.",
  services: "Roof repair and inspection", territories: "Austin, Texas", customers: "Austin homeowners with hail damage", entitled: AGENT_ROLE_KEYS,
};
const dental: Spec = {
  name: "Harbor Smile Dental", industry: "healthcare", timezone: "Asia/Manila", description: "We provide orthodontic braces and clear aligners.",
  services: "Orthodontic braces", territories: "Makati; Taguig", customers: "Parents of teenagers in Metro Manila",
  entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant"),
};

async function onboard(spec: Spec) {
  const org = await createOrg({ name: spec.name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  await withSystem((db) => db.query("update agent_instances set enabled = (role_key = any($2::text[])) where org_id = $1", [org.id, [...spec.entitled]]));
  const ctx = ctxFor(owner, org, "owner");
  const answers: Record<string, unknown> = {
    "a.business_name": spec.name, "a.industry": spec.industry, "a.business_model": "local", "a.description": spec.description, "a.timezone": spec.timezone, "a.contact_email": owner.email,
    "a.territories": spec.territories, "a.target_customers": spec.customers, "b.goals": ["more_leads"], "b.services": spec.services, "b.ideal_customer": spec.customers,
    "b.appointments": false, "b.website_need": "have", "d.pricing_policy": "never", "f.review": true,
  };
  const saved = await saveOnboardingStep(ctx, { answers: Object.fromEntries(Object.entries(answers).map(([key, value]) => [key, { value }])), currentQuestionId: "f.review" });
  expect(saved.rejected).toEqual({});
  await submitOnboarding(ctx);
  return { org, owner, ctx, spec };
}
type Client = Awaited<ReturnType<typeof onboard>>;

const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const readiness = async (c: Client) => (await getLaunchReadiness(c.ctx)) as LaunchReadiness;
const provisionJobs = (orgId: string) => rows<{ role_key: string; status: string; detail: string | null }>(
  "select a.role_key, j.status, j.detail from agent_provisioning_jobs j join agent_instances a on a.id = j.agent_instance_id where j.org_id = $1 and j.kind = 'provision' order by a.role_key, j.created_at", [orgId]);
const versionsByRole = async (orgId: string) => (await rows<{ role_key: string; version: number; source: string }>(
  "select a.role_key, v.version, v.source from agent_config_versions v join agent_instances a on a.id = v.agent_instance_id where v.org_id = $1 order by a.role_key, v.version", [orgId])).map((r) => `${r.role_key}:${r.version}:${r.source}`);

/** The recorded state a verified employee has once the restricted worker has built its profile (the worker is not live; this is what it would leave). */
async function simulateVerified(c: Client, roles: readonly AgentRoleKey[]) {
  for (const role of roles) {
    const id = await agentId(c.org.id, role);
    await makeRuntimeReady(id, c.org.id, c.owner.id);
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'succeeded' where org_id = $1 and agent_instance_id = $2 and status <> 'succeeded' and status <> 'cancelled'", [c.org.id, id]));
  }
}

describe("a plan change after 100% Ready to Launch", () => {
  const superAdmin = { current: null as ReturnType<typeof agencyUser> | null };
  let a: Client;
  let b: Client;
  let sales: string;
  const admin = () => superAdmin.current!;
  const REASON = "The practice moved up to the full plan";

  it("starts with two paying clients, one of them at 100% without a Sales Assistant", async () => {
    superAdmin.current = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    a = await onboard(roofing);
    b = await onboard(dental);
    for (const c of [a, b]) {
      await clearSetupPayment(c.org.id);
      await withSystem((db) => afterSetupCleared(db, c.org.id, { actorUserId: null, how: "waiver", eventKey: `plan-acceptance-${c.org.id}` }));
    }
    expect((await provisionJobs(a.org.id)).map((j) => j.role_key)).toEqual([...AGENT_ROLE_KEYS].sort());
    expect((await provisionJobs(b.org.id)).map((j) => j.role_key)).toEqual(dental.entitled.slice().sort());
    await getWorkspace(memberActor(b.ctx));
    await applyRealBlueprint(b.org.id);
    await simulateVerified(b, dental.entitled);
    await pickUpSetupEvidence(b.org.id, "a Blueprint apply");
    await settled(b.org.id, dental.entitled.length - 1);
    expect(await readiness(b)).toMatchObject({ state: "ready_to_launch", percent: 100, blocking: [] });
    expect(itemOf(await readiness(b), "employees.sales_assistant")).toMatchObject({ state: "not_applicable", required: false });
    sales = await agentId(b.org.id, "sales_assistant");
  }, 240_000);

  it("configures the new employee from the Manila answers only, requests setup once however often it is asked, and moves its launch item to in progress", async () => {
    const chicagoBefore = { versions: await versionsByRole(a.org.id), jobs: await provisionJobs(a.org.id) };
    const manilaOthersBefore = (await provisionJobs(b.org.id)).filter((j) => j.role_key !== "sales_assistant");

    expect(await setAgentEnabled(admin(), b.org.id, sales, true, REASON)).toMatchObject({ changed: true, configuration: "built", provisioning: "requested" });
    expect(await setAgentEnabled(admin(), b.org.id, sales, true, REASON)).toMatchObject({ changed: false, configuration: "existing", provisioning: "already_open" });

    // Exactly one configuration, of source onboarding, built from this client's answers.
    const built = await rows<{ source: string; status: string; compiled_instructions: string; settings: { targetCustomers: string; companyRules: string } }>(
      "select source, status, compiled_instructions, settings from agent_config_versions where org_id = $1 and agent_instance_id = $2", [b.org.id, sales]);
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({ source: "onboarding", status: "applied" });
    const text = `${built[0].compiled_instructions} ${JSON.stringify(built[0].settings)}`.toLowerCase();
    expect(text).toContain("harbor smile dental");
    expect(text).toContain("orthodontic");
    expect(text).toContain("parents of teenagers in metro manila");
    for (const theirs of ["brightside", "hail", "austin"]) expect(text, theirs).not.toContain(theirs);

    // One setup request for it; the other five are exactly as they were.
    const jobs = await provisionJobs(b.org.id);
    expect(jobs.filter((j) => j.role_key === "sales_assistant")).toEqual([{ role_key: "sales_assistant", status: "requested", detail: null }]);
    expect(jobs.filter((j) => j.role_key !== "sales_assistant")).toEqual(manilaOthersBefore);

    // The launch panel says it is being set up: not ready, not "not applicable", and not done.
    const r = await readiness(b);
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "in_progress", required: true });
    expect(r.state).not.toBe("ready_to_launch");

    // The other client saw none of it.
    expect({ versions: await versionsByRole(a.org.id), jobs: await provisionJobs(a.org.id) }).toEqual(chicagoBefore);
    expect(await readiness(a)).not.toMatchObject({ percent: 100 });
  }, 240_000);

  it("takes the employee out again by cancelling its open request, and the item goes back to not applicable at 100%", async () => {
    const removed = await setAgentEnabled(admin(), b.org.id, sales, false, "The practice stayed on the smaller plan");
    expect(removed).toMatchObject({ changed: true, cancelledJobs: 1 });
    expect((await provisionJobs(b.org.id)).filter((j) => j.role_key === "sales_assistant")).toEqual([{ role_key: "sales_assistant", status: "cancelled", detail: "Removed from the plan." }]);
    const r = await readiness(b);
    expect(itemOf(r, "employees.sales_assistant")).toMatchObject({ state: "not_applicable", required: false });
    expect(r).toMatchObject({ state: "ready_to_launch", percent: 100, blocking: [] });
    expect(await setAgentEnabled(admin(), b.org.id, sales, false, "The practice stayed on the smaller plan")).toMatchObject({ changed: false });
  }, 240_000);

  it("can add it back with a new request, and reaches 100% again only when the new employee has passed its own check", async () => {
    expect(await setAgentEnabled(admin(), b.org.id, sales, true, "The practice moved up after all")).toMatchObject({ changed: true, configuration: "existing", provisioning: "requested" });
    expect((await provisionJobs(b.org.id)).filter((j) => j.role_key === "sales_assistant").map((j) => j.status)).toEqual(["cancelled", "requested"]);
    expect(await rows("select 1 from agent_config_versions where org_id = $1 and agent_instance_id = $2", [b.org.id, sales])).toHaveLength(1);
    expect(itemOf(await readiness(b), "employees.sales_assistant").state).toBe("in_progress");

    // The worker builds its profile and the portal verifies it (recorded state). Then the check starts by itself, for the new employee only, and 100% comes back.
    await simulateVerified(b, ["sales_assistant"]);
    expect((await sweepLaunchVerification(b.org.id)).queued).toEqual(["sales_assistant"]);
    await settled(b.org.id, dental.entitled.length);
    expect(await readiness(b)).toMatchObject({ state: "ready_to_launch", percent: 100, blocking: [] });
    expect(itemOf(await readiness(b), "employees.sales_assistant")).toMatchObject({ state: "done" });
  }, 240_000);

  it("keeps every employee of both clients in step with its answers and never crosses a workspace", async () => {
    for (const c of [a, b]) {
      const state = await withSystem((db) => employeeSyncState(db, c.org.id));
      // Nothing was changed behind a client's back: no employee that the questionnaire configured is behind the answers it was built from. (The CRM Manager's first version is held for
      // review with these answers, and the simulated verification gives it a default configuration instead, which the check rightly calls behind: that is the fixture, not the plan change.)
      expect(state.filter((s) => s.state === "behind" && s.role !== "crm_manager")).toEqual([]);
      expect(state.find((s) => s.role === "sales_assistant")?.state ?? "in_sync").toBe("in_sync");
    }
    const crossed = await rows("select 1 from agent_config_versions v join agent_instances i on i.id = v.agent_instance_id where i.org_id <> v.org_id");
    expect(crossed).toHaveLength(0);
    const crossedJobs = await rows("select 1 from agent_provisioning_jobs j join agent_instances i on i.id = j.agent_instance_id where i.org_id <> j.org_id");
    expect(crossedJobs).toHaveLength(0);
    // The Chicago client's six employees still read Chicago, and nothing here sent anything.
    for (const row of await rows<{ compiled_instructions: string }>("select compiled_instructions from agent_config_versions where org_id = $1", [a.org.id])) {
      expect(row.compiled_instructions.toLowerCase()).not.toContain("orthodontic");
    }
    for (const c of [a, b]) {
      expect(Number((await rows<{ n: string }>("select count(*) as n from conversation_messages where org_id = $1 and direction = 'outbound'", [c.org.id]))[0].n)).toBe(0);
    }
  }, 240_000);
});
