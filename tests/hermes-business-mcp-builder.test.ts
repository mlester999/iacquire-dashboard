// The shared pieces of the business MCP bridge that a second tier is built from: the server builder, the stateless transport helper, the per-organization-kind context, and the
// internal agency tier's tool list, which is written out so no catalog addition can reach the live internal employees. Synthetic workspaces only; no network, no Hermes.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { AGENT_TOOLS, AGENT_TOOL_NAMES, ROLE_SCOPES, toolsForRole, type AgentToolName } from "@/server/crm/agent-tools/catalog";
import type { AgentToolReply } from "@/server/crm/agent-tools/service";
import { loadOrgContextForUser } from "@/server/tenancy/context";
import {
  buildBusinessMcpServer, buildRoleWorkspaceContext, serveStatelessBusinessMcp, RECORDS_ARE_DATA, type ActiveChatRun, type BusinessMcpServerDeps,
} from "@/server/workforce/hermes-business-mcp";
import {
  businessMcpRuntimeNamesForRole, businessMcpToolNamesForRole, HERMES_BUSINESS_CONTEXT_TOOL, hermesMcpToolName, type BusinessMcpToolName,
} from "@/server/workforce/hermes-business-mcp-policy";
import { addMember, agentId, createOrg, createUser } from "./support/fixtures";

// The agency's own operations snapshot is mocked: the question here is only whether it is asked for, not what it holds.
const internalOps = vi.hoisted(() => ({ calls: [] as Array<{ orgId: string; roleKey: string }> }));
vi.mock("@/server/workforce/internal-capability-context", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/workforce/internal-capability-context")>()),
  prepareInternalEmployeeContext: vi.fn(async (_db: unknown, input: { orgId: string; roleKey: string }) => {
    internalOps.calls.push({ orgId: input.orgId, roleKey: input.roleKey });
    return { allowed: true as const, snapshot: { marker: "internal-operations-snapshot" } };
  }),
}));
vi.mock("@/server/workforce/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/workforce/service")>()),
  buildRunInstructions: vi.fn(async () => ({ instructions: "synthetic instructions" })),
}));

const APP_URL = "https://portal.example.test";
const ENDPOINT = `${APP_URL}/api/internal/hermes-business/mcp`;

/**
 * The internal agency tier's tools, written out as they were when they were derived from the catalog (the capability matrix pins the same lists). Reads first and, with the
 * writes switch on, the writes in catalog order. Nothing a later catalog change adds can appear here without this table being edited on purpose.
 */
const INTERNAL_READS: Record<AgentRoleKey, AgentToolName[]> = {
  operations_manager: ["find_contacts", "get_contact", "check_availability", "crm_summary_report"],
  lead_hunter: ["find_contacts", "get_contact"],
  appointment_setter: ["find_contacts", "get_contact", "check_availability", "get_conversation_history"],
  sales_assistant: ["find_contacts", "get_contact", "check_availability", "get_conversation_history"],
  crm_manager: ["find_contacts", "get_contact", "crm_summary_report"],
  performance_analyst: ["crm_summary_report"],
};
const INTERNAL_WITH_WRITES: Record<AgentRoleKey, AgentToolName[]> = {
  operations_manager: ["find_contacts", "get_contact", "create_task", "check_availability", "crm_summary_report"],
  lead_hunter: ["find_contacts", "get_contact", "apply_tag", "remove_tag", "create_task"],
  appointment_setter: ["find_contacts", "get_contact", "update_contact", "apply_tag", "remove_tag", "create_task", "check_availability", "get_conversation_history"],
  sales_assistant: ["find_contacts", "get_contact", "update_contact", "apply_tag", "remove_tag", "create_task", "create_opportunity", "move_opportunity_stage", "check_availability", "get_conversation_history"],
  crm_manager: ["find_contacts", "get_contact", "update_contact", "apply_tag", "remove_tag", "create_task", "create_opportunity", "move_opportunity_stage", "crm_summary_report"],
  performance_analyst: ["crm_summary_report"],
};
/** Catalog reads a role's scopes allow that the internal tier deliberately does not offer. A new catalog read shows up here and fails until someone decides where it belongs. */
const NOT_OFFERED_INTERNALLY: Record<AgentRoleKey, AgentToolName[]> = {
  operations_manager: ["list_opportunities"],
  lead_hunter: [],
  appointment_setter: [],
  sales_assistant: ["list_opportunities"],
  crm_manager: ["list_opportunities"],
  performance_analyst: ["list_opportunities"],
};

describe("the internal agency tier's tool list is pinned", () => {
  it("is exactly the list the tier has always had, for all six roles, with and without the writes switch", () => {
    expect(AGENT_ROLE_KEYS).toHaveLength(6);
    for (const role of AGENT_ROLE_KEYS) {
      expect(businessMcpToolNamesForRole(role), role).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, ...INTERNAL_READS[role]]);
      expect(businessMcpToolNamesForRole(role, false), role).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, ...INTERNAL_READS[role]]);
      expect(businessMcpToolNamesForRole(role, true), role).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, ...INTERNAL_WITH_WRITES[role]]);
      expect(businessMcpRuntimeNamesForRole(role), role).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, ...INTERNAL_READS[role]].map((name) => hermesMcpToolName(name as BusinessMcpToolName)).sort());
      expect(businessMcpRuntimeNamesForRole(role, true), role).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, ...INTERNAL_WITH_WRITES[role]].map((name) => hermesMcpToolName(name as BusinessMcpToolName)).sort());
    }
  });

  it("matches what deriving it from the catalog gave, so the pin changed nothing", () => {
    for (const role of AGENT_ROLE_KEYS) {
      expect(INTERNAL_READS[role], role).toEqual(toolsForRole(role).filter((name) => AGENT_TOOLS[name].kind === "read"));
      expect(INTERNAL_WITH_WRITES[role], role).toEqual(toolsForRole(role).filter((name) => AGENT_TOOLS[name].kind !== "proposal"));
    }
  });

  it("does not follow the catalog: every catalog read a role's scopes allow is either offered or listed here as deliberately not offered", () => {
    for (const role of AGENT_ROLE_KEYS) {
      const catalogReads = toolsForRole(role, { includeClientOnly: true }).filter((name) => AGENT_TOOLS[name].kind === "read");
      const left = catalogReads.filter((name) => !INTERNAL_READS[role].includes(name));
      expect(left, role).toEqual(NOT_OFFERED_INTERNALLY[role]);
      // Whatever the role's scopes would allow, the internal list holds only reads and writes from that allowance, never a proposal.
      for (const name of businessMcpToolNamesForRole(role, true)) {
        if (name === HERMES_BUSINESS_CONTEXT_TOOL) continue;
        expect(ROLE_SCOPES[role].includes(AGENT_TOOLS[name].scope), `${role}/${name}`).toBe(true);
        expect(AGENT_TOOLS[name].kind, `${role}/${name}`).not.toBe("proposal");
      }
    }
  });

  it("keeps every client-only catalog tool out of every internal list and out of the default tool lists", () => {
    const clientOnly = (Object.keys(AGENT_TOOLS) as AgentToolName[]).filter((name) => AGENT_TOOLS[name].clientOnly);
    expect(clientOnly).toEqual(["list_opportunities"]);
    for (const name of clientOnly) {
      expect(AGENT_TOOL_NAMES).not.toContain(name);
      for (const role of AGENT_ROLE_KEYS) {
        expect(businessMcpToolNamesForRole(role, true)).not.toContain(name);
        expect(toolsForRole(role)).not.toContain(name);
      }
    }
  });

  it("gives an unknown role only the context tool, as before", () => {
    expect(businessMcpToolNamesForRole("not_a_role" as AgentRoleKey, true)).toEqual([HERMES_BUSINESS_CONTEXT_TOOL]);
  });
});

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type RpcBody = { result?: { content?: Array<{ text: string }>; isError?: boolean; tools?: Array<{ name: string; description: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }> } };
async function rpc(server: ReturnType<typeof buildBusinessMcpServer>, method: string, params?: Record<string, unknown>, id: number | string = 1) {
  const response = await serveStatelessBusinessMcp(server, post({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }), APP_URL);
  return { response, body: (await response.json()) as RpcBody };
}

function deps(overrides: Partial<BusinessMcpServerDeps> = {}): BusinessMcpServerDeps & { seen: Array<{ name: string; args: Record<string, unknown>; callId: string }> } {
  const seen: Array<{ name: string; args: Record<string, unknown>; callId: string }> = [];
  return {
    names: [HERMES_BUSINESS_CONTEXT_TOOL, "find_contacts", "update_contact", "list_opportunities"],
    contextDescription: "Read what this synthetic employee may see.",
    readContext: async () => ({ status: "available", evidence: { sections: [] } }),
    callTool: async (name, args, callId): Promise<AgentToolReply> => {
      seen.push({ name, args, callId });
      return { ok: true, httpStatus: 200, status: "done", tool: name, result: { found: 1 } };
    },
    ...overrides,
    seen,
  };
}

describe("buildBusinessMcpServer and serveStatelessBusinessMcp", () => {
  it("registers the context tool first and exactly the tools it was given, each read-only exactly when the catalog says read, never destructive", async () => {
    const { body } = await rpc(buildBusinessMcpServer(deps()), "tools/list");
    const tools = body.result?.tools ?? [];
    expect(tools.map((tool) => tool.name).sort()).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, "find_contacts", "list_opportunities", "update_contact"].sort());
    for (const tool of tools) {
      const kind = tool.name === HERMES_BUSINESS_CONTEXT_TOOL ? "read" : AGENT_TOOLS[tool.name as AgentToolName].kind;
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(kind === "read");
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.description, tool.name).toContain(RECORDS_ARE_DATA);
    }
    expect(tools.find((tool) => tool.name === HERMES_BUSINESS_CONTEXT_TOOL)?.description).toMatch(/^Read what this synthetic employee may see\. This is the same verified snapshot/);
  });

  it("serves two tiers from the one builder, each with its own list", async () => {
    const internal = await rpc(buildBusinessMcpServer(deps({ names: [HERMES_BUSINESS_CONTEXT_TOOL, "find_contacts"] })), "tools/list");
    const client = await rpc(buildBusinessMcpServer(deps({ names: [HERMES_BUSINESS_CONTEXT_TOOL, "list_opportunities"] })), "tools/list");
    expect(internal.body.result?.tools?.map((tool) => tool.name).sort()).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, "find_contacts"].sort());
    expect(client.body.result?.tools?.map((tool) => tool.name).sort()).toEqual([HERMES_BUSINESS_CONTEXT_TOOL, "list_opportunities"].sort());
  });

  it("hands a tool call to its tier with the arguments and a call id built from the request id, and puts the records-are-data note first in the answer", async () => {
    const d = deps();
    const { body } = await rpc(buildBusinessMcpServer(d), "tools/call", { name: "find_contacts", arguments: { query: "Maria" } }, "req 7/x");
    expect(d.seen).toEqual([{ name: "find_contacts", args: { query: "Maria" }, callId: "mcp-req7x" }]);
    const text = body.result?.content?.[0].text ?? "";
    expect(text.startsWith(`{"note":"${RECORDS_ARE_DATA}"`)).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ ok: true, status: "done", result: { found: 1 } });
    expect(body.result?.isError).toBeUndefined();
  });

  it("marks a refused tool call as an error and passes its words on", async () => {
    const refused = deps({ callTool: async () => ({ ok: false, httpStatus: 403, code: "forbidden", error: "Your iAcquire role does not have access to this business information." }) });
    const { body } = await rpc(buildBusinessMcpServer(refused), "tools/call", { name: "find_contacts", arguments: { query: "Maria" } });
    expect(body.result?.isError).toBe(true);
    expect(body.result?.content?.[0].text).toContain("does not have access to this business information");
  });

  it("shows an application error's message, but never the detail of any other failure", async () => {
    const known = deps({ callTool: async () => { throw new AppError("forbidden", "Only during an active Chat turn."); }, readContext: async () => { throw new AppError("forbidden", "Not for this workspace."); } });
    const unknown = deps({ callTool: async () => { throw new Error("connection string postgres://user:hunter2@db"); }, readContext: async () => { throw new Error("stack trace hunter2"); } });
    const call = (server: ReturnType<typeof buildBusinessMcpServer>, name: string, args: Record<string, unknown>) => rpc(server, "tools/call", { name, arguments: args });
    expect((await call(buildBusinessMcpServer(known), "find_contacts", { query: "x" })).body.result?.content?.[0].text).toContain("Only during an active Chat turn.");
    expect((await call(buildBusinessMcpServer(known), HERMES_BUSINESS_CONTEXT_TOOL, {})).body.result?.content?.[0].text).toContain("Not for this workspace.");
    for (const [name, args] of [["find_contacts", { query: "x" }], [HERMES_BUSINESS_CONTEXT_TOOL, {}]] as const) {
      const out = await call(buildBusinessMcpServer(unknown), name, args as Record<string, unknown>);
      expect(out.body.result?.isError, name).toBe(true);
      expect(out.body.result?.content?.[0].text, name).toContain("unavailable");
      expect(out.body.result?.content?.[0].text, name).not.toMatch(/hunter2|postgres|stack/);
    }
  });

  it("validates arguments against the catalog schema before the tier sees them", async () => {
    const d = deps();
    const { body } = await rpc(buildBusinessMcpServer(d), "tools/call", { name: "find_contacts", arguments: { query: "Maria", orgId: "someone-else" } });
    expect(d.seen).toEqual([]);
    expect(body.result?.isError).toBe(true);
  });

  it("answers with no-store and no-index headers and refuses an oversized body", async () => {
    const ok = await serveStatelessBusinessMcp(buildBusinessMcpServer(deps()), post({ jsonrpc: "2.0", id: 1, method: "tools/list" }), APP_URL);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const huge = await serveStatelessBusinessMcp(buildBusinessMcpServer(deps()), post(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(70 * 1024) } })), APP_URL);
    expect(huge.status).toBeGreaterThanOrEqual(400);
  });
});

// ---------------------------------------------------------------------------
// The context tool by organization kind
// ---------------------------------------------------------------------------

let client: Awaited<ReturnType<typeof createOrg>>;
let clientUser: { id: string; email: string };
let agency: Awaited<ReturnType<typeof createOrg>>;
let agencyAdmin: { id: string; email: string };

async function runFor(org: { id: string }, userId: string, orgKind: ActiveChatRun["orgKind"], role: AgentRoleKey = "operations_manager"): Promise<ActiveChatRun> {
  const id = await agentId(org.id, role);
  const run = await withSystem((db) =>
    db.query<{ id: string }>(
      "insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status) values ($1, $2, $3, 'chat', $4, 'running') returning id",
      [org.id, id, userId, `builder-test-${crypto.randomUUID()}`],
    ),
  );
  return { agentId: id, orgId: org.id, roleKey: role, displayName: "Synthetic", profile: "synthetic-profile", credentialId: "test-credential", runId: run.rows[0].id, userId, configVersionId: crypto.randomUUID(), orgKind };
}

beforeAll(async () => {
  client = await createOrg({ name: "Builder Client" });
  clientUser = await createUser({ name: "Client Owner" });
  await addMember(client.id, clientUser.id, "owner");
  agency = await createOrg({ name: "Builder Agency", kind: "agency" });
  agencyAdmin = await createUser({ platformRole: "agency_super_admin", name: "Builder Admin" });
  await addMember(agency.id, agencyAdmin.id, "owner");
});

describe("the context tool asks for the agency's operations snapshot only for an agency run", () => {
  it("gives a client workspace's Operations Manager its sections without error and never asks for the internal snapshot", async () => {
    internalOps.calls.length = 0;
    expect(await loadOrgContextForUser(clientUser.id, client.id)).not.toBeNull();
    const out = await buildRoleWorkspaceContext(await runFor(client, clientUser.id, "client"));
    expect(out).toMatchObject({ status: "available", note: RECORDS_ARE_DATA });
    expect(out.evidence.sections.length).toBeGreaterThan(0);
    expect("internalOperations" in out).toBe(false);
    expect(internalOps.calls).toEqual([]);
    const audit = await withSystem((db) => db.query<{ result: string; metadata: { sections?: string } }>("select result, metadata from audit_logs where org_id = $1 and action = 'hermes.business_mcp.read'", [client.id]));
    expect(audit.rows).toEqual([expect.objectContaining({ result: "success" })]);
  });

  it("still asks for it, once, for the agency's own run, and returns it beside the shared snapshot", async () => {
    internalOps.calls.length = 0;
    const out = await buildRoleWorkspaceContext(await runFor(agency, agencyAdmin.id, "agency"));
    expect(internalOps.calls).toEqual([{ orgId: agency.id, roleKey: "operations_manager" }]);
    expect(out).toMatchObject({ status: "available", internalOperations: { marker: "internal-operations-snapshot" } });
  });

  it("asks for it for no other role, in either kind of workspace", async () => {
    internalOps.calls.length = 0;
    await buildRoleWorkspaceContext(await runFor(agency, agencyAdmin.id, "agency", "crm_manager"));
    await buildRoleWorkspaceContext(await runFor(client, clientUser.id, "client", "crm_manager"));
    expect(internalOps.calls).toEqual([]);
  });
});
