import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENCY_DELEGABLE_PERMISSIONS, PERMISSION_MATRIX } from "@/lib/permissions";
import { agencyOrgId, setMessages, splitStatements, staffPerson } from "./support/staff-messages";
import { createOrg, uid } from "./support/fixtures";

// Migration 0096: the schema is closed by default, who may read it, what the database itself refuses, and a rollback that never drops a colleague's conversation. Each case that
// changes anything runs in a transaction that is always rolled back, so the shared test database is untouched.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0096_staff_messages.down.sql", "utf8");

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const runDown = async (db: Db) => {
  for (const stmt of splitStatements(down)) await db.query(stmt);
};
const rows = async <T = Record<string, unknown>>(sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<T & Record<string, unknown>>(sql, params))).rows;

const TABLES = [
  "staff_message_settings", "staff_conversations", "staff_conversation_members", "staff_messages", "staff_message_reactions", "staff_message_attachments", "staff_conversation_events",
  "staff_inbox_state",
];
const KINDS = ["staff_message_direct", "staff_message_mention", "staff_message_added", "staff_workload_alert", "staff_work_overdue"];
const AGENCY_ROLES = ["agency_staff", "agency_manager", "agency_super_admin"];
const FUNCTIONS = ["staff_messages_enabled()", "staff_messages_allowed()", "staff_conversation_ids()", "staff_directory()"];

/** Runs a statement that the database must refuse, inside a savepoint so the transaction survives; returns the message. */
async function refused(db: Db, sql: string, params: unknown[] = []): Promise<string | null> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    await db.query("rollback to savepoint probe");
    return null;
  } catch (e) {
    await db.query("rollback to savepoint probe");
    return String((e as Error).message);
  }
}

/** Three people and the agency workspace, made before a probe's transaction opens (a transaction can't start another one). */
async function people() {
  return { agency: await agencyOrgId(), a: (await staffPerson("agency_staff")).id, b: (await staffPerson("agency_manager")).id, c: (await staffPerson("agency_staff")).id };
}

/** A direct message, a group with two members, one message and everything else a probe needs, made inside the caller's transaction. */
async function seed(db: Db, who: Awaited<ReturnType<typeof people>>) {
  const { agency, a, b, c } = who;
  const [lo, hi] = [a, b].sort();
  const direct = (await db.query<{ id: string }>("insert into staff_conversations (org_id, kind, direct_key, created_by) values ($1, 'direct', $2, $3) returning id", [agency, `${lo}:${hi}`, a])).rows[0].id;
  const group = (await db.query<{ id: string }>("insert into staff_conversations (org_id, kind, name, created_by) values ($1, 'group', 'Probe group', $2) returning id", [agency, a])).rows[0].id;
  for (const u of [a, b]) await db.query("insert into staff_conversation_members (conversation_id, user_id, org_id) values ($1, $2, $3)", [group, u, agency]);
  await db.query("update staff_conversations set last_seq = 1 where id = $1", [group]);
  const message = (await db.query<{ id: string }>("insert into staff_messages (org_id, conversation_id, seq, author_id, body, client_message_id) values ($1, $2, 1, $3, 'Hello', gen_random_uuid()) returning id", [agency, group, a])).rows[0].id;
  return { agency, a, b, c, direct, group, message, lo, hi };
}

describe("the schema is closed by default", () => {
  it("has row-level security on every table and no access for anon, authenticated, PUBLIC or the published-site role", async () => {
    const meta = await rows<{ relname: string; relrowsecurity: boolean; relacl: string | null }>("select relname, relrowsecurity, relacl::text as relacl from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES]);
    expect(meta.map((m) => m.relname).sort()).toEqual([...TABLES].sort());
    for (const m of meta) {
      expect(m.relrowsecurity, m.relname).toBe(true);
      expect(m.relacl ?? "", m.relname).not.toMatch(/(^\{|,)=/);
      for (const role of ["anon", "authenticated", "iaq_site_runtime"]) expect(m.relacl ?? "", `${m.relname} ${role}`).not.toContain(`${role}=`);
    }
    const priv = await rows<{ t: string; ok: boolean }>(
      `select t, bool_or(has_any_column_privilege(r, format('public.%I', t), 'select, insert, update, references')) as ok from unnest($1::text[]) t, unnest(array['anon', 'authenticated', 'iaq_site_runtime']) r group by t`, [TABLES],
    );
    expect(priv.filter((x) => x.ok)).toEqual([]);
  });

  it("gives the application role select only, through one policy per table that depends on the person's standing", async () => {
    const grants = await rows<{ t: string; read: boolean; write: boolean }>(
      `select t, has_table_privilege('iaq_app_user', format('public.%I', t), 'select') as read,
         has_any_column_privilege('iaq_app_user', format('public.%I', t), 'insert, update') or has_table_privilege('iaq_app_user', format('public.%I', t), 'delete, truncate') as write from unnest($1::text[]) t`, [TABLES],
    );
    for (const g of grants) {
      expect(g.write, `${g.t} must not be writable by the application role`).toBe(false);
      expect(g.read, g.t).toBe(true);
    }
    const policies = await rows<{ tablename: string; cmd: string; qual: string }>("select tablename, cmd, qual from pg_policies where tablename = any($1::text[])", [TABLES]);
    expect(policies.map((p) => p.tablename).sort()).toEqual([...TABLES].sort());
    for (const p of policies) {
      expect(p.cmd, p.tablename).toBe("SELECT");
      expect(p.qual, p.tablename).toMatch(/staff_conversation_ids|staff_messages_allowed/);
    }
    // No policy reads a client workspace, a membership or a permission of a client role.
    for (const p of policies) expect(p.qual, p.tablename).not.toMatch(/organization_memberships|permitted_orgs|has_permission\(|can_access_org/);
  });

  it("makes the helper functions callable by the application role and by no browser role", async () => {
    const acl = await rows<{ sig: string; grantees: string[]; definer: boolean }>(
      `select p.oid::regprocedure::text as sig, p.prosecdef as definer,
         (select coalesce(array_agg(coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC')), '{}') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.privilege_type = 'EXECUTE') as grantees
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.oid::regprocedure::text = any($1::text[])`,
      [FUNCTIONS.map((f) => `app.${f}`)],
    );
    expect(acl.map((a) => a.sig).sort()).toEqual(FUNCTIONS.map((f) => `app.${f}`).sort());
    for (const a of acl) {
      expect(a.definer, a.sig).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(a.grantees, `${a.sig} ${role}`).not.toContain(role);
      expect(a.grantees, a.sig).toContain("iaq_app_user");
    }
  });

  it("keeps the table a stream or poll reads to a person and a number, so what is sent to a page can be that and no more", async () => {
    const cols = await rows<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'staff_inbox_state' order by ordinal_position");
    expect(cols.map((c) => c.column_name)).toEqual(["user_id", "org_id", "revision", "updated_at"]);
  });

  it("pins the search path of every function it adds", async () => {
    const fns = await rows<{ proname: string; proconfig: string[] | null }>("select p.proname, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname like 'staff\\_%'");
    expect(fns.length).toBeGreaterThanOrEqual(9);
    for (const f of fns) expect((f.proconfig ?? []).join(","), f.proname).toMatch(/search_path=/);
  });
});

describe("the permissions", () => {
  it("are seeded for the agency roles the product says, and for no client role", async () => {
    const seeded = await rows<{ role: string; permission: string }>("select role, permission from role_permissions where permission like 'agency.messages.%' order by permission, role");
    const by = (perm: string) => seeded.filter((r) => r.permission === perm).map((r) => r.role).sort();
    expect(by("agency.messages.use")).toEqual([...AGENCY_ROLES].sort());
    expect(by("agency.messages.channels")).toEqual(["agency_manager", "agency_super_admin"]);
    expect(by("agency.messages.moderate")).toEqual(["agency_super_admin"]);
    expect(seeded.every((r) => AGENCY_ROLES.includes(r.role))).toBe(true);
    expect(seeded).toHaveLength(6);
  });

  it("agree with the permission matrix in the code, and only the two delegable ones can be changed one person at a time", () => {
    for (const [perm, roles] of [["agency.messages.use", AGENCY_ROLES], ["agency.messages.channels", ["agency_manager", "agency_super_admin"]], ["agency.messages.moderate", ["agency_super_admin"]]] as const) {
      const key = perm as keyof typeof PERMISSION_MATRIX;
      expect([...PERMISSION_MATRIX[key]].sort(), perm).toEqual([...roles].sort());
    }
    expect([...AGENCY_DELEGABLE_PERMISSIONS].filter((p) => p.startsWith("agency.messages."))).toEqual(["agency.messages.use", "agency.messages.channels"]);
  });

  it("are accepted by both per-person override lists (the two delegable ones), keep every earlier entry, and refuse the moderation one", async () => {
    for (const table of ["agency_user_permission_overrides", "invitation_agency_permission_overrides"]) {
      const [c] = await rows<{ def: string }>("select pg_get_constraintdef(k.oid) as def from pg_constraint k where k.conname = $1 and k.conrelid = $2::regclass", [`${table}_permission_check`, table]);
      const listed = [...c.def.matchAll(/'([a-z0-9_.]+)'::text/g)].map((m) => m[1]);
      expect(listed.length, table).toBeGreaterThanOrEqual(52);
      for (const p of ["agency.messages.use", "agency.messages.channels", "agency.support.priority", "agency.crm.read", "agency.clients.create"]) expect(listed, `${table} ${p}`).toContain(p);
      expect(listed, table).not.toContain("agency.messages.moderate");
      expect(new Set(listed).size, table).toBe(listed.length);
    }
    const user = await staffPerson("agency_staff");
    await withSystem(async (db) => {
      expect(await refused(db, "insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.messages.use', 'deny')", [user.id])).toBeNull();
      expect(await refused(db, "insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.messages.channels', 'allow')", [user.id])).toBeNull();
      expect(await refused(db, "insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.messages.moderate', 'allow')", [user.id])).toMatch(/permission_check/);
      throw new Done();
    }).catch((e) => {
      if (!(e instanceof Done)) throw e;
    });
  });
});

describe("the notifications", () => {
  it("add the audience 'staff' and the five kinds, and keep every audience and kind that was there", async () => {
    const [aud] = await rows<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_audience_check' and conrelid = 'notifications'::regclass");
    const audiences = [...aud.def.matchAll(/'([a-z]+)'::text/g)].map((m) => m[1]);
    expect(audiences.sort()).toEqual(["agency", "client", "direct", "staff"]);
    const [kinds] = await rows<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass");
    const listed = [...kinds.def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
    for (const k of [...KINDS, "invoice_paid", "social_post_failed", "support_sla", "proposal_accepted", "web_chat_lead", "crm_task_due", "incident_opened"]) expect(listed, k).toContain(k);
    expect(new Set(listed).size).toBe(listed.length);
  });

  it("show a staff notice to an active agency account, and to nobody else: a client user, a disabled account and a person with no role see none", async () => {
    const staff = await staffPerson("agency_staff");
    const none = await staffPerson("none");
    const gone = await staffPerson("agency_staff");
    const org = await createOrg();
    await withSystem(async (db) => {
      await db.query("update users set status = 'disabled' where id = $1", [gone.id]);
      const visible = async (who: string, audience: string, orgId: string | null = null) =>
        (await db.query<{ v: boolean }>("select app.notification_visible($1, $2, $3) as v", [who, audience, orgId])).rows[0].v;
      expect(await visible(staff.id, "staff")).toBe(true);
      expect(await visible(none.id, "staff")).toBe(false);
      expect(await visible(gone.id, "staff")).toBe(false);
      expect(await visible(staff.id, "unknown")).toBe(false);
      // The audiences that were there are unchanged: 'direct' is still visible to anyone, a client row to someone with access, agency mail by scope.
      expect(await visible(none.id, "direct")).toBe(true);
      expect(await visible(none.id, "client", org.id)).toBe(false);
      throw new Done();
    }).catch((e) => {
      if (!(e instanceof Done)) throw e;
    });
  });
});

describe("what the database itself refuses", () => {
  const probe = async (fn: (db: Db, s: Awaited<ReturnType<typeof seed>>) => Promise<void>) => {
    const who = await people();
    await withSystem(async (db) => {
      await fn(db, await seed(db, who));
      throw new Done();
    }).catch((e) => {
      if (!(e instanceof Done)) throw e;
    });
  };

  it("keeps every row in the one agency workspace", async () => {
    const client = await createOrg();
    await probe(async (db, s) => {
      expect(await refused(db, "insert into staff_conversations (org_id, kind, name) values ($1, 'group', 'In a client workspace')", [client.id])).toMatch(/staff_messages_agency_only/);
      expect(await refused(db, "insert into staff_inbox_state (user_id, org_id) values ($1, $2)", [s.c, client.id])).toMatch(/staff_messages_agency_only/);
      expect(await refused(db, "insert into staff_message_settings (org_id, retention_days) values ($1, 90)", [client.id])).toMatch(/staff_messages_agency_only/);
      // A row of the right workspace but the wrong conversation's workspace does not get past the composite key.
      expect(await refused(db, "insert into staff_messages (org_id, conversation_id, seq, author_id, body, client_message_id) values ($1, $2, 1, $3, 'x', gen_random_uuid())", [client.id, s.group, s.a])).toMatch(/foreign key|violates/);
    });
  });

  it("holds the shape of a conversation: a direct message is two sorted ids and has no name, a group or channel has a name, and only a channel can be open to the team", async () => {
    await probe(async (db, s) => {
      const ins = (cols: string, vals: string, params: unknown[] = []) => refused(db, `insert into staff_conversations (org_id, ${cols}) values ($1, ${vals})`, [s.agency, ...params]);
      expect(await ins("kind, direct_key", "'direct', $2", [`${s.hi}:${s.lo}`])).toMatch(/check/);
      expect(await ins("kind, direct_key", "'direct', $2", [`${s.lo}:${s.lo}`])).toMatch(/check/);
      expect(await ins("kind, direct_key", "'direct', $2", ["not-a-key"])).toMatch(/check/);
      expect(await ins("kind, direct_key", "'direct', $2", [`${s.lo.toUpperCase()}:${s.hi}`])).toMatch(/check/);
      expect(await ins("kind, direct_key, name", "'direct', $2, 'Named'", [`${s.c}:${s.a}`.split(":").sort().join(":")])).toMatch(/check/);
      expect(await ins("kind", "'direct'")).toMatch(/check/);
      expect(await ins("kind, direct_key", "'group', $2", [`${s.lo}:${s.hi}`])).toMatch(/check/);
      expect(await ins("kind", "'group'")).toMatch(/check/);
      expect(await ins("kind, name", "'group', ''")).toMatch(/check/);
      expect(await ins("kind, name", "'group', $2", ["x".repeat(81)])).toMatch(/check/);
      expect(await ins("kind, name, visibility", "'group', 'Open group', 'staff'")).toMatch(/check/);
      expect(await ins("kind, name, topic", "'group', 'Topic too long', $2", ["t".repeat(251)])).toMatch(/check/);
      expect(await ins("kind, name", "'chat', 'Unknown kind'")).toMatch(/check/);
      expect(await ins("kind, name, visibility", "'channel', $2, 'staff'", [`open-${uid()}`])).toBeNull();
      // One direct message per pair, and two live channels never share a name, whatever the case.
      expect(await ins("kind, direct_key", "'direct', $2", [`${s.lo}:${s.hi}`])).toMatch(/duplicate key/);
      await db.query("insert into staff_conversations (org_id, kind, name, visibility) values ($1, 'channel', 'Shared-Name', 'staff')", [s.agency]);
      expect(await ins("kind, name", "'channel', 'shared-name'")).toMatch(/duplicate key/);
      await db.query("update staff_conversations set archived_at = now() where lower(name) = 'shared-name'");
      expect(await ins("kind, name", "'channel', 'SHARED-NAME'")).toBeNull();
    });
  });

  it("only lets an agency account that may use Messages be a member, a direct message hold its two people, and a conversation hold 200", async () => {
    const client = await staffPerson("none");
    const denied = await staffPerson("agency_staff");
    const filler = await Promise.all(Array.from({ length: 197 }, () => staffPerson("agency_staff")));
    const last = await staffPerson("agency_staff");
    const extra = await staffPerson("agency_staff");
    await probe(async (db, s) => {
      await db.query("insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.messages.use', 'deny')", [denied.id]);
      const add = (conversation: string, user: string) => refused(db, "insert into staff_conversation_members (conversation_id, user_id, org_id) values ($1, $2, $3)", [conversation, user, s.agency]);
      expect(await add(s.group, client.id)).toMatch(/staff_member_not_eligible/);
      expect(await add(s.group, denied.id)).toMatch(/staff_member_not_eligible/);
      expect(await add(s.group, s.c)).toBeNull();
      expect(await add(s.direct, s.a)).toBeNull();
      expect(await add(s.direct, s.c)).toMatch(/staff_direct_has_two_people/);
      await db.query("insert into staff_conversation_members (conversation_id, user_id, org_id) select $1, u, $2 from unnest($3::uuid[]) u", [s.group, s.agency, filler.map((f) => f.id)]);
      // a, b and 197 more = 199 active; c was only a probe above and is rolled back, so one more fits and the next does not.
      expect(await add(s.group, last.id)).toBeNull();
      await db.query("insert into staff_conversation_members (conversation_id, user_id, org_id) values ($1, $2, $3)", [s.group, last.id, s.agency]);
      expect(await add(s.group, extra.id)).toMatch(/staff_conversation_is_full/);
    });
  });

  it("only moves a read cursor forward, never past the newest message, and never changes who or where it is", async () => {
    await probe(async (db, s) => {
      await db.query("update staff_conversations set last_seq = 10 where id = $1", [s.group]);
      const cursor = async () => (await db.query<{ n: string }>("select last_read_seq::text as n from staff_conversation_members where conversation_id = $1 and user_id = $2", [s.group, s.b])).rows[0].n;
      await db.query("update staff_conversation_members set last_read_seq = 6 where conversation_id = $1 and user_id = $2", [s.group, s.b]);
      expect(await cursor()).toBe("6");
      await db.query("update staff_conversation_members set last_read_seq = 3 where conversation_id = $1 and user_id = $2", [s.group, s.b]);
      expect(await cursor()).toBe("6");
      await db.query("update staff_conversation_members set last_read_seq = 99 where conversation_id = $1 and user_id = $2", [s.group, s.b]);
      expect(await cursor()).toBe("10");
      expect(await refused(db, "update staff_conversation_members set user_id = $3 where conversation_id = $1 and user_id = $2", [s.group, s.b, s.c])).toMatch(/staff_member_identity_is_fixed/);
      expect(await refused(db, "update staff_conversation_members set joined_at = now() - interval '1 day' where conversation_id = $1 and user_id = $2", [s.group, s.b])).toMatch(/staff_member_identity_is_fixed/);
      expect(await refused(db, "update staff_conversation_members set notify = 'sometimes' where conversation_id = $1 and user_id = $2", [s.group, s.b])).toMatch(/check/);
    });
  });

  it("takes message numbers from the conversation's counter, one level of thread, and a text that is empty only when deleted", async () => {
    await probe(async (db, s) => {
      const post = (extra: string, vals: string, params: unknown[] = []) =>
        refused(db, `insert into staff_messages (org_id, conversation_id, ${extra}, author_id, client_message_id) values ($1, $2, ${vals}, $3, gen_random_uuid())`, [s.agency, s.group, s.a, ...params]);
      expect(await post("seq, body", "2, 'Number not taken yet'")).toMatch(/staff_message_number_not_taken/);
      await db.query("update staff_conversations set last_seq = 5 where id = $1", [s.group]);
      expect(await post("seq, body", "2, 'Now it is'")).toBeNull();
      expect(await post("seq, body", "1, 'Same number twice'")).toMatch(/duplicate key/);
      expect(await post("seq, body", "0, 'Zero'")).toMatch(/check/);
      expect(await post("seq, body", "3, ''")).toMatch(/check/);
      expect(await post("seq, body", "3, $4", ["x".repeat(8001)])).toMatch(/check/);
      expect(await post("seq, body, mentions", "3, 'Many', $4::uuid[]", [Array.from({ length: 21 }, () => s.a)])).toMatch(/check/);
      expect(await post("seq, body, deleted_at", "3, 'Deleted but with text', now()")).toMatch(/check/);
      expect(await post("seq, body, deleted_at", "3, '', now()")).toBeNull();
      // A reply to a reply is refused: a thread is one level deep.
      await db.query("insert into staff_messages (org_id, conversation_id, seq, thread_root_id, author_id, body, client_message_id) values ($1, $2, 3, $3, $4, 'Reply', gen_random_uuid())", [s.agency, s.group, s.message, s.b]);
      const reply = (await db.query<{ id: string }>("select id from staff_messages where seq = 3 and conversation_id = $1", [s.group])).rows[0].id;
      expect(await post("seq, body, thread_root_id", "4, 'Reply to a reply', $4", [reply])).toMatch(/staff_thread_is_one_level/);
      // A thread root must be in the same conversation.
      expect(await post("seq, body, thread_root_id", "4, 'Wrong place', $4", [freshUuid()])).toMatch(/foreign key|violates/);
    });
  });

  it("keeps a message in its place: the number, author, conversation and thread can't change, an edit is stamped, and a deleted message stays deleted and empty", async () => {
    await probe(async (db, s) => {
      const upd = (set: string, params: unknown[] = []) => refused(db, `update staff_messages set ${set} where id = $1`, [s.message, ...params]);
      expect(await upd("seq = 9")).toMatch(/staff_message_place_is_fixed/);
      expect(await upd("conversation_id = $2", [s.direct])).toMatch(/staff_message_place_is_fixed|foreign key/);
      expect(await upd("client_message_id = gen_random_uuid()")).toMatch(/staff_message_place_is_fixed/);
      expect(await upd("created_at = now() - interval '9 days'")).toMatch(/staff_message_place_is_fixed/);
      expect(await upd("author_id = $2", [s.b])).toMatch(/staff_message_author_and_thread_are_fixed/);
      expect(await upd("author_id = null")).toBeNull();
      expect((await db.query<{ edited_at: Date | null }>("select edited_at from staff_messages where id = $1", [s.message])).rows[0].edited_at).toBeNull();
      await db.query("update staff_messages set body = 'Hello, edited' where id = $1", [s.message]);
      expect((await db.query<{ edited_at: Date | null }>("select edited_at from staff_messages where id = $1", [s.message])).rows[0].edited_at).not.toBeNull();
      await db.query("update staff_messages set body = '', deleted_at = now() where id = $1", [s.message]);
      expect(await upd("deleted_at = null")).toMatch(/staff_message_stays_deleted/);
      expect(await upd("body = 'Back'")).toMatch(/staff_message_stays_deleted|check/);
    });
  });

  it("allows only the listed reactions, once each per person, and five files on a message of the listed types and sizes", async () => {
    await probe(async (db, s) => {
      const react = (reaction: string, user = s.a) => refused(db, "insert into staff_message_reactions (message_id, user_id, reaction, conversation_id, org_id) values ($1, $2, $3, $4, $5)", [s.message, user, reaction, s.group, s.agency]);
      expect(await react("thumbs_up")).toBeNull();
      expect(await react("not-on-the-list")).toMatch(/check/);
      expect(await react("")).toMatch(/check/);
      await db.query("insert into staff_message_reactions (message_id, user_id, reaction, conversation_id, org_id) values ($1, $2, 'heart', $3, $4)", [s.message, s.a, s.group, s.agency]);
      expect(await react("heart")).toMatch(/duplicate key/);
      // A reaction can't name a message of another conversation.
      expect(await refused(db, "insert into staff_message_reactions (message_id, user_id, reaction, conversation_id, org_id) values ($1, $2, 'heart', $3, $4)", [s.message, s.b, s.direct, s.agency])).toMatch(/foreign key|violates/);

      const file = async (mime = "application/pdf") =>
        (await db.query<{ id: string }>("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes) values ($1, 'staff-messages', $2::text || '/' || gen_random_uuid()::text || '/a.pdf', 'a.pdf', $3, 100) returning id", [s.agency, s.agency, mime])).rows[0].id;
      const attach = (fileId: string, over: { mime?: string; size?: number; status?: string; message?: string | null } = {}) =>
        refused(db,
          `insert into staff_message_attachments (org_id, conversation_id, message_id, private_file_id, uploaded_by, status, expires_at, filename, mime_type, size_bytes, attached_at)
           values ($1, $2, $3, $4, $5, $6, now() + interval '1 day', 'a.pdf', $7, $8, case when $6 = 'attached' then now() else null end)`,
          [s.agency, s.group, over.message === undefined ? s.message : over.message, fileId, s.a, over.status ?? "attached", over.mime ?? "application/pdf", over.size ?? 100]);
      expect(await attach(await file(), { mime: "application/x-msdownload" })).toMatch(/check/);
      expect(await attach(await file(), { mime: "image/svg+xml" })).toMatch(/check/);
      expect(await attach(await file(), { size: 10_485_761 })).toMatch(/check/);
      expect(await attach(await file(), { size: 0 })).toMatch(/check/);
      expect(await attach(await file(), { status: "staged" })).toMatch(/check/);
      expect(await attach(await file(), { status: "attached", message: null })).toMatch(/check/);
      expect(await attach(await file(), { status: "staged", message: null })).toBeNull();
      for (let i = 0; i < 5; i++) await db.query("insert into staff_message_attachments (org_id, conversation_id, message_id, private_file_id, uploaded_by, status, expires_at, filename, mime_type, size_bytes, attached_at) values ($1, $2, $3, $4, $5, 'attached', now() + interval '1 day', 'a.pdf', 'application/pdf', 1, now())", [s.agency, s.group, s.message, await file(), s.a]);
      expect(await attach(await file())).toMatch(/staff_message_has_too_many_files/);
      // One stored file belongs to one attachment, and a file of another workspace's row can't be used.
      const reused = await file();
      await db.query("insert into staff_message_attachments (org_id, conversation_id, private_file_id, uploaded_by, expires_at, filename, mime_type, size_bytes) values ($1, $2, $3, $4, now() + interval '1 day', 'a.pdf', 'application/pdf', 1)", [s.agency, s.group, reused, s.a]);
      expect(await attach(reused, { status: "staged", message: null })).toMatch(/duplicate key/);
    });
  });

  it("keeps the history append-only and limited to the listed kinds, and the retention period within 30 to 3650 days", async () => {
    await probe(async (db, s) => {
      await db.query("insert into staff_conversation_events (org_id, conversation_id, kind, actor_id) values ($1, $2, 'created', $3)", [s.agency, s.group, s.a]);
      expect(await refused(db, "update staff_conversation_events set kind = 'archived' where conversation_id = $1", [s.group])).toMatch(/append-only/);
      expect(await refused(db, "delete from staff_conversation_events where conversation_id = $1", [s.group])).toMatch(/append-only/);
      expect(await refused(db, "insert into staff_conversation_events (org_id, conversation_id, kind) values ($1, $2, 'deleted_everything')", [s.agency, s.group])).toMatch(/check/);
      expect(await refused(db, "insert into staff_conversation_events (org_id, conversation_id, kind, detail) values ($1, $2, 'created', $3::jsonb)", [s.agency, s.group, JSON.stringify({ text: "x".repeat(2000) })])).toMatch(/check/);
      for (const days of [0, 29, 3651]) expect(await refused(db, "insert into staff_message_settings (org_id, retention_days) values ($1, $2)", [s.agency, days]), String(days)).toMatch(/check/);
      expect(await refused(db, "insert into staff_message_settings (org_id, retention_days) values ($1, null)", [s.agency])).toBeNull();
      expect(await refused(db, "insert into staff_message_settings (org_id, retention_days) values ($1, 365)", [s.agency])).toBeNull();
    });
  });

  it("makes the people directory answer to a person who may use Messages, and give a name, a role and an id only", async () => {
    await setMessages(true);
    const staff = await staffPerson("agency_staff");
    const client = await staffPerson("none");
    const asUser = async (userId: string) =>
      withSystem(async (db) => {
        await db.query("select set_config('app.user_id', $1, true), set_config('role', 'iaq_app_user', true)", [userId]);
        return (await db.query<{ id: string }>("select * from app.staff_directory()")).rows;
      });
    const cols = await rows<{ column_name: string }>("select a.attname as column_name from pg_proc p, unnest(p.proargnames) with ordinality as a(attname, n) where p.oid = 'app.staff_directory()'::regprocedure and p.proargmodes is not null order by a.n");
    expect(cols.map((c) => c.column_name)).toEqual(["id", "name", "platform_role"]);
    expect((await asUser(staff.id)).map((r) => r.id)).toContain(staff.id);
    expect(await asUser(client.id)).toEqual([]);
  });
});

describe("the rollback", () => {
  const clearAll = async (db: Db) => {
    await db.query("alter table staff_conversation_events disable trigger staff_conversation_events_immutable");
    await db.query("delete from staff_conversations");
    await db.query("alter table staff_conversation_events enable trigger staff_conversation_events_immutable");
    await db.query("delete from private_files where bucket = 'staff-messages'");
    await db.query("delete from notifications where audience = 'staff' or kind = any($1::text[])", [KINDS]);
  };
  const rolledBack = (fn: (db: Db) => Promise<void>) =>
    withSystem(async (db) => {
      await fn(db);
      throw new Done();
    }).catch((e) => {
      if (!(e instanceof Done)) throw e;
    });

  it("refuses while a conversation, a message, an attachment, a stored staff file or a staff notice exists, and says what to do", async () => {
    const who = await people();
    // A conversation (each case runs in its own rolled-back transaction, after clearing what the other tests left).
    await rolledBack(async (db) => {
      await clearAll(db);
      await seed(db, who);
      await expect(runDown(db)).rejects.toThrow(/Rollback refused: staff conversations, messages, attachments or stored staff files exist/);
    });
    await rolledBack(async (db) => {
      await clearAll(db);
      await db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes) values ($1, 'staff-messages', $2::text || '/' || gen_random_uuid()::text || '/a.pdf', 'a.pdf', 'application/pdf', 1)", [who.agency, who.agency]);
      await expect(runDown(db)).rejects.toThrow(/Rollback refused: staff conversations, messages, attachments or stored staff files exist/);
    });
    await rolledBack(async (db) => {
      await clearAll(db);
      await db.query("insert into notifications (audience, user_id, kind, title) values ('staff', $1, 'staff_message_direct', 'A staff notice')", [who.a]);
      await expect(runDown(db)).rejects.toThrow(/Rollback refused: staff notifications exist/);
    });
  });

  it("takes everything it added away when nothing was used: the tables, the helper functions, the permissions, the override entries, the audience, the kinds and the module switch", async () => {
    const before = {
      kinds: (await rows<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass"))[0].def.match(/'[a-z0-9_]+'::text/g)?.length ?? 0,
    };
    const agency = await agencyOrgId();
    const person = await staffPerson("agency_staff");
    await rolledBack(async (db) => {
      await clearAll(db);
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, 'staff_messages', true) on conflict do nothing", [agency]);
      await runDown(db);
      const q = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T & Record<string, unknown>>(sql, params)).rows;
      expect(await q("select relname from pg_class where relnamespace = 'public'::regnamespace and relname like 'staff\\_%' and relname not like 'staff\\_assignments%' and relname not like 'staff\\_profiles%'")).toEqual([]);
      expect(await q("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and proname in ('staff_messages_enabled', 'staff_messages_allowed', 'staff_conversation_ids', 'staff_directory', 'staff_org_guard', 'staff_member_guard', 'staff_message_insert_guard', 'staff_message_guard', 'staff_attachment_cap')")).toEqual([]);
      expect(await q("select 1 from role_permissions where permission like 'agency.messages.%'")).toEqual([]);
      expect(await q("select 1 from org_features where feature = 'staff_messages'")).toEqual([]);
      for (const table of ["agency_user_permission_overrides", "invitation_agency_permission_overrides"]) {
        const [c] = await q<{ def: string }>("select pg_get_constraintdef(k.oid) as def from pg_constraint k where k.conname = $1 and k.conrelid = $2::regclass", [`${table}_permission_check`, table]);
        expect(c.def, table).not.toContain("agency.messages");
        expect(c.def, table).toContain("agency.support.priority");
      }
      const [aud] = await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_audience_check' and conrelid = 'notifications'::regclass");
      expect(aud.def).not.toContain("'staff'");
      const [kinds] = await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass");
      for (const k of KINDS) expect(kinds.def, k).not.toContain(`'${k}'`);
      expect(kinds.def.match(/'[a-z0-9_]+'::text/g)?.length).toBe(before.kinds - KINDS.length);
      // The function is 0067's again: a 'staff' row is visible to no one.
      expect((await q<{ v: boolean }>("select app.notification_visible($1, 'staff', null) as v", [person.id]))[0].v).toBe(false);
      expect((await q<{ v: boolean }>("select app.notification_visible($1, 'direct', null) as v", [person.id]))[0].v).toBe(true);
    });
    // And after the throwaway rollback, it is all still there.
    expect((await rows("select relname from pg_class where relnamespace = 'public'::regnamespace and relname = 'staff_messages'")).length).toBe(1);
  });
});

const freshUuid = () => crypto.randomUUID();
