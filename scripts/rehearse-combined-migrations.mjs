// Rehearses the ACTUAL combined migration history (everything from 0077, the AI workforce, up to the current head, with the reserved 0084 slotted in) on
// EMBEDDED Postgres only (PGlite, in memory). It never reads an environment file, never opens a network connection and cannot reach any hosted database:
//   node scripts/rehearse-combined-migrations.mjs [--report .data/combined-migration-rehearsal.json] [--scale 1] [--sections A,B,C,D,E,F]
//   (--scale sizes the dataset, 1 = about 7,200 rows before 0077; --sections runs part of it, B / C / D always run together; --migrations-dir and --rollbacks-dir
//    point at a scratch copy with a deliberately broken file, to show that the checks can fail. Run it under the lock: node scripts/run-locked.mjs heavy -- node scripts/rehearse-combined-migrations.mjs)
//
// The per-phase rehearsals (phase2, phase3, phase4, migration-order) each cover their own migrations from the state just before them. This one covers the whole
// history on ONE populated database:
//   A. Numbers and order: every file applies in order on an empty database with no error; numbers are unique; every gap is listed and explained; every
//      migration from 0077 has a rollback; the declared prerequisites hold in the order applied; the same files on codex/client-ai-onboarding are the same blobs.
//   B. Upgrade from the production baseline: apply everything below 0077, populate a realistic dataset (several workspaces, members, contacts, conversations,
//      messages, calls, appointments, AI employees, notifications, private files, tasks, leads, chat), hash every row of every table, then apply each later
//      migration ONE AT A TIME. After each: every earlier row is unchanged (count and hash, all tables), no earlier notification kind, permission, storage bucket,
//      stored-file bucket, conversation channel or contact origin is lost, the application role sees exactly the same rows as before, every new table has
//      row-level security and no grant to anon, authenticated, PUBLIC or the published-site role, the application role holds SELECT only (column level where the
//      migration says so), and every new table starts empty. Each migration's own data is then added, so later migrations meet realistic rows of earlier ones.
//   C. The schema after every step of path B (and the final one) equals the schema of the fresh chain of A (columns, constraints, indexes, policies, triggers,
//      function bodies, table / column / function / schema grants, default privileges, roles, role permissions, comments), and the data the migrations
//      themselves seed (reference data) is the same.
//   D. Rollbacks, from 0077, on the populated database of B: every rollback is first tried on the full database inside a throwaway transaction (those with a data
//      guard must refuse and change nothing); then, newest first, the data a rollback guards is removed (what an operator exports first), the rollback runs, and
//      the schema must equal the fingerprint recorded before that migration was applied and every earlier row must be unchanged; then everything is applied forward
//      again and compared with C.
//   E. The reserved 0084 (restricted Hermes provisioner, from codex/client-ai-onboarding) before, between and after: the final schema is identical, and 0084 also
//      applies cleanly on top of the populated head.
//   F. The hosted procedure of the release docs, as far as embedded Postgres can: a database whose ledger ends at 0086 (80 rows), a backup that is restored and
//      checked, a dry run that lists the pending versions, then each pending migration applied alone (the runner's prerequisite and ledger rules mirrored) with a
//      full check after each.
// Exit code 1 when any check fails, 2 when the rehearsal itself could not finish.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

const bail = (e) => {
  console.error(`The rehearsal could not finish: ${String(e?.stack ?? e?.message ?? e).slice(0, 1200)}`);
  process.exit(2);
};
process.on("uncaughtException", bail);
process.on("unhandledRejection", bail);

const root = path.resolve(import.meta.dirname, "..");
const argv = process.argv.slice(2);
const arg = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : null);
// --migrations-dir / --rollbacks-dir point at a scratch copy with a deliberately broken file, to show that the checks below can fail (mutation check).
const MIGRATIONS = arg("--migrations-dir") ? path.resolve(arg("--migrations-dir")) : path.join(root, "supabase", "migrations");
const ROLLBACKS = arg("--rollbacks-dir") ? path.resolve(arg("--rollbacks-dir")) : path.join(root, "supabase", "rollbacks");
const FILE = /^\d{4}_[a-z0-9_]+\.sql$/;
const ROLLBACK_FILE = /^\d{4}_[a-z0-9_]+\.down\.sql$/;
const reportPath = arg("--report");
const scale = Number(arg("--scale") ?? 1);
const wanted = arg("--sections") ? new Set(arg("--sections").split(",").map((s) => s.trim().toUpperCase())) : null;
const wants = (...keys) => !wanted || keys.some((k) => wanted.has(k));
const EXT = { citext, pg_trgm, btree_gist };

const files = fs.readdirSync(MIGRATIONS).filter((f) => FILE.test(f)).sort();
const name = (f) => f.replace(/\.sql$/, "");
const prefix = (f) => f.slice(0, f.indexOf("_"));
const numOf = (f) => Number(prefix(f));
const BASELINE = files.filter((f) => numOf(f) < 77);
const HISTORY = files.filter((f) => numOf(f) >= 77);
const HEAD = files[files.length - 1];
if (!BASELINE.length || !HISTORY.length) throw new Error("This checkout has no migrations on both sides of 0077.");

const t0All = Date.now();
const result = { ok: true, sections: {}, notes: [] };
const section = (key, title) => (result.sections[key] = { title, failures: [], findings: [], notes: [], ms: 0 });
const fail = (key, message) => {
  result.ok = false;
  result.sections[key].failures.push(message);
};
const finding = (key, message) => result.sections[key].findings.push(message);
const note = (key, message) => result.sections[key].notes.push(message);
const clip = (s, n = 400) => String(s ?? "").replace(/\s+/g, " ").slice(0, n);
const git = (args) => {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
};

// --------------------------------------------------------------------------------------------------------------------------------------------
// Embedded database helpers
// --------------------------------------------------------------------------------------------------------------------------------------------
const COMPAT = fs.readFileSync(path.join(root, "supabase", "local-compat.sql"), "utf8");
async function newDb(options = {}) {
  const db = new PGlite({ extensions: EXT, ...options });
  await db.waitReady;
  if (options.loadDataDir) return db;
  await db.transaction((tx) => tx.exec(COMPAT));
  // A hosted Supabase project is reported to refuse a direct delete from its storage tables unless the transaction sets storage.allow_delete_query to 'true'.
  // The embedded stand-in has no such guard, so one modelled on that report is added: a rollback that deletes a bucket without allowing it fails here. It is a
  // model, not a copy of the hosted trigger; the rollback has not been run on a real project.
  await db.exec(`
    create function storage.zz_rehearsal_protect_delete() returns trigger language plpgsql as $$
    begin
      if current_setting('storage.allow_delete_query', true) is distinct from 'true' then
        raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.';
      end if;
      return null;
    end $$;
    create trigger zz_rehearsal_protect_delete before delete on storage.buckets for each statement execute function storage.zz_rehearsal_protect_delete();`);
  await db.exec("create table if not exists schema_migrations (version text primary key, applied_at timestamptz not null default now())");
  return db;
}
// The runner's own statement (src/server/db/index.ts runMigrations): the file and its ledger row in one transaction.
const upSql = (db, sql, version) => db.transaction((tx) => tx.exec(`${sql}\ninsert into schema_migrations (version) values ('${version}');`));
const up = (db, file) => upSql(db, fs.readFileSync(path.join(MIGRATIONS, file), "utf8"), name(file));
const rollbackPath = (file) => path.join(ROLLBACKS, `${name(file)}.down.sql`);
const rollbackSql = (file) => fs.readFileSync(rollbackPath(file), "utf8");
const down = (db, file) => db.transaction((tx) => tx.exec(rollbackSql(file)));
const forget = (db, file) => db.query("delete from schema_migrations where version = $1", [name(file)]);
const q = async (db, sql, params) => (await db.query(sql, params)).rows;
const one = async (db, sql, params) => (await q(db, sql, params))[0];
const ROLLED_BACK = new Error("rolled back on purpose");
// Runs fn inside a transaction that is always rolled back, so a rollback script tried out of order, or a migration expected to fail, can never leave a trace.
async function throwaway(db, fn) {
  let out;
  try {
    await db.transaction(async (tx) => {
      out = await fn(tx);
      throw ROLLED_BACK;
    });
  } catch (e) {
    if (e !== ROLLED_BACK) throw e;
  }
  return out;
}
// A script (several statements, no parameters) goes through exec; a single statement with parameters through query.
const attempt = async (tx, sql, params) => {
  try {
    if (params) await tx.query(sql, params);
    else await tx.exec(sql);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: String(e.message) };
  }
};

// --------------------------------------------------------------------------------------------------------------------------------------------
// The schema fingerprint: every fact a migration can change, as one text line each
// --------------------------------------------------------------------------------------------------------------------------------------------
const ROLES = "('anon', 'authenticated', 'service_role', 'iaq_app_user', 'iaq_site_runtime')";
const NOT_EXT = "not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')";
const FINGERPRINT = `
  select 'column' as kind, n.nspname || '.' || c.relname || '.' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), '') || ':' || a.attidentity::text || ':' || a.attgenerated::text as item
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
   where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm') and n.nspname in ('public', 'app')
  union all select 'constraint', conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) from pg_constraint where connamespace in ('public'::regnamespace, 'app'::regnamespace)
  union all select 'index', schemaname || '.' || indexdef from pg_indexes where schemaname in ('public', 'app', 'storage')
  union all select 'policy', schemaname || '.' || tablename || ':' || policyname || ':' || cmd || ':' || permissive || ':' || roles::text || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') from pg_policies where schemaname in ('public', 'app', 'storage', 'realtime')
  union all select 'trigger', t.tgrelid::regclass::text || ':' || t.tgname || ':' || pg_get_triggerdef(t.oid) from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace where not t.tgisinternal and n.nspname in ('public', 'app', 'storage', 'realtime')
  union all select 'function', p.oid::regprocedure::text || ':' || md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname in ('public', 'app', 'storage', 'auth', 'realtime') and p.prokind in ('f', 'p') and ${NOT_EXT}
  union all select 'function_acl', p.oid::regprocedure::text || ':' || coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') || ':' || x.privilege_type || ':' || x.is_grantable::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
   where n.nspname in ('public', 'app', 'storage', 'auth', 'realtime') and p.prokind in ('f', 'p') and ${NOT_EXT}
  union all select 'rls', c.relname || ':' || c.relrowsecurity::text || ':' || c.relforcerowsecurity::text from pg_class c where c.relnamespace in ('public'::regnamespace, 'app'::regnamespace) and c.relkind in ('r', 'p')
  union all select 'table_acl', n.nspname || '.' || c.relname || ':' || coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') || ':' || x.privilege_type || ':' || x.is_grantable::text
    from pg_class c join pg_namespace n on n.oid = c.relnamespace, aclexplode(coalesce(c.relacl, acldefault(case when c.relkind = 'S' then 's'::"char" else 'r'::"char" end, c.relowner))) x
   where n.nspname in ('public', 'app') and c.relkind in ('r', 'p', 'v', 'm', 'S')
  union all select 'column_acl', n.nspname || '.' || c.relname || '.' || a.attname || ':' || coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') || ':' || x.privilege_type
    from pg_attribute a join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace, aclexplode(a.attacl) x
   where a.attnum > 0 and not a.attisdropped and a.attacl is not null and n.nspname in ('public', 'app')
  union all select 'schema_acl', n.nspname || ':' || coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') || ':' || x.privilege_type from pg_namespace n, aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) x where n.nspname in ('public', 'app', 'storage', 'auth', 'realtime')
  union all select 'default_acl', coalesce(n.nspname, '*') || ':' || d.defaclobjtype::text || ':' || coalesce(d.defaclacl::text, '') from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
  union all select 'role', r.rolname || ':' || r.rolsuper::text || ':' || r.rolinherit::text || ':' || r.rolcanlogin::text || ':' || r.rolbypassrls::text from pg_roles r where r.rolname in ${ROLES}
  union all select 'role_member', g.rolname || '>' || m.rolname from pg_auth_members am join pg_roles g on g.oid = am.roleid join pg_roles m on m.oid = am.member where g.rolname in ${ROLES} or m.rolname in ${ROLES}
  union all select 'role_setting', coalesce(r.rolname, '*') || ':' || s.setconfig::text from pg_db_role_setting s left join pg_roles r on r.oid = s.setrole
  union all select 'type', t.typname || ':' || t.typtype::text || ':' || coalesce((select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid), '') from pg_type t where t.typnamespace in ('public'::regnamespace, 'app'::regnamespace) and t.typtype in ('e', 'd')
  union all select 'extension', extname from pg_extension
  union all select 'comment', 'public.' || c.relname || '.' || d.objsubid::text || ':' || d.description from pg_description d join pg_class c on c.oid = d.objoid and d.classoid = 'pg_class'::regclass where c.relnamespace = 'public'::regnamespace
  union all select 'sequence', n.nspname || '.' || c.relname || ':' || format_type(s.seqtypid, null) || ':' || s.seqstart || ':' || s.seqincrement || ':' || s.seqmax || ':' || s.seqcycle::text from pg_sequence s join pg_class c on c.oid = s.seqrelid join pg_namespace n on n.oid = c.relnamespace where n.nspname in ('public', 'app')
  union all select 'role_permission', role || ':' || permission from role_permissions`;
// Allow-lists that migrations rewrite are compared as SETS (the database prints the same constraint as an IN list or an array literal, in any order).
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
const showDiff = (d, n = 900) => clip(JSON.stringify(d), n);
const constraintSet = async (db, conname, table) => {
  const r = (await q(db, "select pg_get_constraintdef(oid) as d from pg_constraint where conname = $1 and conrelid = $2::regclass", [conname, table]))[0];
  return r ? [...new Set(quoted(r.d))].sort() : [];
};
const kindsNow = (db) => constraintSet(db, "notifications_kind_check", "notifications");
const subsetOf = (a, b) => a.filter((x) => !b.includes(x));

// --------------------------------------------------------------------------------------------------------------------------------------------
// Row snapshots: count and hash of every row of every table, with the columns and keys known when the snapshot was taken
// --------------------------------------------------------------------------------------------------------------------------------------------
const listTables = async (db) => (await q(db, "select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relname <> 'schema_migrations' order by 1")).map((r) => r.relname);
async function countAll(db, tables) {
  const rows = await q(db, "select t as table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int as n from unnest($1::text[]) t", [tables]);
  return new Map(rows.map((r) => [r.table_name, r.n]));
}
async function tableShape(db) {
  const pks = new Map((await q(db, `select c.relname, array_agg(a.attname order by array_position(i.indkey::int2[], a.attnum)) as cols
    from pg_index i join pg_class c on c.oid = i.indrelid join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
    where i.indisprimary and c.relnamespace = 'public'::regnamespace group by c.relname`)).map((r) => [r.relname, r.cols]));
  const cols = new Map();
  for (const r of await q(db, "select table_name, column_name from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position")) {
    if (!cols.has(r.table_name)) cols.set(r.table_name, []);
    cols.get(r.table_name).push(r.column_name);
  }
  return { pks, cols };
}
const keyExpr = (table, pks) => (pks.has(table) ? `concat_ws('|', ${pks.get(table).map((c) => `t."${c}"::text`).join(", ")})` : "md5(to_jsonb(t)::text)");
async function hashRows(db, table, cols, expr, keys) {
  const sql = `select count(*)::int as n, md5(coalesce(string_agg(r, '|' order by k), '')) as h, coalesce(array_agg(k order by k), '{}') as keys
    from (select ${expr} as k, (select jsonb_object_agg(e.key, e.value) from jsonb_each(to_jsonb(t)) e where e.key = any($1::text[]))::text as r from public."${table}" t${keys ? ` where ${expr} = any($2::text[])` : ""}) s`;
  return one(db, sql, keys ? [cols, keys] : [cols]);
}
async function snapshot(db) {
  const tables = await listTables(db);
  const counts = await countAll(db, tables);
  const { pks, cols } = await tableShape(db);
  const snap = new Map();
  for (const t of tables) {
    const n = counts.get(t);
    const c = cols.get(t);
    if (!n) {
      snap.set(t, { n: 0, cols: c, expr: keyExpr(t, pks), keys: [], h: "" });
      continue;
    }
    const expr = keyExpr(t, pks);
    const r = await hashRows(db, t, c, expr, null);
    snap.set(t, { n: r.n, cols: c, expr, keys: r.keys, h: r.h });
  }
  return snap;
}
const rowsIn = (snap) => [...snap.values()].reduce((a, s) => a + s.n, 0);
// The whole table must still be what it was: same number of rows and the same hash over the columns that existed then. Returns what differs.
// A table in `growable` (one the migration itself inserts into, such as the role permissions) may gain rows; every earlier row must still be there and unchanged.
async function verifyWhole(db, snap, growable = new Set()) {
  const bad = [];
  bad.grew = new Map();
  const tables = [...snap.keys()];
  const exists = new Set(await listTables(db));
  const counts = await countAll(db, tables.filter((t) => exists.has(t)));
  for (const [t, s] of snap) {
    if (!exists.has(t)) {
      bad.push(`${t}: the table is gone`);
      continue;
    }
    const n = counts.get(t);
    if (growable.has(t)) {
      if (s.n) {
        const r = await hashRows(db, t, s.cols, s.expr, s.keys);
        if (r.n !== s.n || r.h !== s.h) bad.push(`${t}: ${s.n} earlier rows, ${r.n} found, ${r.h === s.h ? "same" : "different"} content`);
      }
      if (n > s.n) bad.grew.set(t, n - s.n);
      continue;
    }
    if (n !== s.n) {
      bad.push(`${t}: ${s.n} rows before, ${n} now`);
      continue;
    }
    if (!n) continue;
    const r = await hashRows(db, t, s.cols, s.expr, null);
    if (r.h !== s.h) bad.push(`${t}: ${s.n} rows keep their count but their content changed`);
  }
  return bad;
}
// Only the rows that existed then (by key), over the columns that existed then: for a database that has since gained other rows.
async function verifyKeys(db, snap) {
  const bad = [];
  const exists = new Set(await listTables(db));
  for (const [t, s] of snap) {
    if (!s.n) continue;
    if (!exists.has(t)) {
      bad.push(`${t}: the table is gone`);
      continue;
    }
    const r = await hashRows(db, t, s.cols, s.expr, s.keys);
    if (r.n !== s.n || r.h !== s.h) bad.push(`${t}: ${s.n} earlier rows, ${r.n} found, ${r.h === s.h ? "same" : "different"} content`);
  }
  return bad;
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// What the application role can see: row counts per person, per table that holds data
// --------------------------------------------------------------------------------------------------------------------------------------------
async function probeTables(db, snap) {
  const withData = [...snap.entries()].filter(([, s]) => s.n > 0).map(([t]) => t);
  const rows = await q(db, `select c.relname from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity and c.relname = any($1::text[])
      and has_any_column_privilege('iaq_app_user', format('public.%I', c.relname), 'select') order by 1`, [withData]);
  return rows.map((r) => r.relname);
}
async function probe(db, ctx, tables) {
  const people = { ownerA: ctx.users.ownerA, adminA: ctx.users.adminA, memberA: ctx.users.memberA, viewerA: ctx.users.viewerA, ownerB: ctx.users.ownerB, stranger: ctx.users.stranger, nobody: null };
  const out = {};
  for (const [who, id] of Object.entries(people)) {
    out[who] = await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [id ?? ""]);
      await tx.query("set local role iaq_app_user");
      const rows = (await tx.query("select t as table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', t), false, true, '')))[1]::text::int as n from unnest($1::text[]) t", [tables])).rows;
      return Object.fromEntries(rows.map((r) => [r.table_name, r.n]));
    });
  }
  return out;
}
const OLD_BUCKETS = ["company-documents", "support-attachments", "project-files", "project-uploads", "portfolio-assets", "brand-assets", "aqi-attachments"];
async function filePermissionTruth(db, ctx) {
  const people = { ownerA: ctx.users.ownerA, adminA: ctx.users.adminA, memberA: ctx.users.memberA, salesA: ctx.users.salesA, viewerA: ctx.users.viewerA, stranger: ctx.users.stranger, ownerB: ctx.users.ownerB };
  const out = {};
  for (const [who, id] of Object.entries(people)) {
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [id]);
      for (const bucket of OLD_BUCKETS) {
        for (const write of [false, true]) {
          out[`${who}|${bucket}|${write ? "write" : "read"}`] = (await tx.query("select app.file_permission($1, $2, $3, 'client') as ok", [ctx.orgs.a.id, bucket, write])).rows[0].ok;
        }
      }
    });
  }
  return out;
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// The state of a database that later steps are compared with
// --------------------------------------------------------------------------------------------------------------------------------------------
async function capture(db, ctx, options = {}) {
  const snap = await snapshot(db);
  const tables = new Set(await listTables(db));
  const fnHash = (await one(db, "select md5(pg_get_functiondef('app.file_permission(uuid, text, boolean, text)'::regprocedure)) as h")).h;
  const state = {
    fp: await fingerprint(db),
    snap,
    tables,
    kinds: await kindsNow(db),
    perms: new Set((await q(db, "select role || ':' || permission as p from role_permissions")).map((r) => r.p)),
    buckets: (await q(db, "select id from storage.buckets order by id")).map((r) => r.id),
    bucketCheck: await constraintSet(db, "private_files_bucket_check", "private_files"),
    channels: await constraintSet(db, "conversations_channel_check", "conversations"),
    vias: await constraintSet(db, "contacts_created_via_check", "contacts"),
    ledger: (await q(db, "select version from schema_migrations order by version")).map((r) => r.version),
    fnHash,
    probeTables: await probeTables(db, snap),
  };
  state.probe = ctx && !options.skipProbe ? await probe(db, ctx, state.probeTables) : null;
  return state;
}
const probeDiff = (a, b, skip = new Set()) => {
  const out = [];
  for (const who of Object.keys(a)) for (const t of Object.keys(a[who])) if (!skip.has(t) && a[who][t] !== b[who]?.[t]) out.push(`${who} sees ${a[who][t]} rows of ${t} before and ${b[who]?.[t]} after`);
  return out;
};
// Tables a migration file itself inserts into (reference data such as the role permissions): they may gain rows, but every earlier row must stay.
const insertTargets = (file) => {
  const text = fs.readFileSync(path.join(MIGRATIONS, file), "utf8").replace(/--[^\n]*/g, "");
  return new Set([...text.matchAll(/\binsert\s+into\s+(?:public\.)?"?([a-z_]+)"?/gi)].map((m) => m[1]));
};

// --------------------------------------------------------------------------------------------------------------------------------------------
// New tables: row-level security, grants, emptiness
// --------------------------------------------------------------------------------------------------------------------------------------------
async function checkNewObjects(db, key, version, before, after) {
  const fresh = [...after.tables].filter((t) => !before.tables.has(t)).sort();
  const problems = [];
  const columnLevel = [];
  const serverOnly = [];
  const fnInfo = [];
  for (const t of fresh) {
    const meta = await one(db, "select c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = $1", [t]);
    if (!meta.rls) problems.push(`${t} has no row-level security`);
    const grants = await q(db, `select coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') as grantee, x.privilege_type as priv
      from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) x where c.relnamespace = 'public'::regnamespace and c.relname = $1`, [t]);
    const cols = await q(db, `select a.attname as col, coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') as grantee, x.privilege_type as priv
      from pg_attribute a join pg_class c on c.oid = a.attrelid, aclexplode(a.attacl) x where c.relnamespace = 'public'::regnamespace and c.relname = $1 and a.attacl is not null and a.attnum > 0 and not a.attisdropped`, [t]);
    for (const g of grants) {
      if (["anon", "authenticated", "PUBLIC", "iaq_site_runtime"].includes(g.grantee)) problems.push(`${t}: ${g.grantee} holds ${g.priv}`);
      if (g.grantee === "iaq_app_user" && g.priv !== "SELECT") problems.push(`${t}: iaq_app_user holds ${g.priv} (select only expected)`);
    }
    for (const g of cols) {
      if (["anon", "authenticated", "PUBLIC", "iaq_site_runtime"].includes(g.grantee)) problems.push(`${t}.${g.col}: ${g.grantee} holds column ${g.priv}`);
      if (g.grantee === "iaq_app_user" && g.priv !== "SELECT") problems.push(`${t}.${g.col}: iaq_app_user holds column ${g.priv}`);
    }
    const canRead = (await one(db, "select has_any_column_privilege('iaq_app_user', $1, 'select') as ok", [`public.${t}`])).ok;
    const tableLevel = (await one(db, "select has_table_privilege('iaq_app_user', $1, 'select') as ok", [`public.${t}`])).ok;
    if (canRead && !tableLevel) {
      const withheld = (await q(db, "select a.attname from pg_attribute a where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and not has_column_privilege('iaq_app_user', a.attrelid, a.attnum, 'select')", [`public.${t}`])).map((r) => r.attname);
      columnLevel.push(`${t} (select on every column except ${withheld.join(", ") || "none"})`);
    }
    if (!canRead) serverOnly.push(t);
    const policies = await q(db, "select qual from pg_policies where schemaname = 'public' and tablename = $1 and cmd in ('SELECT', 'ALL')", [t]);
    if (canRead && !policies.some((p) => p.qual && p.qual.trim() !== "true")) problems.push(`${t}: readable by iaq_app_user but no row-limiting select policy`);
    if (!canRead && policies.length) problems.push(`${t}: has policies but iaq_app_user cannot read it (dead policy)`);
    const siteRead = (await one(db, "select has_any_column_privilege('iaq_site_runtime', $1, 'select, insert, update, references') as ok", [`public.${t}`])).ok;
    if (siteRead) problems.push(`${t}: the published-site role holds a privilege`);
    const n = (await one(db, `select count(*)::int as n from public."${t}"`)).n;
    if (n) problems.push(`${t} was not empty after the migration (${n} rows): a dormant feature must start with no data`);
  }
  // Identity sequences of new tables, and new functions, must not be open to the Data API roles either.
  const seqs = await q(db, `select c.relname as seq, coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC') as grantee, x.privilege_type as priv
    from pg_class c, aclexplode(coalesce(c.relacl, acldefault('s', c.relowner))) x where c.relnamespace = 'public'::regnamespace and c.relkind = 'S' and x.grantee in (0, (select oid from pg_roles where rolname = 'anon'), (select oid from pg_roles where rolname = 'authenticated'))`);
  for (const s of seqs) if (fresh.some((t) => s.seq.startsWith(`${t}_`))) problems.push(`sequence ${s.seq}: ${s.grantee} holds ${s.priv}`);
  const newFns = [...after.fp].filter((f) => f.startsWith("function|") && !before.fp.has(f)).map((f) => f.slice("function|".length, f.lastIndexOf(":")));
  for (const sig of newFns) {
    const r = await one(db, `select p.prosecdef as definer, (select coalesce(array_agg(coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC')), '{}') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.privilege_type = 'EXECUTE') as grantees
      from pg_proc p where p.oid = $1::regprocedure`, [sig]);
    const open = r.grantees.filter((g) => ["PUBLIC", "anon", "authenticated"].includes(g));
    if (r.definer && open.length) problems.push(`function ${sig} is SECURITY DEFINER and executable by ${open.join(", ")}`);
    fnInfo.push(`${sig} [${r.definer ? "security definer" : "invoker"}; execute: ${[...new Set(r.grantees)].join(", ")}]`);
  }
  for (const p of problems) fail(key, `${version}: ${p}`);
  return { fresh, newFns, problems, columnLevel, serverOnly, fnInfo };
}

// Tenant isolation of the workforce event trail: an event row that names workspace B but belongs to a job of workspace A. Does the owner of B see it through the
// application role? (Writes are server-only, so such a row would be a server bug; the policy is the database-level defence.) Always rolled back.
async function eventLeak(db, ctx) {
  return throwaway(db, async (tx) => {
    const job = (await tx.query("select id from ai_work_jobs where org_id = $1 and capability <> 'proactive_review' limit 1", [ctx.orgs.a.id])).rows[0].id;
    await tx.query("insert into ai_work_events (job_id, org_id, kind, message) values ($1, $2, 'notice', 'cross-workspace probe')", [job, ctx.orgs.b.id]);
    await tx.query("select set_config('app.user_id', $1, true)", [ctx.users.ownerB]);
    await tx.query("set local role iaq_app_user");
    return (await tx.query("select count(*)::int as n from ai_work_events where message = 'cross-workspace probe'")).rows[0].n;
  });
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// The dataset
// --------------------------------------------------------------------------------------------------------------------------------------------
async function seedBaseline(db, k) {
  const N = (x) => Math.max(5, Math.round(x * k));
  const ctx = { orgs: {}, users: {}, agents: {}, sizes: {} };
  const mkUser = async (email, fullName, platformRole = "none") =>
    (await one(db, "insert into users (email, full_name, email_verified_at, platform_role) values ($1::text, $2::text, now(), $3::text) returning id", [email, fullName, platformRole])).id;
  const defs = [["a", "Atlas Plumbing", "active", "555"], ["b", "Birch Dental", "active", "556"], ["c", "Cedar Realty", "active", "557"], ["d", "Dune Studio", "onboarding", "558"]];
  for (const [key, orgName, status, area] of defs) {
    const id = (await one(db, "insert into organizations (name, slug, kind, status, timezone) values ($1::text, $2::text, 'client', $3::text, 'America/New_York') returning id", [orgName, `rehearsal-${key}`, status])).id;
    ctx.orgs[key] = { key, id, area };
  }
  const roles = [["owner", "owner"], ["admin", "admin"], ["member", "member"], ["sales", "sales_rep"], ["viewer", "viewer"]];
  for (const key of ["a", "b", "c"]) {
    for (const [who, role] of roles) {
      const id = await mkUser(`${who}-${key}@example.test`, `${who} ${key}`);
      ctx.users[`${who}${key.toUpperCase()}`] = id;
      await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, $3)", [ctx.orgs[key].id, id, role]);
    }
  }
  ctx.users.ownerD = await mkUser("owner-d@example.test", "owner d");
  await db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'owner')", [ctx.orgs.d.id, ctx.users.ownerD]);
  ctx.users.staff = await mkUser("staff@example.test", "Agency Super Admin", "agency_super_admin");
  ctx.users.stranger = await mkUser("stranger@example.test", "A Stranger");

  const kinds = await kindsNow(db);
  for (const key of ["a", "b", "c"]) {
    const org = ctx.orgs[key].id;
    const owner = ctx.users[`owner${key.toUpperCase()}`];
    const member = ctx.users[`member${key.toUpperCase()}`];
    const agents = {};
    for (const [slot, role, display, status, mode] of [["sales", "sales_assistant", "Sales Assistant", "online", "approval_required"], ["setter", "appointment_setter", "Appointment Setter", "offline", "approval_required"], ["hunter", "lead_hunter", "Lead Hunter", "setup_required", "approval_required"], ["crm", "crm_manager", "CRM Manager", "online", "autonomous"]]) {
      agents[slot] = (await one(db, "insert into agent_instances (org_id, role_key, display_name, status, mode) values ($1, $2, $3, $4, $5) returning id", [org, role, display, status, mode])).id;
    }
    ctx.agents[key] = agents;
    for (const [slot, id] of Object.entries(agents)) {
      await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, requested_by, detail) values ($1, $2, 'provision', 'succeeded', $3, $4)", [org, id, owner, `Provisioned ${slot}`]);
    }
    // One employee has a request still open: the state 0082's unique index must accept, since only a second open request for the same employee is refused.
    await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, requested_by, detail) values ($1, $2, 'reconnect', 'requested', $3, 'Reconnect requested')", [org, agents.hunter, owner]);

    await db.query(
      `insert into contacts (org_id, display_name, email, phone, first_name, last_name, lifecycle_stage, lead_status, source, created_via)
       select $1::uuid, 'Customer ' || g, 'c' || g || '@' || $2::text || '.example.test', '+1' || $3::text || lpad(g::text, 7, '0'), 'First' || g, 'Last' || g,
              (array['lead_captured', 'qualified', 'follow_up', 'customer'])[1 + g % 4], (array['new', 'open', 'contacted', 'qualified'])[1 + g % 4], 'inbound_message',
              (array['inbound_message', 'manual', 'import', 'website_form', 'call'])[1 + g % 5]
         from generate_series(1, $4::int) g`, [org, key, ctx.orgs[key].area, N(500)]);
    await db.query(
      `insert into conversations (org_id, contact_id, channel, status, owner_kind, ai_agent_id, owner_user_id, priority, unread_count, last_inbound_at, last_outbound_at, last_message_at, last_message_preview)
       select $1::uuid, c.id, (array['sms', 'whatsapp', 'email'])[1 + c.k % 3], (array['open', 'open', 'snoozed', 'closed'])[1 + c.k % 4],
              case c.k % 3 when 0 then 'ai' when 1 then 'human' else 'unassigned' end, case c.k % 3 when 0 then $2::uuid end, case c.k % 3 when 1 then $3::uuid end,
              (array['low', 'normal', 'high', 'urgent'])[1 + c.k % 4], c.k % 5, now() - (c.k * interval '7 minutes'), now() - (c.k * interval '6 minutes'), now() - (c.k * interval '5 minutes'), 'Preview ' || c.k
         from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1::uuid order by id limit $4::int) c`, [org, agents.sales, member, N(300)]);
    await db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at, provider)
       select org_id, id, 'inbound', 'contact', 'Hi, I have a question ' || last_message_preview, 'received', coalesce(last_inbound_at, now()), 'twilio' from conversations where org_id = $1::uuid`, [org]);
    await db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, agent_id, author_user_id, body, status, created_at, sent_at, failed_at, status_detail, provider)
       select c.org_id, c.id, 'outbound', case when c.owner_kind = 'human' then 'human' else 'ai' end, case when c.owner_kind = 'ai' then c.ai_agent_id end, c.owner_user_id,
              'Thanks, we can help ' || c.last_message_preview, case when c.unread_count = 4 then 'failed' else 'sent' end, coalesce(c.last_outbound_at, now()), coalesce(c.last_outbound_at, now()),
              case when c.unread_count = 4 then coalesce(c.last_outbound_at, now()) end, case when c.unread_count = 4 then 'Provider rejected the number' end, 'twilio'
         from conversations c where c.org_id = $1::uuid`, [org]);
    await db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, author_user_id, body, status, created_at)
       select org_id, id, 'internal', 'human', $2::uuid, 'Internal note for ' || last_message_preview, 'note', coalesce(last_message_at, now()) from conversations where org_id = $1::uuid`, [org, owner]);
    await db.query(
      `insert into crm_call_records (org_id, provider, provider_call_id, direction, status, from_number, to_number, contact_id, started_at, ended_at, duration_seconds)
       select $1::uuid, (array['vapi', 'retell'])[1 + x.k % 2], 'rh-' || $2::text || '-' || x.k, case when x.k % 5 = 0 then 'outbound' else 'inbound' end,
              (array['no_answer', 'completed', 'voicemail', 'failed', 'busy'])[1 + x.k % 5], x.phone, '+15555550100', x.id, now() - (x.k * interval '17 minutes'),
              now() - (x.k * interval '17 minutes') + interval '20 seconds', 20
         from (select id, phone, row_number() over (order by id)::int as k from contacts where org_id = $1::uuid order by id limit $3::int) x`, [org, key, N(150)]);
    await db.query(
      `insert into appointment_refs (org_id, provider, status, start_at, end_at, ghl_appointment_id, ghl_calendar_id, title, timezone, contact_id, origin)
       select $1::uuid, 'ghl', (array['new', 'confirmed', 'showed', 'noshow'])[1 + x.k % 4], now() + (x.k * interval '1 day'), now() + (x.k * interval '1 day') + interval '30 minutes',
              'ghl-appt-' || $2::text || '-' || x.k, 'cal-' || $2::text, 'Consultation ' || x.k, 'America/New_York', x.id, 'sync'
         from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1::uuid order by id limit $3::int) x`, [org, key, N(40)]);
    await db.query(
      `insert into appointment_bookings (org_id, contact_id, calendar_id, start_at, end_at, timezone, title, requested_by_kind, status, idempotency_key)
       select $1::uuid, x.id, 'cal-' || $2::text, now() + (x.k * interval '2 days'), now() + (x.k * interval '2 days') + interval '30 minutes', 'America/New_York', 'Booking ' || x.k, 'ai',
              (array['requested', 'needs_manual', 'awaiting_approval', 'cancelled'])[1 + x.k % 4], 'idem-' || $2::text || '-' || x.k
         from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1::uuid order by id desc limit $3::int) x`, [org, key, N(20)]);
    // One notification of every kind the allow-list holds, so no kind can be lost without a row to show it.
    for (const kind of kinds) {
      await db.query("insert into notifications (org_id, user_id, kind, title, body) values ($1, $2, $3, $4, 'Rehearsal notice')", [org, owner, kind, `Notice ${kind}`]);
    }
    await db.query("insert into notifications (org_id, user_id, kind, title) select $1::uuid, $2::uuid, 'system', 'Rehearsal notice ' || g from generate_series(1, $3::int) g", [org, owner, N(60)]);
    for (const bucket of OLD_BUCKETS) {
      for (let i = 1; i <= 3; i += 1) {
        await db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status, uploaded_by) values ($1, $2, $3, $4, 'application/pdf', 1000, 'ready', $5)", [org, bucket, `${org}/${bucket}/file-${i}.pdf`, `file-${i}.pdf`, owner]);
      }
    }
    await db.query(
      `insert into tasks (org_id, title, status, assigned_user_id, contact_id, created_by, completed_at)
       select $1::uuid, 'Follow up ' || x.k, (array['open', 'in_progress', 'done', 'cancelled'])[1 + x.k % 4], $2::uuid, x.id, $2::uuid, case when x.k % 4 = 2 then now() end
         from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1::uuid order by id limit $3::int) x`, [org, owner, N(40)]);
    await db.query("insert into leads (org_id, business_name, website, industry, location, source_platform) select $1::uuid, 'Prospect ' || g, 'https://prospect' || g || '.example.test', 'Plumbing', 'Austin', 'directory' from generate_series(1, $2::int) g", [org, N(20)]);
    await db.query("insert into lead_research_requests (org_id, requested_by, prompt, status) select $1::uuid, $2::uuid, 'Find plumbers near Austin ' || g, 'completed' from generate_series(1, $3::int) g", [org, owner, N(5)]);
    for (let i = 1; i <= N(5); i += 1) {
      const conv = (await one(db, "insert into chat_conversations (org_id, agent_instance_id, user_id, hermes_session_id, title) values ($1, $2, $3, $4, $5) returning id", [org, agents.sales, owner, `session-${key}-${i}`, `Chat ${i}`])).id;
      for (let m = 1; m <= 4; m += 1) {
        await db.query("insert into chat_messages (conversation_id, org_id, role, content, status, client_message_id) values ($1, $2, $3, $4, 'complete', $5)", [conv, org, m % 2 ? "user" : "assistant", `Message ${m} of chat ${i}`, `c${m}`]);
      }
    }
  }
  ctx.sizes = { contacts: N(500), conversations: N(300) };
  return ctx;
}

// Each migration's own data, added after it is applied. It only INSERTS rows (never edits an earlier row), so what a later step compares is exactly what was there.
const SEEDS = {};
const CLEAN = {};
const forOrgs = async (ctx, fn) => {
  for (const key of ["a", "b", "c"]) await fn(ctx.orgs[key].id, key, ctx.users[`owner${key.toUpperCase()}`]);
};
const seedContact = async (db, org, label, extra = {}) => {
  const cols = ["org_id", "display_name", ...Object.keys(extra)];
  const vals = [org, label, ...Object.values(extra)];
  return (await one(db, `insert into contacts (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals)).id;
};
SEEDS["0077_ai_work_jobs"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    const agents = ctx.agents[key];
    const statuses = ["queued", "running", "completed", "failed", "waiting_for_approval", "cancelled"];
    for (let i = 0; i < statuses.length; i += 1) {
      const job = (await one(db, `insert into ai_work_jobs (org_id, agent_instance_id, requested_by, capability, title, status, stage, result_summary, idempotency_key)
        values ($1, $2, $3, $4, $5, $6, 'working', $7, $8) returning id`, [org, i % 2 ? agents.hunter : agents.sales, owner, i === 4 ? "proactive_review" : "lead_research", `Seed job ${i}`, statuses[i], statuses[i] === "completed" ? "Found 3 leads" : null, `seed-0077-${key}-${i}`])).id;
      for (const [kind, message] of [["stage", "Started"], ["progress", "Halfway"], ["notice", "Needs a look"]]) {
        await db.query("insert into ai_work_events (job_id, org_id, kind, stage, message) values ($1, $2, $3, 'working', $4)", [job, org, kind, message]);
      }
      if (i === 2) {
        await db.query("insert into lead_research_requests (org_id, requested_by, prompt, status, work_job_id) values ($1, $2, 'Seed linked research request', 'completed', $3)", [org, owner, job]);
        const conv = (await one(db, "select id from chat_conversations where org_id = $1 limit 1", [org])).id;
        await db.query("insert into chat_messages (conversation_id, org_id, role, content, status, client_message_id, work_job_id) values ($1, $2, 'assistant', 'Seed linked chat message', 'complete', 'seed-linked', $3)", [conv, org, job]);
        await db.query("insert into leads (org_id, business_name, duplicate_matches, public_contact) values ($1, 'Seed researched lead', '[{\"id\":\"x\",\"score\":0.9}]'::jsonb, '{\"phone\":\"+15550001111\"}'::jsonb)", [org]);
      }
    }
  });
};
CLEAN["0077_ai_work_jobs"] = {
  guard: async (db) => {
    await db.query("delete from chat_messages where work_job_id is not null");
    await db.query("delete from lead_research_requests where work_job_id is not null");
    await db.query("delete from leads where business_name = 'Seed researched lead'");
    await db.query("delete from ai_work_events");
    await db.query("delete from ai_work_jobs");
  },
};
SEEDS["0078_ai_work_schedules"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    const job = (await one(db, "select id from ai_work_jobs where org_id = $1 order by created_at limit 1", [org])).id;
    await db.query("insert into ai_work_schedules (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, enabled, last_job_id) values ($1, $2, $3, 'lead_research', 'daily', 1440, false, $4)", [org, ctx.agents[key].hunter, owner, job]);
    await db.query("insert into ai_work_schedules (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, enabled) values ($1, $2, $3, 'crm_review', 'weekly', 10080, false)", [org, ctx.agents[key].crm, owner]);
  });
};
CLEAN["0078_ai_work_schedules"] = { guard: (db) => db.query("delete from ai_work_schedules") };
SEEDS["0079_ai_work_triggers"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    await db.query("insert into ai_work_triggers (org_id, agent_instance_id, created_by, capability, event_type, enabled) values ($1, $2, $3, 'lead_research', 'contact.created', false), ($1, $2, $3, 'crm_review', 'contact.updated', false)", [org, ctx.agents[key].crm, owner]);
  });
};
CLEAN["0079_ai_work_triggers"] = { guard: (db) => db.query("delete from ai_work_triggers") };
SEEDS["0080_proactive_ai_employees"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    const kinds = ["alert", "recommendation", "completion", "blocker", "daily_briefing"];
    for (let i = 0; i < kinds.length; i += 1) {
      const report = (await one(db, `insert into ai_work_reports (org_id, agent_instance_id, capability, kind, severity, title, summary, dedupe_key, alert_key)
        values ($1, $2, 'crm_review', $3, $4, $5, 'Seeded proactive report', $6, $7) returning id`, [org, ctx.agents[key].crm, kinds[i], i === 0 ? "critical" : "info", `Report ${i}`, `seed-0080-${key}-${i}-dedupe`, `seed-0080-${key}-${i}-alert`])).id;
      await db.query("insert into ai_work_report_deliveries (report_id, org_id, user_id, status, reason) values ($1, $2, $3, $4, 'rehearsal')", [report, org, owner, i === 0 ? "delivered" : "held"]);
    }
    // New schedule rows carry the new columns (an earlier row is never edited).
    await db.query("insert into ai_work_schedules (org_id, agent_instance_id, created_by, capability, cadence, interval_minutes, enabled, business_hours, payload, last_skipped_reason) values ($1, $2, $3, 'daily_briefing', 'daily', 1440, false, '{\"mon\":[[\"09:00\",\"17:00\"]]}'::jsonb, '{\"scope\":\"all\"}'::jsonb, 'quiet_hours')", [org, ctx.agents[key].setter, owner]);
  });
};
// The rollback refuses while ANY schedule exists, including those of 0078: they are exported (kept aside), removed for the rollback, and put back afterwards.
CLEAN["0080_proactive_ai_employees"] = {
  guard: async (db) => {
    await db.query("delete from ai_work_report_deliveries");
    await db.query("delete from ai_work_reports");
    const kept = (await q(db, "select to_jsonb(s) as row from ai_work_schedules s where payload = '{}'::jsonb and business_hours = '{}'::jsonb")).map((r) => r.row);
    await db.query("delete from ai_work_schedules");
    return { restore: async () => { if (kept.length) await db.query("insert into ai_work_schedules select * from jsonb_populate_recordset(null::ai_work_schedules, $1::jsonb)", [JSON.stringify(kept)]); } };
  },
};
// 0081 only changes two policies: nothing to seed, nothing to remove.
SEEDS["0082_client_employee_provisioning"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, requested_by, attempt_count, next_retry_at, lease_token, lease_expires_at, result_reference, detail) values ($1, $2, 'reconnect', 'failed', $3, 2, now() + interval '5 minutes', gen_random_uuid(), now() + interval '1 minute', 'profile-ref-seed', 'Retry scheduled')", [org, ctx.agents[key].setter, owner]);
  });
};
CLEAN["0082_client_employee_provisioning"] = { rest: (db) => db.query("delete from agent_provisioning_jobs where detail = 'Retry scheduled'") };
SEEDS["0083_unified_inbox"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    const mk = async (label, conv) => {
      const contact = await seedContact(db, org, `Seed-0083 ${label}`, { phone: `+1${ctx.orgs[key].area}9${String(label.length).padStart(6, "0")}` });
      const cols = ["org_id", "contact_id", "channel", ...Object.keys(conv)];
      const vals = [org, contact, "sms", ...Object.values(conv)];
      return (await one(db, `insert into conversations (${cols.join(", ")}) values (${vals.map((_, i) => `$${i + 1}`).join(", ")}) returning id`, vals)).id;
    };
    const archived = await mk("archived", { status: "closed", resolved_at: new Date().toISOString(), resolved_by: owner, outcome: "answered", archived_at: new Date().toISOString(), archived_by: owner });
    const paused = await mk("ai paused", { owner_kind: "ai", ai_agent_id: ctx.agents[key].sales, ai_paused_at: new Date().toISOString(), ai_paused_by: owner, ai_pause_reason: "Rehearsal pause" });
    const failed = await mk("failed send", {});
    const fenced = await mk("fenced", { owner_kind: "ai", ai_agent_id: ctx.agents[key].sales });
    await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, failed_at, failure_kind) values ($1, $2, 'outbound', 'human', 'Seed failed message', 'failed', now(), 'rejected')", [org, failed]);
    await db.query("insert into conversation_messages (org_id, conversation_id, direction, author_kind, agent_id, body, status, ownership_fence, status_changed_at) values ($1, $2, 'outbound', 'ai', $3, 'Seed fenced message', 'sent', 2, now())", [org, fenced, ctx.agents[key].sales]);
    for (const [conv, kind] of [[archived, "archived"], [paused, "ai_paused"], [failed, "message_retried"], [fenced, "ai_assigned"]]) {
      await db.query("insert into conversation_events (org_id, conversation_id, kind, actor_kind, actor_user_id, detail) values ($1, $2, $3, 'user', $4, '{\"from\":\"x\"}'::jsonb)", [org, conv, kind, owner]);
    }
    for (const kind of ["conversation_assigned", "conversation_new_inquiry", "conversation_awaiting_reply"]) {
      await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, $3, $4)", [org, owner, kind, `Seed ${kind}`]);
    }
  });
  await db.query("insert into inbox_rollout (org_id, enabled, note, enabled_at, enabled_by) values ($1, true, 'rehearsal wave', now(), $2), ($3, false, null, null, null)", [ctx.orgs.a.id, ctx.users.ownerA, ctx.orgs.b.id]);
};
CLEAN["0083_unified_inbox"] = {
  guard: async (db) => {
    await db.query("delete from conversation_events");
    await db.query("delete from notifications where kind in ('conversation_assigned', 'conversation_new_inquiry', 'conversation_awaiting_reply')");
  },
  // The rollback does not refuse for the new columns of conversations and messages (their rows stay, the columns go): the seed rows are removed afterwards.
  rest: (db) => db.query("delete from contacts where display_name like 'Seed-0083 %'"),
};
SEEDS["0085_missed_call_recovery"] = async (db, ctx) => {
  await db.query("insert into missed_call_policies (org_id, enabled, mode, activated_at, activated_by) values ($1, true, 'assisted', now(), $2)", [ctx.orgs.a.id, ctx.users.ownerA]);
  await db.query("insert into missed_call_policies (org_id) values ($1)", [ctx.orgs.b.id]);
  await forOrgs(ctx, async (org, key, owner) => {
    const calls = await q(db, "select id, contact_id, from_number, started_at from crm_call_records where org_id = $1 and direction = 'inbound' and from_number is not null order by id limit 4", [org]);
    const states = ["detected", "awaiting_response", "recovered", "suppressed"];
    for (let i = 0; i < calls.length; i += 1) {
      const c = calls[i];
      const id = (await one(db, `insert into missed_call_cases (org_id, contact_id, caller_number, business_number, classification, provider, first_called_at, last_called_at, state, state_reason)
        values ($1, $2, $3, '+15555550100', 'ring_no_answer', 'vapi', $4, $4, $5, 'seed') returning id`, [org, c.contact_id, c.from_number, c.started_at, states[i]])).id;
      await db.query("insert into missed_call_case_calls (org_id, case_id, call_record_id, classification, called_at) values ($1, $2, $3, 'ring_no_answer', $4)", [org, id, c.id, c.started_at]);
      await db.query("insert into missed_call_actions (org_id, case_id, kind, status, dedupe_key, actor_kind) values ($1, $2, 'task', 'done', $3, 'system')", [org, id, `seed-0085-${key}-${i}-task`]);
      await db.query("insert into missed_call_case_events (org_id, case_id, kind, to_state, actor_kind) values ($1, $2, 'detected', 'detected', 'system')", [org, id]);
    }
    await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'missed_call_follow_up', 'Seed missed call')", [org, owner]);
  });
};
// A policy row that was only ever saved with the defaults (workspace b) is configuration, not history: it is left in place and goes with the table.
CLEAN["0085_missed_call_recovery"] = {
  guard: async (db, ctx) => {
    await db.query("delete from notifications where kind = 'missed_call_follow_up'");
    await db.query("delete from missed_call_case_events");
    await db.query("delete from missed_call_actions");
    await db.query("delete from missed_call_case_calls");
    await db.query("delete from missed_call_cases");
    await db.query("delete from missed_call_policies where org_id = $1", [ctx.orgs.a.id]);
  },
};
SEEDS["0086_lead_scoring"] = async (db, ctx) => {
  await db.query("insert into lead_scoring_profiles (org_id, preset, criteria, ai_extraction_enabled) values ($1, 'real_estate', '{\"weights\":{\"budget\":10}}'::jsonb, true)", [ctx.orgs.a.id]);
  await db.query("insert into lead_scoring_profiles (org_id) values ($1)", [ctx.orgs.b.id]);
  await forOrgs(ctx, async (org, key, owner) => {
    for (let i = 1; i <= 3; i += 1) {
      const contact = await seedContact(db, org, `Seed-0086 hot lead ${i}`, { priority_score: 90 + i, priority_label: "hot", priority_source: "engine", priority_reason: "Seeded by the rehearsal" });
      await db.query("insert into lead_score_assessments (org_id, contact_id, seq, score, label, engine_version, profile_version, inputs_hash, facts_as_of) values ($1, $2, 1, $3, 'hot', 'v1', 1, 'abcdef0123456789abcd', now())", [org, contact, 90 + i]);
      if (i === 1) {
        await db.query("insert into lead_score_overrides (org_id, contact_id, label, reason, set_by) values ($1, $2, 'hot', 'Rehearsal override', $3)", [org, contact, owner]);
        await db.query("insert into lead_score_queue (contact_id, org_id, trigger) values ($1, $2, 'rehearsal')", [contact, org]);
      }
    }
    await db.query("insert into lead_score_usage (org_id, day, assessments) values ($1, current_date, 3)", [org]);
    await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'hot_lead_detected', 'Seed hot lead')", [org, owner]);
  });
};
CLEAN["0086_lead_scoring"] = {
  guard: async (db, ctx) => {
    await db.query("delete from notifications where kind = 'hot_lead_detected'");
    await db.query("delete from contacts where display_name like 'Seed-0086 %'");
    await db.query("delete from lead_score_queue");
    await db.query("delete from lead_score_usage");
    await db.query("delete from lead_scoring_profiles where org_id = $1", [ctx.orgs.a.id]);
  },
};
SEEDS["0087_website_chat"] = async (db, ctx) => {
  await db.query("insert into web_chat_widgets (org_id, public_key, enabled, allowed_origins) values ($1, 'wk_' || repeat('a', 24), true, '{www.example.test}')", [ctx.orgs.a.id]);
  await db.query("insert into web_chat_widgets (org_id, public_key) values ($1, 'wk_' || repeat('b', 24))", [ctx.orgs.b.id]);
  await forOrgs(ctx, async (org, key, owner) => {
    for (let i = 1; i <= 3; i += 1) {
      const contact = await seedContact(db, org, `Seed-0087 visitor ${i}`, { created_via: "website_chat" });
      const conv = (await one(db, "insert into conversations (org_id, contact_id, channel, status, owner_kind) values ($1, $2, 'web_chat', 'open', 'unassigned') returning id", [org, contact])).id;
      await db.query("insert into web_chat_sessions (org_id, token_hash, surface, origin_host, contact_id, conversation_id) values ($1, md5($2::text) || md5($2::text || 'x'), 'embed', 'www.example.test', $3, $4)", [org, `${key}${i}`, contact, conv]);
    }
    await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'web_chat_lead', 'Seed chat lead')", [org, owner]);
  });
};
CLEAN["0087_website_chat"] = {
  guard: async (db, ctx) => {
    await db.query("delete from notifications where kind = 'web_chat_lead'");
    await db.query("delete from web_chat_sessions");
    await db.query("delete from contacts where created_via = 'website_chat'");
    await db.query("delete from web_chat_widgets where org_id = $1", [ctx.orgs.a.id]);
  },
};
SEEDS["0088_lead_attribution"] = async (db, ctx) => {
  await forOrgs(ctx, async (org, key, owner) => {
    const contacts = await q(db, "select id from contacts where org_id = $1 order by id limit 5", [org]);
    for (let i = 0; i < contacts.length; i += 1) {
      await db.query("insert into lead_touches (org_id, contact_id, kind, source, medium, confidence, evidence, ref_type, ref_id) values ($1, $2, 'website_form', 'google', 'cpc', 'known', 'utm', 'form_submission', $3)", [org, contacts[i].id, `seed-0088-${key}-${i}`]);
    }
    await db.query("insert into attribution_costs (org_id, source, period_start, period_end, amount, currency, entered_by) values ($1, 'google', '2026-01-01', '2026-01-31', 250.50, 'USD', $2)", [org, owner]);
    await seedContact(db, org, "Seed-0088 pointer contact", { first_touch_id: 1, latest_touch_id: 1 });
  });
};
CLEAN["0088_lead_attribution"] = {
  guard: async (db) => {
    await db.query("delete from lead_touches");
    await db.query("delete from attribution_costs");
    await db.query("delete from contacts where display_name = 'Seed-0088 pointer contact'");
  },
};
const SOCIAL_KINDS = ["social_approval_requested", "social_approval_decided", "social_post_published", "social_post_failed", "social_account_attention"];
SEEDS["0089_social_media_manager"] = async (db, ctx) => {
  await db.query("insert into social_settings (org_id) values ($1)", [ctx.orgs.a.id]);
  await forOrgs(ctx, async (org, key, owner) => {
    const account = (await one(db, "insert into social_accounts (org_id, platform, adapter, external_id, name, credentials) values ($1, 'facebook', 'simulated', $2, 'Seed Page', 'encrypted-secret') returning id", [org, `page-${key}`])).id;
    await db.query("insert into social_oauth_states (org_id, user_id, platform, state_hash, expires_at, pending) values ($1, $2, 'facebook', md5($3::text) || md5($3::text || 'x'), now() + interval '10 minutes', 'encrypted-pages')", [org, owner, key]);
    await db.query("insert into social_campaigns (org_id, name, utm_campaign) values ($1, 'Spring', 'spring')", [org]);
    await db.query("insert into social_media_assets (org_id, source, external_ref, kind, filename, mime_type, size_bytes) values ($1, 'google_drive', 'drive-file-1', 'image', 'a.jpg', 'image/jpeg', 100)", [org]);
    await db.query("insert into social_ai_runs (org_id, kind, status) values ($1, 'ideas', 'succeeded')", [org]);
    const post = (await one(db, "insert into social_posts (org_id, account_id, kind, caption) values ($1, $2, 'text', 'Seed post') returning id", [org, account])).id;
    await db.query("insert into social_post_events (org_id, post_id, kind) values ($1, $2, 'created')", [org, post]);
    await db.query("insert into social_publish_jobs (org_id, post_id, account_id, post_version, idempotency_key) values ($1, $2, $3, 1, $4)", [org, post, account, `${post}:1:seed`]);
    await db.query("insert into social_post_metrics (org_id, post_id, metrics, source) values ($1, $2, '{\"likes\":1}'::jsonb, 'simulated')", [org, post]);
    await db.query("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'social-media', $2, 'm.jpg', 'image/jpeg', 100, 'ready')", [org, `${org}/social/m.jpg`]);
    await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'social_post_failed', 'Seed social failure')", [org, owner]);
  });
};
CLEAN["0089_social_media_manager"] = {
  guard: async (db) => {
    for (const t of ["social_post_metrics", "social_publish_jobs", "social_post_events", "social_posts", "social_ai_runs", "social_media_assets", "social_campaigns", "social_oauth_states", "social_accounts"]) await db.query(`delete from ${t}`);
    await db.query("delete from private_files where bucket = 'social-media'");
    await db.query("delete from notifications where kind = any($1::text[])", [SOCIAL_KINDS]);
    // The default settings row of workspace a stays: configuration, not history.
  },
};

// Tenant isolation across the whole populated database: through the application role, the owner of workspace A sees rows of workspace A only, the owner of B rows of
// B only, a signed-in stranger and a request with no user see none. Every public table with an org_id column that the role can read and that holds rows is swept.
async function isolationSweep(db, ctx) {
  const tables = (await q(db, `select c.relname from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attname = 'org_id' and not a.attisdropped
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity and has_column_privilege('iaq_app_user', c.oid, a.attnum, 'select') order by 1`)).map((r) => r.relname);
  const counts = await countAll(db, tables);
  const swept = tables.filter((t) => counts.get(t));
  const people = { ownerA: [ctx.users.ownerA, ctx.orgs.a.id], ownerB: [ctx.users.ownerB, ctx.orgs.b.id], stranger: [ctx.users.stranger, null], nobody: [null, null] };
  const problems = [];
  const positive = new Map();
  for (const [who, [id, own]] of Object.entries(people)) {
    const seen = await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [id ?? ""]);
      await tx.query("set local role iaq_app_user");
      const out = {};
      for (const t of swept) out[t] = (await tx.query(`select coalesce(array_agg(distinct org_id::text), '{}') as orgs, count(*)::int as n from public."${t}" where org_id is not null`)).rows[0];
      return out;
    });
    for (const t of swept) {
      const foreign = seen[t].orgs.filter((o) => o !== own);
      if (foreign.length) problems.push(`${t}: ${who} sees rows of ${foreign.length} other workspace(s)`);
      if (own && seen[t].n) positive.set(t, (positive.get(t) ?? 0) + 1);
    }
  }
  return { tables: tables.length, swept: swept.length, readable: positive.size, problems };
}

// --------------------------------------------------------------------------------------------------------------------------------------------
// The fresh chain (A): every file in order on an empty database, with the schema fingerprint after each step from 0077
// --------------------------------------------------------------------------------------------------------------------------------------------
let freshMemo = null;
async function freshChain() {
  if (freshMemo) return freshMemo;
  const db = await newDb();
  const timings = [];
  const errors = [];
  const fpBy = new Map();
  let applied = 0;
  for (const f of files) {
    const t = Date.now();
    try {
      await up(db, f);
      applied += 1;
    } catch (e) {
      errors.push(`${f}: ${clip(e.message, 300)}`);
      break;
    }
    timings.push([f, Date.now() - t]);
    if (numOf(f) === 76 || numOf(f) >= 77 || f === BASELINE[BASELINE.length - 1]) fpBy.set(name(f), await fingerprint(db));
  }
  const final = await fingerprint(db);
  const counts = await countAll(db, await listTables(db));
  const seeded = [...counts.entries()].filter(([, n]) => n > 0).map(([t]) => t);
  const ref = await referenceData(db, seeded);
  const ledger = (await q(db, "select version from schema_migrations order by version")).map((r) => r.version);
  const tableCount = (await listTables(db)).length;
  const nobuckets = (await q(db, "select id from storage.buckets order by id")).map((r) => r.id);
  const engine = (await one(db, "select split_part(version(), ',', 1) as v")).v;
  await db.close();
  freshMemo = { engine, fpBy, final, timings, errors, applied, seeded, ref, ledger, tableCount, buckets: nobuckets, baselineFp: fpBy.get(name(BASELINE[BASELINE.length - 1])) };
  return freshMemo;
}
// What the migrations themselves seed (reference data): a hash per table over the global rows (no workspace), leaving out uuid and timestamp columns that differ per run.
async function referenceData(db, tables) {
  const out = new Map();
  for (const t of tables) {
    const cols = await q(db, "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = $1", [t]);
    const volatile = cols.filter((c) => ["uuid", "timestamp with time zone", "timestamp without time zone"].includes(c.data_type)).map((c) => c.column_name);
    const scoped = cols.some((c) => c.column_name === "org_id") ? "where org_id is null" : "";
    const r = await one(db, `select count(*)::int as n, md5(coalesce(string_agg(r, '|' order by r), '')) as h from (select (to_jsonb(t) - $1::text[])::text as r from public."${t}" t ${scoped}) s`, [volatile]);
    out.set(t, `${r.n}:${r.h}`);
  }
  return out;
}

// ============================================================================================================================================
// A. Numbers, gaps, order, rollbacks, prerequisites
// ============================================================================================================================================
async function runA() {
  section("A", "Every migration applies in order; numbering, gaps, prerequisites and rollbacks");
  const t0 = Date.now();
  const present = new Set(files.map(numOf));
  const dupes = [...present].filter((n) => files.filter((f) => numOf(f) === n).length > 1);
  for (const n of dupes) fail("A", `number ${String(n).padStart(4, "0")} is used twice: ${files.filter((f) => numOf(f) === n).join(", ")}`);
  const strays = fs.readdirSync(MIGRATIONS).filter((f) => !FILE.test(f));
  for (const s of strays) fail("A", `supabase/migrations holds a file the runner would ignore: ${s}`);
  const head = numOf(HEAD);
  const gaps = [];
  for (let n = 1; n <= head; n += 1) if (!present.has(n)) gaps.push(n);
  const pad = (n) => String(n).padStart(4, "0");
  const refs = (git(["for-each-ref", "--format=%(refname:short)", "refs/heads", "refs/remotes"]) ?? "").split("\n").filter(Boolean);
  const trees = new Map(refs.map((ref) => [ref, (git(["ls-tree", "--name-only", ref, "supabase/migrations/"]) ?? "").split("\n").map((l) => path.basename(l)).filter((l) => FILE.test(l))]));
  const holdersOf = (n) => refs.filter((ref) => trees.get(ref).some((l) => l.startsWith(`${pad(n)}_`)));
  const explained = [];
  for (const n of gaps) {
    const history = (git(["log", "--all", "--diff-filter=A", "--name-only", "--format=", "--", `supabase/migrations/${pad(n)}_*`]) ?? "").split("\n").map((l) => path.basename(l.trim())).filter((l) => FILE.test(l));
    const names = [...new Set(history)];
    const holders = holdersOf(n);
    let why;
    if (holders.length) {
      const f = trees.get(holders[0]).find((l) => l.startsWith(`${pad(n)}_`));
      why = `reserved: ${f} exists on ${holders.slice(0, 4).join(", ")}${holders.length > 4 ? ` and ${holders.length - 4} more` : ""}`;
    } else if (names.length) {
      const moved = names.map((nm) => {
        const stem = nm.slice(nm.indexOf("_"));
        const now = files.find((f) => f.endsWith(stem));
        return now ? `${nm} was renumbered to ${now}` : `${nm} no longer exists`;
      });
      why = `renumbered before release: ${moved.join("; ")}`;
    } else {
      why = "never used by any commit on any ref";
    }
    explained.push(`${pad(n)}: ${why}`);
  }
  finding("A", `${files.length} migration files, numbers 0001..${pad(head)}, every number used once (${dupes.length} duplicates, ${strays.length} stray files); ${gaps.length} gaps: ${gaps.map(pad).join(", ")}`);
  for (const e of explained) finding("A", `   gap ${e}`);
  const unexplainedOther = gaps.filter((n) => n !== 84);
  if (unexplainedOther.length) note("A", `gaps other than the reserved 0084: ${unexplainedOther.map(pad).join(", ")} (see above). They are harmless to the runner: it sorts by file name, tracks each version by name, and the ledger of 75 rows at 0080 (docs/unified-inbox/release-verification.md) equals the number of files up to 0080 (${files.filter((f) => numOf(f) <= 80).length}), so no gap hides an applied version.`);
  if (!gaps.includes(84)) note("A", "0084 is not a gap in this checkout (it was added here)");

  // Rollbacks: one for every migration from 0077, none orphaned, none numbered twice.
  const rollbacks = fs.readdirSync(ROLLBACKS).filter((f) => ROLLBACK_FILE.test(f));
  const rbStem = new Set(rollbacks.map((f) => f.replace(/\.down\.sql$/, "")));
  const missing = HISTORY.filter((f) => !rbStem.has(name(f)));
  for (const f of missing) fail("A", `${name(f)} has no rollback in supabase/rollbacks`);
  const orphan = rollbacks.filter((f) => numOf(f) >= 77 && !files.includes(f.replace(/\.down\.sql$/, ".sql")));
  for (const f of orphan) fail("A", `rollback ${f} has no migration of that name`);
  const rbDupes = [...new Set(rollbacks.map(numOf))].filter((n) => rollbacks.filter((f) => numOf(f) === n).length > 1);
  for (const n of rbDupes) fail("A", `rollback number ${pad(n)} is used twice`);
  const olderMissing = files.filter((f) => numOf(f) < 77 && !rbStem.has(name(f))).map((f) => prefix(f));
  finding("A", `rollbacks: ${HISTORY.length - missing.length} of ${HISTORY.length} migrations from 0077 have one${missing.length ? ` (missing: ${missing.map(name).join(", ")})` : " (none missing)"}; ${orphan.length} orphans; ${olderMissing.length} older migrations below 0077 have none (${olderMissing.join(", ")}) and are outside this rehearsal`);

  // The order, on an empty database.
  const fresh = await freshChain();
  if (fresh.errors.length) for (const e of fresh.errors) fail("A", `a migration failed on an empty database: ${e}`);
  const slow = [...fresh.timings].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([f, ms]) => `${prefix(f)} ${ms} ms`).join(", ");
  finding("A", `engine: ${fresh.engine} (embedded PGlite; production is reported as PostgreSQL 17.11)`);
  finding("A", `applied ${fresh.applied} of ${files.length} files in order on an empty database, each with its ledger row in one transaction, no error; ledger ${fresh.ledger.length} rows, last ${fresh.ledger[fresh.ledger.length - 1]}; ${fresh.tableCount} public tables; slowest: ${slow}`);
  if (fresh.ledger.length !== files.length) fail("A", `the ledger has ${fresh.ledger.length} rows for ${files.length} files`);
  // The documented ledger sizes of production at the milestones.
  for (const [upto, rows, label] of [[80, 75, "0080 (release-verification.md: ledger through 0080, 75 rows)"], [83, 78, "0083 (rollout-plan.md: 78 rows)"], [86, 80, "0086 (phase2/05-release-readiness.md: ledger now 80 rows)"]]) {
    const got = files.filter((f) => numOf(f) <= upto).length;
    if (got !== rows) fail("A", `files up to ${label} should number ${rows}, found ${got}`);
  }
  finding("A", `the files up to 0080, 0083 and 0086 number 75, 78 and 80: exactly the ledger sizes the release docs record for production at those points`);

  // The prerequisites the runner enforces: parsed from the source, and checked against the order actually applied.
  const src = fs.readFileSync(path.join(root, "src", "server", "db", "index.ts"), "utf8");
  const block = src.slice(src.indexOf("export const MIGRATION_PREREQUISITES"), src.indexOf("};", src.indexOf("export const MIGRATION_PREREQUISITES")));
  const prereq = {};
  for (const m of block.matchAll(/"(\d{4}_[a-z0-9_]+)":\s*\[([^\]]*)\]/g)) prereq[m[1]] = [...m[2].matchAll(/"(\d{4}_[a-z0-9_]+)"/g)].map((x) => x[1]);
  const order = files.map(name);
  for (const [v, reqs] of Object.entries(prereq)) {
    if (!order.includes(v)) fail("A", `MIGRATION_PREREQUISITES names ${v}, which has no file`);
    for (const r of reqs) {
      if (!order.includes(r)) fail("A", `${v} requires ${r}, which has no file`);
      else if (order.indexOf(r) > order.indexOf(v)) fail("A", `${v} requires ${r}, which is applied after it`);
    }
  }
  const rewriters = files.filter((f) => numOf(f) > 65 && fs.readFileSync(path.join(MIGRATIONS, f), "utf8").includes("notifications_kind_check"));
  for (const f of rewriters) if (!(prereq[name(f)] ?? []).includes("0065_support_requests")) fail("A", `${name(f)} rewrites notifications_kind_check but does not require 0065_support_requests`);
  const dependsOnFilePermission = files.filter((f) => numOf(f) > 49 && fs.readFileSync(path.join(MIGRATIONS, f), "utf8").includes("app.file_permission"));
  for (const f of dependsOnFilePermission) if (!(prereq[name(f)] ?? []).includes("0049_aqi_attachments")) fail("A", `${name(f)} replaces app.file_permission but does not require 0049_aqi_attachments`);
  finding("A", `${Object.keys(prereq).length} declared prerequisites parsed from src/server/db/index.ts all name existing files that come earlier; the ${rewriters.length} migrations after 0065 that extend notifications_kind_check (${rewriters.map(prefix).join(", ")}) all require 0065, and the ${dependsOnFilePermission.length} that replace app.file_permission (${dependsOnFilePermission.map(prefix).join(", ")}) require 0049`);

  // The reserved 0084 and the copy of 0077..0083 that travels with it.
  const other = ["codex/client-ai-onboarding", "codex/hermes-gha-acceptance"];
  const compare = [];
  for (const ref of other) {
    const listing = git(["ls-tree", "--name-only", ref, "supabase/migrations/"]);
    if (!listing) continue;
    const names = listing.split("\n").map((l) => path.basename(l)).filter((l) => FILE.test(l) && numOf(l) >= 77);
    let identical = 0;
    const differing = [];
    for (const nm of names) {
      if (nm.startsWith("0084_")) continue;
      const theirs = (git(["rev-parse", `${ref}:supabase/migrations/${nm}`]) ?? "").trim();
      const mine = fs.existsSync(path.join(MIGRATIONS, nm)) ? (git(["hash-object", path.join(MIGRATIONS, nm)]) ?? "").trim() : "";
      if (theirs && theirs === mine) identical += 1;
      else differing.push(mine ? `${nm} (different content)` : `${nm} (absent here)`);
    }
    compare.push(`${ref}: ${identical} of ${names.filter((n) => !n.startsWith("0084_")).length} migrations from 0077 identical to this checkout${differing.length ? `; differ: ${differing.join(", ")}` : ""}`);
    if (differing.length) note("A", `${ref} carries ${differing.join(", ")} that differ from this checkout: merge that branch with this tree's version of those files, and re-run this rehearsal after the merge.`);
  }
  for (const c of compare) finding("A", c);
  result.sections.A.ms = Date.now() - t0;
}

// ============================================================================================================================================
// B, C, D on one populated database
// ============================================================================================================================================
const state = { popDb: null, ctx: null };
async function runBCD() {
  section("B", "Upgrade from the production baseline, one migration at a time, on a populated database");
  section("C", "Schema after every step and at the end equals the fresh chain");
  section("D", "Rollbacks newest first on the populated database, then forward again");
  const fresh = await freshChain();
  const tB = Date.now();
  const db = await newDb();
  state.popDb = db;
  for (const f of BASELINE) await up(db, f);
  const ctx = await seedBaseline(db, scale);
  state.ctx = ctx;
  let cur = await capture(db, ctx);
  cur.truth = await filePermissionTruth(db, ctx);
  const baseline = cur;
  if (!same(diff(fresh.baselineFp, baseline.fp))) fail("B", `the baseline (everything below 0077) differs from the fresh chain at the same point: ${showDiff(diff(fresh.baselineFp, baseline.fp))}`);
  const populated = [...baseline.snap.values()].filter((s) => s.n > 0);
  finding("B", `baseline = the ${BASELINE.length} migrations below 0077 (ledger ${baseline.ledger.length} rows); dataset: ${rowsIn(baseline.snap)} rows in ${populated.length} tables (${ctx.sizes.contacts * 3} contacts, ${ctx.sizes.conversations * 3} conversations, ${ctx.sizes.conversations * 9} messages, calls, appointments, 12 AI employees with provisioning jobs, ${baseline.kinds.length} notification kinds with one notice each, ${OLD_BUCKETS.length} buckets of private files, tasks, leads, chat), 4 workspaces and ${Object.keys(ctx.users).length} people; scale ${scale}`);
  const steps = new Map(); // version -> { before, after, ms }
  let broke = false;
  for (const file of HISTORY) {
    const v = name(file);
    const before = cur;
    if (prefix(file) === "0082") {
      // The documented precondition: two open requests for one employee. 0082 must fail whole, and leave nothing behind.
      const res = await throwaway(db, async (tx) => {
        const emp = (await tx.query("select agent_instance_id, org_id from agent_provisioning_jobs where status in ('requested', 'in_progress', 'awaiting_health_check') limit 1")).rows[0];
        await tx.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, detail) values ($1, $2, 'provision', 'requested', 'duplicate open request')", [emp.org_id, emp.agent_instance_id]);
        return attempt(tx, `${fs.readFileSync(path.join(MIGRATIONS, file), "utf8")}\ninsert into schema_migrations (version) values ('${v}');`);
      });
      if (res.ok) fail("B", `${v} applied although one employee had two open provisioning requests (it must refuse)`);
      else if (!/agent_provisioning_one_open_per_employee/.test(res.message)) fail("B", `${v} failed on duplicate open requests for another reason: ${clip(res.message, 200)}`);
      else finding("B", `${v}: with two open provisioning requests for one employee it fails whole ("${clip(res.message, 110)}") and, rolled back, leaves nothing behind`);
      if (!same(diff(before.fp, await fingerprint(db)))) fail("B", `${v}: the refused attempt left schema changes behind`);
    }
    const leakBefore = prefix(file) === "0081" ? await eventLeak(db, ctx) : null;
    const t = Date.now();
    try {
      await up(db, file);
    } catch (e) {
      fail("B", `${v} failed on the populated database: ${clip(e.message, 400)}`);
      broke = true;
      break;
    }
    const ms = Date.now() - t;
    const after = await capture(db, ctx, { skipProbe: true });
    after.probe = await probe(db, ctx, before.probeTables.filter((x) => after.tables.has(x)));
    // 1. Every earlier row, in every table, unchanged.
    const growable = insertTargets(file);
    const changed = await verifyWhole(db, before.snap, growable);
    for (const c of changed) fail("B", `${v}: ${c}`);
    const grew = [...changed.grew.entries()].map(([t, n]) => `+${n} rows in ${t} (inserted by the migration itself, every earlier row intact)`);
    // 2. Nothing earlier was lost from the shared lists.
    const lostKinds = subsetOf(before.kinds, after.kinds);
    if (lostKinds.length) fail("B", `${v}: notification kinds lost: ${lostKinds.join(", ")}`);
    const lostPerms = [...before.perms].filter((p) => !after.perms.has(p));
    if (lostPerms.length) fail("B", `${v}: role permissions lost: ${lostPerms.slice(0, 6).join(", ")}${lostPerms.length > 6 ? ` and ${lostPerms.length - 6} more` : ""}`);
    const lostBuckets = subsetOf(before.buckets, after.buckets);
    if (lostBuckets.length) fail("B", `${v}: storage buckets lost: ${lostBuckets.join(", ")}`);
    for (const [label, a, b] of [["private_files bucket list", before.bucketCheck, after.bucketCheck], ["conversation channels", before.channels, after.channels], ["contact origins", before.vias, after.vias]]) {
      const lost = subsetOf(a, b);
      if (lost.length) fail("B", `${v}: ${label} lost: ${lost.join(", ")}`);
    }
    // 3. The application role sees the same rows (a changed policy must not change who sees what).
    for (const d of probeDiff(before.probe, after.probe, growable)) fail("B", `${v}: ${d}`);
    // 4. A replaced app.file_permission answers the same for every person and every earlier bucket.
    let fileAnswers = "";
    if (before.fnHash !== after.fnHash) {
      const truthBefore = before.truth ?? null;
      const truthAfter = await filePermissionTruth(db, ctx);
      if (truthBefore) {
        const moved = Object.keys(truthBefore).filter((k) => truthBefore[k] !== truthAfter[k]);
        if (moved.length) fail("B", `${v}: app.file_permission answers differently for earlier buckets: ${moved.slice(0, 6).join(", ")}`);
        fileAnswers = `; app.file_permission was replaced and gives the same ${Object.keys(truthBefore).length} answers (7 people x 7 earlier buckets x read/write)`;
      }
      after.truth = truthAfter;
    } else {
      after.truth = before.truth ?? (await filePermissionTruth(db, ctx));
    }
    // 5. New tables.
    const objects = await checkNewObjects(db, "B", v, before, after);
    if (leakBefore !== null) {
      const leakAfter = await eventLeak(db, ctx);
      if (leakAfter !== 0) fail("B", `${v}: after the migration the owner of workspace B still sees ${leakAfter} event row(s) that belong to a job of workspace A`);
      finding("B", `${v}: tenant isolation of ai_work_events: a row that names workspace B but belongs to a job of workspace A was visible to B's owner ${leakBefore} time(s) before the migration and ${leakAfter} after. (The policy of 0077 to 0080 compared j.org_id with itself; the job lookup inside it is itself filtered by ai_work_jobs_select, so the self-comparison alone opened no path for a member of one workspace. 0081 makes the match explicit instead of relying on that.)`);
      if (leakBefore) note("B", `0077 to 0080 shipped ai_work_events_select with "j.org_id = org_id", which Postgres reads as j.org_id = j.org_id (always true): a cross-workspace event row WAS readable (${leakBefore} row). Writes are server-only, so this needs a server bug to matter, and 0081 (applied to production on 2026-10-22) closes it.`);
    }
    if (prefix(file) === "0082") {
      const dup = await throwaway(db, async (tx) => {
        const emp = (await tx.query("select agent_instance_id, org_id from agent_provisioning_jobs where status = 'requested' limit 1")).rows[0];
        return attempt(tx, "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, detail) values ($1, $2, 'provision', 'in_progress', 'second open request')", [emp.org_id, emp.agent_instance_id]);
      });
      const closed = await throwaway(db, async (tx) => {
        const emp = (await tx.query("select agent_instance_id, org_id from agent_provisioning_jobs where status = 'requested' limit 1")).rows[0];
        return attempt(tx, "insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, detail) values ($1, $2, 'reconnect', 'failed', 'a closed request')", [emp.org_id, emp.agent_instance_id]);
      });
      if (dup.ok || !/agent_provisioning_one_open_per_employee/.test(dup.message)) fail("B", `${v}: a second open provisioning request for one employee was not refused by agent_provisioning_one_open_per_employee (${dup.ok ? "accepted" : clip(dup.message, 120)})`);
      if (!closed.ok) fail("B", `${v}: a finished request for an employee that has an open one was refused: ${clip(closed.message, 160)}`);
      if (!dup.ok && closed.ok) finding("B", `${v}: a second OPEN request for one employee is refused by the unique index, a finished one is still accepted`);
    }
    // 6. The ledger.
    if (after.ledger.length !== before.ledger.length + 1 || after.ledger[after.ledger.length - 1] !== v) fail("B", `${v}: the ledger is ${after.ledger.length} rows ending ${after.ledger[after.ledger.length - 1]}`);
    // 7. The schema equals the fresh chain at the same point.
    const d = diff(fresh.fpBy.get(v), after.fp);
    const sameAsFresh = same(d);
    steps.set(v, { before, after, ms, sameAsFresh, diffText: sameAsFresh ? "" : showDiff(d) });
    const addedKinds = subsetOf(after.kinds, before.kinds);
    finding("B", `${v}: applied in ${ms} ms; ${before.snap.size} tables / ${rowsIn(before.snap)} earlier rows unchanged; ${objects.fresh.length} new table${objects.fresh.length === 1 ? "" : "s"}${objects.fresh.length ? ` (${objects.fresh.join(", ")}) with row-level security, empty, no grant to anon / authenticated / PUBLIC / the site role, select-only for the application role${objects.columnLevel.length ? `; column level: ${objects.columnLevel.join("; ")}` : ""}${objects.serverOnly.length ? `; no access at all for the application role (server only): ${objects.serverOnly.join(", ")}` : ""}${objects.fnInfo.length ? `; new functions: ${objects.fnInfo.join("; ")}` : ""}` : ""}${addedKinds.length ? `; +${addedKinds.length} notification kind${addedKinds.length === 1 ? "" : "s"}` : ""}${after.buckets.length !== before.buckets.length ? `; +${after.buckets.length - before.buckets.length} storage bucket` : ""}${after.perms.size !== before.perms.size ? `; +${after.perms.size - before.perms.size} role permissions` : ""}; the application role sees the same rows${fileAnswers}${grew.length ? `; ${grew.join("; ")}` : ""}`);
    // 8. This migration's own data.
    if (SEEDS[v]) {
      try {
        await SEEDS[v](db, ctx);
      } catch (e) {
        fail("B", `${v}: its own data could not be written after the migration: ${clip(e.message, 300)}`);
      }
    }
    cur = await capture(db, ctx);
    cur.truth = after.truth;
  }
  result.sections.B.ms = Date.now() - tB;
  finding("B", `end of path B: ledger ${cur.ledger.length} rows, last ${cur.ledger[cur.ledger.length - 1]}; ${rowsIn(cur.snap)} rows in ${[...cur.snap.values()].filter((s) => s.n > 0).length} tables`);
  if (broke) {
    fail("C", "path B stopped at a failed migration, so the final schema cannot be compared");
    fail("D", "path B stopped at a failed migration, so the rollbacks cannot be rehearsed");
    return;
  }

  // ----- C -----
  const tC = Date.now();
  let compared = 0;
  for (const [v, s] of steps) {
    compared += fresh.fpBy.get(v).size;
    if (!s.sameAsFresh) fail("C", `after ${v} the upgraded schema differs from the fresh chain: ${s.diffText}`);
  }
  const dEnd = diff(fresh.final, cur.fp);
  if (!same(dEnd)) fail("C", `the final schema of path B differs from the fresh chain: ${showDiff(dEnd, 1500)}`);
  else finding("C", `the final schema of path B equals the fresh chain: ${fresh.final.size} facts (columns, constraints, indexes, policies, triggers, function bodies, table / column / function / schema grants, default privileges, roles, role permissions, comments, sequences, extensions); the schema after each of the ${steps.size} steps from ${name(HISTORY[0])} to ${name(HISTORY[HISTORY.length - 1])} equals the fresh chain at the same point (${compared} facts compared in total)`);
  const kindsFacts = {};
  for (const x of cur.fp) kindsFacts[x.slice(0, x.indexOf("|"))] = (kindsFacts[x.slice(0, x.indexOf("|"))] ?? 0) + 1;
  finding("C", `facts by kind: ${Object.entries(kindsFacts).map(([k, n]) => `${k} ${n}`).join(", ")}`);
  const refB = await referenceData(db, fresh.seeded);
  const refBad = fresh.seeded.filter((t) => fresh.ref.get(t) !== refB.get(t));
  for (const t of refBad) fail("C", `reference data of ${t} differs between the upgraded and the fresh database (fresh ${fresh.ref.get(t)}, upgraded ${refB.get(t)})`);
  if (!refBad.length) finding("C", `the data the migrations seed themselves (${fresh.seeded.length} tables: ${fresh.seeded.join(", ")}) is identical on both paths (global rows, hashed without uuid and timestamp columns)`);
  const bucketsFresh = fresh.buckets.join(",");
  if (bucketsFresh !== cur.buckets.join(",")) fail("C", `storage buckets differ: fresh ${bucketsFresh}; upgraded ${cur.buckets.join(",")}`);
  else finding("C", `storage buckets are the same on both paths: ${cur.buckets.join(", ")}`);
  const iso = await isolationSweep(db, ctx);
  for (const p of iso.problems) fail("C", `tenant isolation: ${p}`);
  if (!iso.problems.length) finding("C", `tenant isolation across the populated head: ${iso.swept} tables with an org_id column, readable by the application role and holding rows, were read as the owner of workspace A, the owner of B, a signed-in stranger and a request with no user: no one saw a row of another workspace, a stranger and an anonymous request saw none, and both owners read their own rows in ${iso.readable} of the tables (the rest are visible only to staff or to the person concerned)`);
  result.sections.C.ms = Date.now() - tC;

  // ----- D1: every rollback tried on the full database, in a transaction that is always rolled back -----
  const tD = Date.now();
  const top = cur;
  // 0081 only alters two policies and 0082 adds columns and an index: neither has a data guard. A newer migration without seed data here has nothing to refuse for.
  const REFUSES = new Map(HISTORY.map((f) => [name(f), !["0081", "0082"].includes(prefix(f)) && Boolean(SEEDS[name(f)])]));
  const refusedNames = [];
  for (const file of HISTORY) {
    const v = name(file);
    if (!fs.existsSync(rollbackPath(file))) {
      fail("D", `${v} has no rollback`);
      continue;
    }
    const sql = rollbackSql(file);
    const res = await throwaway(db, (tx) => attempt(tx, sql));
    const refused = !res.ok && /Rollback refused/.test(res.message);
    if (!res.ok && !refused) fail("D", `${v}: the rollback failed for another reason on the full database: ${clip(res.message, 300)}`);
    else if (REFUSES.get(v) && !refused) fail("D", `${v}: the rollback ran on a database that holds the feature's data (it must refuse)`);
    else if (refused) {
      refusedNames.push(prefix(file));
      finding("D", `${v}: refused on the full database ("${clip(res.message.replace(/^.*Rollback refused:\s*/, ""), 120)}")`);
    } else {
      finding("D", `${v}: no data guard, so it ran (in the throwaway transaction); it carries none by design`);
    }
  }
  const afterRefusals = await fingerprint(db);
  const dRef = diff(top.fp, afterRefusals);
  if (!same(dRef)) fail("D", `the schema changed during the throwaway rollback attempts: ${showDiff(dRef)}`);
  const movedRows = await verifyWhole(db, top.snap);
  for (const m of movedRows) fail("D", `data changed during the throwaway rollback attempts: ${m}`);
  finding("D", `the throwaway attempts changed nothing: schema (${afterRefusals.size} facts) and all ${rowsIn(top.snap)} rows unchanged; refused: ${refusedNames.join(", ")}`);

  // ----- D2: newest first, the guarded data removed, the rollback run, the schema compared with the one recorded before the migration -----
  const noteRisk = [];
  const EVENTS_POLICY = "policy|public.ai_work_events:ai_work_events_select:";
  let carried = null;
  const order = [...HISTORY].reverse();
  for (const file of order) {
    const v = name(file);
    const st = steps.get(v);
    if (!st) continue;
    const clean = CLEAN[v] ?? {};
    let restore = null;
    if (clean.guard) {
      const r = await clean.guard(db, ctx);
      if (r?.restore) restore = r.restore;
    }
    // Columns this rollback will drop that hold data other than their default, and tables it will drop that still hold rows.
    const dropCols = [...st.after.fp].filter((x) => x.startsWith("column|") && !st.before.fp.has(x)).map((x) => x.slice("column|".length));
    const atRisk = [];
    for (const c of dropCols) {
      const m = /^public\.([a-z0-9_]+)\.([a-z0-9_]+):/.exec(c);
      if (!m || !st.before.tables.has(m[1])) continue;
      const rows = (await one(db, `select count(*)::int as n from public."${m[1]}" where "${m[2]}" is not null and to_jsonb("${m[1]}") ->> '${m[2]}' not in ('0', 'false', '{}', '[]')`)).n;
      if (rows) atRisk.push([m[1], m[2], rows]);
    }
    const droppedTables = [...st.after.tables].filter((t) => !st.before.tables.has(t));
    const dropRows = [];
    for (const t of droppedTables) {
      const n = (await one(db, `select count(*)::int as n from public."${t}"`)).n;
      if (n) dropRows.push(`${t} (${n} row${n === 1 ? "" : "s"})`);
    }
    const t = Date.now();
    let ran = false;
    try {
      await down(db, file);
      ran = true;
    } catch (e) {
      fail("D", `${v}: the rollback could not run after the guarded data was removed: ${clip(e.message, 300)}`);
    }
    if (ran) {
      await forget(db, file);
      if (restore) await restore();
      if (clean.rest) await clean.rest(db, ctx);
      const nowFp = await fingerprint(db);
      let dd = diff(st.before.fp, nowFp);
      let tolerated = false;
      // The one DOCUMENTED difference: the rollback of 0081 puts back 0080's row-wise permission checks but, as its header says, keeps the explicit event / job
      // tenant match (it does not bring back "j.org_id = org_id", which Postgres reads as j.org_id = j.org_id). Accepted only in exactly that form, and carried
      // down to 0077, whose rollback drops the policy.
      const pair = dd.onlyBefore.length === 1 && dd.onlyAfter.length === 1 && dd.onlyBefore[0].startsWith(EVENTS_POLICY) && dd.onlyAfter[0].startsWith(EVENTS_POLICY)
        && dd.onlyBefore[0].includes("j.org_id = j.org_id") && dd.onlyAfter[0].includes("j.org_id = ai_work_events.org_id") ? [dd.onlyBefore[0], dd.onlyAfter[0]] : null;
      if (pair && (!carried || (carried[0] === pair[0] && carried[1] === pair[1])) && ["0081", "0080", "0079", "0078"].includes(prefix(file))) {
        carried = pair;
        tolerated = true;
        dd = { onlyBefore: [], onlyAfter: [] };
        if (prefix(file) === "0081") note("D", "0081_ai_work_job_rls_hardening: the rollback is not an exact inverse, by design (its header: it keeps the explicit event / job tenant match). The only difference from the schema before 0081 is the text of the policy ai_work_events_select: it compares j.org_id with ai_work_events.org_id instead of the original j.org_id = j.org_id. Every other fact of the 0081 rollback, including ai_work_jobs_select and the row-wise permission calls, is exactly as before.");
      }
      const nowKinds = await kindsNow(db);
      const nowBuckets = (await q(db, "select id from storage.buckets order by id")).map((r) => r.id);
      const nowPerms = new Set((await q(db, "select role || ':' || permission as p from role_permissions")).map((r) => r.p));
      const problems = [];
      if (!same(dd)) problems.push(`the schema is not what it was before the migration: ${showDiff(dd, 1100)}`);
      if (JSON.stringify(nowKinds) !== JSON.stringify(st.before.kinds)) problems.push("the notification kinds differ from before the migration");
      if (nowBuckets.join(",") !== st.before.buckets.join(",")) problems.push(`the storage buckets differ from before the migration (${nowBuckets.join(",")} vs ${st.before.buckets.join(",")})`);
      if ([...st.before.perms].some((p) => !nowPerms.has(p)) || [...nowPerms].some((p) => !st.before.perms.has(p))) problems.push("the role permissions differ from before the migration");
      const moved = await verifyWhole(db, st.before.snap);
      for (const m of moved) problems.push(`data: ${m}`);
      if (SEEDS[v] && !CLEAN[v]) problems.push("(its data is seeded here but no cleaning rule is known for it)");
      for (const p of problems) fail("D", `${v}: ${p}`);
      if (!problems.length) finding("D", `${v}: rolled back in ${Date.now() - t} ms to exactly the schema recorded before it${tolerated ? " except the one documented policy text (see the note)" : ""} (${nowFp.size} facts), and all ${rowsIn(st.before.snap)} earlier rows are unchanged${dropRows.length ? `; unused configuration dropped with its tables: ${dropRows.join(", ")}` : ""}`);
      if (atRisk.length) {
        const byTable = new Map();
        for (const [tb, col, rows] of atRisk) byTable.set(tb, [...(byTable.get(tb) ?? []), `${col} (${rows})`]);
        noteRisk.push(`${v}: the rollback ran without refusing although these columns it drops held data other than their default: ${[...byTable.entries()].map(([tb, cols]) => `${tb}: ${cols.join(", ")}`).join("; ")}. The guard protects the history tables only, so the new columns of existing tables go silently; export them first if they matter.`);
      }
    }
  }
  for (const n of noteRisk) note("D", n);
  const baseDiff = diff(baseline.fp, await fingerprint(db));
  if (!same(baseDiff)) fail("D", `after the last rollback the schema is not the baseline: ${showDiff(baseDiff)}`);
  const baseMoved = await verifyKeys(db, baseline.snap);
  for (const m of baseMoved) fail("D", `after the last rollback an original row changed: ${m}`);
  const ledgerNow = (await q(db, "select version from schema_migrations order by version")).map((r) => r.version);
  if (JSON.stringify(ledgerNow) !== JSON.stringify(baseline.ledger)) fail("D", `the ledger after all rollbacks is ${ledgerNow.length} rows, expected the baseline's ${baseline.ledger.length}`);
  if (!baseDiff.onlyBefore.length && !baseDiff.onlyAfter.length && !baseMoved.length) finding("D", `after all ${order.length} rollbacks: the baseline schema (${baseline.fp.size} facts), every one of the ${rowsIn(baseline.snap)} original rows and the ledger of ${ledgerNow.length} rows are exactly what they were before 0077`);

  // ----- D3: forward again, one at a time, compared with the fresh chain; the features take data again -----
  let forwardOk = true;
  for (const file of HISTORY) {
    const v = name(file);
    try {
      await up(db, file);
    } catch (e) {
      fail("D", `${v} could not be applied again after the rollbacks: ${clip(e.message, 300)}`);
      forwardOk = false;
      break;
    }
    const dd = diff(fresh.fpBy.get(v), await fingerprint(db));
    if (!same(dd)) {
      fail("D", `after the rollbacks, applying ${v} again gives a different schema from the fresh chain: ${showDiff(dd)}`);
      forwardOk = false;
    }
    if (SEEDS[v]) {
      try {
        await SEEDS[v](db, ctx);
      } catch (e) {
        fail("D", `${v}: its data could not be written after rolling back and applying again: ${clip(e.message, 300)}`);
        forwardOk = false;
      }
    }
  }
  const finalAgain = diff(fresh.final, await fingerprint(db));
  if (!same(finalAgain)) fail("D", `after rolling everything back and forward the schema differs from C: ${showDiff(finalAgain)}`);
  const againMoved = await verifyKeys(db, baseline.snap);
  for (const m of againMoved) fail("D", `after rolling back and forward again an original row changed: ${m}`);
  if (forwardOk && same(finalAgain) && !againMoved.length) finding("D", `applied forward again one at a time: after every step the schema equals the fresh chain, the final schema equals C (${fresh.final.size} facts), the original rows are unchanged, and each feature accepted its data again (triggers, constraints and policies are alive)`);
  const missingRb = HISTORY.filter((f) => !fs.existsSync(rollbackPath(f))).map(name);
  finding("D", `rollbacks present for ${HISTORY.length - missingRb.length} of ${HISTORY.length} migrations from 0077${missingRb.length ? `; MISSING: ${missingRb.join(", ")}` : ""}`);
  result.sections.D.ms = Date.now() - tD;
}

// ============================================================================================================================================
// E. The reserved 0084 before, between and after
// ============================================================================================================================================
async function runE() {
  section("E", "The reserved 0084 before, between and after: the same final schema");
  const t0 = Date.now();
  const fresh = await freshChain();
  const candidates = [];
  for (const ref of ["codex/client-ai-onboarding", "codex/hermes-gha-acceptance"]) {
    const listing = git(["ls-tree", "--name-only", ref, "supabase/migrations/"]);
    const file = listing?.split("\n").map((l) => path.basename(l)).find((l) => l.startsWith("0084_"));
    if (!file) continue;
    const sql = git(["show", `${ref}:supabase/migrations/${file}`]);
    if (sql) candidates.push({ ref, file, sql, blob: (git(["rev-parse", `${ref}:supabase/migrations/${file}`]) ?? "").trim() });
  }
  if (!candidates.length) {
    fail("E", "0084 was not found on codex/client-ai-onboarding or codex/hermes-gha-acceptance, so the order against it cannot be rehearsed");
    return;
  }
  const s84 = candidates[0];
  finding("E", `0084 = ${s84.file} (blob ${s84.blob.slice(0, 10)}) read with git show from ${candidates.map((c) => c.ref).join(" and ")}${new Set(candidates.map((c) => c.blob)).size === 1 ? " (the same blob on both)" : ""}`);
  if (new Set(candidates.map((c) => c.blob)).size > 1) fail("E", "0084 differs between codex/client-ai-onboarding and codex/hermes-gha-acceptance");
  const afterVersions = HISTORY.map(name);
  const positions = [
    ["before 0077 (right after 0072)", null],
    ["between 0080 and 0081", afterVersions.find((v) => v.startsWith("0080"))],
    ["between 0083 and 0085", afterVersions.find((v) => v.startsWith("0083"))],
    ["between 0086 and 0087", afterVersions.find((v) => v.startsWith("0086"))],
    ["after the head", afterVersions[afterVersions.length - 1]],
  ];
  const build = async (anchor) => {
    const db = await newDb();
    const insert = () => upSql(db, s84.sql, name(s84.file));
    for (const f of BASELINE) await up(db, f);
    if (anchor === null) await insert();
    for (const f of HISTORY) {
      await up(db, f);
      if (name(f) === anchor) await insert();
    }
    return db;
  };
  let reference = null;
  let compared = 0;
  for (const [label, anchor] of positions) {
    let db;
    try {
      db = await build(anchor);
    } catch (e) {
      fail("E", `0084 ${label}: the chain could not be applied: ${clip(e.message, 300)}`);
      continue;
    }
    const fp = await fingerprint(db);
    await db.close();
    if (!reference) {
      reference = fp;
      finding("E", `reference = 0084 ${label}: ${fp.size} facts`);
      continue;
    }
    const d = diff(reference, fp);
    if (!same(d)) fail("E", `0084 ${label}: the final schema differs from 0084 ${positions[0][0]}: ${showDiff(d)}`);
    else compared += 1;
  }
  if (compared === positions.length - 1) finding("E", `0084 ${positions.slice(1).map((p) => p[0]).join("; ")}: the final schema is identical to the reference in all ${compared} orders`);
  if (reference) {
    const d = diff(fresh.final, reference);
    const short = (x) => clip(x.slice(x.indexOf("|") + 1), 110);
    finding("E", `0084 is not a no-op: it adds ${d.onlyAfter.length} schema facts and removes ${d.onlyBefore.length}; for example: ${[...d.onlyAfter.slice(0, 4).map((x) => `+ ${short(x)}`), ...d.onlyBefore.slice(0, 1).map((x) => `- ${short(x)}`)].join(" | ")}`);
    if (!d.onlyAfter.length) fail("E", "applying 0084 changed nothing, so the order test proves nothing");
    // And on the populated head of path D: 0084 applied last to the real, populated database.
    if (state.popDb) {
      const db = state.popDb;
      const before = await snapshot(db);
      try {
        await upSql(db, s84.sql, name(s84.file));
        const dd = diff(reference, await fingerprint(db));
        if (!same(dd)) fail("E", `0084 applied to the populated database gives a different schema from the reference: ${showDiff(dd)}`);
        const moved = await verifyWhole(db, before);
        for (const m of moved) fail("E", `0084 changed existing data: ${m}`);
        if (same(dd) && !moved.length) finding("E", `0084 applied on top of the populated head (${rowsIn(before)} rows): the schema equals the reference and no row changed`);
        // Its rollback lives on the same branch as the migration (not in this checkout): read it with git show and exercise it on the populated head.
        const rbSql = git(["show", `${s84.ref}:supabase/rollbacks/${name(s84.file)}.down.sql`]);
        if (!rbSql) {
          note("E", "0084 has no rollback script on codex/client-ai-onboarding or in this checkout: if it is merged, a rollback must be added with it");
        } else if (state.ctx) {
          const ctx = state.ctx;
          const agent = (await one(db, "select id, org_id from agent_instances where org_id = $1 limit 1", [ctx.orgs.a.id]));
          await db.query("insert into agent_provisioning_jobs (org_id, agent_instance_id, kind, status, detail) values ($1, $2, 'sync', 'succeeded', 'sync probe')", [agent.org_id, agent.id]);
          const refused = await throwaway(db, (tx) => attempt(tx, rbSql));
          if (refused.ok || !/rolling back 0084/.test(refused.message)) fail("E", `the 0084 rollback did not refuse while a sync job existed (${refused.ok ? "it ran" : clip(refused.message, 160)})`);
          await db.query("delete from agent_provisioning_jobs where detail = 'sync probe'");
          await db.transaction((tx) => tx.exec(rbSql));
          await db.query("delete from schema_migrations where version = $1", [name(s84.file)]);
          const back = diff(fresh.final, await fingerprint(db));
          const moved = await verifyWhole(db, before);
          if (!same(back)) fail("E", `the 0084 rollback did not return the populated head to the schema without 0084: ${showDiff(back)}`);
          for (const m of moved) fail("E", `the 0084 rollback changed data: ${m}`);
          await upSql(db, s84.sql, name(s84.file));
          const again = diff(reference, await fingerprint(db));
          if (!same(again)) fail("E", `applying 0084 again after its rollback gives a different schema: ${showDiff(again)}`);
          if (!refused.ok && same(back) && !moved.length && same(again)) finding("E", `0084's own rollback (read from ${s84.ref}) refuses while a Hermes sync job exists ("${clip(refused.message, 80)}"), then returns the populated head to exactly the schema without 0084 (${fresh.final.size} facts) with every row unchanged, and 0084 applies again to the same schema`);
        }
      } catch (e) {
        fail("E", `0084 could not be applied on top of the populated head: ${clip(e.message, 300)}`);
      }
    }
  }
  result.sections.E.ms = Date.now() - t0;
}

// ============================================================================================================================================
// F. The hosted procedure, as far as embedded Postgres can go
// ============================================================================================================================================
async function runF() {
  section("F", "The hosted procedure from a ledger at 0086: backup, dry run, one at a time, verify");
  const t0 = Date.now();
  const fresh = await freshChain();
  // The runner's rules, mirrored from src/server/db/index.ts (appliedVersions, runMigrations, selectMigrationFiles) and scripts/migrate.ts (--only, --through, --dry-run).
  const src = fs.readFileSync(path.join(root, "src", "server", "db", "index.ts"), "utf8");
  for (const marker of ["insert into schema_migrations (version) values ('${version}');", "if (applied.has(version)) continue;", "Cannot apply ${version} before ${missingPrerequisites.join(\", \")}.", "supabase_migrations.schema_migrations", "execScript", "Unknown migration version(s): ${unknown.join"]) {
    if (!src.includes(marker)) fail("F", `the runner source no longer contains "${marker}": the mirror in this script is out of date`);
  }
  const block = src.slice(src.indexOf("export const MIGRATION_PREREQUISITES"), src.indexOf("};", src.indexOf("export const MIGRATION_PREREQUISITES")));
  const prereq = {};
  for (const m of block.matchAll(/"(\d{4}_[a-z0-9_]+)":\s*\[([^\]]*)\]/g)) prereq[m[1]] = [...m[2].matchAll(/"(\d{4}_[a-z0-9_]+)"/g)].map((x) => x[1]);
  const applied = async (db) => {
    const set = new Set((await q(db, "select version from schema_migrations")).map((r) => r.version));
    if ((await one(db, "select to_regclass('supabase_migrations.schema_migrations')::text as t")).t) {
      const prefixes = new Set((await q(db, "select version from supabase_migrations.schema_migrations")).map((r) => r.version));
      for (const f of files) if (prefixes.has(prefix(f))) set.add(name(f));
    }
    return set;
  };
  const select = (versions) => {
    if (versions === undefined) return files;
    if (!versions.length) throw new Error("Pass at least one exact migration version after --only.");
    if (new Set(versions).size !== versions.length) throw new Error("A migration version was requested more than once.");
    const byVersion = new Map(files.map((f) => [name(f), f]));
    const unknown = versions.filter((v) => !byVersion.has(v));
    if (unknown.length) throw new Error(`Unknown migration version(s): ${unknown.join(", ")}. Pass exact filenames without .sql.`);
    return files.filter((f) => versions.includes(name(f)));
  };
  const scope = (through) => files.map(name).filter((v) => v <= through);
  const pending = async (db, versions) => {
    const have = await applied(db);
    return select(versions).map(name).filter((v) => !have.has(v));
  };
  const runnerApply = async (db, versions) => {
    const have = await applied(db);
    const ran = [];
    for (const f of select(versions)) {
      const v = name(f);
      if (have.has(v)) continue;
      const miss = (prereq[v] ?? []).filter((r) => !have.has(r));
      if (miss.length) throw new Error(`Cannot apply ${v} before ${miss.join(", ")}.`);
      await upSql(db, fs.readFileSync(path.join(MIGRATIONS, f), "utf8"), v);
      if ((await one(db, "select to_regclass('supabase_migrations.schema_migrations')::text as t")).t) {
        await db.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2) on conflict (version) do nothing", [prefix(f), v.replace(/^\d+_/, "")]).catch(() => undefined);
      }
      have.add(v);
      ran.push(v);
    }
    return ran;
  };
  const prodHead = "0086_lead_scoring";
  if (!files.map(name).includes(prodHead)) {
    fail("F", `${prodHead} is not in this checkout`);
    return;
  }
  // Production as the docs describe it: rebuilt with --through, populated.
  const db = await newDb();
  const rebuilt = await runnerApply(db, scope(prodHead));
  const pendingNow = files.map(name).filter((v) => v > prodHead);
  finding("F", `rebuilt production's state with the runner (--through ${prodHead}): ${rebuilt.length} migrations applied, ledger ${(await applied(db)).size} rows (the docs record 80 at 0086), ${pendingNow.length} pending: ${pendingNow.join(", ")}`);
  if ((await applied(db)).size !== 80) fail("F", `the ledger at ${prodHead} has ${(await applied(db)).size} rows, the release docs say 80`);
  const ctx = await seedBaseline(db, Math.max(0.3, scale * 0.3));
  for (const f of files.filter((x) => numOf(x) >= 77 && name(x) <= prodHead)) if (SEEDS[name(f)]) await SEEDS[name(f)](db, ctx);
  let cur = await capture(db, ctx);
  finding("F", `populated like a workspace in use: ${rowsIn(cur.snap)} rows in ${[...cur.snap.values()].filter((s) => s.n > 0).length} tables (scale ${Math.max(0.3, scale * 0.3)})`);
  // Read-only look first.
  const noRls = (await q(db, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity and relname <> 'schema_migrations' order by 1")).map((r) => r.relname);
  if (noRls.length) fail("F", `before applying, public tables without row-level security: ${noRls.join(", ")}`);
  const trgm = (await q(db, "select 1 from pg_extension where extname = 'pg_trgm'")).length > 0;
  const cli = (await one(db, "select to_regclass('supabase_migrations.schema_migrations')::text as t")).t;
  finding("F", `read-only look: ledger ${cur.ledger.length} rows ending ${cur.ledger[cur.ledger.length - 1]}; pg_trgm ${trgm ? "installed" : "MISSING"}; Supabase CLI ledger ${cli ? "present" : "absent (as on production)"}; every public table has row-level security (${(await listTables(db)).length} tables)`);
  if (!trgm) fail("F", "pg_trgm is not installed in the production-like database");
  // Backup, verified by restoring it.
  const tb = Date.now();
  const backup = await db.dumpDataDir("gzip");
  const copy = await newDb({ loadDataDir: backup });
  const ledgerCopy = (await q(copy, "select version from schema_migrations order by version")).map((r) => r.version);
  const snapCopy = await snapshot(copy);
  const copyBad = await verifyWhole(copy, cur.snap);
  const dCopy = diff(cur.fp, await fingerprint(copy));
  await copy.close();
  if (JSON.stringify(ledgerCopy) !== JSON.stringify(cur.ledger)) fail("F", "the restored backup has a different ledger");
  for (const m of copyBad) fail("F", `the restored backup differs from the source: ${m}`);
  if (!same(dCopy)) fail("F", `the restored backup has a different schema: ${showDiff(dCopy)}`);
  if (!copyBad.length && same(dCopy)) finding("F", `backup (embedded stand-in for pg_dump + pg_restore --list): ${(backup.size / 1048576).toFixed(1)} MB gzip data directory taken in ${Date.now() - tb} ms, restored into a second database: ledger ${ledgerCopy.length} rows, ${rowsIn(snapCopy)} rows in ${[...snapCopy.values()].filter((s) => s.n > 0).length} tables and ${cur.fp.size} schema facts all identical to the source`);
  // Dry run.
  const dry = await pending(db, undefined);
  if (JSON.stringify(dry) !== JSON.stringify(pendingNow)) fail("F", `the dry run lists ${dry.join(", ")}; expected ${pendingNow.join(", ")}`);
  finding("F", `dry run: "Would apply, in this order: ${dry.join(", ")}" (nothing applied)`);
  const dryOnly = await pending(db, [...pendingNow]);
  if (JSON.stringify(dryOnly) !== JSON.stringify(pendingNow)) fail("F", "--only with the three pending versions does not list them in order");
  // The runner's guards on the same database.
  const guard = async (label, fn, expect) => {
    try {
      await fn();
      fail("F", `${label}: expected an error`);
    } catch (e) {
      if (!expect.test(e.message)) fail("F", `${label}: expected ${expect}, got "${clip(e.message, 160)}"`);
    }
  };
  await guard("--only with an unknown version", () => pending(db, ["0099_nothing"]), /Unknown migration version/);
  await guard("--only with a version twice", () => pending(db, ["0087_website_chat", "0087_website_chat"]), /more than once/);
  const missingPrereq = (() => {
    const have = new Set(cur.ledger);
    have.delete("0049_aqi_attachments");
    return (prereq["0089_social_media_manager"] ?? []).filter((r) => !have.has(r));
  })();
  if (!missingPrereq.includes("0049_aqi_attachments")) fail("F", "0089 does not require 0049 in the runner's prerequisite list");
  const rangeEnd = scope("0087_website_chat").filter((v) => !cur.ledger.includes(v));
  if (JSON.stringify(rangeEnd) !== JSON.stringify(["0087_website_chat"])) fail("F", `--through 0087 from the 0086 ledger lists ${rangeEnd.join(", ")}`);
  finding("F", "the runner's own refusals hold on this database: an unknown version and a version named twice are refused before anything is applied, and --through 0087 from the 0086 ledger lists exactly 0087_website_chat");
  // A ledger that lacks a prerequisite: through 0064, 0065 (support requests) is not in. The runner must refuse 0083, 0085 and 0089, which all extend
  // notifications_kind_check from the live constraint and would otherwise be overwritten by 0065's copied list, and must apply nothing.
  {
    const early = await newDb();
    await runnerApply(early, scope("0064_aqi_feature_tours"));
    const before = (await applied(early)).size;
    const refused = [];
    for (const v of ["0083_unified_inbox", "0085_missed_call_recovery", "0086_lead_scoring", "0087_website_chat", "0089_social_media_manager"]) {
      if (!files.map(name).includes(v)) continue;
      try {
        await runnerApply(early, [v]);
        fail("F", `from a ledger through 0064 the runner applied ${v} although 0065 is not in it`);
      } catch (e) {
        if (!/^Cannot apply .* before /.test(e.message)) fail("F", `from a ledger through 0064, ${v} failed for another reason: ${clip(e.message, 160)}`);
        else refused.push(v.slice(0, 4));
      }
    }
    const afterRows = (await applied(early)).size;
    await early.close();
    if (afterRows !== before) fail("F", `a refused migration changed the ledger (${before} to ${afterRows} rows)`);
    else finding("F", `from a ledger through 0064 (0065 not in it) the runner refuses ${refused.join(", ")} with "Cannot apply ... before ...", before applying anything (ledger stays at ${before} rows)`);
  }
  // One at a time, a full check after each.
  let sawProblem = false;
  for (const v of pendingNow) {
    const before = cur;
    const ran = await runnerApply(db, [v]);
    if (JSON.stringify(ran) !== JSON.stringify([v])) fail("F", `--only ${v} applied ${ran.join(", ") || "nothing"}`);
    const after = await capture(db, ctx, { skipProbe: true });
    after.probe = await probe(db, ctx, before.probeTables.filter((x) => after.tables.has(x)));
    const problems = [];
    const growable = insertTargets(files.find((f) => name(f) === v));
    const rowsChanged = await verifyWhole(db, before.snap, growable);
    for (const m of rowsChanged) problems.push(`earlier data: ${m}`);
    if (after.ledger.length !== before.ledger.length + 1 || after.ledger[after.ledger.length - 1] !== v) problems.push(`ledger is ${after.ledger.length} rows ending ${after.ledger[after.ledger.length - 1]}`);
    for (const k of subsetOf(before.kinds, after.kinds)) problems.push(`notification kind lost: ${k}`);
    for (const d of probeDiff(before.probe, after.probe, growable)) problems.push(d);
    const objects = await checkNewObjects(db, "F", v, before, after);
    const unprotected = (await q(db, "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity and relname <> 'schema_migrations'")).map((r) => r.relname);
    if (unprotected.length) problems.push(`public tables without row-level security: ${unprotected.join(", ")}`);
    const dd = diff(fresh.fpBy.get(v), after.fp);
    if (!same(dd)) problems.push(`schema differs from the fresh chain: ${showDiff(dd, 500)}`);
    for (const p of problems) fail("F", `${v}: ${p}`);
    if (problems.length || objects.problems.length) sawProblem = true;
    finding("F", `--only ${v}: ledger ${after.ledger.length} rows ending ${v}; ${rowsIn(before.snap)} earlier rows in ${before.snap.size} tables unchanged; ${objects.fresh.length} new tables (${objects.fresh.join(", ")}) with row-level security, empty, select-only for the application role; no public table without row-level security; the application role sees the same rows; the schema equals the fresh chain at this point`);
    cur = after;
  }
  const finalDiff = diff(fresh.final, cur.fp);
  if (!same(finalDiff)) fail("F", `the end state differs from the fresh chain: ${showDiff(finalDiff)}`);
  const last = await pending(db, undefined);
  if (last.length) fail("F", `after the last migration the dry run still lists ${last.join(", ")}`);
  finding("F", `final: dry run says "Nothing pending in this scope."; ledger ${cur.ledger.length} rows (${files.length} files); schema equals the fresh chain (${fresh.final.size} facts)${sawProblem ? "" : "; every check after every step passed"}`);
  // The CLI ledger hazard: a hosted project that has supabase_migrations.schema_migrations treats a file as applied when its NUMBER is in it.
  {
    const hazard = await newDb();
    await runnerApply(hazard, scope(prodHead));
    await hazard.exec("create schema supabase_migrations; create table supabase_migrations.schema_migrations (version text primary key, name text)");
    for (const f of files.filter((x) => name(x) <= prodHead)) await hazard.query("insert into supabase_migrations.schema_migrations (version, name) values ($1, $2)", [prefix(f), name(f).replace(/^\d+_/, "")]);
    const p = await pending(hazard, undefined);
    if (JSON.stringify(p) !== JSON.stringify(pendingNow)) fail("F", `with a Supabase CLI ledger the dry run lists ${p.join(", ")}`);
    const ranHazard = await runnerApply(hazard, [pendingNow[0]]);
    const cliRows = (await q(hazard, "select version from supabase_migrations.schema_migrations order by version")).map((r) => r.version);
    if (JSON.stringify(ranHazard) !== JSON.stringify([pendingNow[0]]) || !cliRows.includes(prefix(files.find((f) => name(f) === pendingNow[0])))) fail("F", "with a Supabase CLI ledger the first pending migration was not applied and recorded by number");
    else finding("F", `with a Supabase CLI ledger present (hosted projects have one), the dry run still lists the same ${p.length} versions and --only ${pendingNow[0]} records itself there by number as well (${cliRows.length} rows)`);
    await hazard.close();
  }
  // Rolling back by restoring: the backup is the way back for a migration defect, and it is exactly the state before.
  {
    const restored = await newDb({ loadDataDir: backup });
    const rd = diff(cur.fp, await fingerprint(restored));
    const rl = (await q(restored, "select version from schema_migrations order by version")).map((r) => r.version);
    await restored.close();
    if (rl.length !== 80 || rl[rl.length - 1] !== prodHead) fail("F", `the backup restores to a ledger of ${rl.length} rows ending ${rl[rl.length - 1]}`);
    else finding("F", `after the three applies, restoring the backup returns the database to ledger ${rl.length} rows ending ${rl[rl.length - 1]} and the ${rd.onlyBefore.length} schema facts the three migrations added are gone again (the way back if a migration, not the application, is at fault)`);
  }
  await db.close();
  result.sections.F.ms = Date.now() - t0;
}

// ============================================================================================================================================
// Run
// ============================================================================================================================================
console.log(`Combined migration rehearsal on embedded Postgres (${files.length} migrations 0001..${prefix(HEAD)}, ${HISTORY.length} from 0077; PGlite in memory, no environment file read, no network)`);
if (process.env.DATABASE_URL || process.env.DATABASE_DRIVER) console.log("note: DATABASE_URL / DATABASE_DRIVER are set in this shell and are not used by this script");
if (wants("A")) await runA();
if (wants("B", "C", "D")) await runBCD();
if (wants("E")) await runE();
if (state.popDb) await state.popDb.close();
if (wants("F")) await runF();

for (const [key, s] of Object.entries(result.sections)) {
  console.log(`\n${key}. ${s.title}: ${s.failures.length ? "FAIL" : "ok"}${s.ms ? ` (${(s.ms / 1000).toFixed(1)} s)` : ""}`);
  for (const x of s.failures) console.log(`   FAIL  ${x}`);
  for (const x of s.findings) console.log(`   ${x}`);
  for (const x of s.notes) console.log(`   note: ${x}`);
}
console.log(`\ntotal ${((Date.now() - t0All) / 1000).toFixed(0)} s; ${result.ok ? "all sections passed" : "FAILED"}`);
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(reportPath), JSON.stringify(result, null, 2));
  console.log(`report written to ${reportPath}`);
}
process.exit(result.ok ? 0 : 1);
