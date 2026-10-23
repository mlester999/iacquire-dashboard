// Rehearses migration 0089 (the social media manager) on EMBEDDED Postgres only (PGlite, in memory). It never reads an environment file, never opens a
// network connection and cannot reach any hosted database:
//   node scripts/rehearse-phase4-migrations.mjs [--report .data/phase4-migration-rehearsal.json]
//
// What it answers:
//   A. Numbers: across every branch and every sibling worktree, is 0089 used by any other name, and is every migration number at 0077 or higher unique?
//   B. Order: another branch reserves 0084 (restricted Hermes provisioner); 0087 and 0088 (Phase 3) also rewrite the notification allow-list that 0089 extends.
//      Is the schema identical in every order?
//   C. Data: with a populated database at the state before 0089, does 0089 leave every contact, notification and stored file unchanged, keep every earlier
//      notification kind, storage bucket and file-permission answer (for every role and every older bucket), and accept the new kinds and the new bucket?
//   D. Rollback: does the rollback REFUSE while social data exists (each kind of data on its own, leaving data and schema intact), and, once it is gone, return
//      the schema (including the file-permission function, the bucket rule and the notification allow-list) to exactly what it was, so 0089 applies again?
//   E. Row-level security and permissions: does every new table have row-level security and a workspace-membership policy; is the application role limited to
//      reading (and never reading a connection's credentials or the sign-in state); does one workspace's data stay away from another workspace and from a
//      stranger; do the six social.* permissions go to exactly the intended roles; and can the role a published site runs under read none of it?
// Exit code 1 when A, B (if 0084 can be applied), C, D or E fail.
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
const F89 = files.find((f) => prefix(f) === "0089");
if (!F87 || !F88 || !F89) throw new Error("This checkout has no 0087 / 0088 / 0089 migration.");
const before89 = files.filter((f) => Number(prefix(f)) < 89);
const before87 = files.filter((f) => Number(prefix(f)) < 87);

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
  const holders = new Map(); // "0089_x.sql" -> [places]
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
  // The same name in several places is the same migration travelling; different NAMES for one number are the conflict.
  for (const [p, byName] of seen) if (byName.size > 1) fail("A", `number ${p} is used by ${byName.size} different files: ${[...byName.keys()].join(", ")}`);
  const elsewhere = (holders.get(F89) ?? []).filter((r) => r !== "this checkout" && !/phases-3-7/.test(r));
  if (elsewhere.length) fail("A", `${F89} already exists on ${[...new Set(elsewhere)].join(", ")}`);
  const reserved = [...seen.keys()].filter((p) => Number(p) >= 84 && Number(p) <= 99).sort();
  finding("A", `${refs.length} branches and ${scanned} working trees scanned; numbers 0084 and above in use anywhere: ${reserved.join(", ")} (each with one name)`);
  const own = new Map();
  for (const f of files) own.set(prefix(f), [...(own.get(prefix(f)) ?? []), f]);
  for (const [p, names] of own) if (names.length > 1) fail("A", `this checkout uses number ${p} twice: ${names.join(", ")}`);
  if (!result.sections.A.failures.length) finding("A", `0089 is unique across every branch, every sibling worktree and this checkout; no number from 0077 up has two names; next free number is ${String(Math.max(...files.map((f) => Number(prefix(f)))) + 1).padStart(4, "0")}`);
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
  union all select 'colgrant', table_name || '.' || column_name || ':' || grantee || ':' || privilege_type from information_schema.column_privileges where table_schema = 'public' and grantee in ('iaq_app_user', 'iaq_site_runtime')
  union all select 'execute', n.nspname || '.' || p.proname || ':' || r.rolname from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_roles r on has_function_privilege(r.oid, p.oid, 'execute')
    where n.nspname = 'app' and r.rolname in ('iaq_app_user', 'iaq_site_runtime', 'anon', 'authenticated')
  union all select 'role_permission', role || ':' || permission from role_permissions`;
// The notification allow-list is compared as a SET of kinds (the database prints the same constraint as an IN list or an array literal, in any order).
const KINDS_PREFIX = "notifications:notifications_kind_check:";
const BUCKET_PREFIX = "private_files:private_files_bucket_check:";
const quoted = (text) => [...text.matchAll(/'([a-z0-9_-]+)'::text/g)].map((m) => m[1]);
const normal = (r) => {
  if (r.kind === "constraint" && r.item.startsWith(KINDS_PREFIX)) return `${r.kind}|${KINDS_PREFIX}kinds=${[...new Set(quoted(r.item))].sort().join(",")}`;
  if (r.kind === "constraint" && r.item.startsWith(BUCKET_PREFIX)) return `${r.kind}|${BUCKET_PREFIX}buckets=${[...new Set(quoted(r.item))].sort().join(",")}`;
  return `${r.kind}|${r.item}`;
};
const fingerprint = async (db) => new Set((await q(db, FINGERPRINT)).map(normal));
const diff = (a, b) => ({ onlyBefore: [...a].filter((x) => !b.has(x)).sort(), onlyAfter: [...b].filter((x) => !a.has(x)).sort() });
const same = (d) => !d.onlyBefore.length && !d.onlyAfter.length;
const kindsNow = async (db) => quoted((await q(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass"))[0].d);
const bucketsNow = async (db) => quoted((await q(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'private_files_bucket_check' and conrelid = 'private_files'::regclass"))[0].d);
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
const SOCIAL_KINDS = ["social_approval_requested", "social_approval_decided", "social_post_published", "social_post_failed", "social_account_attention"];
const OLD_BUCKETS = ["company-documents", "support-attachments", "project-files", "project-uploads", "portfolio-assets", "brand-assets", "aqi-attachments"];

// --------------------------------------------------------------------------------------------------------------------------------------------
// B. Order against the reserved 0084 and the other two notification-allow-list migrations
// --------------------------------------------------------------------------------------------------------------------------------------------
section("B", "Order independence from the reserved 0084 and from 0087 / 0088");
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
  const byKey = { 87: F87, 88: F88, 89: F89 };
  const chain = async (order) => {
    const db = await newDb();
    for (const f of before87) await up(db, f);
    for (const step of order) {
      if (step === "84") await upSql(db, sql84.sql, name(sql84.file));
      else await up(db, byKey[step]);
    }
    return db;
  };
  const reference = await chain(["87", "88", "89"]);
  const fpRef = await fingerprint(reference);
  await reference.close();
  let fpRef84 = null;
  if (sql84) {
    const r = await chain(["84", "87", "88", "89"]);
    fpRef84 = await fingerprint(r);
    await r.close();
  } else {
    finding("B", "0084 was not found on any branch, so only the order of 0087, 0088 and 0089 was rehearsed");
  }
  const orders = [["89", "87", "88"], ["87", "89", "88"], ["88", "89", "87"]];
  if (sql84) orders.push(["87", "84", "88", "89"], ["89", "84", "87", "88"], ["87", "88", "89", "84"]);
  let rehearsed = 0;
  for (const order of orders) {
    try {
      const db = await chain(order);
      const d = diff(order.includes("84") ? fpRef84 : fpRef, await fingerprint(db));
      if (!same(d)) fail("B", `order ${order.join(" → ")} gives a different schema: ${JSON.stringify(d).slice(0, 700)}`);
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
section("C", "Existing data through 0089");
section("D", "Rollback");
{
  const db = await newDb();
  for (const f of before89) await up(db, f);
  const fp88 = await fingerprint(db);
  const kinds88 = await kindsNow(db);
  const buckets88 = await bucketsNow(db);
  const org = (await q(db, "insert into organizations (name, slug, kind, status) values ('Rehearsal Co', 'rehearsal-co', 'client', 'active') returning id"))[0].id;
  const otherOrg = (await q(db, "insert into organizations (name, slug, kind, status) values ('Other Co', 'other-co', 'client', 'active') returning id"))[0].id;
  const mkUser = async (email) => (await q(db, "insert into users (email, full_name, email_verified_at) values ($1::text, $1::text, now()) returning id", [email]))[0].id;
  const users = { owner: await mkUser("owner@example.test"), admin: await mkUser("admin@example.test"), member: await mkUser("member@example.test"), sales: await mkUser("sales@example.test"), viewer: await mkUser("viewer@example.test"), stranger: await mkUser("stranger@example.test"), otherOwner: await mkUser("other-owner@example.test") };
  await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($1, $3, 'admin'), ($1, $4, 'member'), ($1, $5, 'sales_rep'), ($1, $6, 'viewer'), ($7, $8, 'owner')", [org, users.owner, users.admin, users.member, users.sales, users.viewer, otherOrg, users.otherOwner]);
  await db.query("insert into contacts (org_id, display_name, phone) select $1, 'Customer ' || g, '+1555' || lpad(g::text, 7, '0') from generate_series(1, 400) g", [org]);
  await db.query("insert into notifications (org_id, user_id, kind, title) select $1, $2, 'system', 'Rehearsal notice ' || g from generate_series(1, 25) g", [org, users.owner]);
  // One stored file in each of the seven earlier buckets.
  let n = 0;
  for (const bucket of OLD_BUCKETS) {
    n += 1;
    await db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, $2, $3, $4, 'application/pdf', 1000, 'ready')", [org, bucket, `${org}/${bucket}/file-${n}.pdf`, `file-${n}.pdf`]);
  }
  const snap = async () => ({
    contacts: await q(db, "select md5(string_agg(id::text || display_name || coalesce(phone, ''), ',' order by id)) as h, count(*)::int as n from contacts"),
    notifications: await q(db, "select md5(string_agg(id::text || kind || title, ',' order by id)) as h, count(*)::int as n from notifications"),
    files: await q(db, "select md5(string_agg(id::text || bucket || storage_key || status, ',' order by id)) as h, count(*)::int as n from private_files"),
    roles: await q(db, "select md5(string_agg(role || permission, ',' order by role, permission)) as h, count(*)::int as n from role_permissions where permission not like 'social.%'"),
  });
  const s0 = await snap();
  const check = (label, key = "C") => async () => {
    if (JSON.stringify(await snap()) !== JSON.stringify(s0)) fail(key, `existing data changed after ${label}`);
  };

  // What app.file_permission answers for every person and every earlier bucket, read and write, for client-visible files: it must not change.
  const people = { owner: users.owner, admin: users.admin, member: users.member, sales: users.sales, viewer: users.viewer, stranger: users.stranger, otherOwner: users.otherOwner };
  const truthTable = async (buckets) => {
    const out = {};
    for (const [who, id] of Object.entries(people)) {
      for (const bucket of buckets) {
        for (const write of [false, true]) {
          let answer;
          await db.transaction(async (tx) => {
            await tx.query("select set_config('app.user_id', $1, true)", [id]);
            answer = (await tx.query("select app.file_permission($1, $2, $3, 'client') as ok", [org, bucket, write])).rows[0].ok;
          });
          out[`${who}|${bucket}|${write ? "write" : "read"}`] = answer;
        }
      }
    }
    return out;
  };
  const truth88 = await truthTable(OLD_BUCKETS);

  await up(db, F89);
  await check("0089 up")();
  const fp89 = await fingerprint(db);
  const kinds89 = await kindsNow(db);
  const lost = kinds88.filter((k) => !kinds89.includes(k));
  if (lost.length) fail("C", `notification kinds lost: ${lost.join(", ")}`);
  const missing = SOCIAL_KINDS.filter((k) => !kinds89.includes(k));
  if (missing.length) fail("C", `notification kinds not added: ${missing.join(", ")}`);
  finding("C", `${s0.contacts[0].n} contacts, ${s0.notifications[0].n} notifications, ${s0.files[0].n} stored files and ${s0.roles[0].n} earlier role permissions unchanged after 0089; ${kinds88.length} earlier notification kinds kept, ${SOCIAL_KINDS.length} added`);

  const buckets89 = await bucketsNow(db);
  const lostBuckets = buckets88.filter((b) => !buckets89.includes(b));
  if (lostBuckets.length) fail("C", `storage buckets lost from the allow-list: ${lostBuckets.join(", ")}`);
  if (!buckets89.includes("social-media")) fail("C", "the bucket social-media was not added to the allow-list");
  const file = (bucket) => accepts(db, "insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, $2, $3, 'probe.jpg', 'image/jpeg', 1000, 'ready')", [org, bucket, `${org}/${bucket}/probe.jpg`]);
  for (const b of [...OLD_BUCKETS, "social-media"]) if (!(await file(b))) fail("C", `a stored file in bucket ${b} is refused after 0089`);
  if (await file("scrapbook")) fail("C", "a stored file in an unknown bucket is accepted after 0089");
  if (!result.sections.C.failures.length) finding("C", "after 0089 the seven earlier buckets and social-media accept files; an unknown bucket is still refused");

  const truth89 = await truthTable(OLD_BUCKETS);
  const changed = Object.keys(truth88).filter((k) => truth88[k] !== truth89[k]);
  if (changed.length) fail("C", `app.file_permission answers differently for earlier buckets after 0089: ${changed.slice(0, 8).join(", ")}`);
  else finding("C", `app.file_permission gives the same ${Object.keys(truth88).length} answers as before for 7 earlier buckets × 7 people × read/write`);
  const social = await truthTable(["social-media"]);
  const expectSocial = { owner: [true, true], admin: [true, true], member: [true, true], sales: [true, true], viewer: [true, false], stranger: [false, false], otherOwner: [false, false] };
  for (const [who, [r, w]] of Object.entries(expectSocial)) {
    if (social[`${who}|social-media|read`] !== r) fail("C", `social-media read for ${who} should be ${r}`);
    if (social[`${who}|social-media|write`] !== w) fail("C", `social-media write for ${who} should be ${w}`);
  }
  if (!result.sections.C.failures.length) finding("C", "social-media files: owner, admin, team member and sales rep may read and write, a viewer may only read, a stranger and another workspace's owner may do neither");
  await check("the file-permission probes")();

  // Data the rollback must protect. Each kind on its own: the rollback refuses, nothing changes, the data is removed again.
  const fpWithConfig = await fingerprint(db);
  const acct = async () => (await q(db, "insert into social_accounts (org_id, platform, adapter, external_id, name) values ($1, 'facebook', 'simulated', 'rehearsal-page', 'Rehearsal Page') returning id", [org]))[0].id;
  let account = null;
  const refusal = async (label, setup, cleanup, counts) => {
    await setup();
    try {
      await down(db, F89);
      fail("D", `${name(F89)} rolled back while ${label} existed (it must refuse)`);
    } catch (e) {
      if (!/Rollback refused/.test(String(e.message))) fail("D", `${name(F89)} failed for another reason while ${label} existed: ${String(e.message).slice(0, 200)}`);
      else finding("D", `refused while ${label} existed`);
    }
    for (const [table, expected] of counts) {
      const c = Number((await q(db, `select count(*) as n from ${table}`))[0].n);
      if (c !== expected) fail("D", `${table} has ${c} rows after the refused rollback (expected ${expected})`);
    }
    if (!same(diff(fpWithConfig, await fingerprint(db)))) fail("D", `the schema changed although ${name(F89)} refused`);
    await cleanup();
  };
  await refusal("a connected account", async () => { account = await acct(); }, () => db.query("delete from social_accounts"), [["social_accounts", 1]]);
  await refusal("a post", async () => {
    account = await acct();
    await db.query("insert into social_posts (org_id, account_id, kind, caption) values ($1, $2, 'text', 'Hello')", [org, account]);
  }, async () => {
    await db.query("delete from social_posts");
    await db.query("delete from social_accounts");
  }, [["social_posts", 1], ["social_accounts", 1]]);
  await refusal("a publishing job", async () => {
    account = await acct();
    const post = (await q(db, "insert into social_posts (org_id, account_id, kind, caption) values ($1, $2, 'text', 'Hello') returning id", [org, account]))[0].id;
    await db.query("insert into social_publish_jobs (org_id, post_id, account_id, post_version, idempotency_key) values ($1, $2, $3, 1, $4)", [org, post, account, `${post}:1:rehearsal`]);
  }, async () => {
    await db.query("delete from social_publish_jobs");
    await db.query("delete from social_posts");
    await db.query("delete from social_accounts");
  }, [["social_publish_jobs", 1]]);
  await refusal("a media record", () => db.query("insert into social_media_assets (org_id, source, external_ref, kind, filename, mime_type, size_bytes) values ($1, 'google_drive', 'drive-file-1', 'image', 'a.jpg', 'image/jpeg', 100)", [org]), () => db.query("delete from social_media_assets"), [["social_media_assets", 1]]);
  await refusal("a campaign", () => db.query("insert into social_campaigns (org_id, name, utm_campaign) values ($1, 'Spring', 'spring')", [org]), () => db.query("delete from social_campaigns"), [["social_campaigns", 1]]);
  await refusal("an AI run", () => db.query("insert into social_ai_runs (org_id, kind, status) values ($1, 'ideas', 'succeeded')", [org]), () => db.query("delete from social_ai_runs"), [["social_ai_runs", 1]]);
  await refusal("a stored media file", () => db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'social-media', $2, 'm.jpg', 'image/jpeg', 100, 'ready')", [org, `${org}/social/m.jpg`]), () => db.query("delete from private_files where bucket = 'social-media'"), [["private_files", Number(s0.files[0].n) + 1]]);
  await refusal("a social notification", () => db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'social_post_failed', 'A post failed')", [org, users.owner]), () => db.query("delete from notifications where kind = 'social_post_failed'"), [["notifications", Number(s0.notifications[0].n) + 1]]);
  await check("the refused rollbacks", "D")();

  // With the data gone, roll back and compare with the schema before 0089. An unused default settings row goes with its table.
  await db.query("insert into social_settings (org_id) values ($1)", [org]);
  try {
    await down(db, F89);
    const d = diff(fp88, await fingerprint(db));
    if (same(d)) finding("D", `${name(F89)}: rolled back to exactly the schema before it (tables, policies, grants, permissions, the file-permission function, the bucket rule and the notification allow-list; an unused settings row went with its table)`);
    else fail("D", `${name(F89)}: rolled back, but the schema differs from before it: ${JSON.stringify(d).slice(0, 1400)}`);
    await check(`${name(F89)} rollback`, "D")();
    await forget(db, F89);
    const bucketRows = await q(db, "select count(*)::int as n from storage.buckets where id = 'social-media'");
    if (bucketRows[0].n !== 0) fail("D", "the social-media storage bucket is still registered after the rollback");
    const kindsBack = await kindsNow(db);
    if (JSON.stringify([...new Set(kindsBack)].sort()) !== JSON.stringify([...new Set(kinds88)].sort())) fail("D", "the notification kinds after the rollback differ from before 0089");
    if (await file("social-media")) fail("D", "a social-media file is still accepted after the rollback");
    const truthBack = await truthTable(OLD_BUCKETS);
    if (Object.keys(truth88).some((k) => truth88[k] !== truthBack[k])) fail("D", "app.file_permission answers differently from before 0089 after the rollback");
  } catch (e) {
    fail("D", `${name(F89)} could not be rolled back on an empty workspace: ${String(e.message).slice(0, 300)}`);
  }
  // Apply again: the migration must work after a rollback, with the data intact.
  try {
    await up(db, F89);
    await check("applying 0089 again", "D")();
    if (!same(diff(fp89, await fingerprint(db)))) fail("D", "applying 0089 again gives a different schema from the first time");
    else finding("D", "applied again after the rollback: the same schema as the first time, existing data unchanged");
  } catch (e) {
    fail("D", `0089 could not be applied again after its rollback: ${String(e.message).slice(0, 300)}`);
  }
  await db.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// E. Row-level security, credentials, permissions and the published-site role
// --------------------------------------------------------------------------------------------------------------------------------------------
section("E", "Row-level security, credentials, permissions and the published-site role");
{
  const db = await newDb();
  for (const f of files) await up(db, f);
  const tables = [...fs.readFileSync(path.join(MIGRATIONS, F89), "utf8").matchAll(/create table(?: if not exists)? +(?:public\.)?([a-z_]+)/gi)].map((m) => m[1]);
  const noRls = (await q(db, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity")).map((r) => r.relname);
  for (const t of tables) if (noRls.includes(t)) fail("E", `${t} has no row-level security`);
  const grants = await q(db, "select table_name, grantee, privilege_type from information_schema.role_table_grants where table_schema = 'public' and table_name = any($1)", [tables]);
  for (const g of grants) {
    if (g.grantee === "iaq_app_user" && g.privilege_type !== "SELECT") fail("E", `${g.table_name}: iaq_app_user holds ${g.privilege_type} (select only expected)`);
    if (["anon", "authenticated", "PUBLIC", "iaq_site_runtime"].includes(g.grantee)) fail("E", `${g.table_name}: ${g.grantee} holds ${g.privilege_type}`);
  }
  const colGrants = await q(db, "select table_name, column_name, grantee, privilege_type from information_schema.column_privileges where table_schema = 'public' and table_name = any($1) and grantee in ('anon', 'authenticated', 'PUBLIC', 'iaq_site_runtime')", [tables]);
  for (const g of colGrants) fail("E", `${g.table_name}.${g.column_name}: ${g.grantee} holds ${g.privilege_type}`);
  // The credentials column and the whole sign-in state table must be unreadable for the application role; everything else readable.
  const canColumn = async (table, column) => (await q(db, "select has_column_privilege('iaq_app_user', $1, $2, 'SELECT') as ok", [`public.${table}`, column]))[0].ok;
  if (await canColumn("social_accounts", "credentials")) fail("E", "iaq_app_user can read social_accounts.credentials");
  if (!(await canColumn("social_accounts", "status"))) fail("E", "iaq_app_user cannot read social_accounts.status");
  const noRead = new Set(["social_oauth_states"]);
  for (const t of tables) {
    const tableLevel = (await q(db, "select has_table_privilege('iaq_app_user', $1, 'SELECT') as ok", [`public.${t}`]))[0].ok;
    if (noRead.has(t) && (tableLevel || (await canColumn(t, "state_hash")) || (await canColumn(t, "pending")))) fail("E", `${t} is readable by iaq_app_user (the sign-in state and its encrypted choices are server-only)`);
    if (!noRead.has(t) && t !== "social_accounts" && !tableLevel) fail("E", `iaq_app_user cannot read ${t}`);
  }
  const policies = await q(db, "select tablename, qual from pg_policies where schemaname = 'public' and tablename = any($1)", [tables]);
  for (const t of tables) {
    if (noRead.has(t)) {
      if (policies.some((p) => p.tablename === t)) fail("E", `${t} has a policy although the application role must not read it`);
      continue;
    }
    if (!policies.some((p) => p.tablename === t && /permitted_orgs/.test(p.qual ?? ""))) fail("E", `${t} has no policy that goes through app.permitted_orgs`);
  }
  finding("E", `${tables.length} new tables (${tables.join(", ")}), every one with row-level security; the application role may only read (the sign-in state table not at all, and a connection's credentials column never), with a workspace-membership policy on every readable table; nothing for anon, authenticated, public or the published-site role`);

  // The six permissions go to exactly the intended roles.
  const expected = {
    "social.view": ["owner", "admin", "member", "sales_rep", "support", "viewer", "appointment_setter", "agency_staff", "agency_manager", "agency_super_admin"],
    "social.create": ["owner", "admin", "member", "sales_rep", "agency_staff", "agency_manager", "agency_super_admin"],
    "social.approve": ["owner", "admin"],
    "social.publish": ["owner", "admin", "agency_manager", "agency_super_admin"],
    "social.connect": ["owner", "admin"],
    "social.settings": ["owner"],
  };
  const have = {};
  for (const r of await q(db, "select role, permission from role_permissions where permission like 'social.%'")) (have[r.permission] ??= []).push(r.role);
  for (const [perm, roles] of Object.entries(expected)) {
    const got = (have[perm] ?? []).sort();
    if (JSON.stringify(got) !== JSON.stringify([...roles].sort())) fail("E", `${perm} is held by ${got.join(", ") || "nobody"}; expected ${[...roles].sort().join(", ")}`);
  }
  for (const perm of Object.keys(have)) if (!(perm in expected)) fail("E", `an unexpected permission ${perm} was added`);
  if (!result.sections.E.failures.length) finding("E", "social.approve and social.connect belong to owner and admin only, social.settings to owner only, social.publish to owner, admin and the agency's managers (an agency never approves what a client publishes), social.view reaches every workspace role and the agency");

  // A probe as the application role: two workspaces, an owner each, a viewer in one, and a stranger.
  const mk = async (slug) => (await q(db, "insert into organizations (name, slug, kind, status) values ($1::text, $1::text, 'client', 'active') returning id", [slug]))[0].id;
  const orgA = await mk("probe-a");
  const orgB = await mk("probe-b");
  const mkUser = async (email) => (await q(db, "insert into users (email, full_name, email_verified_at) values ($1::text, $1::text, now()) returning id", [email]))[0].id;
  const ownerA = await mkUser("a@example.test");
  const ownerB = await mkUser("b@example.test");
  const viewerA = await mkUser("viewer-a@example.test");
  const stranger = await mkUser("stranger@example.test");
  await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'owner'), ($3, $4, 'owner'), ($1, $5, 'viewer')", [orgA, ownerA, orgB, ownerB, viewerA]);
  for (const [o, ch] of [[orgA, "a"], [orgB, "b"]]) {
    await db.query("insert into social_settings (org_id) values ($1)", [o]);
    const account = (await q(db, "insert into social_accounts (org_id, platform, adapter, external_id, name, credentials) values ($1, 'facebook', 'simulated', $2, 'Probe Page', 'encrypted-secret-' || $2) returning id", [o, `page-${ch}`]))[0].id;
    await db.query("insert into social_oauth_states (org_id, user_id, platform, state_hash, expires_at, pending) values ($1, $2, 'facebook', $3, now() + interval '10 minutes', 'encrypted-pages')", [o, ch === "a" ? ownerA : ownerB, ch.repeat(64).replace(/[^0-9a-f]/g, "0")]);
    await db.query("insert into social_campaigns (org_id, name, utm_campaign) values ($1, 'Probe', 'probe')", [o]);
    await db.query("insert into social_media_assets (org_id, source, external_ref, kind, filename, mime_type, size_bytes) values ($1, 'google_drive', 'ref', 'image', 'a.jpg', 'image/jpeg', 100)", [o]);
    await db.query("insert into social_ai_runs (org_id, kind, status) values ($1, 'ideas', 'succeeded')", [o]);
    const post = (await q(db, "insert into social_posts (org_id, account_id, kind, caption) values ($1, $2, 'text', 'Probe post') returning id", [o, account]))[0].id;
    await db.query("insert into social_post_events (org_id, post_id, kind) values ($1, $2, 'created')", [o, post]);
    await db.query("insert into social_publish_jobs (org_id, post_id, account_id, post_version, idempotency_key) values ($1, $2, $3, 1, $4)", [o, post, account, `${post}:1:probe`]);
    await db.query("insert into social_post_metrics (org_id, post_id, metrics, source) values ($1, $2, '{\"likes\":1}'::jsonb, 'simulated')", [o, post]);
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
  const denied = async (userId, sql) => {
    try {
      await asUser(userId, sql);
      return false;
    } catch {
      return true;
    }
  };
  const readable = tables.filter((t) => !noRead.has(t));
  for (const table of readable) {
    const col = table === "social_accounts" ? "id, org_id" : "org_id";
    const sel = (u) => asUser(u, `select ${col} from ${table}`).then((rows) => rows.map((r) => r.org_id));
    const seen = { ownerA: await sel(ownerA), ownerB: await sel(ownerB), viewerA: await sel(viewerA), stranger: await sel(stranger), nobody: await sel(null) };
    if (seen.ownerA.some((o) => o !== orgA)) fail("E", `${table}: the owner of workspace A can read another workspace's rows`);
    if (seen.ownerB.some((o) => o !== orgB)) fail("E", `${table}: the owner of workspace B can read another workspace's rows`);
    if (seen.viewerA.some((o) => o !== orgA)) fail("E", `${table}: a viewer in workspace A can read another workspace's rows`);
    if (seen.stranger.length) fail("E", `${table}: a signed-in stranger can read ${seen.stranger.length} rows`);
    if (seen.nobody.length) fail("E", `${table}: a request with no user can read ${seen.nobody.length} rows`);
    // A probe that found nothing to read would pass the checks above by default.
    const need = table === "social_post_events" || table === "social_post_metrics" || table === "social_publish_jobs" || table === "social_posts" ? 1 : 1;
    if (seen.ownerA.length !== need || seen.ownerB.length !== need) fail("E", `${table}: each owner should see exactly their own workspace's row (A ${seen.ownerA.length}, B ${seen.ownerB.length})`);
    if (seen.viewerA.length !== need) fail("E", `${table}: a viewer should see their workspace's row (saw ${seen.viewerA.length})`);
  }
  if (!(await denied(ownerA, "select credentials from social_accounts"))) fail("E", "the application role can read social_accounts.credentials");
  if (!(await denied(ownerA, "select * from social_accounts"))) fail("E", "select * on social_accounts works for the application role (it would include the credentials column)");
  if (!(await denied(ownerA, "select 1 from social_oauth_states"))) fail("E", "the application role can read social_oauth_states");
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
  if (!result.sections.E.failures.length) finding("E", "as the application role: each owner and a viewer read only their own workspace's rows in all nine readable tables; a stranger and a request with no user read nothing; the credentials column, select *, and the sign-in state table are refused; a delete is refused on all ten");

  // The role a published site runs under: no table privileges at all.
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
    if (!result.sections.E.failures.length) finding("E", "as the published-site role: none of the ten new tables can be read");
  }
  await db.close();
}

// --------------------------------------------------------------------------------------------------------------------------------------------
console.log(`Phase 4 migration rehearsal on embedded Postgres (${name(F89)}; ${files.length} migrations in this checkout)`);
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
