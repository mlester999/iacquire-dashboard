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
  // Connections to outside systems: policies on app.permitted_orgs too, and its rollback refuses while a connection or call record exists.
  "0072_automation_connections.sql",
  // Workforce foundations are newer than 0060 and their policies reference app.permitted_orgs; roll them back before 0060.
  "0077_ai_work_jobs.sql", "0078_ai_work_schedules.sql", "0079_ai_work_triggers.sql", "0080_proactive_ai_employees.sql",
  "0081_ai_work_job_rls_hardening.sql",
  // Missed-call recovery and lead scoring: read policies on app.permitted_orgs, and both rollbacks refuse while recovery cases or assessments exist (none do here).
  // 0086 is rolled back before 0085, and both before 0060.
  "0085_missed_call_recovery.sql", "0086_lead_scoring.sql",
  // Website chat: read policies on app.permitted_orgs; its rollback refuses while a widget is on or a chat exists (none do here).
  "0087_website_chat.sql",
  // Lead touches and entered campaign costs: read policies on app.permitted_orgs; its rollback refuses while a touch or cost exists (none do here).
  "0088_lead_attribution.sql",
  // Social media manager: read policies on app.permitted_orgs, a new private-file bucket and permission rows; its rollback refuses while an account, post,
  // media file, campaign, AI run or job exists (none do here) and puts app.file_permission back to 0049's definition.
  "0089_social_media_manager.sql",
  // Two more private-file buckets (proposal documents, staff message attachments) and 0089's app.file_permission with their two branches; its rollback refuses while a
  // file is stored in either bucket (none is here) and is rolled back first, putting 0089's definition back before 0089's own rollback replaces it with 0049's.
  "0090_document_buckets.sql",
  // Proposals: read policies on app.permitted_orgs, eight permission rows and nine notification kinds; its rollback refuses while a proposal, price book entry, tax rate,
  // template, AI run or stored proposal document exists (none does here). It is rolled back before 0090 and leaves 0090's bucket and file rule alone.
  "0091_proposals.sql",
  // E-signatures for proposals: three tables with read policies on app.permitted_orgs, one permission row and a key from proposal_decisions to the signature request that
  // made it; its rollback refuses while a connection, a signature request or its history exists (none does here) and is rolled back before 0091, whose tables it hangs off.
  "0092_esign.sql",
  // Reputation follow-through: columns on customer_feedback and crm_review_requests, a settings table and three permissions; its rollback refuses while a survey answer,
  // an escalation, an acknowledgement or a resolution exists (none does here).
  "0094_reputation_followthrough.sql",
  // Public reviews read from a review site and replies to them: five tables with read policies on app.permitted_orgs (a connection's credentials stay unreadable); its rollback
  // refuses while a connection, a mirrored review or a reply exists (none does here) and is rolled back before 0094, whose permissions its policies use.
  "0095_external_reviews.sql",
  // Customer invoices and payments: ten tables with read policies on app.permitted_orgs, seventeen invoices.* permission rows, eight notification kinds and the 'billing' message
  // scope; its rollback refuses while an invoice, payment, refund, connection, receipt or reminder exists (none does here).
  "0093_customer_invoices_payments.sql",
  // Internal staff Messages: eight agency-only tables with read policies on the caller's current standing (app.staff_conversation_ids), three agency.messages.* permission rows,
  // two entries in the agency override lists, the 'staff' notification audience and five notification kinds; its rollback refuses while a conversation, message, attachment or
  // staff notification exists (none does here).
  "0096_staff_messages.sql",
  // Payment controls for iAcquire's own billing: columns on billing_accounts, payments and maintenance_subscriptions, a function and four notification kinds; its rollback
  // refuses while a payment recorded by hand, a waiver a person made or a plan period tied to a payment exists (none does here).
  "0099_payment_controls.sql",
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
