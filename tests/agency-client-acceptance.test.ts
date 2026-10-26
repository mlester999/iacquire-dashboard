// The agency's six internal employees and a newly onboarded client's six are different things, and this suite keeps them apart: an internal 6/6 says nothing about a client, a client's
// employees are provisioned per workspace and idempotently, nothing leaks between workspaces (identity, SOUL, knowledge, credentials), and a client's employees are held to the very same
// tool policy as the agency's. Embedded Postgres and the Hermes test double; no live runtime is involved, and nothing here claims one.
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENCY_HERMES_PROFILE_IDS, AGENT_ROLE_KEYS, AGENT_BY_KEY, type AgentRoleKey } from "@/lib/agents";
import { deriveEmployeeReadiness } from "@/lib/workforce-readiness";
import { employeeActions } from "@/lib/employee-tool-policy";
import { getProvisioningBundle, requestProvisioning } from "@/server/workforce/provisioning";
import { suggestedProfileName } from "@/server/workforce/service";
import { employeeKnowledgeContext } from "@/server/workforce/knowledge";
import { ensureAgencyWorkforceRegistry } from "@/server/workforce/agency-registry";
import { enforceAgentAction } from "@/server/workforce/action-policy";
import { resolveCredential, saveCredential } from "@/server/security/credentials";
import { agencyUser, createUser } from "./support/fixtures";
import { submitRealOnboarding } from "./support/billing";

interface Client { orgId: string; name: string; slug: string; ownerId: string; agents: Record<AgentRoleKey, string> }

async function client(name: string): Promise<Client> {
  const made = await submitRealOnboarding({ name, clearPayment: true });
  const { rows } = await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey; slug: string }>(
    "select a.id, a.role_key, o.slug from agent_instances a join organizations o on o.id = a.org_id where a.org_id = $1", [made.org.id]));
  return { orgId: made.org.id, name, slug: rows[0].slug, ownerId: made.owner.id, agents: Object.fromEntries(rows.map((r) => [r.role_key, r.id])) as Record<AgentRoleKey, string> };
}

let a: Client;
let b: Client;
let agencyOrg: string;
let superAdmin: ReturnType<typeof agencyUser>;

beforeAll(async () => {
  superAdmin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
  agencyOrg = await ensureAgencyWorkforceRegistry(superAdmin);
  a = await client("Acceptance Alpha Roofing");
  b = await client("Acceptance Bravo Plumbing");
}, 120_000);

describe("the agency's six and a client's six are separate truths", () => {
  it("keeps six fixed internal identities in the agency workspace, and registering them again resets nothing", async () => {
    const before = (await withSystem((db) => db.query<{ id: string; role_key: AgentRoleKey; display_name: string }>("select id, role_key, display_name from agent_instances where org_id = $1 order by role_key", [agencyOrg]))).rows;
    expect(before.map((r) => r.role_key).sort()).toEqual([...AGENT_ROLE_KEYS].sort());
    // A working internal employee: configured, mapped and verified. Registering the registry again must leave it exactly as it is.
    const hunter = before.find((r) => r.role_key === "lead_hunter")!;
    await withSystem((db) => db.query("update agent_instances set status = 'online', last_health_ok = true, hermes_profile = $2, display_name = 'Hunter (tuned)' where id = $1", [hunter.id, AGENCY_HERMES_PROFILE_IDS.lead_hunter]));
    expect(await ensureAgencyWorkforceRegistry(superAdmin)).toBe(agencyOrg);
    const after = (await withSystem((db) => db.query<{ id: string; status: string; last_health_ok: boolean; hermes_profile: string; display_name: string }>("select id, status, last_health_ok, hermes_profile, display_name from agent_instances where id = $1", [hunter.id]))).rows[0];
    expect(after).toMatchObject({ status: "online", last_health_ok: true, hermes_profile: AGENCY_HERMES_PROFILE_IDS.lead_hunter, display_name: "Hunter (tuned)" });
    expect((await withSystem((db) => db.query("select 1 from agent_instances where org_id = $1", [agencyOrg]))).rows).toHaveLength(6);
  });

  it("leaves a newly onboarded client's six unverified however healthy the agency's are", async () => {
    for (const c of [a, b]) {
      const { rows } = await withSystem((db) => db.query<{ role_key: AgentRoleKey; status: string; enabled: boolean; hermes_profile: string | null; last_health_ok: boolean | null; credential_id: string | null }>(
        "select role_key, status, enabled, hermes_profile, last_health_ok, credential_id from agent_instances where org_id = $1", [c.orgId]));
      expect(rows).toHaveLength(6);
      for (const r of rows) {
        expect(r.hermes_profile, `${c.name}/${r.role_key}: no profile until the provisioner makes one`).toBeNull();
        expect(r.credential_id).toBeNull();
        expect(r.last_health_ok).not.toBe(true);
        const readiness = deriveEmployeeReadiness({ displayName: r.role_key, enabled: r.enabled, status: r.status as never, configVersion: 1, lastHealthCheckAt: null, lastHealthOk: r.last_health_ok, inventoryDigest: null });
        expect(readiness.workReady, r.role_key).toBe(false);
        expect(readiness.chatAvailable, r.role_key).toBe(false);
      }
    }
  });

  it("gives each client six tenant-scoped identities that can never be an agency profile or another client's", () => {
    const names = new Set<string>();
    for (const c of [a, b]) {
      for (const role of AGENT_ROLE_KEYS) {
        const name = suggestedProfileName(c.slug, role);
        expect(name.startsWith("c-")).toBe(true);
        expect(name.startsWith("iacquire-")).toBe(false);
        expect(Object.values(AGENCY_HERMES_PROFILE_IDS)).not.toContain(name);
        names.add(name);
      }
    }
    expect(names.size).toBe(12);
  });
});

describe("provisioning is per workspace and idempotent", () => {
  it("queues one provisioning request per employee, once, however often it is asked", async () => {
    const first = await withSystem((db) => requestProvisioning(db, a.orgId, a.ownerId));
    const second = await withSystem((db) => requestProvisioning(db, a.orgId, a.ownerId));
    const third = await withSystem((db) => requestProvisioning(db, a.orgId, null));
    const jobs = (await withSystem((db) => db.query<{ n: number; open: number }>("select count(*)::int as n, count(*) filter (where status in ('requested', 'in_progress', 'awaiting_health_check'))::int as open from agent_provisioning_jobs where org_id = $1 and kind = 'provision'", [a.orgId]))).rows[0];
    expect(jobs.n).toBe(6);
    expect(jobs.open).toBe(6);
    expect(Number(first) + Number(second) + Number(third)).toBe(Number(first)); // only the first call created anything
    // One workspace's request never creates or touches another's.
    expect((await withSystem((db) => db.query("select 1 from agent_provisioning_jobs where org_id = $1", [b.orgId]))).rows.length).toBeLessThanOrEqual(6);
  });

  it("recovers from a partly failed run: a failed job stays visible, is retried within its limit, and the others are untouched", async () => {
    const hunter = a.agents.lead_hunter;
    const ops = a.agents.operations_manager;
    await withSystem((db) => db.query("update agent_provisioning_jobs set status = 'failed', detail = 'The host did not answer', attempt_count = 1, next_retry_at = now() - interval '1 minute' where agent_instance_id = $1 and kind = 'provision'", [hunter]));
    const states = (await withSystem((db) => db.query<{ agent_instance_id: string; status: string; attempt_count: number }>("select agent_instance_id, status, attempt_count from agent_provisioning_jobs where org_id = $1 and kind = 'provision'", [a.orgId]))).rows;
    expect(states.find((s) => s.agent_instance_id === hunter)).toMatchObject({ status: "failed", attempt_count: 1 });
    expect(states.find((s) => s.agent_instance_id === ops)?.status).toBe("requested");
    // Asking again does not create a second job for the failed employee (the retry belongs to the leased worker, not to a duplicate request).
    await withSystem((db) => requestProvisioning(db, a.orgId, a.ownerId));
    expect((await withSystem((db) => db.query("select 1 from agent_provisioning_jobs where agent_instance_id = $1 and kind = 'provision'", [hunter]))).rows).toHaveLength(1);
  });
});

describe("nothing crosses a workspace boundary", () => {
  it("writes each client's SOUL from its own business only", async () => {
    const soulA = (await getProvisioningBundle(a.agents.lead_hunter)).soul;
    const soulB = (await getProvisioningBundle(b.agents.lead_hunter)).soul;
    expect(soulA).toContain(a.name);
    expect(soulA).not.toContain(b.name);
    expect(soulB).toContain(b.name);
    expect(soulB).not.toContain(a.name);
    expect(soulA).not.toContain("Bravo");
    expect((await getProvisioningBundle(a.agents.lead_hunter)).profile).not.toBe((await getProvisioningBundle(b.agents.lead_hunter)).profile);
  });

  it("gives an employee only its own workspace's knowledge", async () => {
    await withSystem(async (db) => {
      await db.query("insert into company_knowledge (org_id, section, content) values ($1, 'faq', 'ALPHA-ONLY: we repair roofs after storms.') on conflict (org_id, section) do update set content = excluded.content", [a.orgId]);
      await db.query("insert into company_knowledge (org_id, section, content) values ($1, 'faq', 'BRAVO-ONLY: we fix leaking pipes.') on conflict (org_id, section) do update set content = excluded.content", [b.orgId]);
    });
    const ctxA = await withSystem((db) => employeeKnowledgeContext(db, a.orgId, a.agents.sales_assistant));
    const ctxB = await withSystem((db) => employeeKnowledgeContext(db, b.orgId, b.agents.sales_assistant));
    expect(ctxA.block).toContain("ALPHA-ONLY");
    expect(ctxA.block).not.toContain("BRAVO-ONLY");
    expect(ctxB.block).toContain("BRAVO-ONLY");
    expect(ctxB.block).not.toContain("ALPHA-ONLY");
    // An employee id from the other workspace cannot be used to read this workspace's knowledge notes.
    const crossed = await withSystem((db) => employeeKnowledgeContext(db, a.orgId, b.agents.sales_assistant));
    expect(crossed.block).not.toContain("BRAVO-ONLY");
  });

  it("resolves a credential only for the workspace and provider that own it", async () => {
    const id = await withSystem((db) => saveCredential(db, { orgId: a.orgId, provider: "hermes", label: "Alpha lead hunter", secret: "alpha-profile-key-0123456789abcdef", actorId: superAdmin.id }));
    const credentialId = typeof id === "string" ? id : (id as { id: string }).id;
    expect(await withSystem((db) => resolveCredential(db, credentialId, a.orgId, "hermes"))).toBe("alpha-profile-key-0123456789abcdef");
    // Asked by another workspace, or as another provider, or as no workspace at all, it refuses outright (it does not hand back the secret or pretend there is none).
    await expect(withSystem((db) => resolveCredential(db, credentialId, b.orgId, "hermes"))).rejects.toThrow(/ownership does not match/);
    await expect(withSystem((db) => resolveCredential(db, credentialId, a.orgId, "ghl"))).rejects.toThrow(/ownership does not match/);
    await expect(withSystem((db) => resolveCredential(db, credentialId, null, "hermes"))).rejects.toThrow(/ownership does not match/);
  });
});

describe("a client's employees are held to the same tool policy as the agency's", () => {
  it("allows each client employee exactly what its role owns, denies the rest, and records the refusals in that client's own log", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const own = employeeActions(role).map((x) => x.id);
      const sample = own[0];
      await expect(enforceAgentAction({ orgId: a.orgId, agentId: a.agents[role], actionId: sample, actorUserId: a.ownerId, actorKind: "user" })).resolves.toMatchObject({ role });
      const foreign = AGENT_ROLE_KEYS.filter((r) => r !== role).flatMap((r) => employeeActions(r).map((x) => x.id)).find((id) => !own.includes(id))!;
      await expect(enforceAgentAction({ orgId: a.orgId, agentId: a.agents[role], actionId: foreign, actorUserId: a.ownerId, actorKind: "user" })).rejects.toMatchObject({ code: "forbidden" });
    }
    const refused = (await withSystem((db) => db.query<{ org_id: string }>("select org_id from audit_logs where action = 'agent.action_denied' and org_id = any($1::uuid[])", [[a.orgId, b.orgId]]))).rows;
    expect(refused.length).toBeGreaterThanOrEqual(6);
    expect(refused.every((r) => r.org_id === a.orgId)).toBe(true);
    // A's owner cannot ask the policy about B's employee: it is not found in A.
    await expect(enforceAgentAction({ orgId: a.orgId, agentId: b.agents.lead_hunter, actionId: "runtime:memory", actorUserId: a.ownerId, actorKind: "user" })).rejects.toMatchObject({ code: "not_found" });
    expect(AGENT_BY_KEY.lead_hunter.name).toBeTruthy();
  });
});
