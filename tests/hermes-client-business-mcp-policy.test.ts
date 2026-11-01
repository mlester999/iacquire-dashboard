// The client tier's policy: which tools a client employee may be offered, which of them may only be PROPOSED, the two switches that turn the tier on (the deployment's flag and the
// workspace's own switch, the second read inside the caller's transaction), and the two rate limits that hold one workspace or one person apart from every other.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { AGENT_TOOLS, ROLE_SCOPES, toolsForRole, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import { businessMcpToolNamesForRole } from "@/server/workforce/hermes-business-mcp-policy";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { clearFeatureCache, featureOn, setOrgFeature } from "@/server/proposals/features";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  CLIENT_BUSINESS_PROPOSALS_FEATURE,
  CLIENT_BUSINESS_TOOL_MATRIX,
  CLIENT_BUSINESS_TOOLS_FEATURE,
  clientBusinessMcpRuntimeNamesForRole,
  clientBusinessMcpToolNamesForRole,
  clientBusinessProposalToolNamesForRole,
  clientBusinessProposalsOn,
  clientBusinessToolsOn,
} from "@/server/workforce/hermes-client-business-mcp-policy";
import { agencyUser, createOrg, createUser } from "./support/fixtures";

const CONTEXT = "get_role_workspace_context";

// The reads each role has today, written out on purpose. They are not computed from the internal tier's function or from the catalog: this test is what notices a tool that
// reaches a client without being listed here and reviewed.
const READS: Record<AgentRoleKey, string[]> = {
  operations_manager: ["find_contacts", "get_contact", "check_availability", "crm_summary_report", "list_opportunities"],
  lead_hunter: ["find_contacts", "get_contact"],
  appointment_setter: ["find_contacts", "get_contact", "check_availability", "get_conversation_history"],
  sales_assistant: ["find_contacts", "get_contact", "check_availability", "get_conversation_history", "list_opportunities"],
  crm_manager: ["find_contacts", "get_contact", "crm_summary_report", "list_opportunities"],
  performance_analyst: ["crm_summary_report", "list_opportunities"],
};

// What a role may PROPOSE: every catalog `write` tool its scopes allow. Messages and appointment requests (kind `proposal`) are not among them.
const PROPOSALS: Record<AgentRoleKey, string[]> = {
  operations_manager: ["create_task"],
  lead_hunter: ["apply_tag", "create_task", "remove_tag"],
  appointment_setter: ["apply_tag", "create_task", "remove_tag", "update_contact"],
  sales_assistant: ["apply_tag", "create_opportunity", "create_task", "move_opportunity_stage", "remove_tag", "update_contact"],
  crm_manager: ["apply_tag", "create_opportunity", "create_task", "move_opportunity_stage", "remove_tag", "update_contact"],
  performance_analyst: [],
};

const NEVER_OFFERED = ["request_appointment", "prepare_message", "request_send_approval"];

describe("the read tools a client employee is offered", () => {
  it("is the context tool plus exactly the reads listed above, for each of the six roles", () => {
    expect(Object.keys(READS).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    for (const role of AGENT_ROLE_KEYS) {
      expect(clientBusinessMcpToolNamesForRole(role), role).toEqual([CONTEXT, ...READS[role]]);
      expect([...CLIENT_BUSINESS_TOOL_MATRIX[role]], role).toEqual(READS[role]);
    }
  });

  it("offers nothing that changes anything unless proposals are asked for", () => {
    for (const role of AGENT_ROLE_KEYS) {
      for (const name of clientBusinessMcpToolNamesForRole(role)) {
        if (name !== CONTEXT) expect(AGENT_TOOLS[name].kind, `${role} ${name}`).toBe("read");
      }
    }
  });

  it("names the tools to the gateway the way the internal tier does, sorted", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const expected = [CONTEXT, ...READS[role]].map((name) => `mcp__iacquire_business__${name}`).sort();
      expect(clientBusinessMcpRuntimeNamesForRole(role), role).toEqual(expected);
    }
  });

  it("never offers a read the role's scopes do not allow, even if the matrix listed one", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const allowed = new Set<string>(toolsForRole(role, { includeClientOnly: true }));
      for (const name of CLIENT_BUSINESS_TOOL_MATRIX[role]) expect(allowed.has(name), `${role} ${name}`).toBe(true);
    }
    // The analyst has no contact or calendar scope, and the lead hunter has no report or calendar scope.
    expect(clientBusinessMcpToolNamesForRole("performance_analyst")).not.toContain("find_contacts");
    expect(clientBusinessMcpToolNamesForRole("lead_hunter")).not.toContain("check_availability");
    expect(clientBusinessMcpToolNamesForRole("lead_hunter")).not.toContain("crm_summary_report");
  });
});

describe("a tool only the client tier offers", () => {
  it("is offered to every role whose scopes allow it, never to a role without that scope, never as a proposal, and to no internal agency employee", () => {
    const allowedRoles = AGENT_ROLE_KEYS.filter((role) => ROLE_SCOPES[role].includes(AGENT_TOOLS.list_opportunities.scope));
    const deniedRoles = AGENT_ROLE_KEYS.filter((role) => !allowedRoles.includes(role));
    expect(allowedRoles.length).toBeGreaterThan(0);
    expect(deniedRoles.length).toBeGreaterThan(0);
    for (const role of allowedRoles) {
      expect(CLIENT_BUSINESS_TOOL_MATRIX[role], role).toContain("list_opportunities");
      expect(clientBusinessMcpToolNamesForRole(role), role).toContain("list_opportunities");
      expect(clientBusinessMcpRuntimeNamesForRole(role), role).toContain("mcp__iacquire_business__list_opportunities");
    }
    for (const role of deniedRoles) {
      expect(CLIENT_BUSINESS_TOOL_MATRIX[role], role).not.toContain("list_opportunities");
      expect(clientBusinessMcpToolNamesForRole(role), role).not.toContain("list_opportunities");
    }
    for (const role of AGENT_ROLE_KEYS) {
      expect(clientBusinessProposalToolNamesForRole(role), role).not.toContain("list_opportunities");
      expect(businessMcpToolNamesForRole(role, true), role).not.toContain("list_opportunities");
    }
  });

  it("is dropped for a role whose scopes lose the deals scope, even while the matrix lists it", () => {
    const matrix = CLIENT_BUSINESS_TOOL_MATRIX as unknown as Record<AgentRoleKey, AgentToolName[]>;
    const saved = [...matrix.lead_hunter];
    try {
      matrix.lead_hunter = [...saved, "list_opportunities"];
      expect(clientBusinessMcpToolNamesForRole("lead_hunter")).not.toContain("list_opportunities");
    } finally {
      matrix.lead_hunter = saved;
    }
  });
});

describe("the changes a client employee may propose", () => {
  it("are the write tools its scopes allow, as listed above, and never a message or a booking", () => {
    for (const role of AGENT_ROLE_KEYS) {
      expect([...clientBusinessProposalToolNamesForRole(role)].sort(), role).toEqual(PROPOSALS[role]);
      for (const name of clientBusinessProposalToolNamesForRole(role)) {
        expect(AGENT_TOOLS[name].kind, `${role} ${name}`).toBe("write");
        expect(NEVER_OFFERED).not.toContain(name);
      }
    }
  });

  it("add exactly those names to the list, and only when asked for", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const withProposals = clientBusinessMcpToolNamesForRole(role, { proposals: true });
      expect([...withProposals].sort(), role).toEqual([CONTEXT, ...READS[role], ...PROPOSALS[role]].sort());
      expect(clientBusinessMcpToolNamesForRole(role, { proposals: false })).toEqual([CONTEXT, ...READS[role]]);
      expect(clientBusinessMcpRuntimeNamesForRole(role, { proposals: true })).toEqual(withProposals.map((name) => `mcp__iacquire_business__${name}`).sort());
      for (const never of NEVER_OFFERED) expect(withProposals).not.toContain(never);
    }
  });

  it("stay inside what the role's scopes allow", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const scopes = new Set<string>(ROLE_SCOPES[role]);
      for (const name of clientBusinessProposalToolNamesForRole(role)) expect(scopes.has(AGENT_TOOLS[name].scope), `${role} ${name}`).toBe(true);
    }
  });
});

describe("the two switches that turn the tier on", () => {
  const FLAGS = ["HERMES_CLIENT_BUSINESS_MCP_ENABLED", "HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED"];
  const flags = (values: Record<string, string>) => {
    for (const name of FLAGS) vi.stubEnv(name, values[name] ?? "false");
    resetEnvCache();
  };
  const on = (orgId: string, feature: string, enabled = true) =>
    withSystem((db) => db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = excluded.enabled", [orgId, feature, enabled]));
  const toolsOn = (orgId: string) => withSystem((db) => clientBusinessToolsOn(orgId, db));
  const proposalsOn = (orgId: string) => withSystem((db) => clientBusinessProposalsOn(orgId, db));

  beforeEach(() => {
    clearFeatureCache();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetEnvCache();
  });

  it("is off for every workspace by default: no flag and no row", async () => {
    const org = await createOrg({ kind: "client" });
    flags({});
    expect(await toolsOn(org.id)).toBe(false);
    expect(await proposalsOn(org.id)).toBe(false);
  });

  it("needs the deployment flag AND the workspace's own switch", async () => {
    const org = await createOrg({ kind: "client" });
    await on(org.id, CLIENT_BUSINESS_TOOLS_FEATURE);
    flags({});
    expect(await toolsOn(org.id)).toBe(false);
    flags({ HERMES_CLIENT_BUSINESS_MCP_ENABLED: "true" });
    expect(await toolsOn(org.id)).toBe(true);
    const other = await createOrg({ kind: "client" });
    expect(await toolsOn(other.id)).toBe(false);
  });

  it("needs the tier, both proposals flags and both workspace switches for proposals", async () => {
    const org = await createOrg({ kind: "client" });
    flags({ HERMES_CLIENT_BUSINESS_MCP_ENABLED: "true", HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED: "true" });
    await on(org.id, CLIENT_BUSINESS_PROPOSALS_FEATURE);
    expect(await proposalsOn(org.id)).toBe(false); // the proposals switch alone is not the tier
    await on(org.id, CLIENT_BUSINESS_TOOLS_FEATURE);
    expect(await proposalsOn(org.id)).toBe(true);
    flags({ HERMES_CLIENT_BUSINESS_MCP_ENABLED: "true" });
    expect(await proposalsOn(org.id)).toBe(false); // the deployment's proposals flag is off
    flags({ HERMES_CLIENT_BUSINESS_MCP_ENABLED: "true", HERMES_CLIENT_BUSINESS_MCP_PROPOSALS_ENABLED: "true" });
    await on(org.id, CLIENT_BUSINESS_PROPOSALS_FEATURE, false);
    expect(await proposalsOn(org.id)).toBe(false);
    expect(await toolsOn(org.id)).toBe(true); // reads are unaffected by the proposals switch
  });

  it("sees a switch-off at once: the read happens in the caller's transaction, not through the three-second cache", async () => {
    const org = await createOrg({ kind: "client" });
    flags({ HERMES_CLIENT_BUSINESS_MCP_ENABLED: "true" });
    await on(org.id, CLIENT_BUSINESS_TOOLS_FEATURE);
    // The cached form is primed and keeps answering "on" after the row changes underneath it; the tier's own check does not.
    const primedAt = Date.now();
    expect(await featureOn(org.id, CLIENT_BUSINESS_TOOLS_FEATURE)).toBe(true);
    await on(org.id, CLIENT_BUSINESS_TOOLS_FEATURE, false);
    // The cache window is judged against a clock held at the moment it was primed, so a slow database call on a loaded machine cannot expire the entry between the two reads.
    const frozen = vi.spyOn(Date, "now").mockReturnValue(primedAt);
    try {
      expect(await featureOn(org.id, CLIENT_BUSINESS_TOOLS_FEATURE)).toBe(true);
    } finally {
      frozen.mockRestore();
    }
    expect(await toolsOn(org.id)).toBe(false);
  });

  it("is switched by a Super Admin through the existing audited switch, and by nobody else", async () => {
    const org = await createOrg({ kind: "client" });
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const staff = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    flags({ HERMES_CLIENT_BUSINESS_MCP_ENABLED: "true" });
    await expect(setOrgFeature(staff, { orgId: org.id, feature: CLIENT_BUSINESS_TOOLS_FEATURE, enabled: true })).rejects.toMatchObject({ code: "forbidden" });
    expect(await toolsOn(org.id)).toBe(false);
    await setOrgFeature(admin, { orgId: org.id, feature: CLIENT_BUSINESS_TOOLS_FEATURE, enabled: true });
    expect(await toolsOn(org.id)).toBe(true);
    await setOrgFeature(admin, { orgId: org.id, feature: CLIENT_BUSINESS_TOOLS_FEATURE, enabled: false });
    expect(await toolsOn(org.id)).toBe(false);
  });
});

describe("the rate limits", () => {
  beforeAll(async () => {
    await withSystem((db) => db.query("delete from rate_limit_buckets"));
  });

  it("names two new rules and leaves every other rule's name and number alone", () => {
    expect(RATE_LIMITS.clientBusinessMcpByOrg).toEqual({ name: "client-business-mcp:org", limit: 240, windowSeconds: 60 });
    expect(RATE_LIMITS.clientBusinessMcpByUser).toEqual({ name: "client-business-mcp:user", limit: 30, windowSeconds: 60 });
    // The internal tier's rules, exactly as they were.
    expect(RATE_LIMITS.agentToolCallsByEmployee).toEqual({ name: "agent-tools:employee", limit: 60, windowSeconds: 60 });
    expect(RATE_LIMITS.agentToolAuthFailureByIp).toEqual({ name: "agent-tools:auth-fail:ip", limit: 30, windowSeconds: 600 });
    const names = Object.values(RATE_LIMITS).map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("holds one workspace to its limit without touching another workspace or the per-employee rule", async () => {
    const a = `org-a-${Math.random().toString(36).slice(2)}`;
    const b = `org-b-${Math.random().toString(36).slice(2)}`;
    const rule = RATE_LIMITS.clientBusinessMcpByOrg;
    for (let i = 0; i < rule.limit; i += 1) expect((await consumeRateLimit(rule, a)).allowed).toBe(true);
    const over = await consumeRateLimit(rule, a);
    expect(over).toMatchObject({ allowed: false, remaining: 0 });
    expect(over.retryAfterSeconds).toBeGreaterThanOrEqual(1);
    expect(await consumeRateLimit(rule, b)).toMatchObject({ allowed: true, remaining: rule.limit - 1 });
    // The same key under the internal rule is a different bucket.
    expect(await consumeRateLimit(RATE_LIMITS.agentToolCallsByEmployee, a)).toMatchObject({ allowed: true, remaining: RATE_LIMITS.agentToolCallsByEmployee.limit - 1 });
  });

  it("holds one person to their limit without touching another person or the workspace rule", async () => {
    const one = `user-1-${Math.random().toString(36).slice(2)}`;
    const two = `user-2-${Math.random().toString(36).slice(2)}`;
    const rule = RATE_LIMITS.clientBusinessMcpByUser;
    for (let i = 0; i < rule.limit; i += 1) expect((await consumeRateLimit(rule, one)).allowed).toBe(true);
    expect((await consumeRateLimit(rule, one)).allowed).toBe(false);
    expect((await consumeRateLimit(rule, two)).allowed).toBe(true);
    expect((await consumeRateLimit(RATE_LIMITS.clientBusinessMcpByOrg, one)).allowed).toBe(true);
  });
});
