import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgContext } from "@/server/tenancy/context";

// The "every workspace has the new inbox" state, and the rollout switch around it, can only ever be exercised against throw-away test data.
//
//   A. The suite runs on an in-memory embedded database whatever the shell or an .env file says, and nothing else in the tree can reach a hosted one.
//   B. The one test-matrix knob that switches workspaces on (INBOX_TEST_ROLLOUT=on) refuses to run anywhere but that in-memory database.
//   C. A new workspace starts with the new inbox off, and switching it on is a Super Admin action whose audit row cannot be skipped.
//   D. Every workspace switched on through that audited path, the global kill switch beating all of them, and one step putting everything back.
//   E. Nothing in the rollout tests or the QA seed writes outside the isolated database, and no test leaves the kill switch or the knob set.
//
// Evidence that is not code (a hostile shell and .env file, two files run one after the other in one worker) is in the final report; this file keeps
// the parts that can regress silently.

const state = vi.hoisted(() => ({ ctx: null as null | OrgContext }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/server/tenancy/context", async (original) => {
  const actual = await original<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  const need = (permission?: string) => {
    if (!state.ctx) throw new AppError("unauthenticated", "Sign in to continue.");
    if (permission && !state.ctx.can(permission as never)) throw new AppError("forbidden", "Your role doesn't allow this action. Ask a workspace owner for access.");
    return state.ctx;
  };
  return { ...actual, requireOrgContextOrThrow: async (permission?: string) => need(permission), requireOrgContext: async (permission?: string) => need(permission) };
});
vi.mock("@/server/auth/session", async (original) => {
  const actual = await original<typeof import("@/server/auth/session")>();
  return { ...actual, assertSameOrigin: async () => undefined };
});
// Passes through, so every audit row is really written; a test can make the next write fail.
vi.mock("@/server/audit", async (original) => {
  const actual = await original<typeof import("@/server/audit")>();
  return { ...actual, recordAudit: vi.fn(actual.recordAudit) };
});

import { env, resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { createClientTenant } from "@/server/admin/tenants";
import { assertInboxEnabledFor, disableAllWorkspaces, inboxEnabledFor, inboxModeFor, listRollout, setWorkspaceRollout, setWorkspaceRolloutBulk, workspaceInboxOn } from "@/server/messaging/inbox-rollout";
import * as rolloutModule from "@/server/messaging/inbox-rollout";
import { scanInboxAttention } from "@/server/messaging/attention";
import { memberActor } from "@/server/crm/actor";
import { createTag } from "@/server/crm/tags";
import { createWorkflow, publishWorkflow, setWorkflowStatus } from "@/server/crm/workflows/definitions";
import type { WorkflowDefinition, WorkflowStep } from "@/lib/crm/workflow/spec";
import { GET as syncGET } from "@/app/api/inbox/sync/route";
import * as inboxActions from "@/app/actions/inbox";
import { CRM_QA_ENV, assertIsolated } from "../scripts/crm-qa-env.mjs";
import { createOrg, inboxMatrixKnob, uid } from "./support/fixtures";
import { inbound, messagingOrg } from "./support/messaging";

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel: string) => fs.existsSync(path.join(ROOT, rel));
const FILE_TYPES = /\.(ts|tsx|mts|mjs|cjs|js|json|sql|yml|yaml|sh|ps1|cmd|bat)$/;
const walk = (dir: string): string[] =>
  fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return e.name === "node_modules" || e.name === "__pycache__" ? [] : walk(rel);
    return FILE_TYPES.test(e.name) ? [rel] : [];
  });
const SELF = "tests/unified-inbox-rollout-isolation.test.ts";
const count = async (sql: string, p: unknown[] = []) => Number((await withSystem((db) => db.query<{ n: string }>(sql, p))).rows[0].n);
const ENABLED_ROWS = "select count(*)::text as n from inbox_rollout where enabled";

/** What this file's worker looked like before it did anything: captured by the first hook, checked by test A3. */
const started = { rolloutRows: -1, organizations: -1, killSwitch: undefined as string | undefined };
beforeAll(async () => {
  started.killSwitch = process.env.INBOX_DISABLED;
  started.rolloutRows = await count("select count(*)::text as n from inbox_rollout");
  started.organizations = await count("select count(*)::text as n from organizations");
  delete process.env.INBOX_DISABLED;
  resetEnvCache();
});
afterAll(() => {
  // The kill switch is put back the way the shell had it (the matrix runs set it for the whole process), and the env cache forgets what this file did.
  if (started.killSwitch === undefined) delete process.env.INBOX_DISABLED;
  else process.env.INBOX_DISABLED = started.killSwitch;
  resetEnvCache();
});
beforeEach(() => {
  state.ctx = null;
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// A. Only an in-memory embedded database
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe("A. the suite runs on an in-memory embedded database, whatever the shell or an .env file says", () => {
  const config = read("vitest.config.ts");

  it("A1. forces the in-memory database, local sign-in and test mode in the configuration itself, with no hosted URL and nothing that shares a worker between files", () => {
    const block = /\n\s+env:\s*\{([\s\S]*?)\n\s+\},/.exec(config)?.[1] ?? "";
    expect(block).toContain('DATABASE_DRIVER: "pglite-memory"');
    expect(block).toContain('NODE_ENV: "test"');
    expect(block).toContain('AUTH_PROVIDER: "local"');
    expect(block).toContain('SECRET_STORE: "test-memory"');
    expect(block).not.toMatch(/DATABASE_URL|SUPABASE|INBOX_TEST_ROLLOUT|INBOX_DISABLED/);
    // A test file gets its own process (and so its own empty in-memory database): the default for the forks pool, and these would change it.
    expect(config).toContain('pool: "forks"');
    // The one setup file allowed is the guard that refuses connections to other machines; it must not read or set any environment value.
    const guard = 'setupFiles: [path.resolve(import.meta.dirname, "tests/support/no-network.ts")],';
    expect(config.split(guard).length - 1).toBeLessThanOrEqual(1);
    expect(config.replace(guard, "")).not.toMatch(/isolate\s*:\s*false|singleFork|poolOptions|pool:\s*"(threads|vmThreads|vmForks)"|dotenv|globalSetup|setupFiles/);
    expect(read("tests/support/no-network.ts")).not.toMatch(/process\.env|dotenv|DATABASE|INBOX_|SUPABASE/);
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts.test).toBe("vitest run");
    for (const [name, command] of Object.entries(pkg.scripts)) {
      expect(command, `package.json script ${name}`).not.toMatch(/--no-isolate|--isolate|--pool|--poolOptions|INBOX_TEST_ROLLOUT/);
    }
  });

  it("A2. is on PGlite in test mode right now, and a hosted DATABASE_URL in the environment changes nothing about which driver is chosen", async () => {
    expect(process.env.NODE_ENV).toBe("test");
    expect(env().DATABASE_DRIVER).toBe("pglite-memory");
    expect(env().AUTH_PROVIDER).toBe("local");
    const version = (await withSystem((db) => db.query<{ v: string }>("select version() as v"))).rows[0].v;
    expect(version).toMatch(/PGlite .*wasm32-unknown-emscripten/);
    const before = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = "postgresql://postgres:not-a-real-password@db.example.invalid:5432/postgres";
      resetEnvCache();
      expect(env().DATABASE_DRIVER).toBe("pglite-memory");
    } finally {
      if (before === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = before;
      resetEnvCache();
    }
  });

  it("A3. started with nothing in it: no workspace and no rollout row, so no state from another test file (or an earlier run) is carried in", () => {
    expect(started.organizations).toBe(0);
    expect(started.rolloutRows).toBe(0);
  });

  it("A4. has exactly one way to open a hosted connection (the pg Pool in the database module), reached only when the driver is postgres", () => {
    const users = walk("src").filter((f) => /from "pg"|import\("pg"\)|require\("pg"\)/.test(read(f)));
    expect(users).toEqual(["src/server/db/index.ts"]);
    const db = read("src/server/db/index.ts");
    expect(db.match(/createPostgresDriver\(/g)).toHaveLength(2); // the definition and the one call
    expect(db).toMatch(/if \(e\.DATABASE_DRIVER === "postgres"\) \{\s*if \(!e\.DATABASE_URL\) throw[^\n]*\n\s*driver = await createPostgresDriver\(e\.DATABASE_URL\);/);
  });

  it("A5. every other vitest configuration runs only QA seeds that refuse to start unless the database is the embedded one (or forces the in-memory one itself)", () => {
    const configs = walk("scripts").filter((f) => /\.vitest\.config\.ts$/.test(f));
    expect(configs.length).toBeGreaterThanOrEqual(8);
    for (const file of configs) {
      const text = read(file);
      if (/DATABASE_DRIVER:\s*"pglite-memory"/.test(text)) continue;
      const included = [...(/include:\s*\[([^\]]*)\]/.exec(text)?.[1] ?? "").matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(included.length, file).toBeGreaterThan(0);
      for (const seed of included) {
        expect(seed, `${file} includes only QA scripts`).toMatch(/^scripts\/[\w.-]+\.qa\.ts$/);
        expect(exists(seed), `${seed} exists`).toBe(true);
        // Each refuses a hosted database: "driver must be pglite", "driver must not be postgres", or (the workforce seed) a connection string that is not empty,
        // which with the postgres driver leaves nothing to connect to ("DATABASE_URL is required for the postgres driver", src/server/db/index.ts).
        expect(read(seed), `${seed} refuses a hosted database`).toMatch(/DATABASE_DRIVER\s*(!==\s*"pglite"|===\s*"postgres")|if \(process\.env\.DATABASE_URL\) throw/);
      }
    }
  });

  it("A6. the QA environment guard refuses a hosted database, a hosted-style driver and hosted sign-in, and the inbox QA runner calls it before it starts anything", () => {
    const offline = { root: ROOT, files: [] as string[] };
    expect(() => assertIsolated({ ...offline, env: CRM_QA_ENV })).not.toThrow();
    expect(() => assertIsolated({ ...offline, env: { ...CRM_QA_ENV, DATABASE_URL: "postgresql://postgres:not-a-real-password@db.example.invalid:5432/postgres" } })).toThrow(/DATABASE_URL must be empty/);
    expect(() => assertIsolated({ ...offline, env: { ...CRM_QA_ENV, DATABASE_DRIVER: "postgres" } })).toThrow(/DATABASE_DRIVER must be pglite/);
    expect(() => assertIsolated({ ...offline, env: { ...CRM_QA_ENV, DATABASE_DRIVER: "pglite-memory" } })).toThrow(/DATABASE_DRIVER must be pglite/);
    expect(() => assertIsolated({ ...offline, env: { ...CRM_QA_ENV, AUTH_PROVIDER: "supabase" } })).toThrow(/AUTH_PROVIDER must be local/);
    expect(() => assertIsolated({ ...offline, env: { ...CRM_QA_ENV, SUPABASE_SECRET_KEY: "not-a-real-key" } })).toThrow(/must be empty/);

    const runner = read("scripts/run-inbox-qa-seed.mjs");
    expect(runner.indexOf("assertIsolated({ root })")).toBeGreaterThan(-1);
    expect(runner.indexOf("assertIsolated({ root })")).toBeLessThan(runner.indexOf("spawnSync("));
    // The values the guard checked are the values the seed runs with: the pinned set is spread after the shell's, so the shell cannot change them.
    expect(runner).toContain('env: { ...process.env, ...CRM_QA_ENV, NODE_ENV: "test", SECRET_STORE: "test-memory" }');
    const server = read("scripts/crm-qa.mjs");
    expect(server.indexOf("assertIsolated({ root, env: qaEnv })")).toBeGreaterThan(-1);
    expect(server.indexOf("assertIsolated({ root, env: qaEnv })")).toBeLessThan(server.indexOf("const env = { ...process.env, ...qaEnv"));
    expect(read("scripts/inbox-qa.mjs")).toContain('await import("./crm-qa.mjs")');
  });

  it("A7. the QA environment pins the global inbox switch off, so a stray INBOX_DISABLED in the shell cannot change what a browser run verifies", () => {
    expect(CRM_QA_ENV.INBOX_DISABLED).toBe("false");
    // The runners spread the pinned set after the shell's, so the pinned value wins.
    expect({ ...{ INBOX_DISABLED: "true", INBOX_TEST_ROLLOUT: "on" }, ...CRM_QA_ENV }.INBOX_DISABLED).toBe("false");
    expect(() => assertIsolated({ root: ROOT, files: [], env: CRM_QA_ENV })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// B. The test-matrix knob
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe("B. INBOX_TEST_ROLLOUT, the knob that switches the new inbox on for every workspace a test creates", () => {
  const memory = { NODE_ENV: "test", DATABASE_DRIVER: "pglite-memory" };

  it("B1. is honored on the in-memory test database only, and refuses everywhere else instead of writing a rollout row", () => {
    expect(inboxMatrixKnob({ ...memory })).toBe(false);
    expect(inboxMatrixKnob({ ...memory, INBOX_TEST_ROLLOUT: "" })).toBe(false);
    expect(inboxMatrixKnob({ ...memory, INBOX_TEST_ROLLOUT: "off" })).toBe(false);
    expect(inboxMatrixKnob({ ...memory, INBOX_TEST_ROLLOUT: "on" })).toBe(true);
    for (const where of [
      { NODE_ENV: "test", DATABASE_DRIVER: "pglite" }, // a file-based embedded database, such as the QA seeds use
      { NODE_ENV: "test", DATABASE_DRIVER: "postgres" },
      { NODE_ENV: "test", DATABASE_DRIVER: undefined },
      { NODE_ENV: "development", DATABASE_DRIVER: "pglite-memory" },
      { NODE_ENV: "production", DATABASE_DRIVER: "postgres" },
      { NODE_ENV: undefined, DATABASE_DRIVER: undefined },
    ]) {
      expect(() => inboxMatrixKnob({ ...where, INBOX_TEST_ROLLOUT: "on" }), JSON.stringify(where)).toThrow(/only for the in-memory test database/);
      // Unset or off never blocks anything: the QA seeds and every normal run are unaffected.
      expect(inboxMatrixKnob({ ...where }), JSON.stringify(where)).toBe(false);
    }
    // A typo is loud: "true" must not quietly be a run that is not the matrix run.
    for (const typo of ["true", "1", "ON", "On", "yes", " on"]) expect(() => inboxMatrixKnob({ ...memory, INBOX_TEST_ROLLOUT: typo }), typo).toThrow(/must be "on" or "off"/);
  });

  it("B2. is read by one file only (the fixtures), never by application code, a script, the configuration, a package script or an env file", () => {
    const files = [...walk("src"), ...walk("scripts"), ...walk("tests"), ...walk("supabase"), "package.json", "vitest.config.ts", "tsconfig.json", "next.config.ts"]
      .concat(fs.readdirSync(ROOT).filter((f) => f.startsWith(".env")));
    const mentions = files.filter((f) => f !== SELF && read(f).includes("INBOX_TEST_ROLLOUT")).sort();
    expect(mentions).toEqual(["tests/support/fixtures.ts", "tests/support/messaging.ts"]);
    const fixtures = read("tests/support/fixtures.ts");
    expect(fixtures.match(/process\.env\.INBOX_TEST_ROLLOUT/g) ?? []).toHaveLength(0); // read only through inboxMatrixKnob(vars = process.env)
    expect(fixtures).toContain("if (inboxMatrixKnob()) await db.query(");
    expect(read("tests/support/messaging.ts").match(/INBOX_TEST_ROLLOUT/g)).toHaveLength(1); // the comment that says messagingOrg overrides it
    // The documented env examples do not carry it, so copying one into a hosted environment cannot bring it along.
    // (A boolean, so a failure names the file and never prints what is in it.)
    for (const f of fs.readdirSync(ROOT).filter((n) => n.startsWith(".env"))) expect(read(f).includes("INBOX_TEST_ROLLOUT"), f).toBe(false);
  });

  it("B3. gives a plain createOrg a rollout row exactly when this run is the matrix run, and never to a workspace that asked for the previous inbox", async () => {
    const matrix = inboxMatrixKnob();
    const rows = (id: string) => withSystem((db) => db.query<{ enabled: boolean; note: string | null }>("select enabled, note from inbox_rollout where org_id = $1", [id])).then((r) => r.rows);
    const plain = await createOrg({ name: `Knob Plain ${uid()}` });
    expect(await rows(plain.id)).toEqual(matrix ? [{ enabled: true, note: "Test matrix" }] : []);
    expect(await workspaceInboxOn(plain.id)).toBe(matrix);
    const off = await messagingOrg({ name: `Knob Off ${uid()}`, inboxRollout: false });
    expect(await rows(off.org.id)).toEqual([]);
    expect(await inboxEnabledFor(off.org.id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// C. Off by default, on through an audited Super Admin action
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe("C. a new workspace starts off, and switching it on is audited with the change", () => {
  it("C1. the column defaults to false and not null, and no migration, seed or rollback ever writes a rollout row", async () => {
    const col = await withSystem((db) => db.query<{ column_default: string; is_nullable: string }>("select column_default, is_nullable from information_schema.columns where table_name = 'inbox_rollout' and column_name = 'enabled'"));
    expect(col.rows).toEqual([{ column_default: "false", is_nullable: "NO" }]);
    const sqlFiles = [...walk("supabase"), ...walk("scripts").filter((f) => f.endsWith(".sql"))];
    expect(sqlFiles.length).toBeGreaterThan(100); // the migrations, their rollbacks and the local-compat layer: a path typo must not make this scan an empty list
    const writes = /\b(insert\s+into|update|delete\s+from|truncate(\s+table)?|copy)\s+(only\s+)?(public\.)?inbox_rollout\b/i;
    expect(sqlFiles.filter((f) => writes.test(read(f)))).toEqual([]);
    // Only the migration that creates the table mentions it, so a later migration that touches it has to be read on purpose.
    expect(walk("supabase/migrations").filter((f) => read(f).includes("inbox_rollout"))).toEqual(["supabase/migrations/0083_unified_inbox.sql"]);
  });

  it("C2. a workspace created through the real service has no rollout row, and stays off while every other workspace is on", async () => {
    const admin = (await messagingOrg({ name: `Default Off Admin ${uid()}`, inboxRollout: false })).superAdmin;
    const created = await createClientTenant(admin, { name: `Fresh Client ${uid()}`, ownerEmail: `owner-${uid()}@example.test`, enabledRoles: ["lead_hunter"] });
    expect(await count("select count(*)::text as n from inbox_rollout where org_id = $1", [created.orgId])).toBe(0);
    expect(await inboxEnabledFor(created.orgId)).toBe(false);
    expect(await inboxModeFor(created.orgId)).toBe("legacy");
  });

  it("C3. switching a workspace on writes its audit row in the same transaction: an enable that cannot be audited does not happen", async () => {
    const m = await messagingOrg({ name: `Unauditable ${uid()}`, inboxRollout: false });
    const admin = m.superAdmin;
    vi.mocked(recordAudit).mockRejectedValueOnce(new Error("audit store unavailable"));
    await expect(setWorkspaceRollout(admin, { orgId: m.org.id, enabled: true })).rejects.toThrow(/audit store unavailable/);
    expect(await count("select count(*)::text as n from inbox_rollout where org_id = $1", [m.org.id])).toBe(0);
    expect(await workspaceInboxOn(m.org.id)).toBe(false);
    // The same workspace switches on normally, with its row and its audit entry together.
    expect(await setWorkspaceRollout(admin, { orgId: m.org.id, enabled: true, note: "audited" })).toEqual({ orgId: m.org.id, enabled: true, changed: true });
    const audit = await withSystem((db) => db.query<{ action: string; actor_user_id: string; actor_kind: string; result: string }>("select action, actor_user_id, actor_kind, result from audit_logs where org_id = $1 and action like 'inbox.rollout_%'", [m.org.id]));
    expect(audit.rows).toEqual([{ action: "inbox.rollout_enabled", actor_user_id: admin.id, actor_kind: "agency", result: "success" }]);
  });

  it("C4. has no way to switch workspaces on except by name: the service exports no 'enable all', and the Super Admin controls only switch several on by id, 25 at most", () => {
    expect(Object.keys(rolloutModule).sort()).toEqual([
      "assertInboxEnabledFor", "clearInboxRolloutCache", "disableAllWorkspaces", "inboxEnabledFor", "inboxModeFor", "listRollout", "rolloutImpact", "rolloutOnSql",
      "setWorkspaceRollout", "setWorkspaceRolloutBulk", "workspaceInboxOn",
    ]);
    const source = read("src/server/messaging/inbox-rollout.ts");
    expect(source).toContain("const BULK_ENABLE_MAX = 25;");
    expect(source).toMatch(/if \(input\.enabled && ids\.length > BULK_ENABLE_MAX\) throw new AppError\("invalid_input"/);
    const actions = read("src/app/(admin)/admin/inbox-rollout/actions.ts");
    expect([...actions.matchAll(/export async function (\w+)\(/g)].map((x) => x[1]).sort()).toEqual(["disableAllWorkspacesAction", "rolloutImpactAction", "setWorkspaceRolloutAction", "setWorkspaceRolloutBulkAction"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// D. Every workspace switched on, in the isolated database
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe("D. every workspace switched on through the audited service, the global switch beating all of them, and one step putting everything back", () => {
  const NOTE = "all-workspaces isolation check";
  let admin: Awaited<ReturnType<typeof messagingOrg>>["superAdmin"];
  let orgs: Awaited<ReturnType<typeof messagingOrg>>[] = [];
  let late: { orgId: string } | null = null;
  const url = (p: string) => `http://localhost/api/inbox/${p}`;
  const noticeCount = (orgId: string) => count("select count(*)::text as n from notifications where org_id = $1 and kind = 'conversation_awaiting_reply'", [orgId]);
  const audit = (orgId: string, action: string) =>
    withSystem((db) => db.query<{ actor_user_id: string; actor_kind: string; result: string; metadata: Record<string, unknown> }>("select actor_user_id, actor_kind, result, metadata from audit_logs where org_id = $1 and action = $2 order by created_at, id", [orgId, action])).then((r) => r.rows);
  const killSwitch = (on: boolean) => {
    if (on) process.env.INBOX_DISABLED = "true";
    else delete process.env.INBOX_DISABLED;
    resetEnvCache();
  };

  beforeAll(async () => {
    orgs = [];
    for (const name of ["All-On A", "All-On B", "All-On C"]) {
      const m = await messagingOrg({ name: `${name} ${uid()}`, inboxRollout: false });
      // A customer who has been waiting 45 minutes: what the new inbox's own notice is about.
      const c = await inbound(m.org.id);
      await withSystem((db) => db.query("update conversations set unread_count = 1, last_outbound_at = null, last_inbound_at = now() - interval '45 minutes' where id = $1", [c.conversationId]));
      orgs.push(m);
    }
    admin = orgs[0].superAdmin;
  });
  afterAll(async () => {
    // Whatever happened above, leave the file's database with nothing switched on and the kill switch cleared.
    killSwitch(false);
    await disableAllWorkspaces(admin).catch(() => undefined);
  });

  it("D1. switches on every workspace in the database, 25 at a time, and writes one audit row for each", async () => {
    const before = (await listRollout(admin)).filter((r) => !r.enabled).map((r) => r.orgId);
    for (const m of orgs) expect(before).toContain(m.org.id);
    for (let i = 0; i < before.length; i += 25) await setWorkspaceRolloutBulk(admin, { orgIds: before.slice(i, i + 25), enabled: true, note: NOTE });
    const rows = await listRollout(admin);
    expect(rows.length).toBeGreaterThanOrEqual(orgs.length);
    expect(rows.every((r) => r.enabled)).toBe(true);
    expect(await count("select count(*)::text as n from inbox_rollout r join organizations o on o.id = r.org_id where r.enabled and o.status <> 'archived'")).toBe(rows.length);
    for (const id of before) {
      const log = await audit(id, "inbox.rollout_enabled");
      expect(log, id).toHaveLength(1);
      expect(log[0]).toMatchObject({ actor_user_id: admin.id, actor_kind: "agency", result: "success", metadata: { via: "bulk", note: NOTE } });
    }
    for (const m of orgs) {
      expect(await inboxEnabledFor(m.org.id)).toBe(true);
      expect(await inboxModeFor(m.org.id)).toBe("new");
    }
  });

  it("D2. a workspace created after that is still off: switching everyone on set no default for the next one", async () => {
    const created = await createClientTenant(admin, { name: `Late Client ${uid()}`, ownerEmail: `late-${uid()}@example.test`, enabledRoles: ["lead_hunter"] });
    late = { orgId: created.orgId };
    expect(await count("select count(*)::text as n from inbox_rollout where org_id = $1", [late.orgId])).toBe(0);
    expect(await inboxEnabledFor(late.orgId)).toBe(false);
    expect(await inboxModeFor(late.orgId)).toBe("legacy");
  });

  it("D3. INBOX_DISABLED beats every one of them: no new inbox, a 503 'unavailable' (also for the workspace that was never switched on), no notices, and all of it back when cleared", async () => {
    killSwitch(true);
    try {
      for (const m of orgs) {
        expect(await workspaceInboxOn(m.org.id), "the rollout itself is untouched").toBe(true);
        expect(await inboxEnabledFor(m.org.id)).toBe(false);
        expect(await inboxModeFor(m.org.id)).toBe("legacy");
        state.ctx = m.ctx("owner");
        const res = await syncGET(new Request(url("sync")));
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ code: "unavailable" });
        const c = await inbound(m.org.id);
        expect(await inboxActions.markUnreadAction(c.conversationId)).toMatchObject({ ok: false, code: "unavailable" });
        await expect(assertInboxEnabledFor(m.org.id)).rejects.toMatchObject({ code: "unavailable" });
      }
      // The global switch is checked before the rollout state, so it also does not tell a workspace that was never switched on that it is not part of the rollout.
      await expect(assertInboxEnabledFor(late!.orgId)).rejects.toMatchObject({ code: "unavailable" });
      expect(await scanInboxAttention()).toMatchObject({ notified: 0 });
      for (const m of orgs) expect(await noticeCount(m.org.id), m.org.name).toBe(0);
    } finally {
      killSwitch(false);
    }
    await expect(assertInboxEnabledFor(late!.orgId)).rejects.toMatchObject({ code: "not_enabled" });
    for (const m of orgs) {
      expect(await inboxEnabledFor(m.org.id)).toBe(true);
      state.ctx = m.ctx("owner");
      expect((await syncGET(new Request(url("sync")))).status).toBe(200);
    }
    expect((await scanInboxAttention()).notified).toBeGreaterThan(0);
    for (const m of orgs) expect(await noticeCount(m.org.id), m.org.name).toBeGreaterThan(0);
  });

  it("D4. pins the one thing the global switch deliberately leaves running: 'went quiet' events for workflows keep being announced while its notices stop", async () => {
    const m = orgs[0];
    const actor = memberActor(m.ctx("owner"));
    const tag = await createTag(actor, { name: `Quiet ${uid()}`, color: "#2563eb" });
    const step = { key: "tag", kind: "add_tag", config: { tagIds: [tag.id] }, next: null } as unknown as WorkflowStep;
    const definition = { trigger: { type: "conversation.idle", filters: { idleHours: [24] } }, steps: [step] } as unknown as WorkflowDefinition;
    const { id } = await createWorkflow(actor, { name: "Quiet", definition });
    await publishWorkflow(actor, id);
    await setWorkflowStatus(actor, id, "active");
    const c = await inbound(m.org.id);
    await withSystem((db) => db.query("update conversations set last_message_at = now() - interval '25 hours' where id = $1", [c.conversationId]));
    killSwitch(true);
    try {
      // src/server/messaging/attention.ts: "Went quiet" is an event for workflows, not a screen, and keeps being announced.
      expect(await scanInboxAttention()).toEqual({ notified: 0, idle: 1 });
    } finally {
      killSwitch(false);
    }
  });

  it("D5. one step puts everything back: nothing is switched on, each change is audited, and a second step finds nothing to do", async () => {
    const enabled = await count(ENABLED_ROWS);
    expect(enabled).toBeGreaterThanOrEqual(orgs.length);
    const out = await disableAllWorkspaces(admin, "isolation check rollback");
    expect(out).toHaveLength(enabled);
    expect(out.every((o) => o.changed && o.enabled === false)).toBe(true);
    expect(await count(ENABLED_ROWS)).toBe(0);
    for (const m of orgs) {
      expect(await inboxEnabledFor(m.org.id)).toBe(false);
      expect(await audit(m.org.id, "inbox.rollout_disabled")).toMatchObject([{ actor_user_id: admin.id, actor_kind: "agency", result: "success", metadata: { via: "disable_all", note: "isolation check rollback" } }]);
    }
    expect(await disableAllWorkspaces(admin)).toEqual([]);
    expect(await count(ENABLED_ROWS)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// E. Nothing leaves the isolated database, and nothing is left set
// ---------------------------------------------------------------------------------------------------------------------------------------------------

describe("E. the rollout tests and the inbox QA seed touch nothing outside the isolated database", () => {
  const SEED = "scripts/ui-qa-inbox-seed.qa.ts";

  it("E1. only the fixtures, the rollout service, the inbox QA seed and the migration rehearsals write rollout rows: no migration, hook or other script or test does", () => {
    const writes = /(insert\s+into|update|delete\s+from)\s+inbox_rollout\b/i;
    const all = [...walk("src"), ...walk("scripts"), ...walk("tests")].filter((f) => f !== SELF && writes.test(read(f))).sort();
    // A migration rehearsal fills its own database with sample rows. It may do so only on a PGlite instance it creates itself, in memory: no hosted driver,
    // no connection string, no network module, no application database handle and no data directory on disk.
    const rehearsals = all.filter((f) => /^scripts\/rehearse-[\w-]+\.mjs$/.test(f));
    for (const f of rehearsals) {
      const text = read(f);
      expect(text, `${f} creates its database with PGlite`).toMatch(/new PGlite\(/);
      expect(text, `${f} opens nothing but PGlite`).not.toMatch(/from "pg"|import\("pg"\)|require\("pg"\)|new Pool\(|createClient\(|\bfetch\(|from "node:(net|http|https|http2|dns|tls)"|withSystem|@\/server\/db|\bdataDir\s*:/);
      expect(text, `${f} reads no environment file`).not.toMatch(/dotenv|["'`]\.env|--env-file/);
    }
    const writers = all.filter((f) => !rehearsals.includes(f));
    expect(writers).toEqual([
      "scripts/ui-qa-inbox-seed.qa.ts",
      "src/server/messaging/inbox-rollout.ts",
      "tests/support/fixtures.ts",
      "tests/support/messaging.ts",
      "tests/unified-inbox-rollout.test.ts", // one UPDATE that the note's CHECK constraint must reject, in a test about the constraint
    ]);
    expect(read("tests/unified-inbox-rollout.test.ts").match(/update inbox_rollout/g)).toHaveLength(1);
    expect(read("tests/unified-inbox-rollout.test.ts")).toMatch(/await expect\(withSystem\(\(db\) => db\.query\("update inbox_rollout set note = \$2 where org_id = \$1", \[m\.org\.id, "x"\.repeat\(201\)\]\)\)\)\.rejects/);
  });

  it("E2. the QA seed switches on one workspace only, after its isolation guard, and writes only its own credential and summary files under .data/crm-qa", () => {
    const seed = read(SEED);
    expect(seed.match(/inbox_rollout/g)).toHaveLength(1); // the one insert, and no other use of the table
    expect(seed.match(/insert into inbox_rollout/g)).toHaveLength(1);
    expect(seed).toContain(`"insert into inbox_rollout (org_id, enabled, note, enabled_at) values ($1, true, 'Inbox QA workspace', now())", [org.id]`);
    expect(seed).not.toMatch(/insert into inbox_rollout[^\n]*\bselect\b|update inbox_rollout|delete from inbox_rollout/i);
    const guardCall = seed.indexOf("\n  assertIsolated();\n");
    expect(guardCall).toBeGreaterThan(-1);
    expect(guardCall).toBeLessThan(seed.indexOf("insert into inbox_rollout"));
    for (const clause of ['e.NODE_ENV === "production"', 'e.AUTH_PROVIDER !== "local"', 'e.DATABASE_DRIVER !== "pglite"', '(e.DATABASE_URL ?? "") !== ""', '!qaDataDir().startsWith(".data/crm-qa/")']) {
      expect(seed, clause).toContain(clause);
    }
    expect(seed).toContain('it.skipIf(!qaDataDir().startsWith(".data/crm-qa/"))');
    expect(seed).toContain('const DATA_DIR = path.resolve(".data/crm-qa");');
    expect([...seed.matchAll(/fs\.writeFileSync\(\s*([A-Z_]+)/g)].map((m) => m[1]).every((f) => f === "CRED_FILE" || f === "SUMMARY_FILE")).toBe(true);
    expect(seed.match(/fs\.writeFileSync\(/g)).toHaveLength(4); // the credentials file three times as people are added, and the summary
    expect(seed).not.toMatch(/child_process|\bfetch\(|https?:\/\/|["'`]\.env|dotenv|vercel/i);
    expect(read("scripts/run-inbox-qa-seed.mjs").match(/spawnSync\(/g)).toHaveLength(1);
  });

  it("E3. none of the rollout tests or fixtures starts a process, makes a network call, or writes or deletes a file", () => {
    const files = ["tests/unified-inbox-rollout.test.ts", "tests/unified-inbox-switch.test.ts", "tests/unified-inbox-entrypoints.test.ts", "tests/unified-inbox-acceptance.test.ts", "tests/support/fixtures.ts", "tests/support/messaging.ts"];
    for (const f of files) {
      expect(read(f), f).not.toMatch(/child_process|\bexecSync\(|\bspawnSync?\(|\bexecFile|\bfetch\(|writeFile|appendFile|createWriteStream|\brmSync\(|\bunlinkSync\(|renameSync|copyFileSync|vercel/i);
    }
  });

  it("E4. every test file that sets the kill switch or the knob clears it again in a hook", () => {
    const mutation = /process\.env\.(INBOX_DISABLED|INBOX_TEST_ROLLOUT)\s*=[^=]|stubEnv\(\s*["'](INBOX_DISABLED|INBOX_TEST_ROLLOUT)["']/g;
    const mutators: string[] = [];
    for (const f of walk("tests")) {
      const text = read(f);
      const names = new Set([...text.matchAll(mutation)].map((m) => m[1] ?? m[2]));
      if (!names.size) continue;
      mutators.push(f);
      expect(/\bafter(Each|All)\(/.test(text), `${f} has an afterEach or afterAll`).toBe(true);
      for (const name of names) expect(text.includes(`delete process.env.${name}`) || text.includes("unstubAllEnvs"), `${f} clears ${name}`).toBe(true);
    }
    expect(mutators).toEqual(expect.arrayContaining(["tests/unified-inbox-rollout.test.ts", "tests/unified-inbox-switch.test.ts", SELF]));
  });
});
