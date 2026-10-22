import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSystem, withUser } from "@/server/db";
import { assignConversation } from "@/server/messaging/handoff";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

// Migration 0082 (Unified Inbox) and its rollback: what it adds, that it changes nothing that already exists, that it is safe in the
// application's transactional runner, and that down-then-up on a populated database loses and invents nothing.

const UP = readFileSync("supabase/migrations/0082_unified_inbox.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0082_unified_inbox.down.sql", "utf8");
class Done extends Error {}

const OUR_KINDS = ["conversation_assigned", "conversation_awaiting_reply", "conversation_new_inquiry"];
const NEW_CONVERSATION_COLUMNS = ["archived_at", "archived_by", "resolved_at", "resolved_by", "outcome", "ai_paused_at", "ai_paused_by", "ai_pause_reason", "revision"];
const NEW_MESSAGE_COLUMNS = ["status_changed_at", "ownership_fence", "failure_kind", "retry_of"];
const NEW_INDEXES = [
  "conversations_view_idx", "conversations_sync_idx", "conversation_messages_changed_idx", "conversation_messages_retry_idx", "conversation_messages_failed_idx",
  "conversation_events_conversation_idx", "conversation_events_org_idx",
];

/** Splits a SQL file into statements, keeping dollar-quoted blocks whole. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    current.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(current.join("\n"));
      current = [];
    }
  }
  return out;
}
type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const run = async (db: Db, sql: string) => {
  for (const statement of statements(sql)) await db.query(statement);
};

const columnsOf = async (db: Db, table: string) =>
  (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1 order by ordinal_position", [table])).rows.map((r) => r.column_name);
/** The allowed notification kinds, read from the live constraint in either of the two forms Postgres prints it in (IN list, or array literal). */
const kindsOf = async (db: Db) => {
  const def = (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass")).rows[0].def;
  const listed = [...def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
  const kinds = listed.length ? listed : (def.match(/'\{([^}]*)\}'::text\[\]/)?.[1] ?? "").split(",").filter(Boolean);
  // A reader that silently finds nothing would make every comparison below pass for the wrong reason.
  if (kinds.length < 20) throw new Error(`could not read the notification kinds from: ${def.slice(0, 200)}`);
  return kinds.sort();
};
const snapshot = async (db: Db) => ({
  conversations: (await db.query<{ n: string }>("select count(*)::text as n from conversations")).rows[0].n,
  messages: (await db.query<{ n: string }>("select count(*)::text as n from conversation_messages")).rows[0].n,
  // The pre-existing columns of every row, so "changes nothing that exists" is a comparison of values, not of counts.
  conversationRows: (await db.query("select id, status, priority, owner_kind, assigned_user_id, unread_count, last_inbound_at, last_outbound_at from conversations order by id")).rows,
  messageRows: (await db.query("select id, direction, status, body, scope, created_at from conversation_messages order by id")).rows,
});

let m: MessagingOrg;
beforeAll(async () => {
  resetEnvCache();
  m = await messagingOrg({ name: "Migration Co" });
  // Populated: several conversations, a lifecycle event and a notification of our kind.
  for (let i = 0; i < 3; i += 1) await inbound(m.org.id);
  const c = await inbound(m.org.id);
  await assignConversation(m.ctx("manager"), c.conversationId, m.people.support.id);
});

describe("migration 0082 Unified Inbox", () => {
  it("adds its columns and indexes, and the event trail with row-level security and read-only access for the application role", async () => {
    const conv = await withSystem((db) => columnsOf(db, "conversations"));
    const msg = await withSystem((db) => columnsOf(db, "conversation_messages"));
    expect(conv).toEqual(expect.arrayContaining(NEW_CONVERSATION_COLUMNS));
    expect(msg).toEqual(expect.arrayContaining(NEW_MESSAGE_COLUMNS));
    const idx = await withSystem((db) => db.query<{ indexname: string }>("select indexname from pg_indexes where indexname = any($1)", [NEW_INDEXES]));
    expect(idx.rows.map((r) => r.indexname).sort()).toEqual([...NEW_INDEXES].sort());
    const rls = await withSystem((db) => db.query<{ relrowsecurity: boolean }>("select relrowsecurity from pg_class where relname = 'conversation_events' and relkind = 'r'"));
    expect(rls.rows[0].relrowsecurity).toBe(true);
    const grants = await withSystem((db) => db.query<{ privilege_type: string }>("select privilege_type from information_schema.role_table_grants where table_name = 'conversation_events' and grantee = 'iaq_app_user'"));
    expect(grants.rows.map((g) => g.privilege_type)).toEqual(["SELECT"]);
    await expect(withUser(m.people.owner.id, (db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind) values ($1, $2, 'assigned', 'user')", [m.org.id, crypto.randomUUID()]))).rejects.toThrow(/permission denied|row-level/i);
  });

  it("leaves what existed alone: new columns are empty or neutral on old rows, and the old columns are unchanged", async () => {
    const before = await withSystem((db) => snapshot(db));
    const row = await withSystem((db) => db.query<Record<string, unknown>>("select archived_at, resolved_at, outcome, ai_paused_at, revision, status from conversations order by created_at limit 1"));
    expect(row.rows[0]).toMatchObject({ archived_at: null, resolved_at: null, outcome: null, ai_paused_at: null });
    const msg = await withSystem((db) => db.query<Record<string, unknown>>("select ownership_fence, failure_kind, retry_of from conversation_messages limit 1"));
    expect(msg.rows[0]).toMatchObject({ ownership_fence: null, failure_kind: null, retry_of: null });
    expect(before.conversations).not.toBe("0");
  });

  it("keeps its guards: bad outcomes, failure kinds and actors are refused, and the trail cannot be rewritten", async () => {
    const c = await inbound(m.org.id);
    await expect(withSystem((db) => db.query("update conversations set outcome = 'great' where id = $1", [c.conversationId]))).rejects.toThrow(/outcome/i);
    await expect(withSystem((db) => db.query("update conversation_messages set failure_kind = 'maybe' where conversation_id = $1", [c.conversationId]))).rejects.toThrow(/failure_kind/i);
    await expect(withSystem((db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind) values ($1, $2, 'assigned', 'robot')", [m.org.id, c.conversationId]))).rejects.toThrow(/actor_kind/i);
    await expect(withSystem((db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind) values ($1, $2, 'Not A Kind', 'user')", [m.org.id, c.conversationId]))).rejects.toThrow(/kind/i);
    await expect(withSystem((db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind, detail) values ($1, $2, 'assigned', 'user', $3)", [m.org.id, c.conversationId, JSON.stringify({ x: "y".repeat(3000) })]))).rejects.toThrow(/detail/i);
    await withSystem((db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind) values ($1, $2, 'assigned', 'workflow')", [m.org.id, c.conversationId]));
    await expect(withSystem((db) => db.query("update conversation_events set kind = 'archived' where conversation_id = $1", [c.conversationId]))).rejects.toThrow();
    // An event cannot point at another workspace's conversation.
    const other = await messagingOrg({ name: "Other Migration Co" });
    await expect(withSystem((db) => db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind) values ($1, $2, 'assigned', 'user')", [other.org.id, c.conversationId]))).rejects.toThrow(/foreign key|violates/i);
  });

  it("bumps the revision on every conversation update and the status time only when a message's status changes", async () => {
    const c = await inbound(m.org.id);
    const rev = async () => Number((await withSystem((db) => db.query<{ revision: string }>("select revision::text as revision from conversations where id = $1", [c.conversationId]))).rows[0].revision);
    const r0 = await rev();
    await withSystem((db) => db.query("update conversations set unread_count = unread_count + 1 where id = $1", [c.conversationId]));
    expect(await rev()).toBe(r0 + 1);
    // A message is stamped when it is created, left alone by edits that don't change its status, and stamped again by a status change.
    const msg = (await withSystem((db) => db.query<{ id: string }>(
      "insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope) values ($1, $2, 'outbound', 'human', 'Hello', 'queued', 'human') returning id", [m.org.id, c.conversationId],
    ))).rows[0].id;
    const stamp = async () => (await withSystem((db) => db.query<{ t: Date | null }>("select status_changed_at as t from conversation_messages where id = $1", [msg]))).rows[0].t;
    const t0 = await stamp();
    expect(t0).not.toBeNull();
    await withSystem((db) => db.query("update conversation_messages set body = 'Hello again' where id = $1", [msg]));
    expect((await stamp())!.getTime()).toBe(t0!.getTime());
    await new Promise((r) => setTimeout(r, 25));
    await withSystem((db) => db.query("update conversation_messages set status = 'sent', sent_at = now() where id = $1", [msg]));
    expect((await stamp())!.getTime()).toBeGreaterThan(t0!.getTime());
    // Messages from before the migration have no stamp, so the first sync poll after a deploy cannot match a workspace's whole history.
    const old = (await withSystem((db) => db.query<{ id: string }>(
      "insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, status_changed_at) values ($1, $2, 'inbound', 'contact', 'Old', 'received', null) returning id", [m.org.id, c.conversationId],
    ))).rows[0].id;
    const changed = await withSystem((db) => db.query<{ id: string }>("select id from conversation_messages where org_id = $1 and status_changed_at > $2", [m.org.id, new Date(Date.now() - 3_600_000)]));
    expect(changed.rows.map((r) => r.id)).not.toContain(old);
  });

  it("is safe in the application's transactional runner: fail-fast locking, plain re-runnable indexes, nothing rewritten", () => {
    const code = UP.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
    expect(code).toMatch(/set local lock_timeout\s*=\s*'\d+s'/i);
    expect(code).not.toMatch(/concurrently/i); // the runner wraps each file in a transaction, where that is an error
    expect(code).not.toMatch(/\bdelete from\b|\bupdate\b\s+\w+\s+set/i); // no existing data is rewritten
    expect(code).not.toMatch(/\bdrop table\b|\btruncate\b|\bdrop column\b/i);
    for (const statement of code.split(";").map((s) => s.trim()).filter(Boolean)) {
      if (/^create index\b/i.test(statement)) expect(statement.slice(0, 90)).toMatch(/^create index if not exists\b/i);
    }
    // The notification allow-list is extended from the live constraint, never replaced by a copied list.
    expect(code).toMatch(/pg_get_constraintdef/);
  });
});

describe("rolling migration 0082 back and forward on a populated database", () => {
  it("refuses while lifecycle history or conversation notifications exist, and says why", async () => {
    await expect(withSystem((db) => run(db, DOWN))).rejects.toThrow(/conversation_events holds lifecycle history/);
    await expect(withSystem(async (db) => {
      await db.query("delete from conversation_events");
      await run(db, DOWN);
    })).rejects.toThrow(/notifications of the conversation kinds exist/);
    // Nothing was half-done: the columns are still there.
    expect(await withSystem((db) => columnsOf(db, "conversations"))).toEqual(expect.arrayContaining(NEW_CONVERSATION_COLUMNS));
  });

  it("removes only what it added, keeps every existing row and value, and comes back identical", async () => {
    const out: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      const before = { data: await snapshot(db), kinds: await kindsOf(db), conv: await columnsOf(db, "conversations"), msg: await columnsOf(db, "conversation_messages") };
      await db.query("delete from conversation_events");
      await db.query("delete from notifications where kind = any($1)", [OUR_KINDS]);
      await run(db, DOWN);
      const down = { data: await snapshot(db), kinds: await kindsOf(db), conv: await columnsOf(db, "conversations"), msg: await columnsOf(db, "conversation_messages"), events: (await db.query("select to_regclass('public.conversation_events')::text as t")).rows[0], rollout: (await db.query("select to_regclass('public.inbox_rollout')::text as t")).rows[0] };
      await run(db, UP);
      const up = { data: await snapshot(db), kinds: await kindsOf(db), conv: await columnsOf(db, "conversations"), msg: await columnsOf(db, "conversation_messages"), rollout: (await db.query("select to_regclass('public.inbox_rollout')::text as t")).rows[0] };
      Object.assign(out, { before, down, up });
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    const { before, down, up } = out as Record<"before" | "down" | "up", { data: Awaited<ReturnType<typeof snapshot>>; kinds: string[]; conv: string[]; msg: string[]; events?: unknown; rollout?: unknown }>;
    // Down: our columns, our table and our three notification kinds are gone; everything else is exactly as it was.
    for (const c of NEW_CONVERSATION_COLUMNS) expect(down.conv).not.toContain(c);
    for (const c of NEW_MESSAGE_COLUMNS) expect(down.msg).not.toContain(c);
    expect(down.events).toEqual({ t: null });
    // The rollout allowlist is current state only (its history is in audit_logs), so rolling back drops it and rolling forward brings it back empty: every workspace off.
    expect(down.rollout).toEqual({ t: null });
    expect(up.rollout).toEqual({ t: "inbox_rollout" });
    expect(down.kinds).toEqual(before.kinds.filter((k) => !OUR_KINDS.includes(k)));
    expect(down.data).toEqual(before.data);
    // Up again: back to the same columns and the same allow-list, with the data untouched.
    expect(up.conv).toEqual(before.conv);
    expect(up.msg).toEqual(before.msg);
    expect(up.kinds).toEqual(before.kinds);
    expect(up.data).toEqual(before.data);
    // The probe was rolled back: the real database still has the migration.
    expect(await withSystem((db) => columnsOf(db, "conversations"))).toEqual(expect.arrayContaining(NEW_CONVERSATION_COLUMNS));
  });

  it("keeps a notification kind another migration added, whichever form the live constraint is written in", async () => {
    const out: Record<string, string[]> = {};
    for (const form of ["in-list", "array-literal"] as const) {
      await expect(withSystem(async (db) => {
        await db.query("delete from conversation_events");
        await db.query("delete from notifications where kind = any($1)", [OUR_KINDS]);
        await run(db, DOWN);
        // Another branch's migration adds its own kind to the allow-list in between, written either way.
        const withOther = [...(await kindsOf(db)), "some_other_branch_kind"];
        await db.query("alter table notifications drop constraint notifications_kind_check");
        await db.query(
          form === "in-list"
            ? `alter table notifications add constraint notifications_kind_check check (kind in (${withOther.map((k) => `'${k}'`).join(", ")}))`
            : `alter table notifications add constraint notifications_kind_check check (kind = any ('{${withOther.join(",")}}'::text[]))`,
        );
        await run(db, UP);
        out[form] = await kindsOf(db);
        // Rolling back again removes only ours and leaves the other branch's kind.
        await db.query("delete from conversation_events");
        await run(db, DOWN);
        out[`${form}-down`] = await kindsOf(db);
        throw new Done();
      })).rejects.toBeInstanceOf(Done);
    }
    for (const form of ["in-list", "array-literal"]) {
      expect(out[form], form).toEqual(expect.arrayContaining([...OUR_KINDS, "some_other_branch_kind"]));
      expect(out[`${form}-down`], form).toContain("some_other_branch_kind");
      for (const k of OUR_KINDS) expect(out[`${form}-down`], form).not.toContain(k);
      expect(out[form].length, form).toBe(out[`${form}-down`].length + OUR_KINDS.length);
    }
  });

  it("refuses, instead of locking out every notification, when it can't read the current allow-list", async () => {
    await expect(withSystem(async (db) => {
      await db.query("delete from conversation_events");
      await db.query("delete from notifications where kind = any($1)", [OUR_KINDS]);
      await run(db, DOWN);
      await db.query("alter table notifications drop constraint notifications_kind_check");
      await db.query("alter table notifications add constraint notifications_kind_check check (char_length(kind) > 0)");
      await expect(run(db, UP)).rejects.toThrow(/could not read the current notification kinds/);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    // Nothing leaked out of the probe: the live constraint still lists the real kinds.
    expect((await withSystem((db) => kindsOf(db))).length).toBeGreaterThan(60);
  });
});
