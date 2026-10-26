// The six AI employees' tool policy: one table, deny by default, decided from the employee's database row and never from anything a prompt or a model says. The pure table is frozen
// here role by role (a change must be a visible edit to this file), then walked against the real enforcement code: the server's authorization and its audit trail, capability dispatch,
// the Hermes tool-inventory verifier (shared reviewed set, or the role's narrower set when enforced) and the profile configuration the host-side worker is given.
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES, roleMayUseCapability, type CapabilityKey } from "@/lib/workforce-capabilities";
import { AGENT_TOOL_SCOPES, ROLE_SCOPES } from "@/lib/agent-tool-scopes";
import {
  RUNTIME_TOOL_ROLES, allPolicyActionIds, authorizeEmployeeAction, employeeActions, requiredRuntimeToolsFor, roleToolEnforcement, runtimeToolExposure, runtimeToolsFor, runtimeToolsetsFor,
} from "@/lib/employee-tool-policy";
import { evaluateRequirements, EMPTY_WORKSPACE_FACTS } from "@/lib/employee-requirements";
import { decideAgentAction, enforceAgentAction } from "@/server/workforce/action-policy";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { verifyToolInventory, ToolInventoryError } from "@/server/integrations/hermes/inventory";
import { buildConfigYaml } from "@/server/workforce/provisioning";
import { addMember, agentId, createOrg, createUser, ctxFor } from "./support/fixtures";
import { startMockHermes, type MockHermes, type MockInventoryTool } from "./support/mock-hermes";

const FROZEN: Record<AgentRoleKey, string[]> = {
  operations_manager: ["capability:proactive_review", "crm:contacts:read", "crm:tasks:write", "crm:opportunities:read", "crm:calendar:read", "crm:reports:read", "runtime:memory", "runtime:session_search", "runtime:todo_list", "runtime:vision_analyze"],
  lead_hunter: ["capability:lead_research", "capability:lead_generation_review", "crm:contacts:read", "crm:tags:write", "crm:tasks:write", "runtime:memory", "runtime:session_search", "runtime:todo_list", "runtime:vision_analyze", "runtime:web_search", "runtime:web_extract"],
  appointment_setter: ["capability:appointment_review", "capability:appointment_availability", "capability:missed_call_review", "chat:booking_request", "chat:appointment_change", "crm:contacts:read", "crm:contacts:write", "crm:tags:write", "crm:tasks:write", "crm:calendar:read", "crm:appointments:request", "crm:conversations:read", "crm:messages:draft", "runtime:memory", "runtime:session_search", "runtime:todo_list", "runtime:vision_analyze"],
  sales_assistant: ["capability:pipeline_review", "capability:pipeline_followup_drafts", "capability:lead_priority_review", "crm:contacts:read", "crm:contacts:write", "crm:tags:write", "crm:tasks:write", "crm:opportunities:read", "crm:opportunities:write", "crm:calendar:read", "crm:conversations:read", "crm:messages:draft", "runtime:memory", "runtime:session_search", "runtime:todo_list", "runtime:vision_analyze"],
  crm_manager: ["capability:crm_quality_review", "crm:contacts:read", "crm:contacts:write", "crm:tags:write", "crm:tasks:write", "crm:opportunities:read", "crm:opportunities:write", "crm:reports:read", "runtime:memory", "runtime:session_search", "runtime:todo_list", "runtime:vision_analyze"],
  performance_analyst: ["capability:social_performance_review", "capability:receivables_review", "capability:reputation_review", "capability:performance_snapshot", "crm:opportunities:read", "crm:reports:read", "runtime:memory", "runtime:session_search", "runtime:todo_list", "runtime:vision_analyze"],
};

describe("the policy table, role by role", () => {
  it("is exactly the frozen table for each of the six roles", () => {
    for (const role of AGENT_ROLE_KEYS) expect(employeeActions(role).map((a) => a.id), role).toEqual(FROZEN[role]);
  });

  it("agrees with the capability registry and the CRM scope table it is built from, and invents nothing", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const ids = new Set(employeeActions(role).map((a) => a.id));
      for (const key of CAPABILITY_KEYS) expect(ids.has(`capability:${key}`), `${role}/${key}`).toBe(roleMayUseCapability(role, key));
      for (const scope of AGENT_TOOL_SCOPES) expect(ids.has(`crm:${scope}`), `${role}/${scope}`).toBe(ROLE_SCOPES[role].includes(scope));
    }
    const known = new Set(allPolicyActionIds());
    for (const role of AGENT_ROLE_KEYS) for (const a of employeeActions(role)) expect(known.has(a.id), a.id).toBe(true);
  });

  it("gives every role something it can do without approval and marks everything that changes anything as needing a person", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const actions = employeeActions(role);
      expect(actions.some((a) => a.approval === "none" && a.effect === "read"), role).toBe(true);
      for (const a of actions) {
        if (a.effect !== "read") expect(a.approval, `${role}/${a.id}`).toBe("person_decides");
        if (a.kind === "capability") expect(a.effect === "read", a.id).toBe(WORKFORCE_CAPABILITIES[a.id.slice("capability:".length) as CapabilityKey].risk === "read_only");
      }
    }
  });

  it("denies every action a role does not own, for every role and every action in the product", () => {
    let denied = 0;
    for (const role of AGENT_ROLE_KEYS) {
      const own = new Set(FROZEN[role]);
      for (const id of allPolicyActionIds()) {
        const d = authorizeEmployeeAction(role, id);
        expect(d.allowed, `${role} / ${id}`).toBe(own.has(id));
        if (!d.allowed) denied += 1;
      }
    }
    expect(denied).toBeGreaterThan(100);
  });

  it("denies by default: unknown actions, odd spellings, prototype names and a role that is not one of the six", () => {
    const strange = ["", " ", "capability:", "capability:lead_research ", "CAPABILITY:LEAD_RESEARCH", "capability:lead_research;drop table agent_instances", "capability:__proto__", "crm:*", "crm:admin", "runtime:terminal", "runtime:shell", "runtime:browser", "chat:send_email", "chat:send_sms", "admin:everything", "../../etc/passwd", "constructor", "__proto__", "toString"];
    for (const role of AGENT_ROLE_KEYS) for (const id of strange) expect(authorizeEmployeeAction(role, id).allowed, `${role} / ${JSON.stringify(id)}`).toBe(false);
    for (const role of ["", "owner", "agency_super_admin", "LEAD_HUNTER", "__proto__", "lead-hunter", "superuser"]) {
      for (const id of ["capability:lead_research", "runtime:memory", "crm:contacts:read"]) expect(authorizeEmployeeAction(role, id).allowed, `${role} / ${id}`).toBe(false);
    }
  });

  it("cannot be widened by what a request says: the decision takes only a role and an action id", () => {
    // There is no parameter through which text from a customer, a prompt or a model could name a different role or grant a tool; the only inputs are these two strings, and the role string
    // is read from the employee's database row by the server (see the next block).
    expect(authorizeEmployeeAction.length).toBe(2);
    expect(authorizeEmployeeAction("sales_assistant", "capability:lead_research")).toMatchObject({ allowed: false });
    expect(authorizeEmployeeAction("sales_assistant", "runtime:web_search")).toMatchObject({ allowed: false });
  });

  it("limits public web research to the Lead Hunter, and nothing sends a message or books by itself", () => {
    for (const role of AGENT_ROLE_KEYS) expect(runtimeToolsFor(role).includes("web_search"), role).toBe(role === "lead_hunter");
    for (const role of AGENT_ROLE_KEYS) for (const a of employeeActions(role)) expect(/send|book_now|publish|delete|export|import|campaign/.test(a.id), `${role}/${a.id}`).toBe(false);
    expect(Object.keys(RUNTIME_TOOL_ROLES).sort()).toEqual(["memory", "session_search", "todo_list", "vision_analyze", "web_extract", "web_search"]);
  });
});

describe("tool exposure and the toolsets a role's profile should enable", () => {
  it("derives each role's toolsets, required tools and optional tools", () => {
    expect(runtimeToolsetsFor("lead_hunter")).toEqual(["memory", "session_search", "todo", "vision", "web"]);
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter")) expect(runtimeToolsetsFor(role), role).toEqual(["memory", "session_search", "todo", "vision"]);
    expect(requiredRuntimeToolsFor("lead_hunter")).toEqual(["memory", "session_search", "todo_list", "web_search", "web_extract"]);
    expect(requiredRuntimeToolsFor("crm_manager")).toEqual(["memory", "session_search", "todo_list"]);
  });

  it("judges an exposed tool list: excess beyond the role, and missing tools the role needs", () => {
    const shared = ["memory", "session_search", "todo_list", "vision_analyze", "web_search", "web_extract"];
    expect(runtimeToolExposure("lead_hunter", shared)).toEqual({ ok: true, excess: [], missing: [] });
    expect(runtimeToolExposure("sales_assistant", shared)).toEqual({ ok: false, excess: ["web_extract", "web_search"], missing: [] });
    expect(runtimeToolExposure("appointment_setter", ["memory", "session_search", "todo_list"])).toEqual({ ok: true, excess: [], missing: [] });
    expect(runtimeToolExposure("lead_hunter", ["memory", "session_search", "todo_list"])).toEqual({ ok: false, excess: [], missing: ["web_extract", "web_search"] });
    expect(runtimeToolExposure("crm_manager", [...shared, "terminal"]).excess).toEqual(["terminal", "web_extract", "web_search"]);
  });

  it("enforces unless a deployment deliberately asks for report-only, and reads that switch strictly", () => {
    // The table above is a security boundary, so the strict answer is the default: an unset variable, a typo, or a word that only looks like an opt-out keeps enforcing.
    expect(roleToolEnforcement({})).toBe("enforce");
    expect(roleToolEnforcement({ WORKFORCE_ROLE_TOOL_ENFORCEMENT: "report" })).toBe("report");
    for (const v of ["enforce", "ENFORCE", "true", "1", "on", "report ", "Report", ""]) expect(roleToolEnforcement({ WORKFORCE_ROLE_TOOL_ENFORCEMENT: v }), v).toBe("enforce");
  });

  it("writes the role's own toolsets into a profile's configuration, and the shared reviewed set only when a deployment opts into report-only", () => {
    delete process.env.WORKFORCE_ROLE_TOOL_ENFORCEMENT;
    expect(buildConfigYaml(undefined, "lead_hunter")).toContain("    - web\n");
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter")) {
      const yaml = buildConfigYaml(undefined, role);
      expect(yaml, role).not.toContain("    - web\n");
      expect(yaml, role).toContain("    - memory\n    - session_search\n    - todo\n    - vision\n    - no_mcp\n");
    }
    // Without a role (the internal agency profiles, whose policy is applied per run) the shared reviewed set is unchanged.
    expect(buildConfigYaml()).toContain("    - web\n");
    process.env.WORKFORCE_ROLE_TOOL_ENFORCEMENT = "report";
    try {
      for (const role of AGENT_ROLE_KEYS) expect(buildConfigYaml(undefined, role), role).toContain("    - web\n");
    } finally {
      delete process.env.WORKFORCE_ROLE_TOOL_ENFORCEMENT;
    }
  });
});

describe("the server: tenant scoping, the role from the database row, and the audit trail", () => {
  let org: Awaited<ReturnType<typeof createOrg>>;
  let other: Awaited<ReturnType<typeof createOrg>>;
  let owner: { id: string; email: string };
  const ids: Partial<Record<AgentRoleKey, string>> = {};
  let otherAgent: string;

  beforeAll(async () => {
    org = await createOrg({ name: "Policy Co" });
    other = await createOrg({ name: "Other Policy Co" });
    owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    for (const role of AGENT_ROLE_KEYS) ids[role] = await agentId(org.id, role);
    otherAgent = await agentId(other.id, "sales_assistant");
  });

  const denials = async (orgId: string) => (await withSystem((db) => db.query<{ metadata: { actionId: string; role: string | null; reason: string }; actor_user_id: string | null }>(
    "select metadata, actor_user_id from audit_logs where org_id = $1 and action = 'agent.action_denied' order by id", [orgId]))).rows;

  it("reads the role from the employee's own row, and allows exactly what that role owns", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      for (const id of allPolicyActionIds()) {
        const attempt = enforceAgentAction({ orgId: org.id, agentId: ids[role]!, actionId: id, actorUserId: owner.id, actorKind: "user" });
        if (FROZEN[role].includes(id)) await expect(attempt, `${role}/${id}`).resolves.toMatchObject({ role });
        else await expect(attempt, `${role}/${id}`).rejects.toMatchObject({ code: "forbidden" });
      }
    }
  });

  it("records every refusal against the caller's workspace with the role, the action and the reason, and records no allowance", async () => {
    const rows = await denials(org.id);
    expect(rows.length).toBeGreaterThan(100);
    for (const r of rows) {
      expect(r.metadata.actionId).toMatch(/^(capability|chat|crm|runtime):/);
      expect(AGENT_ROLE_KEYS as readonly string[]).toContain(r.metadata.role);
      expect(r.metadata.reason.length).toBeGreaterThan(10);
      expect(r.actor_user_id).toBe(owner.id);
    }
    expect(rows.some((r) => r.metadata.role === "sales_assistant" && r.metadata.actionId === "runtime:web_search")).toBe(true);
    expect(await denials(other.id)).toEqual([]);
  });

  it("treats another workspace's employee as not found, and the attempt is on the caller's record", async () => {
    const before = (await denials(org.id)).length;
    await expect(enforceAgentAction({ orgId: org.id, agentId: otherAgent, actionId: "runtime:memory", actorUserId: owner.id, actorKind: "user" })).rejects.toMatchObject({ code: "not_found" });
    const after = await denials(org.id);
    expect(after.length).toBe(before + 1);
    expect(after.at(-1)?.metadata.reason).toMatch(/does not belong to this workspace/);
    expect(await denials(other.id)).toEqual([]);
  });

  it("decides without writing or throwing, so a refusal inside a caller's transaction cannot roll back its own record", async () => {
    const d = await withSystem((db) => decideAgentAction(db, { orgId: org.id, agentId: ids.crm_manager!, actionId: "capability:lead_research" }));
    expect(d).toMatchObject({ allowed: false, code: "forbidden", role: "crm_manager" });
    const gone = await withSystem((db) => decideAgentAction(db, { orgId: org.id, agentId: otherAgent, actionId: "runtime:memory" }));
    expect(gone).toMatchObject({ allowed: false, code: "not_found", role: null });
    const ok = await withSystem((db) => decideAgentAction(db, { orgId: org.id, agentId: ids.lead_hunter!, actionId: "runtime:web_search" }));
    expect(ok).toMatchObject({ allowed: true, role: "lead_hunter" });
  });

  it("refuses to dispatch another role's work, creates no job, and records who asked", async () => {
    const ctx = ctxFor(owner, org, "owner");
    const jobsBefore = Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from ai_work_jobs where org_id = $1", [org.id]))).rows[0].n);
    const denialsBefore = (await denials(org.id)).length;
    let attempts = 0;
    for (const role of AGENT_ROLE_KEYS) {
      for (const capability of CAPABILITY_KEYS) {
        if (roleMayUseCapability(role, capability)) continue;
        await expect(dispatchCapabilityJob(ctx, { agentRole: role, capability, title: "Prompt told me to", deferKick: true }), `${role}/${capability}`).rejects.toMatchObject({ code: "forbidden" });
        attempts += 1;
      }
    }
    expect(Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from ai_work_jobs where org_id = $1", [org.id]))).rows[0].n)).toBe(jobsBefore);
    expect((await denials(org.id)).length).toBe(denialsBefore + attempts);
  });
});

describe("the Hermes tool inventory against the role policy", () => {
  const KEY = "r".repeat(40);
  // The rest of the suite runs legacy fixtures in report mode (vitest.config.ts); this suite is where the enforced path is proved, so every case starts from the
  // code's own default by removing the suite-wide opt-out.
  beforeEach(() => { delete process.env.WORKFORCE_ROLE_TOOL_ENFORCEMENT; });
  afterEach(() => { delete process.env.WORKFORCE_ROLE_TOOL_ENFORCEMENT; });
  const SHARED: MockInventoryTool[] = [
    { name: "memory", toolset: "memory" }, { name: "session_search", toolset: "session_search" }, { name: "todo_list", toolset: "todo" },
    { name: "vision_analyze", toolset: "vision" }, { name: "web_search", toolset: "web" }, { name: "web_extract", toolset: "web" },
  ];
  const NO_WEB = SHARED.filter((t) => t.toolset !== "web");
  let mock: MockHermes;
  const profiles = { shared: "c-policy-shared", narrow: "c-policy-narrow" };

  beforeAll(async () => {
    mock = await startMockHermes({
      [profiles.shared]: { key: KEY, inventory: { tools: SHARED, enabledToolsets: ["memory", "session_search", "todo", "vision", "web"] } },
      [profiles.narrow]: { key: KEY, inventory: { tools: NO_WEB, enabledToolsets: ["memory", "session_search", "todo", "vision"] } },
    });
  });

  const conn = (profile: string, roleKey: AgentRoleKey | null, orgKind: "client" | "agency" | null) => ({ baseUrl: mock.url, profile, apiKey: KEY, roleKey, orgKind });
  const verify = (profile: string, roleKey: AgentRoleKey | null, orgKind: "client" | "agency" | null) => verifyToolInventory(conn(profile, roleKey, orgKind), { stabilityReads: 2, purpose: "health" });

  it("by default refuses a client profile that exposes the web tools to a role the table does not give them", async () => {
    // This is the boundary the table exists for: a Sales Assistant that can search the web can be talked into sending what it read somewhere. The default is now the
    // strict answer, so the shared profile (which carries the web toolset) is refused for every role but the Lead Hunter.
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter")) {
      await expect(verify(profiles.shared, role, "client"), role).rejects.toMatchObject({ code: "inventory_unsafe", message: expect.stringMatching(/not allowed: web/) });
    }
    await expect(verify(profiles.shared, "lead_hunter", "client")).resolves.toMatchObject({ toolCount: 6 });
    // And a profile that carries exactly its role's tools is accepted.
    await expect(verify(profiles.narrow, "appointment_setter", "client")).resolves.toMatchObject({ toolCount: 4 });
  });

  it("accepts the shared reviewed set for every role when a deployment has deliberately opted into report-only", async () => {
    process.env.WORKFORCE_ROLE_TOOL_ENFORCEMENT = "report";
    for (const role of AGENT_ROLE_KEYS) await expect(verify(profiles.shared, role, "client"), role).resolves.toMatchObject({ toolCount: 6 });
    await expect(verify(profiles.narrow, "appointment_setter", "client")).rejects.toBeInstanceOf(ToolInventoryError); // the shared contract still wants the web tools
  });

  it("refuses a client profile with more or fewer tools than its role allows", async () => {
    for (const role of AGENT_ROLE_KEYS.filter((r) => r !== "lead_hunter")) {
      await expect(verify(profiles.narrow, role, "client"), `${role} narrow`).resolves.toMatchObject({ toolCount: 4 });
      await expect(verify(profiles.shared, role, "client"), `${role} shared`).rejects.toMatchObject({ code: "inventory_unsafe", message: expect.stringMatching(/not allowed: web/) });
    }
    await expect(verify(profiles.shared, "lead_hunter", "client")).resolves.toMatchObject({ toolCount: 6 });
    await expect(verify(profiles.narrow, "lead_hunter", "client")).rejects.toMatchObject({ code: expect.stringMatching(/inventory_unsafe|inventory_incomplete/), message: expect.stringMatching(/missing/) });
  });

  it("leaves the internal agency profiles and connections without a role on the shared reviewed set", async () => {
    await expect(verify(profiles.shared, "sales_assistant", "agency")).resolves.toMatchObject({ toolCount: 6 });
    await expect(verify(profiles.shared, null, null)).resolves.toMatchObject({ toolCount: 6 });
  });
});

describe("what the screens say", () => {
  it("adds an advisory 'tools limited to this role' prerequisite only when the recorded inventory is known, and never blocks on it", () => {
    expect(evaluateRequirements("sales_assistant", EMPTY_WORKSPACE_FACTS).some((r) => r.key === "role_tools")).toBe(false);
    const wide = evaluateRequirements("sales_assistant", EMPTY_WORKSPACE_FACTS, { runtimeToolsExcess: ["web_extract", "web_search"] }).find((r) => r.key === "role_tools")!;
    expect(wide).toMatchObject({ met: false, blocking: false });
    expect(wide.detail).toMatch(/web_extract, web_search/);
    expect(wide.detail).toMatch(/portal refuses those actions/);
    expect(evaluateRequirements("sales_assistant", EMPTY_WORKSPACE_FACTS, { runtimeToolsExcess: [] }).find((r) => r.key === "role_tools")).toMatchObject({ met: true, blocking: false });
  });
});
