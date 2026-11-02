// The server actions behind the agency's runtime controls. The page may hide a button, but the server decides: a person who is not a Super Admin is refused and nothing is written, a control
// whose deployment switch is off refuses even when called directly, an agency's or a demo's workspace is refused and nothing is written, every action needs a reason, and a press that
// goes through leaves exactly one audit row. Synthetic workspaces only; nothing here talks to Hermes.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import type { SessionUser } from "@/server/auth/service";
import { agencyPeople } from "./support/crm";
import { createOrg } from "./support/fixtures";
import { provisionedClient, sharedGateway, type ClientTenant } from "./support/client-business-mcp";

const state = vi.hoisted(() => ({ user: null as null | SessionUser, revalidated: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => state.revalidated.push(path) }));
vi.mock("@/server/auth/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/auth/session")>();
  const { AppError } = await import("@/server/errors");
  const need = () => {
    if (!state.user) throw new AppError("unauthenticated", "Sign in to continue.");
    return state.user;
  };
  return { ...actual, requireUserOrThrow: async () => need(), requireFreshUserOrThrow: async () => need() };
});
vi.mock("@/server/tenancy/context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/tenancy/context")>();
  const { AppError } = await import("@/server/errors");
  return {
    ...actual,
    requireAgencyOrThrow: async (level: "staff" | "super_admin" = "staff") => {
      if (!state.user) throw new AppError("unauthenticated", "Sign in to continue.");
      if (level === "super_admin" && state.user.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Agency access is required.");
      return state.user;
    },
  };
});

import { requestDeprovisionAction, requestFleetSyncAction } from "@/app/(admin)/admin/provisioning-actions";
import { setClientBusinessToolsAction } from "@/app/actions/client-business-access";

let gateway: { id: string; baseUrl: string };
let superAdmin: SessionUser;
let staff: SessionUser;
let counter = 0;

const rows = async <T>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;
const flags = (on: { deprovision?: boolean; provisioner?: boolean; tools?: boolean }) => {
  vi.stubEnv("HERMES_PROVISIONER_GATEWAY_ID", gateway.id);
  // The schema wants a token of 32 characters whenever the provisioner is enabled; this one opens nothing (no worker runs here).
  vi.stubEnv("HERMES_PROVISIONER_TOKEN", "t".repeat(40));
  vi.stubEnv("HERMES_PROVISIONER_DEPROVISION_ENABLED", on.deprovision ? "true" : "false");
  vi.stubEnv("HERMES_PROVISIONER_ENABLED", on.provisioner ? "true" : "false");
  vi.stubEnv("HERMES_CLIENT_BUSINESS_MCP_ENABLED", on.tools ? "true" : "false");
  resetEnvCache();
};
async function tenant(): Promise<ClientTenant> {
  counter += 1;
  return provisionedClient({ name: `Controls Client ${counter}`, timezone: "America/Chicago", tag: `Controller${counter}`, phone: `+1312555${String(5000 + counter)}`, crm: false });
}
const jobs = (orgId: string) => rows<{ kind: string; status: string }>("select kind, status from agent_provisioning_jobs where org_id = $1 and kind in ('deprovision', 'sync') order by created_at", [orgId]);
const audits = (orgId: string, action: string) => rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = $2", [orgId, action]);

beforeAll(async () => {
  gateway = await sharedGateway();
  const people = await agencyPeople();
  superAdmin = people.superAdmin;
  staff = people.staff;
  if (!(await rows("select 1 from organizations where kind = 'agency'")).length) await createOrg({ name: "Agency Controls Test", kind: "agency" });
});
beforeEach(() => {
  state.user = superAdmin;
  state.revalidated.length = 0;
  flags({ deprovision: true, provisioner: true, tools: true });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  resetEnvCache();
  await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'cancelled', lease_token = null, lease_expires_at = null where kind in ('deprovision', 'sync') and status in ('requested', 'in_progress', 'failed', 'awaiting_health_check')"));
});

describe("containing one employee's runtime profile", () => {
  it("goes through for a Super Admin with a reason, leaves exactly one audit row, and a second press says the request was already open", async () => {
    const t = await tenant();
    const first = await requestDeprovisionAction(t.org.id, t.agents.lead_hunter, "The client left the programme.");
    expect(first).toMatchObject({ ok: true, data: { alreadyOpen: false, replaced: 0 } });
    expect(await jobs(t.org.id)).toEqual([{ kind: "deprovision", status: "requested" }]);
    expect(await audits(t.org.id, "agent.profile_deprovision_requested")).toHaveLength(1);
    expect(state.revalidated).toContain(`/admin/clients/${t.org.id}`);
    const second = await requestDeprovisionAction(t.org.id, t.agents.lead_hunter, "Pressed again by mistake.");
    expect(second).toMatchObject({ ok: true, data: { alreadyOpen: true } });
    expect(await jobs(t.org.id)).toHaveLength(1);
    expect(await audits(t.org.id, "agent.profile_deprovision_requested")).toHaveLength(1);
  });

  it("refuses a person who is not a Super Admin, and writes nothing", async () => {
    const t = await tenant();
    state.user = staff;
    expect(await requestDeprovisionAction(t.org.id, t.agents.lead_hunter, "A staff member trying it.")).toMatchObject({ ok: false, code: "forbidden" });
    expect(await jobs(t.org.id)).toHaveLength(0);
    expect(await audits(t.org.id, "agent.profile_deprovision_requested")).toHaveLength(0);
  });

  it("refuses when containment is turned off in the deployment, even though it is called directly, and writes nothing", async () => {
    const t = await tenant();
    flags({ deprovision: false, provisioner: true, tools: true });
    expect(await requestDeprovisionAction(t.org.id, t.agents.lead_hunter, "The switch is off.")).toMatchObject({ ok: false, error: expect.stringMatching(/turned off in this deployment/i) });
    expect(await jobs(t.org.id)).toHaveLength(0);
    expect(await audits(t.org.id, "agent.profile_deprovision_requested")).toHaveLength(0);
  });

  it("needs a reason of five characters, and writes nothing without one", async () => {
    const t = await tenant();
    expect(await requestDeprovisionAction(t.org.id, t.agents.lead_hunter, "no")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await requestDeprovisionAction(t.org.id, t.agents.lead_hunter, "     ")).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await jobs(t.org.id)).toHaveLength(0);
  });

  it("refuses a demo workspace and the agency's own employees, and writes nothing", async () => {
    const demo = await tenant();
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    expect(await requestDeprovisionAction(demo.org.id, demo.agents.lead_hunter, "A demo is never contained.")).toMatchObject({ ok: false, code: "conflict" });
    expect(await jobs(demo.org.id)).toHaveLength(0);
    const agency = (await rows<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0].id;
    const employee = (await rows<{ id: string }>("select id from agent_instances where org_id = $1 limit 1", [agency]))[0];
    expect(await requestDeprovisionAction(agency, employee.id, "The agency's own employee.")).toMatchObject({ ok: false });
    expect(await rows("select 1 from agent_provisioning_jobs where agent_instance_id = $1", [employee.id])).toHaveLength(0);
  });

  it("refuses ids that are not ids", async () => {
    expect(await requestDeprovisionAction("not-an-id", "also-not", "A reason that is long enough.")).toMatchObject({ ok: false });
  });
});

describe("synchronizing the client runtime", () => {
  it("opens one job per provisioned employee with a reason, audits each once, and says so when pressed again", async () => {
    const t = await tenant();
    for (const id of Object.values(t.agents)) {
      await withSystem(async (db) => {
        await db.query("update agent_instances set hermes_profile_config_version_id = active_config_version_id where id = $1", [id]);
        await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, result_reference) values ($1, $2, 'provision', 'succeeded', 'provisioner:v1:fixture')", [t.org.id, id]);
      });
    }
    const first = await requestFleetSyncAction("The runtime image was updated today.");
    expect(first).toMatchObject({ ok: true, data: { truncated: false } });
    if (!first.ok) throw new Error("expected the synchronization to go through");
    expect((first.data as { queued: Array<{ orgId: string }> }).queued.filter((q) => q.orgId === t.org.id)).toHaveLength(6);
    expect(await audits(t.org.id, "agent.fleet_sync_requested")).toHaveLength(6);
    const again = await requestFleetSyncAction("Pressed again by mistake.");
    expect(again).toMatchObject({ ok: true });
    expect(await audits(t.org.id, "agent.fleet_sync_requested")).toHaveLength(6);
  });

  it("refuses a person who is not a Super Admin, a missing reason, and a deployment where the provisioner is off, and writes nothing", async () => {
    const t = await tenant();
    state.user = staff;
    expect(await requestFleetSyncAction("A staff member trying it.")).toMatchObject({ ok: false, code: "forbidden" });
    state.user = superAdmin;
    expect(await requestFleetSyncAction("no")).toMatchObject({ ok: false, code: "invalid_input" });
    flags({ deprovision: true, provisioner: false, tools: true });
    expect(await requestFleetSyncAction("The provisioner is off.")).toMatchObject({ ok: false, error: expect.stringMatching(/not enabled in this deployment/i) });
    expect(await jobs(t.org.id)).toHaveLength(0);
    expect(await audits(t.org.id, "agent.fleet_sync_requested")).toHaveLength(0);
  });
});

describe("switching a workspace's business tools", () => {
  // The fixture's workspace is already in the tier (its tools switch is on), so the changes below are real ones.
  const tierOn = async (orgId: string) => (await rows<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = 'client_business_tools'", [orgId]))[0]?.enabled === true;
  const switchRows = (orgId: string) => rows<{ action: string; metadata: Record<string, unknown> }>("select action, metadata from audit_logs where org_id = $1 and action in ('feature.enabled', 'feature.disabled')", [orgId]);

  it("records the reason in the one audit row the switch writes", async () => {
    const t = await tenant();
    expect(await tierOn(t.org.id)).toBe(true);
    const result = await setClientBusinessToolsAction({ orgId: t.org.id, tools: false, reason: "Pausing tools while we review." });
    expect(result).toMatchObject({ ok: true, data: { changed: true } });
    expect(await tierOn(t.org.id)).toBe(false);
    const written = await switchRows(t.org.id);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({ action: "feature.disabled", metadata: { feature: "client_business_tools", reason: "Pausing tools while we review." } });
  });

  it("says nothing changed, and writes nothing, when the switch is already that way", async () => {
    const t = await tenant();
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: true, reason: "Already on, pressing again." })).toMatchObject({ ok: true, data: { changed: false, queued: 0 } });
    expect(await switchRows(t.org.id)).toHaveLength(0);
  });

  it("refuses a reason that is too short, and a person who is not a Super Admin, and changes nothing", async () => {
    const t = await tenant();
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: false, reason: "no" })).toMatchObject({ ok: false, code: "invalid_input" });
    state.user = staff;
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: false, reason: "A staff member trying it." })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await tierOn(t.org.id)).toBe(true);
    expect(await switchRows(t.org.id)).toHaveLength(0);
  });

  it("refuses a demo workspace and changes nothing", async () => {
    const demo = await tenant();
    await withSystem((db) => db.query("update organizations set is_demo = true where id = $1", [demo.org.id]));
    expect(await setClientBusinessToolsAction({ orgId: demo.org.id, tools: false, reason: "A demo is never in the tier." })).toMatchObject({ ok: false, code: "conflict" });
    expect(await tierOn(demo.org.id)).toBe(true);
    expect(await switchRows(demo.org.id)).toHaveLength(0);
  });
});
