// A fleet synchronization: the agency asks the restricted worker to bring every provisioned client employee's profile in line with its applied configuration again (for example after the
// worker or the runtime was updated). One job per enabled employee whose profile the restricted worker made on the pinned gateway, bounded per call, safe to repeat, audited per employee
// in its own workspace and once on the agency, and never for an agency's or a demo's employee. Synthetic workspaces only; nothing here talks to Hermes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { FLEET_SYNC_MAX_EMPLOYEES, requestFleetSync } from "@/server/workforce/provisioning";
import { agencyPeople } from "./support/crm";
import { createOrg } from "./support/fixtures";
import { provisionedClient, sharedGateway, type ClientTenant } from "./support/client-business-mcp";

let gateway: { id: string; baseUrl: string };
let superAdmin: { id: string };
let counter = 0;

const rows = async <T>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const sync = (reason = "The runtime was updated, so every profile is brought up to date.", opts?: { limit?: number }, actor = superAdmin.id, gatewayId = gateway.id) =>
  withSystem((db) => requestFleetSync(db, gatewayId, actor, reason, opts));

/** A client whose six employees are in the state a finished provisioning leaves: an applied configuration, a profile on the gateway, and the provisioning job that made it. */
async function tenant(): Promise<ClientTenant> {
  counter += 1;
  const t = await provisionedClient({ name: `Fleet Client ${counter}`, timezone: "America/Chicago", tag: `Fleeter${counter}`, phone: `+1312555${String(4000 + counter)}`, crm: false });
  for (const role of AGENT_ROLE_KEYS) {
    await withSystem(async (db) => {
      await db.query("update agent_instances set hermes_profile_config_version_id = active_config_version_id where id = $1", [t.agents[role]]);
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, result_reference) values ($1, $2, 'provision', 'succeeded', 'provisioner:v1:fixture')", [t.org.id, t.agents[role]]);
    });
  }
  return t;
}
const syncJobs = (orgId: string) => rows<{ kind: string; status: string; requested_by: string | null; source_job_id: string | null }>(
  "select kind, status, requested_by, source_job_id from agent_provisioning_jobs where org_id = $1 and kind = 'sync'", [orgId]);

beforeAll(async () => {
  gateway = await sharedGateway();
  superAdmin = (await agencyPeople()).superAdmin;
  // The database allows one agency workspace; the summary row of a synchronization is written on it.
  if (!(await rows("select 1 from organizations where kind = 'agency'")).length) await createOrg({ name: "Agency Fleet Sync Test", kind: "agency" });
});
beforeEach(() => {
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gateway.id);
  resetEnvCache();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'cancelled', lease_token = null, lease_expires_at = null where kind = 'sync' and status in ('requested', 'in_progress', 'failed', 'awaiting_health_check')"));
});

describe("asking for a fleet synchronization", () => {
  it("opens one synchronization job per provisioned employee and audits each in its own workspace and once on the agency", async () => {
    const t = await tenant();
    const result = await sync("The runtime was updated.");
    const mine = result.queued.filter((q) => q.orgId === t.org.id);
    expect(mine).toHaveLength(6);
    expect(new Set(mine.map((q) => q.agentId))).toEqual(new Set(Object.values(t.agents)));
    const jobs = await syncJobs(t.org.id);
    expect(jobs).toHaveLength(6);
    expect(jobs.every((j) => j.status === "requested" && j.requested_by === superAdmin.id && j.source_job_id)).toBe(true);
    const audit = await rows<{ agent_instance_id: string; metadata: { gatewayId: string; reason: string } }>("select agent_instance_id, metadata from audit_logs where org_id = $1 and action = 'agent.fleet_sync_requested'", [t.org.id]);
    expect(audit).toHaveLength(6);
    expect(audit.every((a) => a.metadata.gatewayId === gateway.id && a.metadata.reason === "The runtime was updated.")).toBe(true);
    const summary = await rows<{ metadata: { queued: number; reason: string; truncated: boolean } }>("select a.metadata from audit_logs a join organizations o on o.id = a.org_id where o.kind = 'agency' and a.action = 'agent.fleet_sync_summary' order by a.created_at desc limit 1");
    expect(summary[0].metadata).toMatchObject({ queued: result.queued.length, reason: "The runtime was updated.", truncated: false });
  });

  it("is safe to repeat: an employee with a request already open is counted, never asked twice", async () => {
    const t = await tenant();
    const first = await sync();
    const second = await sync();
    expect(second.queued).toHaveLength(0);
    expect(second.alreadyOpen).toBe(first.queued.length);
    expect(await syncJobs(t.org.id)).toHaveLength(6);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'agent.fleet_sync_requested'", [t.org.id])).toHaveLength(6);
  });

  it("is bounded: a call takes no more than its limit, says there is more, and the next call covers the rest", async () => {
    await tenant();
    await tenant();
    expect(FLEET_SYNC_MAX_EMPLOYEES).toBe(200);
    const first = await sync(undefined, { limit: 5 });
    expect(first.queued).toHaveLength(5);
    expect(first.truncated).toBe(true);
    const second = await sync(undefined, { limit: 5 });
    expect(second.queued.length).toBeGreaterThan(0);
    // A caller can ask for fewer than the bound but never more.
    const capped = await sync(undefined, { limit: 100_000 });
    expect(capped.queued.length + capped.alreadyOpen + capped.skipped).toBeLessThanOrEqual(FLEET_SYNC_MAX_EMPLOYEES);
  });

  it("leaves out a demo workspace, a workspace that is not active, and an employee that is switched off", async () => {
    const live = await tenant();
    const demo = await tenant();
    const suspended = await tenant();
    await withSystem(async (db) => {
      await db.query("update organizations set is_demo = true where id = $1", [demo.org.id]);
      await db.query("update organizations set status = 'suspended' where id = $1", [suspended.org.id]);
      await db.query("update agent_instances set enabled = false where id = $1", [live.agents.crm_manager]);
    });
    const result = await sync();
    expect(result.queued.filter((q) => q.orgId === live.org.id)).toHaveLength(5);
    expect(await syncJobs(demo.org.id)).toHaveLength(0);
    expect(await syncJobs(suspended.org.id)).toHaveLength(0);
  });

  it("refuses without a reason, for someone who is not on the agency's staff, and for another gateway, and writes nothing", async () => {
    const t = await tenant();
    await expect(sync("no")).rejects.toMatchObject({ code: "invalid_input" });
    await expect(sync(undefined, undefined, t.owner.id)).rejects.toMatchObject({ code: "forbidden" });
    await expect(sync(undefined, undefined, superAdmin.id, crypto.randomUUID())).rejects.toMatchObject({ code: "forbidden" });
    await expect(sync(undefined, undefined, "not-an-id")).rejects.toMatchObject({ code: "invalid_input" });
    expect(await syncJobs(t.org.id)).toHaveLength(0);
    expect(await rows("select 1 from audit_logs where org_id = $1 and action = 'agent.fleet_sync_requested'", [t.org.id])).toHaveLength(0);
  });
});
