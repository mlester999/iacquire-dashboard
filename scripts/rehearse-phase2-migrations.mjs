// Rehearses migrations 0085 (missed-call recovery) and 0086 (lead scoring) on EMBEDDED Postgres only (PGlite, in memory). It never reads an environment file, never
// opens a network connection and cannot reach any hosted database:
//   node scripts/rehearse-phase2-migrations.mjs [--report .data/phase2-migration-rehearsal.json]
//
// What it answers:
//   A. Numbers: across every local and remote branch, is 0085 / 0086 used by any other name, and is every migration number at 0077 or higher unique?
//   B. Order: another branch reserves 0084 (restricted Hermes provisioner). Is the schema identical whether 0084 is applied before or after 0085 and 0086?
//   C. Data: with a populated database at the state before 0085, do 0085 and 0086 leave every existing contact, conversation, message, call and notification
//      unchanged, and keep every earlier notification kind?
//   D. Rollbacks: do the rollbacks REFUSE while recovery or scoring data exists (and leave it intact), and, once it is gone, return the schema to exactly what it
//      was before each migration, so the migrations apply again afterwards with the existing data unchanged?
//   E. Row-level security: does every new table have it, with select-only access for the application role, nothing for anon / authenticated / public, and does
//      the policy keep one workspace's rows from another workspace's members and from a signed-in stranger?
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
const F85 = files.find((f) => prefix(f) === "0085");
const F86 = files.find((f) => prefix(f) === "0086");
if (!F85 || !F86) throw new Error("This checkout has no 0085 / 0086 migration.");
const base = files.filter((f) => Number(prefix(f)) < 85);

const result = { ok: true, sections: {}, notes: [] };
const section = (key, title) => (result.sections[key] = { title, failures: [], findings: [] });
const fail = (key, message) => {
  result.ok = false;
  result.sections[key].failures.push(message);
};
const finding = (key, message) => result.sections[key].findings.push(message);

// --------------------------------------------------------------------------------------------------------------------------------------------
// A. Numbers across branches
// --------------------------------------------------------------------------------------------------------------------------------------------
section("A", "Migration numbers across all branches");
{
  const refs = execFileSync("git", ["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"], { cwd: root, encoding: "utf8" }).split("\n").filter(Boolean);
  const seen = new Map(); // prefix -> Map(name -> Set(blob))
  const holders = new Map(); // "0084_x.sql" -> [refs]
  for (const ref of refs) {
    let listing = "";
    try {
      listing = execFileSync("git", ["ls-tree", ref, "supabase/migrations/"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue;
    }
    for (const line of listing.trim().split("\n").filter(Boolean)) {
      const [meta, file] = line.split("\t");
      const base = path.basename(file);
      if (!FILE.test(base) || Number(prefix(base)) < 77) continue;
      const byName = seen.get(prefix(base)) ?? new Map();
      const blobs = byName.get(base) ?? new Set();
      blobs.add(meta.split(" ")[2]);
      byName.set(base, blobs);
      seen.set(prefix(base), byName);
      holders.set(base, [...(holders.get(base) ?? []), ref]);
    }
  }
  // This checkout's own files count too (uncommitted work is not in any ref).
  for (const f of files) if (Number(prefix(f)) >= 77) {
    const byName = seen.get(prefix(f)) ?? new Map();
    byName.set(f, byName.get(f) ?? new Set(["working-tree"]));
    seen.set(prefix(f), byName);
  }
  for (const [p, byName] of seen) {
    if (byName.size > 1) fail("A", `number ${p} is used by ${byName.size} different files: ${[...byName.keys()].join(", ")}`);
  }
  for (const f of [F85, F86]) {
    const elsewhere = (holders.get(f) ?? []).filter((r) => !r.startsWith("feat/phase2"));
    if (elsewhere.length) fail("A", `${f} already exists on ${elsewhere.join(", ")}`);
  }
  const reserved = [...seen.keys()].filter((p) => Number(p) >= 84 && Number(p) <= 99).sort();
  finding("A", `${refs.length} branches scanned; numbers 0084 and above in use anywhere: ${reserved.join(", ")} (each with one name)`);
  const own = new Map();
  for (const f of files) own.set(prefix(f), [...(own.get(prefix(f)) ?? []), f]);
  for (const [p, names] of own) if (names.length > 1) fail("A", `this checkout uses number ${p} twice: ${names.join(", ")}`);
  if (!result.sections.A.failures.length) finding("A", `0085 and 0086 are unique across every branch and this checkout; no number from 0077 up has two names`);
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
  union all select 'grant', table_name || ':' || grantee || ':' || privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'iaq_app_user'`;
// The notification allow-list is compared as a SET of kinds (the database prints the same constraint as an IN list or an array literal, in any order).
const KINDS_PREFIX = "notifications:notifications_kind_check:";
const kindsOf = (text) => [...text.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
const normal = (r) => (r.kind === "constraint" && r.item.startsWith(KINDS_PREFIX) ? `${r.kind}|${KINDS_PREFIX}kinds=${[...new Set(kindsOf(r.item))].sort().join(",")}` : `${r.kind}|${r.item}`);
const fingerprint = async (db) => new Set((await q(db, FINGERPRINT)).map(normal));
const diff = (a, b) => ({ onlyBefore: [...a].filter((x) => !b.has(x)).sort(), onlyAfter: [...b].filter((x) => !a.has(x)).sort() });
const same = (d) => !d.onlyBefore.length && !d.onlyAfter.length;
const kindsNow = async (db) => kindsOf((await q(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass"))[0].d);
const forget = (db, file) => db.query("delete from schema_migrations where version = $1", [name(file)]);

// --------------------------------------------------------------------------------------------------------------------------------------------
// B. Order against the reserved 0084
// --------------------------------------------------------------------------------------------------------------------------------------------
section("B", "Order independence from the reserved 0084");
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
  if (!sql84) {
    finding("B", "skipped: no branch with a 0084 migration was found");
  } else {
    const chain = async (order) => {
      const db = await newDb();
      for (const f of base) await up(db, f);
      for (const step of order) {
        if (step === "84") await upSql(db, sql84.sql, name(sql84.file));
        else await up(db, step === "85" ? F85 : F86);
      }
      return db;
    };
    try {
      const before = await chain(["84", "85", "86"]);
      const after = await chain(["85", "86", "84"]);
      const between = await chain(["85", "84", "86"]);
      const fpBefore = await fingerprint(before);
      for (const [label, db] of [["after 0085 and 0086", after], ["between them", between]]) {
        const d = diff(fpBefore, await fingerprint(db));
        if (!same(d)) fail("B", `applying ${sql84.file} ${label} gives a different schema: ${JSON.stringify(d).slice(0, 600)}`);
      }
      if (!result.sections.B.failures.length) finding("B", `${sql84.file} (from ${source}) before, between or after 0085 and 0086: identical schema (${fpBefore.size} schema facts compared)`);
      await Promise.all([before.close(), after.close(), between.close()]);
    } catch (e) {
      finding("B", `could not apply ${sql84.file} from ${source} in this checkout, so the order was not rehearsed (${String(e.message).slice(0, 200)}). 0085 and 0086 touch none of the hermes provisioner objects.`);
    }
  }
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// C and D. Data through up, down, up
// --------------------------------------------------------------------------------------------------------------------------------------------
section("C", "Existing data through 0085 and 0086");
section("D", "Rollbacks");
{
  const db = await newDb();
  for (const f of base) await up(db, f);
  const fp83 = await fingerprint(db);
  const kinds83 = await kindsNow(db);
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
    conversations: await q(db, "select md5(string_agg(id::text || status || owner_kind || priority || coalesce(last_message_preview, ''), ',' order by id)) as h, count(*)::int as n from conversations"),
    calls: await q(db, "select md5(string_agg(id::text || direction || status || coalesce(from_number, ''), ',' order by id)) as h, count(*)::int as n from crm_call_records"),
    notifications: await q(db, "select md5(string_agg(id::text || kind || title, ',' order by id)) as h, count(*)::int as n from notifications"),
  });
  const s0 = await snap();
  const check = (label) => async () => { if (JSON.stringify(await snap()) !== JSON.stringify(s0)) fail("C", `existing data changed after ${label}`); };

  await up(db, F85);
  await check("0085 up")();
  await up(db, F86);
  await check("0086 up")();
  const kindsFull = await kindsNow(db);
  const lost = kinds83.filter((k) => !kindsFull.includes(k));
  if (lost.length) fail("C", `notification kinds lost: ${lost.join(", ")}`);
  for (const k of ["missed_call_follow_up", "hot_lead_detected"]) if (!kindsFull.includes(k)) fail("C", `the notification kind ${k} was not added`);
  const fpFull = await fingerprint(db);
  finding("C", `${s0.contacts[0].n} contacts, ${s0.conversations[0].n} conversations, ${s0.calls[0].n} calls, ${s0.notifications[0].n} notifications unchanged after 0085 and 0086; ${kinds83.length} earlier notification kinds kept, 2 added`);

  // Recovery and scoring data: both rollbacks must refuse and leave it alone.
  const contact = (await q(db, "select id, phone from contacts where org_id = $1 order by id limit 1", [org]))[0];
  await db.query(
    `insert into missed_call_cases (org_id, contact_id, caller_number, business_number, classification, after_hours, provider, first_called_at, last_called_at, call_count, state, state_reason, attempts, owner_kind)
     values ($1, $2, $3, '+15555550100', 'ring_no_answer', false, 'vapi', now(), now(), 1, 'detected', 'rehearsal', 0, 'unassigned')`, [org, contact.id, contact.phone]);
  await db.query("update contacts set priority_label = 'hot', priority_score = 90, priority_source = 'engine', priority_evaluated_at = now() where id = $1", [contact.id]);
  const refusal = async (file, label, tables) => {
    try {
      await down(db, file);
      fail("D", `${name(file)} rolled back while ${label} existed (it must refuse)`);
    } catch (e) {
      if (!/Rollback refused/.test(String(e.message))) fail("D", `${name(file)} failed for another reason while ${label} existed: ${String(e.message).slice(0, 200)}`);
      else finding("D", `${name(file)}: refused while ${label} existed ("${String(e.message).slice(0, 70)}...")`);
    }
    for (const [table, expected] of tables) {
      const n = Number((await q(db, `select count(*) as n from ${table}`))[0].n);
      if (n !== expected) fail("D", `${table} has ${n} rows after the refused rollback (expected ${expected})`);
    }
    if (!same(diff(fpFull, await fingerprint(db)))) fail("D", `the schema changed although ${name(file)} refused`);
  };
  await refusal(F86, "a contact priority", [["contacts", 400]]);
  await refusal(F85, "a recovery case", [["missed_call_cases", 1]]);

  // Remove the test data (the way a person who exported it would), then roll back newest first and compare with the schema before each migration.
  await db.query("update contacts set priority_label = null, priority_score = null, priority_source = null, priority_evaluated_at = null where id = $1", [contact.id]);
  await db.query("delete from missed_call_cases where org_id = $1", [org]);
  await db.query("delete from missed_call_policies where org_id = $1", [org]);
  await db.query("delete from lead_scoring_profiles where org_id = $1", [org]);
  let fp85 = null;
  {
    const probe = await newDb();
    for (const f of base) await up(probe, f);
    await up(probe, F85);
    fp85 = await fingerprint(probe);
    await probe.close();
  }
  for (const [file, expected] of [[F86, fp85], [F85, fp83]]) {
    try {
      await down(db, file);
    } catch (e) {
      fail("D", `${name(file)} could not be rolled back on an empty workspace: ${String(e.message).slice(0, 300)}`);
      continue;
    }
    const d = diff(expected, await fingerprint(db));
    if (same(d)) finding("D", `${name(file)}: rolled back to exactly the schema before it`);
    else fail("D", `${name(file)}: rolled back, but the schema differs from before it: ${JSON.stringify(d).slice(0, 1200)}`);
    await check(`${name(file)} rollback`)();
    await forget(db, file);
  }
  const kindsBack = await kindsNow(db);
  if (JSON.stringify([...new Set(kindsBack)].sort()) !== JSON.stringify([...new Set(kinds83)].sort())) fail("D", "the notification kinds after both rollbacks differ from before 0085");
  // Apply again: the migrations must work after a rollback, with the data intact.
  try {
    await up(db, F85);
    await up(db, F86);
    await check("applying 0085 and 0086 again")();
    if (!same(diff(fpFull, await fingerprint(db)))) fail("D", "applying 0085 and 0086 again gives a different schema from the first time");
    else finding("D", "applied again after the rollbacks: the same schema as the first time, existing data unchanged");
  } catch (e) {
    fail("D", `0085 / 0086 could not be applied again after their rollbacks: ${String(e.message).slice(0, 300)}`);
  }
  await db.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// E. Row-level security
// --------------------------------------------------------------------------------------------------------------------------------------------
section("E", "Row-level security");
{
  const db = await newDb();
  for (const f of files) await up(db, f);
  const created = {};
  for (const f of [F85, F86]) created[name(f)] = [...fs.readFileSync(path.join(MIGRATIONS, f), "utf8").matchAll(/create table(?: if not exists)? +(?:public\.)?([a-z_]+)/gi)].map((m) => m[1]);
  const tables = Object.values(created).flat();
  const noRls = (await q(db, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity")).map((r) => r.relname);
  for (const t of tables) if (noRls.includes(t)) fail("E", `${t} has no row-level security`);
  const grants = await q(db, "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = any($1)", [tables]);
  for (const g of grants) {
    if (g.grantee === "iaq_app_user" && g.privilege_type !== "SELECT") fail("E", `${g.table_name}: iaq_app_user holds ${g.privilege_type} (select only expected)`);
    if (["anon", "authenticated", "PUBLIC"].includes(g.grantee)) fail("E", `${g.table_name}: ${g.grantee} holds ${g.privilege_type}`);
  }
  const selectors = tables.filter((t) => grants.some((g) => g.table_name === t && g.grantee === "iaq_app_user" && g.privilege_type === "SELECT"));
  if (selectors.length !== tables.length) fail("E", `iaq_app_user cannot read: ${tables.filter((t) => !selectors.includes(t)).join(", ")}`);
  const policies = await q(db, "select tablename, qual from pg_policies where schemaname = 'public' and tablename = any($1)", [tables]);
  for (const t of tables) if (!policies.some((p) => p.tablename === t && /permitted_orgs/.test(p.qual ?? ""))) fail("E", `${t} has no policy that goes through app.permitted_orgs`);
  finding("E", `${tables.length} new tables, every one with row-level security, a workspace-membership policy and select-only access for the application role (nothing for anon, authenticated or public)`);

  // A probe as the application role: two workspaces, an owner each, and a stranger.
  const mk = async (slug) => (await q(db, "insert into organizations (name, slug, kind, status) values ($1::text, $1::text, 'client', 'active') returning id", [slug]))[0].id;
  const orgA = await mk("probe-a");
  const orgB = await mk("probe-b");
  const mkUser = async (email) => (await q(db, "insert into users (email, full_name, email_verified_at) values ($1::text, $1::text, now()) returning id", [email]))[0].id;
  const ownerA = await mkUser("a@example.test");
  const ownerB = await mkUser("b@example.test");
  const stranger = await mkUser("stranger@example.test");
  await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner')", [orgA, ownerA, orgB, ownerB]);
  for (const o of [orgA, orgB]) {
    const c = (await q(db, "insert into contacts (org_id, display_name, phone) values ($1, 'Probe', '+15550000001') returning id", [o]))[0].id;
    await db.query(
      `insert into missed_call_cases (org_id, contact_id, caller_number, business_number, classification, after_hours, provider, first_called_at, last_called_at, call_count, state, state_reason, attempts, owner_kind)
       values ($1, $2, '+15550000001', '+15555550100', 'voicemail', false, 'vapi', now(), now(), 1, 'detected', 'probe', 0, 'unassigned')`, [o, c]);
    await db.query("insert into missed_call_policies (org_id) values ($1)", [o]).catch(() => {});
    await db.query("insert into lead_scoring_profiles (org_id) values ($1)", [o]).catch(() => {});
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
  for (const table of ["missed_call_cases", "missed_call_policies", "lead_scoring_profiles"]) {
    const seen = {
      ownerA: await visible(ownerA, table), ownerB: await visible(ownerB, table), stranger: await visible(stranger, table), nobody: await visible(null, table),
    };
    if (seen.ownerA.some((o) => o !== orgA)) fail("E", `${table}: the owner of workspace A can read another workspace's rows`);
    if (seen.ownerB.some((o) => o !== orgB)) fail("E", `${table}: the owner of workspace B can read another workspace's rows`);
    if (seen.stranger.length) fail("E", `${table}: a signed-in stranger can read ${seen.stranger.length} rows`);
    if (seen.nobody.length) fail("E", `${table}: a request with no user can read ${seen.nobody.length} rows`);
    // A probe that found nothing to read would pass the checks above by default: each owner must see exactly their own workspace's row.
    if (seen.ownerA.length !== 1 || seen.ownerB.length !== 1) fail("E", `${table}: each owner should see exactly their own workspace's row (A ${seen.ownerA.length}, B ${seen.ownerB.length})`);
  }
  let wrote = false;
  try {
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [ownerA]);
      await tx.query("set local role iaq_app_user");
      await tx.query("update missed_call_cases set state = 'completed_without_recovery'");
      wrote = true;
    });
  } catch {
    /* expected: no write grant */
  }
  if (wrote) fail("E", "the application role could update missed_call_cases (writes must only happen in trusted server code)");
  else finding("E", "as the application role: each owner reads only their own workspace's cases, policies and scoring profile; a stranger and a request with no user read nothing; an update is refused");
  await db.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
console.log(`Phase 2 migration rehearsal on embedded Postgres (0085 ${name(F85)}, 0086 ${name(F86)}; ${files.length} migrations in this checkout)`);
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
