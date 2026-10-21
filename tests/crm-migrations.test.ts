import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { crmOrg } from "./support/crm";

// Every Native CRM migration ships with a reviewed rollback. Here they are proven: run newest-first on a fully migrated database they must
// execute and remove what the migrations added; with native data present they must refuse. Each run happens in a transaction that is always
// rolled back, so the shared test database is untouched.

const CRM_MIGRATION_NAMES = [
  "0027_native_crm.sql", "0028_crm_sales.sql", "0029_crm_calendars.sql", "0030_crm_scheduling.sql",
  "0031_crm_messaging.sql", "0032_crm_automation.sql", "0033_crm_growth.sql", "0054_crm_blueprints.sql",
  "0055_crm_ghl_migration.sql", "0056_crm_setup_native.sql", "0057_crm_performance.sql", "0058_crm_provider_switch.sql",
  "0041_crm_action_permissions.sql", "0042_company_delete_permission.sql", "0060_rls_initplan.sql",
  "0062_agency_manager_blueprint_permissions.sql",
  // Newer than all of the above and built on 0060's statement-level policy helpers (app.permitted_orgs), which the 0060 rollback drops:
  // rolling back "newest first" means this one goes first.
  "0065_support_requests.sql",
  // Automation Studio extends crm_workflows / crm_workflow_versions / crm_workflow_runs and its policies also use app.permitted_orgs, so it
  // is rolled back before everything above (its own rollback refuses while Studio data exists; none does here).
  "0069_automation_studio_foundation.sql",
  // Its tables hang off crm_workflows and its policies use app.permitted_orgs too, so it goes before 0069.
  "0070_automation_studio_conversations.sql",
];
const CRM_MIGRATIONS = readdirSync("supabase/migrations").filter((f) => CRM_MIGRATION_NAMES.includes(f)).sort();
const downFor = (file: string) => readFileSync(`supabase/rollbacks/${file.replace(/\.sql$/, ".down.sql")}`, "utf8");
class Done extends Error {}

/** Splits a script into statements, keeping `$$ ... $$` bodies whole. The test driver runs one statement per call. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}

const runAllDowns = async (db: { query: (sql: string) => Promise<unknown> }) => {
  for (const file of [...CRM_MIGRATIONS].reverse()) for (const stmt of statements(downFor(file))) await db.query(stmt);
};

describe("Native CRM migrations and rollbacks", () => {
  it("every CRM migration has a rollback script", () => {
    expect(CRM_MIGRATIONS.length).toBeGreaterThanOrEqual(2);
    for (const f of CRM_MIGRATIONS) expect(() => downFor(f)).not.toThrow();
  });

  it("rolls back cleanly, newest first, on a fully migrated database with no native data", async () => {
    let report: Record<string, unknown> = {};
    await expect(
      withSystem(async (db) => {
        await runAllDowns(db);
        const q = async (sql: string) => (await db.query<Record<string, unknown>>(sql)).rows;
        report = {
          crmTables: (await q("select table_name from information_schema.tables where table_schema = 'public' and table_name like 'crm\\_%' and table_name not in ('crm_pipelines', 'crm_opportunities')")).map((r) => r.table_name),
          contactColumns: (await q("select column_name from information_schema.columns where table_name = 'contacts' and column_name in ('first_name', 'search_text', 'lead_status')")).length,
          oppProvider: (await q("select column_name from information_schema.columns where table_name = 'crm_opportunities' and column_name = 'provider'")).length,
          setterRole: (await q("select 1 from role_permissions where role = 'appointment_setter'")).length,
          hasPermission: String((await q("select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = 'has_permission'"))[0]?.prosrc ?? ""),
        };
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
    expect(report).toMatchObject({ crmTables: [], contactColumns: 0, oppProvider: 0, setterRole: 0 });
    expect(String(report.hasPermission)).not.toContain("member_permission_overrides");
    const still = await withSystem(async (db) => (await db.query("select 1 from information_schema.tables where table_name = 'crm_workspaces'")).rows.length);
    expect(still).toBe(1);
  });

  it("refuses to roll back while Native CRM data exists", async () => {
    const c = await crmOrg();
    await createTag(c.actor("owner"), { name: "Keep me" });
    await createContact(c.actor("owner"), { firstName: "Keep", lastName: "Me" });
    await expect(withSystem(async (db) => {
      await runAllDowns(db);
      throw new Done();
    })).rejects.toThrow(/Rollback refused/);
  });
});
