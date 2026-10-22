// Rehearses the migration chain on EMBEDDED Postgres only (PGlite, in memory). It never reads an environment file, never opens a network connection and
// cannot reach any hosted database: node scripts/rehearse-migration-order.mjs [--report .data/migration-rehearsal.json] [--refs a,b,c]
//
// What it answers, for the migrations in the current checkout (and, with --refs, for the same migrations across the branches meant to be integrated):
//   A. Across branches: does any migration number appear under two names, or does one name have two different contents?
//   B. Order: does applying 0082 after 0083 (instead of before) give exactly the same schema? (It must: they touch different tables.)
//   C. Data: with a populated database at the state just before 0083, does applying 0083, rolling it back, and applying it again leave every existing
//      contact, conversation, message and notification unchanged, and keep the notification kinds that already existed?
//   D. Rollbacks: does rolling back 0083, 0082 and 0081 (newest first) return the schema to exactly what it was before each one?
//   E. Row-level security: which tables have it, and does every table the last three migrations created?
// Exit code 1 when A, B, C or the new tables' part of E fail; D reports differences without failing (rollbacks are for emergencies and are reviewed by a person).
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

// A failure of the rehearsal itself (not of what it checks) prints one short line instead of a stack from the database engine.
const bail = (e) => {
  console.error(`The rehearsal could not finish: ${String(e?.message ?? e).slice(0, 400)}`);
  process.exit(2);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

const root = path.resolve(import.meta.dirname, "..");
const MIGRATIONS = path.join(root, "supabase", "migrations");
const ROLLBACKS = path.join(root, "supabase", "rollbacks");
const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const reportPath = arg("--report");
const refs = (arg("--refs") ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const files = fs.readdirSync(MIGRATIONS).filter((f) => FILE.test(f)).sort();
const name = (f) => f.replace(/\.sql$/, "");
const prefix = (f) => f.slice(0, f.indexOf("_"));
const find = (p) => files.find((f) => prefix(f) === p);
const F81 = find("0081"), F82 = find("0082"), F83 = find("0083");
if (!F83) throw new Error("This checkout has no 0083 migration.");

const result = { ok: true, sections: {}, notes: [] };
const fail = (section, message) => {
  result.ok = false;
  (result.sections[section].failures ??= []).push(message);
};
const section = (key, title) => (result.sections[key] = { title, failures: [], findings: [] });

// --------------------------------------------------------------------------------------------------------------------------------------------
// A. Across branches (static, from git)
// --------------------------------------------------------------------------------------------------------------------------------------------
section("A", "Migration numbers and names across the branches");
if (refs.length) {
  const seen = new Map(); // prefix -> Map(name -> Set(blob))
  const perRef = {};
  for (const ref of refs) {
    let listing;
    try {
      listing = execFileSync("git", ["ls-tree", ref, "supabase/migrations/"], { cwd: root, encoding: "utf8" });
    } catch {
      result.sections.A.findings.push(`${ref}: not found, skipped`);
      continue;
    }
    const entries = listing.trim().split("\n").filter(Boolean).map((line) => {
      const [meta, file] = line.split("\t");
      return { blob: meta.split(" ")[2], file: path.basename(file) };
    }).filter((e) => FILE.test(e.file));
    perRef[ref] = entries.filter((e) => Number(prefix(e.file)) >= 77).map((e) => e.file);
    for (const e of entries) {
      const byName = seen.get(prefix(e.file)) ?? new Map();
      const blobs = byName.get(e.file) ?? new Set();
      blobs.add(e.blob);
      byName.set(e.file, blobs);
      seen.set(prefix(e.file), byName);
    }
  }
  result.sections.A.perRef = perRef;
  for (const [p, byName] of seen) {
    if (byName.size > 1) fail("A", `number ${p} is used by ${byName.size} different files: ${[...byName.keys()].join(", ")}`);
    for (const [n, blobs] of byName) if (blobs.size > 1) fail("A", `${n} has ${blobs.size} different contents across the branches`);
  }
  if (!result.sections.A.failures.length) result.sections.A.findings.push(`${refs.length} refs checked: every number has one name and every name one content`);
} else {
  result.sections.A.findings.push("skipped (pass --refs a,b,c to compare branches)");
}
const own = new Map();
for (const f of files) own.set(prefix(f), [...(own.get(prefix(f)) ?? []), f]);
for (const [p, names] of own) if (names.length > 1) fail("A", `this checkout uses number ${p} twice: ${names.join(", ")}`);

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
const up = (db, file) => db.transaction((tx) => tx.exec(`${fs.readFileSync(path.join(MIGRATIONS, file), "utf8")}\ninsert into schema_migrations (version) values ('${name(file)}');`));
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
  union all select 'grant', table_name || ':' || grantee || ':' || privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'iaq_app_user'`;
// The notification allow-list is compared as a SET of kinds: the database prints the same constraint either as an IN list or as an array literal, in
// whatever order it was written, and none of that changes what is allowed.
const KINDS_PREFIX = "notifications:notifications_kind_check:";
const kindsOf = (text) => [...text.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
const normal = (r) => (r.kind === "constraint" && r.item.startsWith(KINDS_PREFIX) ? `${r.kind}|${KINDS_PREFIX}kinds=${[...new Set(kindsOf(r.item))].sort().join(",")}` : `${r.kind}|${r.item}`);
const fingerprint = async (db) => new Set((await q(db, FINGERPRINT)).map(normal));
const diff = (a, b) => ({ onlyBefore: [...a].filter((x) => !b.has(x)).sort(), onlyAfter: [...b].filter((x) => !a.has(x)).sort() });
const same = (d) => !d.onlyBefore.length && !d.onlyAfter.length;

// --------------------------------------------------------------------------------------------------------------------------------------------
// Build the chain once in order, remembering the schema after each of the last migrations (used by B, D and E)
// --------------------------------------------------------------------------------------------------------------------------------------------
const stages = {};
const dbA = await newDb();
for (const f of files) {
  await up(dbA, f);
  if (f === F81 || f === F82 || f === F83 || f === files[files.indexOf(F81 ?? F83) - 1]) stages[prefix(f)] = await fingerprint(dbA);
}
const before81 = F81 ? stages[prefix(files[files.indexOf(F81) - 1])] : null;
const fpFull = await fingerprint(dbA);
result.notes.push(`applied ${files.length} migrations in order; last: ${name(files[files.length - 1])}`);

// --------------------------------------------------------------------------------------------------------------------------------------------
// B. Order: 0082 after 0083 gives the same schema
// --------------------------------------------------------------------------------------------------------------------------------------------
section("B", "Order independence of 0082 and 0083");
if (F82) {
  const dbB = await newDb();
  for (const f of files) if (f !== F82 && f !== F83) await up(dbB, f);
  await up(dbB, F83);
  await up(dbB, F82);
  const d = diff(fpFull, await fingerprint(dbB));
  if (!same(d)) fail("B", `applying ${name(F82)} after ${name(F83)} gives a different schema: ${JSON.stringify(d).slice(0, 600)}`);
  else result.sections.B.findings.push(`${name(F82)} before or after ${name(F83)}: identical schema (${fpFull.size} schema facts compared)`);
  await dbB.close();
} else {
  result.sections.B.findings.push("no 0082 in this checkout; nothing to reorder");
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// C. Populated data survives 0083 up, down, up; earlier notification kinds are kept
// --------------------------------------------------------------------------------------------------------------------------------------------
section("C", "Existing data through 0083 up, down, up");
{
  const dbC = await newDb();
  for (const f of files) if (f !== F83) await up(dbC, f);
  const org = (await q(dbC, "insert into organizations (name, slug, kind, status) values ('Rehearsal Co', 'rehearsal-co', 'client', 'active') returning id"))[0].id;
  const user = (await q(dbC, "insert into users (email, full_name, email_verified_at) values ('rehearsal@example.test', 'Rehearsal User', now()) returning id"))[0].id;
  await dbC.query("insert into contacts (org_id, display_name, phone) select $1, 'Customer ' || g, '+1555' || lpad(g::text, 7, '0') from generate_series(1, 400) g", [org]);
  await dbC.query(
    `insert into conversations (org_id, contact_id, channel, status, owner_kind, owner_user_id, priority, unread_count, last_inbound_at, last_outbound_at, last_message_at, last_message_preview)
     select $1, c.id, (array['sms','email','whatsapp'])[1 + c.k % 3], case when c.k % 5 = 0 then 'closed' else 'open' end, case c.k % 3 when 0 then 'ai' when 1 then 'unassigned' else 'human' end,
            case when c.k % 3 = 2 then $2::uuid end,
            case when c.k % 25 = 0 then 'urgent' else 'normal' end, c.k % 4, now() - (c.k * interval '17 minutes'),
            case when c.k % 3 = 0 then null else now() - (c.k * interval '16 minutes') end, now() - (c.k * interval '16 minutes'), 'Thanks ' || c.k
     from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1) c`, [org, user]);
  await dbC.query(
    `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at)
     select $1, cv.id, case when m % 2 = 0 then 'inbound' else 'outbound' end, case when m % 2 = 0 then 'contact' else 'ai' end, 'Message ' || m,
            case when m % 2 = 0 then 'received' else 'delivered' end, cv.last_message_at - (m * interval '2 minutes')
     from (select id, last_message_at from conversations where org_id = $1) cv, generate_series(1, 4) m`, [org]);
  await dbC.query("insert into notifications (org_id, user_id, kind, title) select $1, $2, 'system', 'Rehearsal notice ' || g from generate_series(1, 25) g", [org, user]);
  const kindsBefore = (await q(dbC, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass"))[0].d;
  const snap = async () => ({
    contacts: await q(dbC, "select md5(string_agg(id::text || display_name || coalesce(phone, ''), ',' order by id)) as h, count(*)::int as n from contacts"),
    conversations: await q(dbC, "select md5(string_agg(id::text || status || owner_kind || priority || unread_count::text || coalesce(last_message_preview, ''), ',' order by id)) as h, count(*)::int as n from conversations"),
    messages: await q(dbC, "select md5(string_agg(id::text || direction || status || body, ',' order by id)) as h, count(*)::int as n from conversation_messages"),
    notifications: await q(dbC, "select md5(string_agg(id::text || kind || title, ',' order by id)) as h, count(*)::int as n from notifications"),
  });
  const s0 = await snap();
  const check = (label, s) => { if (JSON.stringify(s) !== JSON.stringify(s0)) fail("C", `existing data changed after ${label}`); };
  await up(dbC, F83);
  check("0083 up", await snap());
  const kindsAfter = (await q(dbC, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass"))[0].d;
  const listed = (d) => [...d.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
  const lostKinds = listed(kindsBefore).filter((k) => !listed(kindsAfter).includes(k));
  if (lostKinds.length) fail("C", `notification kinds lost by 0083: ${lostKinds.join(", ")}`);
  for (const k of ["conversation_assigned", "conversation_awaiting_reply", "conversation_new_inquiry"]) if (!listed(kindsAfter).includes(k)) fail("C", `0083 did not add the notification kind ${k}`);
  await down(dbC, F83);
  check("0083 down", await snap());
  // A rollback file is not a migration and leaves the ledger alone. The runner treats a version that is still listed as applied, so a person who rolls a
  // migration back and wants it applied again must also delete its ledger row (in schema_migrations, and in supabase_migrations.schema_migrations where it exists).
  await dbC.query("delete from schema_migrations where version = $1", [name(F83)]);
  await up(dbC, F83).catch((e) => fail("C", `0083 could not be applied again after its rollback: ${e.message}`));
  check("0083 up again", await snap());
  result.sections.C.findings.push(`${s0.contacts[0].n} contacts, ${s0.conversations[0].n} conversations, ${s0.messages[0].n} messages, ${s0.notifications[0].n} notifications unchanged through up, down, up; ${listed(kindsBefore).length} earlier notification kinds kept`);
  await dbC.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// D. Rollbacks, newest first
// --------------------------------------------------------------------------------------------------------------------------------------------
section("D", "Rollbacks newest first");
{
  const steps = [[F83, stages[prefix(F82 ?? F81)] ?? before81], [F82, stages[prefix(F81)]], [F81, before81]].filter(([f]) => f);
  for (const [f, expected] of steps) {
    if (!fs.existsSync(path.join(ROLLBACKS, `${name(f)}.down.sql`))) {
      result.sections.D.findings.push(`${name(f)}: no rollback file`);
      continue;
    }
    try {
      await down(dbA, f);
    } catch (e) {
      result.sections.D.findings.push(`${name(f)}: rollback failed (${String(e.message).slice(0, 160)})`);
      break;
    }
    const d = diff(expected, await fingerprint(dbA));
    result.sections.D.findings.push(same(d) ? `${name(f)}: rolled back to exactly the schema before it` : `${name(f)}: rolled back, but the schema differs from before it: ${JSON.stringify(d).slice(0, 1500)}`);
  }
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// E. Row-level security
// --------------------------------------------------------------------------------------------------------------------------------------------
section("E", "Row-level security");
{
  const dbE = await newDb();
  for (const f of files) await up(dbE, f);
  const noRls = (await q(dbE, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity order by 1")).map((r) => r.relname);
  const created = {};
  for (const f of [F81, F82, F83].filter(Boolean)) {
    const sql = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
    created[name(f)] = [...sql.matchAll(/create table(?: if not exists)? +(?:public\.)?([a-z_]+)/gi)].map((m) => m[1]);
  }
  result.sections.E.created = created;
  for (const [mig, tables] of Object.entries(created)) {
    for (const t of tables) if (noRls.includes(t)) fail("E", `${mig} creates ${t} without row-level security`);
    result.sections.E.findings.push(`${mig} creates: ${tables.length ? tables.join(", ") : "no tables"}${tables.every((t) => !noRls.includes(t)) ? " (all with RLS)" : ""}`);
  }
  const grants = (await q(dbE, "select grantee, privilege_type from information_schema.role_table_grants where table_name = 'inbox_rollout' and grantee in ('iaq_app_user', 'anon', 'authenticated', 'PUBLIC')"));
  if (grants.length) fail("E", `inbox_rollout is reachable by the application or public roles: ${JSON.stringify(grants)}`);
  else result.sections.E.findings.push("inbox_rollout has no grants for iaq_app_user, anon, authenticated or public");
  result.sections.E.tablesWithoutRls = noRls;
  result.sections.E.findings.push(`${noRls.length} public tables have no row-level security in the whole chain (listed in the report; compare with master before judging): ${noRls.slice(0, 12).join(", ")}${noRls.length > 12 ? ", ..." : ""}`);
  await dbE.close();
}
await dbA.close();

// --------------------------------------------------------------------------------------------------------------------------------------------
console.log(`Migration rehearsal on embedded Postgres (${files.length} migrations, last ${name(files[files.length - 1])})`);
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
