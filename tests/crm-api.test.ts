// The public CRM API (/api/v1/crm): scoped API keys, authentication, scope enforcement, organization isolation, validation and duplicate
// rules shared with the CRM services, idempotent creates, pagination and rate limits. Route handlers are called directly.
import crypto from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { hashIp } from "@/server/security/crypto";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { API_KEY_PATTERN, createApiKey, listApiKeys, permissionsForScopes, revokeApiKey, type ApiScope } from "@/server/crm/api-keys";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { createOpportunity } from "@/server/crm/opportunities";
import { GET as listContactsRoute, POST as createContactRoute } from "@/app/api/v1/crm/contacts/route";
import { GET as getContactRoute, PATCH as patchContactRoute } from "@/app/api/v1/crm/contacts/[id]/route";
import { POST as contactTagsRoute } from "@/app/api/v1/crm/contacts/[id]/tags/route";
import { GET as listOppsRoute, POST as createOppRoute } from "@/app/api/v1/crm/opportunities/route";
import { GET as getOppRoute } from "@/app/api/v1/crm/opportunities/[id]/route";
import { POST as moveStageRoute } from "@/app/api/v1/crm/opportunities/[id]/stage/route";
import { GET as pipelinesRoute } from "@/app/api/v1/crm/pipelines/route";
import { GET as appointmentsRoute } from "@/app/api/v1/crm/appointments/route";
import { GET as tagsRoute } from "@/app/api/v1/crm/tags/route";
import { GET as meRoute } from "@/app/api/v1/crm/me/route";
import { crmOrg, type CrmOrg } from "./support/crm";

const BASE = "http://localhost/api/v1/crm";
const randomIp = () => `198.51.100.${Math.floor(Math.random() * 250) + 1}`;

function req(path: string, opts: { key?: string | null; auth?: string; method?: string; body?: unknown; headers?: Record<string, string>; ip?: string } = {}) {
  const headers: Record<string, string> = { "x-forwarded-for": opts.ip ?? randomIp(), ...opts.headers };
  if (opts.auth !== undefined) headers.authorization = opts.auth;
  else if (opts.key) headers.authorization = `Bearer ${opts.key}`;
  if (opts.body !== undefined && !headers["content-type"]) headers["content-type"] = "application/json";
  return new Request(`${BASE}${path}`, { method: opts.method ?? (opts.body !== undefined ? "POST" : "GET"), headers, body: opts.body === undefined ? undefined : typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body) });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const json = async (res: Response) => (await res.json()) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const ALL: ApiScope[] = ["contacts.read", "contacts.write", "opportunities.read", "opportunities.write", "appointments.read", "tags.read", "tags.write"];
async function keyFor(org: CrmOrg, scopes: ApiScope[] = ALL, name = "Test app") {
  const r = await createApiKey(org.actor("owner"), { name, scopes, expiresInDays: null });
  return { id: r.key.id, secret: r.secret };
}
const email = (p = "api") => `${p}-${crypto.randomUUID().slice(0, 8)}@example.test`;

let a: CrmOrg;
let b: CrmOrg;
let keyA: { id: string; secret: string };
let keyB: { id: string; secret: string };
beforeAll(async () => {
  a = await crmOrg({ name: "API Co" });
  b = await crmOrg({ name: "Other API Co" });
  keyA = await keyFor(a);
  keyB = await keyFor(b);
});

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------

describe("API keys", () => {
  it("are shown once, stored as a hash the app role can't read, listed by prefix, and managed only with crm.api.manage", async () => {
    const org = await crmOrg();
    const created = await createApiKey(org.actor("manager"), { name: "  Zapier   bridge ", scopes: ["contacts.read", "tags.write"], expiresInDays: 90 });
    expect(created.secret).toMatch(API_KEY_PATTERN);
    expect(created.secret.startsWith(`${created.key.prefix}_`)).toBe(true);
    expect(created.key).toMatchObject({ name: "Zapier bridge", scopes: ["contacts.read", "tags.write"], state: "active", lastUsedAt: null });
    expect(new Date(created.key.expiresAt!).getTime() - Date.now()).toBeGreaterThan(89 * 86_400_000);
    const stored = await withSystem((db) => db.query<{ key_hash: string }>("select key_hash from crm_api_keys where id = $1", [created.key.id]));
    expect(stored.rows[0].key_hash).toBe(crypto.createHash("sha256").update(created.secret).digest("hex"));
    expect(JSON.stringify(await listApiKeys(org.actor("owner")))).not.toContain(created.secret.slice(11));
    await expect(withUser(org.people.owner.id, (db) => db.query("select key_hash from crm_api_keys"))).rejects.toThrow(/permission denied/);
    const visible = await withUser(org.people.owner.id, (db) => db.query("select id, key_prefix, scopes from crm_api_keys"));
    expect(visible.rows).toHaveLength(1);
    expect((await withUser(org.people.sales.id, (db) => db.query("select id from crm_api_keys"))).rows).toHaveLength(0);
    await expect(createApiKey(org.actor("sales"), { name: "x", scopes: ["contacts.read"] })).rejects.toThrow(/role/);
    await expect(createApiKey(org.system, { name: "x", scopes: ["contacts.read"] })).rejects.toThrow(/Only people/);
    await expect(createApiKey(org.actor("owner"), { name: "x", scopes: ["contacts.delete"] })).rejects.toThrow(/isn't a permission/);
    await expect(createApiKey(org.actor("owner"), { name: "x", scopes: [] })).rejects.toThrow(/at least one/);
    await expect(createApiKey(org.actor("owner"), { name: "x", scopes: ["contacts.read"], expiresInDays: 7 })).rejects.toThrow(/expires/);
    await expect(revokeApiKey(b.actor("owner"), created.key.id)).rejects.toThrow(/not found/);
    await revokeApiKey(org.actor("owner"), created.key.id);
    await revokeApiKey(org.actor("owner"), created.key.id);
    expect((await listApiKeys(org.actor("owner")))[0].state).toBe("revoked");
    const audit = await withSystem((db) => db.query<{ action: string }>("select action from audit_logs where org_id = $1 and action like 'crm.api_key%' order by id", [org.org.id]));
    expect(audit.rows.map((r) => r.action)).toEqual(["crm.api_key_created", "crm.api_key_revoked"]);
  });

  it("map scopes to CRM permissions without granting anything else", () => {
    const read = permissionsForScopes(["contacts.read"]);
    expect([...read].sort()).toEqual(["contacts.view", "crm.view"]);
    const write = permissionsForScopes(["opportunities.write"]);
    expect(write.has("opportunities.edit")).toBe(true);
    expect(write.has("opportunities.reopen")).toBe(false);
    expect(write.has("contacts.edit")).toBe(false);
    expect(permissionsForScopes(["crm.api.manage", "contacts.delete"]).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

describe("authentication", () => {
  it("refuses missing, malformed, unknown, revoked and expired keys with 401 and a clear JSON error", async () => {
    const missing = await meRoute(req("/me"));
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toMatch(/Bearer/);
    const body = await json(missing);
    expect(body.error).toMatchObject({ code: "unauthorized" });
    expect(body.error.requestId).toMatch(/^req_/);
    expect((await json(await meRoute(req("/me", { auth: "Basic abc" })))).error.code).toBe("unauthorized");
    expect((await json(await meRoute(req("/me", { auth: "Bearer not-a-key" })))).error.message).toMatch(/format/);
    const unknown = `iaq_abcdef_${"A".repeat(43)}`;
    expect((await json(await meRoute(req("/me", { key: unknown })))).error.message).toMatch(/isn't recognised/);

    const org = await crmOrg();
    const revoked = await keyFor(org);
    await revokeApiKey(org.actor("owner"), revoked.id);
    const r = await meRoute(req("/me", { key: revoked.secret }));
    expect(r.status).toBe(401);
    expect((await json(r)).error.message).toMatch(/revoked/);
    const expired = await keyFor(org);
    await withSystem((db) => db.query("update crm_api_keys set expires_at = now() - interval '1 minute' where id = $1", [expired.id]));
    const e = await meRoute(req("/me", { key: expired.secret }));
    expect(e.status).toBe(401);
    expect((await json(e)).error.message).toMatch(/expired/);
  });

  it("accepts a valid key, derives the workspace from it, records its use and returns standard headers", async () => {
    const res = await meRoute(req("/me", { key: keyA.secret }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("iacquire-api-version")).toBe("2026-10-01");
    expect(res.headers.get("x-request-id")).toMatch(/^req_/);
    expect(Number(res.headers.get("x-ratelimit-limit"))).toBe(RATE_LIMITS.crmApiByKey.limit);
    const body = await json(res);
    expect(body.data.workspace).toMatchObject({ id: a.org.id, name: a.org.name });
    expect(body.data.key.scopes).toEqual(ALL);
    const used = await withSystem((db) => db.query<{ last_used_at: Date | null }>("select last_used_at from crm_api_keys where id = $1", [keyA.id]));
    expect(used.rows[0].last_used_at).not.toBeNull();
    // A version the API doesn't speak is refused rather than guessed.
    const v = await meRoute(req("/me", { key: keyA.secret, headers: { "iacquire-version": "2025-01-01" } }));
    expect(v.status).toBe(400);
    expect((await json(v)).error.code).toBe("unsupported_version");
  });

  it("refuses keys of a suspended workspace", async () => {
    const org = await crmOrg();
    const k = await keyFor(org);
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [org.org.id]));
    const res = await meRoute(req("/me", { key: k.secret }));
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("workspace_inactive");
  });

  it("rate limits each key, and bad keys per client address, with 429 and Retry-After", async () => {
    const org = await crmOrg();
    const k = await keyFor(org, ["contacts.read"]);
    const fill = async (bucket: string, rule: { limit: number; windowSeconds: number }) => {
      const ms = rule.windowSeconds * 1000;
      const now = Math.floor(Date.now() / ms) * ms;
      await withSystem(async (db) => {
        for (const start of [now, now + ms]) await db.query("insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, $3) on conflict (bucket_key, window_start) do update set hits = excluded.hits", [bucket, new Date(start).toISOString(), rule.limit]);
      });
    };
    await fill(`${RATE_LIMITS.crmApiByKey.name}:${k.id}`, RATE_LIMITS.crmApiByKey);
    const limited = await listContactsRoute(req("/contacts", { key: k.secret }));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await json(limited)).error.code).toBe("rate_limited");
    // Another key of the same workspace is unaffected.
    const other = await keyFor(org, ["contacts.read"]);
    expect((await listContactsRoute(req("/contacts", { key: other.secret }))).status).toBe(200);

    const ip = "203.0.113.77";
    await fill(`${RATE_LIMITS.crmApiAuthFailureByIp.name}:${hashIp(ip)}`, RATE_LIMITS.crmApiAuthFailureByIp);
    const guessed = await meRoute(req("/me", { key: `iaq_zzzzzz_${"B".repeat(43)}`, ip }));
    expect(guessed.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Scopes and isolation
// ---------------------------------------------------------------------------

describe("scopes and isolation", () => {
  it("enforces each key's scopes", async () => {
    const readOnly = await keyFor(a, ["contacts.read"], "Read only");
    expect((await listContactsRoute(req("/contacts", { key: readOnly.secret }))).status).toBe(200);
    const denied = await createContactRoute(req("/contacts", { key: readOnly.secret, body: { email: email() } }));
    expect(denied.status).toBe(403);
    const body = await json(denied);
    expect(body.error).toMatchObject({ code: "insufficient_scope", details: { required: ["contacts.write"], granted: ["contacts.read"] } });
    const writer = await keyFor(a, ["contacts.write"], "Writer");
    const tagged = await createContactRoute(req("/contacts", { key: writer.secret, body: { email: email(), tags: ["VIP"] } }));
    expect(tagged.status).toBe(403);
    expect((await json(tagged)).error.message).toMatch(/tags\.write/);
    expect((await appointmentsRoute(req("/appointments", { key: writer.secret }))).status).toBe(403);
    expect((await tagsRoute(req("/tags", { key: readOnly.secret }))).status).toBe(403);
    expect((await pipelinesRoute(req("/pipelines", { key: readOnly.secret }))).status).toBe(403);
    expect((await createOppRoute(req("/opportunities", { key: readOnly.secret, body: { name: "Nope" } }))).status).toBe(403);
  });

  it("never reads or changes another workspace's records, whatever ids it is sent", async () => {
    const theirs = await createContact(b.actor("owner"), { firstName: "Private", email: email("private") });
    const theirDeal = await createOpportunity(b.actor("owner"), { name: "Their deal", contactId: theirs.id });
    const mine = await createContact(a.actor("owner"), { firstName: "Mine", email: email("mine") });
    expect((await getContactRoute(req(`/contacts/${theirs.id}`, { key: keyA.secret }), params(theirs.id))).status).toBe(404);
    expect((await patchContactRoute(req(`/contacts/${theirs.id}`, { key: keyA.secret, method: "PATCH", body: { firstName: "Hacked" } }), params(theirs.id))).status).toBe(404);
    expect((await contactTagsRoute(req(`/contacts/${theirs.id}/tags`, { key: keyA.secret, body: { add: ["Stolen"] } }), params(theirs.id))).status).toBe(404);
    expect((await getOppRoute(req(`/opportunities/${theirDeal.id}`, { key: keyA.secret }), params(theirDeal.id))).status).toBe(404);
    expect((await moveStageRoute(req(`/opportunities/${theirDeal.id}/stage`, { key: keyA.secret, body: { stageId: crypto.randomUUID() } }), params(theirDeal.id))).status).toBe(404);
    expect((await createOppRoute(req("/opportunities", { key: keyA.secret, body: { name: "Cross", contactId: theirs.id } }))).status).toBe(404);
    const list = await json(await listContactsRoute(req("/contacts?limit=100", { key: keyA.secret })));
    const ids = (list.data as Array<{ id: string }>).map((c) => c.id);
    expect(ids).toContain(mine.id);
    expect(ids).not.toContain(theirs.id);
    const deals = await json(await listOppsRoute(req("/opportunities?limit=100", { key: keyA.secret })));
    expect((deals.data as Array<{ id: string }>).map((d) => d.id)).not.toContain(theirDeal.id);
    // B's own key sees its record; nothing about A's request changed it.
    const own = await json(await getContactRoute(req(`/contacts/${theirs.id}`, { key: keyB.secret }), params(theirs.id)));
    expect(own.data.firstName).toBe("Private");
    expect(own.data.tags).toEqual([]);
    // A path that isn't an id is a 404, not a server error.
    expect((await getContactRoute(req("/contacts/not-an-id", { key: keyA.secret }), params("not-an-id"))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

describe("contacts", () => {
  it("creates with the CRM's normalization and duplicate rules, as the API key", async () => {
    const addr = email("Create").toUpperCase();
    const res = await createContactRoute(req("/contacts", { key: keyA.secret, body: { firstName: " Ana ", lastName: "Reyes", email: addr, address: { city: "Cebu", country: "PH" }, leadStatus: "qualified", tags: ["Newsletter"] } }));
    expect(res.status).toBe(201);
    const { data } = await json(res);
    expect(data).toMatchObject({ firstName: "Ana", lastName: "Reyes", displayName: "Ana Reyes", email: addr.toLowerCase(), leadStatus: "qualified", address: { city: "Cebu", country: "PH" }, archived: false, version: 1 });
    expect(data.tags.map((t: { name: string }) => t.name)).toEqual(["Newsletter"]);
    const row = await withSystem((db) => db.query<{ created_via: string }>("select created_via from contacts where id = $1", [data.id]));
    expect(row.rows[0].created_via).toBe("api");
    const ev = await withSystem((db) => db.query<{ actor_kind: string; actor_id: string }>("select actor_kind, actor_id from crm_events where entity_id = $1 and type = 'contact.created'", [data.id]));
    expect(ev.rows[0]).toEqual({ actor_kind: "api", actor_id: keyA.id });
    const audit = await withSystem((db) => db.query<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'crm.contact_created' and target_id = $2", [a.org.id, data.id]));
    expect(audit.rows[0].metadata).toMatchObject({ via: "api", keyName: "Test app" });

    const dup = await createContactRoute(req("/contacts", { key: keyA.secret, body: { firstName: "Copy", email: addr } }));
    expect(dup.status).toBe(409);
    expect((await json(dup)).error).toMatchObject({ code: "duplicate_contact", details: { existingContactId: data.id } });
    const badEmail = await createContactRoute(req("/contacts", { key: keyA.secret, body: { email: "nope@" } }));
    expect(badEmail.status).toBe(400);
    expect((await json(badEmail)).error.code).toBe("invalid_request");
    const unknownField = await createContactRoute(req("/contacts", { key: keyA.secret, body: { email: email(), favouriteColour: "blue" } }));
    expect(unknownField.status).toBe(400);
    expect((await json(unknownField)).error.code).toBe("validation_failed");
    const empty = await createContactRoute(req("/contacts", { key: keyA.secret, body: {} }));
    expect(empty.status).toBe(400);
    expect((await createContactRoute(req("/contacts", { key: keyA.secret, body: "{oops", headers: { "content-type": "application/json" } }))).status).toBe(400);
    expect((await createContactRoute(req("/contacts", { key: keyA.secret, body: "name=x", headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(415);
  });

  it("is idempotent per Idempotency-Key: a retry returns the first contact, a different body is refused, concurrent retries create one", async () => {
    const body = { firstName: "Idem", email: email("idem") };
    const key = crypto.randomUUID();
    const first = await createContactRoute(req("/contacts", { key: keyA.secret, body, headers: { "idempotency-key": key } }));
    const second = await createContactRoute(req("/contacts", { key: keyA.secret, body: { email: body.email, firstName: "Idem" }, headers: { "idempotency-key": key } }));
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect((await json(second)).data.id).toBe((await json(first)).data.id);
    const changed = await createContactRoute(req("/contacts", { key: keyA.secret, body: { ...body, firstName: "Other" }, headers: { "idempotency-key": key } }));
    expect(changed.status).toBe(422);
    expect((await json(changed)).error.code).toBe("idempotency_key_reused");

    const race = { firstName: "Race", email: email("race") };
    const raceKey = crypto.randomUUID();
    const results = await Promise.all([1, 2, 3].map(() => createContactRoute(req("/contacts", { key: keyA.secret, body: race, headers: { "idempotency-key": raceKey } }))));
    expect(results.map((r) => r.status)).toEqual([201, 201, 201]);
    const ids = new Set(await Promise.all(results.map(async (r) => (await json(r)).data.id)));
    expect(ids.size).toBe(1);
    const count = await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from contacts where org_id = $1 and email = $2", [a.org.id, race.email]));
    expect(count.rows[0].n).toBe("1");
    // Without a key, a retry is an ordinary duplicate.
    const noKey = await createContactRoute(req("/contacts", { key: keyA.secret, body: race }));
    expect(noKey.status).toBe(409);
    expect((await createContactRoute(req("/contacts", { key: keyA.secret, body: race, headers: { "idempotency-key": "has space" } }))).status).toBe(400);
  });

  it("updates only the fields sent, refuses a stale version and a stolen address", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Patch", lastName: "Me", email: email("patch") });
    const other = await createContact(a.actor("owner"), { firstName: "Owner", email: email("taken") });
    const res = await patchContactRoute(req(`/contacts/${c.id}`, { key: keyA.secret, method: "PATCH", body: { firstName: "Patched", leadScore: 70, version: 1 } }), params(c.id));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.data).toMatchObject({ firstName: "Patched", lastName: "Me", leadScore: 70, version: 2 });
    expect(body.changed).toEqual(expect.arrayContaining(["firstName", "leadScore"]));
    const stale = await patchContactRoute(req(`/contacts/${c.id}`, { key: keyA.secret, method: "PATCH", body: { lastName: "Late", version: 1 } }), params(c.id));
    expect(stale.status).toBe(409);
    const otherEmail = (await json(await getContactRoute(req(`/contacts/${other.id}`, { key: keyA.secret }), params(other.id)))).data.email;
    const stolen = await patchContactRoute(req(`/contacts/${c.id}`, { key: keyA.secret, method: "PATCH", body: { email: otherEmail } }), params(c.id));
    expect(stolen.status).toBe(409);
    expect((await json(stolen)).error.code).toBe("duplicate_contact");
    expect((await patchContactRoute(req(`/contacts/${c.id}`, { key: keyA.secret, method: "PATCH", body: {} }), params(c.id))).status).toBe(400);
    const readOnly = await keyFor(a, ["contacts.read"], "Reader");
    expect((await patchContactRoute(req(`/contacts/${c.id}`, { key: readOnly.secret, method: "PATCH", body: { firstName: "X" } }), params(c.id))).status).toBe(403);
  });

  it("pages with a cursor and searches like the Contacts screen", async () => {
    const org = await crmOrg();
    const k = await keyFor(org, ["contacts.read"]);
    for (const n of ["Alpha", "Bravo", "Charlie"]) await createContact(org.actor("owner"), { firstName: n, email: email(n.toLowerCase()) });
    const p1 = await json(await listContactsRoute(req("/contacts?limit=2", { key: k.secret })));
    expect(p1.data.map((c: { firstName: string }) => c.firstName)).toEqual(["Charlie", "Bravo"]);
    expect(p1.pagination.hasMore).toBe(true);
    const p2 = await json(await listContactsRoute(req(`/contacts?limit=2&cursor=${encodeURIComponent(p1.pagination.nextCursor)}`, { key: k.secret })));
    expect(p2.data.map((c: { firstName: string }) => c.firstName)).toEqual(["Alpha"]);
    expect(p2.pagination).toEqual({ hasMore: false, nextCursor: null });
    const search = await json(await listContactsRoute(req("/contacts?search=brav", { key: k.secret })));
    expect(search.data.map((c: { firstName: string }) => c.firstName)).toEqual(["Bravo"]);
    // Rows created within the same millisecond (microseconds apart) are never skipped between pages.
    const same = await crmOrg();
    const sk = await keyFor(same, ["contacts.read"]);
    const made: Array<{ id: string }> = [];
    for (const n of ["One", "Two", "Three"]) made.push(await createContact(same.actor("owner"), { firstName: n, email: email(n.toLowerCase()) }));
    await withSystem(async (db) => {
      for (const [i, c] of made.entries()) await db.query("update contacts set created_at = $2::timestamptz where id = $1", [c.id, `2026-10-01 09:00:00.1234${i + 1}6+00`]);
    });
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 4; i++) {
      const page: Record<string, any> = await json(await listContactsRoute(req(`/contacts?limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`, { key: sk.secret }))); // eslint-disable-line @typescript-eslint/no-explicit-any
      seen.push(...page.data.map((c: { firstName: string }) => c.firstName));
      cursor = page.pagination.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toEqual(["Three", "Two", "One"]);
    expect((await listContactsRoute(req("/contacts?limit=500", { key: k.secret }))).status).toBe(400);
    expect((await listContactsRoute(req("/contacts?cursor=garbage", { key: k.secret }))).status).toBe(400);
    expect((await listContactsRoute(req("/contacts?updated_since=yesterday", { key: k.secret }))).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe("tags", () => {
  it("adds by name or id (creating new names), removes, records events as the API key, and lists tags", async () => {
    const c = await createContact(a.actor("owner"), { firstName: "Taggy", email: email("tag") });
    const existing = await createTag(a.actor("owner"), { name: "Existing" });
    const res = await contactTagsRoute(req(`/contacts/${c.id}/tags`, { key: keyA.secret, body: { add: ["Hot lead", existing.id] } }), params(c.id));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.added).toBe(2);
    expect(body.data.tags.map((t: { name: string }) => t.name).sort()).toEqual(["Existing", "Hot lead"]);
    const again = await json(await contactTagsRoute(req(`/contacts/${c.id}/tags`, { key: keyA.secret, body: { add: ["hot LEAD"] } }), params(c.id)));
    expect(again.added).toBe(0);
    const removed = await json(await contactTagsRoute(req(`/contacts/${c.id}/tags`, { key: keyA.secret, body: { remove: ["Hot lead", "Never existed"] } }), params(c.id)));
    expect(removed.error).toBeUndefined();
    expect(removed.removed).toBe(1);
    expect(removed.data.tags.map((t: { name: string }) => t.name)).toEqual(["Existing"]);
    const events = await withSystem((db) => db.query<{ type: string; actor_kind: string }>("select type, actor_kind from crm_events where entity_id = $1 and type like 'contact.tag_%' order by id", [c.id]));
    expect(events.rows).toEqual([
      { type: "contact.tag_added", actor_kind: "api" }, { type: "contact.tag_added", actor_kind: "api" }, { type: "contact.tag_removed", actor_kind: "api" },
    ]);
    expect((await contactTagsRoute(req(`/contacts/${c.id}/tags`, { key: keyA.secret, body: { add: [crypto.randomUUID()] } }), params(c.id))).status).toBe(404);
    expect((await contactTagsRoute(req(`/contacts/${c.id}/tags`, { key: keyA.secret, body: {} }), params(c.id))).status).toBe(400);
    const list = await json(await tagsRoute(req("/tags?search=hot", { key: keyA.secret })));
    expect(list.data.map((t: { name: string }) => t.name)).toEqual(["Hot lead"]);
  });
});

// ---------------------------------------------------------------------------
// Deals and appointments
// ---------------------------------------------------------------------------

describe("deals", () => {
  it("creates a deal idempotently, lists pipelines and moves it between stages with the CRM's rules", async () => {
    const org = await crmOrg();
    const k = await keyFor(org, ["opportunities.write", "contacts.read"]);
    const contact = await createContact(org.actor("owner"), { firstName: "Buyer", email: email("buyer") });
    const idem = crypto.randomUUID();
    const res = await createOppRoute(req("/opportunities", { key: k.secret, body: { name: "Kitchen remodel", value: 12500.5, contactId: contact.id }, headers: { "idempotency-key": idem } }));
    expect(res.status).toBe(201);
    const deal = (await json(res)).data;
    expect(deal).toMatchObject({ name: "Kitchen remodel", status: "open", value: 12500.5, contactId: contact.id, source: "api" });
    const replay = await createOppRoute(req("/opportunities", { key: k.secret, body: { name: "Kitchen remodel", value: 12500.5, contactId: contact.id }, headers: { "idempotency-key": idem } }));
    expect((await json(replay)).data.id).toBe(deal.id);
    const pipes = await json(await pipelinesRoute(req("/pipelines", { key: k.secret })));
    const stages = pipes.data[0].stages as Array<{ id: string; name: string; kind: string }>;
    expect(stages[0].id).toBe(deal.stageId);
    const nextOpen = stages.filter((s) => s.kind === "open")[1];
    const moved = await json(await moveStageRoute(req(`/opportunities/${deal.id}/stage`, { key: k.secret, body: { stageId: nextOpen.id } }), params(deal.id)));
    expect(moved).toMatchObject({ changed: true, data: { stageId: nextOpen.id, stageName: nextOpen.name, version: 2 } });
    const same = await json(await moveStageRoute(req(`/opportunities/${deal.id}/stage`, { key: k.secret, body: { stageId: nextOpen.id } }), params(deal.id)));
    expect(same.changed).toBe(false);
    const lost = stages.find((s) => s.kind === "lost")!;
    const noReason = await moveStageRoute(req(`/opportunities/${deal.id}/stage`, { key: k.secret, body: { stageId: lost.id } }), params(deal.id));
    expect(noReason.status).toBe(400);
    const won = stages.find((s) => s.kind === "won")!;
    const closed = await json(await moveStageRoute(req(`/opportunities/${deal.id}/stage`, { key: k.secret, body: { stageId: won.id } }), params(deal.id)));
    expect(closed.data.status).toBe("won");
    // Reopening needs a permission API keys don't have.
    const reopen = await moveStageRoute(req(`/opportunities/${deal.id}/stage`, { key: k.secret, body: { stageId: nextOpen.id } }), params(deal.id));
    expect(reopen.status).toBe(403);
    const stale = await moveStageRoute(req(`/opportunities/${deal.id}/stage`, { key: k.secret, body: { stageId: lost.id, lostReason: "Budget", version: 1 } }), params(deal.id));
    expect(stale.status).toBe(409);
    const wonList = await json(await listOppsRoute(req("/opportunities?status=won", { key: k.secret })));
    expect(wonList.data.map((d: { id: string }) => d.id)).toEqual([deal.id]);
    expect((await listOppsRoute(req("/opportunities?status=maybe", { key: k.secret }))).status).toBe(400);
    expect((await listOppsRoute(req("/opportunities?pipeline_id=nope", { key: k.secret }))).status).toBe(400);
    const events = await withSystem((db) => db.query<{ type: string }>("select type from crm_events where entity_id = $1 order by id", [deal.id]));
    expect(events.rows.map((e) => e.type)).toEqual(["opportunity.created", "opportunity.stage_changed", "opportunity.stage_changed", "opportunity.won"]);
  });
});

describe("appointments", () => {
  it("lists native appointments for keys with appointments.read and validates filters", async () => {
    const org = await crmOrg();
    const k = await keyFor(org, ["appointments.read"]);
    const res = await appointmentsRoute(req("/appointments", { key: k.secret }));
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ data: [], pagination: { hasMore: false, nextCursor: null } });
    expect((await appointmentsRoute(req("/appointments?status=maybe", { key: k.secret }))).status).toBe(400);
    expect((await appointmentsRoute(req("/appointments?from=2026-10-10T00:00:00Z&to=2026-10-01T00:00:00Z", { key: k.secret }))).status).toBe(400);
    expect((await appointmentsRoute(req("/appointments?contact_id=123", { key: k.secret }))).status).toBe(400);
  });
});

describe("routing", () => {
  it("the proxy never redirects API requests to the sign-in page", async () => {
    const { NextRequest } = await import("next/server");
    const { proxy } = await import("@/proxy");
    const res = await proxy(new NextRequest("http://localhost/api/v1/crm/contacts", { headers: { authorization: `Bearer ${keyA.secret}` } }));
    expect(res.headers.get("location")).toBeNull();
  });
});
