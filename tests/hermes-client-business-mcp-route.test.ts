// The client business-tool route: off by default (a plain 404 before anything is read), a separate tier from the internal agency route (neither tier's credential opens the other), the
// role's read tools and nothing else, and one read end to end. Synthetic workspaces only; no Hermes, provider or network.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { AGENT_TOOLS } from "@/server/crm/agent-tools/catalog";
import { handleHermesBusinessMcp } from "@/server/workforce/hermes-business-mcp";
import { handleHermesClientBusinessMcp } from "@/server/workforce/hermes-client-business-mcp";
import { issueBusinessMcpCredentialWithSecret } from "@/server/workforce/hermes-business-mcp-credential";
import { clientBusinessMcpToolNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import * as route from "@/app/api/internal/hermes-business/client/mcp/route";
import { MCP_TEST_SECRET } from "./support/business-mcp";
import {
  CLIENT_MCP_URL, auditRows, callBody, clientSideEffects, endClientTurns, postClient, refused, setClientTier, startClientTurn, toolJson, toolText, provisionedClient, tenantRows, type ClientTenant,
} from "./support/client-business-mcp";

let a: ClientTenant;
let b: ClientTenant;

const rateBuckets = async () => Number((await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from rate_limit_buckets"))).rows[0].n);
const ledgerUse = async (id: string) => (await withSystem((db) => db.query<{ use_count: number; last_used_at: Date | null }>("select use_count, last_used_at from agent_business_credentials where id = $1", [id]))).rows[0];

beforeAll(async () => {
  a = await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" });
  b = await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") });
}, 180_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
  vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "false");
  setClientTier(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("with the client tier's flag off the route does not exist", () => {
  it("answers a plain 404 to every caller, creates no audit row, uses no rate bucket and records no use of the credential", async () => {
    setClientTier(false);
    const before = await clientSideEffects();
    const buckets = await rateBuckets();
    const used = await ledgerUse(a.credentialIds.crm_manager);
    for (const token of [a.credentials.crm_manager, b.credentials.crm_manager, a.credentials.lead_hunter, "not-a-credential", null]) {
      const rpc = await postClient(token);
      expect(rpc.status).toBe(404);
      expect(rpc.text).toBe("Not found");
      expect(rpc.headers.get("cache-control")).toBe("no-store");
      expect(rpc.headers.get("www-authenticate")).toBeNull();
    }
    for (const method of ["GET", "DELETE"] as const) {
      const response = await route[method](new Request(CLIENT_MCP_URL, { method, headers: { Authorization: `Bearer ${a.credentials.crm_manager}` } }));
      expect(response.status).toBe(404);
    }
    expect(await clientSideEffects()).toEqual(before);
    expect(await rateBuckets()).toBe(buckets);
    expect(await ledgerUse(a.credentialIds.crm_manager)).toEqual(used);
  });

  it("answers before it reads anything about the request: not its headers, not its body", async () => {
    setClientTier(false);
    const untouched = {
      get headers(): Headers { throw new Error("the request's headers were read"); },
      get body(): unknown { throw new Error("the request's body was read"); },
      json: () => { throw new Error("the request's body was read"); },
      text: () => { throw new Error("the request's body was read"); },
    } as unknown as Request;
    const response = await handleHermesClientBusinessMcp(untouched);
    expect(response.status).toBe(404);
  });

  it("is off by default: with nothing set, the tier answers 404", async () => {
    vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_ENABLED", "");
    resetEnvCache();
    expect((await postClient(a.credentials.crm_manager)).status).toBe(404);
  });

  it("leaves the internal agency route exactly as it was: it has its own flag, and the client flag does not turn it on or off", async () => {
    for (const client of [false, true]) {
      setClientTier(client);
      vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "false");
      resetEnvCache();
      const response = await handleHermesBusinessMcp(new Request("https://portal.example.test/api/internal/hermes-business/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.credentials.crm_manager}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }));
      expect(response.status, `client tier ${client}`).toBe(404);
    }
  });
});

describe("two tiers, two kinds of credential", () => {
  it("refuses an internal agency credential on the client route and a client credential on the internal route, with both tiers on", async () => {
    vi.stubEnv("HERMES_BUSINESS_MCP_ENABLED", "true");
    vi.stubEnv("HERMES_BUSINESS_MCP_WRITES_ENABLED", "false");
    vi.stubEnv("HERMES_BUSINESS_MCP_SECRET", MCP_TEST_SECRET);
    setClientTier(true);
    // A well-formed, correctly signed internal credential, minted for this very client employee: its shape is what the client route refuses.
    const internal = issueBusinessMcpCredentialWithSecret(MCP_TEST_SECRET, { role: "crm_manager", agentId: a.agents.crm_manager, orgId: a.org.id }).token;
    const before = await clientSideEffects();
    const onClient = await postClient(internal);
    expect(onClient.status).toBe(401);
    expect(onClient.text).toBe("Unauthorized");
    const onInternal = await handleHermesBusinessMcp(new Request("https://portal.example.test/api/internal/hermes-business/mcp", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${a.credentials.crm_manager}`, "x-forwarded-for": "198.51.100.200" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(onInternal.status).toBe(401);
    expect(await clientSideEffects()).toEqual(before);
    // The same client credential still opens its own route.
    expect((await postClient(a.credentials.crm_manager)).status).toBe(200);
  });
});

describe("the tools the route lists", () => {
  it("lists, for every employee, exactly its role's read tools (and the deals read where the role holds the deals scope), all marked read-only", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const rpc = await postClient(a.credentials[role]);
      expect(rpc.status, role).toBe(200);
      expect(rpc.headers.get("cache-control")).toBe("no-store");
      expect(rpc.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      const tools = rpc.json?.result?.tools ?? [];
      const names = tools.map((tool) => tool.name).sort();
      expect(names, role).toEqual([...clientBusinessMcpToolNamesForRole(role)].sort());
      expect(names.includes("list_opportunities"), role).toBe(["operations_manager", "sales_assistant", "crm_manager", "performance_analyst"].includes(role));
      for (const tool of tools) expect(tool.annotations?.readOnlyHint, `${role} ${tool.name}`).toBe(true);
      for (const name of names) if (name !== "get_role_workspace_context") expect(AGENT_TOOLS[name as keyof typeof AGENT_TOOLS].kind, `${role} ${name}`).toBe("read");
      // Nothing that changes, books, sends or administers, whatever the catalog holds.
      expect(names.filter((name) => /update|create|apply|remove|move|request|prepare|send|approve|admin/.test(name)), role).toEqual([]);
    }
  });

  it("lists the same tools whichever workspace asks, for the same role: the list is fixed by the role, the answer is decided per call", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const forA = (await postClient(a.credentials[role])).json?.result?.tools?.map((tool) => tool.name).sort();
      const forB = role === "sales_assistant" ? forA : (await postClient(b.credentials[role])).json?.result?.tools?.map((tool) => tool.name).sort();
      expect(forB, role).toEqual(forA);
    }
  });
});

describe("one read, end to end", () => {
  it("answers the Appointment Setter's contact search from its own workspace, as the person whose turn it is, and ends the one-minute tool token", async () => {
    await startClientTurn(a, "appointment_setter", a.owner.id);
    const used = (await ledgerUse(a.credentialIds.appointment_setter)).use_count;
    const rpc = await postClient(a.credentials.appointment_setter, callBody("find_contacts", { query: "Chicagoan" }));
    expect(rpc.status).toBe(200);
    expect(refused(rpc)).toBe(false);
    expect(toolText(rpc)).toContain("Chicagoan Prospect");
    expect(toolText(rpc)).not.toContain("Manilan");
    expect(toolJson(rpc)).toMatchObject({ ok: true, status: "done", tool: "find_contacts" });
    // The credential's use is recorded, and the tool token that carried the call is gone.
    expect((await ledgerUse(a.credentialIds.appointment_setter)).use_count).toBe(used + 1);
    const live = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from crm_agent_tokens where org_id = $1 and revoked_at is null", [a.org.id]));
    expect(live.rows[0].n).toBe(0);
    // The call is on record in the client's own workspace, naming the employee and the person, and nowhere else.
    const rows = await auditRows("crm.agent_tool.find_contacts", a.org.id);
    expect(rows.at(-1)).toMatchObject({ org_id: a.org.id, result: "success", agent_instance_id: a.agents.appointment_setter, metadata: { actingUserId: a.owner.id } });
    expect(await auditRows("crm.agent_tool.find_contacts", b.org.id)).toHaveLength(0);
    await endClientTurns(a, "appointment_setter");
  });

  it("gives a client's Operations Manager its workspace snapshot and never the agency's internal operations", async () => {
    await startClientTurn(a, "operations_manager", a.owner.id);
    const rpc = await postClient(a.credentials.operations_manager, callBody("get_role_workspace_context"));
    expect(refused(rpc)).toBe(false);
    const body = toolJson(rpc);
    expect(body).toMatchObject({ status: "available" });
    expect(body && "internalOperations" in body).toBe(false);
    await endClientTurns(a, "operations_manager");
  });

  it("does not touch the other workspace while serving this one", async () => {
    await startClientTurn(a, "crm_manager", a.owner.id);
    const before = await tenantRows(b.org.id);
    const rpc = await postClient(a.credentials.crm_manager, callBody("crm_summary_report"));
    expect(refused(rpc)).toBe(false);
    expect(await tenantRows(b.org.id)).toEqual(before);
    expect(await auditRows("crm.agent_tool.crm_summary_report", b.org.id)).toHaveLength(0);
    await endClientTurns(a, "crm_manager");
  });
});

describe("how the route is wired", () => {
  const source = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("is its own route file, dynamic and on the Node runtime, handing every method to the client handler and to nothing else", () => {
    const file = source("src/app/api/internal/hermes-business/client/mcp/route.ts");
    expect(file).toContain('import { handleHermesClientBusinessMcp } from "@/server/workforce/hermes-client-business-mcp";');
    expect(file).toContain('export const dynamic = "force-dynamic";');
    expect(file).toContain('export const runtime = "nodejs";');
    for (const method of ["GET", "POST", "DELETE"]) expect(file).toContain(`export const ${method} = handleHermesClientBusinessMcp;`);
    expect(file).not.toContain("hermes-business-mcp\"");
    expect(route.POST).toBe(handleHermesClientBusinessMcp);
  });

  it("sits under the proxy's internal-route allowance, so it is reached with its own bearer credential and no portal session", () => {
    expect(source("src/proxy.ts")).toContain("/^\\/api\\/internal\\//");
  });

  it("keeps the internal route file as it was: the internal handler only", () => {
    const file = source("src/app/api/internal/hermes-business/mcp/route.ts");
    expect(file).toContain("handleHermesBusinessMcp");
    expect(file).not.toContain("handleHermesClientBusinessMcp");
  });
});

describe("the fixture", () => {
  it("holds a credential for each of the six roles in both workspaces, and each is a different value", () => {
    const all = [...AGENT_ROLE_KEYS.map((role: AgentRoleKey) => a.credentials[role]), ...AGENT_ROLE_KEYS.map((role: AgentRoleKey) => b.credentials[role])];
    expect(new Set(all).size).toBe(12);
    expect(new Set(all.map((value) => value.split(".")[1])).size).toBe(12);
  });
});
