import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createInvitation } from "@/server/auth/service";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

const DOWN = readFileSync("supabase/rollbacks/0041_crm_action_permissions.down.sql", "utf8");
const DOWN_0042 = readFileSync("supabase/rollbacks/0042_company_delete_permission.down.sql", "utf8");
const DOWN_0043 = readFileSync("supabase/rollbacks/0043_agency_manager_operational_defaults.down.sql", "utf8");
const DOWN_0044 = readFileSync("supabase/rollbacks/0044_agency_module_view_overrides.down.sql", "utf8");
const UP_0042 = readFileSync("supabase/migrations/0042_company_delete_permission.sql", "utf8");
class Done extends Error {}

/** Split SQL into whole statements while keeping dollar-quoted function bodies intact. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inDollarBody = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inDollarBody && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inDollarBody = !inDollarBody;
    if (!inDollarBody && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}

async function runDown(db: { query: (sql: string) => Promise<unknown> }) {
  await runDown0043(db);
  await runDown0042(db);
  for (const statement of statements(DOWN)) await db.query(statement);
}

async function runDown0043(db: { query: (sql: string) => Promise<unknown> }) {
  for (const statement of statements(DOWN_0043)) await db.query(statement);
}

async function runDown0044(db: { query: (sql: string) => Promise<unknown> }) {
  for (const statement of statements(DOWN_0044)) await db.query(statement);
}

async function runDown0042(db: { query: (sql: string) => Promise<unknown> }) {
  await runDown0043(db);
  for (const statement of statements(DOWN_0042)) await db.query(statement);
}

async function runUp0042(db: { query: (sql: string) => Promise<unknown> }) {
  for (const statement of statements(UP_0042)) await db.query(statement);
}

describe("migration 0043 rollback safety", () => {
  it("removes only the Manager operational defaults and preserves earlier agency permissions", async () => {
    const report: { manager: string[]; staff: string[] } = { manager: [], staff: [] };
    await expect(withSystem(async (db) => {
      await runDown0043(db);
      const state = await db.query<{ role: string; permission: string }>(
        `select role,permission from role_permissions
         where role in ('agency_manager','agency_staff')
           and permission in ('agency.crm.manage','contacts.create','contacts.edit','companies.create','companies.edit',
             'opportunities.create','opportunities.edit','appointments.book','appointments.manage','calendars.manage',
             'website.publish','agency.workforce.manage','agency.crm.read')
         order by role,permission`,
      );
      report.manager = state.rows.filter((row) => row.role === "agency_manager").map((row) => row.permission);
      report.staff = state.rows.filter((row) => row.role === "agency_staff").map((row) => row.permission);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);

    expect(report.manager).toEqual(["agency.crm.read", "agency.workforce.manage"]);
    expect(report.staff).toEqual(["agency.crm.read"]);
  });
});

describe("migration 0044 rollback safety", () => {
  it("refuses to remove permissions that are already in use", async () => {
    const manager = await createUser({ platformRole: "agency_manager" });
    await expect(withSystem(async (db) => {
      await db.query(
        "insert into agency_user_permission_overrides(user_id,permission,effect) values($1,'projects.view','deny')",
        [manager.id],
      );
      await runDown0044(db);
    })).rejects.toThrow(/cannot rollback 0044 while Projects or Website Studio view overrides exist/);

    const constraint = await withSystem((db) => db.query<{ definition: string }>(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='agency_user_permission_overrides'::regclass and conname='agency_user_permission_overrides_permission_check'",
    ));
    expect(constraint.rows[0].definition).toContain("projects.view");
    expect(constraint.rows[0].definition).toContain("website.view");
  });

  it("restores the 0043 permission constraints when no module view overrides exist", async () => {
    let agencyConstraint = "";
    let invitationConstraint = "";
    await expect(withSystem(async (db) => {
      await runDown0044(db);
      const rows = await db.query<{ name: string; definition: string }>(
        `select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint
         where conrelid in ('agency_user_permission_overrides'::regclass,'invitation_agency_permission_overrides'::regclass)
           and conname in ('agency_user_permission_overrides_permission_check','invitation_agency_permission_overrides_permission_check')`,
      );
      agencyConstraint = rows.rows.find((row) => row.name === "agency_user_permission_overrides_permission_check")?.definition ?? "";
      invitationConstraint = rows.rows.find((row) => row.name === "invitation_agency_permission_overrides_permission_check")?.definition ?? "";
      throw new Done();
    })).rejects.toBeInstanceOf(Done);

    expect(agencyConstraint).not.toContain("projects.view");
    expect(agencyConstraint).not.toContain("website.view");
    expect(invitationConstraint).not.toContain("projects.view");
    expect(invitationConstraint).not.toContain("website.view");
  });
});

describe("migration 0042 rollback safety", () => {
  it("refuses to collapse company and contact deletion overrides that disagree", async () => {
    const manager = await createUser({ platformRole: "agency_manager" });
    await expect(withSystem(async (db) => {
      await db.query(
        "insert into agency_user_permission_overrides(user_id,permission,effect) values($1,'contacts.delete','allow'),($1,'companies.delete','deny')",
        [manager.id],
      );
      await runDown0042(db);
    })).rejects.toThrow(/cannot rollback 0042 while agency company delete overrides differ/);

    const constraint = await withSystem((db) => db.query<{ definition: string }>(
      "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='agency_user_permission_overrides'::regclass and conname='agency_user_permission_overrides_permission_check'",
    ));
    expect(constraint.rows[0].definition).toContain("companies.delete");
  });

  it("removes the new permission cleanly when defaults and overrides remain equivalent", async () => {
    let report: { constraint: string | null; permissionRows: number; functionSource: string } = {
      constraint: null,
      permissionRows: -1,
      functionSource: "",
    };
    await expect(withSystem(async (db) => {
      await runDown0042(db);
      const state = await db.query<{ constraint: string; permission_rows: number; function_source: string }>(
        `select
           (select pg_get_constraintdef(oid) from pg_constraint where conrelid='agency_user_permission_overrides'::regclass and conname='agency_user_permission_overrides_permission_check') as constraint,
           (select count(*)::int from role_permissions where permission='companies.delete') as permission_rows,
           (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname='has_permission' and p.pronargs=2) as function_source`,
      );
      const row = state.rows[0];
      report = { constraint: row.constraint, permissionRows: row.permission_rows, functionSource: row.function_source };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);

    expect(report.constraint).not.toContain("companies.delete");
    expect(report.permissionRows).toBe(0);
    expect(report.functionSource).not.toContain("companies.delete");
  });

  it("preserves existing company-delete access when upgrading contact-delete overrides", async () => {
    const org = await createOrg({ name: "Company permission migration client" });
    const member = await createUser();
    await addMember(org.id, member.id, "sales_rep");
    const agencyMember = await createUser({ platformRole: "agency_staff" });
    const inviter = await createUser({ platformRole: "agency_super_admin" });
    const invitation = await withSystem((db) => createInvitation({
      orgId: null,
      email: `company-delete-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      invitedBy: inviter.id,
    }, db));

    let report: { member?: string; agency?: string; invitation?: string } = {};
    await expect(withSystem(async (db) => {
      await runDown0042(db);
      await db.query("insert into member_permission_overrides(org_id,user_id,permission,effect) values($1,$2,'contacts.delete','grant')", [org.id, member.id]);
      await db.query("insert into agency_user_permission_overrides(user_id,permission,effect) values($1,'contacts.delete','allow')", [agencyMember.id]);
      await db.query("insert into invitation_agency_permission_overrides(invitation_id,permission,effect) values($1,'contacts.delete','allow')", [invitation.id]);
      await runUp0042(db);
      const migrated = await db.query<{ kind: string; effect: string }>(
        `select 'member' as kind,effect from member_permission_overrides where org_id=$1 and user_id=$2 and permission='companies.delete'
         union all select 'agency',effect from agency_user_permission_overrides where user_id=$3 and permission='companies.delete'
         union all select 'invitation',effect from invitation_agency_permission_overrides where invitation_id=$4 and permission='companies.delete'`,
        [org.id, member.id, agencyMember.id, invitation.id],
      );
      const effects = new Map(migrated.rows.map((row) => [row.kind, row.effect]));
      report = { member: effects.get("member"), agency: effects.get("agency"), invitation: effects.get("invitation") };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);

    expect(report).toEqual({ member: "grant", agency: "allow", invitation: "allow" });
  });
});

describe("migration 0041 rollback safety", () => {
  it("refuses to remove Website Studio override choices and leaves the schema intact", async () => {
    const manager = await createUser({ platformRole: "agency_manager" });
    await expect(withSystem(async (db) => {
      await db.query(
        "insert into agency_user_permission_overrides(user_id,permission,effect) values($1,'website.create','allow'),($1,'website.edit','allow')",
        [manager.id],
      );
      await runDown(db);
    })).rejects.toThrow(/cannot rollback 0041 while Website Studio team overrides exist/);
    const state = await withSystem(async (db) => ({
      override: (await db.query("select 1 from agency_user_permission_overrides where user_id=$1 and permission='website.edit'", [manager.id])).rows.length,
      constraint: (await db.query<{ definition: string }>(
        "select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='agency_user_permission_overrides'::regclass and conname='agency_user_permission_overrides_permission_check'",
      )).rows[0]?.definition ?? "",
    }));
    expect(state.override).toBe(0);
    expect(state.constraint).toContain("website.edit");
    expect(state.constraint).toContain("website.create");
  });

  it("merges create/edit choices conservatively and restores the prior schema transactionally", async () => {
    const org = await createOrg({ name: "CRM action rollback client" });
    const clientMember = await createUser();
    await addMember(org.id, clientMember.id, "admin");
    const agencyMember = await createUser({ platformRole: "agency_staff" });
    const invitation = await createInvitation({
      orgId: null,
      email: `rollback-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      invitedBy: null,
      agencyPermissionOverrides: { "contacts.edit": "allow", "contacts.create": "deny", "website.publish": "allow" },
    });

    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      await db.query(
        "insert into member_permission_overrides(org_id,user_id,permission,effect) values($1,$2,'contacts.edit','grant'),($1,$2,'contacts.create','revoke')",
        [org.id, clientMember.id],
      );
      await db.query(
        "insert into agency_user_permission_overrides(user_id,permission,effect) values($1,'contacts.edit','allow'),($1,'contacts.create','deny')",
        [agencyMember.id],
      );
      await db.query(
        "insert into agency_user_permission_overrides(user_id,permission,effect) values($1,'website.publish','allow'),($1,'website.archive','deny')",
        [agencyMember.id],
      );
      await db.query(
        "insert into invitation_agency_permission_overrides(invitation_id,permission,effect) values($1,'website.archive','deny')",
        [invitation.id],
      );

      await runDown(db);
      const member = await db.query<{ permission: string; effect: string }>(
        "select permission,effect from member_permission_overrides where org_id=$1 and user_id=$2 order by permission",
        [org.id, clientMember.id],
      );
      const agency = await db.query<{ permission: string; effect: string }>(
        "select permission,effect from agency_user_permission_overrides where user_id=$1 order by permission",
        [agencyMember.id],
      );
      const invite = await db.query<{ permission: string; effect: string }>(
        "select permission,effect from invitation_agency_permission_overrides where invitation_id=$1 order by permission",
        [invitation.id],
      );
      const schema = await db.query<{ member: string; agency: string; invitation: string; function_source: string; create_defaults: number }>(
        `select
          (select pg_get_constraintdef(oid) from pg_constraint where conrelid='member_permission_overrides'::regclass and conname='member_permission_overrides_permission_check') as member,
          (select pg_get_constraintdef(oid) from pg_constraint where conrelid='agency_user_permission_overrides'::regclass and conname='agency_user_permission_overrides_permission_check') as agency,
          (select pg_get_constraintdef(oid) from pg_constraint where conrelid='invitation_agency_permission_overrides'::regclass and conname='invitation_agency_permission_overrides_permission_check') as invitation,
          (select prosrc from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='app' and p.proname='has_permission' and p.pronargs=2) as function_source,
          (select count(*)::int from role_permissions where permission in ('contacts.create','companies.create','opportunities.create')) as create_defaults`,
      );
      report = { member: member.rows, agency: agency.rows, invitation: invite.rows, schema: schema.rows[0] };
      throw new Done();
    })).rejects.toBeInstanceOf(Done);

    expect(report.member).toEqual([{ permission: "contacts.edit", effect: "revoke" }]);
    expect(report.agency).toEqual([
      { permission: "contacts.edit", effect: "deny" },
      { permission: "website.publish", effect: "deny" },
    ]);
    expect(report.invitation).toEqual([
      { permission: "contacts.edit", effect: "deny" },
      { permission: "website.publish", effect: "deny" },
    ]);
    const schema = report.schema as { member: string; agency: string; invitation: string; function_source: string; create_defaults: number };
    expect(schema.create_defaults).toBe(0);
    expect(schema.member).not.toContain("contacts.create");
    expect(schema.agency).not.toContain("contacts.create");
    expect(schema.invitation).not.toContain("contacts.create");
    expect(schema.agency).not.toContain("website.edit");
    expect(schema.function_source).not.toContain("contacts.create");

    // The sentinel exception rolled the audit back so this test never downgrades the shared test database.
    const stillCurrent = await withSystem((db) => db.query<{ allowed: boolean }>(
      "select app.user_has_agency_permission($1,'contacts.create') as allowed",
      [agencyMember.id],
    ));
    expect(stillCurrent.rows[0]?.allowed).toBe(false);
  });
});
