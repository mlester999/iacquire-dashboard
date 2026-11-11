// "Allowed actions" is enforced where work starts. A workspace owner switches an employee's ability off; typing the right words, pressing the button, or a job queued earlier
// must not start work that ability covers. Synthetic workspaces on the embedded database; nothing here calls Hermes or a model.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, type Queryable } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey, type WorkforceRoleKey } from "@/lib/agents";
import { CHAT_REQUESTS } from "@/lib/employee-chat-requests";
import { abilitiesForCapability, allPolicyActionIds, CHAT_ACTION_ABILITIES, requiredAbilitiesForCapability, ROLE_ABILITIES } from "@/lib/employee-tool-policy";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES } from "@/lib/workforce-capabilities";
import { abilityRefusal, assertAbility, capabilityNeed, employeeAbilities, jobAbilityRefusal, missingAbilities } from "@/server/workforce/abilities";
import { dispatchCapabilityJob, dispatchSystemCapabilityJob } from "@/server/workforce/capability-dispatch";
import { readAbilities, roleAbilitiesAllow } from "@/server/workforce/employee-evidence";
import { retryWorkJob } from "@/server/workforce/jobs";
import { registerWorkHandler, runWorkJob } from "@/server/workforce/work-runner";
import { createConfigVersion } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";

interface Workspace {
  org: Awaited<ReturnType<typeof createOrg>>;
  owner: { id: string; email: string };
  ctx: ReturnType<typeof ctxFor>;
}

async function workspace(name: string): Promise<Workspace> {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  for (const role of AGENT_ROLE_KEYS) {
    const id = await agentId(org.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
  }
  await withSystem((db) => db.query("update agent_instances set mode = 'autonomous', enabled = true, status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
  return { org, owner, ctx: ctxFor(owner, org, "owner") };
}

/** The owner's Allowed actions: a new applied configuration whose settings switch these abilities off (an empty list switches everything back on). */
async function switchOff(w: Workspace, role: AgentRoleKey, disabledTools: string[]) {
  const id = await agentId(w.org.id, role);
  await withSystem(async (db) => {
    const v = await db.query<{ id: string }>(
      `insert into agent_config_versions (org_id, agent_instance_id, version, settings, summary, compiled_instructions, policy_version, source, status)
       values ($1, $2, (select coalesce(max(version), 0) + 1 from agent_config_versions where agent_instance_id = $2), $3, 's', '# config', 'p', 'onboarding', 'applied') returning id`,
      [w.org.id, id, JSON.stringify({ ...defaultSettings(role), disabledTools })],
    );
    await db.query("update agent_instances set active_config_version_id = $2 where id = $1", [id, v.rows[0].id]);
  });
}

const jobCount = async (orgId: string) => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from ai_work_jobs where org_id = $1", [orgId]))).rows[0].n);
const jobRow = async (id: string) => (await withSystem((db) => db.query<{ status: string; failure_code: string | null; failure_message: string | null }>("select status, failure_code, failure_message from ai_work_jobs where id = $1", [id]))).rows[0];
async function settled(jobId: string, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await jobRow(jobId);
    if (row && ["completed", "failed", "cancelled", "blocked"].includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("job did not settle");
}
const denials = async (orgId: string) => (await withSystem((db) => db.query<{ metadata: { actionId: string; role: string; reason: string }; actor_user_id: string | null; target_id: string | null }>(
  "select metadata, actor_user_id, target_id from audit_logs where org_id = $1 and action = 'agent.action_denied' order by id", [orgId]))).rows;
const eventText = async (jobId: string) => (await withSystem((db) => db.query<{ message: string }>("select message from ai_work_events where job_id = $1 order by id", [jobId]))).rows.map((r) => r.message).join(" | ");

describe("the reviewed ability tables (pure)", () => {
  it("every capability needs at least one ability, and the table covers all of them", () => {
    expect(CAPABILITY_KEYS).toHaveLength(14);
    for (const key of CAPABILITY_KEYS) expect(abilitiesForCapability(key).length, key).toBeGreaterThan(0);
  });

  it("every ability a table names is a real default tool of the roles that may use it", async () => {
    const { rows } = await withSystem((db) => db.query<{ key: WorkforceRoleKey; default_tools: string[] }>("select key, default_tools from agent_roles"));
    const tools = Object.fromEntries(rows.map((r) => [r.key, new Set(r.default_tools)])) as Record<WorkforceRoleKey, Set<string>>;
    const anywhere = new Set(rows.flatMap((r) => r.default_tools));
    for (const key of CAPABILITY_KEYS) {
      const roles = WORKFORCE_CAPABILITIES[key].allowedRoles;
      for (const ability of [...abilitiesForCapability(key), ...requiredAbilitiesForCapability(key)]) {
        expect(anywhere.has(ability), `${key}: ${ability} is nobody's tool`).toBe(true);
        // A capability a role may start must be switchable by that role's own abilities, or the switch could never govern it.
        expect(roles.some((role) => tools[role].has(ability)), `${key}: ${ability} is not a default tool of ${roles.join("/")}`).toBe(true);
      }
    }
    for (const [role, abilities] of Object.entries(ROLE_ABILITIES) as Array<[WorkforceRoleKey, readonly string[]]>) {
      for (const ability of abilities) expect(tools[role].has(ability), `${role}: ${ability}`).toBe(true);
    }
    for (const [action, abilities] of Object.entries(CHAT_ACTION_ABILITIES)) for (const ability of abilities) expect(anywhere.has(ability), `${action}: ${ability}`).toBe(true);
  });

  it("the chat request list and the dispatcher's table name the same abilities", () => {
    for (const role of AGENT_ROLE_KEYS) {
      for (const def of CHAT_REQUESTS[role]) {
        const capability = def.capability ?? (def.key === "lead_research" ? "lead_research" : null);
        if (capability) expect([...abilitiesForCapability(capability)].sort(), def.key).toEqual([...def.abilities].sort());
      }
    }
  });

  it("the chat action ability map covers exactly the chat proposals, with the booking ability", () => {
    const chatActions = allPolicyActionIds().filter((id) => id.startsWith("chat:")).sort();
    expect(Object.keys(CHAT_ACTION_ABILITIES).sort()).toEqual(chatActions);
    const booking = CHAT_REQUESTS.appointment_setter.filter((d) => d.key === "booking_preview" || d.key === "appointment_change");
    expect(booking).toHaveLength(2);
    for (const def of booking) {
      const action = def.key === "booking_preview" ? "chat:booking_request" : "chat:appointment_change";
      expect([...CHAT_ACTION_ABILITIES[action]]).toEqual([...def.abilities]);
    }
    expect([...CHAT_ACTION_ABILITIES["chat:targeting_update"]]).toEqual(["research.public_web"]);
    expect([...CHAT_ACTION_ABILITIES["chat:messaging_hours_update"]]).toEqual([]);
    expect([...CHAT_ACTION_ABILITIES["chat:partner_goal_update"]]).toEqual([]);
    expect([...CHAT_ACTION_ABILITIES["chat:crm_contact_create"]]).toEqual(["crm.contacts.create"]);
    expect([...CHAT_ACTION_ABILITIES["chat:crm_opportunity_create"]]).toEqual(["crm.request_update"]);
    expect([...CHAT_ACTION_ABILITIES["chat:crm_opportunity_move"]]).toEqual(["crm.request_update"]);
    expect([...CHAT_ACTION_ABILITIES["chat:appointment_policy_update"]]).toEqual(["calendar.booking_rules.update"]);
    expect([...CHAT_ACTION_ABILITIES["chat:calendar_create"]]).toEqual(["calendar.create"]);
  });

  it("the follow-up drafts also need the drafting ability, and no other capability has an extra requirement", () => {
    for (const key of CAPABILITY_KEYS) expect([...requiredAbilitiesForCapability(key)], key).toEqual(key === "pipeline_followup_drafts" ? ["drafts.create"] : []);
  });

  it("missingAbilities: at least one of anyOf, every one of allOf, and unreadable never passes", () => {
    const on = new Set(["a", "b"]);
    expect(missingAbilities(on, { anyOf: ["a", "x"] })).toBeNull();
    expect(missingAbilities(on, { anyOf: ["x", "y"] })).toEqual(["x", "y"]);
    expect(missingAbilities(on, { anyOf: ["a"], allOf: ["b"] })).toBeNull();
    expect(missingAbilities(on, { anyOf: ["a"], allOf: ["b", "z"] })).toEqual(["z"]);
    expect(missingAbilities(new Set(), { anyOf: ["a"] })).toEqual(["a"]);
    expect(missingAbilities(null, { anyOf: ["a"], allOf: ["b"] })).toEqual(["a", "b"]);
  });

  it("roleAbilitiesAllow follows the role's own list, and null abilities never allow", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const own = ROLE_ABILITIES[role];
      expect(roleAbilitiesAllow(role, new Set(own)), role).toBe(true);
      expect(roleAbilitiesAllow(role, new Set([own[own.length - 1]])), role).toBe(true);
      expect(roleAbilitiesAllow(role, new Set()), role).toBe(false);
      expect(roleAbilitiesAllow(role, null), role).toBe(false);
      // Another role's abilities do not count.
      const foreign = AGENT_ROLE_KEYS.filter((r) => r !== role).flatMap((r) => ROLE_ABILITIES[r]).filter((a) => !own.includes(a));
      expect(roleAbilitiesAllow(role, new Set(foreign)), role).toBe(false);
    }
  });
});

describe("the switch is enforced where work starts", () => {
  let a: Workspace;
  let b: Workspace;

  beforeAll(async () => {
    a = await workspace("Ability Roofing");
    b = await workspace("Ability Dental");
  }, 90000);

  it("reads what an employee may still do, as its role's tools minus the switched-off ones, and never across workspaces", async () => {
    const crm = await agentId(a.org.id, "crm_manager");
    expect([...(await withSystem((db) => employeeAbilities(db, a.org.id, crm, "crm_manager")))!].sort()).toEqual(["crm.read", "crm.request_update"]);
    await switchOff(a, "crm_manager", ["crm.request_update"]);
    expect([...(await readAbilities(a.ctx, crm, "crm_manager"))!]).toEqual(["crm.read"]);
    await switchOff(a, "crm_manager", []);
    // Another tenant's employee id, or the wrong role, is not found: null, which callers treat as "unreadable".
    const theirs = await agentId(b.org.id, "crm_manager");
    expect(await withSystem((db) => employeeAbilities(db, a.org.id, theirs, "crm_manager"))).toBeNull();
    expect(await withSystem((db) => employeeAbilities(db, a.org.id, crm, "sales_assistant"))).toBeNull();
  });

  it("with the ability on the work starts; with it off the dispatcher refuses, records the denial and creates no job", async () => {
    const ok = await dispatchCapabilityJob(a.ctx, { agentRole: "crm_manager", capability: "crm_quality_review", title: "Check the CRM", deferKick: true });
    expect(await jobRow(ok.jobId)).toMatchObject({ status: "queued" });

    await switchOff(a, "crm_manager", ["crm.read"]);
    const before = await jobCount(a.org.id);
    const deniedBefore = (await denials(a.org.id)).length;
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "crm_manager", capability: "crm_quality_review", title: "Check the CRM", deferKick: true }))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/CRM Manager has "Read CRM records" switched off in Allowed actions\. Nothing was started\./) });
    expect(await jobCount(a.org.id)).toBe(before);
    const rows = await denials(a.org.id);
    expect(rows).toHaveLength(deniedBefore + 1);
    expect(rows[rows.length - 1]).toMatchObject({ actor_user_id: a.owner.id, metadata: { actionId: "capability:crm_quality_review", role: "crm_manager", reason: expect.stringContaining("ability_switched_off: crm.read") } });

    // Switching it back on restores the work.
    await switchOff(a, "crm_manager", []);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "crm_manager", capability: "crm_quality_review", title: "Check the CRM", deferKick: true })).resolves.toMatchObject({ jobId: expect.any(String) });
  });

  it("only the switch that governs the capability matters, and another workspace is untouched", async () => {
    await switchOff(a, "crm_manager", ["crm.request_update"]);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "crm_manager", capability: "crm_quality_review", title: "Unrelated switch", deferKick: true })).resolves.toBeDefined();
    await switchOff(a, "crm_manager", ["crm.read"]);
    // Workspace B's CRM Manager still has everything on.
    await expect(dispatchCapabilityJob(b.ctx, { agentRole: "crm_manager", capability: "crm_quality_review", title: "Other tenant", deferKick: true })).resolves.toBeDefined();
    expect((await denials(b.org.id))).toHaveLength(0);
    await switchOff(a, "crm_manager", []);
  });

  it("a capability that lists several abilities runs while one is on and is refused when all are off", async () => {
    await switchOff(a, "lead_hunter", ["research.public_web"]);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "lead_hunter", capability: "lead_generation_review", title: "Review leads", deferKick: true })).resolves.toBeDefined();
    await switchOff(a, "lead_hunter", ["research.public_web", "leads.stage_for_review"]);
    const before = await jobCount(a.org.id);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "lead_hunter", capability: "lead_generation_review", title: "Review leads", deferKick: true }))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/switched off in Allowed actions/) });
    expect(await jobCount(a.org.id)).toBe(before);
    await switchOff(a, "lead_hunter", []);
  });

  it("follow-up drafts need the drafting ability even while the opportunity read is on, and the read-only pipeline review does not", async () => {
    await switchOff(a, "sales_assistant", ["drafts.create"]);
    const before = await jobCount(a.org.id);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "sales_assistant", capability: "pipeline_followup_drafts", title: "Drafts", deferKick: true }))
      .rejects.toMatchObject({ code: "forbidden", message: expect.stringContaining('"Draft messages (never sends them)"') });
    expect(await jobCount(a.org.id)).toBe(before);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "sales_assistant", capability: "pipeline_review", title: "Review", deferKick: true })).resolves.toBeDefined();
    await switchOff(a, "sales_assistant", []);
    await expect(dispatchCapabilityJob(a.ctx, { agentRole: "sales_assistant", capability: "pipeline_followup_drafts", title: "Drafts", deferKick: true })).resolves.toBeDefined();
  });

  it("every one of the 14 capabilities is refused when all of its abilities are off", async () => {
    // The employee's own role, for each capability; the dispatcher resolves the role's agent and the table decides.
    for (const key of CAPABILITY_KEYS) {
      const role = WORKFORCE_CAPABILITIES[key].allowedRoles.find((candidate): candidate is AgentRoleKey => candidate !== "growth_partner")!;
      await switchOff(a, role, [...new Set([...abilitiesForCapability(key), ...requiredAbilitiesForCapability(key)])]);
      const before = await jobCount(a.org.id);
      await expect(dispatchCapabilityJob(a.ctx, { agentRole: role, capability: key, title: key, deferKick: true }), key).rejects.toMatchObject({ code: "forbidden", message: expect.stringMatching(/Nothing was started/) });
      expect(await jobCount(a.org.id), key).toBe(before);
      await switchOff(a, role, []);
    }
  });

  it("null abilities (unreadable) fail closed and name that nothing was started", async () => {
    const crm = await agentId(a.org.id, "crm_manager");
    const need = capabilityNeed("crm_quality_review");
    // An employee that is not this workspace's, and a read that throws.
    const theirs = await agentId(b.org.id, "crm_manager");
    expect(await withSystem((db) => abilityRefusal(db, { orgId: a.org.id, agentId: theirs, roleKey: "crm_manager", need }))).toMatchObject({ reason: "ability_unreadable", message: expect.stringMatching(/could not be confirmed.*nothing was started/) });
    const broken: Queryable = { query: () => Promise.reject(new Error("db down")) };
    expect(await abilityRefusal(broken, { orgId: a.org.id, agentId: crm, roleKey: "crm_manager", need })).toMatchObject({ reason: "ability_unreadable" });
    await expect(assertAbility(broken, { orgId: a.org.id, agentId: crm, roleKey: "crm_manager", need, actionId: "capability:crm_quality_review" })).rejects.toMatchObject({ code: "forbidden" });
    expect(await withSystem((db) => abilityRefusal(db, { orgId: a.org.id, agentId: crm, roleKey: "crm_manager", need }))).toBeNull();
  });

  it("a job queued before the switch was turned off blocks at run time, runs nothing, and can be retried once it is back on", async () => {
    let ran = 0;
    registerWorkHandler("pipeline_review", async () => { ran += 1; });
    const queued = await dispatchCapabilityJob(a.ctx, { agentRole: "sales_assistant", capability: "pipeline_review", title: "Queued before the switch", deferKick: true });
    await switchOff(a, "sales_assistant", ["crm.read_opportunities"]);
    const deniedBefore = (await denials(a.org.id)).length;
    expect(await runWorkJob(queued.jobId)).toBe(true);

    expect(ran).toBe(0);
    expect(await jobRow(queued.jobId)).toMatchObject({ status: "blocked", failure_code: "ability_switched_off", failure_message: expect.stringMatching(/Sales Assistant has "Read CRM opportunities" switched off/) });
    expect(await eventText(queued.jobId)).toMatch(/Nothing was executed/);
    const rows = await denials(a.org.id);
    expect(rows).toHaveLength(deniedBefore + 1);
    expect(rows[rows.length - 1].metadata).toMatchObject({ actionId: "capability:pipeline_review", role: "sales_assistant", reason: expect.stringContaining("ability_switched_off") });
    // The row names the person whose request was blocked and the job it stopped.
    expect(rows[rows.length - 1]).toMatchObject({ actor_user_id: a.owner.id, metadata: { jobId: queued.jobId } });

    await switchOff(a, "sales_assistant", []);
    await withSystem((db) => retryWorkJob(db, { jobId: queued.jobId, orgId: a.org.id }));
    await runWorkJob(queued.jobId);
    expect(ran).toBe(1);
  });

  it("the launch sweep's dispatcher is unchanged: it starts the check, and the run blocks it", async () => {
    let ran = 0;
    registerWorkHandler("pipeline_review", async () => { ran += 1; });
    await switchOff(a, "sales_assistant", ["crm.read_opportunities"]);
    const started = await dispatchSystemCapabilityJob({ orgId: a.org.id, onBehalfOf: a.owner.id, agentRole: "sales_assistant", capability: "pipeline_review", title: "Final check", idempotencyKey: "ability-test:final-check" });
    expect(started.created).toBe(true);
    // The dispatcher wakes the worker itself, so the job settles on its own.
    expect(await settled(started.jobId)).toMatchObject({ status: "blocked", failure_code: "ability_switched_off" });
    expect(ran).toBe(0);
    await switchOff(a, "sales_assistant", []);
  });

  it("a job whose employee cannot be judged is refused, and a capability that is not a reviewed one is left to the runner", async () => {
    const crm = await agentId(a.org.id, "crm_manager");
    const theirs = await agentId(b.org.id, "crm_manager");
    expect(await withSystem((db) => jobAbilityRefusal(db, { orgId: a.org.id, agentId: theirs, capability: "crm_quality_review" }))).toMatchObject({ reason: "ability_unreadable", roleKey: null });
    expect(await withSystem((db) => jobAbilityRefusal(db, { orgId: a.org.id, agentId: crm, capability: "not_a_capability" }))).toBeNull();
    expect(await withSystem((db) => jobAbilityRefusal(db, { orgId: a.org.id, agentId: crm, capability: "crm_quality_review" }))).toBeNull();
    // Work filed under a role that may not do it at all is the handler's "not allowed", not a switch.
    expect(await withSystem((db) => jobAbilityRefusal(db, { orgId: a.org.id, agentId: crm, capability: "proactive_review" }))).toBeNull();
  });
});
