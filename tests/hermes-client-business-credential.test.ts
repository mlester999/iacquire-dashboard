// The stored-verifier credential of the client tier (iamcpc1.<ledger id>.<secret>): its format, that only a hash is ever stored, that every refusal costs the same, expiry, revocation
// (by id, by employee, by workspace), the 48-hour rotation overlap, and that no table, audit row or log line ever holds the secret. The ledger itself is in
// client-business-credentials-migration.test.ts.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_ROLE_KEYS, type AgentRoleKey } from "@/lib/agents";
import { withSystem, type Queryable } from "@/server/db";
import { sha256 } from "@/server/security/crypto";
import {
  allocateClientCredentialId,
  CLIENT_CREDENTIAL_AUDIT,
  CLIENT_CREDENTIAL_PENDING_HOURS,
  CLIENT_CREDENTIAL_PREFIX,
  CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS,
  expireClientBusinessCredentials,
  formatClientCredential,
  generateClientCredentialSecret,
  hashClientSecret,
  MAX_CLIENT_CREDENTIAL_LENGTH,
  parseClientCredential,
  recordClientCredentialUse,
  registerClientBusinessCredential,
  revokeClientBusinessCredential,
  revokeClientBusinessCredentialsForAgent,
  revokeClientBusinessCredentialsForOrg,
  verifyClientCredential,
} from "@/server/workforce/hermes-client-business-credential";
import { agentId, createOrg, uid } from "./support/fixtures";

const q = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T>(sql, params))).rows;
const HOUR = 3_600_000;
const after = (at: Date, hours: number) => new Date(at.getTime() + hours * HOUR);
const UUID = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const SECRET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ"; // 43 characters

/** A client workspace with one employee that has a Hermes profile of its own, the way the provisioner leaves it. */
async function world(role: AgentRoleKey = "lead_hunter") {
  const org = await createOrg({ kind: "client" });
  const agent = await agentId(org.id, role);
  const profile = `c-${uid()}-${role.slice(0, 8)}`;
  await q("update agent_instances set hermes_base_url = 'http://client-gateway.test', hermes_profile = $2 where id = $1", [agent, profile]);
  return { org, agent, profile, role };
}
type World = Awaited<ReturnType<typeof world>>;

// There is only ever one agency workspace, so the tests that need an internal employee share it.
let agencyOrg: ReturnType<typeof createOrg> | null = null;
async function agencyEmployee() {
  agencyOrg ??= createOrg({ kind: "agency" });
  const org = await agencyOrg;
  const agent = await agentId(org.id, "lead_hunter");
  await q("update agent_instances set hermes_base_url = 'http://agency-gateway.test', hermes_profile = 'iacquire-lead-hunter' where id = $1", [agent]);
  return { org, agent, profile: "iacquire-lead-hunter" };
}

/** Another employee of the same workspace, also with a profile of its own. */
async function colleague(w: World, role: AgentRoleKey): Promise<World> {
  const agent = await agentId(w.org.id, role);
  const profile = `c-${uid()}-${role.slice(0, 8)}`;
  await q("update agent_instances set hermes_base_url = 'http://client-gateway.test', hermes_profile = $2 where id = $1", [agent, profile]);
  return { ...w, agent, profile, role };
}

async function issue(w: World, over: Partial<Parameters<typeof registerClientBusinessCredential>[1]> = {}) {
  const secret = generateClientCredentialSecret();
  const { id } = await withSystem((db) =>
    registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: w.profile, secretSha256: hashClientSecret(secret), ...over }),
  );
  return { id, secret, token: formatClientCredential(id, secret) };
}

const verify = (presented: string | null | undefined, at?: Date) => withSystem((db) => verifyClientCredential(db, presented, at));
const row = async (id: string) =>
  (await q<{ status: string; expires_at: Date; revoked_reason: string | null; use_count: number; secret_sha256: string | null; last_used_at: Date | null }>("select * from agent_business_credentials where id = $1", [id]))[0];
const audits = (action: string, orgId?: string) =>
  q<{ org_id: string; actor_kind: string; agent_instance_id: string | null; target_type: string; target_id: string; result: string; metadata: Record<string, unknown> }>(
    "select org_id, actor_kind, agent_instance_id, target_type, target_id, result, metadata from audit_logs where action = $1 and ($2::uuid is null or org_id = $2) order by id",
    [action, orgId ?? null],
  );

describe("the credential format", () => {
  it("is iamcpc1.<lowercase uuid>.<43 base64url characters>, short enough for a header", () => {
    expect(parseClientCredential(`iamcpc1.${UUID}.${SECRET}`)).toEqual({ id: UUID, secret: SECRET });
    expect(parseClientCredential(`iamcpc1.${UUID}.${"-_".repeat(21)}A`)).toEqual({ id: UUID, secret: `${"-_".repeat(21)}A` });
    const made = formatClientCredential(UUID, generateClientCredentialSecret());
    expect(made.startsWith(`${CLIENT_CREDENTIAL_PREFIX}.`)).toBe(true);
    expect(made.length).toBeLessThanOrEqual(MAX_CLIENT_CREDENTIAL_LENGTH);
    expect(parseClientCredential(made)?.id).toBe(UUID);
    expect(generateClientCredentialSecret()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(generateClientCredentialSecret()).not.toBe(generateClientCredentialSecret());
  });

  it("refuses every other shape: another prefix, version, case, length, separator, padding or type", () => {
    const bad: unknown[] = [
      `iamcpc2.${UUID}.${SECRET}`,
      `iamcp1.${UUID}.${SECRET}`,
      `IAMCPC1.${UUID}.${SECRET}`,
      `iamcpc1.${UUID.toUpperCase()}.${SECRET}`,
      `iamcpc1.${UUID.slice(1)}.${SECRET}`,
      `iamcpc1.${UUID}.${SECRET.slice(1)}`,
      `iamcpc1.${UUID}.${SECRET}A`,
      `iamcpc1.${UUID}.${SECRET.slice(1)}=`,
      `iamcpc1.${UUID}.${SECRET.slice(1)}+`,
      `iamcpc1.${UUID}.${SECRET}.extra`,
      `iamcpc1:${UUID}:${SECRET}`,
      ` iamcpc1.${UUID}.${SECRET}`,
      `iamcpc1.${UUID}.${SECRET}\n`,
      `Bearer iamcpc1.${UUID}.${SECRET}`,
      `iamcpc1.${UUID}.`,
      `iamcpc1..${SECRET}`,
      `${`iamcpc1.${UUID}.${SECRET}`}${" ".repeat(MAX_CLIENT_CREDENTIAL_LENGTH)}`,
      "",
      null,
      undefined,
      42,
      { id: UUID },
    ];
    for (const value of bad) expect(parseClientCredential(value as string), String(value).slice(0, 40)).toBeNull();
  });

  it("hashes with sha256 (lowercase hex) and nothing else", () => {
    expect(hashClientSecret(SECRET)).toBe(sha256(SECRET));
    expect(hashClientSecret(SECRET)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashClientSecret(SECRET)).not.toBe(hashClientSecret(`${SECRET.slice(1)}A`));
  });
});

describe("registering and verifying", () => {
  it("makes a credential live from its hash, and verifies it as the employee it was issued to", async () => {
    const w = await world("crm_manager");
    const issued = await issue(w);
    const result = await verify(issued.token);
    expect(result).toEqual({
      ok: true,
      claims: { credentialId: issued.id, orgId: w.org.id, agentId: w.agent, role: "crm_manager", profile: w.profile, orgSlug: w.org.slug, displayName: expect.any(String), status: "active" },
    });
    const stored = await row(issued.id);
    expect(stored.status).toBe("active");
    expect(stored.secret_sha256).toBe(hashClientSecret(issued.secret));
  });

  it("takes the workspace, employee, role and profile from the records, never from the credential", async () => {
    const w = await world("operations_manager");
    const issued = await issue(w);
    // Moving the employee to another role changes what the credential means; the credential itself said nothing about it.
    await q("update agent_instances set display_name = 'Renamed' where id = $1", [w.agent]);
    const result = await verify(issued.token);
    expect(result.ok && result.claims).toMatchObject({ role: "operations_manager", displayName: "Renamed", orgId: w.org.id });
  });

  it("refuses an employee of another workspace, an agency employee, an unknown employee and a profile that is not the employee's", async () => {
    const a = await world();
    const b = await world();
    const hash = hashClientSecret(generateClientCredentialSecret());
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: b.org.id, agentId: a.agent, profile: a.profile, secretSha256: hash }))).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: a.org.id, agentId: crypto.randomUUID(), profile: a.profile, secretSha256: hash }))).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: a.org.id, agentId: a.agent, profile: b.profile, secretSha256: hash }))).rejects.toMatchObject({ code: "conflict" });
    const internal = await agencyEmployee();
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: internal.org.id, agentId: internal.agent, profile: internal.profile, secretSha256: hash }))).rejects.toMatchObject({ code: "not_found" });
    expect(await q("select 1 from agent_business_credentials where org_id = any($1::uuid[])", [[a.org.id, b.org.id, internal.org.id]])).toEqual([]);
  });

  it("refuses a hash that is not a lowercase sha256, a lifetime outside 1 to 400 days, and a malformed id", async () => {
    const w = await world();
    for (const bad of ["not-a-hash", "A".repeat(64), "a".repeat(63), generateClientCredentialSecret()]) {
      await expect(issue(w, { secretSha256: bad }), bad).rejects.toMatchObject({ code: "invalid_input" });
    }
    for (const days of [0, -1, 401, 1.5, Number.NaN]) await expect(issue(w, { expiresInDays: days }), String(days)).rejects.toMatchObject({ code: "invalid_input" });
    await expect(issue(w, { credentialId: "not-a-uuid" })).rejects.toMatchObject({ code: "invalid_input" });
    expect(await q("select 1 from agent_business_credentials where org_id = $1", [w.org.id])).toEqual([]);
    const longest = await issue(w, { expiresInDays: 400 });
    expect((await row(longest.id)).status).toBe("active");
  });

  it("is refused for an expired credential, a revoked one, and one whose secret is wrong, each in its own words only once the secret matched", async () => {
    const w = await world();
    const now = new Date();
    const issued = await issue(w, { expiresInDays: 1, now });
    expect(await verify(issued.token, after(now, 23))).toMatchObject({ ok: true });
    expect(await verify(issued.token, after(now, 24))).toEqual({
      ok: false, reason: "expired", claims: { credentialId: issued.id, orgId: w.org.id, agentId: w.agent, role: w.role, profile: w.profile, orgSlug: w.org.slug, displayName: expect.any(String) },
    });
    expect(await verify(issued.token, after(now, 25))).toMatchObject({ ok: false, reason: "expired" });

    const live = await issue(w, { now });
    expect(await withSystem((db) => revokeClientBusinessCredential(db, w.org.id, live.id, "operator_request"))).toBe(true);
    expect(await verify(live.token)).toMatchObject({ ok: false, reason: "revoked", claims: { credentialId: live.id } });
  });

  it("ends the credential at once when the employee is re-mapped to another Hermes profile", async () => {
    const w = await world();
    const issued = await issue(w);
    expect(await verify(issued.token)).toMatchObject({ ok: true });
    await q("update agent_instances set hermes_profile = $2 where id = $1", [w.agent, `c-${uid()}-moved`]);
    expect(await verify(issued.token)).toMatchObject({ ok: false, reason: "profile_changed", claims: { credentialId: issued.id } });
  });
});

describe("every refusal costs the same and says the same", () => {
  /** Counts the queries a call makes, so the paths can be compared. */
  async function counted(presented: string | null) {
    return withSystem(async (db) => {
      let queries = 0;
      const wrapped: Queryable = { query: <T>(sql: string, params?: unknown[]) => { queries += 1; return db.query<T>(sql, params); } };
      const result = await verifyClientCredential(wrapped, presented);
      return { result, queries };
    });
  }

  it("answers an unknown id, a wrong secret, a waiting id and a malformed value alike, with one lookup each", async () => {
    const w = await world();
    const issued = await issue(w);
    const waitingId = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent }));
    const unknown = await counted(formatClientCredential(crypto.randomUUID(), generateClientCredentialSecret()));
    const wrong = await counted(formatClientCredential(issued.id, generateClientCredentialSecret()));
    const waiting = await counted(formatClientCredential(waitingId, generateClientCredentialSecret()));
    const malformed = await counted("iamcpc1.nonsense");
    const nothing = await counted(null);
    const good = await counted(issued.token);
    expect(unknown.result).toEqual({ ok: false, reason: "invalid" });
    expect(wrong.result).toEqual(unknown.result);
    expect(waiting.result).toEqual(unknown.result);
    expect(malformed.result).toEqual({ ok: false, reason: "malformed" });
    expect(nothing.result).toEqual({ ok: false, reason: "malformed" });
    expect(good.result.ok).toBe(true);
    for (const attempt of [unknown, wrong, waiting, malformed, nothing, good]) expect(attempt.queries).toBe(1);
  });

  it("never tells a caller who does not hold the secret anything about the row: no claims, and the same answer for a revoked or expired id", async () => {
    const w = await world();
    const now = new Date();
    const ended = await issue(w, { now });
    await withSystem((db) => revokeClientBusinessCredential(db, w.org.id, ended.id, "operator_request"));
    const wrongSecret = formatClientCredential(ended.id, generateClientCredentialSecret());
    expect(await verify(wrongSecret)).toEqual({ ok: false, reason: "invalid" });
    expect(await verify(wrongSecret, after(now, 24 * 400))).toEqual({ ok: false, reason: "invalid" });
  });

  it("compares hashes in constant time, never with an equality operator, and never logs", () => {
    const source = readFileSync("src/server/workforce/hermes-client-business-credential.ts", "utf8");
    expect(source).toContain("timingSafeEqual");
    expect(source).not.toMatch(/(?:secret_sha256|presentedHash|expected)\s*(?:===|!==|==)|(?:===|!==)\s*(?:presentedHash|row\??\.secret_sha256)/);
    expect(source).not.toMatch(/console\.|logger\./);
    expect(source).not.toMatch(/HERMES_BUSINESS_MCP_SECRET|@\/server\/env/);
  });
});

describe("allocating the id a worker embeds", () => {
  it("hands out a waiting id that cannot authenticate, and the same id again while it waits", async () => {
    const w = await world();
    const id = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent }));
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    const waiting = await row(id);
    expect(waiting).toMatchObject({ status: "pending", secret_sha256: null });
    expect(await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent }))).toBe(id);
    expect(await q("select 1 from agent_business_credentials where org_id = $1", [w.org.id])).toHaveLength(1);
    expect(await verify(formatClientCredential(id, generateClientCredentialSecret()))).toEqual({ ok: false, reason: "invalid" });
  });

  it("is completed by the worker's hash alone, then verifies; completing it twice or for another employee is refused", async () => {
    const w = await world();
    const other = await world();
    const id = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent }));
    const secret = generateClientCredentialSecret();
    const hash = hashClientSecret(secret);
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: other.org.id, agentId: other.agent, profile: other.profile, secretSha256: hash, credentialId: id }))).rejects.toMatchObject({ code: "not_found" });
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: w.profile, secretSha256: hash, credentialId: crypto.randomUUID() }))).rejects.toMatchObject({ code: "not_found" });
    expect(await verify(formatClientCredential(id, secret))).toEqual({ ok: false, reason: "invalid" });
    const done = await withSystem((db) => registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: w.profile, secretSha256: hash, credentialId: id }));
    expect(done.id).toBe(id);
    expect(await verify(formatClientCredential(id, secret))).toMatchObject({ ok: true, claims: { credentialId: id, status: "active" } });
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: w.profile, secretSha256: hashClientSecret(generateClientCredentialSecret()), credentialId: id }))).rejects.toMatchObject({ code: "not_found" });
    expect((await row(id)).secret_sha256).toBe(hash);
  });

  it("lets a waiting id lapse after its window, and refuses to complete a lapsed one", async () => {
    const w = await world();
    const now = new Date();
    const first = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent, now }));
    expect(await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent, now: after(now, CLIENT_CREDENTIAL_PENDING_HOURS - 1) }))).toBe(first);
    const later = after(now, CLIENT_CREDENTIAL_PENDING_HOURS + 1);
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: w.profile, secretSha256: hashClientSecret(generateClientCredentialSecret()), credentialId: first, now: later }))).rejects.toMatchObject({ code: "not_found" });
    const second = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent, now: later }));
    expect(second).not.toBe(first);
  });

  it("does not hand out an id issued for a profile the employee no longer has: that id is ended and a new one is issued for the current profile", async () => {
    const w = await world();
    const stale = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent }));
    const renamed = `c-${uid()}-renamed`;
    await q("update agent_instances set hermes_profile = $2 where id = $1", [w.agent, renamed]);
    const fresh = await withSystem((db) => allocateClientCredentialId(db, { orgId: w.org.id, agentId: w.agent }));
    expect(fresh).not.toBe(stale);
    expect(await row(stale)).toMatchObject({ status: "revoked", revoked_reason: "profile_changed" });
    expect(await row(fresh)).toMatchObject({ status: "pending", profile: renamed });
    // The new id completes for the current profile; the old one never can.
    const secret = generateClientCredentialSecret();
    await expect(withSystem((db) => registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: renamed, secretSha256: hashClientSecret(secret), credentialId: stale }))).rejects.toMatchObject({ code: "not_found" });
    await withSystem((db) => registerClientBusinessCredential(db, { orgId: w.org.id, agentId: w.agent, profile: renamed, secretSha256: hashClientSecret(secret), credentialId: fresh }));
    expect(await verify(formatClientCredential(fresh, secret))).toMatchObject({ ok: true });
    // Asking again with nothing stale waiting still returns the one waiting id.
    const other = await world();
    const waiting = await withSystem((db) => allocateClientCredentialId(db, { orgId: other.org.id, agentId: other.agent }));
    expect(await withSystem((db) => allocateClientCredentialId(db, { orgId: other.org.id, agentId: other.agent }))).toBe(waiting);
  });

  it("is refused for another workspace's employee, an agency employee, and an employee with no profile yet", async () => {
    const a = await world();
    const b = await world();
    await expect(withSystem((db) => allocateClientCredentialId(db, { orgId: b.org.id, agentId: a.agent }))).rejects.toMatchObject({ code: "not_found" });
    const bare = await createOrg({ kind: "client" });
    const bareAgent = await agentId(bare.id, "lead_hunter");
    await expect(withSystem((db) => allocateClientCredentialId(db, { orgId: bare.id, agentId: bareAgent }))).rejects.toMatchObject({ code: "conflict" });
    const internal = await agencyEmployee();
    await expect(withSystem((db) => allocateClientCredentialId(db, { orgId: internal.org.id, agentId: internal.agent }))).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("rotation", () => {
  it("keeps the previous credential for 48 hours, then it expires, and both verify in between", async () => {
    const w = await world();
    const now = new Date();
    const first = await issue(w, { now });
    const second = await issue(w, { now: after(now, 1) });
    expect(await verify(first.token, after(now, 2))).toMatchObject({ ok: true, claims: { credentialId: first.id, status: "rotating_out" } });
    expect(await verify(second.token, after(now, 2))).toMatchObject({ ok: true, claims: { credentialId: second.id, status: "active" } });
    expect((await row(first.id)).status).toBe("rotating_out");
    expect((await row(first.id)).expires_at.getTime()).toBe(after(now, 1 + CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS).getTime());
    expect(await verify(first.token, after(now, 1 + CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS - 1))).toMatchObject({ ok: true });
    expect(await verify(first.token, after(now, 1 + CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS))).toMatchObject({ ok: false, reason: "expired" });
    expect(await verify(second.token, after(now, 1 + CLIENT_CREDENTIAL_ROTATION_OVERLAP_HOURS))).toMatchObject({ ok: true });
    expect(await audits(CLIENT_CREDENTIAL_AUDIT.rotated, w.org.id)).toHaveLength(1);
  });

  it("never lengthens a credential that was already due to end sooner than the overlap", async () => {
    const w = await world();
    const now = new Date();
    const short = await issue(w, { expiresInDays: 1, now });
    const before = (await row(short.id)).expires_at.getTime();
    await issue(w, { now: after(now, 1) });
    expect((await row(short.id)).expires_at.getTime()).toBe(before);
  });

  it("keeps one active and one rotating_out credential: a third registration ends the oldest", async () => {
    const w = await world();
    const now = new Date();
    const first = await issue(w, { now });
    const second = await issue(w, { now: after(now, 1) });
    const third = await issue(w, { now: after(now, 2) });
    expect((await row(first.id))).toMatchObject({ status: "revoked", revoked_reason: "superseded" });
    expect((await row(second.id)).status).toBe("rotating_out");
    expect((await row(third.id)).status).toBe("active");
    expect(await verify(first.token, after(now, 3))).toMatchObject({ ok: false, reason: "revoked" });
    const live = await q<{ status: string }>("select status from agent_business_credentials where agent_instance_id = $1 and status <> 'revoked' order by status", [w.agent]);
    expect(live.map((r) => r.status)).toEqual(["active", "rotating_out"]);
  });

  it("ends the previous credential on the first honoured use of the new one, and not on a use of the old one", async () => {
    const w = await world();
    const now = new Date();
    const first = await issue(w, { now });
    const second = await issue(w, { now: after(now, 1) });
    expect(await withSystem((db) => recordClientCredentialUse(db, w.org.id, first.id, after(now, 2)))).toEqual([]);
    expect((await row(first.id)).status).toBe("rotating_out");
    expect(await withSystem((db) => recordClientCredentialUse(db, w.org.id, second.id, after(now, 3)))).toEqual([first.id]);
    expect(await row(first.id)).toMatchObject({ status: "revoked", revoked_reason: "rotation_complete" });
    expect(await row(second.id)).toMatchObject({ status: "active", use_count: 1 });
    expect((await row(second.id)).last_used_at?.getTime()).toBe(after(now, 3).getTime());
    expect(await verify(first.token, after(now, 4))).toMatchObject({ ok: false, reason: "revoked" });
    expect(await withSystem((db) => recordClientCredentialUse(db, w.org.id, second.id, after(now, 5)))).toEqual([]);
    expect((await row(second.id)).use_count).toBe(2);
  });

  it("does not count a use for a credential of another workspace", async () => {
    const a = await world();
    const b = await world();
    const mine = await issue(a);
    expect(await withSystem((db) => recordClientCredentialUse(db, b.org.id, mine.id))).toEqual([]);
    expect((await row(mine.id)).use_count).toBe(0);
  });
});

describe("revocation", () => {
  it("ends one credential by id, only inside the workspace that owns it", async () => {
    const a = await world();
    const b = await world();
    const mine = await issue(a);
    const theirs = await issue(b);
    expect(await withSystem((db) => revokeClientBusinessCredential(db, b.org.id, mine.id, "operator_request"))).toBe(false);
    expect(await verify(mine.token)).toMatchObject({ ok: true });
    expect(await withSystem((db) => revokeClientBusinessCredential(db, a.org.id, mine.id, "operator_request"))).toBe(true);
    expect(await verify(mine.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(await verify(theirs.token)).toMatchObject({ ok: true });
    expect(await withSystem((db) => revokeClientBusinessCredential(db, a.org.id, mine.id, "operator_request"))).toBe(false);
    expect(await withSystem((db) => revokeClientBusinessCredential(db, a.org.id, "not-a-uuid", "operator_request"))).toBe(false);
  });

  it("ends every credential of one employee and leaves the workspace's other employees alone", async () => {
    const w = await world("lead_hunter");
    const sibling = await colleague(w, "crm_manager");
    const now = new Date();
    const old = await issue(w, { now });
    const current = await issue(w, { now: after(now, 1) });
    const other = await issue(sibling, { now });
    const ended = await withSystem((db) => revokeClientBusinessCredentialsForAgent(db, w.org.id, w.agent, "role_removed"));
    expect(ended.sort()).toEqual([old.id, current.id].sort());
    expect(await verify(old.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(await verify(current.token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(await verify(other.token)).toMatchObject({ ok: true });
    expect(await withSystem((db) => revokeClientBusinessCredentialsForAgent(db, w.org.id, w.agent, "role_removed"))).toEqual([]);
    expect(await withSystem((db) => revokeClientBusinessCredentialsForAgent(db, crypto.randomUUID(), w.agent, "role_removed"))).toEqual([]);
  });

  it("ends every credential of one workspace and no other, whatever state each is in", async () => {
    const a = await world("lead_hunter");
    const b = await world("lead_hunter");
    const analyst = await colleague(a, "performance_analyst");
    const sales = await colleague(a, "sales_assistant");
    const one = await issue(a);
    const rotated = await issue(a);
    const two = await issue(analyst);
    const waiting = await withSystem((db) => allocateClientCredentialId(db, { orgId: a.org.id, agentId: sales.agent }));
    const theirs = await issue(b);
    const ended = await withSystem((db) => revokeClientBusinessCredentialsForOrg(db, a.org.id, "org_suspended"));
    expect(ended.sort()).toEqual([one.id, rotated.id, two.id, waiting].sort());
    for (const token of [one.token, rotated.token, two.token]) expect(await verify(token)).toMatchObject({ ok: false, reason: "revoked" });
    expect(await verify(theirs.token)).toMatchObject({ ok: true });
    expect(await withSystem((db) => revokeClientBusinessCredentialsForOrg(db, a.org.id, "org_suspended"))).toEqual([]);
    expect(await withSystem((db) => revokeClientBusinessCredentialsForOrg(db, "not-a-uuid", "org_suspended"))).toEqual([]);
  });

  it("records the reason as a short code and refuses free text, changing nothing", async () => {
    const w = await world();
    const issued = await issue(w);
    for (const reason of ["The client asked us to stop", "ORG_SUSPENDED", "x", "a".repeat(61), "", "line\nbreak"]) {
      await expect(withSystem((db) => revokeClientBusinessCredential(db, w.org.id, issued.id, reason)), reason).rejects.toMatchObject({ code: "invalid_input" });
    }
    expect((await row(issued.id)).status).toBe("active");
    await withSystem((db) => revokeClientBusinessCredential(db, w.org.id, issued.id, "org_suspended"));
    expect((await row(issued.id)).revoked_reason).toBe("org_suspended");
  });

  it("closes credentials whose time has run out, and only those", async () => {
    const w = await world();
    const now = new Date();
    const short = await issue(w, { expiresInDays: 1, now });
    const rotated = await issue(w, { now });
    const swept = await withSystem((db) => expireClientBusinessCredentials(db, after(now, 24 * 30 * 12)));
    expect(swept).toBeGreaterThanOrEqual(2);
    expect(await row(short.id)).toMatchObject({ status: "revoked", revoked_reason: "expired" });
    expect((await row(rotated.id)).status).toBe("revoked");
    expect(await withSystem((db) => expireClientBusinessCredentials(db, after(now, 24 * 30 * 12)))).toBe(0);
    const fresh = await issue(w, { now: after(now, 24 * 30 * 12) });
    expect(await withSystem((db) => expireClientBusinessCredentials(db, after(now, 24 * 30 * 12 + 1)))).toBe(0);
    expect((await row(fresh.id)).status).toBe("active");
    expect((await audits(CLIENT_CREDENTIAL_AUDIT.expired, w.org.id)).map((r) => r.target_id).sort()).toEqual([short.id, rotated.id].sort());
  });
});

describe("what is written down", () => {
  it("audits issue, rotation and revocation with the credential id and a reason code only, under the workspace that owns it", async () => {
    const a = await world();
    const b = await world();
    const first = await issue(a);
    const second = await issue(a);
    await issue(b);
    await withSystem((db) => revokeClientBusinessCredential(db, a.org.id, second.id, "operator_request"));
    const issued = await audits(CLIENT_CREDENTIAL_AUDIT.issued, a.org.id);
    expect(issued.map((r) => r.target_id).sort()).toEqual([first.id, second.id].sort());
    for (const entry of issued) {
      expect(entry).toMatchObject({ org_id: a.org.id, actor_kind: "system", agent_instance_id: a.agent, target_type: "client_business_credential", result: "success" });
      expect(entry.metadata).toEqual({ jti: entry.target_id });
    }
    expect(await audits(CLIENT_CREDENTIAL_AUDIT.rotated, a.org.id)).toEqual([expect.objectContaining({ target_id: first.id, metadata: { jti: first.id } })]);
    expect(await audits(CLIENT_CREDENTIAL_AUDIT.revoked, a.org.id)).toEqual([expect.objectContaining({ target_id: second.id, metadata: { jti: second.id, reason: "operator_request" } })]);
    // Workspace B has its own issue row and none of A's.
    expect((await audits(CLIENT_CREDENTIAL_AUDIT.issued, b.org.id)).every((r) => r.org_id === b.org.id)).toBe(true);
    expect(await audits(CLIENT_CREDENTIAL_AUDIT.revoked, b.org.id)).toEqual([]);
  });

  it("writes no audit row when nothing was ended", async () => {
    const w = await world();
    const issued = await issue(w);
    await withSystem((db) => revokeClientBusinessCredential(db, w.org.id, issued.id, "operator_request"));
    const before = (await audits(CLIENT_CREDENTIAL_AUDIT.revoked, w.org.id)).length;
    await withSystem((db) => revokeClientBusinessCredential(db, w.org.id, issued.id, "operator_request"));
    await withSystem((db) => revokeClientBusinessCredentialsForAgent(db, w.org.id, w.agent, "operator_request"));
    await withSystem((db) => revokeClientBusinessCredentialsForOrg(db, w.org.id, "operator_request"));
    expect((await audits(CLIENT_CREDENTIAL_AUDIT.revoked, w.org.id)).length).toBe(before);
  });

  it("keeps the secret out of every table, and the hash out of every table but the ledger, after every kind of operation", async () => {
    const w = await world();
    const now = new Date();
    const secrets: string[] = [];
    const tokens: string[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const issued = await issue(w, { now: after(now, i) });
      secrets.push(issued.secret);
      tokens.push(issued.token);
      hashes.push(hashClientSecret(issued.secret));
      await verify(issued.token, after(now, i));
      await verify(formatClientCredential(issued.id, generateClientCredentialSecret()), after(now, i));
      await withSystem((db) => recordClientCredentialUse(db, w.org.id, issued.id, after(now, i)));
    }
    await withSystem((db) => revokeClientBusinessCredentialsForAgent(db, w.org.id, w.agent, "operator_request"));
    await withSystem((db) => expireClientBusinessCredentials(db, after(now, 24 * 500)));

    const tables = (await q<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1")).map((r) => r.relname);
    expect(tables).toContain("audit_logs");
    expect(tables).toContain("agent_business_credentials");
    const dump = new Map<string, string>();
    await withSystem(async (db) => {
      for (const table of tables) {
        const { rows } = await db.query<{ t: string }>(`select coalesce(string_agg(to_jsonb(x)::text, E'\\n'), '') as t from "${table}" x`);
        dump.set(table, rows[0].t);
      }
    });
    expect(dump.get("agent_business_credentials")).toContain(hashes[0]);
    for (const [table, text] of dump) {
      for (const secret of secrets) expect(text, `${table} holds a secret`).not.toContain(secret);
      for (const token of tokens) expect(text, `${table} holds a credential`).not.toContain(token);
      expect(text, `${table} holds the credential prefix with a secret`).not.toMatch(new RegExp(`${CLIENT_CREDENTIAL_PREFIX}\\.[0-9a-f-]{36}\\.[A-Za-z0-9_-]{43}`));
      if (table === "agent_business_credentials") continue;
      for (const hash of hashes) expect(text, `${table} holds a hash`).not.toContain(hash);
    }
  });

  it("covers every new audit action under the credential family's one prefix", () => {
    for (const action of Object.values(CLIENT_CREDENTIAL_AUDIT)) expect(action).toMatch(/^hermes\.client_business_mcp\.credential_[a-z]+$/);
    expect(new Set(Object.values(CLIENT_CREDENTIAL_AUDIT)).size).toBe(4);
  });
});

describe("every role", () => {
  it("is verified as its own role, for all six", async () => {
    for (const role of AGENT_ROLE_KEYS) {
      const w = await world(role);
      const issued = await issue(w);
      const result = await verify(issued.token);
      expect(result.ok && result.claims.role, role).toBe(role);
    }
  });
});
