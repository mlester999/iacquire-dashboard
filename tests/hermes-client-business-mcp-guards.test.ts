// Guards on the client business-tool tier. Static: the client and internal tiers never reach each other's credential module, the client credential module stays on the server, nothing in the
// client tier logs, and the policy module is the only place a tool list is made. Dynamic: after real traffic (reads, a proposal that is approved, refusals of every kind) no credential, secret,
// hash or tool token is in any table, any tool result or any log line. Synthetic workspaces; no Hermes, provider or network.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { decideApproval } from "@/server/approvals/service";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { clientBusinessMcpToolNamesForRole } from "@/server/workforce/hermes-client-business-mcp-policy";
import { formatClientCredential, generateClientCredentialSecret, hashClientSecret, revokeClientBusinessCredential } from "@/server/workforce/hermes-client-business-credential";
import {
  callBody, endClientTurns, personContext, postClient, provisionedClient, refused, setClientProposals, setProposalsSwitch, startClientTurn, toolJson, type ClientTenant, type Rpc,
} from "./support/client-business-mcp";

const ROOT = path.resolve(import.meta.dirname, "..");
const rel = (file: string) => path.relative(ROOT, file).replaceAll("\\", "/");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

/** Source without its comments, so a rule about code is not tripped (or satisfied) by a sentence that explains it. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
const importsOf = (file: string) => [...code(file).matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((match) => match[1]);

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(?:ts|tsx)$/.test(name)) out.push(rel(full));
  }
  return out;
}

const CLIENT_ROUTE = "src/app/api/internal/hermes-business/client/mcp/route.ts";
const CLIENT_HANDLER = "src/server/workforce/hermes-client-business-mcp.ts";
const CLIENT_GATE = "src/server/workforce/hermes-client-business-mcp-gate.ts";
const CLIENT_POLICY = "src/server/workforce/hermes-client-business-mcp-policy.ts";
const CLIENT_CREDENTIAL = "src/server/workforce/hermes-client-business-credential.ts";
const CLIENT_FILES = [CLIENT_ROUTE, CLIENT_HANDLER, CLIENT_GATE, CLIENT_POLICY];

const INTERNAL_ROUTE = "src/app/api/internal/hermes-business/mcp/route.ts";
const INTERNAL_HANDLER = "src/server/workforce/hermes-business-mcp.ts";
const INTERNAL_POLICY = "src/server/workforce/hermes-business-mcp-policy.ts";
const INTERNAL_CREDENTIAL = "src/server/workforce/hermes-business-mcp-credential.ts";
const INTERNAL_FILES = [INTERNAL_ROUTE, INTERNAL_HANDLER, INTERNAL_POLICY, INTERNAL_CREDENTIAL];

describe("the two tiers keep their credentials apart", () => {
  it("never lets the client route, handler, gate or policy import the internal credential module, issue or verify an internal credential, or name its secret", () => {
    for (const file of CLIENT_FILES) {
      expect(importsOf(file).filter((specifier) => specifier.endsWith("hermes-business-mcp-credential")), file).toEqual([]);
      expect(code(file), file).not.toMatch(/HERMES_BUSINESS_MCP_SECRET|BUSINESS_MCP_CREDENTIAL_ENV_VAR|verifyConfiguredBusinessMcpCredential|verifyBusinessMcpCredential|issueBusinessMcpCredential|issueConfiguredBusinessMcpCredential|iamcp1/);
    }
  });

  it("never lets the internal route, handler, policy or credential module import anything of the client tier", () => {
    for (const file of INTERNAL_FILES) {
      expect(importsOf(file).filter((specifier) => /hermes-client-business/.test(specifier)), file).toEqual([]);
      expect(code(file), file).not.toMatch(/iamcpc1|CLIENT_CREDENTIAL_PREFIX|verifyClientCredential/);
    }
    expect(read(INTERNAL_ROUTE)).not.toContain("handleHermesClientBusinessMcp");
    expect(read(CLIENT_ROUTE)).not.toContain("handleHermesBusinessMcp");
  });

  it("never lets the client credential module import the internal one, or the internal one import it", () => {
    expect(importsOf(CLIENT_CREDENTIAL).filter((specifier) => specifier.endsWith("hermes-business-mcp-credential"))).toEqual([]);
    expect(importsOf(INTERNAL_CREDENTIAL).filter((specifier) => specifier.endsWith("hermes-client-business-credential"))).toEqual([]);
  });

  it("keeps the client credential module on the server: it is imported only by server code, never by a component, a page or a module marked for the browser", () => {
    const importers = sourceFiles(path.join(ROOT, "src")).filter((file) => importsOf(file).some((specifier) => specifier.endsWith("hermes-client-business-credential")));
    expect(importers).toContain(CLIENT_HANDLER);
    for (const file of importers) {
      expect(file, file).toMatch(/^src\/(?:server|app\/api|app\/actions)\//);
      expect(read(file).slice(0, 600), file).not.toMatch(/["']use client["']/);
    }
    expect(read(CLIENT_CREDENTIAL).startsWith('import "server-only";')).toBe(true);
    for (const file of CLIENT_FILES.filter((item) => item !== CLIENT_ROUTE)) expect(read(file).startsWith('import "server-only";'), file).toBe(true);
    // The credential's shape is named in no browser-facing code and no prompt builder.
    const browserSide = sourceFiles(path.join(ROOT, "src")).filter((file) => /^src\/(?:components|app\/(?!api))/.test(file) || /\/(?:compiler|chat-prompt)[^/]*$/.test(file));
    expect(browserSide.length).toBeGreaterThan(20);
    for (const file of browserSide) expect(read(file), file).not.toMatch(/iamcpc1|agent_business_credentials|hermes-client-business-credential/);
  });
});

describe("the policy module is the one place a tool list is made", () => {
  it("registers tools in exactly one place, the shared server builder", () => {
    const registrars = sourceFiles(path.join(ROOT, "src")).filter((file) => /\bregisterTool\s*\(/.test(code(file)));
    expect(registrars).toEqual([INTERNAL_HANDLER]);
  });

  it("makes the client handler's list from the policy function and from nothing else", () => {
    expect(code(CLIENT_HANDLER)).toMatch(/names:\s*clientBusinessMcpToolNamesForRole\(/);
    for (const file of [CLIENT_ROUTE, CLIENT_HANDLER, CLIENT_GATE]) {
      expect(code(file), file).not.toMatch(/\btoolsForRole\s*\(|ALL_AGENT_TOOL_NAMES|\bAGENT_TOOL_NAMES\b|Object\.keys\(\s*AGENT_TOOLS|toolManifest\s*\(|CLIENT_BUSINESS_TOOL_MATRIX|registerTool\s*\(/);
    }
  });

  it("keeps the client tool matrix inside the policy module: no other file of the application reads it", () => {
    const readers = sourceFiles(path.join(ROOT, "src")).filter((file) => /CLIENT_BUSINESS_TOOL_MATRIX/.test(code(file)));
    expect(readers).toEqual([CLIENT_POLICY]);
  });

  it("lists, for each of the six roles, what the policy says and nothing more, in each phase", async () => {
    // No test file in this module's own list is needed to name the tools: the answer comes from the real handler and is compared with the policy.
    const policyTenant = await tenants();
    for (const proposals of [false, true]) {
      setClientProposals(proposals);
      await setProposalsSwitch(policyTenant.a.org.id, proposals);
      for (const role of AGENT_ROLE_KEYS) {
        const listed = ((await postClient(policyTenant.a.credentials[role])).json?.result?.tools ?? []).map((tool) => tool.name).sort();
        expect(listed, `${role} proposals=${proposals}`).toEqual([...clientBusinessMcpToolNamesForRole(role, { proposals })].sort());
      }
    }
  });
});

describe("nothing in the client tier logs", () => {
  it("has no console call in the route, handler, gate or policy, and no audit metadata that names a secret, a hash, a token or a header", () => {
    for (const file of CLIENT_FILES) {
      const source = code(file);
      expect(source, file).not.toMatch(/\bconsole\s*\./);
      expect(source, file).not.toMatch(/\bsecret\b|ciphertext|\bvault\b|process\.env|\.authorization/i);
      // Every metadata object literal a client file writes: ids, names of tools and roles, reason codes. Never anything that could hold a credential.
      for (const literal of source.matchAll(/metadata:\s*\{[^}]*\}/g)) expect(literal[0], `${file}: ${literal[0]}`).not.toMatch(/secret|hash|token|password|authorization|bearer|presented/i);
    }
  });
});

// ---------------------------------------------------------------------------
// Dynamic: real traffic, then everything it left behind.
// ---------------------------------------------------------------------------

let pair: { a: ClientTenant; b: ClientTenant } | null = null;
async function tenants() {
  pair ??= {
    a: await provisionedClient({ name: "Chicago Roofing", timezone: "America/Chicago", tag: "Chicagoan", phone: "+13125550101" }),
    b: await provisionedClient({ name: "Manila Dental", timezone: "Asia/Manila", tag: "Manilan", phone: "+639171234501", entitled: AGENT_ROLE_KEYS.filter((role) => role !== "sales_assistant") }),
  };
  return pair;
}

beforeAll(async () => {
  await tenants();
}, 240_000);

beforeEach(async () => {
  await withSystem((db) => db.query("delete from rate_limit_buckets"));
});

afterEach(async () => {
  if (pair) for (const t of [pair.a, pair.b]) for (const role of AGENT_ROLE_KEYS) await endClientTurns(t, role);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("no secret, hash, credential or tool token anywhere after real traffic", () => {
  it("leaves none in any table, any tool result or any log line, through reads, an approved proposal and every kind of refusal", async () => {
    const { a, b } = await tenants();
    setClientProposals(true);
    await setProposalsSwitch(a.org.id, true);
    const logged: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { logged.push(args.map((arg) => (typeof arg === "string" ? arg : JSON.stringify(arg))).join(" ")); });
    }
    const texts: string[] = [];
    const keep = (rpc: Rpc) => { texts.push(rpc.text); return rpc; };

    await startClientTurn(a, "crm_manager", a.owner.id);
    const manager = a.credentials.crm_manager;
    keep(await postClient(manager));
    expect(refused(keep(await postClient(manager, callBody("get_role_workspace_context"))))).toBe(false);
    expect(refused(keep(await postClient(manager, callBody("find_contacts", { query: "Chicagoan" }))))).toBe(false);
    const proposal = toolJson(keep(await postClient(manager, callBody("create_task", { title: "Guard task", contactId: a.contact.id })))) as { status?: string; approvalId?: string };
    expect(proposal.status).toBe("pending_approval");
    const decided = await decideApproval(personContext(a), proposal.approvalId as string, "approve");
    expect(decided.outcome).toMatchObject({ status: "succeeded" });

    // Refusals: a right id with a made-up secret (audited, because the id exists), a malformed value, another workspace's employee with no turn, a person past their limit.
    expect(keep(await postClient(formatClientCredential(a.credentialIds.crm_manager, generateClientCredentialSecret()))).status).toBe(401);
    expect(keep(await postClient(`${manager}x`)).status).toBe(401);
    expect(refused(keep(await postClient(b.credentials.crm_manager, callBody("find_contacts", { query: "Manilan" }))))).toBe(true);
    for (let i = 0; i < RATE_LIMITS.clientBusinessMcpByUser.limit; i += 1) await consumeRateLimit(RATE_LIMITS.clientBusinessMcpByUser, `${a.org.id}:${a.owner.id}`);
    expect(refused(keep(await postClient(manager, callBody("find_contacts", { query: "Chicagoan" }))))).toBe(true);
    // An ended credential's next use.
    await withSystem((db) => revokeClientBusinessCredential(db, a.org.id, a.credentialIds.lead_hunter, "operator_request"));
    expect(keep(await postClient(a.credentials.lead_hunter)).status).toBe(401);

    const secrets = [a, b].flatMap((t) => AGENT_ROLE_KEYS.map((role) => t.secrets[role]));
    const credentials = [a, b].flatMap((t) => AGENT_ROLE_KEYS.map((role) => t.credentials[role]));
    const hashes = secrets.map(hashClientSecret);
    const SHAPES = [/iamcpc1\.[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}/, /iaqat_[A-Za-z0-9_-]{20,}/, /Bearer\s+[A-Za-z0-9._-]{20,}/];

    const clean = (text: string, where: string, hashesToo = true) => {
      for (const value of [...secrets, ...credentials, ...(hashesToo ? hashes : [])]) expect(text, `${where} carries a credential, secret or hash`).not.toContain(value);
      for (const shape of SHAPES) expect(text, `${where} carries something shaped like a credential or tool token`).not.toMatch(shape);
    };
    for (const text of texts) clean(text, "a tool result");
    for (const line of logged) clean(line, "a log line");

    const tables = (await withSystem((db) => db.query<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1"))).rows.map((row) => row.relname);
    expect(tables).toContain("audit_logs");
    expect(tables).toContain("approval_requests");
    const dump = new Map<string, string>();
    await withSystem(async (db) => {
      for (const table of tables) dump.set(table, (await db.query<{ t: string }>(`select coalesce(string_agg(to_jsonb(x)::text, E'\\n'), '') as t from "${table}" x`)).rows[0].t);
    });
    // The ledger holds the hash of each secret by design (and only that); every other table holds neither a hash nor a secret nor a credential.
    expect(dump.get("agent_business_credentials")).toContain(hashes[0]);
    for (const [table, text] of dump) clean(text, `table ${table}`, table !== "agent_business_credentials");
    // The traffic really did write the rows the scan is about.
    for (const table of ["audit_logs", "approval_requests", "tool_executions"]) expect((dump.get(table) ?? "").length, table).toBeGreaterThan(100);
    expect(dump.get("audit_logs")).toContain("hermes.client_business_mcp.proposal_requested");
    expect(dump.get("audit_logs")).toContain("hermes.business_mcp.auth_denied");
    expect(dump.get("audit_logs")).toContain("rate_limited");
  });
});
