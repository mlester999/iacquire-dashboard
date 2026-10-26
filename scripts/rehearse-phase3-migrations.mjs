// Rehearses migrations 0087 (website chat) and 0088 (lead attribution) on EMBEDDED Postgres only (PGlite, in memory). It never reads an environment file, never
// opens a network connection and cannot reach any hosted database:
//   node scripts/rehearse-phase3-migrations.mjs [--report .data/phase3-migration-rehearsal.json]
//
// What it answers:
//   A. Numbers: across every branch and every sibling worktree, is 0087 / 0088 used by any other name, and is every migration number at 0077 or higher unique?
//   B. Order: another branch reserves 0084 (restricted Hermes provisioner), and 0087 / 0088 do not depend on each other. Is the schema identical in every order?
//   C. Data: with a populated database at the state before 0087, do 0087 and 0088 leave every existing contact, conversation, call and notification unchanged,
//      keep every earlier notification kind, conversation channel and contact origin, and accept the new ones?
//   D. Rollbacks: do the rollbacks REFUSE while chat or attribution data exists (and leave it intact), and, once it is gone, return the schema to exactly what
//      it was before each migration, so the migrations apply again afterwards with the existing data unchanged?
//   E. Row-level security and the published-site role: does every new table have row-level security, select-only access for the application role and nothing for
//      anon / authenticated / public; does one workspace's data stay away from another workspace's members and from a stranger; and can the role a published
//      site runs under read none of the new tables, only ask which widget key names its own host?
// Exit code 1 when A, B (if 0084 can be applied), C, D (refusal and exact return) or E fail.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const bail = (e) => {
  console.error(`The rehearsal could not finish: ${String(e?.stack ?? e?.message ?? e).slice(0, 900)}`);
  process.exit(2);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

const root = path.resolve(import.meta.dirname, "..");
const MIGRATIONS = path.join(root, "supabase", "migrations");
const ROLLBACKS = path.join(root, "supabase", "rollbacks");
const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
const reportPath = arg("--report");

const files = fs.readdirSync(MIGRATIONS).filter((f) => FILE.test(f)).sort();
const name = (f) => f.replace(/\.sql$/, "");
const prefix = (f) => f.slice(0, f.indexOf("_"));
const F87 = files.find((f) => prefix(f) === "0087");
const F88 = files.find((f) => prefix(f) === "0088");
if (!F87 || !F88) throw new Error("This checkout has no 0087 / 0088 migration.");
const base = files.filter((f) => Number(prefix(f)) < 87);

const result = { ok: true, sections: {}, notes: [] };
const section = (key, title) => (result.sections[key] = { title, failures: [], findings: [] });
const fail = (key, message) => {
  result.ok = false;
  result.sections[key].failures.push(message);
};
const finding = (key, message) => result.sections[key].findings.push(message);

// --------------------------------------------------------------------------------------------------------------------------------------------
// A. Numbers across branches and worktrees
// --------------------------------------------------------------------------------------------------------------------------------------------
section("A", "Migration numbers across all branches and worktrees");
{
  const refs = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const seen = new Map(); // prefix -> Map(name -> Set(blob))
  const holders = new Map(); // "0087_x.sql" -> [places]
  const note = (file, blob, place) => {
    const byName = seen.get(prefix(file)) ?? new Map();
    const blobs = byName.get(file) ?? new Set();
    blobs.add(blob);
    byName.set(file, blobs);
    seen.set(prefix(file), byName);
    holders.set(file, [...(holders.get(file) ?? []), place]);
  };
  for (const ref of refs) {
    let listing = "";
    try {
      listing = execFileSync("git", ["ls-tree", ref, "supabase/migrations/"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    for (const line of listing.trim().split("\n").filter(Boolean)) {
      const [meta, file] = line.split("\t");
      const b = path.basename(file);
      if (FILE.test(b) && Number(prefix(b)) >= 77) note(b, meta.split(" ")[2], ref);
    }
  }
  // Uncommitted work is in no ref: the working trees of this checkout and of every sibling worktree count too.
  const trees = [root];
  const dataDir = path.resolve(root, "..");
  for (const d of fs.readdirSync(dataDir)) if (d.startsWith("wt-") && path.join(dataDir, d) !== root) trees.push(path.join(dataDir, d));
  const mainTree = path.resolve(dataDir, "..");
  if (fs.existsSync(path.join(mainTree, "supabase", "migrations"))) trees.push(mainTree);
  let scanned = 0;
  for (const tree of trees) {
    const dir = path.join(tree, "supabase", "migrations");
    if (!fs.existsSync(dir)) continue;
    scanned += 1;
    for (const f of fs.readdirSync(dir)) {
      if (FILE.test(f) && Number(prefix(f)) >= 77) note(f, `file:${f}`, tree === root ? "this checkout" : `worktree ${path.basename(tree)}`);
    }
  }
  // Same name with different content is a conflict only within ONE place; across places the same name is the same migration travelling. Different NAMES for one number are the conflict.
  for (const [p, byName] of seen) if (byName.size > 1) fail("A", `number ${p} is used by ${byName.size} different files: ${[...byName.keys()].join(", ")}`);
  for (const f of [F87, F88]) {
    const elsewhere = (holders.get(f) ?? []).filter((r) => r !== "this checkout" && !/phases-3-7/.test(r));
    if (elsewhere.length) fail("A", `${f} already exists on ${[...new Set(elsewhere)].join(", ")}`);
  }
  const reserved = [...seen.keys()].filter((p) => Number(p) >= 84 && Number(p) <= 99).sort();
  finding("A", `${refs.length} branches and ${scanned} working trees scanned; numbers 0084 and above in use anywhere: ${reserved.join(", ")} (each with one name)`);
  const own = new Map();
  for (const f of files) own.set(prefix(f), [...(own.get(prefix(f)) ?? []), f]);
  for (const [p, names] of own) if (names.length > 1) fail("A", `this checkout uses number ${p} twice: ${names.join(", ")}`);
  if (!result.sections.A.failures.length) finding("A", `0087 and 0088 are unique across every branch, every sibling worktree and this checkout; no number from 0077 up has two names; next free number is ${String(Math.max(...files.map((f) => Number(prefix(f)))) + 1).padStart(4, "0")}`);
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// Embedded database helpers
// --------------------------------------------------------------------------------------------------------------------------------------------
async function newDb() {
  const db = new PGlite({ extensions: { citext, pg_trgm, btree_gist } });
  await db.waitReady;
  await db.transaction((tx) => tx.exec(fs.readFileSync(path.join(root, "supabase", "local-compat.sql"), "utf8")));
  await db.exec("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  return db;
}
const upSql = (db, sql, version) => db.transaction((tx) => tx.exec(`${sql}\ninsert into schema_migrations (version) values ('${version}') on conflict do nothing;`));
const up = (db, file) => upSql(db, fs.readFileSync(path.join(MIGRATIONS, file), "utf8"), name(file));
const down = (db, file) => db.transaction((tx) => tx.exec(fs.readFileSync(path.join(ROLLBACKS, `${name(file)}.down.sql`), "utf8")));
const q = async (db, sql, params) => (await db.query(sql, params)).rows;

const FINGERPRINT = `
  select 'column' as kind, table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' || coalesce(column_default, '') as item
    from information_schema.columns where table_schema = 'public'
  union all select 'constraint', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace = 'public'::regnamespace
  union all select 'index', indexdef from pg_indexes where schemaname = 'public'
  union all select 'policy', tablename || ':' || policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname = 'public'
  union all select 'trigger', event_object_table || ':' || trigger_name || ':' || action_timing || ':' || event_manipulation from information_schema.triggers where trigger_schema = 'public'
  union all select 'function', n.nspname || '.' || p.proname || ':' || md5(p.prosrc) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname in ('public', 'app')
  union all select 'rls', relname || ':' || relrowsecurity::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
  union all select 'grant', table_name || ':' || grantee || ':' || privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee in ('iaq_app_user', 'iaq_site_runtime')
  union all select 'execute', n.nspname || '.' || p.proname || ':' || r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on has_function_privilege(r.oid, p.oid, 'execute')
    where n.nspname = 'app' and r.rolname in ('iaq_app_user', 'iaq_site_runtime', 'anon', 'authenticated')`;
// The notification allow-list is compared as a SET of kinds (the database prints the same constraint as an IN list or an array literal, in any order).
const KINDS_PREFIX = "notifications:notifications_kind_check:";
const kindsOf = (text) => [...text.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
const normal = (r) => (r.kind === "constraint" && r.item.startsWith(KINDS_PREFIX) ? `${r.kind}|${KINDS_PREFIX}kinds=${[...new Set(kindsOf(r.item))].sort().join(",")}` : `${r.kind}|${r.item}`);
const fingerprint = async (db) => new Set((await q(db, FINGERPRINT)).map(normal));
const diff = (a, b) => ({ onlyBefore: [...a].filter((x) => !b.has(x)).sort(), onlyAfter: [...b].filter((x) => !a.has(x)).sort() });
const same = (d) => !d.onlyBefore.length && !d.onlyAfter.length;
const kindsNow = async (db) => kindsOf((await q(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass"))[0].d);
const forget = (db, file) => db.query("delete from schema_migrations where version = $1", [name(file)]);
const accepts = async (db, sql, params) => {
  try {
    await db.transaction(async (tx) => {
      await tx.query(sql, params);
      throw new Error("rolled back on purpose");
    });
  } catch (e) {
    return e.message === "rolled back on purpose";
  }
  return false;
};

// --------------------------------------------------------------------------------------------------------------------------------------------
// B. Order against the reserved 0084, and between 0087 and 0088
// --------------------------------------------------------------------------------------------------------------------------------------------
section("B", "Order independence from the reserved 0084 and between 0087 and 0088");
{
  let sql84 = null;
  let source = null;
  for (const ref of ["codex/client-ai-onboarding", "codex/hermes-gha-acceptance"]) {
    try {
      const listing = execFileSync("git", ["ls-tree", "--name-only", ref, "supabase/migrations/"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const file = listing.split("\n").map((l) => path.basename(l)).find((l) => l.startsWith("0084_"));
      if (!file) continue;
      sql84 = { file, sql: execFileSync("git", ["show", `${ref}:supabase/migrations/${file}`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) };
      source = ref;
      break;
    } catch {
      /* try the next ref */
    }
  }
  const chain = async (order) => {
    const db = await newDb();
    for (const f of base) await up(db, f);
    for (const step of order) {
      if (step === "84") await upSql(db, sql84.sql, name(sql84.file));
      else await up(db, step === "87" ? F87 : F88);
    }
    return db;
  };
  const reference = await chain(["87", "88"]);
  const fpRef = await fingerprint(reference);
  await reference.close();
  // Every order is compared with the same chain it would have on the primary path: 0087, 0088, and 0084 first when it takes part.
  let fpRef84 = null;
  if (sql84) {
    const r = await chain(["84", "87", "88"]);
    fpRef84 = await fingerprint(r);
    await r.close();
  } else {
    finding("B", "0084 was not found on any branch, so only the order of 0087 and 0088 was rehearsed");
  }
  const orders = [["88", "87"]];
  if (sql84) orders.push(["87", "84", "88"], ["87", "88", "84"], ["88", "84", "87"]);
  let rehearsed = 0;
  for (const order of orders) {
    try {
      const db = await chain(order);
      const d = diff(order.includes("84") ? fpRef84 : fpRef, await fingerprint(db));
      if (!same(d)) fail("B", `order ${order.join(" → ")} gives a different schema: ${JSON.stringify(d).slice(0, 600)}`);
      else rehearsed += 1;
      await db.close();
    } catch (e) {
      finding("B", `order ${order.join(" → ")} could not be applied in this checkout (${String(e.message).slice(0, 200)})`);
    }
  }
  if (!result.sections.B.failures.length) finding("B", `${rehearsed} other orders${sql84 ? ` (with ${sql84.file} from ${source} before, between and after)` : ""}: identical schema (${fpRef.size} schema facts compared)`);
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// C and D. Data through up, down, up
// --------------------------------------------------------------------------------------------------------------------------------------------
section("C", "Existing data through 0087 and 0088");
section("D", "Rollbacks");
{
  const db = await newDb();
  for (const f of base) await up(db, f);
  const fp86 = await fingerprint(db);
  const kinds86 = await kindsNow(db);
  const org = (await q(db, "insert into organizations (name, slug, kind, status) values ('Rehearsal Co', 'rehearsal-co', 'client', 'active') returning id"))[0].id;
  const user = (await q(db, "insert into users (email, full_name, email_verified_at) values ('rehearsal@example.test', 'Rehearsal User', now()) returning id"))[0].id;
  await db.query("insert into contacts (org_id, display_name, phone) select $1, 'Customer ' || g, '+1555' || lpad(g::text, 7, '0') from generate_series(1, 400) g", [org]);
  await db.query(
    `insert into conversations (org_id, contact_id, channel, status, owner_kind, priority, unread_count, last_message_at, last_message_preview)
     select $1, c.id, 'sms', 'open', 'unassigned', 'normal', 0, now() - (c.k * interval '16 minutes'), 'Thanks ' || c.k
     from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1) c`, [org]);
  await db.query(
    `insert into crm_call_records (org_id, provider, provider_call_id, direction, status, from_number, to_number, contact_id, started_at, ended_at)
     select $1, 'vapi', 'rehearsal-' || k.n, 'inbound', 'no_answer', k.phone, '+15555550100', k.id, now() - (k.n * interval '17 minutes'), now() - (k.n * interval '17 minutes') + interval '20 seconds'
     from (select id, phone, row_number() over (order by id)::int as n from contacts where org_id = $1) k`, [org]);
  await db.query("insert into notifications (org_id, user_id, kind, title) select $1, $2, 'system', 'Rehearsal notice ' || g from generate_series(1, 25) g", [org, user]);
  const snap = async () => ({
    contacts: await q(db, "select md5(string_agg(id::text || display_name || coalesce(phone, ''), ',' order by id)) as h, count(*)::int as n from contacts"),
    conversations: await q(db, "select md5(string_agg(id::text || channel || status || owner_kind || priority || coalesce(last_message_preview, ''), ',' order by id)) as h, count(*)::int as n from conversations"),
    calls: await q(db, "select md5(string_agg(id::text || direction || status || coalesce(from_number, ''), ',' order by id)) as h, count(*)::int as n from crm_call_records"),
    notifications: await q(db, "select md5(string_agg(id::text || kind || title, ',' order by id)) as h, count(*)::int as n from notifications"),
  });
  const s0 = await snap();
  const check = (label, key = "C") => async () => { if (JSON.stringify(await snap()) !== JSON.stringify(s0)) fail(key, `existing data changed after ${label}`); };

  await up(db, F87);
  await check("0087 up")();
  const fp87 = await fingerprint(db);
  await up(db, F88);
  await check("0088 up")();
  const kindsFull = await kindsNow(db);
  const lost = kinds86.filter((k) => !kindsFull.includes(k));
  if (lost.length) fail("C", `notification kinds lost: ${lost.join(", ")}`);
  if (!kindsFull.includes("web_chat_lead")) fail("C", "the notification kind web_chat_lead was not added");
  const fpFull = await fingerprint(db);
  finding("C", `${s0.contacts[0].n} contacts, ${s0.conversations[0].n} conversations, ${s0.calls[0].n} calls, ${s0.notifications[0].n} notifications unchanged after 0087 and 0088; ${kinds86.length} earlier notification kinds kept, 1 added`);

  // The widened constraints: old values still pass, the new ones pass, anything else still fails.
  const contact = (await q(db, "select id, phone from contacts where org_id = $1 order by id limit 1", [org]))[0];
  // A fresh contact each time: a contact already holds one conversation per channel.
  const conv = (channel) => accepts(db, "with c as (insert into contacts (org_id, display_name) values ($1, 'Channel probe') returning id) insert into conversations (org_id, contact_id, channel, status, owner_kind, priority, unread_count) select $1, c.id, $2, 'open', 'unassigned', 'normal', 0 from c", [org, channel]);
  for (const ch of ["sms", "whatsapp", "email", "web_chat"]) if (!(await conv(ch))) fail("C", `a ${ch} conversation is refused after 0087`);
  if (await conv("fax")) fail("C", "a conversation on an unknown channel is accepted after 0087");
  const via = (v) => accepts(db, "insert into contacts (org_id, display_name, created_via) values ($1, 'Via', $2)", [org, v]);
  for (const v of ["manual", "inbound_message", "call", "website_form", "website_chat"]) if (!(await via(v))) fail("C", `a contact created via ${v} is refused after 0087`);
  if (await via("telepathy")) fail("C", "a contact with an unknown created_via is accepted after 0087");
  if (!result.sections.C.failures.length) finding("C", "after 0087 the conversation channels sms, whatsapp, email and web_chat and the contact origins (including website_chat) are accepted; an unknown channel or origin is still refused");

  // Data the rollbacks must protect. Each condition on its own: the rollback refuses, nothing changes, the condition is removed again.
  const widgetKey = "wk_" + "a".repeat(24);
  await db.query("insert into web_chat_widgets (org_id, public_key) values ($1, $2)", [org, widgetKey]);
  const fpWithConfig = await fingerprint(db);
  const refusal = async (file, label, setup, cleanup, counts) => {
    await setup();
    try {
      await down(db, file);
      fail("D", `${name(file)} rolled back while ${label} existed (it must refuse)`);
    } catch (e) {
      if (!/Rollback refused/.test(String(e.message))) fail("D", `${name(file)} failed for another reason while ${label} existed: ${String(e.message).slice(0, 200)}`);
      else finding("D", `${name(file)}: refused while ${label} existed`);
    }
    for (const [table, expected] of counts) {
      const n = Number((await q(db, `select count(*) as n from ${table}`))[0].n);
      if (n !== expected) fail("D", `${table} has ${n} rows after the refused rollback (expected ${expected})`);
    }
    if (!same(diff(fpWithConfig, await fingerprint(db)))) fail("D", `the schema changed although ${name(file)} refused`);
    await cleanup();
  };
  const sessionSql = "insert into web_chat_sessions (org_id, token_hash, surface, origin_host) values ($1, $2, 'embed', 'example.test')";
  await refusal(F88, "a lead touch", async () => {
    await db.query("insert into lead_touches (org_id, contact_id, kind, source, confidence, evidence) values ($1, $2, 'manual', 'referral', 'known', 'manual')", [org, contact.id]);
  }, () => db.query("delete from lead_touches"), [["lead_touches", 1]]);
  await refusal(F88, "an entered cost", async () => {
    await db.query("insert into attribution_costs (org_id, source, period_start, period_end, amount, currency) values ($1, 'google', '2026-01-01', '2026-01-31', 100, 'USD')", [org]);
  }, () => db.query("delete from attribution_costs"), [["attribution_costs", 1]]);
  await refusal(F88, "a contact touch pointer", () => db.query("update contacts set first_touch_id = 999 where id = $1", [contact.id]), () => db.query("update contacts set first_touch_id = null where id = $1", [contact.id]), [["contacts", Number(s0.contacts[0].n)]]);
  await refusal(F87, "a chat session", () => db.query(sessionSql, [org, "a".repeat(64)]), () => db.query("delete from web_chat_sessions"), [["web_chat_sessions", 1]]);
  await refusal(F87, "a switched-on widget", () => db.query("update web_chat_widgets set enabled = true where org_id = $1", [org]), () => db.query("update web_chat_widgets set enabled = false where org_id = $1", [org]), [["web_chat_widgets", 1]]);
  await refusal(F87, "an allowed site on the widget", () => db.query("update web_chat_widgets set allowed_origins = '{www.example.test}' where org_id = $1", [org]), () => db.query("update web_chat_widgets set allowed_origins = '{}' where org_id = $1", [org]), [["web_chat_widgets", 1]]);
  await refusal(F87, "a notification of the chat kind", () => db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'web_chat_lead', 'Chat lead')", [org, user]), () => db.query("delete from notifications where kind = 'web_chat_lead'"), [["notifications", Number(s0.notifications[0].n) + 1]]);
  // A web_chat conversation and a contact created through the chat are rows the data snapshot covers, so they get their own counts below.
  const chatConv = (await q(db, "insert into conversations (org_id, contact_id, channel, status, owner_kind, priority, unread_count) values ($1, $2, 'web_chat', 'open', 'unassigned', 'normal', 0) returning id", [org, contact.id]))[0].id;
  await refusal(F87, "a web_chat conversation", async () => {}, async () => {}, [["conversations", Number(s0.conversations[0].n) + 1]]);
  await db.query("delete from conversations where id = $1", [chatConv]);
  const viaId = (await q(db, "insert into contacts (org_id, display_name, created_via) values ($1, 'Chat visitor', 'website_chat') returning id", [org]))[0].id;
  await refusal(F87, "a contact created through the chat", async () => {}, async () => {}, [["contacts", Number(s0.contacts[0].n) + 1]]);
  await db.query("delete from contacts where id = $1", [viaId]);
  await check("the refused rollbacks", "D")();

  // With the data gone, roll back newest first and compare with the schema before each migration. A default (disabled, never used) widget row does not block
  // 0087's rollback: it is configuration, not a conversation, and goes with the table.
  for (const [file, expected] of [[F88, fp87], [F87, fp86]]) {
    try {
      await down(db, file);
    } catch (e) {
      fail("D", `${name(file)} could not be rolled back on an empty workspace: ${String(e.message).slice(0, 300)}`);
      continue;
    }
    const d = diff(expected, await fingerprint(db));
    if (same(d)) finding("D", `${name(file)}: rolled back to exactly the schema before it${file === F87 ? " (an unused default widget row went with its table)" : ""}`);
    else fail("D", `${name(file)}: rolled back, but the schema differs from before it: ${JSON.stringify(d).slice(0, 1200)}`);
    await check(`${name(file)} rollback`, "D")();
    await forget(db, file);
  }
  const kindsBack = await kindsNow(db);
  if (JSON.stringify([...new Set(kindsBack)].sort()) !== JSON.stringify([...new Set(kinds86)].sort())) fail("D", "the notification kinds after both rollbacks differ from before 0087");
  if (await accepts(db, "insert into conversations (org_id, contact_id, channel, status, owner_kind, priority, unread_count) values ($1, $2, 'web_chat', 'open', 'unassigned', 'normal', 0)", [org, contact.id])) fail("D", "a web_chat conversation is still accepted after the rollbacks");
  // Apply again: the migrations must work after a rollback, with the data intact.
  try {
    await up(db, F87);
    await up(db, F88);
    await check("applying 0087 and 0088 again", "D")();
    if (!same(diff(fpFull, await fingerprint(db)))) fail("D", "applying 0087 and 0088 again gives a different schema from the first time");
    else finding("D", "applied again after the rollbacks: the same schema as the first time, existing data unchanged");
  } catch (e) {
    fail("D", `0087 / 0088 could not be applied again after their rollbacks: ${String(e.message).slice(0, 300)}`);
  }
  await db.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// E. Row-level security and the published-site role
// --------------------------------------------------------------------------------------------------------------------------------------------
section("E", "Row-level security and the published-site role");
{
  const db = await newDb();
  for (const f of files) await up(db, f);
  const tables = [];
  for (const f of [F87, F88]) tables.push(...[...fs.readFileSync(path.join(MIGRATIONS, f), "utf8").matchAll(/create table(?: if not exists)? +(?:public\.)?([a-z_]+)/gi)].map((m) => m[1]));
  const noRls = (await q(db, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity")).map((r) => r.relname);
  for (const t of tables) if (noRls.includes(t)) fail("E", `${t} has no row-level security`);
  const grants = await q(db, "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = any($1)", [tables]);
  for (const g of grants) {
    if (g.grantee === "iaq_app_user" && g.privilege_type !== "SELECT") fail("E", `${g.table_name}: iaq_app_user holds ${g.privilege_type} (select only expected)`);
    if (["anon", "authenticated", "PUBLIC", "iaq_site_runtime"].includes(g.grantee)) fail("E", `${g.table_name}: ${g.grantee} holds ${g.privilege_type}`);
  }
  const selectors = tables.filter((t) => grants.some((g) => g.table_name === t && g.grantee === "iaq_app_user" && g.privilege_type === "SELECT"));
  if (selectors.length !== tables.length) fail("E", `iaq_app_user cannot read: ${tables.filter((t) => !selectors.includes(t)).join(", ")}`);
  const policies = await q(db, "select tablename, qual from pg_policies where schemaname = 'public' and tablename = any($1)", [tables]);
  for (const t of tables) if (!policies.some((p) => p.tablename === t && /permitted_orgs/.test(p.qual ?? ""))) fail("E", `${t} has no policy that goes through app.permitted_orgs`);
  finding("E", `${tables.length} new tables (${tables.join(", ")}), every one with row-level security, a workspace-membership policy and select-only access for the application role (nothing for anon, authenticated, public or the published-site role)`);

  // A probe as the application role: two workspaces, an owner each, and a stranger.
  const mk = async (slug) => (await q(db, "insert into organizations (name, slug, kind, status) values ($1::text, $1::text, 'client', 'active') returning id", [slug]))[0].id;
  const orgA = await mk("probe-a");
  const orgB = await mk("probe-b");
  const mkUser = async (email) => (await q(db, "insert into users (email, full_name, email_verified_at) values ($1::text, $1::text, now()) returning id", [email]))[0].id;
  const ownerA = await mkUser("a@example.test");
  const ownerB = await mkUser("b@example.test");
  const stranger = await mkUser("stranger@example.test");
  await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [orgA, ownerA, orgB, ownerB]);
  for (const [o, ch] of [[orgA, "a"], [orgB, "b"]]) {
    const c = (await q(db, "insert into contacts (org_id, display_name, phone) values ($1, 'Probe', '+15550000001') returning id", [o]))[0].id;
    await db.query("insert into web_chat_widgets (org_id, public_key, enabled) values ($1, $2, true)", [o, "wk_" + ch.repeat(24)]);
    await db.query("insert into web_chat_sessions (org_id, token_hash, surface, origin_host) values ($1, $2, 'embed', 'example.test')", [o, ch.repeat(64)]);
    await db.query("insert into lead_touches (org_id, contact_id, kind, source, confidence, evidence) values ($1, $2, 'website_chat', 'google', 'known', 'utm')", [o, c]);
    await db.query("insert into attribution_costs (org_id, source, period_start, period_end, amount, currency) values ($1, 'google', '2026-01-01', '2026-01-31', 10, 'USD')", [o]);
  }
  const asUser = async (userId, sql) => {
    let rows = [];
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true), set_config('role', 'iaq_app_user', true)", [userId ?? ""]);
      await tx.query("set local role iaq_app_user");
      rows = (await tx.query(sql)).rows;
    });
    return rows;
  };
  const visible = async (userId, table) => (await asUser(userId, `select org_id from ${table}`)).map((r) => r.org_id);
  for (const table of tables) {
    const seen = { ownerA: await visible(ownerA, table), ownerB: await visible(ownerB, table), stranger: await visible(stranger, table), nobody: await visible(null, table) };
    if (seen.ownerA.some((o) => o !== orgA)) fail("E", `${table}: the owner of workspace A can read another workspace's rows`);
    if (seen.ownerB.some((o) => o !== orgB)) fail("E", `${table}: the owner of workspace B can read another workspace's rows`);
    if (seen.stranger.length) fail("E", `${table}: a signed-in stranger can read ${seen.stranger.length} rows`);
    if (seen.nobody.length) fail("E", `${table}: a request with no user can read ${seen.nobody.length} rows`);
    // A probe that found nothing to read would pass the checks above by default: each owner must see exactly their own workspace's row.
    if (seen.ownerA.length !== 1 || seen.ownerB.length !== 1) fail("E", `${table}: each owner should see exactly their own workspace's row (A ${seen.ownerA.length}, B ${seen.ownerB.length})`);
  }
  for (const table of tables) {
    let wrote = false;
    try {
      await db.transaction(async (tx) => {
        await tx.query("select set_config('app.user_id', $1, true)", [ownerA]);
        await tx.query("set local role iaq_app_user");
        await tx.query(`delete from ${table}`);
        wrote = true;
      });
    } catch {
      /* expected: no write grant */
    }
    if (wrote) fail("E", `the application role could delete from ${table} (writes must only happen in trusted server code)`);
  }
  if (!result.sections.E.failures.length) finding("E", "as the application role: each owner reads only their own workspace's rows in all four tables; a stranger and a request with no user read nothing; a delete is refused on all four");

  // The role a published site runs under: no table privileges at all; it can only ask which widget key names its host.
  const roleExists = (await q(db, "select 1 from pg_roles where rolname = 'iaq_site_runtime'")).length > 0;
  if (!roleExists) {
    fail("E", "the role iaq_site_runtime does not exist in the rehearsal database");
  } else {
    for (const table of tables) {
      let read = false;
      try {
        await db.transaction(async (tx) => {
          await tx.query("set local role iaq_site_runtime");
          await tx.query(`select 1 from ${table} limit 1`);
          read = true;
        });
      } catch {
        /* expected: permission denied */
      }
      if (read) fail("E", `the published-site role can read ${table}`);
    }
    let rows = null;
    let error = null;
    try {
      await db.transaction(async (tx) => {
        await tx.query("set local role iaq_site_runtime");
        rows = (await tx.query("select * from app.site_chat_widget('unknown.example.test')")).rows;
      });
    } catch (e) {
      error = e.message;
    }
    if (error) fail("E", `the published-site role cannot call app.site_chat_widget: ${error.slice(0, 200)}`);
    else if (rows.length) fail("E", "app.site_chat_widget returned a key for a host that is not a published site");
    const execs = await q(db, "select r.rolname from pg_roles r where r.rolname in ('iaq_app_user', 'anon', 'authenticated') and has_function_privilege(r.rolname, 'app.site_chat_widget(text)', 'execute')");
    if (execs.length) fail("E", `app.site_chat_widget can also be executed by ${execs.map((r) => r.rolname).join(", ")}`);
    // A published, verified host whose workspace switched the chat on gets exactly its own key, and a workspace that did not gets nothing.
    const w = (await q(db, "insert into websites (org_id, name, template_key, subdomain, draft_content) values ($1, 'Site', 'summit.peak', 'probe-a', '{}'::jsonb) returning id", [orgA]))[0].id;
    await db.query("insert into website_domains (org_id, website_id, hostname, kind, status, verification_token, acquisition, is_primary) values ($1, $2, 'probe-a.example.test', 'platform', 'active', 'abcdef0123456789abcdef0123456789', 'platform', true)", [orgA, w]);
    const keyFor = async (host) => {
      let out = [];
      await db.transaction(async (tx) => {
        await tx.query("set local role iaq_site_runtime");
        out = (await tx.query("select public_key from app.site_chat_widget($1)", [host])).rows;
      });
      return out;
    };
    const unpublished = await keyFor("probe-a.example.test");
    // The probe site has no live publication yet, so the function must say nothing: a verified domain alone is not a live site.
    if (unpublished.length) fail("E", "app.site_chat_widget returned a key for a host with no live publication");
    if (!result.sections.E.failures.length) finding("E", "as the published-site role: none of the four new tables can be read; app.site_chat_widget answers nothing for an unknown host or an unpublished one, runs for that role and for no other (the positive path, a live publication with the chat on, is covered by tests/webchat-site.test.ts)");
  }
  await db.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
console.log(`Phase 3 migration rehearsal on embedded Postgres (0087 ${name(F87)}, 0088 ${name(F88)}; ${files.length} migrations in this checkout)`);
for (const [key, s] of Object.entries(result.sections)) {
  console.log(`\n${key}. ${s.title}: ${s.failures.length ? "FAIL" : "ok"}`);
  for (const x of s.failures) console.log(`   FAIL  ${x}`);
  for (const x of s.findings) console.log(`   ${x}`);
}
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(reportPath), JSON.stringify(result, null, 2));
  console.log(`\nreport written to ${reportPath}`);
}
process.exit(result.ok ? 0 : 1);
