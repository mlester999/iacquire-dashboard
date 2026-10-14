import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";

// A schema-wide guard: every table that carries an org_id must be protected by row-level security whose
// policies depend on the caller's organization membership. It reads the live catalog, so a table added
// by a future migration is checked automatically and cannot quietly ship with an open policy.

interface Policy {
  table: string;
  name: string;
  cmd: string;
  roles: string[];
  using: string | null;
  check: string | null;
}

let tenantTables: string[] = [];
let policies: Policy[] = [];
const grants = new Map<string, { insert: boolean; update: boolean; delete: boolean; select: boolean }>();

// Helpers that make a policy depend on who is asking and which organization the row belongs to.
const SCOPING = /app\.(can_access_org|has_permission|is_agency_admin|is_agency_staff|staff_assigned|can_view_conversation|file_permission|current_user_id)/;

/** A policy may scope a child table through an EXISTS on a parent table, whose own row-level security then applies. */
function scoped(table: string, expr: string, depth = 0): boolean {
  if (SCOPING.test(expr)) return true;
  if (depth >= 3) return false;
  for (const m of expr.matchAll(/FROM\s+(?:public\.)?([a-z_]+)/g)) {
    const parent = m[1];
    if (parent === table || !tenantTables.includes(parent)) continue;
    const parentPolicies = policies.filter((p) => p.table === parent && p.roles.includes("iaq_app_user") && (p.cmd === "SELECT" || p.cmd === "ALL"));
    if (parentPolicies.length && parentPolicies.every((p) => scoped(parent, p.using ?? "", depth + 1))) return true;
  }
  return false;
}

// Tables whose rows are intentionally readable by every signed-in user, or which have no client access at all.
const GLOBAL_READABLE = new Set<string>([]);

beforeAll(async () => {
  const { rows } = await withSystem((db) =>
    db.query<{ relname: string }>(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
       where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
    ),
  );
  tenantTables = rows.map((r) => r.relname);
  const pol = await withSystem((db) =>
    db.query<{ tablename: string; policyname: string; cmd: string; roles: string; qual: string | null; with_check: string | null }>(
      "select tablename, policyname, cmd, roles::text as roles, qual, with_check from pg_policies where schemaname = 'public'",
    ),
  );
  policies = pol.rows.map((p) => ({
    table: p.tablename,
    name: p.policyname,
    cmd: p.cmd,
    roles: p.roles.replace(/[{}]/g, "").split(","),
    using: p.qual,
    check: p.with_check,
  }));
  for (const t of tenantTables) {
    const g = await withSystem((db) =>
      db.query<{ s: boolean; i: boolean; u: boolean; d: boolean }>(
        `select has_table_privilege('iaq_app_user', $1::regclass, 'select') as s, has_table_privilege('iaq_app_user', $1::regclass, 'insert') as i,
                has_table_privilege('iaq_app_user', $1::regclass, 'update') as u, has_table_privilege('iaq_app_user', $1::regclass, 'delete') as d`,
        [`public.${t}`],
      ),
    );
    grants.set(t, { select: g.rows[0].s, insert: g.rows[0].i, update: g.rows[0].u, delete: g.rows[0].d });
  }
});

describe("schema-wide tenant isolation", () => {
  it("finds the tenant tables (guards against the query silently matching nothing)", () => {
    expect(tenantTables.length).toBeGreaterThan(60);
    for (const must of ["onboarding_answers", "org_assets", "conversations", "credit_ledger_entries", "contacts", "notifications"]) expect(tenantTables).toContain(must);
  });

  it("enables row-level security on every tenant table", async () => {
    const { rows } = await withSystem((db) =>
      db.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity and c.relname = any($1::text[])`,
        [tenantTables],
      ),
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("gives the browser-facing roles no access to tenant tables", async () => {
    for (const role of ["anon", "authenticated", "public"]) {
      const { rows } = await withSystem((db) =>
        db.query<{ relname: string }>(
          role === "public"
            ? `select c.relname from pg_class c where c.relname = any($1::text[]) and c.relnamespace = 'public'::regnamespace and exists (
                 select 1 from information_schema.role_table_grants g where g.table_name = c.relname and g.table_schema = 'public' and g.grantee = 'PUBLIC')`
            : `select c.relname from pg_class c where c.relname = any($1::text[]) and c.relnamespace = 'public'::regnamespace and has_table_privilege('${role}', c.oid, 'select,insert,update,delete')`,
          [tenantTables],
        ),
      );
      expect(rows.map((r) => r.relname), role).toEqual([]);
    }
  });

  it("scopes every read policy for the application role to the caller's organization", () => {
    const bad: string[] = [];
    for (const t of tenantTables) {
      if (!grants.get(t)?.select || GLOBAL_READABLE.has(t)) continue;
      const reads = policies.filter((p) => p.table === t && (p.cmd === "SELECT" || p.cmd === "ALL") && (p.roles.includes("iaq_app_user") || p.roles.includes("public")));
      if (!reads.length) {
        bad.push(`${t}: SELECT is granted but no policy applies`);
        continue;
      }
      for (const p of reads) {
        const expr = (p.using ?? "").trim();
        if (expr === "" || expr === "true" || !scoped(t, expr)) bad.push(`${t}.${p.name}: ${expr || "(none)"}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("scopes every write policy for the application role, and never grants DELETE of whole tables loosely", () => {
    const bad: string[] = [];
    for (const t of tenantTables) {
      const g = grants.get(t)!;
      if (!(g.insert || g.update || g.delete)) continue;
      const writes = policies.filter((p) => p.table === t && ["INSERT", "UPDATE", "DELETE", "ALL"].includes(p.cmd) && p.roles.includes("iaq_app_user"));
      if (!writes.length) bad.push(`${t}: write granted but no write policy`);
      for (const p of writes) {
        const expr = `${p.using ?? ""} ${p.check ?? ""}`.trim();
        if (!scoped(t, expr)) bad.push(`${t}.${p.name}: ${expr || "(none)"}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("keeps ledgers, receipts and credentials write-protected from the application role", () => {
    for (const t of ["credit_ledger_entries", "credit_accounts", "payments", "payment_webhook_events", "metered_usage_events", "contact_consent_events", "conversation_ownership_events", "audit_logs", "webhook_receipts"]) {
      if (!tenantTables.includes(t)) continue;
      const g = grants.get(t)!;
      expect({ t, insert: g.insert, update: g.update, delete: g.delete }).toEqual({ t, insert: false, update: false, delete: false });
    }
  });
});
