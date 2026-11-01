// The lifecycle of a client employee's business tool credential, as an operator uses it: the Super Admin's emergency revocation (one credential, one employee, a whole workspace), a
// rotation that overlaps for at most 48 hours and ends when the new credential is first used, the warnings before a credential lapses, the scheduled job that sends them, and that a
// client read names the person it was for. Synthetic workspaces on the embedded database, driven through the real client route; no Hermes, provider or network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem } from "@/server/db";
import { resetEnvCache } from "@/server/env";
import { JOBS, runScheduledJobs } from "@/server/ops/tick";
import { suggestedProfileName } from "@/server/workforce/service";
import {
  CLIENT_ACCESS_AUDIT,
  CLIENT_CREDENTIAL_AUDIT,
  CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS,
  completeClientRotation,
  expireClientBusinessCredentials,
  expiringClientCredentials,
  formatClientCredential,
  generateClientCredentialSecret,
  hashClientSecret,
  registerClientBusinessCredential,
  revokeClientBusinessAccessAsAdmin,
  rotateClientBusinessCredential,
  runClientBusinessCredentialExpiry,
  verifyClientCredential,
} from "@/server/workforce/hermes-client-business-credential";
import { createOrg, createUser, agentId } from "./support/fixtures";
import { auditRows, callBody, clientSideEffects, endClientTurns, postClient, provisionedClient, refused, setClientTier, startClientTurn, type ClientTenant } from "./support/client-business-mcp";

const state = vi.hoisted(() => ({ user: null as null | { id: string; platformRole: string; email: string; fullName: string }, revalidated: [] as string[] }));
vi.mock("next/cache", () => ({ revalidatePath: (path: string) => state.revalidated.push(path) }));
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

import { revokeClientBusinessAccess, setClientBusinessToolsAction } from "@/app/actions/client-business-access";

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const after = (at: Date, ms: number) => new Date(at.getTime() + ms);
const ledger = (id: string) => q<{ status: string; revoked_reason: string | null; expires_at: Date; secret_sha256: string | null; use_count: number }>("select status, revoked_reason, expires_at, secret_sha256, use_count from agent_business_credentials where id = $1", [id]).then((rows) => rows[0]);
const live = async (token: string) => (await postClient(token)).status;
const AGENT_ROLES = AGENT_ROLE_KEYS;

let admin: { id: string; email: string };
let staff: { id: string; email: string };
const tenants = {} as Record<"one" | "workspace" | "rotation" | "expiry" | "bystander", ClientTenant>;

async function tenant(name: string, tag: string, phone: string, timezone = "America/Chicago") {
  return provisionedClient({ name, timezone, tag, phone, crm: false });
}

/** Makes the employee look the way the restricted worker leaves it, so the portal can ask for a synchronization: the applied version is the one the profile holds, and a provision job made it. */
async function asProvisioned(t: ClientTenant, role: AgentRoleKey) {
  await q("update agent_instances set hermes_profile_config_version_id = active_config_version_id where id = $1", [t.agents[role]]);
  await q(
    "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, result_reference, attempt_count) values ($1, $2, 'provision', 'succeeded', $3, 1)",
    [t.org.id, t.agents[role], `provisioner:v1:${role}-${t.slug}`.slice(0, 280)],
  );
}

beforeAll(async () => {
  admin = await createUser({ platformRole: "agency_super_admin", name: "Lifecycle Admin" });
  staff = await createUser({ platformRole: "agency_staff", name: "Lifecycle Staff" });
  tenants.one = await tenant("Lifecycle One", "Lifeone", "+13125550151");
  tenants.workspace = await tenant("Lifecycle Workspace", "Lifework", "+639171234551", "Asia/Manila");
  tenants.rotation = await tenant("Lifecycle Rotation", "Liferot", "+13125550153");
  tenants.expiry = await tenant("Lifecycle Expiry", "Lifeexp", "+13125550154");
  tenants.bystander = await tenant("Lifecycle Bystander", "Lifeby", "+13125550155");
}, 360_000);

beforeEach(() => {
  setClientTier(true);
  state.user = { id: admin.id, platformRole: "agency_super_admin", email: "admin@example.test", fullName: "Lifecycle Admin" };
  state.revalidated.length = 0;
});
afterEach(async () => {
  for (const t of Object.values(tenants)) for (const role of AGENT_ROLES) await endClientTurns(t, role);
  vi.unstubAllEnvs();
  resetEnvCache();
});
afterAll(() => {
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("a Super Admin ends business tool access at once", () => {
  it("ends one credential: that credential is refused on its next request, the employee's others and every other workspace are untouched, and the audit trail names who and why", async () => {
    const { one, bystander } = tenants;
    for (const t of [one, bystander]) for (const role of AGENT_ROLES) expect(await live(t.credentials[role]), role).toBe(200);
    const outcome = await revokeClientBusinessAccess({ orgId: one.org.id, credentialId: one.credentialIds.lead_hunter, reason: "Pasted into a support ticket" });
    expect(outcome).toEqual({ ok: true, data: { revoked: 1 } });
    expect(state.revalidated).toEqual([`/admin/clients/${one.org.id}`]);

    expect(await live(one.credentials.lead_hunter)).toBe(401);
    for (const role of AGENT_ROLES.filter((r) => r !== "lead_hunter")) expect(await live(one.credentials[role]), role).toBe(200);
    for (const role of AGENT_ROLES) expect(await live(bystander.credentials[role]), role).toBe(200);
    expect(await ledger(one.credentialIds.lead_hunter)).toMatchObject({ status: "revoked", revoked_reason: "operator_request" });
    expect(await ledger(one.credentialIds.crm_manager)).toMatchObject({ status: "active" });

    const ended = (await auditRows(CLIENT_CREDENTIAL_AUDIT.revoked, one.org.id)).filter((row) => row.metadata.jti === one.credentialIds.lead_hunter);
    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ org_id: one.org.id, actor_user_id: admin.id, agent_instance_id: one.agents.lead_hunter, metadata: { reason: "operator_request" } });
    const lever = await auditRows(CLIENT_ACCESS_AUDIT.accessRevoked, one.org.id);
    expect(lever).toHaveLength(1);
    expect(lever[0]).toMatchObject({ actor_user_id: admin.id, result: "success", metadata: { scope: "credential", count: 1, reason: "Pasted into a support ticket" } });
    expect(await auditRows(CLIENT_ACCESS_AUDIT.accessRevoked, bystander.org.id)).toEqual([]);
    expect(await auditRows(CLIENT_CREDENTIAL_AUDIT.revoked, bystander.org.id)).toEqual([]);
  });

  it("does not find another workspace's credential, and a credential that is already ended is not found either", async () => {
    const { one, bystander } = tenants;
    const before = await clientSideEffects();
    const foreign = await revokeClientBusinessAccess({ orgId: bystander.org.id, credentialId: one.credentialIds.crm_manager, reason: "Wrong workspace on purpose" });
    expect(foreign).toMatchObject({ ok: false, code: "not_found" });
    const twice = await revokeClientBusinessAccess({ orgId: one.org.id, credentialId: one.credentialIds.lead_hunter, reason: "Already ended above" });
    expect(twice).toMatchObject({ ok: false, code: "not_found" });
    expect(await live(one.credentials.crm_manager)).toBe(200);
    expect(await clientSideEffects()).toEqual(before);
    expect(await auditRows(CLIENT_ACCESS_AUDIT.accessRevoked, bystander.org.id)).toEqual([]);
  });

  it("ends one employee's credentials, and only that employee's", async () => {
    const { one } = tenants;
    const outcome = await revokeClientBusinessAccess({ orgId: one.org.id, agentId: one.agents.performance_analyst, reason: "Role moved to another person" });
    expect(outcome).toEqual({ ok: true, data: { revoked: 1 } });
    expect(await live(one.credentials.performance_analyst)).toBe(401);
    for (const role of AGENT_ROLES.filter((r) => r !== "lead_hunter" && r !== "performance_analyst")) expect(await live(one.credentials[role]), role).toBe(200);
    expect((await auditRows(CLIENT_ACCESS_AUDIT.accessRevoked, one.org.id)).at(-1)).toMatchObject({ agent_instance_id: one.agents.performance_analyst, metadata: { scope: "employee", count: 1 } });
  });

  it("ends the whole workspace's credentials: all six fail, and the other workspace is unaffected", async () => {
    const { workspace, bystander } = tenants;
    for (const role of AGENT_ROLES) expect(await live(workspace.credentials[role]), role).toBe(200);
    const outcome = await revokeClientBusinessAccess({ orgId: workspace.org.id, reason: "The client asked us to stop everything" });
    expect(outcome).toEqual({ ok: true, data: { revoked: 6 } });
    for (const role of AGENT_ROLES) expect(await live(workspace.credentials[role]), role).toBe(401);
    for (const role of AGENT_ROLES) expect(await live(bystander.credentials[role]), role).toBe(200);
    expect(await q("select 1 from agent_business_credentials where org_id = $1 and status <> 'revoked'", [workspace.org.id])).toEqual([]);
    expect(await auditRows(CLIENT_CREDENTIAL_AUDIT.revoked, workspace.org.id)).toHaveLength(6);
    // A second press has nothing left to end.
    expect(await revokeClientBusinessAccess({ orgId: workspace.org.id, reason: "Pressed twice by mistake" })).toEqual({ ok: true, data: { revoked: 0 } });
  });

  it("refuses everyone but a Super Admin, a reason shorter than five characters, an ambiguous request, and an agency or demo workspace, and each refusal changes nothing", async () => {
    const { bystander } = tenants;
    const demo = await tenant("Lifecycle Demo", "Lifedemo", "+13125550156");
    await q("update organizations set is_demo = true where id = $1", [demo.org.id]);
    const agencyId = (await q<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0]?.id ?? (await createOrg({ kind: "agency" })).id;
    const before = await clientSideEffects();
    const credentials = async () => (await q<{ n: number }>("select count(*)::int as n from agent_business_credentials where status <> 'revoked'"))[0].n;
    const liveBefore = await credentials();
    const reason = "A reason long enough to be real";

    state.user = { id: staff.id, platformRole: "agency_staff", email: "staff@example.test", fullName: "Lifecycle Staff" };
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, reason })).toMatchObject({ ok: false, code: "forbidden" });
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, credentialId: bystander.credentialIds.lead_hunter, reason })).toMatchObject({ ok: false, code: "forbidden" });
    state.user = null;
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, reason })).toMatchObject({ ok: false, code: "unauthenticated" });
    // The service refuses a non-Super-Admin by itself too, whatever called it.
    await expect(revokeClientBusinessAccessAsAdmin({ id: staff.id, platformRole: "agency_staff" }, { orgId: bystander.org.id, reason })).rejects.toMatchObject({ code: "forbidden" });

    state.user = { id: admin.id, platformRole: "agency_super_admin", email: "admin@example.test", fullName: "Lifecycle Admin" };
    for (const short of ["", "no", "four", "    ab  "]) expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, reason: short }), short).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, reason: "x".repeat(501) })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeClientBusinessAccess({ orgId: "not-an-id", reason })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, reason, extra: true })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeClientBusinessAccess({ orgId: bystander.org.id, agentId: bystander.agents.lead_hunter, credentialId: bystander.credentialIds.lead_hunter, reason })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await revokeClientBusinessAccess({ orgId: crypto.randomUUID(), reason })).toMatchObject({ ok: false, code: "not_found" });
    expect(await revokeClientBusinessAccess({ orgId: demo.org.id, reason })).toMatchObject({ ok: false, code: "conflict" });
    expect(await revokeClientBusinessAccess({ orgId: agencyId, reason })).toMatchObject({ ok: false, code: "conflict" });

    expect(await credentials()).toBe(liveBefore);
    expect(await clientSideEffects()).toEqual(before);
    for (const role of AGENT_ROLES) expect(await live(bystander.credentials[role]), role).toBe(200);
    expect(await auditRows(CLIENT_ACCESS_AUDIT.accessRevoked, demo.org.id)).toEqual([]);
    expect(await auditRows(CLIENT_ACCESS_AUDIT.accessRevoked, agencyId)).toEqual([]);
    expect(state.revalidated).toEqual([]);
  });
});

describe("the Super Admin's business tool switch action", () => {
  it("switches the workspace's tools, audits it as the Super Admin, and asks for the employees to be synchronized (none here has a profile made by the worker, so none is queued)", async () => {
    const t = tenants.workspace;
    const off = await setClientBusinessToolsAction({ orgId: t.org.id, tools: false });
    expect(off).toEqual({ ok: true, data: { changed: true, queued: 0 } });
    expect((await q<{ enabled: boolean }>("select enabled from org_features where org_id = $1 and feature = 'client_business_tools'", [t.org.id]))[0].enabled).toBe(false);
    expect(state.revalidated).toEqual([`/admin/clients/${t.org.id}`]);
    expect(await q("select 1 from audit_logs where org_id = $1 and action = 'feature.disabled' and actor_user_id = $2", [t.org.id, admin.id])).toHaveLength(1);
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: false })).toEqual({ ok: true, data: { changed: false, queued: 0 } });
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: true })).toEqual({ ok: true, data: { changed: true, queued: 0 } });
  });

  it("refuses a person who is not a Super Admin, a malformed request, and an agency or unknown workspace", async () => {
    const t = tenants.bystander;
    const before = (await q<{ n: number }>("select count(*)::int as n from org_features"))[0].n;
    state.user = { id: staff.id, platformRole: "agency_staff", email: "staff@example.test", fullName: "Lifecycle Staff" };
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: false })).toMatchObject({ ok: false, code: "forbidden" });
    state.user = { id: admin.id, platformRole: "agency_super_admin", email: "admin@example.test", fullName: "Lifecycle Admin" };
    expect(await setClientBusinessToolsAction({ orgId: t.org.id })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await setClientBusinessToolsAction({ orgId: t.org.id, tools: "yes" })).toMatchObject({ ok: false, code: "invalid_input" });
    expect(await setClientBusinessToolsAction({ orgId: crypto.randomUUID(), tools: true })).toMatchObject({ ok: false, code: "not_found" });
    const agencyId = (await q<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0]?.id ?? (await createOrg({ kind: "agency" })).id;
    expect(await setClientBusinessToolsAction({ orgId: agencyId, tools: true })).toMatchObject({ ok: false, code: "conflict" });
    expect((await q<{ n: number }>("select count(*)::int as n from org_features"))[0].n).toBe(before);
    expect(state.revalidated).toEqual([]);
    expect(await live(t.credentials.lead_hunter)).toBe(200);
  });
});

describe("rotation", () => {
  it("allocates one waiting credential and one synchronization job, however often it is asked for, and the waiting credential cannot authenticate", async () => {
    const t = tenants.rotation;
    await asProvisioned(t, "lead_hunter");
    const first = await withSystem((db) => rotateClientBusinessCredential(db, { orgId: t.org.id, agentId: t.agents.lead_hunter, requestedBy: admin.id }));
    const again = await withSystem((db) => rotateClientBusinessCredential(db, { orgId: t.org.id, agentId: t.agents.lead_hunter, requestedBy: admin.id }));
    expect(again).toEqual(first);
    expect(await q("select 1 from agent_business_credentials where agent_instance_id = $1 and status = 'pending'", [t.agents.lead_hunter])).toHaveLength(1);
    const jobs = await q<{ id: string; kind: string; status: string; requested_by: string | null }>("select id, kind, status, requested_by from agent_provisioning_jobs where agent_instance_id = $1 and kind = 'sync'", [t.agents.lead_hunter]);
    expect(jobs).toEqual([{ id: first.syncJobId, kind: "sync", status: "requested", requested_by: admin.id }]);
    // Until the worker reports a hash the id is nothing: a made-up secret for it is refused, and the current credential keeps working.
    expect(await live(formatClientCredential(first.credentialId, generateClientCredentialSecret()))).toBe(401);
    expect(await live(t.credentials.lead_hunter)).toBe(200);
    expect(await auditRows(CLIENT_ACCESS_AUDIT.rotationRequested, t.org.id)).toHaveLength(2);
    expect(JSON.stringify(await auditRows(CLIENT_ACCESS_AUDIT.rotationRequested, t.org.id))).not.toMatch(/iamcpc1/);
  });

  it("overlaps: both credentials work until the new one is first used, then the old one is refused at once", async () => {
    const t = tenants.rotation;
    const waiting = (await q<{ id: string }>("select id from agent_business_credentials where agent_instance_id = $1 and status = 'pending'", [t.agents.lead_hunter]))[0].id;
    const secret = generateClientCredentialSecret();
    const done = await withSystem((db) => completeClientRotation(db, waiting, hashClientSecret(secret)));
    expect(done).toEqual({ id: waiting, duplicate: false });
    const oldId = t.credentialIds.lead_hunter;
    expect(await ledger(oldId)).toMatchObject({ status: "rotating_out" });
    expect(await ledger(waiting)).toMatchObject({ status: "active", secret_sha256: hashClientSecret(secret) });
    expect((await ledger(oldId)).expires_at.getTime()).toBeLessThanOrEqual(Date.now() + CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS * HOUR + 1000);

    // The profile may still present the old credential for a while: it works, and it does not end anything.
    expect(await live(t.credentials.lead_hunter)).toBe(200);
    expect(await ledger(oldId)).toMatchObject({ status: "rotating_out" });
    // The first honoured use of the new one ends the old one at once.
    const fresh = formatClientCredential(waiting, secret);
    expect(await live(fresh)).toBe(200);
    expect(await ledger(oldId)).toMatchObject({ status: "revoked", revoked_reason: "rotation_complete" });
    expect(await live(t.credentials.lead_hunter)).toBe(401);
    expect(await live(fresh)).toBe(200);
    expect(await auditRows(CLIENT_CREDENTIAL_AUDIT.rotated, t.org.id)).toHaveLength(1);
    // The worker may report the same thing twice; a different hash for the same id is refused.
    expect(await withSystem((db) => completeClientRotation(db, waiting, hashClientSecret(secret)))).toEqual({ id: waiting, duplicate: true });
    await expect(withSystem((db) => completeClientRotation(db, waiting, hashClientSecret(generateClientCredentialSecret())))).rejects.toMatchObject({ code: "conflict" });
    expect((await ledger(waiting)).secret_sha256).toBe(hashClientSecret(secret));
  });

  it("refuses a completion that is not for a waiting credential, and one whose hash is not a hash", async () => {
    const t = tenants.rotation;
    const hash = hashClientSecret(generateClientCredentialSecret());
    await expect(withSystem((db) => completeClientRotation(db, crypto.randomUUID(), hash))).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => completeClientRotation(db, "nope", hash))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(withSystem((db) => completeClientRotation(db, t.credentialIds.crm_manager, "ABC"))).rejects.toMatchObject({ code: "invalid_input" });
    // A live credential cannot be "completed" with a new hash.
    await expect(withSystem((db) => completeClientRotation(db, t.credentialIds.crm_manager, hash))).rejects.toMatchObject({ code: "conflict" });
    expect(await live(t.credentials.crm_manager)).toBe(200);
  });

  it("ends the old credential after 48 hours even if the new one was never used, and not before", async () => {
    const t = tenants.rotation;
    await asProvisioned(t, "appointment_setter");
    const { credentialId } = await withSystem((db) => rotateClientBusinessCredential(db, { orgId: t.org.id, agentId: t.agents.appointment_setter, requestedBy: admin.id }));
    const completedAt = new Date();
    const secret = generateClientCredentialSecret();
    await withSystem((db) => completeClientRotation(db, credentialId, hashClientSecret(secret), completedAt));
    const old = t.credentials.appointment_setter;
    const verify = (token: string, at: Date) => withSystem((db) => verifyClientCredential(db, token, at));
    expect(await verify(old, after(completedAt, 47 * HOUR))).toMatchObject({ ok: true, claims: { status: "rotating_out" } });
    expect(await verify(old, after(completedAt, 49 * HOUR))).toMatchObject({ ok: false, reason: "expired" });
    expect(await verify(formatClientCredential(credentialId, secret), after(completedAt, 49 * HOUR))).toMatchObject({ ok: true, claims: { status: "active" } });
    // The sweep then closes it in the ledger.
    expect(await withSystem((db) => expireClientBusinessCredentials(db, after(completedAt, 49 * HOUR)))).toBeGreaterThanOrEqual(1);
    expect(await ledger(t.credentialIds.appointment_setter)).toMatchObject({ status: "revoked", revoked_reason: "expired" });
  });

  it("refuses to rotate for a switched-off employee, a demo workspace, an employee without a live credential or a client profile, an agency employee, and writes nothing", async () => {
    const t = tenants.rotation;
    const rotate = (orgId: string, id: string) => withSystem((db) => rotateClientBusinessCredential(db, { orgId, agentId: id, requestedBy: admin.id }));
    const stable = async () => ({ credentials: await clientSideEffects(), jobs: await q("select id, status from agent_provisioning_jobs where org_id = $1 order by id", [t.org.id]) });
    await asProvisioned(t, "crm_manager");
    const before = await stable();

    await q("update agent_instances set enabled = false where id = $1", [t.agents.crm_manager]);
    await expect(rotate(t.org.id, t.agents.crm_manager)).rejects.toMatchObject({ code: "conflict" });
    await q("update agent_instances set enabled = true where id = $1", [t.agents.crm_manager]);

    await q("update organizations set is_demo = true where id = $1", [t.org.id]);
    await expect(rotate(t.org.id, t.agents.crm_manager)).rejects.toMatchObject({ code: "conflict" });
    await q("update organizations set is_demo = false where id = $1", [t.org.id]);

    // An employee whose credential was ended has none to replace (the Super Admin revoked the Analyst's above), and one with no profile of its own has nothing to synchronize.
    await expect(rotate(tenants.one.org.id, tenants.one.agents.performance_analyst)).rejects.toMatchObject({ code: "conflict" });
    const analystProfile = suggestedProfileName(t.slug, "performance_analyst");
    await q("update agent_instances set hermes_profile = null, hermes_gateway_id = null where id = $1", [t.agents.performance_analyst]);
    try {
      await expect(rotate(t.org.id, t.agents.performance_analyst)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await q("update agent_instances set hermes_profile = $2, hermes_gateway_id = $3 where id = $1", [t.agents.performance_analyst, analystProfile, t.gatewayId]);
    }

    // An employee of another kind of workspace, or of another workspace, is not found.
    const agencyId = (await q<{ id: string }>("select id from organizations where kind = 'agency' limit 1"))[0]?.id ?? (await createOrg({ kind: "agency" })).id;
    await expect(rotate(agencyId, await agentId(agencyId, "lead_hunter"))).rejects.toMatchObject({ code: "not_found" });
    await expect(rotate(tenants.bystander.org.id, t.agents.crm_manager)).rejects.toMatchObject({ code: "not_found" });
    await expect(rotate("nope", t.agents.crm_manager)).rejects.toMatchObject({ code: "invalid_input" });

    // A synchronization that cannot be queued (the gateway's client-only isolation is not verified) is refused, and the waiting id is not kept.
    await q("update hermes_gateways set provisioner_isolation_verified_at = null where id = $1", [t.gatewayId]);
    try {
      await expect(rotate(t.org.id, t.agents.crm_manager)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      await q("update hermes_gateways set provisioner_isolation_verified_at = now() where id = $1", [t.gatewayId]);
    }
    expect(await q("select 1 from agent_business_credentials where agent_instance_id = $1 and status = 'pending'", [t.agents.crm_manager])).toEqual([]);
    expect(await stable()).toEqual(before);
  });
});

describe("the warning before a credential lapses", () => {
  const notices = (id: string, windowDays: number) => q<{ user_id: string; title: string; body: string | null; severity: string; kind: string; org_id: string | null }>(
    "select user_id, title, body, severity, kind, org_id from notifications where dedupe_key = $1", [`client-credential-expiry:${id}:${windowDays}`],
  );

  it("lists only live credentials that lapse within the window, soonest first, for enabled employees of active real client workspaces", async () => {
    const t = tenants.expiry;
    const now = new Date();
    const profile = suggestedProfileName(t.slug, "lead_hunter");
    const secret = generateClientCredentialSecret();
    const short = await withSystem((db) => registerClientBusinessCredential(db, { orgId: t.org.id, agentId: t.agents.lead_hunter, profile, secretSha256: hashClientSecret(secret), expiresInDays: 20, now }));
    const list = await withSystem((db) => expiringClientCredentials(db, 30, now));
    const mine = list.filter((item) => item.orgId === t.org.id);
    expect(mine.map((item) => item.id)).toEqual([short.id]);
    expect(mine[0]).toMatchObject({ orgName: "Lifecycle Expiry", agentId: t.agents.lead_hunter, role: "lead_hunter", daysLeft: 20 });
    // The credential it replaced is in its 48-hour overlap and ends by design: it is not a warning.
    expect(await ledger(t.credentialIds.lead_hunter)).toMatchObject({ status: "rotating_out" });
    expect(list.find((item) => item.id === t.credentialIds.lead_hunter)).toBeUndefined();
    // A shorter look-ahead leaves it out; the default 180-day credentials of the other employees are far outside the window.
    expect((await withSystem((db) => expiringClientCredentials(db, 10, now))).filter((item) => item.orgId === t.org.id)).toEqual([]);
    await expect(withSystem((db) => expiringClientCredentials(db, 0, now))).rejects.toMatchObject({ code: "invalid_input" });
    await expect(withSystem((db) => expiringClientCredentials(db, 401, now))).rejects.toMatchObject({ code: "invalid_input" });
    // A switched-off employee, a demo workspace and a workspace that is not active are not listed.
    await q("update agent_instances set enabled = false where id = $1", [t.agents.lead_hunter]);
    expect((await withSystem((db) => expiringClientCredentials(db, 30, now))).filter((item) => item.orgId === t.org.id)).toEqual([]);
    await q("update agent_instances set enabled = true where id = $1", [t.agents.lead_hunter]);
    for (const [change, restore] of [["is_demo = true", "is_demo = false"], ["status = 'suspended'", "status = 'active'"]]) {
      await q(`update organizations set ${change} where id = $1`, [t.org.id]);
      expect((await withSystem((db) => expiringClientCredentials(db, 30, now))).filter((item) => item.orgId === t.org.id), change).toEqual([]);
      await q(`update organizations set ${restore} where id = $1`, [t.org.id]);
    }
  });

  it("tells the agency once per credential and window: 30 days ahead, then 7 days, never twice", async () => {
    const t = tenants.expiry;
    await createUser({ platformRole: "agency_super_admin", name: "Expiry Watcher" });
    const now = new Date();
    const credential = (await q<{ id: string }>("select id from agent_business_credentials where agent_instance_id = $1 and status = 'active'", [t.agents.lead_hunter]))[0];

    const first = await runClientBusinessCredentialExpiry(now);
    expect(first.announced).toBeGreaterThanOrEqual(1);
    const wide = await notices(credential.id, 30);
    expect(wide.length).toBeGreaterThanOrEqual(1);
    expect(new Set(wide.map((row) => row.user_id)).size).toBe(wide.length);
    expect(wide[0]).toMatchObject({ kind: "agent_status", severity: "info", org_id: t.org.id });
    expect(wide[0].title).toContain("Lifecycle Expiry");
    expect(wide[0].title).toContain("20 days");
    expect(`${wide[0].title} ${wide[0].body}`).not.toMatch(/iamcpc1|[A-Za-z0-9_-]{43}/);
    expect(await notices(credential.id, 7)).toEqual([]);

    // The same instant, and an hour later: nothing new.
    expect((await runClientBusinessCredentialExpiry(now)).announced).toBe(0);
    expect((await runClientBusinessCredentialExpiry(after(now, HOUR))).announced).toBe(0);
    expect(await notices(credential.id, 30)).toHaveLength(wide.length);

    // Inside the closer window it is announced once more, as a warning.
    const closer = after(now, 14 * DAY);
    expect((await runClientBusinessCredentialExpiry(closer)).announced).toBeGreaterThanOrEqual(1);
    const near = await notices(credential.id, 7);
    expect(near.length).toBe(wide.length);
    expect(near[0]).toMatchObject({ severity: "warning" });
    expect(near[0].title).toContain("6 days");
    expect((await runClientBusinessCredentialExpiry(closer)).announced).toBe(0);
    expect((await runClientBusinessCredentialExpiry(after(now, 16 * DAY))).announced).toBe(0);
    expect(await notices(credential.id, 7)).toHaveLength(near.length);
  });

  it("gives a credential first seen inside the closer window that notice alone, and nothing for a credential with plenty of time", async () => {
    const t = tenants.expiry;
    const now = new Date();
    const profile = suggestedProfileName(t.slug, "appointment_setter");
    const soon = await withSystem((db) => registerClientBusinessCredential(db, { orgId: t.org.id, agentId: t.agents.appointment_setter, profile, secretSha256: hashClientSecret(generateClientCredentialSecret()), expiresInDays: 5, now }));
    const far = (await q<{ id: string }>("select id from agent_business_credentials where agent_instance_id = $1 and status = 'active'", [t.agents.crm_manager]))[0];
    expect((await runClientBusinessCredentialExpiry(now)).announced).toBeGreaterThanOrEqual(1);
    expect((await notices(soon.id, 7)).length).toBeGreaterThanOrEqual(1);
    expect(await notices(soon.id, 30)).toEqual([]);
    expect(await notices(far.id, 30)).toEqual([]);
    expect(await notices(far.id, 7)).toEqual([]);
  });

  it("closes a credential whose time has run out, in the ledger and the audit trail, and does not announce it", async () => {
    const t = tenants.expiry;
    const credential = (await q<{ id: string }>("select id from agent_business_credentials where agent_instance_id = $1 and status = 'active'", [t.agents.lead_hunter]))[0];
    const lapsed = after(new Date(), 21 * DAY);
    const result = await runClientBusinessCredentialExpiry(lapsed);
    expect(result.closed).toBeGreaterThanOrEqual(1);
    expect(await ledger(credential.id)).toMatchObject({ status: "revoked", revoked_reason: "expired" });
    expect((await auditRows(CLIENT_CREDENTIAL_AUDIT.expired, t.org.id)).some((row) => row.metadata.jti === credential.id && row.metadata.reason === "expired")).toBe(true);
  });

  it("is a registered scheduled job, once, on a daily rhythm, that runs through the real tick without failing", async () => {
    const jobs = JOBS.filter((job) => job.name === "clientBusinessCredentialExpiry");
    expect(jobs).toHaveLength(1);
    expect(jobs[0].everyMinutes).toBe(1440);
    const ran = await runScheduledJobs(undefined, jobs);
    expect(typeof ran.clientBusinessCredentialExpiry).toBe("number");
    expect(ran.tick).toBeUndefined();
  });
});

describe("a client read names the person it was for", () => {
  it("writes the person to the audit row of a context read, as it does for a refusal, and the internal tier's reads pass no person", async () => {
    const t = tenants.bystander;
    await startClientTurn(t, "crm_manager", t.owner.id);
    const read = await postClient(t.credentials.crm_manager, callBody("get_role_workspace_context"));
    expect(refused(read)).toBe(false);
    const reads = (await auditRows("hermes.business_mcp.read", t.org.id)).filter((row) => row.result === "success");
    expect(reads.length).toBeGreaterThanOrEqual(1);
    expect(reads.every((row) => row.actor_user_id === t.owner.id && row.agent_instance_id === t.agents.crm_manager)).toBe(true);
    expect(reads.at(-1)?.metadata).toMatchObject({ tool: "get_role_workspace_context", role: "crm_manager", jti: t.credentialIds.crm_manager });
    // The internal tier's rows stay exactly what they were (no acting person): tests/hermes-business-mcp-context.test.ts asserts that on its own success rows.
  });
});
