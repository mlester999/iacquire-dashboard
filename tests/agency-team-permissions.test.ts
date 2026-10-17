import { describe, expect, it } from "vitest";
import { applyInvitation, createInvitation, getInvitation } from "@/server/auth/service";
import { copyAgencyUserPermissions, updateAgencyTeamMember, updateAgencyUserPermission } from "@/server/admin/team";
import { assignStaff, createClientTenant } from "@/server/admin/tenants";
import { withSystem, withUser, listMigrationFiles, selectMigrationFiles } from "@/server/db";
import { assertAgencyAccess, lockAgencySetupAccess } from "@/server/setup/core";
import { listClientSetupOverview } from "@/server/setup/snapshots";
import { getAdminOverview, getTenantDetail, listAllAgents } from "@/server/admin/queries";
import { agencyCrmPortfolio } from "@/server/crm/agency";
import { listAgencyTickets } from "@/server/support/service";
import { loadAgencyPermissions } from "@/server/tenancy/context";
import { AGENCY_DELEGABLE_PERMISSIONS, AGENCY_PERMISSION_INFO, AGENCY_TEAM_MANAGED_PERMISSIONS, AGENCY_TEAM_PROTECTED_PERMISSIONS, PERMISSION_MATRIX } from "@/lib/permissions";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";

async function canAccess(userId: string, orgId: string) {
  return withSystem(async (db) => (await db.query<{ allowed: boolean }>(
    "select app.user_can_access_org($1,$2) as allowed",
    [userId, orgId],
  )).rows[0]?.allowed === true);
}

describe("agency team migration compatibility", () => {
  it("lists every permission as editable or protected on member details", () => {
    const agencyTeamPermissions = [...AGENCY_TEAM_MANAGED_PERMISSIONS, ...AGENCY_TEAM_PROTECTED_PERMISSIONS];
    expect(new Set(agencyTeamPermissions).size).toBe(agencyTeamPermissions.length);
    expect([...agencyTeamPermissions].sort()).toEqual(Object.keys(PERMISSION_MATRIX).sort());
    expect([...AGENCY_DELEGABLE_PERMISSIONS]).toEqual(Object.entries(AGENCY_PERMISSION_INFO).filter(([, info]) => info.delegable).map(([permission]) => permission));
  });

  it("applies unique migrations 0037 through 0043 in order and keeps the permission constraints in sync", async () => {
    const chain = listMigrationFiles().filter((file) => /^003[789]_|^004[0-3]_/.test(file));
    expect(chain.map((file) => file.slice(0, 4))).toEqual(["0037", "0038", "0039", "0040", "0041", "0042", "0043"]);
    expect(new Set(chain.map((file) => file.slice(0, 4))).size).toBe(chain.length);
    const applied = await withSystem((db) => db.query<{ version: string }>(
      "select version from schema_migrations where version like '0037_%' or version like '0038_%' or version like '0039_%' or version like '0040_%' or version like '0041_%' or version like '0042_%' or version like '0043_%' order by version",
    ));
    expect(applied.rows.map((row) => row.version)).toEqual(chain.map((file) => file.replace(/\.sql$/, "")));

    const constraints = await withSystem((db) => db.query<{ name: string; definition: string }>(
      `select conname as name,pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid in ('agency_user_permission_overrides'::regclass,'invitation_agency_permission_overrides'::regclass)
         and conname in ('agency_user_permission_overrides_permission_check','invitation_agency_permission_overrides_permission_check')`,
    ));
    expect(constraints.rows).toHaveLength(2);
    for (const constraint of constraints.rows) {
      const values = [...constraint.definition.matchAll(/'([^']+)'/g)].map((match) => match[1]).sort();
      expect(values).toEqual([...AGENCY_TEAM_MANAGED_PERMISSIONS, "calendars.connect"].sort());
    }
    const clientOverrideConstraint = await withSystem((db) => db.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
       where conrelid='member_permission_overrides'::regclass and conname='member_permission_overrides_permission_check'`,
    ));
    const clientOverridePermissions = [...clientOverrideConstraint.rows[0].definition.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    expect(clientOverridePermissions).toEqual(expect.arrayContaining(["contacts.create", "companies.create", "companies.delete", "opportunities.create"]));
  });

  it("selects only exact requested agency migrations in dependency order", () => {
    expect(selectMigrationFiles([
      "0041_crm_action_permissions",
      "0042_company_delete_permission",
      "0043_agency_manager_operational_defaults",
      "0040_agency_workforce_permissions",
      "0039_agency_team_permission_overrides",
    ])).toEqual([
      "0039_agency_team_permission_overrides.sql",
      "0040_agency_workforce_permissions.sql",
      "0041_crm_action_permissions.sql",
      "0042_company_delete_permission.sql",
      "0043_agency_manager_operational_defaults.sql",
    ]);
    expect(() => selectMigrationFiles(["0039"])).toThrow(/exact filenames/);
    expect(() => selectMigrationFiles([])).toThrow(/at least one exact migration version/);
  });

  it("preserves authorization for existing private-file buckets alongside support attachment rules", async () => {
    const client = await createOrg({ name: "Private bucket regression client" });
    const owner = await createUser();
    await addMember(client.id, owner.id, "owner");

    const clientBuckets = await withUser(owner.id, (db) => db.query<{ brand: boolean; project_upload: boolean }>(
      `select app.file_permission($1,'brand-assets',true,'client') as brand,
              app.file_permission($1,'project-uploads',true,'client') as project_upload`,
      [client.id],
    ));
    expect(clientBuckets.rows[0]).toEqual({ brand: true, project_upload: true });

    const agency = await createOrg({ name: "Private bucket regression agency", kind: "agency" });
    const superAdmin = await createUser({ platformRole: "agency_super_admin" });
    const portfolio = await withUser(superAdmin.id, (db) => db.query<{ allowed: boolean }>(
      "select app.file_permission($1,'portfolio-assets',true,'client') as allowed",
      [agency.id],
    ));
    expect(portfolio.rows[0]?.allowed).toBe(true);
  });
});

describe("agency manager and staff access", () => {
  it("checks CRM summary permission and applies the live all-client or assigned-client scope", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const assigned = await createOrg({ name: "CRM portfolio assigned client" });
    const unassigned = await createOrg({ name: "CRM portfolio unassigned client" });
    await withSystem((db) => db.query(
      "insert into staff_assignments (org_id,user_id,assigned_by) values ($1,$2,$3)",
      [assigned.id, staff.id, owner.id],
    ));

    const managerRows = await agencyCrmPortfolio(agencyUser(manager, "agency_manager"));
    expect(managerRows.map((row) => row.orgId)).toEqual(expect.arrayContaining([assigned.id, unassigned.id]));

    const staffRows = await agencyCrmPortfolio(agencyUser(staff, "agency_staff"));
    expect(staffRows.map((row) => row.orgId)).toContain(assigned.id);
    expect(staffRows.map((row) => row.orgId)).not.toContain(unassigned.id);

    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: staff.id,
      permission: "agency.crm.read",
      effect: "deny",
    });
    await expect(agencyCrmPortfolio(agencyUser(staff, "agency_staff"))).rejects.toMatchObject({ code: "forbidden" });

    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: staff.id,
      permission: "agency.crm.read",
      effect: null,
    });
    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: staff.id,
      permission: "crm.view",
      effect: "deny",
    });
    expect((await agencyCrmPortfolio(agencyUser(staff, "agency_staff"))).map((row) => row.orgId)).toContain(assigned.id);
  });

  it("removes denied workforce and support data from the admin dashboard and protects its query services", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const client = await createOrg({ name: "Permission-aware dashboard client" });
    const unassignedClient = await createOrg({ name: "Out-of-scope dashboard client" });
    await withSystem(async (db) => {
      await db.query("insert into staff_assignments (org_id,user_id,assigned_by) values ($1,$2,$3)", [client.id, staff.id, owner.id]);
      await db.query("update agent_instances set enabled=true,status='online' where id=(select id from agent_instances where org_id=$1 order by role_key limit 1)", [client.id]);
      await db.query("update agent_instances set enabled=true,status='online' where id=(select id from agent_instances where org_id=$1 order by role_key limit 1)", [unassignedClient.id]);
      await db.query("insert into support_tickets (org_id,created_by,subject,priority) values ($1,$2,'Permission test ticket','urgent')", [client.id, staff.id]);
      await db.query("insert into support_tickets (org_id,created_by,subject,priority) values ($1,$2,'Out-of-scope permission test ticket','urgent')", [unassignedClient.id, staff.id]);
    });
    const session = agencyUser(staff, "agency_staff");

    const visible = await getAdminOverview(session);
    expect(visible.clients).toBe(1);
    expect(visible.agentsOnline).toBe(1);
    expect(visible.openTickets).toBe(1);
    expect(await listAllAgents(session)).toHaveLength(6);
    expect(await listAgencyTickets(session, "active")).toHaveLength(1);

    const admin = agencyUser(owner, "agency_super_admin");
    await updateAgencyUserPermission(admin, { userId: staff.id, permission: "agency.workforce.view", effect: "deny" });
    await updateAgencyUserPermission(admin, { userId: staff.id, permission: "agency.support.view", effect: "deny" });

    const effectivePermissions = await loadAgencyPermissions(staff.id);
    expect(effectivePermissions).not.toContain("agency.workforce.view");
    expect(effectivePermissions).not.toContain("agency.support.view");
    const restricted = await getAdminOverview(session);
    expect(restricted).toMatchObject({ agentsOnline: 0, agentsEnabled: 0, provisioningOpen: 0, heldReviews: 0, openTickets: 0, urgentTickets: 0 });
    await expect(listAllAgents(session)).rejects.toMatchObject({ code: "forbidden" });
    await expect(listAgencyTickets(session, "active")).rejects.toMatchObject({ code: "forbidden" });
  });

  it("gives Managers safe client CRM, calendar and approved-site publishing defaults without destructive grants", async () => {
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const check = (userId: string) => withSystem((db) => db.query<Record<string, boolean>>(
      `select
         app.user_has_agency_permission($1,'agency.crm.manage') as crm_write,
         app.user_has_agency_permission($1,'contacts.create') as contacts_create,
         app.user_has_agency_permission($1,'contacts.edit') as contacts_edit,
         app.user_has_agency_permission($1,'contacts.delete') as contacts_delete,
         app.user_has_agency_permission($1,'contacts.export') as contacts_export,
         app.user_has_agency_permission($1,'companies.create') as companies_create,
         app.user_has_agency_permission($1,'companies.edit') as companies_edit,
         app.user_has_agency_permission($1,'companies.delete') as companies_delete,
         app.user_has_agency_permission($1,'opportunities.create') as opportunities_create,
         app.user_has_agency_permission($1,'opportunities.edit') as opportunities_edit,
         app.user_has_agency_permission($1,'opportunities.delete') as opportunities_delete,
         app.user_has_agency_permission($1,'appointments.book') as appointments_book,
         app.user_has_agency_permission($1,'appointments.manage') as appointments_manage,
         app.user_has_agency_permission($1,'calendars.manage') as calendars_manage,
         app.user_has_agency_permission($1,'website.publish') as website_publish,
         app.user_has_agency_permission($1,'website.approve') as website_approve,
         app.user_has_agency_permission($1,'website.archive') as website_archive`,
      [userId],
    ));
    expect((await check(manager.id)).rows[0]).toEqual({
      crm_write: true,
      contacts_create: true,
      contacts_edit: true,
      contacts_delete: false,
      contacts_export: false,
      companies_create: true,
      companies_edit: true,
      companies_delete: false,
      opportunities_create: true,
      opportunities_edit: true,
      opportunities_delete: false,
      appointments_book: true,
      appointments_manage: true,
      calendars_manage: true,
      website_publish: true,
      website_approve: false,
      website_archive: false,
    });
    expect((await check(staff.id)).rows[0]).toMatchObject({
      crm_write: false,
      contacts_create: false,
      contacts_edit: false,
      appointments_book: false,
      appointments_manage: false,
      calendars_manage: false,
      website_publish: false,
    });
  });

  it("rejects direct team mutations unless the database confirms an active Super Admin", async () => {
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });
    const client = await createOrg({ name: "Unauthorized team mutation client" });

    await expect(updateAgencyTeamMember(agencyUser(manager, "agency_manager"), {
      userId: staff.id,
      platformRole: "agency_staff",
      status: "active",
      scopeMode: "assigned_clients",
    })).rejects.toMatchObject({ code: "forbidden" });
    await expect(updateAgencyUserPermission(agencyUser(manager, "agency_manager"), {
      userId: staff.id,
      permission: "website.publish",
      effect: "allow",
    })).rejects.toMatchObject({ code: "forbidden" });

    // A forged SessionUser role does not replace the live user record check.
    await expect(updateAgencyTeamMember(agencyUser(manager, "agency_super_admin"), {
      userId: staff.id,
      platformRole: "agency_staff",
      status: "active",
      scopeMode: "assigned_clients",
    })).rejects.toMatchObject({ code: "forbidden" });

    expect(await canAccess(staff.id, client.id)).toBe(false);
  });

  it("enforces independent Website Studio create, edit, publish and archive grants in the database", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const client = await createOrg({ name: "Website action permissions client" });
    const admin = agencyUser(owner, "agency_super_admin");

    await updateAgencyTeamMember(admin, {
      userId: manager.id,
      platformRole: "agency_manager",
      status: "active",
      scopeMode: "all_clients",
      permissionOverrides: {
        "website.create": "allow",
        "website.edit": "deny",
        "website.publish": "deny",
        "website.archive": "allow",
      },
    });

    const permissions = await withUser(manager.id, (db) => db.query<{ create_site: boolean; edit_site: boolean; publish_site: boolean; archive_site: boolean }>(
      `select app.has_permission($1,'website.create') as create_site,
              app.has_permission($1,'website.edit') as edit_site,
              app.has_permission($1,'website.publish') as publish_site,
              app.has_permission($1,'website.archive') as archive_site`,
      [client.id],
    ));
    expect(permissions.rows[0]).toEqual({ create_site: true, edit_site: false, publish_site: false, archive_site: true });
  });

  it("keeps a teammate's company-delete grant separate from contact deletion", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const client = await createOrg({ name: "CRM delete action permissions client" });
    await updateAgencyTeamMember(agencyUser(owner, "agency_super_admin"), {
      userId: manager.id,
      platformRole: "agency_manager",
      status: "active",
      scopeMode: "all_clients",
      permissionOverrides: { "agency.crm.manage": "allow", "contacts.delete": "allow", "companies.delete": "deny" },
    });

    const permissions = await withSystem((db) => db.query<{ contact_delete: boolean; company_delete: boolean }>(
      `select app.user_has_agency_permission($1,'contacts.delete') as contact_delete,
              app.user_has_agency_permission($1,'companies.delete') as company_delete`,
      [manager.id],
    ));
    expect(permissions.rows[0]).toEqual({ contact_delete: true, company_delete: false });
    expect(await canAccess(manager.id, client.id)).toBe(true);
  });

  it("assigns a staff member with client-creation permission to the new client without widening their scope", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const staff = await createUser({ platformRole: "agency_staff" });
    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: staff.id,
      permission: "agency.clients.create",
      effect: "allow",
    });

    const created = await createClientTenant(agencyUser(staff, "agency_staff"), {
      name: `Staff client ${crypto.randomUUID().slice(0, 8)}`,
      ownerEmail: `owner-${crypto.randomUUID()}@example.test`,
      enabledRoles: ["lead_hunter"],
    });
    expect(await canAccess(staff.id, created.orgId)).toBe(true);

    const unassigned = await createOrg({ name: "Unassigned client" });
    expect(await canAccess(staff.id, unassigned.id)).toBe(false);
  });

  it("gives managers all current and future clients while staff stay assigned-only", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const currentClient = await createOrg({ name: "Manager current client" });
    const futureClient = await createOrg({ name: "Manager future client" });
    const assignedClient = await createOrg({ name: "Staff assigned client" });
    const otherClient = await createOrg({ name: "Staff other client" });

    const managerInvite = await withSystem((db) => createInvitation({
      orgId: null,
      email: `manager-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_manager",
      invitedBy: owner.id,
    }, db));
    expect(managerInvite.delivery).toBeNull();
    const manager = await createUser();
    await withSystem((db) => applyInvitation(db, managerInvite.id, manager.id));
    expect(await canAccess(manager.id, currentClient.id)).toBe(true);
    expect(await canAccess(manager.id, futureClient.id)).toBe(true);

    await withSystem((db) => db.query(
      "insert into staff_assignments (org_id,user_id,assigned_by) values ($1,$2,$3)",
      [currentClient.id, manager.id, owner.id],
    ));
    const superAdmin = agencyUser(owner, "agency_super_admin");
    await updateAgencyTeamMember(superAdmin, { userId: manager.id, platformRole: "agency_manager", status: "active", scopeMode: "assigned_clients" });
    expect(await canAccess(manager.id, currentClient.id)).toBe(true);
    expect(await canAccess(manager.id, futureClient.id)).toBe(false);
    await updateAgencyTeamMember(superAdmin, { userId: manager.id, platformRole: "agency_manager", status: "disabled", scopeMode: "assigned_clients" });
    expect(await canAccess(manager.id, currentClient.id)).toBe(false);

    const staffInvite = await withSystem((db) => createInvitation({
      orgId: null,
      email: `staff-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      agencyScopeMode: "assigned_clients",
      initialClientIds: [assignedClient.id],
      invitedBy: owner.id,
    }, db));
    const staff = await createUser();
    await withSystem((db) => applyInvitation(db, staffInvite.id, staff.id));
    expect(await canAccess(staff.id, assignedClient.id)).toBe(true);
    expect(await canAccess(staff.id, otherClient.id)).toBe(false);

    await expect(withSystem((db) => applyInvitation(db, staffInvite.id, staff.id))).rejects.toThrow(/no longer valid/);
  });

  it("rejects invalid staff scopes and applies supported permission withdrawals immediately", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });

    await expect(createInvitation({
      orgId: null,
      email: `invalid-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      agencyScopeMode: "all_clients",
      invitedBy: owner.id,
    })).rejects.toThrow(/assigned-client scope/);

    await expect(createInvitation({
      orgId: null,
      email: `owner-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_super_admin",
      invitedBy: owner.id,
    })).rejects.toThrow(/cannot be granted through an invitation/);

    const before = await withSystem(async (db) => (await db.query<{ allowed: boolean }>(
      "select app.user_has_agency_permission($1,'agency.clients.create') as allowed",
      [manager.id],
    )).rows[0].allowed);
    expect(before).toBe(true);
    const workforceDefaults = await withSystem((db) => db.query<{ view: boolean; manage: boolean }>(
      `select app.user_has_agency_permission($1,'agency.workforce.view') as view,
              app.user_has_agency_permission($1,'agency.workforce.manage') as manage`,
      [manager.id],
    ));
    expect(workforceDefaults.rows[0]).toEqual({ view: true, manage: true });
    const staffDefaults = await withSystem((db) => db.query<{ view: boolean; manage: boolean }>(
      `select app.user_has_agency_permission($1,'agency.workforce.view') as view,
              app.user_has_agency_permission($1,'agency.workforce.manage') as manage`,
      [staff.id],
    ));
    expect(staffDefaults.rows[0]).toEqual({ view: true, manage: false });
    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: staff.id,
      permission: "agency.workforce.manage",
      effect: "allow",
    });
    const customizedStaff = await withSystem((db) => db.query<{ allowed: boolean }>(
      "select app.user_has_agency_permission($1,'agency.workforce.manage') as allowed",
      [staff.id],
    ));
    expect(customizedStaff.rows[0]?.allowed).toBe(true);
    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: manager.id,
      permission: "agency.clients.create",
      effect: "deny",
      reason: "Temporary restriction",
    });
    const after = await withSystem(async (db) => (await db.query<{ allowed: boolean }>(
      "select app.user_has_agency_permission($1,'agency.clients.create') as allowed",
      [manager.id],
    )).rows[0].allowed);
    expect(after).toBe(false);

    await expect(withSystem((db) => db.query(
      `insert into agency_user_permission_overrides(user_id,permission,effect,updated_by)
       values($1,'agency.integrations.manage','allow',$2)`,
      [staff.id, owner.id],
    ))).rejects.toThrow();
  });

  it("rechecks Setup Center scope and permission for managers inside the write transaction", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const assigned = await createOrg({ name: "Assigned setup client" });
    const outOfScope = await createOrg({ name: "Out of scope setup client" });
    const admin = agencyUser(owner, "agency_super_admin");
    const agencyManager = agencyUser(manager, "agency_manager");

    await withSystem((db) => db.query(
      "insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)",
      [assigned.id, manager.id, owner.id],
    ));
    await updateAgencyTeamMember(admin, {
      userId: manager.id,
      platformRole: "agency_manager",
      status: "active",
      scopeMode: "assigned_clients",
    });

    await expect(assertAgencyAccess(agencyManager, assigned.id)).resolves.toBeUndefined();
    await expect(withSystem((db) => lockAgencySetupAccess(db, agencyManager, assigned.id))).resolves.toBeUndefined();
    await expect(assertAgencyAccess(agencyManager, outOfScope.id)).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => lockAgencySetupAccess(db, agencyManager, outOfScope.id))).rejects.toMatchObject({ code: "forbidden" });

    await updateAgencyUserPermission(admin, { userId: manager.id, permission: "setup.manage", effect: "deny" });
    await expect(assertAgencyAccess(agencyManager, assigned.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(withSystem((db) => lockAgencySetupAccess(db, agencyManager, assigned.id))).rejects.toMatchObject({ code: "forbidden" });
  });

  it("lists every current client for a full-scope Manager and only assigned clients after narrowing scope", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const assigned = await createOrg({ name: "Manager setup assigned" });
    const unassigned = await createOrg({ name: "Manager setup unassigned" });
    const admin = agencyUser(owner, "agency_super_admin");
    const agencyManager = agencyUser(manager, "agency_manager");

    const fullScope = await listClientSetupOverview(agencyManager);
    expect(fullScope.map((client) => client.id)).toContain(assigned.id);
    expect(fullScope.map((client) => client.id)).toContain(unassigned.id);

    await withSystem((db) => db.query(
      "insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)",
      [assigned.id, manager.id, owner.id],
    ));
    await updateAgencyTeamMember(admin, {
      userId: manager.id,
      platformRole: "agency_manager",
      status: "active",
      scopeMode: "assigned_clients",
    });
    const narrowedScope = await listClientSetupOverview(agencyManager);
    expect(narrowedScope.map((client) => client.id)).toEqual([assigned.id]);
  });

  it("filters client detail data by current feature permissions and removes denied workforce access immediately", async () => {
    const org = await createOrg({ name: "Permission filtered detail client" });
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const staff = await createUser({ platformRole: "agency_staff" });
    await withSystem(async (db) => {
      await db.query("insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3)", [org.id, staff.id, owner.id]);
      await db.query("insert into integration_status(org_id,provider,status,detail) values($1,'hermes','connected','synthetic healthy')", [org.id]);
      await db.query(
        `insert into agent_runs (org_id, agent_instance_id, idempotency_key, status, error_code, error_message, finished_at)
         select $1, id, $2, 'failed', 'synthetic_failure', 'Synthetic failure for authorization test', now()
         from agent_instances where org_id = $1 limit 1`,
        [org.id, `agency-detail-${crypto.randomUUID()}`],
      );
    });

    const managerDetail = await getTenantDetail(agencyUser(manager, "agency_manager"), org.id);
    expect(managerDetail.access).toEqual({ team: true, workforce: true, integrations: true, setup: true });
    expect(managerDetail.agents).toHaveLength(6);
    expect(managerDetail.integrations).toHaveLength(1);
    expect(managerDetail.staff).toContainEqual(expect.objectContaining({ user_id: staff.id, assigned: true }));
    expect(managerDetail.failedRuns).toHaveLength(1);

    const staffDetail = await getTenantDetail(agencyUser(staff, "agency_staff"), org.id);
    expect(staffDetail.access).toEqual({ team: false, workforce: true, integrations: false, setup: true });
    expect(staffDetail.members).toEqual([]);
    expect(staffDetail.staff).toEqual([]);
    expect(staffDetail.integrations).toEqual([]);
    expect(staffDetail.agents).toHaveLength(6);
    expect(staffDetail.failedRuns).toHaveLength(1);

    await updateAgencyUserPermission(agencyUser(owner, "agency_super_admin"), {
      userId: manager.id,
      permission: "agency.workforce.view",
      effect: "deny",
    });
    const updated = await getTenantDetail(agencyUser(manager, "agency_manager"), org.id);
    expect(updated.access.workforce).toBe(false);
    expect(updated.agents).toEqual([]);
    expect(updated.heldVersions).toEqual([]);
    expect(updated.provisioning).toEqual([]);
    expect(updated.failedRuns).toEqual([]);
  });

  it("applies private invitation drafts only after acceptance and keeps public invitation details minimal", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const invitation = await withSystem((db) => createInvitation({
      orgId: null,
      email: `custom-${crypto.randomUUID()}@example.test`,
      platformRole: "agency_staff",
      agencyScopeMode: "assigned_clients",
      agencyPermissionOverrides: { "agency.crm.manage": "allow", "contacts.delete": "allow" },
      invitedBy: owner.id,
    }, db));

    const details = await getInvitation(invitation.token);
    expect(details).toMatchObject({ id: invitation.id, platformRole: "agency_staff", status: "valid" });
    expect(details).not.toHaveProperty("agencyPermissionOverrides");

    const teammate = await createUser();
    await withSystem((db) => applyInvitation(db, invitation.id, teammate.id));
    const result = await withSystem((db) => db.query<{ permission: string; allowed: boolean }>(
      `select p.permission,coalesce(app.user_has_agency_permission($1,p.permission),false) as allowed
       from unnest(array['agency.crm.manage','contacts.delete']::text[]) as p(permission) order by p.permission`,
      [teammate.id],
    ));
    expect(result.rows).toEqual([
      { permission: "agency.crm.manage", allowed: true },
      { permission: "contacts.delete", allowed: true },
    ]);
  });

  it("keeps role defaults dynamic, saves role and overrides atomically, and rejects stale edits", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const manager = await createUser({ platformRole: "agency_manager" });
    const admin = agencyUser(owner, "agency_super_admin");

    const defaults = await withSystem((db) => db.query<{ read: boolean; write: boolean; create_client: boolean }>(
      `select app.user_has_agency_permission($1,'agency.crm.read') as read,
         app.user_has_agency_permission($1,'agency.crm.manage') as write,
         app.user_has_agency_permission($1,'agency.clients.create') as create_client`,
      [manager.id],
    ));
    expect(defaults.rows[0]).toEqual({ read: true, write: true, create_client: true });

    await updateAgencyUserPermission(admin, { userId: manager.id, permission: "agency.crm.manage", effect: "deny", expectedRevision: "0" });
    await expect(updateAgencyUserPermission(admin, { userId: manager.id, permission: "agency.crm.manage", effect: "allow", expectedRevision: "0" }))
      .rejects.toMatchObject({ code: "conflict" });
    await updateAgencyTeamMember(admin, {
      userId: manager.id,
      platformRole: "agency_staff",
      status: "active",
      scopeMode: "assigned_clients",
      expectedRevision: "1",
      permissionOverrides: {},
    });
    const after = await withSystem((db) => db.query<{ role: string; can_write_crm: boolean; can_create_client: boolean }>(
      `select u.platform_role as role,
         app.user_has_agency_permission($1,'agency.crm.manage') as can_write_crm,
         app.user_has_agency_permission($1,'agency.clients.create') as can_create_client
       from users u where u.id=$1`,
      [manager.id],
    ));
    expect(after.rows[0]).toEqual({ role: "agency_staff", can_write_crm: false, can_create_client: false });
  });

  it("copies only selected effective actions and uses revision-checked client assignments", async () => {
    const owner = await createUser({ platformRole: "agency_super_admin" });
    const source = await createUser({ platformRole: "agency_staff" });
    const target = await createUser({ platformRole: "agency_staff" });
    const sourceClient = await createOrg({ name: "Copy source client" });
    const targetClient = await createOrg({ name: "Copy target client" });
    const extraClient = await createOrg({ name: "Copy extra client" });
    await withSystem((db) => db.query(
      "insert into staff_assignments(org_id,user_id,assigned_by) values($1,$2,$3),($4,$5,$3)",
      [sourceClient.id, source.id, owner.id, targetClient.id, target.id],
    ));
    const admin = agencyUser(owner, "agency_super_admin");
    await updateAgencyUserPermission(admin, { userId: source.id, permission: "contacts.delete", effect: "allow" });

    await copyAgencyUserPermissions(admin, {
      sourceUserId: source.id,
      targetUserId: target.id,
      permissions: ["contacts.delete"],
      expectedRevision: "0",
    });
    const access = await withSystem((db) => db.query<{ permission: boolean; source: boolean; target: boolean }>(
      `select app.user_has_agency_permission($1,'contacts.delete') as permission,
         app.user_can_access_org($2,$3) as source,app.user_can_access_org($2,$4) as target`,
      [target.id, target.id, sourceClient.id, targetClient.id],
    ));
    expect(access.rows[0]).toEqual({ permission: true, source: false, target: true });

    await assignStaff(admin, extraClient.id, target.id, true, "1");
    await expect(assignStaff(admin, sourceClient.id, target.id, true, "1")).rejects.toMatchObject({ code: "conflict" });
    expect(await canAccess(target.id, sourceClient.id)).toBe(false);
    expect(await canAccess(target.id, extraClient.id)).toBe(true);
  });
});
