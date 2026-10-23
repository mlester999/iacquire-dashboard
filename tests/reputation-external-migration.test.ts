import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";

// Migration 0095 (public reviews read from a review site, and replies to them): what it adds, what its constraints refuse, who can read what, that the application role can
// change none of it, and that its rollback runs on an unused database and refuses once a connection, a mirrored review or a reply exists. Every case that writes runs inside a
// transaction that is always rolled back (or removes what it committed), so the shared test database is untouched. (The same migration is also rehearsed on a populated
// database by scripts/rehearse-combined-migrations.mjs.)

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0095_external_reviews.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };

/** Runs a statement in a savepoint and says whether it was accepted (the savepoint is always rolled back). */
async function accepted(db: Db, sql: string, params: unknown[] = []): Promise<{ ok: boolean; message: string }> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    return { ok: true, message: "" };
  } catch (e) {
    return { ok: false, message: String((e as Error).message) };
  } finally {
    await db.query("rollback to savepoint probe");
  }
}

async function world() {
  const org = await createOrg({ name: "Migration External Reviews Co" });
  const other = await createOrg({ name: "Other Migration External Reviews Co" });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  return { org, other, owner };
}

let seq = 0;
const unique = () => `${Date.now().toString(36)}${(seq += 1)}`;

const CONNECTION = `insert into review_connections (org_id, provider, adapter, external_location_id, name, credentials, status, can_reply)
  values ($1, $2, $3, $4, 'Harbor Dental', $5, 'connected', false) returning id`;
const connect = async (db: Db, orgId: string, over: { provider?: string; adapter?: string; location?: string; credentials?: string | null } = {}) =>
  (await db.query<{ id: string }>(CONNECTION, [orgId, over.provider ?? "google", over.adapter ?? "simulated", over.location ?? `loc-${unique()}`, over.credentials === undefined ? "sealed-secret" : over.credentials])).rows[0].id;

const REVIEW = "insert into external_reviews (org_id, connection_id, provider_review_id, rating, recommends, comment, simulated) values ($1, $2, $3, $4, $5, $6, true) returning id";
const review = async (db: Db, orgId: string, connectionId: string, o: { id?: string; rating?: number | null; recommends?: boolean | null; comment?: string | null } = {}) =>
  (await db.query<{ id: string }>(REVIEW, [orgId, connectionId, o.id ?? `r-${unique()}`, o.rating === undefined ? 3 : o.rating, o.recommends ?? null, o.comment ?? "Fine."])).rows[0].id;

const REPLY = "insert into review_replies (org_id, review_id, body, status, version, approved_version, approved_hash, approved_by, approved_at, sending_at, posted_at, posted_via) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) returning id";
const reply = async (db: Db, orgId: string, reviewId: string, o: { body?: string; status?: string; version?: number; approvedVersion?: number | null; hash?: string | null; by?: string | null; sendingAt?: string | null; postedAt?: string | null; via?: string | null } = {}) =>
  (await db.query<{ id: string }>(REPLY, [orgId, reviewId, o.body ?? "Thank you for your feedback.", o.status ?? "draft", o.version ?? 1, o.approvedVersion ?? null, o.hash ?? null, o.by ?? null, o.by ? new Date().toISOString() : null, o.sendingAt ?? null, o.postedAt ?? null, o.via ?? null])).rows[0].id;
const HASH = "a".repeat(64);

describe("migration 0095: what it adds", () => {
  it("adds the five tables, with row-level security on each and no grant to anyone but the application role's reads", async () => {
    await expect(withSystem(async (db) => {
      const tables = ["review_connections", "review_oauth_states", "external_reviews", "review_replies", "review_reply_events"];
      const { rows } = await db.query<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[]) order by relname", [tables]);
      expect(rows.map((r) => r.relname)).toEqual([...tables].sort());
      expect(rows.every((r) => r.relrowsecurity)).toBe(true);
      const priv = async (table: string, p: string) => (await db.query<{ ok: boolean }>("select has_table_privilege('iaq_app_user', $1, $2) as ok", [table, p])).rows[0].ok;
      // The mirror, the replies and their history are read-only for the application role: a review reaches the mirror only from the sync that reads the site.
      for (const t of ["external_reviews", "review_replies", "review_reply_events"]) {
        expect(await priv(t, "SELECT"), `${t} select`).toBe(true);
        for (const p of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) expect(await priv(t, p), `${t} ${p}`).toBe(false);
      }
      // The connection is readable column by column, never as a whole table, and never written.
      expect(await priv("review_connections", "SELECT")).toBe(false);
      for (const p of ["INSERT", "UPDATE", "DELETE"]) expect(await priv("review_connections", p), `connections ${p}`).toBe(false);
      // The sign-in state is server-only.
      for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(await priv("review_oauth_states", p), `states ${p}`).toBe(false);
      for (const role of ["anon", "authenticated"]) {
        const has = (await db.query<{ ok: boolean }>("select exists (select 1 from information_schema.role_table_grants where grantee = $1 and table_name = any($2::text[])) as ok", [role, tables])).rows[0].ok;
        expect(has, role).toBe(false);
      }
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("keeps a connection's credentials out of the application role's reach, column by column", async () => {
    await expect(withSystem(async (db) => {
      const cols = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'review_connections' order by ordinal_position")).rows.map((r) => r.column_name);
      expect(cols).toContain("credentials");
      for (const c of cols) {
        const ok = (await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', 'review_connections', $1, 'SELECT') as ok", [c])).rows[0].ok;
        expect(ok, c).toBe(c !== "credentials");
      }
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("starts empty, with the columns the screens and the sync rely on", async () => {
    await expect(withSystem(async (db) => {
      for (const t of ["review_connections", "external_reviews", "review_replies", "review_reply_events", "review_oauth_states"]) expect((await db.query(`select 1 from ${t}`)).rows, t).toHaveLength(0);
      const cols = async (table: string) => (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table])).rows.map((r) => r.column_name);
      expect(await cols("external_reviews")).toEqual(expect.arrayContaining(["connection_id", "provider_review_id", "rating", "recommends", "reviewer_name", "reviewer_anonymous", "comment", "provider_created_at", "removed_at", "provider_reply_text", "contact_id", "simulated", "alerted_at"]));
      expect(await cols("review_replies")).toEqual(expect.arrayContaining(["review_id", "version", "body", "origin", "ai_meta", "status", "approved_version", "approved_hash", "approved_by", "sending_at", "posted_at", "posted_via", "verified_at"]));
      expect(await cols("review_connections")).toEqual(expect.arrayContaining(["social_account_id", "credentials", "can_reply", "sync_cursor", "last_complete_at", "reported_rating", "reported_review_count"]));
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});

describe("migration 0095: what its constraints refuse", () => {
  it("refuses a connection that makes no sense: a provider and adapter that do not belong together, credentials where none belong, a live Google connection without them", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const ins = (o: Parameters<typeof connect>[2]) => accepted(db, CONNECTION, [w.org.id, o?.provider ?? "google", o?.adapter ?? "simulated", `loc-${unique()}`, o?.credentials === undefined ? "sealed" : o.credentials]);
      expect((await ins({ provider: "google", adapter: "google" })).ok).toBe(true);
      expect((await ins({ provider: "facebook", adapter: "meta", credentials: null })).ok).toBe(true);
      expect((await ins({ provider: "facebook", adapter: "simulated", credentials: null })).ok).toBe(true);
      expect((await ins({ provider: "facebook", adapter: "google" })).ok).toBe(false); // the Google API does not read Facebook
      expect((await ins({ provider: "google", adapter: "meta", credentials: null })).ok).toBe(false);
      expect((await ins({ provider: "yelp", adapter: "simulated" })).ok).toBe(false);
      expect((await ins({ provider: "facebook", adapter: "meta", credentials: "sealed" })).ok).toBe(false); // a Facebook connection never keeps a copy of the Page's token
      expect((await ins({ provider: "google", adapter: "google", credentials: null })).ok).toBe(false); // a live Google connection holds its sealed sign-in
      expect((await accepted(db, "insert into review_connections (org_id, provider, adapter, external_location_id, name, status) values ($1, 'google', 'google', 'loc-x', 'Gone', 'needs_reauth')", [w.org.id])).ok).toBe(true);
      const id = await connect(db, w.org.id);
      expect((await accepted(db, "update review_connections set status = 'disconnected' where id = $1", [id])).ok).toBe(false); // a disconnected connection holds no credentials
      expect((await accepted(db, "update review_connections set status = 'disconnected', credentials = null, disconnected_at = now() where id = $1", [id])).ok).toBe(true);
      expect((await accepted(db, "update review_connections set reported_rating = 5.5 where id = $1", [id])).ok).toBe(false);
      expect((await accepted(db, "update review_connections set reported_review_count = -1 where id = $1", [id])).ok).toBe(false);
      expect((await accepted(db, "update review_connections set sync_cursor = '[]'::jsonb where id = $1", [id])).ok).toBe(false);
      expect((await accepted(db, "update review_connections set status = 'working' where id = $1", [id])).ok).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("lets one real location belong to one workspace only, while the simulated stand-in is only held to one per workspace", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      await connect(db, w.org.id, { adapter: "google", location: "locations/shared" });
      const twice = await accepted(db, CONNECTION, [w.org.id, "google", "google", "locations/shared", "sealed"]);
      expect(twice.ok).toBe(false);
      expect(twice.message).toMatch(/review_connections_location_idx|duplicate key/);
      const other = await accepted(db, CONNECTION, [w.other.id, "google", "google", "locations/shared", "sealed"]);
      expect(other.ok).toBe(false); // another workspace cannot read the same location
      expect((await accepted(db, CONNECTION, [w.other.id, "facebook", "meta", "locations/shared", null])).ok).toBe(true); // a Facebook Page with the same id text is a different thing
      // After a disconnect the location is free for anyone.
      await db.query("update review_connections set status = 'disconnected', credentials = null where provider = 'google' and external_location_id = 'locations/shared'");
      expect((await accepted(db, CONNECTION, [w.other.id, "google", "google", "locations/shared", "sealed"])).ok).toBe(true);
      await connect(db, w.org.id, { adapter: "simulated", location: "sim-1" });
      expect((await accepted(db, CONNECTION, [w.org.id, "google", "simulated", "sim-1", "sealed"])).ok).toBe(false);
      expect((await accepted(db, CONNECTION, [w.other.id, "google", "simulated", "sim-1", "sealed"])).ok).toBe(true);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("reuses a social account only inside the workspace, and only for a Facebook connection", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const account = async (orgId: string, name: string) =>
        (await db.query<{ id: string }>("insert into social_accounts (org_id, platform, adapter, external_id, name, credentials) values ($1, 'facebook', 'simulated', $2, $3, 'sealed') returning id", [orgId, `page-${unique()}`, name])).rows[0].id;
      const mine = await account(w.org.id, "Harbor Page");
      const theirs = await account(w.other.id, "Other Page");
      const INS = "insert into review_connections (org_id, provider, adapter, external_location_id, name, social_account_id) values ($1, $2, 'simulated', $3, 'Page', $4)";
      expect((await accepted(db, INS, [w.org.id, "facebook", `p-${unique()}`, mine])).ok).toBe(true);
      const foreign = await accepted(db, INS, [w.org.id, "facebook", `p-${unique()}`, theirs]);
      expect(foreign.ok).toBe(false);
      expect(foreign.message).toMatch(/foreign key/);
      expect((await accepted(db, INS, [w.org.id, "google", `p-${unique()}`, mine])).ok).toBe(false);
      // A social account that a connection reads through cannot be deleted from under it.
      await db.query(INS, [w.org.id, "facebook", `p-${unique()}`, mine]);
      const gone = await accepted(db, "delete from social_accounts where id = $1", [mine]);
      expect(gone.ok).toBe(false);
      expect(gone.message).toMatch(/foreign key/);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("refuses a mirrored review with neither stars nor a recommendation, stars out of range, and the same review twice", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const c = await connect(db, w.org.id);
      const ins = (o: Parameters<typeof review>[3]) => accepted(db, REVIEW, [w.org.id, c, o?.id ?? `r-${unique()}`, o?.rating === undefined ? 3 : o.rating, o?.recommends ?? null, o?.comment ?? null]);
      expect((await ins({ rating: 5 })).ok).toBe(true);
      expect((await ins({ rating: null, recommends: true })).ok).toBe(true);
      expect((await ins({ rating: null, recommends: false })).ok).toBe(true);
      expect((await ins({ rating: null, recommends: null })).ok).toBe(false);
      expect((await ins({ rating: 0 })).ok).toBe(false);
      expect((await ins({ rating: 6 })).ok).toBe(false);
      expect((await ins({ rating: 4, comment: "x".repeat(4097) })).ok).toBe(false);
      await review(db, w.org.id, c, { id: "same" });
      const twice = await ins({ id: "same" });
      expect(twice.ok).toBe(false);
      expect(twice.message).toMatch(/duplicate key|external_reviews_connection_id_provider_review_id_key/);
      // The same site's id in another connection is a different review.
      const c2 = await connect(db, w.org.id);
      expect((await accepted(db, REVIEW, [w.org.id, c2, "same", 3, null, null])).ok).toBe(true);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("ties a review to a connection and a customer of the same workspace, and a hand-made link to who made it", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const mine = await connect(db, w.org.id);
      const theirs = await connect(db, w.other.id);
      const contactOf = async (orgId: string) => (await db.query<{ id: string }>("insert into contacts (org_id, display_name) values ($1, 'Customer') returning id", [orgId])).rows[0].id;
      const ours = await contactOf(w.org.id);
      const foreignContact = await contactOf(w.other.id);
      const foreignConnection = await accepted(db, REVIEW, [w.org.id, theirs, "x1", 3, null, null]);
      expect(foreignConnection.ok).toBe(false);
      expect(foreignConnection.message).toMatch(/foreign key/);
      const id = await review(db, w.org.id, mine);
      const LINK = "update external_reviews set contact_id = $2, contact_linked_by = $3, contact_linked_at = now() where id = $1";
      expect((await accepted(db, LINK, [id, ours, w.owner.id])).ok).toBe(true);
      const foreign = await accepted(db, LINK, [id, foreignContact, w.owner.id]);
      expect(foreign.ok).toBe(false);
      expect(foreign.message).toMatch(/foreign key/);
      // A customer who is deleted takes the link with them, not the review.
      await db.query(LINK, [id, ours, w.owner.id]);
      await db.query("delete from contacts where id = $1", [ours]);
      const row = (await db.query<{ contact_id: string | null }>("select contact_id from external_reviews where id = $1", [id])).rows[0];
      expect(row.contact_id).toBeNull();
      // A connection cannot be deleted while it still has reviews.
      const del = await accepted(db, "delete from review_connections where id = $1", [mine]);
      expect(del.ok).toBe(false);
      expect(del.message).toMatch(/foreign key/);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("holds a reply to the rules of an approval: a version, a hash and a person, and one open reply per review", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const c = await connect(db, w.org.id);
      const r = await review(db, w.org.id, c);
      const ok = async (o: Parameters<typeof reply>[3]) => (await accepted(db, REPLY, [w.org.id, r, o?.body ?? "Thanks.", o?.status ?? "draft", o?.version ?? 1, o?.approvedVersion ?? null, o?.hash ?? null, o?.by ?? null, o?.by ? new Date().toISOString() : null, o?.sendingAt ?? null, o?.postedAt ?? null, o?.via ?? null])).ok;
      expect(await ok({})).toBe(true);
      expect(await ok({ status: "approved", approvedVersion: 1, hash: HASH, by: w.owner.id })).toBe(true);
      expect(await ok({ status: "approved", approvedVersion: 1, hash: HASH })).toBe(false); // approved by nobody
      expect(await ok({ status: "approved" })).toBe(false); // approved with no version
      expect(await ok({ approvedVersion: 1 })).toBe(false); // a version without its hash
      expect(await ok({ hash: HASH })).toBe(false); // a hash without its version
      expect(await ok({ version: 1, approvedVersion: 2, hash: HASH, by: w.owner.id })).toBe(false); // approval of a version that does not exist yet
      expect(await ok({ hash: "not a hash", approvedVersion: 1 })).toBe(false);
      expect(await ok({ status: "posting", approvedVersion: 1, hash: HASH, by: w.owner.id })).toBe(false); // the intent to send is written first
      expect(await ok({ status: "posting", approvedVersion: 1, hash: HASH, by: w.owner.id, sendingAt: new Date().toISOString() })).toBe(true);
      expect(await ok({ status: "needs_reconciliation", approvedVersion: 1, hash: HASH, by: w.owner.id })).toBe(false);
      expect(await ok({ status: "posted", approvedVersion: 1, hash: HASH, by: w.owner.id })).toBe(false); // posted, with no time or way
      expect(await ok({ status: "posted", approvedVersion: 1, hash: HASH, by: w.owner.id, postedAt: new Date().toISOString(), via: "provider" })).toBe(true);
      expect(await ok({ status: "posted", approvedVersion: 1, hash: HASH, by: w.owner.id, postedAt: new Date().toISOString(), via: "guess" })).toBe(false);
      expect(await ok({ status: "answered" })).toBe(false);
      expect(await ok({ body: "" })).toBe(false);
      expect(await ok({ body: "x".repeat(4097) })).toBe(false);
      expect(await ok({ version: 0 })).toBe(false);

      // One open reply per review; a closed one makes room, and several can be closed.
      const first = await reply(db, w.org.id, r);
      const second = await accepted(db, REPLY, [w.org.id, r, "Another.", "draft", 1, null, null, null, null, null, null, null]);
      expect(second.ok).toBe(false);
      expect(second.message).toMatch(/review_replies_open_idx|duplicate key/);
      for (const status of ["failed", "pending_approval", "changes_requested"]) {
        await db.query("update review_replies set status = $2 where id = $1", [first, status]);
        expect((await accepted(db, REPLY, [w.org.id, r, "Another.", "draft", 1, null, null, null, null, null, null, null])).ok, `a ${status} reply is still open`).toBe(false);
      }
      await db.query("update review_replies set status = 'cancelled' where id = $1", [first]);
      await reply(db, w.org.id, r, { body: "Third." });
      expect((await db.query("select 1 from review_replies where review_id = $1", [r])).rows).toHaveLength(2);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("takes a review's replies and their history with it, and refuses a reply or an event from another workspace", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const c = await connect(db, w.org.id);
      const r = await review(db, w.org.id, c);
      const theirC = await connect(db, w.other.id);
      const theirR = await review(db, w.other.id, theirC);
      const mine = await reply(db, w.org.id, r);
      const wrong = await accepted(db, "insert into review_replies (org_id, review_id, body) values ($1, $2, 'x')", [w.org.id, theirR]);
      expect(wrong.ok).toBe(false);
      expect(wrong.message).toMatch(/foreign key/);
      const EVENT = "insert into review_reply_events (org_id, reply_id, kind, actor_kind, detail) values ($1, $2, $3, $4, $5::jsonb)";
      expect((await accepted(db, EVENT, [w.org.id, mine, "created", "user", "{}"])).ok).toBe(true);
      expect((await accepted(db, EVENT, [w.other.id, mine, "created", "user", "{}"])).ok).toBe(false);
      expect((await accepted(db, EVENT, [w.org.id, mine, "created", "robot", "{}"])).ok).toBe(false);
      expect((await accepted(db, EVENT, [w.org.id, mine, "", "user", "{}"])).ok).toBe(false);
      expect((await accepted(db, EVENT, [w.org.id, mine, "created", "user", JSON.stringify({ text: "x".repeat(3000) })])).ok).toBe(false);
      await db.query(EVENT, [w.org.id, mine, "created", "user", "{}"]);
      await db.query("delete from external_reviews where id = $1", [r]);
      expect((await db.query("select 1 from review_replies where id = $1", [mine])).rows).toHaveLength(0);
      expect((await db.query("select 1 from review_reply_events where reply_id = $1", [mine])).rows).toHaveLength(0);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("keeps a sign-in state to one use per hashed value, and only for Google", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      const STATE = "insert into review_oauth_states (org_id, user_id, provider, state_hash, expires_at) values ($1, $2, $3, $4, now() + interval '10 minutes')";
      const hash = `${"b".repeat(60)}${String(1000 + (seq += 1))}`;
      expect((await accepted(db, STATE, [w.org.id, w.owner.id, "google", hash])).ok).toBe(true);
      await db.query(STATE, [w.org.id, w.owner.id, "google", hash]);
      expect((await accepted(db, STATE, [w.org.id, w.owner.id, "google", hash])).ok).toBe(false);
      expect((await accepted(db, STATE, [w.org.id, w.owner.id, "facebook", `${"c".repeat(60)}0001`])).ok).toBe(false);
      expect((await accepted(db, STATE, [w.org.id, w.owner.id, "google", "short"])).ok).toBe(false);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});

describe("migration 0095: who can read it", () => {
  it("shows each workspace its own connections, reviews and replies and nobody else's, with real sessions, and never a credential", async () => {
    const w = await world();
    const stranger = await createUser();
    await addMember(w.other.id, stranger.id, "owner");
    const outsider = await createUser();
    const ids = await withSystem(async (db) => {
      const mineC = await connect(db, w.org.id);
      const theirC = await connect(db, w.other.id);
      const mine = await review(db, w.org.id, mineC);
      const theirs = await review(db, w.other.id, theirC);
      const myReply = await reply(db, w.org.id, mine);
      const theirReply = await reply(db, w.other.id, theirs);
      await db.query("insert into review_reply_events (org_id, reply_id, kind) values ($1, $2, 'created'), ($3, $4, 'created')", [w.org.id, myReply, w.other.id, theirReply]);
      return { mineC, theirC, mine, theirs, myReply, theirReply };
    });
    try {
      const ids_ = async (userId: string, sql: string) => (await withUser(userId, (db) => db.query<{ id: string }>(sql))).rows.map((r) => r.id);
      const view = "select id from review_connections order by id";
      expect(await ids_(w.owner.id, view)).toEqual([ids.mineC]);
      expect(await ids_(stranger.id, view)).toEqual([ids.theirC]);
      expect(await ids_(outsider.id, view)).toEqual([]);
      expect(await ids_(w.owner.id, "select id from external_reviews")).toEqual([ids.mine]);
      expect(await ids_(stranger.id, "select id from external_reviews")).toEqual([ids.theirs]);
      expect(await ids_(w.owner.id, "select id from review_replies")).toEqual([ids.myReply]);
      expect(await ids_(outsider.id, "select id from review_replies")).toEqual([]);
      expect((await withUser(w.owner.id, (db) => db.query("select * from review_reply_events"))).rows).toHaveLength(1);
      expect((await withUser(outsider.id, (db) => db.query("select * from review_reply_events"))).rows).toHaveLength(0);
      // The credentials column, and every way of writing, are refused to a signed-in member.
      await expect(withUser(w.owner.id, (db) => db.query("select credentials from review_connections"))).rejects.toThrow(/permission denied/);
      await expect(withUser(w.owner.id, (db) => db.query("select * from review_connections"))).rejects.toThrow(/permission denied/);
      await expect(withUser(w.owner.id, (db) => db.query("update external_reviews set rating = 5"))).rejects.toThrow(/permission denied/);
      await expect(withUser(w.owner.id, (db) => db.query("insert into external_reviews (org_id, connection_id, provider_review_id, rating) values ($1, $2, 'made-up', 5)", [w.org.id, ids.mineC]))).rejects.toThrow(/permission denied/);
      await expect(withUser(w.owner.id, (db) => db.query("delete from review_replies"))).rejects.toThrow(/permission denied/);
      await expect(withUser(w.owner.id, (db) => db.query("select * from review_oauth_states"))).rejects.toThrow(/permission denied/);
    } finally {
      // Committed rows (a session can only see committed rows): take them away so the rollback tests below start from a database without reviews.
      await withSystem(async (db) => {
        for (const t of ["review_reply_events", "review_replies", "external_reviews", "review_connections"]) await db.query(`delete from ${t} where org_id = any($1::uuid[])`, [[w.org.id, w.other.id]]);
      });
    }
  });
});

describe("migration 0095: its rollback", () => {
  const runDown = async (db: Db) => {
    for (const stmt of statements(down)) await db.query(stmt);
  };

  it("runs on a database where review reading was never used, and drops everything it added", async () => {
    const w = await world();
    await expect(withSystem(async (db) => {
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, 'reputation_reviews', true)", [w.org.id]);
      await db.query("insert into review_oauth_states (org_id, user_id, provider, state_hash, expires_at) values ($1, $2, 'google', $3, now() + interval '10 minutes')", [w.org.id, w.owner.id, "d".repeat(64)]);
      await runDown(db);
      const has = async (sql: string, params: unknown[] = []) => (await db.query(sql, params)).rows.length > 0;
      expect(await has("select 1 from information_schema.tables where table_name in ('review_connections', 'review_oauth_states', 'external_reviews', 'review_replies', 'review_reply_events')")).toBe(false);
      expect(await has("select 1 from pg_policies where policyname in ('review_connections_select', 'external_reviews_select', 'review_replies_select', 'review_reply_events_select')")).toBe(false);
      expect(await has("select 1 from org_features where feature = 'reputation_reviews'")).toBe(false);
      // 0094 is untouched: its permissions and its tables remain.
      expect(await has("select 1 from role_permissions where permission = 'reviews.reply_publish'")).toBe(true);
      expect(await has("select 1 from information_schema.tables where table_name = 'reputation_settings'")).toBe(true);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("refuses once there is a connection, a mirrored review or a reply, each on its own", async () => {
    const w = await world();
    const refuses = async (setup: (db: Db) => Promise<void>) => {
      let message = "";
      await expect(withSystem(async (db) => {
        await setup(db);
        try {
          await runDown(db);
        } catch (e) {
          message = String((e as Error).message);
          throw new Done();
        }
        throw new Error("the rollback ran");
      })).rejects.toBeInstanceOf(Done);
      return message;
    };
    expect(await refuses(async (db) => { await connect(db, w.org.id); })).toMatch(/Rollback refused: review site connections/);
    expect(await refuses(async (db) => {
      const c = await connect(db, w.org.id);
      await db.query("update review_connections set status = 'disconnected', credentials = null where id = $1", [c]);
    })).toMatch(/Rollback refused/); // even a disconnected one: its mirror is history until deliberately exported
    expect(await refuses(async (db) => { await review(db, w.org.id, await connect(db, w.org.id)); })).toMatch(/Rollback refused/);
    expect(await refuses(async (db) => { await reply(db, w.org.id, await review(db, w.org.id, await connect(db, w.org.id))); })).toMatch(/Rollback refused/);
  });
});
