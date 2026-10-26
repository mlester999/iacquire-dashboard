// The six AI employees, checked as a set rather than one screen at a time: the registry and identities agree with each other, every reviewed capability has a real handler and
// completes for the role that owns it (reading the database, with no model), no role can run another's work, and a workspace a purchase just created starts with all six employees
// NOT working. The deterministic reviews here are the only employee behaviour that needs no Hermes; chat, customer replies and lead research need a live profile and are verified
// elsewhere against a simulated one (and never claimed live). Embedded Postgres; nothing is sent.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, AGENT_ROLES, SETUP_REQUIRED_LABEL, canChat, type AgentRoleKey } from "@/lib/agents";
import { CAPABILITY_KEYS, WORKFORCE_CAPABILITIES, capabilitiesForRole, roleMayUseCapability, type CapabilityKey } from "@/lib/workforce-capabilities";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { createConfigVersion, suggestedProfileName } from "@/server/workforce/service";
import { defaultSettings } from "@/server/workforce/compiler";
import { dispatchCapabilityJob } from "@/server/workforce/capability-dispatch";
import { runWorkJob } from "@/server/workforce/work-runner";
import { createPurchaseIntent, provisionPurchaseIntent, startPurchase, verifyPurchasePayment } from "@/server/purchase-intents/service";
import { addMember, agentId, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import { agencyOrgId, staffPerson } from "./support/staff-messages";

/** Capabilities that are not read-only reviews: they prepare something a person must approve. Nothing here sends, books or changes a record by itself. */
const APPROVAL_REQUIRED: readonly CapabilityKey[] = ["pipeline_followup_drafts"];

let org: Awaited<ReturnType<typeof createOrg>>;
let owner: { id: string; email: string };
let viewer: { id: string; email: string };
const ctx = (who: "owner" | "viewer" = "owner") => ctxFor(who === "owner" ? owner : viewer, org, who);

const jobRow = async (id: string) => (await withSystem((db) => db.query<{ status: string; failure_code: string | null; failure_message: string | null; result: Record<string, unknown>; result_summary: string | null }>(
  "select status, failure_code, failure_message, result, result_summary from ai_work_jobs where id = $1", [id]))).rows[0];

beforeAll(async () => {
  org = await createOrg({ name: "Six Employees Co" });
  owner = await createUser();
  viewer = await createUser();
  await addMember(org.id, owner.id, "owner");
  await addMember(org.id, viewer.id, "viewer");
  for (const role of AGENT_ROLE_KEYS) {
    const id = await agentId(org.id, role);
    await withSystem((db) => createConfigVersion(db, { orgId: org.id, agentId: id, settings: defaultSettings(role), source: "onboarding", userId: owner.id, apply: true }));
  }
  await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, last_health_check_at = now() where org_id = $1", [org.id]));
}, 60000);

describe("the registry and the identities agree", () => {
  it("has exactly six roles with distinct names, slugs and fixed agency profile ids, and every capability belongs to a real role", () => {
    expect(AGENT_ROLE_KEYS).toHaveLength(6);
    expect(AGENT_ROLES.map((r) => r.key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    for (const field of ["name", "slug", "shortName", "mascot"] as const) expect(new Set(AGENT_ROLES.map((r) => r[field])).size, field).toBe(6);
    expect(new Set(Object.values(AGENCY_HERMES_PROFILE_IDS)).size).toBe(6);
    for (const id of Object.values(AGENCY_HERMES_PROFILE_IDS)) expect(id).toMatch(/^iacquire-[a-z-]+$/);
    for (const key of CAPABILITY_KEYS) {
      const def = WORKFORCE_CAPABILITIES[key];
      expect(def.allowedRoles.length, key).toBeGreaterThan(0);
      for (const role of def.allowedRoles) expect(AGENT_ROLE_KEYS, `${key} -> ${role}`).toContain(role);
      // Read-only reviews, plus the one capability that prepares drafts (never sent) for a person to approve.
      expect(def.risk, key).toBe(APPROVAL_REQUIRED.includes(key) ? "approval_required" : "read_only");
    }
    // Every role owns something it can really do.
    for (const role of AGENT_ROLE_KEYS) expect(capabilitiesForRole(role).length >= 1 || role === "operations_manager", role).toBe(true);
  });

  it("gives a client's profile a name that can never be an agency employee's, and different for every workspace and role", () => {
    const names = new Set<string>();
    for (const slug of ["harbor-home-services", "brightside-roofing", "a"]) {
      for (const role of AGENT_ROLE_KEYS) {
        const name = suggestedProfileName(slug, role);
        expect(name).toMatch(/^c-[a-z0-9-]+$/);
        expect(name.length).toBeLessThanOrEqual(63);
        expect(Object.values(AGENCY_HERMES_PROFILE_IDS)).not.toContain(name);
        expect(name.startsWith("iacquire-")).toBe(false);
        names.add(name);
      }
    }
    expect(names.size).toBe(18);
  });

  it("never reads 'Ready' for an employee that is switched on but has no verified connection", () => {
    for (const status of ["setup_required", "provisioning", "offline", "error", "disabled"] as const) {
      expect(canChat(status), status).toBe(false);
      const r = deriveEmployeeReadiness({ enabled: status !== "disabled", status, configVersion: null, lastHealthCheckAt: null, lastHealthOk: null, inventoryDigest: null });
      expect(r.chatAvailable, status).toBe(false);
      expect(r.stage, status).not.toBe("ready");
    }
    expect(SETUP_REQUIRED_LABEL).toBe("Setup required");
  });
});

describe("every reviewed capability has a real handler and completes for its own role", () => {
  const deterministic = CAPABILITY_KEYS.filter((k) => k !== "lead_research");

  for (const capability of deterministic) {
    it(`${capability}: runs for ${WORKFORCE_CAPABILITIES[capability].allowedRoles.join(", ")}, reads the database and finishes with a stated result`, async () => {
      const role = WORKFORCE_CAPABILITIES[capability].allowedRoles[0];
      const dispatched = await dispatchCapabilityJob(ctx(), { agentRole: role, capability, title: `Conformance: ${capability}`, deferKick: true });
      expect((await jobRow(dispatched.jobId)).status).toBe("queued");
      await runWorkJob(dispatched.jobId);
      const done = await jobRow(dispatched.jobId);
      expect(done.failure_code, `${capability}: ${done.failure_message}`).not.toBe("capability_unavailable");
      expect(done.status, `${capability}: ${done.failure_code} ${done.failure_message}`).toBe("completed");
      // An honest result: a sentence about what was read, not an empty success.
      expect((done.result_summary ?? "").trim().length, capability).toBeGreaterThan(10);
    }, 30000);
  }

  it("lead_research has a handler too: without a live profile it stops with a reason of its own, never as an unregistered capability", async () => {
    const dispatched = await dispatchCapabilityJob(ctx(), { agentRole: "lead_hunter", capability: "lead_research", title: "Conformance: lead research", deferKick: true });
    await runWorkJob(dispatched.jobId);
    const done = await jobRow(dispatched.jobId);
    expect(done.failure_code).not.toBe("capability_unavailable");
    expect(["failed", "blocked", "completed"]).toContain(done.status);
    if (done.status !== "completed") expect((done.failure_message ?? "").length).toBeGreaterThan(10);
  }, 30000);
});

describe("no employee runs another's work, and nobody runs work they may not start", () => {
  it("refuses every capability for every role that does not own it", async () => {
    let refused = 0;
    for (const role of AGENT_ROLE_KEYS) {
      for (const capability of CAPABILITY_KEYS) {
        if (roleMayUseCapability(role, capability)) continue;
        await expect(dispatchCapabilityJob(ctx(), { agentRole: role, capability: capability as CapabilityKey, title: "Cross-role", deferKick: true }), `${role} / ${capability}`).rejects.toMatchObject({ code: "forbidden" });
        refused += 1;
      }
    }
    // Every role times every capability, minus the pairs that are allowed.
    expect(refused).toBe(AGENT_ROLE_KEYS.length * CAPABILITY_KEYS.length - CAPABILITY_KEYS.reduce((n, k) => n + WORKFORCE_CAPABILITIES[k].allowedRoles.length, 0));
  });

  it("refuses a viewer, who may not start AI work at all", async () => {
    await expect(dispatchCapabilityJob(ctx("viewer"), { agentRole: "crm_manager", capability: "crm_quality_review", title: "Viewer", deferKick: true })).rejects.toMatchObject({ code: "forbidden" });
  });

  it("refuses an employee that is switched off or not connected, with its own reason", async () => {
    const id = await agentId(org.id, "performance_analyst");
    await withSystem((db) => db.query("update agent_instances set enabled = false where id = $1", [id]));
    await expect(dispatchCapabilityJob(ctx(), { agentRole: "performance_analyst", capability: "performance_snapshot", title: "Off", deferKick: true })).rejects.toMatchObject({ code: "agent_unavailable" });
    await withSystem((db) => db.query("update agent_instances set enabled = true, status = 'setup_required' where id = $1", [id]));
    await expect(dispatchCapabilityJob(ctx(), { agentRole: "performance_analyst", capability: "performance_snapshot", title: "Setup", deferKick: true })).rejects.toMatchObject({ code: "agent_unavailable" });
    await withSystem((db) => db.query("update agent_instances set status = 'online' where id = $1", [id]));
  });
});

describe("a workspace a purchase creates starts with all six employees not working", () => {
  it("creates six employees in 'Setup required', none online, none able to chat, and no job can be dispatched to them", async () => {
    await agencyOrgId(); // the agency workspace a purchase belongs to (the database allows exactly one)
    const superAdmin = agencyUser(await staffPerson("agency_super_admin"), "agency_super_admin");
    const email = `buyer-${crypto.randomUUID().slice(0, 8)}@example.test`;
    const created = await createPurchaseIntent(superAdmin, { buyerName: "Pat Buyer", buyerEmail: email, company: `Pending Co ${crypto.randomUUID().slice(0, 6)}`, industry: "Home services", website: "https://pending.example.test", timezone: "America/Chicago", maintenanceSelected: false, autoProvision: false }, { now: new Date() });
    await startPurchase(created.token, { now: new Date() });
    await verifyPurchasePayment(superAdmin, created.id, { amount: "1499.00", method: "bank_transfer", externalReference: `BANK-${crypto.randomUUID().slice(0, 8)}`, paidOn: new Date().toISOString().slice(0, 10), note: "Saw the transfer on the statement." }, { now: new Date() });
    const made = await provisionPurchaseIntent(superAdmin, created.id, { now: new Date() });
    expect(made.clientOrgId).toBeTruthy();
    const agents = await withSystem((db) => db.query<{ role_key: AgentRoleKey; status: string; enabled: boolean; last_health_ok: boolean | null; active_config_version_id: string | null; credential_id: string | null }>(
      "select role_key, status, enabled, last_health_ok, active_config_version_id, credential_id from agent_instances where org_id = $1 order by role_key", [made.clientOrgId]));
    expect(agents.rows.map((a) => a.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    for (const a of agents.rows) {
      expect(a.status, a.role_key).toBe("setup_required");
      expect(canChat(a.status as never), a.role_key).toBe(false);
      expect(a.last_health_ok, a.role_key).not.toBe(true);
      expect(a.credential_id, `${a.role_key} must not have a credential before anyone connects a profile`).toBeNull();
      const r = deriveEmployeeReadiness({ enabled: a.enabled, status: a.status as never, configVersion: null, lastHealthCheckAt: null, lastHealthOk: a.last_health_ok, inventoryDigest: null });
      expect(r.stage, a.role_key).not.toBe("ready");
      expect(r.chatAvailable, a.role_key).toBe(false);
    }
    // Once the buyer accepts the invitation and is the workspace's owner, they still cannot start work for an employee that has not been set up, whatever the role.
    const target = (await withSystem((db) => db.query<{ id: string; name: string; slug: string }>("select id, name, slug from organizations where id = $1", [made.clientOrgId]))).rows[0];
    const buyer = await createUser();
    await addMember(target.id, buyer.id, "owner");
    for (const role of AGENT_ROLE_KEYS) {
      const capability = capabilitiesForRole(role)[0]?.key ?? "proactive_review";
      await expect(dispatchCapabilityJob(ctxFor(buyer, target, "owner"), { agentRole: role, capability, title: "Too early", deferKick: true }), role).rejects.toMatchObject({ code: "agent_unavailable" });
    }
    expect(await withSystem((db) => db.query("select 1 from ai_work_jobs where org_id = $1", [target.id]))).toMatchObject({ rows: [] });
  });
});
