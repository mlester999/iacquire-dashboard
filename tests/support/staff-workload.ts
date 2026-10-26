// Fixtures for the staff workload tests (migration 0097). Synthetic people and clients only. The database holds ONE agency workspace, so it is made once per test file and
// shared; every test makes its own people and clients, so work items never touch each other. Items are written straight into the tables of the four modules (no service
// call), so a count a test checks is the count of the rows it wrote.
import { withSystem } from "@/server/db";
import { createOrg } from "./fixtures";
import { agencyOrgId, staffPerson, type AgencyRole, type Person } from "./staff-messages";
import { STAFF_WORKLOAD_FEATURE } from "@/lib/staff-workload/rules";

export { agencyOrgId, asUser, clearOverride, count, disable, enable, freshId, override, rows, setRole, splitStatements, staffPerson } from "./staff-messages";
export type { AgencyRole, Person } from "./staff-messages";

/** Switches staff workload on or off the way a Super Admin does (a row in org_features on the agency workspace; no row means off). */
export async function setWorkload(on: boolean | null): Promise<void> {
  const org = await agencyOrgId();
  await withSystem(async (db) => {
    if (on === null) await db.query("delete from org_features where org_id = $1 and feature = $2", [org, STAFF_WORKLOAD_FEATURE]);
    else await db.query("insert into org_features (org_id, feature, enabled) values ($1, $2, $3) on conflict (org_id, feature) do update set enabled = excluded.enabled", [org, STAFF_WORKLOAD_FEATURE, on]);
  });
}

/** Sets the agency workspace's time zone (the days of the workload are days there). */
export async function setAgencyTimeZone(zone: string): Promise<void> {
  await withSystem((db) => db.query("update organizations set timezone = $1 where kind = 'agency'", [zone]));
}

export interface WorkloadWorld {
  agencyId: string;
  superAdmin: Person;
  manager: Person;
  staff: Person;
  staff2: Person;
  staff3: Person;
  /** staff and staff2 are assigned to this client; staff3 is not. */
  clientA: { id: string; name: string };
  /** staff3 is assigned to this client; staff and staff2 are not. */
  clientB: { id: string; name: string };
}

/** The agency workspace with the module switched on, a Super Admin, a manager and three staff members, and two clients. */
export async function workloadWorld(): Promise<WorkloadWorld> {
  const agencyId = await agencyOrgId();
  await setWorkload(true);
  const superAdmin = await staffPerson("agency_super_admin");
  const manager = await staffPerson("agency_manager");
  const staff = await staffPerson("agency_staff");
  const staff2 = await staffPerson("agency_staff");
  const staff3 = await staffPerson("agency_staff");
  const clientA = await createOrg({ name: "Workload Client A" });
  const clientB = await createOrg({ name: "Workload Client B" });
  await withSystem(async (db) => {
    for (const s of [staff, staff2]) await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [clientA.id, s.id, superAdmin.id]);
    await db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [clientB.id, staff3.id, superAdmin.id]);
  });
  return { agencyId, superAdmin, manager, staff, staff2, staff3, clientA: { id: clientA.id, name: clientA.name }, clientB: { id: clientB.id, name: clientB.name } };
}

/** Gives a staff member the manager-style reach over every client, or only their assigned ones. */
export async function setScope(userId: string, mode: "all_clients" | "assigned_clients"): Promise<void> {
  await withSystem((db) =>
    db.query("insert into agency_user_client_scopes (user_id, scope_mode) values ($1, $2) on conflict (user_id) do update set scope_mode = excluded.scope_mode", [userId, mode]),
  );
}

export async function assignClient(orgId: string, userId: string): Promise<void> {
  await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2) on conflict do nothing", [orgId, userId]));
}

export async function unassignClient(orgId: string, userId: string): Promise<void> {
  await withSystem((db) => db.query("delete from staff_assignments where org_id = $1 and user_id = $2", [orgId, userId]));
}

// ---------------------------------------------------------------------------
// Work items
// ---------------------------------------------------------------------------

let counter = 0;
const next = () => (counter += 1);

export interface TicketSpec {
  assignedTo?: string | null;
  priority?: "low" | "normal" | "high" | "urgent";
  status?: "new" | "open" | "in_progress" | "waiting_for_client" | "resolved" | "closed";
  category?: string;
  subject?: string;
  /** A response target moment, as support records it while response targets are on. */
  dueAt?: string | null;
  escalated?: boolean;
}

export async function makeTicket(orgId: string, spec: TicketSpec = {}): Promise<string> {
  return withSystem(async (db) => {
    const id = (await db.query<{ id: string }>(
      "insert into support_tickets (org_id, subject, category, priority, status, assigned_to) values ($1, $2, $3, $4, $5, $6) returning id",
      [orgId, spec.subject ?? `Workload ticket ${next()}`, spec.category ?? "general", spec.priority ?? "normal", spec.status ?? "open", spec.assignedTo ?? null],
    )).rows[0].id;
    if (spec.dueAt !== undefined || spec.escalated) {
      await db.query(
        "insert into support_ticket_ops (ticket_id, org_id, response_due_at, escalated_at, escalated_by, escalation_reason) values ($1, $2, $3::timestamptz, $4, null, $5)",
        [id, orgId, spec.dueAt ?? null, spec.escalated ? new Date().toISOString() : null, spec.escalated ? "Seed escalation" : null],
      );
    }
    return id;
  });
}

export interface SetupTaskSpec {
  assignedTo?: string | null;
  status?: "pending" | "in_progress" | "waiting_for_client" | "ready_for_review" | "completed" | "blocked";
  required?: boolean;
  section?: "agency" | "client";
  /** A day, YYYY-MM-DD. */
  estimate?: string | null;
  hidden?: boolean;
  serviceExcluded?: boolean;
  title?: string;
  service?: string | null;
}

/** The client's checklist, with no template tasks: only the tasks a test writes exist. Made once for each client. */
export async function setupInstance(orgId: string, state: "in_setup" | "ready_for_review" | "activated" = "in_setup"): Promise<string> {
  return withSystem(async (db) => {
    const found = (await db.query<{ id: string }>("select id from client_setup_instances where org_id = $1", [orgId])).rows[0];
    if (found) {
      await db.query("update client_setup_instances set state = $2, activated_at = case when $2 = 'activated' then coalesce(activated_at, now()) else null end, ready_for_review_at = case when $2 = 'in_setup' then null else coalesce(ready_for_review_at, now()) end where id = $1", [found.id, state]);
      return found.id;
    }
    return (await db.query<{ id: string }>(
      "insert into client_setup_instances (org_id, state, activated_at, ready_for_review_at) values ($1, $2, case when $2 = 'activated' then now() end, case when $2 <> 'in_setup' then now() end) returning id", [orgId, state],
    )).rows[0].id;
  });
}

export async function makeSetupTask(orgId: string, spec: SetupTaskSpec = {}): Promise<string> {
  const instance = await setupInstance(orgId);
  const status = spec.status ?? "pending";
  return withSystem(async (db) =>
    (await db.query<{ id: string }>(
      `insert into client_setup_tasks (org_id, instance_id, title, section, status, required, hidden, service_excluded, assigned_to, estimated_completion_at, service, sort_order,
         blocked_reason, completed_at, completion_source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::date, $11, $12, $13, $14, $15) returning id`,
      [
        orgId, instance, spec.title ?? `Workload step ${next()}`, spec.section ?? "agency", status, spec.required ?? true, spec.hidden ?? false, spec.serviceExcluded ?? false, spec.assignedTo ?? null,
        spec.estimate ?? null, spec.service ?? null, next(), status === "blocked" ? "Seed reason" : null, status === "completed" ? new Date().toISOString() : null, status === "completed" ? "agency" : null,
      ],
    )).rows[0].id,
  );
}

export interface ProjectSpec {
  assignedTo?: string | null;
  status?: string;
  title?: string;
  /** client_projects.expected_completion_on, a day. Makes an agreed project row. */
  expectedOn?: string | null;
  /** Due times of open review tasks (an ISO moment each). */
  reviewDueAts?: string[];
  milestones?: Array<{ title?: string; status?: string; dueOn?: string | null }>;
  lastActivityAt?: string;
}

export async function makeProject(orgId: string, spec: ProjectSpec = {}): Promise<string> {
  return withSystem(async (db) => {
    const id = (await db.query<{ id: string }>(
      "insert into client_project_requests (org_id, title, summary, status, assigned_to, last_activity_at) values ($1, $2, 'Seed', $3, $4, coalesce($5::timestamptz, now())) returning id",
      [orgId, spec.title ?? `Workload project ${next()}`, spec.status ?? "in_development", spec.assignedTo ?? null, spec.lastActivityAt ?? null],
    )).rows[0].id;
    if (spec.expectedOn !== undefined) {
      await db.query("insert into client_projects (request_id, org_id, agreed_price_cents, expected_completion_on) values ($1, $2, 100000, $3::date)", [id, orgId, spec.expectedOn]);
    }
    for (const due of spec.reviewDueAts ?? []) {
      await db.query("insert into project_review_tasks (request_id, org_id, kind, title, due_at) values ($1, $2, 'initial_review', 'Seed review', $3::timestamptz)", [id, orgId, due]);
    }
    for (const m of spec.milestones ?? []) {
      await db.query(
        "insert into project_milestones (request_id, org_id, title, status, due_on, sort_order) values ($1, $2, $3, $4, $5::date, $6)",
        [id, orgId, m.title ?? `Milestone ${next()}`, m.status ?? "pending", m.dueOn ?? null, next()],
      );
    }
    return id;
  });
}

export interface MaintenanceSpec {
  assignedTo?: string | null;
  status?: "open" | "in_progress" | "waiting_for_client" | "completed" | "declined";
  title?: string;
  /** A support request that mirrors it (the product always makes one). */
  ticketId?: string | null;
}

export async function makeMaintenance(orgId: string, spec: MaintenanceSpec = {}): Promise<string> {
  return withSystem(async (db) =>
    (await db.query<{ id: string }>(
      "insert into maintenance_requests (org_id, kind, title, description, status, assigned_to, ticket_id, closed_at) values ($1, 'core_defect', $2, 'Seed description', $3, $4, $5, case when $3 in ('completed', 'declined') then now() end) returning id",
      [orgId, spec.title ?? `Workload maintenance ${next()}`, spec.status ?? "open", spec.assignedTo ?? null, spec.ticketId ?? null],
    )).rows[0].id,
  );
}

export const agencyRoleOf = (role: AgencyRole) => role;

/** Closes whatever a test left open for these people, so the next test counts only its own rows. */
export async function clearWork(...orgIds: string[]): Promise<void> {
  await withSystem(async (db) => {
    await db.query("delete from maintenance_requests where org_id = any($1::uuid[])", [orgIds]);
    await db.query("delete from client_setup_tasks where org_id = any($1::uuid[])", [orgIds]);
    await db.query("delete from client_projects where org_id = any($1::uuid[])", [orgIds]);
    await db.query("delete from client_project_requests where org_id = any($1::uuid[])", [orgIds]);
    await db.query("delete from support_tickets where org_id = any($1::uuid[])", [orgIds]);
  });
}
