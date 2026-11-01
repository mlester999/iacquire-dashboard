// The agency's client page for provisioning: the history of each setup request (the last five recorded steps), which request is the employee's newest, nothing from another workspace, and
// the requeue action behind the "Requeue with a reason" button. Real rows in the embedded database; only the session lookup is chosen by the test (the permission check itself still runs).
import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ admin: null as null | { id: string } }));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
// The actions resolve who is acting from the session; here the test chooses, and the agency permission query is the real one.
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { withSystem: system } = await import("@/server/db");
  const { AppError } = await import("@/server/errors");
  return {
    ...mod,
    requireAgencyOrgPermissionOrThrow: async (orgId: string, permission: import("@/lib/permissions").Permission) => {
      if (!h.admin) throw new Error("No agency person chosen for this test.");
      const { rows } = await system((db) => db.query<{ allowed: boolean }>("select app.user_can_access_org($1,$2) and app.user_has_agency_permission($1,$3) as allowed", [h.admin!.id, orgId, permission]));
      if (rows[0]?.allowed !== true) throw new AppError("forbidden", "Your role or client scope does not allow this action.");
      return h.admin;
    },
  };
});

import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { getTenantDetail } from "@/server/admin/queries";
import { requeueProvisioningAction } from "@/app/(admin)/admin/actions";
import { addMember, agencyUser, agentId, createOrg, createUser } from "./support/fixtures";
import { readyToRequeue, requeueAs } from "./support/requeue";

async function world(name: string, roles: string[] = ["lead_hunter"]) {
  const org = await createOrg({ name });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const ids: Record<string, string> = {};
  for (const role of roles) ids[role] = await agentId(org.id, role);
  return { org, owner, ids };
}

async function failedJob(w: { org: { id: string }; ids: Record<string, string> }, role: string): Promise<string> {
  return (await withSystem((db) => db.query<{ id: string }>(
    "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, attempt_count, detail) values ($1, $2, 'provision', 'failed', 3, 'Restricted Hermes profile setup failed (canary_failed). Review the isolated host result before retrying.') returning id",
    [w.org.id, w.ids[role]],
  ))).rows[0].id;
}

const step = (orgId: string, agentInstanceId: string, jobId: string, attempt: number, action = "agent.profile_provisioning_failed") =>
  recordAudit({ orgId, actorKind: "system", agentInstanceId, action, targetType: "agent_provisioning_job", targetId: jobId, result: "failure", metadata: { attempt, code: "canary_failed" } });

describe("the client page's provisioning history", () => {
  it("lists each request with its last five steps newest first, marks only the employee's newest request as the latest, and shows nothing of another workspace", async () => {
    const a = await world("History Co A", ["lead_hunter", "crm_manager"]);
    const b = await world("History Co B");
    const admin = await createUser({ platformRole: "agency_super_admin" });

    const first = await failedJob(a, "lead_hunter");
    for (let attempt = 1; attempt <= 7; attempt += 1) await step(a.org.id, a.ids.lead_hunter, first, attempt);
    const crm = await failedJob(a, "crm_manager");
    const theirs = await failedJob(b, "lead_hunter");
    for (let attempt = 1; attempt <= 3; attempt += 1) await step(b.org.id, b.ids.lead_hunter, theirs, attempt);
    // A row of another workspace that names this workspace's job: the history reads this workspace's audit rows only.
    await step(b.org.id, b.ids.lead_hunter, first, 99);

    const { adminId } = await readyToRequeue(a.org, a.owner.id, [a.ids.lead_hunter]);
    const second = await requeueAs(adminId, a.org.id, a.ids.lead_hunter);

    const detail = await getTenantDetail(agencyUser(admin, "agency_super_admin"), a.org.id);
    const jobs = detail.provisioning;
    expect(jobs.map((j) => j.id).sort()).toEqual([first, second.jobId, crm].sort());
    expect(jobs.map((j) => j.id)).not.toContain(theirs);
    const byId = new Map(jobs.map((j) => [j.id, j]));
    // Only the newest request of each employee is the latest: the failed one that the requeue replaced is not.
    expect(byId.get(first)?.is_latest).toBe(false);
    expect(byId.get(second.jobId)?.is_latest).toBe(true);
    expect(byId.get(crm)?.is_latest).toBe(true);
    // Five steps at most, newest first, none from the other workspace.
    const history = byId.get(first)!.history;
    expect(history).toHaveLength(5);
    expect(history.map((e) => e.attempt)).toEqual([7, 6, 5, 4, 3]);
    expect(history.every((e) => e.code === "canary_failed" && e.action === "agent.profile_provisioning_failed")).toBe(true);
    // The requeue is recorded on the new request.
    expect(byId.get(second.jobId)!.history.map((e) => e.action)).toEqual(["agent.provisioning_requeued"]);
    expect(byId.get(crm)!.history).toEqual([]);
  });

  it("reads a workspace that has no provisioning request at all as an empty list", async () => {
    const w = await world("History Empty Co");
    const admin = await createUser({ platformRole: "agency_super_admin" });
    expect((await getTenantDetail(agencyUser(admin, "agency_super_admin"), w.org.id)).provisioning).toEqual([]);
  });
});

describe("requeueProvisioningAction", () => {
  it("requeues for an agency person who may manage the workforce, records the reason once, and is refused for someone who may not or for an employee of another workspace", async () => {
    const a = await world("Action Co A");
    const b = await world("Action Co B");
    const failedA = await failedJob(a, "lead_hunter");
    await readyToRequeue(a.org, a.owner.id, [a.ids.lead_hunter]);
    await readyToRequeue(b.org, b.owner.id, [b.ids.lead_hunter]);

    // An agency staff member who is not assigned to the client cannot.
    const staff = await createUser({ platformRole: "agency_staff" });
    h.admin = { id: staff.id };
    const refused = await requeueProvisioningAction(a.org.id, a.ids.lead_hunter, "Host repaired after review");
    expect(refused).toMatchObject({ ok: false, code: "forbidden" });
    expect((await withSystem((db) => db.query("select 1 from agent_provisioning_jobs where org_id = $1", [a.org.id]))).rows).toHaveLength(1);

    const admin = await createUser({ platformRole: "agency_super_admin" });
    h.admin = { id: admin.id };
    // A reason is required, and an employee of another workspace is not found in this one.
    expect(await requeueProvisioningAction(a.org.id, a.ids.lead_hunter, "no")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await requeueProvisioningAction(a.org.id, b.ids.lead_hunter, "Host repaired after review")).toMatchObject({ ok: false, code: "not_found" });
    expect((await withSystem((db) => db.query("select 1 from agent_provisioning_jobs where org_id = $1", [b.org.id]))).rows).toHaveLength(0);

    expect(await requeueProvisioningAction(a.org.id, a.ids.lead_hunter, "Host repaired after review")).toEqual({ ok: true });
    const jobs = (await withSystem((db) => db.query<{ id: string; status: string }>("select id, status from agent_provisioning_jobs where org_id = $1 order by created_at, id", [a.org.id]))).rows;
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({ id: failedA, status: "failed" });
    expect(jobs[1].status).toBe("requested");
    expect((await withSystem((db) => db.query("select 1 from audit_logs where org_id = $1 and action = 'agent.provisioning_requeued'", [a.org.id]))).rows).toHaveLength(1);
    // A second click on the same button does not open a second request.
    expect(await requeueProvisioningAction(a.org.id, a.ids.lead_hunter, "Host repaired after review")).toMatchObject({ ok: false, code: "conflict" });
    h.admin = null;
  });
});
