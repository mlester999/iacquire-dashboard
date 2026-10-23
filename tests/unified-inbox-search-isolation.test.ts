import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { resetEnvCache } from "@/server/env";
import { withSiteRuntime, withSystem, withUser } from "@/server/db";
import { inboxViewCounts, listConversationsPage } from "@/server/messaging/inbox-list";
import { redactContact } from "@/server/messaging/contacts";
import { loadInboxThread } from "@/server/messaging/inbox-sync";
import { endSupportSession, startSupportSession } from "@/server/crm/actor";
import { agencyPeople } from "./support/crm";
import { addMember, agencyUser, createUser, ctxFor } from "./support/fixtures";
import { inbound, messagingOrg, type MessagingOrg } from "./support/messaging";

// The Unified Inbox search, proved tenant-safe on embedded Postgres (PGlite, in memory, test data only).
//
// What the "search optimization" of migration 0083 actually is: ONE partial trigram GIN index on conversation_messages.body (where direction <> 'internal'),
// plus two ordinary btree indexes for the list and the sync poll. There is no stored search column, no search table and no search function. The query itself
// is the list query (src/server/messaging/inbox-list.ts) running as the signed-in person (withUser), so row-level security on conversations, contacts,
// contact_identities and conversation_messages decides what the predicate can see. A candidate policy rewrite was measured in tests/perf and NOT applied.
//
// So the questions are: (1) did anything change who can read what; (2) does the search, as written, leak across workspaces, roles or people who may not
// open a conversation; (3) does erasing a contact erase what the search matches. Sections below answer them in that order. Embedded timings are not
// production measurements; nothing here claims a latency.

type Ctx = ReturnType<MessagingOrg["ctx"]>;

const SHARED = "gutterwidget";
const SEARCHED_TABLES = ["conversations", "conversation_messages", "conversation_events", "contacts", "contact_identities"] as const;
const POLICY_TABLES = [...SEARCHED_TABLES, "inbox_rollout"] as const;

const sorted = (xs: string[]) => [...xs].sort();
const found = async (ctx: Ctx, q: string, extra: Record<string, unknown> = {}) => sorted((await listConversationsPage(ctx, { q, limit: 100, ...extra })).items.map((i) => i.id));
const rows = async <T extends Record<string, unknown>>(userId: string, sql: string, params: unknown[] = []) => (await withUser(userId, (db) => db.query<T>(sql, params))).rows;
const count = async (userId: string, sql: string, params: unknown[] = []) => Number((await rows<{ n: string }>(userId, sql, params))[0].n);
/** A request with no signed-in user: the application role, no app.user_id. */
const asNobody = async <T extends Record<string, unknown>>(sql: string, params: unknown[] = []) =>
  withSystem(async (db) => {
    await db.query("set local role iaq_app_user");
    return (await db.query<T>(sql, params)).rows;
  });

interface Person {
  label: string;
  name: string;
  /** The phone number (sms) or the email address (email). */
  address: string;
  subject: string | null;
  conversationId: string;
  contactId: string;
}

/**
 * A customer with one conversation and two inbound messages. The older message holds `<label>history`, which only the message-text branch of the search can
 * find (the preview shows the newer one, `<label>latest`). Email customers also have a subject, `<label>subject quote`.
 */
async function person(org: MessagingOrg, label: string, channel: "sms" | "email" = "sms", shared: string | null = null): Promise<Person> {
  const name = `${label} Customer`;
  const subject = channel === "email" ? `${label}subject quote` : null;
  // (inbound() spreads its options over its defaults, so an `address: undefined` would erase the generated phone number: leave the key out.)
  const given = channel === "email" ? { address: `${label}.customer@${label}-mail.test` } : {};
  const first = await inbound(org.org.id, { channel, ...given, name, subject, body: `${label}history ${shared ?? "plain"} words` });
  await inbound(org.org.id, { channel, address: first.address, name, body: `${label}latest message` });
  return { label, name, address: first.address, subject, conversationId: first.conversationId, contactId: first.contactId };
}

/** Everything a person can be found by. Each term belongs to this person's conversation alone. */
const facets = (p: Person) => [p.name, p.address, `${p.label}history`, `${p.label}latest`, ...(p.subject ? [`${p.label}subject`] : [])];

/** Searching for every facet of every person returns that person's conversation if `visible` includes them, and nothing otherwise. */
async function expectVisible(ctx: Ctx, everyone: Person[], visible: string[], who: string) {
  for (const p of everyone) {
    for (const term of facets(p)) {
      expect(await found(ctx, term), `${who} searching ${JSON.stringify(term)}`).toEqual(visible.includes(p.label) ? [p.conversationId] : []);
    }
  }
}

beforeAll(() => {
  resetEnvCache();
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 1. What the optimization is, and that it widened nothing
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("what the search optimization is, and that it adds no new way to read data", () => {
  it("is one partial trigram index on message text; no column, table or function holds searchable text", async () => {
    const idx = await withSystem((db) => db.query<{ indexdef: string; valid: boolean; ready: boolean }>(
      `select pg_get_indexdef(i.indexrelid) as indexdef, i.indisvalid as valid, i.indisready as ready
       from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'conversation_messages_body_trgm'`,
    ));
    expect(idx.rows).toHaveLength(1);
    expect(idx.rows[0].valid && idx.rows[0].ready).toBe(true);
    // Private notes are left out of the index on purpose, in step with the query's own `direction <> 'internal'`.
    expect(idx.rows[0].indexdef).toMatch(/USING gin \(body (\w+\.)?gin_trgm_ops\) WHERE \(direction <> 'internal'::text\)/);

    // No stored search column was added to the inbox tables (contacts.search_text is the older CRM column from 0027; the inbox list does not read it).
    const searchy = await withSystem((db) => db.query<{ t: string; c: string }>(
      `select table_name as t, column_name as c from information_schema.columns
       where table_schema = 'public' and table_name = any($1) and table_name <> 'contacts'
         and (data_type = 'tsvector' or column_name ~* '(search|tsv|trgm|fts|ngram)' or is_generated = 'ALWAYS')`,
      [[...POLICY_TABLES]],
    ));
    expect(searchy.rows).toEqual([]);

    // Migration 0083 added two trigger functions and neither is SECURITY DEFINER: they run with the rights of whoever writes the row.
    const fns = await withSystem((db) => db.query<{ proname: string; prosecdef: boolean }>("select proname::text as proname, prosecdef from pg_proc where pronamespace = 'app'::regnamespace and proname in ('conversation_lifecycle', 'message_status_changed')"));
    expect(fns.rows.map((f) => f.proname).sort()).toEqual(["conversation_lifecycle", "message_status_changed"]);
    expect(fns.rows.every((f) => f.prosecdef === false)).toBe(true);
  });

  it("is searched as the signed-in person: the list code never uses the system, read-only-system or service role, and calls no database function of its own", () => {
    const src = readFileSync("src/server/messaging/inbox-list.ts", "utf8");
    expect(src).toMatch(/withUser\(ctx\.user\.id/);
    expect(src).not.toMatch(/withSystem|readSystem|withServiceRole|withSiteRuntime/);
    expect(src).not.toMatch(/\bapp\.\w+\s*\(/);
    // Every condition is scoped by the workspace first.
    expect(src).toMatch(/const where: string\[\] = \["c\.org_id = \$1"\]/);
    // The search term is only ever a bound parameter.
    expect(src).toMatch(/const p = bind\(`%\$\{escapeLike\(term\)\}%`\)/);
  });

  it("leaves row-level security and the grants on every table the search touches as they were: select-only policies for the application role, nothing for the browser or site roles", async () => {
    const rls = await withSystem((db) => db.query<{ relname: string; relrowsecurity: boolean }>("select relname::text as relname, relrowsecurity from pg_class where relkind = 'r' and relnamespace = 'public'::regnamespace and relname = any($1) order by 1", [[...POLICY_TABLES]]));
    expect(rls.rows.map((r) => [r.relname, r.relrowsecurity])).toEqual([...POLICY_TABLES].sort().map((t) => [t, true]));

    // Nobody but the application role (read) and the owner and service role (Supabase's own) holds anything; PUBLIC, anon, authenticated and the site runtime hold nothing.
    for (const role of ["anon", "authenticated", "iaq_site_runtime"]) {
      for (const table of POLICY_TABLES) {
        // Whole-table grants and column-level grants alike.
        const any = await withSystem((db) => db.query<{ p: string }>(
          `select p from unnest(array['SELECT','INSERT','UPDATE','REFERENCES']) as p where has_any_column_privilege($1::name, ('public.' || $2::text)::regclass, p)
           union all
           select p from unnest(array['DELETE','TRUNCATE','TRIGGER']) as p where has_table_privilege($1::name, ('public.' || $2::text)::regclass, p)`,
          [role, table],
        ));
        expect(any.rows, `${role} on ${table}`).toEqual([]);
      }
    }
    const publicGrants = await withSystem((db) => db.query<{ relname: string }>(
      "select c.relname::text as relname from pg_class c, aclexplode(c.relacl) a where c.relname = any($1) and c.relkind = 'r' and a.grantee = 0",
      [[...POLICY_TABLES]],
    ));
    expect(publicGrants.rows).toEqual([]);
    for (const table of SEARCHED_TABLES) {
      const can = await withSystem((db) => db.query<{ r: boolean; w: boolean }>(
        "select has_table_privilege('iaq_app_user', ('public.' || $1::text)::regclass, 'SELECT') as r, (has_table_privilege('iaq_app_user', ('public.' || $1::text)::regclass, 'INSERT') or has_table_privilege('iaq_app_user', ('public.' || $1::text)::regclass, 'UPDATE') or has_table_privilege('iaq_app_user', ('public.' || $1::text)::regclass, 'DELETE')) as w",
        [table],
      ));
      expect(can.rows[0], table).toEqual({ r: true, w: false });
    }
    // The rollout switch is for trusted server code only.
    expect((await withSystem((db) => db.query<{ r: boolean }>("select has_table_privilege('iaq_app_user', 'public.inbox_rollout'::regclass, 'SELECT') as r"))).rows[0].r).toBe(false);
  });

  it("keeps exactly these policies, and in particular the messages policy still derives from the conversations the person can see (the unapplied short-circuit candidate is not live)", async () => {
    const pol = await withSystem((db) => db.query<{ tablename: string; policyname: string; cmd: string; roles: string; qual: string; permissive: string }>(
      "select tablename::text as tablename, policyname::text as policyname, cmd::text as cmd, roles::text as roles, qual, permissive::text as permissive from pg_policies where schemaname = 'public' and tablename = any($1) order by tablename, policyname",
      [[...POLICY_TABLES]],
    ));
    expect(pol.rows.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([
      "contact_identities.contact_identities_select", "contacts.contacts_select", "conversation_events.conversation_events_select",
      "conversation_messages.conversation_messages_select", "conversations.conversations_select",
    ]);
    for (const p of pol.rows) expect([p.cmd, p.roles, p.permissive], p.policyname).toEqual(["SELECT", "{iaq_app_user}", "PERMISSIVE"]);
    const q = Object.fromEntries(pol.rows.map((p) => [p.policyname, p.qual]));
    // A message is visible only if its conversation is (the conversation policy applies inside this sub-select).
    expect(q.conversation_messages_select, "a policy change needs its own security review").toMatch(/^\(EXISTS \( SELECT 1\s+FROM conversations c\s+WHERE \(\(c\.id = conversation_messages\.conversation_id\) AND \(c\.org_id = conversation_messages\.org_id\)\)\)\)$/);
    expect(q.conversation_messages_select).not.toMatch(/permitted_orgs/);
    expect(q.conversation_events_select).toMatch(/FROM conversations c/);
    expect(q.conversations_select).toMatch(/permitted_orgs\('inbox\.view'::text\)/);
    expect(q.conversations_select).toMatch(/permitted_orgs\('inbox\.view_all'::text\)/);
    expect(q.conversations_select).toMatch(/owner_user_id = \( SELECT app\.current_user_id\(\)/);
    expect(q.conversations_select).toMatch(/assigned_user_id = \( SELECT app\.current_user_id\(\)/);
    expect(q.contacts_select).toMatch(/permitted_orgs\('contacts\.view'::text\)[\s\S]*deleted_at IS NULL/);
    expect(q.contact_identities_select).toMatch(/permitted_orgs\('contacts\.view'::text\)/);
  });

  it("uses only security definer functions that pin their search path and answer for the caller alone", async () => {
    // Everything the five policies call, and everything those functions call in turn.
    const policies = await withSystem((db) => db.query<{ qual: string }>("select qual from pg_policies where schemaname = 'public' and tablename = any($1)", [[...POLICY_TABLES]]));
    const wanted = new Set<string>();
    const queue = [...policies.rows.flatMap((p) => [...p.qual.matchAll(/app\.(\w+)\(/g)].map((m) => m[1]))];
    while (queue.length) {
      const name = queue.pop()!;
      if (wanted.has(name)) continue;
      wanted.add(name);
      const body = await withSystem((db) => db.query<{ prosrc: string }>("select prosrc from pg_proc where pronamespace = 'app'::regnamespace and proname = $1", [name]));
      expect(body.rows.length, `app.${name} exists exactly once`).toBe(1);
      for (const m of body.rows[0].prosrc.matchAll(/app\.(\w+)\(/g)) queue.push(m[1]);
    }
    expect([...wanted]).toEqual(expect.arrayContaining(["permitted_orgs", "current_user_id", "has_permission", "org_role"]));
    const fns = await withSystem((db) => db.query<{ proname: string; prosecdef: boolean; proconfig: string[] | null; public_exec: boolean }>(
      `select p.proname::text as proname, p.prosecdef, p.proconfig,
              exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_exec
       from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = any($1) order by 1`,
      [[...wanted]],
    ));
    expect(fns.rows.length).toBe(wanted.size);
    for (const f of fns.rows.filter((x) => x.prosecdef)) {
      const path = (f.proconfig ?? []).find((c) => c.startsWith("search_path="));
      expect(path, `app.${f.proname} pins search_path`).toMatch(/^search_path=(public, pg_temp|"")$/);
      expect(f.public_exec, `app.${f.proname} is not executable by PUBLIC`).toBe(false);
    }

    // And no SECURITY DEFINER function anywhere in the database (the public-site functions included) leaves its search path open or puts a temporary schema first.
    const loose = await withSystem((db) => db.query<{ fn: string; cfg: string[] | null }>(
      `select (n.nspname || '.' || p.proname)::text as fn, p.proconfig as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where p.prosecdef and n.nspname not in ('pg_catalog', 'information_schema')
         and not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c ~ '^search_path=(public, pg_temp|"")$')
       order by 1`,
    ));
    expect(loose.rows, "SECURITY DEFINER functions without a pinned search_path").toEqual([]);
  });

  it("gives permitted_orgs an answer that depends only on who is asking, and a table of the same name in the caller's temporary schema cannot change it", async () => {
    const a = await messagingOrg({ name: "Permitted A Co" });
    const b = await messagingOrg({ name: "Permitted B Co" });
    const both = await createUser({ name: "In Both" });
    await addMember(a.org.id, both.id, "admin");
    await addMember(b.org.id, both.id, "sales_rep");
    const stranger = await createUser({ name: "Nobody Special" });
    const orgs = async (userId: string | null, permission: string) =>
      sorted(
        userId
          ? (await rows<{ o: string }>(userId, "select o::text as o from unnest(app.permitted_orgs($1)) o", [permission])).map((r) => r.o)
          : (await asNobody<{ o: string }>("select o::text as o from unnest(app.permitted_orgs($1)) o", [permission])).map((r) => r.o),
      );
    expect(await orgs(a.people.owner.id, "inbox.view")).toEqual([a.org.id]);
    expect(await orgs(b.people.owner.id, "inbox.view")).toEqual([b.org.id]);
    expect(await orgs(a.people.support.id, "inbox.view")).toEqual([a.org.id]);
    expect(await orgs(a.people.support.id, "inbox.view_all")).toEqual([]);
    expect(await orgs(both.id, "inbox.view")).toEqual(sorted([a.org.id, b.org.id]));
    expect(await orgs(both.id, "inbox.view_all")).toEqual([a.org.id]);
    expect(await orgs(stranger.id, "inbox.view")).toEqual([]);
    expect(await orgs(null, "inbox.view")).toEqual([]);

    // A hostile caller creates their own `organization_memberships` in their temporary schema saying they own A. The definer functions pin
    // search_path = public, pg_temp, so they read the real table, not the caller's.
    const shadowed = await withUser(stranger.id, async (db) => {
      // (on commit drop: the embedded database is one long session, and a temporary table would otherwise shadow the real one for every later test.)
      await db.query("create temp table organization_memberships (org_id uuid, user_id uuid, role text, status text) on commit drop");
      await db.query("insert into organization_memberships values ($1, $2, 'owner', 'active')", [a.org.id, stranger.id]);
      const mine = (await db.query<{ n: string }>("select count(*)::text as n from organization_memberships")).rows[0].n;
      const o = await db.query<{ o: string }>("select o::text as o from unnest(app.permitted_orgs('inbox.view')) o");
      const r = await db.query<{ role: string | null }>("select app.org_role($1) as role", [a.org.id]);
      return { mine, orgs: o.rows, role: r.rows[0].role };
    });
    expect(shadowed).toEqual({ mine: "1", orgs: [], role: null });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 2. One workspace never finds another's conversations
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a member of one workspace never finds another workspace's conversations", () => {
  let a: MessagingOrg;
  let b: MessagingOrg;
  let aPeople: Person[];
  let bPeople: Person[];

  beforeAll(async () => {
    a = await messagingOrg({ name: "Zebu Tenants Co" });
    b = await messagingOrg({ name: "Quokka Tenants Co" });
    aPeople = [await person(a, "zebusms", "sms", SHARED), await person(a, "zebumail", "email", SHARED)];
    bPeople = [await person(b, "quokkasms", "sms", SHARED), await person(b, "quokkamail", "email", SHARED)];
  }, 60_000);

  it("finds a workspace's own conversations by name, number or address, subject, older message and latest message, and finds none of the other's by any of them", async () => {
    const everyone = [...aPeople, ...bPeople];
    for (const who of ["owner", "manager"] as const) {
      await expectVisible(a.ctx(who), everyone, aPeople.map((p) => p.label), `A ${who}`);
      await expectVisible(b.ctx(who), everyone, bPeople.map((p) => p.label), `B ${who}`);
    }
  });

  it("returns only the searcher's own conversations for a term that both workspaces use, and nothing for the other workspace's name, number, address or subject", async () => {
    expect(await found(a.ctx("owner"), SHARED)).toEqual(sorted(aPeople.map((p) => p.conversationId)));
    expect(await found(b.ctx("owner"), SHARED)).toEqual(sorted(bPeople.map((p) => p.conversationId)));
    // The same word matches names in both workspaces ("Customer"); each side still gets only its own.
    expect(await found(a.ctx("owner"), "Customer")).toEqual(sorted(aPeople.map((p) => p.conversationId)));
    expect(await found(b.ctx("owner"), "Customer")).toEqual(sorted(bPeople.map((p) => p.conversationId)));
  });

  it("keeps a person who belongs to both workspaces inside the workspace they are working in", async () => {
    const both = await createUser({ name: "Works In Both" });
    await addMember(a.org.id, both.id, "admin");
    await addMember(b.org.id, both.id, "admin");
    const inA = ctxFor(both, a.org, "admin");
    const inB = ctxFor(both, b.org, "admin");
    const everyone = [...aPeople, ...bPeople];
    await expectVisible(inA, everyone, aPeople.map((p) => p.label), "dual member working in A");
    await expectVisible(inB, everyone, bPeople.map((p) => p.label), "dual member working in B");
    expect(await found(inA, SHARED)).toEqual(sorted(aPeople.map((p) => p.conversationId)));
    expect(await found(inB, SHARED)).toEqual(sorted(bPeople.map((p) => p.conversationId)));

    // Row-level security alone lets them read both workspaces (they are entitled to); the workspace condition in the query is what scopes the search.
    // A member of one workspace only gets the same answer from the database with no workspace condition at all.
    const orgsOf = async (userId: string) => sorted((await rows<{ org_id: string }>(userId, "select distinct org_id::text as org_id from conversation_messages where body ilike $1", [`%${SHARED}%`])).map((r) => r.org_id));
    expect(await orgsOf(both.id)).toEqual(sorted([a.org.id, b.org.id]));
    expect(await orgsOf(a.people.owner.id)).toEqual([a.org.id]);
    expect(await orgsOf(b.people.owner.id)).toEqual([b.org.id]);
  });

  it("finds nothing even when the request carries the wrong workspace: another workspace's owner using this workspace's context", async () => {
    // A bug that paired a signed-in user with a workspace they do not belong to must fail closed in the database, not only in application code.
    const forged = ctxFor(b.people.owner, a.org, "owner");
    expect((await listConversationsPage(forged, { limit: 100 })).items).toEqual([]);
    expect(await inboxViewCounts(forged)).toMatchObject({ all: 0, unread: 0, open: 0 });
    for (const p of aPeople) for (const term of facets(p)) expect(await found(forged, term), term).toEqual([]);
  });

  it("returns no row of another workspace from any table the search reads, with no workspace condition at all", async () => {
    const asA = a.people.owner.id;
    const b0 = bPeople[0];
    const b1 = bPeople[1];
    expect(await count(asA, "select count(*)::text as n from conversation_messages where body ilike $1 or body ilike $2", [`%${b0.label}history%`, `%${b1.label}latest%`])).toBe(0);
    expect(await count(asA, "select count(*)::text as n from conversations where subject ilike $1 or last_message_preview ilike $2", [`%${b1.label}subject%`, `%${b0.label}latest%`])).toBe(0);
    expect(await count(asA, "select count(*)::text as n from contact_identities where value ilike $1 or value ilike $2", [`%${b0.address}%`, `%${b1.address}%`])).toBe(0);
    expect(await count(asA, "select count(*)::text as n from contacts where display_name ilike $1 or display_name ilike $2", [`%${b0.name}%`, `%${b1.name}%`])).toBe(0);
    expect(await count(asA, "select count(*)::text as n from conversation_events where org_id = $1", [b.org.id])).toBe(0);
    // And a term only workspace B holds is found by B's own people through the very same statements.
    expect(await count(b.people.owner.id, "select count(*)::text as n from conversation_messages where body ilike $1", [`%${b0.label}history%`])).toBe(1);
    expect(await count(b.people.owner.id, "select count(*)::text as n from contact_identities where value ilike $1", [`%${b1.address}%`])).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 3. Inside a workspace: who may open a conversation decides who can find it
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("inside a workspace, search follows who may open each conversation", () => {
  it("lets an assigned-only role, a viewer and a manager find exactly what they may open, by every facet, including text only in an older message", async () => {
    const org = await messagingOrg({ name: "Roles Search Co" });
    const alder = await person(org, "alder", "email");
    const birch = await person(org, "birch", "sms");
    const cedar = await person(org, "cedar", "sms");
    const dogwood = await person(org, "dogwood", "sms");
    const ember = await person(org, "ember", "email");
    const everyone = [alder, birch, cedar, dogwood, ember];
    await withSystem(async (db) => {
      await db.query("update conversations set assigned_user_id = $2 where id = $1", [alder.conversationId, org.people.support.id]);
      await db.query("update conversations set assigned_user_id = $2 where id = $1", [cedar.conversationId, org.people.sales.id]);
      await db.query("update conversations set owner_kind = 'human', owner_user_id = $2 where id = $1", [dogwood.conversationId, org.people.support.id]);
      await db.query("update conversations set assigned_user_id = $2 where id = $1", [ember.conversationId, org.people.viewer.id]);
      // A private note on a conversation they may open, and on one they may not.
      await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'internal', 'human', 'alderprivatenote budget is tiny', 'note'), ($1, $3, 'internal', 'human', 'birchprivatenote', 'note')", [org.org.id, alder.conversationId, birch.conversationId]);
    });

    await expectVisible(org.ctx("support"), everyone, ["alder", "dogwood"], "support (assigned-only: assigned or taken over)");
    await expectVisible(org.ctx("sales"), everyone, ["cedar"], "sales rep (assigned-only)");
    await expectVisible(org.ctx("viewer"), everyone, ["ember"], "viewer (assigned-only)");
    await expectVisible(org.ctx("manager"), everyone, everyone.map((p) => p.label), "manager (sees every conversation)");
    await expectVisible(org.ctx("owner"), everyone, everyone.map((p) => p.label), "owner (sees every conversation)");

    // Private notes are never searched, not even by the person who can read them on the thread.
    for (const who of ["support", "manager", "owner"] as const) {
      expect(await found(org.ctx(who), "alderprivatenote"), who).toEqual([]);
      expect(await found(org.ctx(who), "birchprivatenote"), who).toEqual([]);
    }

    // The message table itself, asked directly, hides the conversations they may not open: not just the list.
    expect(await count(org.people.support.id, "select count(*)::text as n from conversation_messages where body ilike $1", ["%birchhistory%"])).toBe(0);
    expect(await count(org.people.support.id, "select count(*)::text as n from conversation_messages where body ilike $1", ["%alderhistory%"])).toBe(1);
    expect(await count(org.people.manager.id, "select count(*)::text as n from conversation_messages where body ilike $1", ["%birchhistory%"])).toBe(1);
    expect(await count(org.people.viewer.id, "select count(*)::text as n from conversation_messages")).toBe(await count(org.people.viewer.id, "select count(*)::text as n from conversation_messages where conversation_id = $1", [ember.conversationId]));

    // A wildcard or an empty-looking term never widens what a restricted person finds.
    for (const term of ["%", "_", "%%", "\\", "'", "\" or 1=1 --", "' or true --", "a".repeat(500)]) {
      expect(await found(org.ctx("support"), term), JSON.stringify(term)).toEqual([]);
      expect(await found(org.ctx("viewer"), term), JSON.stringify(term)).toEqual([]);
    }
    // A very short term (names, subjects and addresses only, not message text) still finds only what the person may open.
    const openable = sorted((await listConversationsPage(org.ctx("support"), { limit: 100 })).items.map((i) => i.id));
    expect(openable).toEqual(sorted([alder.conversationId, dogwood.conversationId]));
    const oneLetter = await found(org.ctx("support"), "e");
    expect(oneLetter.length).toBeGreaterThan(0);
    expect(oneLetter.every((id) => openable.includes(id))).toBe(true);

    // Reassigning moves the search results with it, at once.
    await withSystem((db) => db.query("update conversations set assigned_user_id = $2 where id = $1", [birch.conversationId, org.people.support.id]));
    await withSystem((db) => db.query("update conversations set assigned_user_id = null where id = $1", [cedar.conversationId]));
    await expectVisible(org.ctx("support"), everyone, ["alder", "birch", "dogwood"], "support after being given birch");
    await expectVisible(org.ctx("sales"), everyone, [], "sales rep after losing cedar");
  }, 120_000);

  it("matches an address of the same customer on another channel only to conversations the person may open, and discloses nothing the thread does not already show them", async () => {
    const org = await messagingOrg({ name: "Cross Channel Search Co" });
    const sms = await person(org, "willow", "sms");
    const workEmail = "willow.work@willow-mail.test";
    await withSystem((db) => db.query("insert into contact_identities (org_id, contact_id, kind, value) values ($1, $2, 'email', $3)", [org.org.id, sms.contactId, workEmail]));
    // The same customer now writes by email: the address resolves to the same contact, so this is a second conversation of theirs.
    const mail = await inbound(org.org.id, { channel: "email", address: workEmail, name: sms.name, subject: "willowsubject by mail", body: "willowmailbody hello" });
    expect(mail.contactId).toBe(sms.contactId);
    expect(mail.conversationId).not.toBe(sms.conversationId);
    await withSystem((db) => db.query("update conversations set assigned_user_id = $2 where id = $1", [sms.conversationId, org.people.support.id]));

    // Searching the customer's email finds the conversations of that customer, whichever channel they are on, but only those the person may open.
    expect(await found(org.ctx("manager"), workEmail)).toEqual(sorted([sms.conversationId, mail.conversationId]));
    expect(await found(org.ctx("support"), workEmail)).toEqual([sms.conversationId]);
    expect(await found(org.ctx("support"), "willowsubject")).toEqual([]);
    expect(await found(org.ctx("support"), "willowmailbody")).toEqual([]);
    expect(await found(org.ctx("sales"), workEmail)).toEqual([]);
    expect(await found(org.ctx("sales"), sms.address)).toEqual([]);
    // What they find is what the conversation they may open already shows: the contact panel of the thread lists every address of the customer.
    const thread = await loadInboxThread(org.ctx("support"), sms.conversationId);
    expect(thread?.contact.identities.map((i) => i.value)).toEqual(expect.arrayContaining([workEmail, sms.address]));
    expect(await loadInboxThread(org.ctx("support"), mail.conversationId)).toBeNull();
    // Another customer's address is not matched through this customer.
    const other = await person(org, "yarrow", "email");
    expect(await found(org.ctx("manager"), other.address)).toEqual([other.conversationId]);
  }, 60_000);

  it("follows per-person permission overrides: withdrawing see-everything, granting it, or withdrawing contact access", async () => {
    const org = await messagingOrg({ name: "Overrides Search Co" });
    const fern = await person(org, "fern", "sms");
    const gorse = await person(org, "gorse", "email");
    const everyone = [fern, gorse];
    await withSystem((db) => db.query("update conversations set assigned_user_id = $2 where id = $1", [fern.conversationId, org.people.support.id]));
    const override = (user: string, permission: string, effect: "grant" | "revoke") =>
      withSystem((db) => db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, $3, $4, 'search isolation test')", [org.org.id, user, permission, effect]));

    // A manager loses "see every conversation": they find only what is assigned to them.
    await override(org.people.manager.id, "inbox.view_all", "revoke");
    await expectVisible(org.ctx("manager"), everyone, [], "manager without see-everything, nothing assigned");
    await withSystem((db) => db.query("update conversations set assigned_user_id = $2 where id = $1", [gorse.conversationId, org.people.manager.id]));
    await expectVisible(org.ctx("manager"), everyone, ["gorse"], "manager without see-everything, gorse assigned");

    // A sales rep is granted it: they find both, still only in this workspace.
    await override(org.people.sales.id, "inbox.view_all", "grant");
    await expectVisible(org.ctx("sales"), everyone, ["fern", "gorse"], "sales rep with see-everything");

    // Support loses access to contacts: a conversation is listed together with its contact, so with no contact access nothing is found, even their own assigned one.
    await override(org.people.support.id, "contacts.view", "revoke");
    await expectVisible(org.ctx("support"), everyone, [], "support without contact access");
    expect(await count(org.people.support.id, "select count(*)::text as n from conversation_messages where body ilike $1", ["%fernhistory%"])).toBe(1);
    expect((await listConversationsPage(org.ctx("support"), { limit: 100 })).items).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 4. People who are not entitled at all
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("people who are not entitled find nothing", () => {
  it("finds nothing for a signed-in stranger, a removed member, a disabled account, a request with no user, and the browser and site roles", async () => {
    const org = await messagingOrg({ name: "Strangers Search Co" });
    const p1 = await person(org, "hazel", "sms");
    const p2 = await person(org, "iris", "email");
    const everyone = [p1, p2];
    const stranger = await createUser({ name: "Signed In Stranger" });
    const removed = await createUser({ name: "Removed Member" });
    await addMember(org.org.id, removed.id, "admin");
    const disabled = await createUser({ name: "Disabled Account" });
    await addMember(org.org.id, disabled.id, "owner");
    // Before they are removed or disabled they do see everything (so the test would notice a search that ignored the change).
    await expectVisible(ctxFor(removed, org.org, "admin"), everyone, ["hazel", "iris"], "member before removal");
    await expectVisible(ctxFor(disabled, org.org, "owner"), everyone, ["hazel", "iris"], "owner before disabling");
    await withSystem(async (db) => {
      await db.query("update organization_memberships set status = 'revoked' where org_id = $1 and user_id = $2", [org.org.id, removed.id]);
      await db.query("update users set status = 'disabled' where id = $1", [disabled.id]);
    });

    for (const [who, user, role] of [["stranger", stranger, "owner"], ["removed member", removed, "admin"], ["disabled account", disabled, "owner"]] as const) {
      const ctx = ctxFor(user, org.org, role);
      await expectVisible(ctx, everyone, [], who);
      expect((await listConversationsPage(ctx, { limit: 100 })).items, who).toEqual([]);
      for (const table of SEARCHED_TABLES) expect(await count(user.id, `select count(*)::text as n from ${table}`), `${who} reads ${table}`).toBe(0);
    }

    for (const table of SEARCHED_TABLES) expect((await asNobody<{ n: string }>(`select count(*)::text as n from ${table}`))[0].n, `no user reads ${table}`).toBe("0");
    // A call without a usable user id never reaches the database as somebody; and the application role cannot switch row-level security off for itself.
    await expect(listConversationsPage({ ...org.ctx("owner"), user: { ...org.ctx("owner").user, id: "" } }, { q: "hazel" })).rejects.toThrow(/valid user id/);
    await expect(withUser(org.people.owner.id, async (db) => {
      await db.query("set local row_security = off");
      await db.query("select count(*) from conversation_messages");
    })).rejects.toThrow(/row-level security/i);
    expect((await asNobody<{ u: string | null }>("select app.current_user_id()::text as u"))[0].u).toBeNull();
    for (const role of ["anon", "authenticated"]) {
      await expect(withSystem(async (db) => {
        await db.query(`set local role ${role}`);
        await db.query("select count(*) from conversation_messages");
      }), role).rejects.toThrow(/permission denied/i);
    }
    await expect(withSiteRuntime((db) => db.query("select count(*) from conversations")), "site runtime").rejects.toThrow(/permission denied/i);
  }, 120_000);

  it("finds nothing for agency staff without a CRM support session, and only the client they opened a session for while it lasts", async () => {
    const x = await messagingOrg({ name: "Support Session X Co" });
    const y = await messagingOrg({ name: "Support Session Y Co" });
    const px = [await person(x, "juniper", "sms"), await person(x, "kestrel", "email")];
    const py = [await person(y, "laurel", "sms")];
    const everyone = [...px, ...py];
    const agency = await agencyPeople();
    const managerUser = await createUser({ platformRole: "agency_manager", name: "Agency Manager" });
    const manager = agencyUser(managerUser, "agency_manager");
    const people = [["agency staff", agency.staff], ["agency super admin", agency.superAdmin], ["agency manager", manager]] as const;
    const asClient = (user: { id: string; email: string }, org: MessagingOrg) => ctxFor(user, org.org, "viewer");
    const rawCount = (userId: string, org: MessagingOrg) => count(userId, "select count(*)::text as n from conversation_messages where org_id = $1", [org.org.id]);

    // 1. Not assigned, no session.
    for (const [who, user] of people) {
      await expectVisible(asClient(user, x), everyone, [], `${who} with nothing`);
      expect(await rawCount(user.id, x), who).toBe(0);
    }
    // 2. Assigned to client X, still no session.
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [x.org.id, agency.staff.id]));
    await expectVisible(asClient(agency.staff, x), everyone, [], "assigned agency staff without a session");
    expect(await rawCount(agency.staff.id, x)).toBe(0);
    expect(await inboxViewCounts(asClient(agency.staff, x))).toMatchObject({ all: 0 });

    // 3. A read session on X: X's conversations by every facet, never Y's. What a session lets a person read is decided by the agency permission table: agency staff and
    // managers hold the three read permissions the inbox needs, and the search must follow the table exactly (for a role that does not hold them, nothing is found).
    const readsInbox = async (userId: string) =>
      (await withSystem((db) => db.query<{ ok: boolean }>(
        "select app.user_has_agency_permission($1, 'inbox.view') and app.user_has_agency_permission($1, 'inbox.view_all') and app.user_has_agency_permission($1, 'contacts.view') as ok",
        [userId],
      ))).rows[0].ok;
    expect(await readsInbox(agency.staff.id), "agency staff may read the inbox in a session").toBe(true);
    expect(await readsInbox(manager.id), "an agency manager may read the inbox in a session").toBe(true);
    await startSupportSession(agency.staff, x.org.id, { mode: "read", reason: "Checking why a lead is missing" });
    await startSupportSession(agency.superAdmin, x.org.id, { mode: "read", reason: "Checking why a lead is missing" });
    await withSystem((db) => db.query("insert into crm_support_sessions (org_id, user_id, mode, reason, expires_at) values ($1, $2, 'read', 'Manager looking at one client', now() + interval '1 hour')", [x.org.id, manager.id]));
    for (const [who, user] of people) {
      const during = (await readsInbox(user.id)) ? px.map((p) => p.label) : [];
      await expectVisible(asClient(user, x), everyone, during, `${who} in a session on X`);
      expect(await rawCount(user.id, x), `${who} reads X's messages in a session`).toBe(during.length ? await rawCount(x.people.owner.id, x) : 0);
      await expectVisible(asClient(user, y), everyone, [], `${who} using Y's context during a session on X`);
      expect(await rawCount(user.id, y), `${who} reads Y`).toBe(0);
    }

    // 4. Ending the session ends the access; so does letting it expire.
    await endSupportSession(agency.staff, x.org.id);
    await endSupportSession(agency.superAdmin, x.org.id);
    await withSystem((db) => db.query("update crm_support_sessions set started_at = now() - interval '2 hours', expires_at = now() - interval '1 minute' where org_id = $1 and user_id = $2", [x.org.id, manager.id]));
    for (const [who, user] of people) {
      await expectVisible(asClient(user, x), everyone, [], `${who} after the session ended`);
      expect(await rawCount(user.id, x), who).toBe(0);
    }

    // 5. A suspended or archived client is closed to its own people and to agency people with an open session.
    await startSupportSession(agency.staff, x.org.id, { mode: "read", reason: "Looking again after the incident" });
    await expectVisible(asClient(agency.staff, x), everyone, px.map((p) => p.label), "agency staff, new session");
    expect(await rawCount(agency.staff.id, x), "agency staff read X's messages in the new session").toBeGreaterThan(0);
    for (const status of ["suspended", "archived"]) {
      await withSystem((db) => db.query("update organizations set status = $2 where id = $1", [x.org.id, status]));
      await expectVisible(asClient(agency.staff, x), everyone, [], `agency staff on a ${status} client`);
      await expectVisible(x.ctx("owner"), everyone, [], `the owner of a ${status} workspace`);
      await expectVisible(x.ctx("manager"), everyone, [], `a manager of a ${status} workspace`);
      expect(await rawCount(x.people.owner.id, x), `${status} owner reads`).toBe(0);
      await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [x.org.id]));
      await expectVisible(x.ctx("owner"), everyone, px.map((p) => p.label), `the owner after ${status} is lifted`);
    }
  }, 180_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 5. Removed and erased customers
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("removed and erased customers stop being found, and what the search matches is erased", () => {
  /** Every searched table's rows that still mention a needle anywhere in any column (whole-row JSON), for one workspace. */
  async function residue(orgId: string, needles: string[]) {
    const hits: string[] = [];
    for (const table of SEARCHED_TABLES) {
      for (const needle of needles) {
        const r = await withSystem((db) => db.query<{ n: string }>(`select count(*)::text as n from ${table} t where t.org_id = $1 and to_jsonb(t)::text ilike $2`, [orgId, `%${needle}%`]));
        if (Number(r.rows[0].n) > 0) hits.push(`${table}: ${needle}`);
      }
    }
    return hits;
  }

  it("hides a customer who was removed from the contact list, from every search and count, and brings them back if restored", async () => {
    const org = await messagingOrg({ name: "Soft Delete Search Co" });
    const gone = await person(org, "mallow", "email");
    const stays = await person(org, "nettle", "sms");
    const everyone = [gone, stays];
    await expectVisible(org.ctx("owner"), everyone, ["mallow", "nettle"], "before removal");
    expect((await inboxViewCounts(org.ctx("owner"))).all).toBe(2);
    await withSystem((db) => db.query("update contacts set deleted_at = now() where id = $1", [gone.contactId]));
    await expectVisible(org.ctx("owner"), everyone, ["nettle"], "owner after removal");
    await expectVisible(org.ctx("manager"), everyone, ["nettle"], "manager after removal");
    expect((await inboxViewCounts(org.ctx("owner"))).all).toBe(1);
    expect(await count(org.people.owner.id, "select count(*)::text as n from contacts where id = $1", [gone.contactId])).toBe(0);
    await withSystem((db) => db.query("update contacts set deleted_at = null where id = $1", [gone.contactId]));
    await expectVisible(org.ctx("owner"), everyone, ["mallow", "nettle"], "after restoring");
  }, 60_000);

  it("erases every searchable text of a contact who asked to be forgotten: name, number or address, subject, every message including private notes, and the preview", async () => {
    const org = await messagingOrg({ name: "Erasure Search Co" });
    const erased = await person(org, "oleander", "email");
    const kept = await person(org, "poppy", "sms");
    const everyone = [erased, kept];
    await withSystem((db) => db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) values ($1, $2, 'internal', 'human', 'oleandernote call after the move', 'note')", [org.org.id, erased.conversationId]));
    const needles = [erased.name, erased.address, "oleanderhistory", "oleanderlatest", "oleandersubject", "oleandernote"];
    await expectVisible(org.ctx("owner"), everyone, ["oleander", "poppy"], "before erasure");
    expect(await residue(org.org.id, needles)).toEqual(expect.arrayContaining([`conversation_messages: oleanderhistory`, `conversations: oleandersubject`]));

    await redactContact(org.ctx("owner"), erased.contactId, "Privacy request received by email");

    await expectVisible(org.ctx("owner"), everyone, ["poppy"], "owner after erasure");
    await expectVisible(org.ctx("manager"), everyone, ["poppy"], "manager after erasure");
    expect(await found(org.ctx("owner"), "oleandernote")).toEqual([]);
    // Nothing the search matches still holds their words, in any column of any table the search reads.
    expect(await residue(org.org.id, needles)).toEqual([]);
    // The other customer is untouched.
    expect(await residue(org.org.id, [kept.name, kept.address, "poppyhistory", "poppylatest"])).toEqual(expect.arrayContaining([`contacts: ${kept.name}`, `conversation_messages: poppyhistory`]));
  }, 60_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 6. The index changes plans, never results
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the trigram index on message text changes how a search is run, never what it returns", () => {
  it("returns the same rows to every role whichever plan runs, never a row of another workspace, and the index itself knows nothing of workspaces", async () => {
    const a = await messagingOrg({ name: "Index A Co" });
    const b = await messagingOrg({ name: "Index B Co" });
    const seed = async (org: MessagingOrg, conversations: number, tag: string, rareAt: number) => {
      await withSystem(async (db) => {
        await db.query(
          "insert into contacts (org_id, display_name, first_name, last_name, phone) select $1, $3::text || ' customer ' || g, 'C', g::text, '+1555' || lpad(g::text, 7, '0') from generate_series(1, $2::int) g",
          [org.org.id, conversations, tag],
        );
        await db.query(
          `insert into conversations (org_id, contact_id, channel, status, owner_kind, assigned_user_id, priority, unread_count, last_message_at, last_message_preview, created_at, updated_at)
           select $1, c.id, 'sms', 'open', 'unassigned', case when c.k % 10 = 0 then $2::uuid end, 'normal', 0, now() - (c.k * interval '1 minute'), 'Thanks ' || c.k,
                  now() - (c.k * interval '1 minute') - interval '1 day', now() - (c.k * interval '1 minute')
           from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1) c`,
          [org.org.id, org.people.support.id],
        );
        await db.query(
          `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at)
           select $1, cv.id, case when m % 2 = 0 then 'inbound' else 'outbound' end, case when m % 2 = 0 then 'contact' else 'ai' end,
                  $2::text || ' message ' || m || ' about ' || (case when m = 3 then 'needleword' when m = 4 and cv.k = $3::int then 'rareword' else 'plumbing' end),
                  case when m % 2 = 0 then 'received' else 'delivered' end, cv.last_message_at - (m * interval '3 minutes')
           from (select id, last_message_at, row_number() over (order by id)::int as k from conversations where org_id = $1) cv, generate_series(1, 5) m`,
          [org.org.id, tag, rareAt],
        );
        // The same private-note text in both workspaces: the index must not contain it, and no role may find it.
        await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status) select $1, id, 'internal', 'human', 'internalonlyword', 'note' from conversations where org_id = $1 limit 5", [org.org.id]);
      });
    };
    await seed(a, 3000, "alpha", 7);
    await seed(b, 1000, "bravo", 11);
    await withSystem(async (db) => {
      for (const t of ["conversations", "conversation_messages", "contacts", "contact_identities"]) await db.query(`analyze ${t}`);
    });

    // The search statement's message branch, with and without its `direction <> 'internal'` condition, and without any workspace condition.
    const SELECT_SQL = "select sm.org_id::text as org_id, sm.id::text as id from conversation_messages sm where sm.direction <> 'internal' and sm.body ilike $1";
    const WITH_NOTES_SQL = "select sm.org_id::text as org_id, sm.id::text as id from conversation_messages sm where sm.body ilike $1";
    const plans = {
      "default plan": [] as string[],
      "no index at all": ["set local enable_indexscan = off", "set local enable_bitmapscan = off"],
      "no sequential scan": ["set local enable_seqscan = off"],
    };
    const run = async (who: { id: string } | null, term: string, settings: string[], sql = SELECT_SQL) => {
      const go = async (db: { query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> }) => {
        for (const s of settings) await db.query(s);
        return (await db.query<{ org_id: string; id: string }>(`${sql} order by sm.id`, [`%${term}%`])).rows;
      };
      return who ? withUser(who.id, go) : withSystem(go);
    };
    /** What each role may read, written out by hand from the rules (see 0019 and 0060), without row-level security: the independent answer the database must match. */
    const byRule = async (orgId: string, userId: string | "everyone", term: string, notes = false) =>
      (await withSystem((db) => db.query<{ id: string }>(
        `select sm.id::text as id from conversation_messages sm join conversations c on c.id = sm.conversation_id and c.org_id = sm.org_id
         where sm.org_id = $1 and ($4 or sm.direction <> 'internal') and sm.body ilike $2 and ($3::text = 'everyone' or c.assigned_user_id::text = $3 or c.owner_user_id::text = $3) order by sm.id`,
        [orgId, `%${term}%`, userId, notes],
      ))).rows.map((r) => r.id);

    // The index is usable for this predicate: with no workspace condition and sequential scans off, the planner picks it (an embedded planner's choice, not a production claim).
    const systemPlan = await withSystem(async (db) => {
      await db.query("set local enable_seqscan = off");
      return (await db.query<{ "QUERY PLAN": string }>(`explain (costs off) ${SELECT_SQL}`, ["%rareword%"])).rows.map((r) => r["QUERY PLAN"]).join("\n");
    });
    expect(systemPlan).toContain("conversation_messages_body_trgm");

    // The index and a sequential scan both return both workspaces' rare-word message to a caller without row-level security: the index is not a tenant boundary,
    // row-level security and the query's own workspace condition are.
    for (const [name, settings] of Object.entries(plans)) expect(sorted((await run(null, "rareword", settings)).map((r) => r.org_id)), `system, ${name}`).toEqual(sorted([a.org.id, b.org.id]));

    // Under row-level security each role gets the same rows under every plan, all inside its own workspace, and exactly the rows its role allows by the written rule.
    const cases: Array<[string, { id: string }, MessagingOrg, string, number | null]> = [
      ["A owner, rare word", a.people.owner, a, "rareword", 1],
      ["A owner, common word", a.people.owner, a, "needleword", 3000],
      ["A support (a tenth of the conversations), rare word", a.people.support, a, "rareword", null],
      ["A support, common word", a.people.support, a, "needleword", 300],
      ["A viewer (nothing assigned), common word", a.people.viewer, a, "needleword", 0],
      ["B owner, rare word", b.people.owner, b, "rareword", 1],
      ["B owner, common word", b.people.owner, b, "needleword", 1000],
    ];
    for (const [label, who, org, term, wantCount] of cases) {
      const want = await byRule(org.org.id, org.people.owner.id === who.id || org.people.manager.id === who.id ? "everyone" : who.id, term);
      if (wantCount !== null) expect(want.length, `${label}: the hand-written rule agrees with the seed`).toBe(wantCount);
      const results: Array<readonly [string, Array<{ org_id: string; id: string }>]> = [];
      for (const [name, settings] of Object.entries(plans)) results.push([name, await run(who, term, settings)] as const);
      for (const [name, got] of results) {
        expect(got.every((r) => r.org_id === org.org.id), `${label}, ${name}: every row is in the caller's own workspace`).toBe(true);
        expect(got.map((r) => r.id), `${label}, ${name}: exactly the rows the rule allows`).toEqual(want);
      }
    }

    // Private notes: the exclusion is a rule of the search statement and of the index (its predicate), not of row-level security. Whoever may open a conversation can
    // read its notes on the thread, so asked WITHOUT the condition the database returns them to exactly those people, and to no one else.
    for (const [name, settings] of Object.entries(plans)) {
      expect(await run(a.people.owner, "internalonlyword", settings), `the search statement, ${name}`).toEqual([]);
      expect((await run(a.people.owner, "internalonlyword", settings, WITH_NOTES_SQL)).map((r) => r.org_id), `without the condition, ${name}`).toEqual(Array(5).fill(a.org.id));
      expect((await run(b.people.owner, "internalonlyword", settings, WITH_NOTES_SQL)).map((r) => r.org_id), `B's owner, ${name}`).toEqual(Array(5).fill(b.org.id));
      expect((await run(a.people.support, "internalonlyword", settings, WITH_NOTES_SQL)).map((r) => r.id), `support, ${name}`).toEqual(await byRule(a.org.id, a.people.support.id, "internalonlyword", true));
      expect(await run(a.people.viewer, "internalonlyword", settings, WITH_NOTES_SQL), `viewer, ${name}`).toEqual([]);
    }

    // The same through the real list: the rare-word conversation is found by the people who may open it and by no one else.
    const target = (await withSystem((db) => db.query<{ conversation_id: string }>("select conversation_id from conversation_messages where org_id = $1 and body ilike '%rareword%'", [a.org.id]))).rows[0].conversation_id;
    await withSystem((db) => db.query("update conversations set assigned_user_id = null, owner_kind = 'unassigned', owner_user_id = null where id = $1", [target]));
    expect(await found(a.ctx("owner"), "rareword")).toEqual([target]);
    expect(await found(a.ctx("support"), "rareword")).toEqual([]);
    expect(await found(b.ctx("owner"), "rareword")).not.toContain(target);
    await withSystem((db) => db.query("update conversations set assigned_user_id = $2 where id = $1", [target, a.people.support.id]));
    expect(await found(a.ctx("support"), "rareword")).toEqual([target]);
    expect(await found(b.ctx("support"), "rareword")).not.toContain(target);
  }, 240_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// 7. Positive controls: the probes above are able to see a leak
// ---------------------------------------------------------------------------------------------------------------------------------------------

class RolledBack extends Error {}

describe("positive controls: the raw probes used above do notice a weakened policy", () => {
  it("shows another workspace's and an unassigned conversation's messages once the conversations policy is weakened, in a transaction that is rolled back", async () => {
    const a = await messagingOrg({ name: "Control A Co" });
    const b = await messagingOrg({ name: "Control B Co" });
    const pa = await person(a, "quince", "sms");
    const pb = await person(b, "rowan", "sms");
    const policyText = async () => (await withSystem((db) => db.query<{ qual: string }>("select qual from pg_policies where tablename = 'conversations' and policyname = 'conversations_select'"))).rows[0].qual;
    const original = await policyText();
    const seen: Record<string, number> = {};
    await expect(withSystem(async (db) => {
      const as = async (userId: string, term: string) => {
        await db.query("select set_config('app.user_id', $1, true)", [userId]);
        await db.query("set local role iaq_app_user");
        const n = Number((await db.query<{ n: string }>("select count(*)::text as n from conversation_messages where body ilike $1", [`%${term}%`])).rows[0].n);
        await db.query("reset role");
        return n;
      };
      seen.supportOwnBefore = await as(a.people.support.id, `${pa.label}history`);
      seen.ownerOtherBefore = await as(a.people.owner.id, `${pb.label}history`);
      seen.ownerOwnBefore = await as(a.people.owner.id, `${pa.label}history`);
      await db.query("alter policy conversations_select on conversations using (true)");
      seen.supportOwnAfter = await as(a.people.support.id, `${pa.label}history`);
      seen.ownerOtherAfter = await as(a.people.owner.id, `${pb.label}history`);
      throw new RolledBack();
    })).rejects.toBeInstanceOf(RolledBack);
    // With the real policy: an assigned-only person finds neither an unassigned conversation's message nor another workspace's; the owner finds their own.
    expect(seen).toMatchObject({ supportOwnBefore: 0, ownerOtherBefore: 0, ownerOwnBefore: 1 });
    // With the policy weakened, the very same probes see the rows they must never see, so a clean result above means something.
    expect(seen).toMatchObject({ supportOwnAfter: 1, ownerOtherAfter: 1 });
    expect(await policyText()).toBe(original);
  }, 60_000);
});
