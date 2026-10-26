// Migration 0100 (the prospect demo funnel): the schema, who can read it (nobody but trusted server code), what the database itself refuses, how the tables stay in step with the
// code that names them, and a rollback that never drops a lead, a conversation or a conversion. Each rollback case runs inside a transaction that is always rolled back.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { PERMISSION_MATRIX } from "@/lib/permissions";
import { AGENT_ROLE_KEYS } from "@/lib/agents";
import { DEMO_DEFAULTS, DEMO_RANGES } from "@/lib/demo/settings";
import { DEMO_EVENT_KINDS, DEMO_NOTIFICATION_KINDS } from "@/lib/demo/events";
import { PROSPECT_STATUSES } from "@/lib/demo/rules";
import { createUser } from "./support/fixtures";
import { rows } from "./support/demo";

class Done extends Error {}
const up = readFileSync("supabase/migrations/0100_demo_funnel.sql", "utf8");
const down = readFileSync("supabase/rollbacks/0100_demo_funnel.down.sql", "utf8");
const TABLES = ["demo_settings", "demo_prospects", "demo_verifications", "demo_sessions", "demo_messages", "demo_events", "demo_usage_days", "demo_registration_requests"];

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

const prospect = (over: Record<string, string> = {}) => {
  const email = over.email ?? `mig-${Math.random().toString(36).slice(2)}@mig.test`;
  return { email, sql: "insert into demo_prospects (name, work_email, email_normalized, business_name, industry) values ($1, $2, $3, $4, $5) returning id", params: [over.name ?? "Mig Test", email, email, "Mig Co", "other"] };
};
const insertProspect = async () => {
  const p = prospect();
  return (await rows<{ id: string }>(p.sql, p.params))[0].id;
};

describe("the schema", () => {
  it("has the eight tables with row-level security on and no policy, and no table was left without one", async () => {
    const found = await rows<{ relname: string; relrowsecurity: boolean }>("select relname, relrowsecurity from pg_class where relname like 'demo\\_%' and relkind = 'r' order by relname");
    expect(found.map((r) => r.relname)).toEqual([...TABLES].sort());
    expect(found.every((r) => r.relrowsecurity)).toBe(true);
    expect(await rows("select 1 from pg_policies where tablename like 'demo\\_%'")).toEqual([]);
  });

  it("gives no application role, Data API role, public role or published-site role any right on any of them", async () => {
    const roles = (await rows<{ rolname: string }>("select rolname from pg_roles where rolname = any($1::text[])", [["iaq_app_user", "iaq_site_runtime", "anon", "authenticated"]])).map((r) => r.rolname);
    expect(roles).toEqual(expect.arrayContaining(["iaq_app_user", "anon", "authenticated"]));
    for (const role of roles) {
      for (const table of TABLES) {
        for (const privilege of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
          const has = (await rows<{ ok: boolean }>("select has_table_privilege($1, $2, $3) as ok", [role, table, privilege]))[0].ok;
          expect(has, `${role} ${privilege} on ${table}`).toBe(false);
        }
        const columnLevel = await rows("select 1 from information_schema.column_privileges where table_name = $1 and grantee = $2", [table, role]);
        expect(columnLevel, `${role} columns of ${table}`).toEqual([]);
      }
    }
    const toPublic = await rows<{ relname: string }>(
      "select c.relname from pg_class c, lateral aclexplode(c.relacl) a where c.relname like 'demo\\_%' and c.relkind = 'r' and a.grantee = 0",
    );
    expect(toPublic).toEqual([]);
  });

  it("refuses a signed-in person, an owner of a workspace and a Super Admin alike, through the application role", async () => {
    const owner = await createUser({ name: "A workspace owner" });
    const admin = await createUser({ platformRole: "agency_super_admin", name: "A Super Admin" });
    for (const who of [owner, admin]) {
      for (const table of TABLES) {
        await expect(withUser(who.id, (db) => db.query(`select * from ${table}`)), `${who.email} ${table}`).rejects.toThrow(/permission denied/);
        await expect(withUser(who.id, (db) => db.query(`delete from ${table}`)), `${who.email} delete ${table}`).rejects.toThrow(/permission denied/);
      }
    }
    await expect(withUser(admin.id, (db) => db.query("insert into demo_settings (enabled) values (true)"))).rejects.toThrow(/permission denied/);
  });

  it("points at no user, workspace, membership, invitation or sign-in except the few agency people and the one conversion it records", async () => {
    const links = (await rows<{ t: string; col: string; ref: string; del: string }>(
      `select c.conrelid::regclass::text as t, a.attname as col, c.confrelid::regclass::text as ref, c.confdeltype::text as del
       from pg_constraint c join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
       where c.contype = 'f' and c.conrelid::regclass::text like 'demo\\_%' order by 1, 2`,
    )).map((l) => `${l.t}.${l.col}->${l.ref}:${l.del}`);
    // 'n' = set null, 'c' = cascade: removing an agency person or a workspace never removes a prospect or its history.
    expect(links).toEqual([
      "demo_events.actor_id->users:n",
      "demo_events.prospect_id->demo_prospects:c",
      "demo_messages.prospect_id->demo_prospects:c",
      "demo_messages.reply_to_id->demo_messages:c",
      "demo_prospects.access_request_id->access_requests:n",
      "demo_prospects.conversion_claimed_by->users:n",
      "demo_prospects.converted_org_id->organizations:n",
      "demo_prospects.owner_user_id->users:n",
      "demo_sessions.prospect_id->demo_prospects:c",
      "demo_settings.updated_by->users:n",
      "demo_verifications.prospect_id->demo_prospects:c",
    ]);
    // And no column that names a user could hold a prospect: the table of prospects has none called user_id.
    expect(await rows("select 1 from information_schema.columns where table_name like 'demo\\_%' and column_name in ('user_id', 'org_id', 'membership_id')")).toEqual([]);
  });

  it("starts empty and off: no settings row exists until a Super Admin saves one, and the defaults are off", async () => {
    // (This file's database has had no Super Admin save: the demo is off because there is nothing saying otherwise.)
    expect(await rows("select 1 from demo_settings")).toEqual([]);
    expect(DEMO_DEFAULTS.enabled).toBe(false);
    expect(DEMO_DEFAULTS.aiEnabled).toBe(false);
    await expect(
      withSystem(async (db) => {
        await db.query("insert into demo_settings default values");
        const row = (await db.query<Record<string, unknown>>("select * from demo_settings")).rows[0];
        expect(row).toMatchObject({ enabled: false, ai_enabled: false, window_hours: 24, message_limit: 10, max_extension_hours: 72, max_extra_messages: 20, retention_days: 90, version: 1 });
        expect(row.consultation_url).toBeNull();
        // There can only ever be the one row.
        let second: unknown = null;
        try {
          await db.query("insert into demo_settings (id) values (true)");
        } catch (e) {
          second = e;
        }
        expect(String(second)).toMatch(/duplicate key/);
        throw new Done();
      }),
    ).rejects.toBeInstanceOf(Done);
  });
});

describe("the code and the database name the same things", () => {
  it("has the settings' ranges and defaults as check constraints and column defaults", () => {
    const columns: Record<keyof typeof DEMO_RANGES, string> = {
      windowHours: "window_hours", messageLimit: "message_limit", maxExtensionHours: "max_extension_hours", maxExtraMessages: "max_extra_messages",
      dailyStartCap: "daily_start_cap", dailyMessageCap: "daily_message_cap", retentionDays: "retention_days",
    };
    for (const [key, column] of Object.entries(columns) as Array<[keyof typeof DEMO_RANGES, string]>) {
      const m = new RegExp(`${column} integer not null default (\\d+) check \\(${column} between (\\d+) and (\\d+)\\)`).exec(up);
      expect(m, column).not.toBeNull();
      expect([Number(m?.[2]), Number(m?.[3])], column).toEqual([...DEMO_RANGES[key]]);
      expect(Number(m?.[1]), `${column} default`).toBe(DEMO_DEFAULTS[key]);
    }
  });

  it("allows exactly the statuses, timeline kinds, personas and notification kinds that the code lists", async () => {
    const quoted = (sql: string) => [...sql.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    const statusList = /status text not null default 'unverified' check \(status in \(([^)]*)\)\)/.exec(up)?.[1] ?? "";
    expect(quoted(statusList)).toEqual([...PROSPECT_STATUSES]);
    const kindList = /kind text not null check \(kind in \(([^)]*)\)\)/.exec(up)?.[1] ?? "";
    expect(quoted(kindList)).toEqual([...DEMO_EVENT_KINDS]);
    const personaList = /employee_role text check \(employee_role is null or employee_role in \(([^)]*)\)\)/.exec(up)?.[1] ?? "";
    expect(quoted(personaList)).toEqual([...AGENT_ROLE_KEYS]);
    // The live notification constraint accepts the new kinds and still every older one.
    const live = (await rows<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check'"))[0].def;
    for (const k of DEMO_NOTIFICATION_KINDS) expect(live, k).toContain(`'${k}'`);
    for (const old of ["support_sla", "social_post_failed", "proposal_accepted", "invoice_paid", "system"]) expect(live, old).toContain(`'${old}'`);
    const user = await createUser({ platformRole: "agency_manager", name: "Notice Reader" });
    for (const kind of DEMO_NOTIFICATION_KINDS) await rows("insert into notifications (user_id, kind, title, audience) values ($1, $2, 'ok', 'direct')", [user.id, kind]);
    await expect(rows("insert into notifications (user_id, kind, title, audience) values ($1, 'demo_made_up', 'no', 'direct')", [user.id])).rejects.toThrow(/notifications_kind_check/);
  });

  it("gives the two permissions to exactly the roles the code gives them to", async () => {
    for (const permission of ["agency.prospects.view", "agency.prospects.manage"] as const) {
      const seeded = (await rows<{ role: string }>("select role from role_permissions where permission = $1 order by role", [permission])).map((r) => r.role);
      expect(seeded, permission).toEqual([...PERMISSION_MATRIX[permission]].sort());
    }
    expect([...PERMISSION_MATRIX["agency.prospects.manage"]]).toEqual(["agency_super_admin"]);
    expect(PERMISSION_MATRIX["agency.prospects.view"]).not.toContain("agency_staff");
    // Neither can be handed to one person: the per-person override list does not accept them.
    const user = await createUser({ platformRole: "agency_staff", name: "Wants it" });
    const admin = await createUser({ platformRole: "agency_super_admin", name: "Grants it" });
    for (const permission of ["agency.prospects.view", "agency.prospects.manage"]) {
      await expect(rows("insert into agency_user_permission_overrides (user_id, permission, effect, updated_by) values ($1, $2, 'allow', $3)", [user.id, permission, admin.id]), permission).rejects.toThrow(/agency_user_permission_overrides_permission_check/);
    }
  });
});

describe("what the database refuses on its own", () => {
  it("keeps one prospect per normalized address, and refuses to hold an erased and an unerased prospect in the wrong shape", async () => {
    const p = prospect();
    await rows(p.sql, p.params);
    await expect(rows(p.sql, [...p.params.slice(0, 1), `other-${p.email}`, p.params[2], ...p.params.slice(3)])).rejects.toThrow(/duplicate key/);
    // Details missing without an erasure, and details kept with one: both refused.
    await expect(rows("insert into demo_prospects (name, work_email, email_normalized) values (null, 'x@y.test', 'x@y.test')")).rejects.toThrow(/check/);
    const id = await insertProspect();
    await expect(rows("update demo_prospects set erased_at = now() where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set name = null where id = $1", [id])).rejects.toThrow(/check/);
    await rows("update demo_prospects set name = null, work_email = null, email_normalized = null, business_name = null, erased_at = now() where id = $1", [id]);
    await expect(rows("update demo_prospects set name = 'Back again' where id = $1", [id])).rejects.toThrow(/check/);
  });

  it("refuses a state that does not fit the facts: a started prospect with no window, a client with no workspace link back, a confirmed one that is unconfirmed", async () => {
    const id = await insertProspect();
    await expect(rows("update demo_prospects set status = 'active' where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set verified_at = now() where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set status = 'converted', verified_at = now(), window_ends_at = now() where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set status = 'nonsense' where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set converted_org_id = gen_random_uuid() where id = $1", [id])).rejects.toThrow();
  });

  it("refuses more messages than the allowance, a negative count and a limit outside 1 to 100", async () => {
    const id = await insertProspect();
    await rows("update demo_prospects set status = 'active', verified_at = now(), window_ends_at = now() + interval '1 day' where id = $1", [id]);
    await expect(rows("update demo_prospects set messages_used = 11 where id = $1", [id])).rejects.toThrow(/check/);
    await rows("update demo_prospects set extra_messages = 5, messages_used = 15 where id = $1", [id]);
    await expect(rows("update demo_prospects set messages_used = 16 where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set messages_used = -1 where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set message_limit = 0 where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set message_limit = 101 where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set extra_messages = 201 where id = $1", [id])).rejects.toThrow(/check/);
    await expect(rows("update demo_prospects set utm = ('{\"a\":\"' || repeat('x', 1100) || '\"}')::jsonb where id = $1", [id])).rejects.toThrow(/check/);
  });

  it("holds a message to its shape: a prospect's has a key and a state, an answer has neither, and each key and number is used once", async () => {
    const id = await insertProspect();
    const msg = (seq: number, role: string, key: string | null, state: string | null, body = "hi") =>
      rows("insert into demo_messages (prospect_id, seq, role, body, client_message_id, state) values ($1, $2, $3, $4, $5, $6)", [id, seq, role, body, key, state]);
    await msg(1, "user", "key-one-aaaa", "pending");
    await expect(msg(1, "user", "key-two-aaaa", "pending")).rejects.toThrow(/duplicate key/);
    await expect(msg(2, "user", "key-one-aaaa", "pending")).rejects.toThrow(/duplicate key/);
    await expect(msg(2, "user", null, "pending")).rejects.toThrow(/check/);
    await expect(msg(2, "user", "key-three-aaa", null)).rejects.toThrow(/check/);
    await expect(msg(2, "assistant", "key-four-aaaa", null)).rejects.toThrow(/check/);
    await expect(msg(2, "assistant", null, "answered")).rejects.toThrow(/check/);
    await expect(msg(2, "user", "short", "pending")).rejects.toThrow(/check/);
    await expect(msg(2, "user", "has a space in it", "pending")).rejects.toThrow(/check/);
    await expect(msg(2, "user", "key-five-aaaa", "lost")).rejects.toThrow(/check/);
    await expect(msg(2, "user", "key-six-aaaaa", "pending", "x".repeat(4001))).rejects.toThrow(/check/);
    await expect(msg(0, "assistant", null, null)).rejects.toThrow(/check/);
    await expect(rows("insert into demo_messages (prospect_id, seq, role, employee_role, body) values ($1, 2, 'assistant', 'social_media_manager', 'no')", [id])).rejects.toThrow(/check/);
    await msg(2, "assistant", null, null, "an answer");
  });

  it("stores a link or session only as the hash of a token, and refuses anything else", async () => {
    const id = await insertProspect();
    for (const table of ["demo_verifications", "demo_sessions"]) {
      const extra = table === "demo_verifications" ? ", purpose, expires_at" : ", expires_at";
      const values = table === "demo_verifications" ? ", 'verify', now() + interval '1 day'" : ", now() + interval '1 day'";
      await expect(rows(`insert into ${table} (prospect_id, token_hash${extra}) values ($1, 'a-raw-token'${values})`, [id]), table).rejects.toThrow(/check/);
      await expect(rows(`insert into ${table} (prospect_id, token_hash${extra}) values ($1, upper(repeat('a', 64))${values})`, [id]), table).rejects.toThrow(/check/);
      await rows(`insert into ${table} (prospect_id, token_hash${extra}) values ($1, repeat('a', 64)${values})`, [id]);
      await expect(rows(`insert into ${table} (prospect_id, token_hash${extra}) values ($1, repeat('a', 64)${values})`, [id]), `${table} twice`).rejects.toThrow(/duplicate key/);
    }
    await expect(rows("insert into demo_verifications (prospect_id, purpose, token_hash, expires_at) values ($1, 'login', repeat('b', 64), now())", [id])).rejects.toThrow(/check/);
  });

  it("keeps the timeline append-only, removes it only with its prospect, and keeps a line when the agency person who wrote it leaves", async () => {
    const author = await createUser({ platformRole: "agency_manager", name: "Leaves Soon" });
    const id = await insertProspect();
    await rows("insert into demo_events (prospect_id, kind, actor_kind, actor_id, detail) values ($1, 'note', 'user', $2, '{\"note\":\"hello\"}'::jsonb)", [id, author.id]);
    await expect(rows("update demo_events set kind = 'blocked' where prospect_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(rows("update demo_events set actor_kind = 'system' where prospect_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(rows("delete from demo_events where prospect_id = $1", [id])).rejects.toThrow(/append-only/);
    await expect(rows("insert into demo_events (prospect_id, kind) values ($1, 'made_up')", [id])).rejects.toThrow(/check/);
    await expect(rows("insert into demo_events (prospect_id, kind, detail) values ($1, 'note', ('{\"a\":\"' || repeat('x', 2100) || '\"}')::jsonb)", [id])).rejects.toThrow(/check/);
    // The person goes: the line stays, without them.
    await rows("delete from users where id = $1", [author.id]);
    expect((await rows<{ actor_id: string | null; detail: Record<string, unknown> }>("select actor_id, detail from demo_events where prospect_id = $1", [id]))[0]).toEqual({ actor_id: null, detail: { note: "hello" } });
    // The prospect goes: the timeline goes with it.
    await rows("delete from demo_prospects where id = $1", [id]);
    expect(await rows("select 1 from demo_events where prospect_id = $1", [id])).toEqual([]);
  });

  it("keeps the daily counters and the consultation address in shape", async () => {
    await expect(rows("insert into demo_usage_days (day, messages) values ('2031-01-01', -1)")).rejects.toThrow(/check/);
    await rows("insert into demo_usage_days (day, messages) values ('2031-01-01', 4)");
    await expect(rows("insert into demo_usage_days (day, messages) values ('2031-01-01', 5)")).rejects.toThrow(/duplicate key/);
    await rows("delete from demo_usage_days where day = '2031-01-01'");
    for (const url of ["http://example.com", "ftp://x.test", "https://has space.test", `https://example.com/${"x".repeat(500)}`]) {
      await expect(withSystem((db) => db.query("insert into demo_settings (consultation_url) values ($1)", [url])), url).rejects.toThrow(/check/);
    }
  });
});

describe("the rollback", () => {
  const rollBack = (before: (db: { query: (sql: string, params?: unknown[]) => Promise<unknown> }) => Promise<void>) =>
    withSystem(async (db) => {
      await before(db);
      for (const stmt of statements(down)) await db.query(stmt);
      // 0100's own tables are gone; 0113's replay ledger belongs to a later migration and is not 0100's to remove.
      const gone = await db.query<{ n: number }>("select count(*)::int as n from pg_class where relname like 'demo\\_%' and relkind = 'r' and relname <> 'demo_registration_requests'");
      const permissions = await db.query<{ n: number }>("select count(*)::int as n from role_permissions where permission like 'agency.prospects.%'");
      const kinds = await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check'");
      throw Object.assign(new Done(), { gone: gone.rows[0].n, permissions: permissions.rows[0].n, kinds: kinds.rows[0].def });
    });

  it("removes the tables, the permissions and the four notification kinds, and nothing else, when there is nothing to lose", async () => {
    const result = await rollBack(async (db) => {
      await db.query("delete from demo_prospects");
      await db.query("delete from notifications where kind like 'demo\\_%'");
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Done);
    expect(result).toMatchObject({ gone: 0, permissions: 0 });
    for (const k of DEMO_NOTIFICATION_KINDS) expect(result.kinds, k).not.toContain(`'${k}'`);
    expect(result.kinds).toContain("'support_sla'");
    expect(result.kinds).toContain("'proposal_accepted'");
  });

  it("refuses while a prospect exists, even one whose details were erased, and while a demo notice exists", async () => {
    await insertProspect();
    await expect(rollBack(async () => undefined)).rejects.toThrow(/Rollback refused/);
    const erased = await insertProspect();
    await rows("update demo_prospects set name = null, work_email = null, email_normalized = null, business_name = null, erased_at = now() where id = $1", [erased]);
    await expect(rollBack(async (db) => { await db.query("delete from demo_prospects where erased_at is null"); })).rejects.toThrow(/Rollback refused/);
    const user = await createUser({ platformRole: "agency_manager", name: "Has a notice" });
    await expect(
      rollBack(async (db) => {
        await db.query("delete from demo_prospects");
        await db.query("insert into notifications (user_id, kind, title, audience) values ($1, 'demo_budget_reached', 'x', 'direct')", [user.id]);
      }),
    ).rejects.toThrow(/demo notifications exist/);
  });

  it("takes the settings and the daily counters with it: they are configuration and statistics, not people", async () => {
    const result = await rollBack(async (db) => {
      await db.query("delete from demo_prospects");
      await db.query("delete from notifications where kind like 'demo%'");
      await db.query("insert into demo_settings default values");
      await db.query("insert into demo_usage_days (day, starts) values ('2032-01-01', 3)");
    }).catch((e) => e);
    expect(result).toBeInstanceOf(Done);
    expect(result).toMatchObject({ gone: 0 });
  });
});
