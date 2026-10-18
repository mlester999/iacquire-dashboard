import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PGlite, Transaction } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  choosePersonas, functionBody, generateFrom, MIGRATION_PATH, openDatabase, PERSONA_STRATA_SQL, readPolicies, ROLLBACK_PATH, runScript, selectPolicies, verifyInTransaction, VERSION,
  type PolicyRow,
} from "../scripts/rls-initplan";

// Migration 0050 rewrites every per-row permission call in a SELECT policy into a statement-level InitPlan. This proves, adversarially and
// for the whole schema, that nobody sees a single row more or less:
//   1. a private in-memory database gets every migration before 0050 (not the shared test database, which already has 0050);
//   2. every table gets rows in five organizations (active, active, suspended, archived, and the agency), inserted generically from the
//      catalog with triggers off and CHECK constraints dropped, so row states the application would never write are covered too;
//   3. for each persona below, the primary keys it can see in every table are captured under row-level security;
//   4. the committed 0050 is applied and the capture repeated: identical, for every table and persona;
//   5. the committed rollback is applied: every policy expression is byte-for-byte the original, and the capture matches the first again.
// It also proves the committed files are exactly what scripts/rls-initplan.ts generates from this schema.
// Run it against a restored staging copy the same way (see docs/rls-performance-rollout.md); never against production data.

const ROOT = process.cwd();
const LONG = 300_000;

let db: PGlite;
const ORGS = { a: randomUUID(), b: randomUUID(), c: randomUUID(), d: randomUUID(), g: randomUUID() };
const ORG_LIST = [ORGS.a, ORGS.b, ORGS.c, ORGS.d, ORGS.g];

interface Persona {
  key: string;
  /** The user id put in app.user_id ('' for a request with none). */
  id: string;
}
const personas: Persona[] = [];
const userIdsFor = new Map<string, string[]>();
let policiesBefore: PolicyRow[] = [];
let tables: Array<{ name: string; key: string }> = [];
let first: Capture;
const fillFailures: string[] = [];

type Capture = Map<string, Map<string, string[] | string>>;

// --- identities -------------------------------------------------------------------------------------------------------------------

async function user(key: string, platformRole = "none", status = "active"): Promise<string> {
  const id = randomUUID();
  await db.query("insert into users (id, email, full_name, platform_role, status) values ($1, $2, $3, $4, $5)", [id, `${key.toLowerCase()}@example.test`, key, platformRole, status]);
  personas.push({ key, id });
  return id;
}
const member = (org: string, userId: string, role: string, status = "active") =>
  db.query("insert into organization_memberships (org_id, user_id, role, status) values ($1, $2, $3, $4)", [org, userId, role, status]);
const assign = (org: string, userId: string) => db.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [org, userId]);
const agencyScope = (userId: string, mode: "all_clients" | "assigned_clients") =>
  db.query("insert into agency_user_client_scopes (user_id, scope_mode) values ($1, $2)", [userId, mode]);
const agencyOverride = (userId: string, permission: string, effect: "allow" | "deny") =>
  db.query("insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, $2, $3)", [userId, permission, effect]);
const override = (org: string, userId: string, permission: string, effect: "grant" | "revoke") =>
  db.query("insert into member_permission_overrides (org_id, user_id, permission, effect, reason) values ($1, $2, $3, $4, 'equivalence test')", [org, userId, permission, effect]);
const session = (org: string, userId: string, mode: "read" | "write") =>
  db.query("insert into crm_support_sessions (org_id, user_id, mode, reason, expires_at) values ($1, $2, $3, 'equivalence test session', now() + interval '1 hour')", [org, userId, mode]);

async function seedIdentities() {
  const orgs: Array<[string, string, string, string]> = [
    [ORGS.a, "Equiv A", "client", "active"],
    [ORGS.b, "Equiv B", "client", "active"],
    [ORGS.c, "Equiv C (suspended)", "client", "suspended"],
    [ORGS.d, "Equiv D (archived)", "client", "archived"],
    [ORGS.g, "Equiv Agency", "agency", "active"],
  ];
  for (const [id, name, kind, status] of orgs) {
    await db.query("insert into organizations (id, name, slug, kind, status) values ($1, $2, $3, $4, $5)", [id, name, `equiv-${id.slice(0, 8)}`, kind, status]);
  }
  // Every client role in the permission matrix, in organization A.
  for (const role of ["owner", "admin", "member", "sales_rep", "support", "viewer", "appointment_setter"]) await member(ORGS.a, await user(`a-${role}`), role);
  // A member whose role permissions are all revoked where overrides allow it (crm.view and the inbox basics cannot be overridden).
  const noCrm = await user("a-member-no-crm");
  await member(ORGS.a, noCrm, "member");
  const overridable = (await db.query<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'member_permission_overrides_permission_check'")).rows[0].def;
  for (const m of overridable.matchAll(/'([a-z_.]+)'::text/g)) await override(ORGS.a, noCrm, m[1], "revoke");
  // A viewer granted extra permissions by override.
  const granted = await user("a-viewer-with-grants");
  await member(ORGS.a, granted, "viewer");
  for (const p of ["contacts.edit", "inbox.view_all", "analytics.export", "workflows.view", "calls.view", "tasks.manage"]) await override(ORGS.a, granted, p, "grant");
  // One user in two organizations with different roles.
  const multi = await user("viewer-in-a-admin-in-b");
  await member(ORGS.a, multi, "viewer");
  await member(ORGS.b, multi, "admin");
  // Membership revoked; account disabled; owners of the other organizations.
  await member(ORGS.a, await user("a-owner-revoked"), "owner", "revoked");
  await member(ORGS.a, await user("a-admin-disabled-user", "none", "disabled"), "admin");
  await member(ORGS.b, await user("b-owner"), "owner");
  await member(ORGS.c, await user("c-owner-suspended-org"), "owner");
  const cViewer = await user("c-viewer-with-grant-suspended-org");
  await member(ORGS.c, cViewer, "viewer");
  await override(ORGS.c, cViewer, "contacts.edit", "grant");
  await member(ORGS.d, await user("d-owner-archived-org"), "owner");
  await member(ORGS.g, await user("agency-org-owner"), "owner");
  // Agency.
  const admin = await user("agency-super-admin", "agency_super_admin");
  await user("agency-super-admin-disabled", "agency_super_admin", "disabled");
  const staffA = await user("agency-staff-assigned-a-c", "agency_staff");
  await assign(ORGS.a, staffA);
  await assign(ORGS.c, staffA);
  await user("agency-staff-unassigned", "agency_staff");
  await assign(ORGS.a, await user("agency-staff-disabled", "agency_staff", "disabled"));
  const staffMember = await user("agency-staff-assigned-b-viewer-in-a", "agency_staff");
  await assign(ORGS.b, staffMember);
  await member(ORGS.a, staffMember, "viewer");
  const managerDefaultScope = await user("agency-manager-default-scope", "agency_manager");
  await assign(ORGS.a, managerDefaultScope);
  const managerAllClients = await user("agency-manager-all-clients", "agency_manager");
  await agencyScope(managerAllClients, "all_clients");
  await assign(ORGS.a, managerAllClients);
  await session(ORGS.b, managerAllClients, "read");
  const managerAssigned = await user("agency-manager-assigned-clients", "agency_manager");
  await agencyScope(managerAssigned, "assigned_clients");
  await assign(ORGS.a, managerAssigned);
  await session(ORGS.a, managerAssigned, "write");
  await agencyOverride(managerAssigned, "agency.crm.read", "deny");
  // A staff_assignments row for someone who is not agency staff (staff_assigned also requires the platform role).
  await assign(ORGS.a, await user("client-user-with-stray-assignment"));
  // Support sessions further restrict agency permission grants for CRM rows; a session alone never grants client scope.
  const adminSession = await user("agency-super-admin-write-session", "agency_super_admin");
  await session(ORGS.a, adminSession, "write");
  const staffSession = await user("agency-staff-assigned-a-read-session", "agency_staff");
  await assign(ORGS.a, staffSession);
  await session(ORGS.a, staffSession, "read");
  await session(ORGS.a, await user("agency-staff-session-without-assignment", "agency_staff"), "read");
  await session(ORGS.b, admin, "read");
  await session(ORGS.c, staffA, "read");
  // Agency super admins who also have memberships or assignments (scripts/seed.ts makes the super admin an owner of the agency
  // organization). For the permissions their agency role lacks (contacts.view, companies.view, calls.view, ...) app.permitted_orgs takes
  // its second branch even for them, so its candidates must be exactly their memberships.
  const adminMember = await user("agency-super-admin-owner-g-member-a", "agency_super_admin");
  await member(ORGS.g, adminMember, "owner");
  await member(ORGS.a, adminMember, "member");
  await override(ORGS.a, adminMember, "contacts.view", "revoke");
  await override(ORGS.a, adminMember, "calls.view", "grant");
  await member(ORGS.c, await user("agency-super-admin-owner-suspended-c", "agency_super_admin"), "owner");
  await assign(ORGS.b, await user("agency-super-admin-assigned-b", "agency_super_admin"));
  // No memberships at all; an id with no user row; a request with no user id.
  await user("no-memberships");
  personas.push({ key: "unknown-user-id", id: randomUUID() }, { key: "no-user-id", id: "" });
  // An override on an owner (the guard trigger forbids it; written with triggers off to cover the state anyway).
  await db.query("set session_replication_role = replica");
  await override(ORGS.b, personas.find((p) => p.key === "b-owner")!.id, "contacts.view", "revoke");
  await db.query("set session_replication_role = origin");

  const all = (await db.query<{ org_id: string; user_id: string }>("select org_id, user_id from organization_memberships")).rows;
  const agency = personas.filter((p) => p.key.startsWith("agency-") || p.key === "no-memberships").map((p) => p.id);
  for (const org of ORG_LIST) userIdsFor.set(org, [...all.filter((m) => m.org_id === org).map((m) => m.user_id), ...agency]);
}

// --- generic rows -----------------------------------------------------------------------------------------------------------------

interface Column {
  name: string;
  type: string;
  notnull: boolean;
  enums: string[];
}
interface Fk {
  cols: string[];
  ftable: string;
  fcols: string[];
}
const IDENTITY_TABLES = ["schema_migrations", "users", "organizations", "organization_memberships", "staff_assignments", "member_permission_overrides", "role_permissions", "crm_support_sessions", "agency_user_client_scopes", "agency_user_permission_overrides"];
const ROWS_PER_ORG = 5;

function enumValues(col: string, checks: string[]): string[] {
  const out = new Set<string>();
  // The column itself, not a function of it (jsonb_typeof(settings) = 'object') or another column ending in the same name.
  const name = `(?<![a-z0-9_.]|[a-z0-9_]\\()\\(?${col}\\)?(?:::text)?`;
  for (const def of checks) {
    for (const m of def.matchAll(new RegExp(`${name} = ANY \\(\\(?ARRAY\\[([^\\]]*)\\]`, "g"))) for (const v of m[1].matchAll(/'((?:[^']|'')*)'/g)) out.add(v[1].replace(/''/g, "'"));
    for (const m of def.matchAll(new RegExp(`${name} = '((?:[^']|'')*)'`, "g"))) out.add(m[1].replace(/''/g, "'"));
  }
  return [...out];
}

const BASE = Date.UTC(2026, 9, 1, 9, 0, 0);
function scalar(col: Column, n: number, salt: number): string | null {
  const t = col.type;
  if (col.enums.length && (t === "text" || t === "citext" || t.startsWith("character"))) return col.enums[(n + salt) % col.enums.length];
  if (t.endsWith("[]")) return "{}";
  if (t === "uuid") return randomUUID();
  if (t === "citext") return `u${n}-${col.name}@example.test`;
  if (t === "text" || t.startsWith("character varying") || t === "name") return `${col.name}-${n}`;
  if (t.startsWith("character")) return "x";
  if (t === "boolean") return (n + salt) % 2 === 0 ? "true" : "false";
  if (["smallint", "integer", "bigint"].includes(t)) return String((n % 20) + 1);
  if (t.startsWith("numeric") || t === "real" || t === "double precision") return String((n % 20) + 0.5);
  const later = /end|until|expires|finish|clos|due|_to$|stop/.test(col.name) ? 3_600_000 : 0;
  const at = new Date(BASE + (n - 12) * 7 * 3_600_000 + later);
  if (t.startsWith("timestamp")) return at.toISOString();
  if (t === "date") return at.toISOString().slice(0, 10);
  if (t.startsWith("time")) return "09:30:00";
  if (t === "interval") return "01:00:00";
  if (t === "jsonb" || t === "json") return "{}";
  if (t === "inet" || t === "cidr") return "10.0.0.1";
  if (t === "bytea") return "\\x00";
  if (t === "tsvector") return "";
  if (t === "tstzrange") return `[${at.toISOString()},${new Date(at.getTime() + 3_600_000).toISOString()})`;
  if (t === "daterange") return `[${at.toISOString().slice(0, 10)},${new Date(at.getTime() + 86_400_000).toISOString().slice(0, 10)})`;
  return null;
}

async function fillTables() {
  const tablesRes = await db.query<{ t: string }>("select c.relname::text as t from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by 1");
  const fill = tablesRes.rows.map((r) => r.t).filter((t) => !IDENTITY_TABLES.includes(t));
  const checks = (await db.query<{ t: string; name: string; def: string }>(
    "select conrelid::regclass::text as t, conname::text as name, pg_get_constraintdef(oid) as def from pg_constraint where contype = 'c' and connamespace = 'public'::regnamespace",
  )).rows;
  const colRows = (await db.query<{ t: string; name: string; type: string; notnull: boolean; skip: boolean }>(
    `select c.relname::text as t, a.attname::text as name, format_type(a.atttypid, a.atttypmod) as type, a.attnotnull as notnull,
            (a.attgenerated <> '' or a.attidentity <> '') as skip
     from pg_class c join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' order by c.relname, a.attnum`,
  )).rows;
  const fkRows = (await db.query<{ t: string; ft: string; fschema: string; cols: string[]; fcols: string[] }>(
    `select c.relname::text as t, f.relname::text as ft, f.relnamespace::regnamespace::text as fschema,
       (select array_agg(a.attname::text order by x.ord) from unnest(k.conkey) with ordinality x(n, ord) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n) as cols,
       (select array_agg(a.attname::text order by x.ord) from unnest(k.confkey) with ordinality x(n, ord) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.n) as fcols
     from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_class f on f.oid = k.confrelid
     where k.contype = 'f' and c.relnamespace = 'public'::regnamespace`,
  )).rows;
  const columns = new Map<string, Column[]>();
  for (const r of colRows) {
    if (r.skip) continue;
    const list = columns.get(r.t) ?? [];
    list.push({ name: r.name, type: r.type, notnull: r.notnull, enums: enumValues(r.name, checks.filter((k) => k.t === r.t || k.t === `public.${r.t}`).map((k) => k.def)) });
    columns.set(r.t, list);
  }
  const fks = new Map<string, Fk[]>();
  for (const r of fkRows) {
    const list = fks.get(r.t) ?? [];
    list.push({ cols: r.cols, ftable: r.fschema === "public" ? r.ft : `${r.fschema}.${r.ft}`, fcols: r.fcols });
    fks.set(r.t, list);
  }
  // Row states the application never writes are covered too: CHECK constraints go, triggers (guards, foreign keys) are off.
  for (const k of checks) await db.query(`alter table ${k.t} drop constraint "${k.name}"`);

  // Parents first.
  const order: string[] = [];
  const pending = new Set(fill);
  while (pending.size) {
    const ready = [...pending].filter((t) => !(fks.get(t) ?? []).some((f) => f.ftable !== t && pending.has(f.ftable)));
    const next = ready.length ? ready : [[...pending].sort()[0]];
    for (const t of next.sort()) {
      order.push(t);
      pending.delete(t);
    }
  }
  const rowsOf = new Map<string, Array<Record<string, unknown>>>();
  const load = async (t: string) => rowsOf.set(t, (await db.query<{ r: Record<string, unknown> }>(`select to_jsonb(x) as r from public.${t} x`)).rows.map((r) => r.r));
  for (const t of IDENTITY_TABLES.filter((x) => x !== "schema_migrations")) await load(t);

  await db.query("set session_replication_role = replica");
  let n = 0;
  for (const t of order) {
    const cols = columns.get(t) ?? [];
    const hasOrg = cols.some((c) => c.name === "org_id");
    const orgNullable = cols.some((c) => c.name === "org_id" && !c.notnull);
    const targets: Array<string | null> = hasOrg ? [...ORG_LIST.flatMap((o) => Array<string>(ROWS_PER_ORG).fill(o)), ...(orgNullable ? [null, null] : [])] : Array(ROWS_PER_ORG * 2).fill(null);
    let inserted = 0;
    const errors: string[] = [];
    for (const [i, org] of targets.entries()) {
      n++;
      for (let attempt = 0; attempt < 3; attempt++) {
        const row = new Map<string, string | null>();
        cols.forEach((c, ci) => {
          if (c.name === "org_id") row.set(c.name, org);
          else if (!c.notnull && (attempt === 1 || (n + ci) % 4 === 3)) row.set(c.name, null);
          else row.set(c.name, scalar(c, n + attempt * 7, ci));
        });
        for (const [fi, fk] of (fks.get(t) ?? []).entries()) {
          if (fk.ftable === t) {
            for (const c of fk.cols) if (c !== "org_id" && !cols.find((x) => x.name === c)?.notnull) row.set(c, null);
            continue;
          }
          if (fk.ftable === "users" && fk.cols.length === 1) {
            const pool = userIdsFor.get(org ?? ORGS.a)!;
            row.set(fk.cols[0], pool[(i + fi * 3 + attempt) % pool.length]);
            continue;
          }
          const orgAt = fk.cols.indexOf("org_id");
          const parents = (rowsOf.get(fk.ftable) ?? []).filter((p) => orgAt < 0 || org === null || p[fk.fcols[orgAt]] === org);
          const pick = parents.length ? parents[(i + fi + attempt) % parents.length] : null;
          fk.cols.forEach((c, ci) => {
            if (c === "org_id") return;
            const col = cols.find((x) => x.name === c);
            if (pick) row.set(c, pick[fk.fcols[ci]] === null || pick[fk.fcols[ci]] === undefined ? null : String(typeof pick[fk.fcols[ci]] === "object" ? JSON.stringify(pick[fk.fcols[ci]]) : pick[fk.fcols[ci]]));
            else if (col && !col.notnull) row.set(c, null);
          });
        }
        // A NOT NULL column with no value is left to its default; a nullable one is written as an explicit null.
        const names = cols.filter((c) => row.get(c.name) !== null || !c.notnull).map((c) => c.name);
        const sql = `insert into public.${t} (${names.map((c) => `"${c}"`).join(", ")}) values (${names.map((c, k) => `$${k + 1}::${cols.find((x) => x.name === c)!.type}`).join(", ")}) on conflict do nothing`;
        try {
          // PGlite serialises a bytea parameter only from bytes.
          const params = names.map((c) => (cols.find((x) => x.name === c)!.type === "bytea" && row.get(c) !== null ? new Uint8Array([n % 256]) : (row.get(c) ?? null)));
          const res = await db.query(sql, params);
          inserted += res.affectedRows ?? 0;
          break;
        } catch (err) {
          if (attempt === 2) errors.push((err as Error).message);
        }
      }
    }
    if (!inserted && errors.length) fillFailures.push(`${t}: ${errors[0]}`);
    await load(t);
  }
  await db.query("set session_replication_role = origin");

  // Conversations: owned by, assigned to, or unrelated to the inbox.view-only sales rep (inbox.view without inbox.view_all).
  const rep = personas.find((p) => p.key === "a-sales_rep")!.id;
  const viewer = personas.find((p) => p.key === "a-viewer")!.id;
  const convs = (await db.query<{ id: string }>("select id from conversations where org_id = $1 order by id", [ORGS.a])).rows.map((r) => r.id);
  const plan: Array<[string | null, string | null]> = [[rep, null], [null, rep], [viewer, rep], [viewer, null], [null, null]];
  await db.query("set session_replication_role = replica");
  for (const [k, id] of convs.entries()) await db.query("update conversations set owner_user_id = $2, assigned_user_id = $3 where id = $1", [id, ...plan[k % plan.length]]);
  await db.query("set session_replication_role = origin");
}

async function seedVisibleAqiAttachment() {
  const ownerId = personas.find((p) => p.key === "a-owner")!.id;
  const conversationId = randomUUID();
  const fileId = randomUUID();
  await db.query("insert into aqi_conversations (id, org_id, user_id, title) values ($1, $2, $3, 'Equivalence attachment conversation')", [conversationId, ORGS.a, ownerId]);
  await db.query(
    `insert into private_files (id, org_id, bucket, storage_key, filename, mime_type, size_bytes, visibility, status, uploaded_by)
     values ($1, $2, 'aqi-attachments', $3, 'equivalence.png', 'image/png', 1, 'client', 'ready', $4)`,
    [fileId, ORGS.a, `${ORGS.a}/equivalence/attachment.png`, ownerId],
  );
  await db.query(
    `insert into aqi_attachments (conversation_id, org_id, user_id, private_file_id, kind, filename, mime_type, size_bytes)
     values ($1, $2, $3, $4, 'image', 'equivalence.png', 'image/png', 1)`,
    [conversationId, ORGS.a, ownerId, fileId],
  );
}

// --- capture ----------------------------------------------------------------------------------------------------------------------

async function captureTables() {
  const rls = (await db.query<{ t: string }>("select relname::text as t from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity order by 1")).rows;
  const out: Array<{ name: string; key: string }> = [];
  for (const { t } of rls) {
    const cols = (await db.query<{ name: string; pk: boolean }>(
      `select a.attname::text as name, coalesce(a.attnum = any(i.indkey), false) as pk
       from pg_attribute a left join pg_index i on i.indrelid = a.attrelid and i.indisprimary
       where a.attrelid = $1::regclass and a.attnum > 0 and not a.attisdropped and has_column_privilege('iaq_app_user', a.attrelid, a.attnum, 'select')
       order by a.attnum`,
      [`public.${t}`],
    )).rows;
    if (!cols.length) continue;
    const pk = cols.filter((c) => c.pk);
    const use = pk.length ? pk : cols.filter((c) => !["search_text"].includes(c.name));
    out.push({ name: t, key: `row(${use.map((c) => `"${c.name}"`).join(", ")})::text` });
  }
  return out;
}

async function capture(): Promise<Capture> {
  const result: Capture = new Map();
  for (const p of personas) {
    const seen = new Map<string, string[] | string>();
    await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [p.id]);
      await tx.query("set local role iaq_app_user");
      for (const t of tables) {
        await tx.query("savepoint s");
        try {
          const { rows } = await tx.query<{ k: string }>(`select ${t.key} as k from public.${t.name}`);
          seen.set(t.name, rows.map((r) => r.k).sort());
          await tx.query("release savepoint s");
        } catch (err) {
          await tx.query("rollback to savepoint s");
          seen.set(t.name, `error: ${(err as Error).message}`);
        }
      }
    });
    result.set(p.key, seen);
  }
  return result;
}

function differences(a: Capture, b: Capture): string[] {
  const out: string[] = [];
  for (const [persona, seenA] of a) {
    const seenB = b.get(persona)!;
    for (const [t, va] of seenA) {
      const vb = seenB.get(t);
      if (JSON.stringify(va) === JSON.stringify(vb)) continue;
      if (typeof va === "string" || typeof vb === "string" || !vb) out.push(`${persona} / ${t}: ${JSON.stringify(va).slice(0, 120)} vs ${JSON.stringify(vb).slice(0, 120)}`);
      else out.push(`${persona} / ${t}: only before ${va.filter((x) => !vb.includes(x)).length}, only after ${vb.filter((x) => !va.includes(x)).length}`);
    }
  }
  return out;
}

const keys = (c: Capture, persona: string, table: string): string[] => {
  const v = c.get(persona)?.get(table);
  if (typeof v === "string" || !v) throw new Error(`${persona} / ${table}: ${v}`);
  return v;
};
const countWhere = async (sql: string, params: unknown[] = []) => (await db.query<{ n: number }>(sql, params)).rows[0].n;

// --- the proof --------------------------------------------------------------------------------------------------------------------

beforeAll(async () => {
  db = await openDatabase(ROOT, VERSION);
  expect(await functionBody(db, "permitted_orgs")).toBeNull();
  policiesBefore = await readPolicies(db);
  await seedIdentities();
  await fillTables();
  await seedVisibleAqiAttachment();
  tables = await captureTables();
  first = await capture();
}, LONG);

afterAll(async () => {
  await db?.close();
});

describe(`row-level security before and after ${VERSION} (every table, every persona)`, () => {
  it("seeds rows in at least three organizations for every table with a row-level security read policy", async () => {
    expect(fillFailures).toEqual([]);
    const withPolicy = (await db.query<{ t: string; org: boolean }>(
      `select distinct p.tablename::text as t, exists (select 1 from pg_attribute a where a.attrelid = ('public.' || p.tablename)::regclass and a.attname = 'org_id' and not a.attisdropped) as org
       from pg_policies p where p.schemaname = 'public' and p.cmd in ('SELECT', 'ALL') order by 1`,
    )).rows;
    expect(withPolicy.length).toBeGreaterThan(150);
    const thin: string[] = [];
    for (const { t, org } of withPolicy) {
      const n = await countWhere(org ? `select count(distinct org_id)::int as n from public.${t}` : `select count(*)::int as n from public.${t}`);
      if (n < (org ? 3 : 1)) thin.push(`${t}: ${n}`);
    }
    expect(thin).toEqual([]);
    expect(tables.length).toBeGreaterThan(150);
    expect(personas.length).toBeGreaterThanOrEqual(25);
  });

  it("the personas see meaningfully different things before the migration (the comparison is not vacuous)", async () => {
    const ids = async (table: string, org: string) => (await db.query<{ k: string }>(`select row(id)::text as k from public.${table} where org_id = $1`, [org])).rows.map((r) => r.k);
    const [contactsA, contactsB] = [await ids("contacts", ORGS.a), await ids("contacts", ORGS.b)];
    const ownerA = keys(first, "a-owner", "contacts");
    expect(ownerA.length).toBeGreaterThan(0);
    expect(ownerA.every((k) => contactsA.includes(k))).toBe(true);
    expect(keys(first, "a-member", "contacts")).toEqual(ownerA);
    expect(keys(first, "a-member-no-crm", "contacts")).toEqual([]);
    expect(keys(first, "b-owner", "contacts")).toEqual([]); // an owner override revokes contacts.view (a state the guard trigger forbids)
    const multi = keys(first, "viewer-in-a-admin-in-b", "contacts");
    expect(multi.some((k) => contactsA.includes(k)) && multi.some((k) => contactsB.includes(k))).toBe(true);
    for (const nobody of ["a-owner-revoked", "a-admin-disabled-user", "c-owner-suspended-org", "c-viewer-with-grant-suspended-org", "d-owner-archived-org", "agency-staff-unassigned", "agency-staff-disabled",
      "agency-staff-session-without-assignment", "client-user-with-stray-assignment", "no-memberships", "unknown-user-id", "no-user-id", "agency-super-admin-disabled"]) {
      expect(keys(first, nobody, "contacts"), nobody).toEqual([]);
      expect(keys(first, nobody, "organizations"), nobody).toEqual([]);
    }
    expect(keys(first, "agency-super-admin", "organizations").length).toBe(await countWhere("select count(*)::int as n from organizations"));
    expect(keys(first, "agency-staff-assigned-a-c", "organizations").length).toBe(1);
    // Agency super admins with memberships, for permissions their agency role lacks: only their memberships count.
    expect(await countWhere("select count(*)::int as n from role_permissions where role = 'agency_super_admin' and permission in ('contacts.view', 'companies.view', 'calls.view')")).toBe(0);
    const union = (...lists: string[][]) => [...new Set(lists.flat())].sort();
    const adminMember = "agency-super-admin-owner-g-member-a";
    const ownerG = keys(first, "agency-org-owner", "contacts");
    expect(ownerG.length).toBeGreaterThan(0);
    expect(keys(first, adminMember, "contacts")).toEqual(ownerG); // the agency organization only: contacts.view is revoked in A
    expect(keys(first, adminMember, "crm_companies")).toEqual(union(keys(first, "agency-org-owner", "crm_companies"), keys(first, "a-member", "crm_companies")));
    expect(keys(first, adminMember, "crm_companies").some((k) => keys(first, "a-member", "crm_companies").includes(k))).toBe(true);
    const callsA = await ids("crm_call_records", ORGS.a);
    expect(callsA.length).toBeGreaterThan(0);
    expect(keys(first, adminMember, "crm_call_records")).toEqual(union(keys(first, "agency-org-owner", "crm_call_records"), callsA)); // granted in A
    for (const key of ["agency-super-admin-owner-suspended-c", "agency-super-admin-assigned-b"]) {
      expect(keys(first, key, "contacts"), key).toEqual([]);
      expect(keys(first, key, "crm_companies"), key).toEqual([]);
      expect(keys(first, key, "organizations").length, key).toBe(ORG_LIST.length);
    }
    const ownerConvs = keys(first, "a-owner", "conversations");
    const rep = keys(first, "a-sales_rep", "conversations");
    expect(rep.length).toBeGreaterThan(0);
    expect(rep.length).toBeLessThan(ownerConvs.length);
    expect(rep.every((k) => ownerConvs.includes(k))).toBe(true);
    expect(keys(first, "a-viewer-with-grants", "conversations")).toEqual(ownerConvs);
    let total = 0;
    for (const seen of first.values()) for (const v of seen.values()) if (Array.isArray(v)) total += v.length;
    expect(total).toBeGreaterThan(1000);
    // Every table is visible to someone, and every table whose read policy 0050 rewrites is also hidden from someone, so no comparison is
    // trivially "the same empty set" or "everything". (The tables everyone may read are global catalogs with a `true` policy.)
    const visibleTo = (t: string) => personas.filter((p) => keys(first, p.key, t).length > 0).length;
    const rewritten = new Set(selectPolicies(policiesBefore).map((p) => p.tablename));
    expect(rewritten.size).toBeGreaterThan(140);
    expect(tables.filter((t) => visibleTo(t.name) === 0).map((t) => t.name)).toEqual([]);
    expect(tables.filter((t) => rewritten.has(t.name) && visibleTo(t.name) === personas.length).map((t) => t.name)).toEqual([]);
  });

  it("the committed migration and rollback are exactly what scripts/rls-initplan.ts generates from this schema", async () => {
    const g = await generateFrom(db);
    expect(g.up).toBe(readFileSync(MIGRATION_PATH, "utf8"));
    expect(g.down).toBe(readFileSync(ROLLBACK_PATH, "utf8"));
    expect(g.rewritten).toBeGreaterThanOrEqual(160);
    expect(await readPolicies(db)).toEqual(policiesBefore);
  }, LONG);

  it("with the migration applied, every persona sees exactly the same rows in every table", async () => {
    await runScript(db, readFileSync(MIGRATION_PATH, "utf8"));
    const after = await readPolicies(db);
    const perRow = after.filter((p) => p.cmd === "SELECT" && /app\.(has_permission|can_view_conversation|can_access_org)\(/.test(p.qual ?? ""));
    expect(perRow.map((p) => `${p.tablename}.${p.policyname}`)).toEqual([]);
    expect(after.filter((p) => /app\.(permitted_orgs|accessible_orgs)\(/.test(p.qual ?? "")).length).toBeGreaterThanOrEqual(160);
    expect(after.filter((p) => p.cmd !== "SELECT")).toEqual(policiesBefore.filter((p) => p.cmd !== "SELECT"));
    const second = await capture();
    expect(differences(first, second)).toEqual([]);
  }, LONG);

  it("documents the proof boundary: only can_access_org differs for null or orphaned ids, which the generator rules out", async () => {
    // The current has_permission helper requires an active client for its agency branch, so an orphan or null id is denied.
    // can_access_org still lets an active Super Admin reach any id through staff_assigned, while accessible_orgs lists real rows only.
    // Inactive and unknown users can also get NULL from can_access_org for an active client (the manager-scope expression propagates
    // NULL); accessible_orgs returns an empty set. Both values reject the row in RLS. Every rewritten column must be NOT NULL (or
    // guarded) and backed by a validated organization foreign key.
    const admin = personas.find((p) => p.key === "agency-super-admin")!.id;
    const probe = await db.transaction(async (tx) => {
      await tx.query("select set_config('app.user_id', $1, true)", [admin]);
      await tx.query("set local role iaq_app_user");
      const orphan = randomUUID();
      return (await tx.query<Record<string, boolean | null>>(
        `select app.has_permission($1::uuid, 'agency.crm.read') as per_row_orphan, $1::uuid = any (app.permitted_orgs('agency.crm.read')) as array_orphan,
                app.has_permission(null, 'agency.crm.read') as per_row_null, null::uuid = any (app.permitted_orgs('agency.crm.read')) as array_null,
                app.has_permission($2::uuid, 'agency.crm.read') as per_row_real, $2::uuid = any (app.permitted_orgs('agency.crm.read')) as array_real,
                app.can_access_org($1::uuid) as access_orphan, $1::uuid = any (app.accessible_orgs()) as accessible_orphan,
                app.can_access_org(null) as access_null, null::uuid = any (app.accessible_orgs()) as accessible_null,
                app.can_access_org($2::uuid) as access_real, $2::uuid = any (app.accessible_orgs()) as accessible_real`,
        [orphan, ORGS.a],
      )).rows[0];
    });
    expect(probe).toEqual({
      per_row_orphan: false, array_orphan: false, per_row_null: false, array_null: null, per_row_real: true, array_real: true,
      access_orphan: true, accessible_orphan: false, access_null: true, accessible_null: null, access_real: true, accessible_real: true,
    });
  });

  it("app.permitted_orgs and app.accessible_orgs list exactly the organizations where the per-row helpers are true, for every persona and permission", async () => {
    const named = new Set((await db.query<{ p: string }>("select distinct permission as p from role_permissions")).rows.map((r) => r.p));
    for (const p of selectPolicies(policiesBefore)) for (const m of (p.qual ?? "").matchAll(/app\.has_permission\([^,()]+, '([a-z_.]+)'::text\)/g)) named.add(m[1]);
    for (const p of ["inbox.view", "inbox.view_all"]) named.add(p); // app.can_view_conversation
    const mismatches: string[] = [];
    for (const p of personas) {
      const rows = await db.transaction(async (tx) => {
        await tx.query("select set_config('app.user_id', $1, true)", [p.id]);
        await tx.query("set local role iaq_app_user");
        // The organizations come from a parameter: under row-level security the role could not list them all.
        return (await tx.query<{ org: string; perm: string | null; per_row: boolean; statement: boolean }>(
          `select o.id::text as org, x.perm, app.has_permission(o.id, x.perm) as per_row, o.id = any(x.orgs) as statement
           from (select perm, app.permitted_orgs(perm) as orgs from unnest($1::text[]) perm) x cross join unnest($2::uuid[]) o(id)
           union all
           select o.id::text, null, app.can_access_org(o.id), o.id = any(app.accessible_orgs()) from unnest($2::uuid[]) o(id)`,
          [[...named], ORG_LIST],
        )).rows;
      });
      expect(rows.length).toBe((named.size + 1) * ORG_LIST.length);
      // Policies keep rows only when the predicate is TRUE; FALSE and NULL both reject them. Compare the true sets, not SQL's
      // false-versus-null distinction, which does not change a SELECT policy's result.
      for (const r of rows) if ((r.per_row === true) !== (r.statement === true)) mismatches.push(`${p.key} / ${r.org} / ${r.perm ?? "accessible_orgs"}: per row ${r.per_row}, statement ${r.statement}`);
    }
    expect(named.size).toBeGreaterThan(100);
    expect(mismatches).toEqual([]);
  }, LONG);

  it("staff assignments cost no per-row helper call: only memberships are checked one by one, so agency staff with many clients stay fast", async () => {
    /**
     * Calls of each app function during `sql`, run as the persona (nested calls included). pg_stat_xact_user_functions also holds counts
     * of earlier transactions until the backend flushes them, so this takes the difference around the statement.
     */
    const calls = (userId: string, sql: string, prepare?: (tx: Transaction) => Promise<unknown>) => db.transaction(async (tx) => {
      const counts = async () => new Map((await tx.query<{ f: string; n: number }>("select funcname::text as f, calls::int as n from pg_stat_xact_user_functions where schemaname = 'app'")).rows.map((r) => [r.f, r.n]));
      await prepare?.(tx);
      await tx.query("set local track_functions = 'all'");
      const before = await counts();
      await tx.query("select set_config('app.user_id', $1, true)", [userId]);
      await tx.query("set local role iaq_app_user");
      const result = (await tx.query<{ n: number }>(sql)).rows[0].n;
      await tx.query("reset role");
      const after = await counts();
      await tx.rollback();
      return { result, ...Object.fromEntries([...after].map(([f, n]) => [f, n - (before.get(f) ?? 0)])) } as Record<string, number>;
    });
    const memberships = async (userId: string) => countWhere("select count(*)::int as n from organization_memberships where user_id = $1", [userId]);
    const perRow = (c: Record<string, number>, ...names: string[]) => names.reduce((n, f) => n + (c[f] ?? 0), 0);
    for (const p of personas.filter((x) => x.id)) {
      const m = await memberships(p.id);
      for (const perm of ["contacts.view", "crm.view", "appointments.view", "usage.view", "inbox.view_all"]) {
        const c = await calls(p.id, `select cardinality(app.permitted_orgs('${perm}'))::int as n`);
        expect(c.has_permission ?? 0, `${p.key} ${perm}: app.has_permission calls`).toBeLessThanOrEqual(m);
        expect(perRow(c, "can_access_org"), `${p.key} ${perm}`).toBe(0);
      }
      const a = await calls(p.id, "select cardinality(app.accessible_orgs())::int as n");
      expect(perRow(a, "can_access_org", "staff_assigned", "has_permission"), `${p.key}: per-row calls in app.accessible_orgs`).toBe(0);
      expect(a.org_role ?? 0, p.key).toBeLessThanOrEqual(m);
    }
    // Agency staff assigned to 60 more clients: the same (zero) per-row calls, and every active client assignment is listed.
    const staff = personas.find((x) => x.key === "agency-staff-assigned-a-c")!.id;
    const extra = Array.from({ length: 60 }, () => randomUUID());
    const addClients = async (tx: Transaction) => {
      for (const id of extra) {
        await tx.query("insert into organizations (id, name, slug, kind, status) values ($1, 'Equiv extra', $2, 'client', 'active')", [id, `equiv-extra-${id.slice(0, 8)}`]);
        await tx.query("insert into staff_assignments (org_id, user_id) values ($1, $2)", [id, staff]);
      }
    };
    const many = await calls(staff, "select cardinality(app.permitted_orgs('usage.view'))::int as n", addClients);
    const staffHolds = (await countWhere("select count(*)::int as n from role_permissions where role = 'agency_staff' and permission = 'usage.view'")) > 0;
    expect(many.result).toBe(staffHolds ? extra.length + 1 : 0);
    expect(perRow(many, "has_permission", "staff_assigned", "can_access_org")).toBe(0);
    const reach = await calls(staff, "select cardinality(app.accessible_orgs())::int as n", addClients);
    expect(reach.result).toBe(extra.length + 1);
    expect(perRow(reach, "has_permission", "staff_assigned", "can_access_org")).toBe(0);
  }, LONG);

  it("the rollback restores every policy expression exactly, drops the helpers, and every persona again sees the original rows", async () => {
    await runScript(db, readFileSync(ROLLBACK_PATH, "utf8"));
    expect(await readPolicies(db)).toEqual(policiesBefore);
    expect(await functionBody(db, "permitted_orgs")).toBeNull();
    expect(await functionBody(db, "accessible_orgs")).toBeNull();
    expect(await functionBody(db, "rls_initplan_expect")).toBeNull();
    const third = await capture();
    expect(differences(first, third)).toEqual([]);
  }, LONG);

  it("refuses to run over a policy that drifted from the expression it was generated from, and changes nothing", async () => {
    await db.query("alter policy contacts_select on public.contacts using (app.has_permission(org_id, 'crm.view'))");
    await expect(runScript(db, readFileSync(MIGRATION_PATH, "utf8"))).rejects.toThrow(/does not have the expected expression/);
    expect(await functionBody(db, "permitted_orgs")).toBeNull();
    const now = await readPolicies(db);
    expect(now.filter((p) => p.policyname !== "contacts_select")).toEqual(policiesBefore.filter((p) => p.policyname !== "contacts_select"));
    await db.query(`alter policy contacts_select on public.contacts using (${policiesBefore.find((p) => p.tablename === "contacts" && p.policyname === "contacts_select")!.qual})`);
    expect(await readPolicies(db)).toEqual(policiesBefore);
  }, LONG);

  it("refuses to run (and to generate) when a helper the proof reads differs from the definition it was proven against, and changes nothing", async () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    const body = await functionBody(db, "has_permission");
    const def = (await db.query<{ def: string }>("select pg_get_functiondef('app.has_permission(uuid, text)'::regprocedure) as def")).rows[0].def;
    const restore = async () => {
      await db.exec(def);
      expect(await functionBody(db, "has_permission")).toBe(body);
    };
    // A hotfix on the target: agency super admins also need a staff assignment. Every policy text is unchanged, so only the helper check
    // can notice; without it 0050 would show super admins rows the per-row policy hides.
    const hotfix = def.replace("app.user_can_access_org(app.current_user_id(), p_org)", "false");
    expect(hotfix).not.toBe(def);
    await db.exec(hotfix);
    try {
      await expect(runScript(db, migration)).rejects.toThrow(/app\.has_permission differs from the definition this file was proven against; nothing was changed/);
      expect(await functionBody(db, "permitted_orgs")).toBeNull();
      expect(await functionBody(db, "rls_initplan_expect_function")).toBeNull();
      expect(await readPolicies(db)).toEqual(policiesBefore);
      await expect(generateFrom(db)).rejects.toThrow(/a helper the RLS proof relies on differs from the reviewed definition; nothing was generated[\s\S]*app\.has_permission has fingerprint/);
    } finally {
      await restore();
    }
    // A second overload is refused too.
    await db.exec("create function app.has_permission(p_org uuid, p_permission text, p_extra integer) returns boolean language sql stable as $$ select true $$");
    try {
      await expect(runScript(db, migration)).rejects.toThrow(/app\.has_permission differs/);
      await expect(generateFrom(db)).rejects.toThrow(/app\.has_permission has 2 overloads/);
    } finally {
      await db.exec("drop function app.has_permission(uuid, text, integer)");
    }
    // Whitespace alone (CRLF line endings, re-indentation by a dump tool) is not drift: the file applies, and its rollback undoes it.
    await db.exec(def.replace(/\n/g, "\r\n    "));
    try {
      expect(await functionBody(db, "has_permission")).not.toBe(body);
      await runScript(db, migration);
      expect(await functionBody(db, "permitted_orgs")).not.toBeNull();
      await runScript(db, readFileSync(ROLLBACK_PATH, "utf8"));
    } finally {
      await restore();
    }
    expect(await readPolicies(db)).toEqual(policiesBefore);
    expect(await functionBody(db, "permitted_orgs")).toBeNull();
  }, LONG);

  it("refuses a target helper whose SECURITY DEFINER owner changed", async () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    const owner = (await db.query<{ owner: string }>("select p.proowner::regrole::text as owner from pg_proc p where p.oid = 'app.has_permission(uuid, text)'::regprocedure")).rows[0].owner;
    const otherOwner = owner === "authenticated" ? "iaq_app_user" : "authenticated";
    const quoteRole = (role: string) => `\"${role.replaceAll('"', '\"')}\"`;
    await db.query("grant create on schema app to authenticated, iaq_app_user");
    await db.query(`alter function app.has_permission(uuid, text) owner to ${quoteRole(otherOwner)}`);
    try {
      await expect(runScript(db, migration)).rejects.toThrow(/app\.has_permission differs from the definition this file was proven against/);
      expect(await functionBody(db, "permitted_orgs")).toBeNull();
      expect(await readPolicies(db)).toEqual(policiesBefore);
    } finally {
      await db.query(`alter function app.has_permission(uuid, text) owner to ${quoteRole(owner)}`);
      await db.query("revoke create on schema app from authenticated, iaq_app_user");
    }
  }, LONG);

  it("rechecks the nullability and validated organization FK assumptions on the migration target", async () => {
    const migration = readFileSync(MIGRATION_PATH, "utf8");
    await db.query("alter table public.contacts alter column org_id drop not null");
    try {
      await expect(runScript(db, migration)).rejects.toThrow(/public\.contacts\.org_id is missing or no longer satisfies the nullability proof/);
      expect(await functionBody(db, "permitted_orgs")).toBeNull();
      expect(await readPolicies(db)).toEqual(policiesBefore);
    } finally {
      await db.query("alter table public.contacts alter column org_id set not null");
    }

    const fk = (await db.query<{ name: string; definition: string }>(
      `select k.conname::text as name, pg_get_constraintdef(k.oid) as definition
       from pg_constraint k where k.contype = 'f' and k.conrelid = 'public.contacts'::regclass and k.confrelid = 'public.organizations'::regclass
         and (select a.attnum from pg_attribute a where a.attrelid = k.conrelid and a.attname = 'org_id') = any(k.conkey) limit 1`,
    )).rows[0];
    expect(fk).toBeTruthy();
    const quoted = `"${fk.name.replaceAll('"', '""')}"`;
    await db.query(`alter table public.contacts drop constraint ${quoted}`);
    await db.query(`alter table public.contacts add constraint ${quoted} ${fk.definition} not valid`);
    try {
      await expect(runScript(db, migration)).rejects.toThrow(/public\.contacts\.org_id no longer has a validated foreign key chain/);
      expect(await functionBody(db, "permitted_orgs")).toBeNull();
      expect(await readPolicies(db)).toEqual(policiesBefore);
    } finally {
      await db.query(`alter table public.contacts drop constraint ${quoted}`);
      await db.query(`alter table public.contacts add constraint ${quoted} ${fk.definition}`);
    }
  }, LONG);

  it("the staging verifier (scripts/rls-initplan.ts --verify-staging) finds no difference here and leaves nothing behind", async () => {
    class Rollback extends Error {}
    let result: Awaited<ReturnType<typeof verifyInTransaction>> | null = null;
    await expect(db.transaction(async (tx) => {
      result = await verifyInTransaction(tx, readFileSync(MIGRATION_PATH, "utf8"), readFileSync(ROLLBACK_PATH, "utf8"), 100, 100);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    const users = personas.filter((p) => p.key !== "unknown-user-id" && p.key !== "no-user-id").length;
    expect(result).toMatchObject({ personas: users + 1, differences: [], rollbackRestoresPolicies: true });
    expect(Object.values(result!.strata).reduce((a, b) => a + b, 0)).toBe(users);
    expect(result!.clientMembers).toBeGreaterThan(5);
    expect(result!.tables).toBe(tables.length);
    expect(result!.rowsSeen).toBeGreaterThan(1000);
    expect(await readPolicies(db)).toEqual(policiesBefore);
    expect(await functionBody(db, "permitted_orgs")).toBeNull();
  }, LONG);

  it("the staging verifier takes its users round-robin across strata, so a small sample still compares client members", async () => {
    // The agency has more than 5 users here; a sample of the first 5 agency-first users would have compared no client at all.
    expect(await countWhere("select count(*)::int as n from users where platform_role <> 'none'")).toBeGreaterThan(5);
    const all = await choosePersonas(db, 1000, 1000);
    expect(Object.keys(all.strata).length).toBeGreaterThan(15);
    expect(Object.keys(all.strata)).toContain("none/active sales_rep/active in a active org");
    expect(Object.keys(all.strata).some((s) => s.includes("+overrides"))).toBe(true);
    expect(Object.keys(all.strata).some((s) => s.includes(" in a suspended org"))).toBe(true);
    const small = await choosePersonas(db, 5, 1);
    expect(small.ids.length).toBe(5);
    expect(Object.values(small.strata)).toEqual([1, 1, 1, 1, 1]);
    expect(small.clientMembers).toBeGreaterThan(0);
    expect(Object.keys(small.strata).filter((s) => s.startsWith("none/")).length).toBeGreaterThanOrEqual(2);
    expect(Object.keys(small.strata).some((s) => s.startsWith("agency_staff/"))).toBe(true);
    expect(Object.keys(small.strata).some((s) => s.startsWith("agency_super_admin/"))).toBe(true);
    // The conversation stratum: members who own or are assigned a conversation without inbox.view_all (the sales rep and the viewer
    // here; the viewer with an inbox.view_all grant is not one of them).
    const conv = "owns or is assigned a conversation without inbox.view_all";
    const inConv = (await db.query<{ id: string; stratum: string }>(PERSONA_STRATA_SQL, [1000])).rows.filter((r) => r.stratum === conv).map((r) => r.id);
    const idOf = (key: string) => personas.find((p) => p.key === key)!.id;
    expect(inConv).toContain(idOf("a-sales_rep"));
    expect(inConv).toContain(idOf("a-viewer"));
    expect(inConv).not.toContain(idOf("a-owner"));
    class Rollback extends Error {}
    let result: Awaited<ReturnType<typeof verifyInTransaction>> | null = null;
    await expect(db.transaction(async (tx) => {
      result = await verifyInTransaction(tx, readFileSync(MIGRATION_PATH, "utf8"), readFileSync(ROLLBACK_PATH, "utf8"), 5, 1);
      throw new Rollback();
    })).rejects.toBeInstanceOf(Rollback);
    expect(result).toMatchObject({ personas: 6, strata: small.strata, clientMembers: small.clientMembers, differences: [], rollbackRestoresPolicies: true });
    expect(await readPolicies(db)).toEqual(policiesBefore);
  }, LONG);
});
