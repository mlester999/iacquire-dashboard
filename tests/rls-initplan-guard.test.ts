import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import {
  findHelperCalls, fingerprint, LEFT_ALONE_ALL_POLICIES, MIGRATION_PATH, normalize, PINNED, PROOF_HELPERS, proveColumns, readHelperDefinitions, rewriteExpression, ROLLBACK_PATH,
  STATEMENT_HELPERS, type PolicyRow,
} from "../scripts/rls-initplan";
import { crmOrg } from "./support/crm";

// Guard for migration 0053 (row-level security evaluated once per statement), on the fully migrated test database.
// When it fails after you add or change a SELECT policy in a migration before 0053, run `node --import tsx scripts/rls-initplan.ts`
// to regenerate 0053 and its rollback, then run tests/rls-initplan-equivalence.test.ts. A policy added by a migration after 0053
// must use the statement-level helpers directly: `org_id = ANY ((SELECT app.permitted_orgs('<permission>'))::uuid[])`.

const REGENERATE = "regenerate with `node --import tsx scripts/rls-initplan.ts`, or write the policy with app.permitted_orgs / app.accessible_orgs";

async function policies(): Promise<PolicyRow[]> {
  return withSystem(async (db) => {
    await db.query("set local search_path = public, pg_temp");
    return (await db.query<PolicyRow>(
      "select tablename::text, policyname::text, cmd, roles::text as roles, permissive, qual, with_check from pg_policies where schemaname = 'public' order by tablename, policyname",
    )).rows;
  });
}

/** The (table, policy, expression, replacement) pairs a generated file spells out. */
function pairs(file: string, tag: "was" | "now") {
  const sql = readFileSync(file, "utf8");
  const re = new RegExp(
    `select app\\.rls_initplan_expect\\('([a-z0-9_]+)', '([a-z0-9_]+)', \\$${tag}\\$([\\s\\S]*?)\\$${tag}\\$\\);\\nalter policy ([a-z0-9_]+) on public\\.([a-z0-9_]+) using \\(([\\s\\S]*?)\\);\\n(?=\\n|drop )`,
    "g",
  );
  return [...sql.matchAll(re)].map((m) => {
    expect(m[4], m[0]).toBe(m[2]);
    expect(m[5], m[0]).toBe(m[1]);
    return { table: m[1], policy: m[2], expect: m[3], set: m[6] };
  });
}

// The proof that permitted_orgs / accessible_orgs return exactly the organizations where the per-row helpers are true reads the
// definitions in PROOF_HELPERS (see docs/rls-performance-rollout.md); their reviewed fingerprints, and those of the two new helpers, are
// PINNED in scripts/rls-initplan.ts, which the generator and the migration itself also check.

/** A SELECT policy created inside a rolled-back transaction, as pg_policies prints it, for the proof checker. */
async function deparsed(table: string, using: string): Promise<PolicyRow> {
  class Done extends Error {}
  let row: PolicyRow | null = null;
  await expect(withSystem(async (db) => {
    await db.query(`create policy rls_initplan_probe on public.${table} for select to iaq_app_user using (${using})`);
    await db.query("set local search_path = public, pg_temp");
    row = (await db.query<PolicyRow>(
      "select tablename::text, policyname::text, cmd, roles::text as roles, permissive, qual, with_check from pg_policies where schemaname = 'public' and policyname = 'rls_initplan_probe'",
    )).rows[0];
    throw new Done();
  })).rejects.toBeInstanceOf(Done);
  return row!;
}

describe("row-level security reads are evaluated once per statement (0053)", () => {
  it("no SELECT policy calls app.has_permission, app.can_view_conversation or app.can_access_org with a row's columns", async () => {
    const all = await policies();
    expect(all.filter((p) => p.cmd === "SELECT").length).toBeGreaterThan(150);
    const perRow = all.filter((p) => p.cmd === "SELECT" && findHelperCalls(p.qual ?? "").length).map((p) => `${p.tablename}.${p.policyname}: ${p.qual}`);
    expect(perRow, REGENERATE).toEqual([]);
    // An ALL policy also applies to reads; the ones that still call a per-row helper are listed in the generator on purpose.
    const allPolicies = all.filter((p) => p.cmd === "ALL" && findHelperCalls(`${p.qual ?? ""} ${p.with_check ?? ""}`).length).map((p) => `${p.tablename}.${p.policyname}`);
    expect(allPolicies, "an ALL policy calls a per-row helper: rewrite it or list it in LEFT_ALONE_ALL_POLICIES with a reason").toEqual(LEFT_ALONE_ALL_POLICIES);
    expect(all.filter((p) => /app\.(permitted_orgs|accessible_orgs)\(/.test(p.qual ?? "")).length).toBeGreaterThanOrEqual(160);
  });

  it("the statement-level helpers have the same security posture as the per-row ones", async () => {
    const { rows } = await withSystem((db) =>
      db.query<{ proname: string; secdef: boolean; vol: string; config: string[] | null; owner: string; acl: string | null }>(
        `select p.proname::text as proname, p.prosecdef as secdef, p.provolatile::text as vol, p.proconfig as config, p.proowner::regrole::text as owner, p.proacl::text as acl
         from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname in ('has_permission', 'can_access_org', 'permitted_orgs', 'accessible_orgs', 'rls_initplan_expect', 'rls_initplan_expect_function', 'rls_initplan_expect_column')`,
      ),
    );
    const by = new Map(rows.map((r) => [r.proname, r]));
    expect(by.has("rls_initplan_expect")).toBe(false);
    expect(by.has("rls_initplan_expect_function")).toBe(false);
    expect(by.has("rls_initplan_expect_column")).toBe(false);
    const reference = by.get("has_permission")!;
    for (const name of ["permitted_orgs", "accessible_orgs"]) {
      const f = by.get(name)!;
      expect({ name, secdef: f.secdef, vol: f.vol, config: f.config, owner: f.owner, acl: f.acl }).toEqual({
        name, secdef: true, vol: "s", config: ["search_path=public, pg_temp"], owner: reference.owner, acl: reference.acl,
      });
    }
    // Only the application role may call them: no public, browser or site-runtime execute grant.
    for (const role of ["anon", "authenticated", "iaq_site_runtime"]) {
      const { rows: can } = await withSystem((db) =>
        db.query<{ a: boolean; b: boolean }>("select has_function_privilege($1, 'app.permitted_orgs(text)', 'execute') as a, has_function_privilege($1, 'app.accessible_orgs()', 'execute') as b", [role]),
      );
      expect({ role, ...can[0] }).toEqual({ role, a: false, b: false });
    }
  });

  it("the definitions the equivalence proof depends on are unchanged", async () => {
    const names = [...PROOF_HELPERS, ...STATEMENT_HELPERS];
    expect(Object.keys(PINNED).sort()).toEqual([...names].sort());
    const rows = await withSystem((db) => readHelperDefinitions(db, names));
    expect(rows.map((r) => r.name), "each helper exists exactly once (no overloads)").toEqual([...names].sort());
    const actual = Object.fromEntries(rows.map((r) => [r.name, fingerprint(r)]));
    expect(actual, "a helper the RLS proof relies on changed: re-check the candidate set of app.permitted_orgs / app.accessible_orgs, then update PINNED in scripts/rls-initplan.ts").toEqual(PINNED);
    // The migration re-checks owners and definitions of the PROOF_HELPERS on its target, then rechecks every proved column and FK chain.
    const sql = readFileSync(MIGRATION_PATH, "utf8");
    const checked = [...sql.matchAll(/^select app\.rls_initplan_expect_function\('([a-z_]+)', /gm)].map((m) => m[1]);
    expect(checked).toEqual([...PROOF_HELPERS]);
    expect(sql.indexOf("drop function app.rls_initplan_expect_function(")).toBeLessThan(sql.indexOf("create function app.permitted_orgs("));
    expect(sql).toContain("p.proowner::regrole::text = p_owner");
    expect(sql).toContain("create function app.rls_initplan_expect_column(");
    expect(sql).toContain("k.convalidated");
    expect(sql).toContain("public.organizations");
    for (const r of rows.filter((x) => (PROOF_HELPERS as readonly string[]).includes(x.name))) {
      expect(sql, r.name).toContain(`$src$${r.normalized}$src$);`);
    }
  });

  it("both files take their locks with a timeout instead of waiting behind a long-running reader", () => {
    for (const file of [MIGRATION_PATH, ROLLBACK_PATH]) {
      const statements = readFileSync(file, "utf8").split("\n").filter((l) => l.trim() && !l.startsWith("--"));
      expect(statements[0], file).toBe("set local lock_timeout = '5s';");
    }
  });

  it("the proof checker resolves an alias in the sub-select that binds it, not the first FROM in the expression, and fails closed otherwise", async () => {
    // Sibling sub-selects may reuse an alias (PostgreSQL only keeps aliases unique against enclosing queries).
    const reused = await deparsed("tasks", "exists (select 1 from contacts c where c.id = tasks.contact_id) or exists (select 1 from audit_logs c where app.has_permission(c.org_id, 'activity.view'))");
    expect(reused.qual).toMatch(/FROM contacts c[\s\S]*FROM audit_logs c/);
    const { lines, failures } = await withSystem((db) => proveColumns(db, [reused]));
    expect(lines.map((l) => l.column)).toEqual(["audit_logs.org_id"]);
    expect(failures).toContain("tasks.rls_initplan_probe: audit_logs.org_id can be null and the call is not guarded by IS NOT NULL");
    // An inner binding wins over the policy's table; the outer row is still the policy's table.
    const nested = await deparsed("tasks", "exists (select 1 from contacts c where c.id = tasks.contact_id and app.has_permission(c.org_id, 'contacts.view')) and app.has_permission(tasks.org_id, 'contacts.view')");
    expect((await withSystem((db) => proveColumns(db, [nested]))).lines.map((l) => l.column).sort()).toEqual(["contacts.org_id", "tasks.org_id"]);
    // A FROM clause that is not a plain list of tables (here a join) is not read: the checker refuses instead of guessing.
    const joined = await deparsed("tasks", "exists (select 1 from contacts c join audit_logs a on a.org_id = c.org_id where c.id = tasks.contact_id and app.has_permission(a.org_id, 'activity.view'))");
    await expect(withSystem((db) => proveColumns(db, [joined]))).rejects.toThrow(/Cannot resolve alias a/);
  });

  it("the committed migration is the generator's rewrite of each original expression, and the rollback restores exactly those", async () => {
    const up = pairs(MIGRATION_PATH, "was");
    const down = pairs(ROLLBACK_PATH, "now");
    expect(up.length).toBeGreaterThanOrEqual(160);
    expect(down.map((d) => `${d.table}.${d.policy}`)).toEqual(up.map((u) => `${u.table}.${u.policy}`));
    for (const [i, u] of up.entries()) {
      expect(u.set, `${u.table}.${u.policy}`).toBe(rewriteExpression(u.expect));
      expect(down[i].set, `${u.table}.${u.policy}`).toBe(u.expect);
    }
    // The rollback's precondition holds on this database: each policy still has the expression 0053 gave it.
    const live = await policies();
    const stale = down.filter((d) => normalize(live.find((p) => p.tablename === d.table && p.policyname === d.policy && p.cmd === "SELECT")?.qual ?? "") !== normalize(d.expect));
    expect(stale.map((d) => `${d.table}.${d.policy}`)).toEqual([]);
  });

  it("every rewritten column is still NOT NULL (or guarded) and still references an organization through a validated foreign key", async () => {
    const originals: PolicyRow[] = pairs(MIGRATION_PATH, "was").map((u) => ({ tablename: u.table, policyname: u.policy, cmd: "SELECT", roles: "", permissive: "", qual: u.expect, with_check: null }));
    const { lines, failures } = await withSystem((db) => proveColumns(db, originals));
    expect(lines.length).toBeGreaterThanOrEqual(170);
    expect(failures).toEqual([]);
  });

  it("does not accept an FK to a same-named organizations table outside public", async () => {
    class Rollback extends Error {}
    await expect(withSystem(async (db) => {
      await db.query("create schema private");
      await db.query("create table private.organizations (id uuid primary key)");
      await db.query("create table public.rls_private_org_probe (id uuid primary key, org_id uuid not null references private.organizations(id))");
      await db.query("alter table public.rls_private_org_probe enable row level security");
      await db.query("create policy rls_private_org_probe_select on public.rls_private_org_probe for select to iaq_app_user using (app.has_permission(org_id, 'contacts.view'))");
      await db.query("set local search_path = public, pg_temp");
      const policy = (await db.query<PolicyRow>("select tablename::text, policyname::text, cmd, roles::text as roles, permissive, qual, with_check from pg_policies where schemaname = 'public' and tablename = 'rls_private_org_probe'")).rows[0];
      const proof = await proveColumns(db, [policy]);
      expect(proof.lines[0].reference).toBeNull();
      expect(proof.failures).toEqual(["rls_private_org_probe.rls_private_org_probe_select: no validated foreign key makes rls_private_org_probe.org_id an organizations.id"]);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
  });

  it("a member's read computes the permitted organizations once per statement (an InitPlan), not once per row", async () => {
    const c = await crmOrg();
    const plan = await withUser(c.people.owner.id, async (db) =>
      (await db.query<{ "QUERY PLAN": string }>("explain (costs off, verbose) select c.id from contacts c join conversations v on v.contact_id = c.id where c.org_id = $1", [c.org.id])).rows.map((r) => r["QUERY PLAN"]).join("\n"),
    );
    expect(plan).toMatch(/InitPlan/);
    expect(plan).toMatch(/app\.permitted_orgs\('contacts\.view'::text\)/);
    // The policy's test is a plain uuid comparison, so the planner can even use it as an index condition.
    expect(plan).toMatch(/Index Cond: \(\(c\.org_id = ANY \(\(InitPlan \d+\)\.col1\)\)/);
    expect(plan).not.toMatch(/has_permission|can_view_conversation|can_access_org/);
  });
});
