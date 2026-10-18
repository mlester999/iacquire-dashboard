/**
 * Generator for the row-level-security InitPlan migration (supabase/migrations/0050_rls_initplan.sql) and its rollback.
 *
 *   node --import tsx scripts/rls-initplan.ts            writes both files
 *   node --import tsx scripts/rls-initplan.ts --check    exits 1 when the committed files differ from what it would write
 *
 * Two modes take a restored copy of the hosted database (never production; the URL is passed on the command line, never read from .env)
 * and run everything inside one transaction that is rolled back:
 *   --verify-staging <url> [--personas 25] [--per-stratum 3] --yes-this-is-a-restored-copy
 *       captures what real users see in every table before 0050, with it and after its rollback, and reports any difference; the
 *       users are taken round-robin from strata (platform role, membership role and status, organization status, overrides,
 *       assignments, several organizations, conversations without inbox.view_all), and it exits 1 if no client member was compared;
 *   --from-database <url> [--check] --yes-this-is-a-restored-copy
 *       generates the two files from that copy's own catalog (for a PostgreSQL version that prints expressions differently).
 *
 * By default it never connects to any server: it builds a throwaway in-memory PGlite database, applies
 * supabase/local-compat.sql and every migration numbered below 0050, reads pg_policies, and spells out one reviewed
 * `alter policy` per SELECT policy that calls a per-row permission helper. Re-run it whenever a migration before 0050 adds or
 * changes a SELECT policy (tests/rls-initplan-guard.test.ts fails until you do).
 *
 * The rewrite (see docs/rls-performance-rollout.md for the proof):
 *   app.has_permission(C, 'p')                 ->  (C = ANY ((SELECT app.permitted_orgs('p'))::uuid[]))
 *   app.can_access_org(C)                      ->  (C = ANY ((SELECT app.accessible_orgs())::uuid[]))
 *   app.can_view_conversation(C, OWNER, ASSIGNED)
 *     -> ((C = ANY (permitted 'inbox.view')) AND ((C = ANY (permitted 'inbox.view_all')) OR (OWNER = (SELECT app.current_user_id()))
 *        OR (ASSIGNED = (SELECT app.current_user_id()))))       (the body of can_view_conversation, expanded)
 * The sub-selects are uncorrelated, so PostgreSQL evaluates each once per statement (an InitPlan) instead of once per row. The
 * `::uuid[]` is required: without it `x = ANY ((SELECT ...))` parses as ANY over the sub-select's rows (PostgreSQL prints the same
 * dummy cast when it deparses the expression, for the same reason).
 *
 * The generator refuses (throws) when a call has an unexpected shape, when a rewritten column could be NULL without a guard, or when
 * it is not backed by a validated foreign key chain to organizations(id): the equivalence proof needs both. It also refuses when a
 * helper the proof reads (PROOF_HELPERS) is missing, overloaded or no longer has its reviewed fingerprint (PINNED), and the migration
 * re-checks those definitions on the target database before changing anything.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { citext } from "@electric-sql/pglite/contrib/citext";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";

export const VERSION = "0050";
export const NAME = "0050_rls_initplan";
export const MIGRATION_PATH = `supabase/migrations/${NAME}.sql`;
export const ROLLBACK_PATH = `supabase/rollbacks/${NAME}.down.sql`;

export const PER_ROW_HELPERS = ["has_permission", "can_view_conversation", "can_access_org"] as const;
export type PerRowHelper = (typeof PER_ROW_HELPERS)[number];

/**
 * Policies for other commands that call a per-row helper and are deliberately left alone. An ALL policy also applies to reads, so it
 * is listed here by name; the guard test fails if this list and the schema disagree.
 */
export const LEFT_ALONE_ALL_POLICIES = ["notification_preferences.notification_prefs_all"];

/** The body of app.can_view_conversation that the expansion copies. The generator refuses to expand a different body. */
export const CAN_VIEW_CONVERSATION_BODY =
  "select app.has_permission(p_org, 'inbox.view') and (app.has_permission(p_org, 'inbox.view_all') or p_owner = app.current_user_id() or p_assigned = app.current_user_id())";

export const HELPERS_SQL = `create function app.permitted_orgs(p_permission text) returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  -- app.has_permission from migration 0042 combines membership grants with scoped agency access.
  -- CRM permissions in the agency branch also require a current support session in the correct mode.
  select coalesce(array_agg(c.org_id), '{}'::uuid[])
  from (
    select m.org_id from organization_memberships m
    where m.user_id = (select app.current_user_id()) and app.has_permission(m.org_id, p_permission)
    union
    select o.id from organizations o
    where o.kind = 'client' and o.status not in ('suspended', 'archived')
      and (select app.user_has_agency_permission(app.current_user_id(), p_permission))
      and (
        (select app.is_agency_admin())
        or ((select app.platform_role()) = 'agency_manager' and (
          coalesce((select s.scope_mode from agency_user_client_scopes s where s.user_id = (select app.current_user_id())), 'all_clients') = 'all_clients'
          or exists (select 1 from staff_assignments a where a.org_id = o.id and a.user_id = (select app.current_user_id()))
        ))
        or ((select app.platform_role()) in ('agency_staff', 'agency_manager')
          and exists (select 1 from staff_assignments a where a.org_id = o.id and a.user_id = (select app.current_user_id())))
      )
      and (
        p_permission not in (
          'crm.view', 'contacts.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge', 'contacts.delete', 'contacts.import', 'contacts.export', 'contacts.bulk',
          'companies.view', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage', 'smartlists.share', 'sales.view', 'pipelines.manage',
          'opportunities.view', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete', 'appointments.view', 'appointments.book',
          'appointments.manage', 'calendars.manage', 'calendars.connect', 'tasks.manage', 'notes.write', 'inbox.view', 'inbox.view_all',
          'inbox.reply', 'inbox.assign', 'inbox.notes', 'inbox.resume_ai', 'workflows.view', 'workflows.manage', 'templates.manage',
          'campaigns.manage', 'campaigns.send', 'forms.manage', 'reviews.manage', 'calls.view', 'analytics.view', 'analytics.export',
          'crm.provider.manage', 'crm.api.manage', 'crm.permissions.manage'
        )
        or exists (
          select 1 from crm_support_sessions s
          where s.org_id = o.id and s.user_id = (select app.current_user_id())
            and s.ended_at is null and s.expires_at > now()
            and (
              (s.mode = 'read' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view'
              ]::text[]))
              or (s.mode = 'write' and p_permission = any(array[
                'crm.view', 'contacts.view', 'companies.view', 'sales.view', 'appointments.view', 'inbox.view', 'inbox.view_all',
                'workflows.view', 'analytics.view', 'calls.view', 'team.view', 'contacts.create', 'contacts.edit', 'contacts.assign', 'contacts.merge',
                'contacts.import', 'contacts.delete', 'contacts.export', 'contacts.bulk', 'companies.create', 'companies.edit', 'companies.delete', 'tags.manage', 'fields.manage',
                'smartlists.share', 'pipelines.manage', 'opportunities.create', 'opportunities.edit', 'opportunities.reopen', 'opportunities.delete',
                'calendars.manage', 'appointments.book', 'appointments.manage', 'notes.write', 'inbox.reply', 'inbox.notes',
                'inbox.assign', 'tasks.manage', 'workflows.manage', 'templates.manage', 'campaigns.manage', 'analytics.export', 'forms.manage', 'reviews.manage'
              ]::text[]))
            )
        )
      )
  ) c
$$;
revoke all on function app.permitted_orgs(text) from public;
grant execute on function app.permitted_orgs(text) to iaq_app_user;

create function app.accessible_orgs() returns uuid[]
language sql stable security definer set search_path = public, pg_temp
as $$
  -- Exactly the organizations where app.can_access_org(org) is true, including manager scope modes.
  select case
    when (select app.is_agency_admin()) then (select coalesce(array_agg(o.id), '{}'::uuid[]) from organizations o)
    else (
      select coalesce(array_agg(c.org_id), '{}'::uuid[])
      from (
        select m.org_id from organization_memberships m
        where m.user_id = (select app.current_user_id()) and app.org_role(m.org_id) is not null
        union
        select o.id from organizations o
        where o.kind = 'client' and o.status not in ('suspended', 'archived')
          and (
            ((select app.platform_role()) = 'agency_manager' and
              coalesce((select s.scope_mode from agency_user_client_scopes s where s.user_id = (select app.current_user_id())), 'all_clients') = 'all_clients')
            or ((select app.platform_role()) in ('agency_staff', 'agency_manager') and
              exists (select 1 from staff_assignments a where a.org_id = o.id and a.user_id = (select app.current_user_id())))
          )
      ) c)
  end
$$;
revoke all on function app.accessible_orgs() from public;
grant execute on function app.accessible_orgs() to iaq_app_user;`;

// pg_policies prints table names relative to the search_path, so this one matches readPolicies (public, pg_temp).
const EXPECT_SQL = `create function app.rls_initplan_expect(p_table text, p_policy text, p_qual text) returns void
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = p_table and policyname = p_policy and cmd = 'SELECT'
      and regexp_replace(qual, '\\s+', ' ', 'g') = regexp_replace(p_qual, '\\s+', ' ', 'g')
  ) then
    raise exception 'rls initplan: policy % on public.% does not have the expected expression; nothing was changed. Regenerate with scripts/rls-initplan.ts against a copy of this database', p_policy, p_table;
  end if;
end
$$;
revoke all on function app.rls_initplan_expect(text, text, text) from public;`;

const DROP_EXPECT_SQL = "drop function app.rls_initplan_expect(text, text, text);";

/**
 * The definitions the equivalence proof reads (docs/rls-performance-rollout.md): the two statement-level helpers are exact only while
 * these are what the proof was made against. Each must exist exactly once in the app schema with the fingerprint pinned below; the
 * generator refuses otherwise, and the migration it writes re-checks each one on the target database before changing anything.
 */
export const PROOF_HELPERS = [
  "auth_uid",
  "can_access_org",
  "can_view_conversation",
  "current_user_id",
  "has_permission",
  "is_agency_admin",
  "is_agency_staff",
  "org_role",
  "platform_role",
  "profile_id_for_auth_user",
  "staff_assigned",
  "user_can_access_org",
  "user_has_agency_permission",
] as const;

/** The two helpers this migration adds. Their bodies are HELPERS_SQL; the guard test pins them too. */
export const STATEMENT_HELPERS = ["accessible_orgs", "permitted_orgs"] as const;

/**
 * Reviewed fingerprints (see `fingerprint`, including SECURITY DEFINER owner). If one of PROOF_HELPERS changes, re-check the proof and the candidate sets in
 * app.permitted_orgs / app.accessible_orgs (memberships, staff assignments, every organization for an agency super admin) before
 * updating it here; if HELPERS_SQL changes, re-check the same and update its two entries.
 */
export const PINNED: Record<(typeof PROOF_HELPERS)[number] | (typeof STATEMENT_HELPERS)[number], string> = {
  accessible_orgs: "e21c677a6edbd524",
  auth_uid: "a713cf18046c7fa7",
  can_access_org: "0553c4f3cd613e21",
  can_view_conversation: "58c07835f8ceddd9",
  current_user_id: "37fc7ef648d83d65",
  has_permission: "8f6ce799b018bd96",
  is_agency_admin: "162fd66479e9b65b",
  is_agency_staff: "06d76041ea713b64",
  org_role: "95ceefe1cfe35bfc",
  permitted_orgs: "2a1defad710bb46e",
  platform_role: "fd56ce907df13888",
  profile_id_for_auth_user: "d04a64992210cca0",
  staff_assigned: "0b660d727156b021",
  user_can_access_org: "6df44ee360f87f17",
  user_has_agency_permission: "6ba1cfd1df55c93e",
};

/** One app-schema function as pg_proc stores it. `normalized` is prosrc with whitespace runs collapsed, computed by the server. */
export interface HelperDefinition {
  name: string;
  secdef: boolean;
  vol: string;
  config: string;
  args: string;
  owner: string;
  src: string;
  normalized: string;
}

/** sha256 over owner | security definer | volatility | settings | identity arguments | whitespace-normalized source, first 16 hex characters. */
export function fingerprint(d: Pick<HelperDefinition, "owner" | "secdef" | "vol" | "config" | "args" | "src">): string {
  return createHash("sha256").update([d.owner, d.secdef, d.vol, d.config ?? "", d.args, normalize(d.src)].join("|")).digest("hex").slice(0, 16);
}

/** Every overload of the named functions in the app schema. */
export async function readHelperDefinitions(db: Db, names: readonly string[]): Promise<HelperDefinition[]> {
  const { rows } = await db.query<HelperDefinition>(
    `select p.proname::text as name, p.prosecdef as secdef, p.provolatile::text as vol, coalesce(array_to_string(p.proconfig, ','), '') as config,
            p.proowner::regrole::text as owner,
            pg_get_function_identity_arguments(p.oid) as args, p.prosrc as src, btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) as normalized
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'app' and p.proname = any($1::text[]) order by 1, 5`,
    [[...names]],
  );
  return rows;
}

/** Why the definitions differ from what the proof was made against: a missing helper, an extra overload or a changed fingerprint. */
export function helperDrift(rows: HelperDefinition[], names: readonly (keyof typeof PINNED)[] = PROOF_HELPERS): string[] {
  const out: string[] = [];
  for (const name of names) {
    const mine = rows.filter((r) => r.name === name);
    if (mine.length === 0) out.push(`app.${name} does not exist`);
    else if (mine.length > 1) out.push(`app.${name} has ${mine.length} overloads (${mine.map((r) => `(${r.args})`).join(", ")})`);
    else if (fingerprint(mine[0]) !== PINNED[name]) out.push(`app.${name} has fingerprint ${fingerprint(mine[0])}, reviewed ${PINNED[name]}:\n${mine[0].src}`);
  }
  return out;
}

// Each helper the proof reads must exist exactly once with the definition the file was generated from. prosrc is stored verbatim for
// these functions (and pg_dump / restore keeps it), so whitespace is the only thing normalized.
const EXPECT_FUNCTION_SQL = `create function app.rls_initplan_expect_function(p_name text, p_args text, p_secdef boolean, p_volatile text, p_config text, p_owner text, p_src text) returns void
language plpgsql set search_path = public, pg_temp
as $$
begin
  if (select count(*) from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname = p_name) <> 1 or not exists (
    select 1 from pg_proc p
    where p.pronamespace = 'app'::regnamespace and p.proname = p_name
      and pg_get_function_identity_arguments(p.oid) = p_args and p.prosecdef = p_secdef and p.provolatile::text = p_volatile
      and p.proowner::regrole::text = p_owner
      and coalesce(array_to_string(p.proconfig, ','), '') = p_config
      and btrim(regexp_replace(p.prosrc, '\\s+', ' ', 'g')) = p_src
  ) then
    raise exception 'rls initplan: app.% differs from the definition this file was proven against; nothing was changed. Re-check the proof in docs/rls-performance-rollout.md, then regenerate with scripts/rls-initplan.ts', p_name;
  end if;
end
$$;
revoke all on function app.rls_initplan_expect_function(text, text, boolean, text, text, text, text) from public;`;

const DROP_EXPECT_FUNCTION_SQL = "drop function app.rls_initplan_expect_function(text, text, boolean, text, text, text, text);";

// Re-check the generator's NOT NULL / FK proof on the target schema before changing any policy. A fresh generator run alone is not enough:
// a restored or hand-edited target could have drifted since it was generated.
const EXPECT_COLUMN_SQL = `create function app.rls_initplan_expect_column(p_table text, p_column text, p_require_not_null boolean) returns void
language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    where n.nspname = 'public' and c.relname = p_table and a.attname = p_column
      and (not p_require_not_null or a.attnotnull)
  ) then
    raise exception 'rls initplan: public.%.% is missing or no longer satisfies the nullability proof; nothing was changed.', p_table, p_column;
  end if;
  if not exists (
    with recursive walk(relid, attnum, depth, visited) as (
      select c.oid, a.attnum, 0, array[format('%s:%s', c.oid, a.attnum)]::text[]
      from pg_class c join pg_namespace n on n.oid = c.relnamespace
        join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
      where n.nspname = 'public' and c.relname = p_table and a.attname = p_column
      union all
      select k.confrelid, dst.attnum, w.depth + 1, w.visited || format('%s:%s', k.confrelid, dst.attnum)
      from walk w join pg_constraint k on k.conrelid = w.relid and k.contype = 'f' and k.convalidated
        join lateral unnest(k.conkey) with ordinality src(attnum, ord) on src.attnum = w.attnum
        join lateral unnest(k.confkey) with ordinality dst(attnum, ord) on dst.ord = src.ord
        join pg_class source_table on source_table.oid = k.conrelid
        join pg_namespace source_ns on source_ns.oid = source_table.relnamespace
        join pg_attribute source_column on source_column.attrelid = k.conrelid and source_column.attnum = src.attnum and not source_column.attisdropped
      where source_ns.nspname = 'public' and w.depth < 8
        and (k.confmatchtype = 'f' or not exists (
          select 1 from unnest(k.conkey) other(attnum)
            join pg_attribute other_column on other_column.attrelid = k.conrelid and other_column.attnum = other.attnum and not other_column.attisdropped
          where other.attnum <> src.attnum and not other_column.attnotnull
        ))
        and format('%s:%s', k.confrelid, dst.attnum) <> all(w.visited)
    )
    select 1 from walk w join pg_class c on c.oid = w.relid join pg_namespace n on n.oid = c.relnamespace
      join pg_attribute a on a.attrelid = c.oid and a.attnum = w.attnum and not a.attisdropped
    where n.nspname = 'public' and c.relname = 'organizations' and a.attname = 'id'
  ) then
    raise exception 'rls initplan: public.%.% no longer has a validated foreign key chain to public.organizations(id); nothing was changed.', p_table, p_column;
  end if;
end
$$;
revoke all on function app.rls_initplan_expect_column(text, text, boolean) from public;`;

const DROP_EXPECT_COLUMN_SQL = "drop function app.rls_initplan_expect_column(text, text, boolean);";

// Each alter policy takes an ACCESS EXCLUSIVE lock that is held until the file's transaction commits. Waiting behind a long-running
// reader would keep every lock already taken and queue all reads of those tables, so give up after 5 s instead (nothing changes).
const LOCK_TIMEOUT_SQL = "set local lock_timeout = '5s';";

// ------------------------------------------------------------------------------------------------------------------------------
// Expression parsing (deparsed policy text from pg_policies)
// ------------------------------------------------------------------------------------------------------------------------------

export interface HelperCall {
  helper: PerRowHelper;
  start: number;
  end: number;
  args: string[];
}

const COLUMN_REF = /^(?:[a-z_][a-z0-9_]*\.)?[a-z_][a-z0-9_]*$/;
const TEXT_LITERAL = /^'(?:[^']|'')*'::text$/;

/** Index just past a quoted token starting at `i` ('...' or "..."; a doubled quote is an escaped quote). */
function skipQuoted(s: string, i: number): number {
  const q = s[i];
  let j = i + 1;
  while (j < s.length) {
    if (s[j] === q) {
      if (s[j + 1] === q) j += 2;
      else return j + 1;
    } else j++;
  }
  throw new Error(`Unterminated quoted token in: ${s}`);
}

/** Pairs of matching parentheses, outside literals. */
function parenPairs(s: string): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  const stack: number[] = [];
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(s, i);
      continue;
    }
    if (ch === "(") stack.push(i);
    else if (ch === ")") {
      const o = stack.pop();
      if (o === undefined) throw new Error(`Unbalanced parentheses in: ${s}`);
      pairs.push([o, i]);
    }
    i++;
  }
  if (stack.length) throw new Error(`Unbalanced parentheses in: ${s}`);
  return pairs;
}

/** Splits `s` at top-level occurrences of `sep` (outside parentheses and literals). */
function splitTop(s: string, sep: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let last = 0;
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(s, i);
      continue;
    }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (depth === 0 && s.startsWith(sep, i)) {
      parts.push(s.slice(last, i));
      i += sep.length;
      last = i;
      continue;
    }
    i++;
  }
  parts.push(s.slice(last));
  return parts.map((p) => p.trim());
}

/** Every call of a per-row helper in a deparsed expression, with its arguments. */
export function findHelperCalls(expr: string): HelperCall[] {
  const calls: HelperCall[] = [];
  const re = new RegExp(`^app\\.(${PER_ROW_HELPERS.join("|")})\\(`);
  for (let i = 0; i < expr.length; ) {
    const ch = expr[i];
    if (ch === "'" || ch === '"') {
      i = skipQuoted(expr, i);
      continue;
    }
    const m = re.exec(expr.slice(i, i + 40));
    if (m && !/[A-Za-z0-9_.]/.test(expr[i - 1] ?? "")) {
      const open = i + m[0].length - 1;
      const close = parenPairs(expr).find(([o]) => o === open)?.[1];
      if (close === undefined) throw new Error(`Unbalanced call in: ${expr}`);
      const args = splitTop(expr.slice(open + 1, close), ",");
      calls.push({ helper: m[1] as PerRowHelper, start: i, end: close + 1, args });
      i = close + 1;
      continue;
    }
    i++;
  }
  return calls;
}

function replacementFor(call: HelperCall, where: string): string {
  const { helper, args } = call;
  for (const a of args) if (findHelperCalls(a).length) throw new Error(`${where}: nested helper call ${a}`);
  const col = (a: string) => {
    if (!COLUMN_REF.test(a)) throw new Error(`${where}: app.${helper} argument "${a}" is not a plain column reference`);
    return a;
  };
  if (helper === "has_permission") {
    if (args.length !== 2 || !TEXT_LITERAL.test(args[1])) throw new Error(`${where}: unexpected app.has_permission(${args.join(", ")})`);
    return `(${col(args[0])} = ANY ((SELECT app.permitted_orgs(${args[1]}))::uuid[]))`;
  }
  if (helper === "can_access_org") {
    if (args.length !== 1) throw new Error(`${where}: unexpected app.can_access_org(${args.join(", ")})`);
    return `(${col(args[0])} = ANY ((SELECT app.accessible_orgs())::uuid[]))`;
  }
  if (args.length !== 3) throw new Error(`${where}: unexpected app.can_view_conversation(${args.join(", ")})`);
  const [org, owner, assigned] = args.map(col);
  return (
    `((${org} = ANY ((SELECT app.permitted_orgs('inbox.view'::text))::uuid[])) AND ((${org} = ANY ((SELECT app.permitted_orgs('inbox.view_all'::text))::uuid[]))` +
    ` OR (${owner} = (SELECT app.current_user_id())) OR (${assigned} = (SELECT app.current_user_id()))))`
  );
}

/** The rewritten expression, or null when it calls no per-row helper. Throws on any call it cannot rewrite mechanically. */
export function rewriteExpression(expr: string, where = "policy"): string | null {
  const calls = findHelperCalls(expr);
  if (!calls.length) return null;
  let out = expr;
  for (const call of [...calls].reverse()) out = out.slice(0, call.start) + replacementFor(call, where) + out.slice(call.end);
  return out;
}

/** True when a surrounding boolean guard makes a nullable organization reference safe to rewrite. */
export function nullGuarded(expr: string, call: HelperCall): boolean {
  const enclosing = parenPairs(expr).filter(([o, c]) => o < call.start && c >= call.end).sort((a, b) => b[0] - a[0])[0];
  if (!enclosing) return false;
  const group = expr.slice(enclosing[0] + 1, enclosing[1]);
  const disjunction = splitTop(group, " OR ");
  if (disjunction.length > 1) {
    const unwrap = (value: string) => {
      let out = value.trim();
      while (out.startsWith("(") && out.endsWith(")") && parenPairs(out).some(([o, c]) => o === 0 && c === out.length - 1)) out = out.slice(1, -1).trim();
      return out.replace(/\s+/g, " ").toLowerCase();
    };
    const nullGuard = `${call.args[0]} IS NULL`.toLowerCase();
    return disjunction.some((part) => unwrap(part) === nullGuard) && disjunction.some((part) => findHelperCalls(part).length > 0);
  }
  return splitTop(group, " AND ").includes(`(${call.args[0]} IS NOT NULL)`);
}

// ------------------------------------------------------------------------------------------------------------------------------
// Catalog
// ------------------------------------------------------------------------------------------------------------------------------

export interface PolicyRow {
  tablename: string;
  policyname: string;
  cmd: string;
  roles: string;
  permissive: string;
  qual: string | null;
  with_check: string | null;
}

/** Anything that runs a query: a PGlite database or transaction, or the app's Queryable (the guard test runs on the shared test database). */
export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/**
 * Every policy in the public schema, printed with search_path = public, pg_temp (pg_policies qualifies names relative to it). Must run
 * inside a transaction (the setting is local to it).
 */
export async function readPoliciesIn(db: Db): Promise<PolicyRow[]> {
  await db.query("set local search_path = public, pg_temp");
  const { rows } = await db.query<PolicyRow>(
    `select tablename::text, policyname::text, cmd, roles::text as roles, permissive, qual, with_check
     from pg_policies where schemaname = 'public' order by tablename, policyname, cmd`,
  );
  return rows;
}

export async function readPolicies(db: PGlite): Promise<PolicyRow[]> {
  return db.transaction((tx) => readPoliciesIn(tx));
}

interface ForeignKey {
  name: string;
  schema: string;
  table: string;
  cols: string[];
  referenceSchema: string;
  ftable: string;
  fcols: string[];
  validated: boolean;
  matchFull: boolean;
}

async function readKeys(db: Db) {
  const cols = await db.query<{ t: string; col: string; notnull: boolean }>(
    `select c.relname::text as t, a.attname::text as col, a.attnotnull as notnull
     from pg_class c join pg_namespace n on n.oid = c.relnamespace join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
     where n.nspname = 'public' and c.relkind in ('r', 'p')`,
  );
  const fks = await db.query<{ name: string; ns: string; t: string; fns: string; cols: string[]; ft: string; fcols: string[]; validated: boolean; mt: string }>(
    `select k.conname::text as name, n.nspname::text as ns, c.relname::text as t, fn.nspname::text as fns, f.relname::text as ft, k.convalidated as validated, k.confmatchtype::text as mt,
       (select array_agg(a.attname::text order by x.ord) from unnest(k.conkey) with ordinality x(n, ord) join pg_attribute a on a.attrelid = k.conrelid and a.attnum = x.n) as cols,
       (select array_agg(a.attname::text order by x.ord) from unnest(k.confkey) with ordinality x(n, ord) join pg_attribute a on a.attrelid = k.confrelid and a.attnum = x.n) as fcols
     from pg_constraint k join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
       join pg_class f on f.oid = k.confrelid join pg_namespace fn on fn.oid = f.relnamespace
     where n.nspname = 'public' and k.contype = 'f'`,
  );
  const notnull = new Map(cols.rows.map((r) => [`${r.t}.${r.col}`, r.notnull]));
  const keys: ForeignKey[] = fks.rows.map((r) => ({ name: r.name, schema: r.ns, table: r.t, cols: r.cols, referenceSchema: r.fns, ftable: r.ft, fcols: r.fcols, validated: r.validated, matchFull: r.mt === "f" }));
  return { notnull, keys };
}

/**
 * The foreign keys that guarantee `table.col` names an existing organizations.id whenever it is not null, or null if none does. A
 * composite key only counts when its other columns are NOT NULL (MATCH SIMPLE skips the check when any column is null), and the
 * referenced column must itself be guaranteed.
 */
function orgReference(keys: ForeignKey[], notnull: Map<string, boolean>, table: string, col: string, schema = "public", depth = 0): string | null {
  if (schema !== "public") return null;
  if (table === "organizations" && col === "id") return "public.organizations.id";
  if (depth > 8) return null;
  for (const k of keys) {
    if (k.schema !== schema || k.table !== table || !k.validated || !k.cols.includes(col)) continue;
    if (!k.matchFull && !k.cols.every((c) => c === col || notnull.get(`${table}.${c}`))) continue;
    const fcol = k.fcols[k.cols.indexOf(col)];
    if (k.referenceSchema !== "public") continue;
    if (k.ftable === "organizations" && fcol === "id") return k.name;
    if (!notnull.get(`${k.ftable}.${fcol}`)) continue;
    const up = orgReference(keys, notnull, k.ftable, fcol, k.referenceSchema, depth + 1);
    if (up) return `${k.name} > ${up}`;
  }
  return null;
}

/** `s` at its own top level: the contents of every parenthesised group and quoted token are dropped (kept as `()`, `''` or `""`). */
function topLevel(s: string): string {
  let out = "";
  let depth = 0;
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const j = skipQuoted(s, i);
      if (depth === 0) out += ch + ch;
      i = j;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) out += "(";
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) out += ")";
    } else if (depth === 0) out += ch;
    i++;
  }
  return out;
}

const FROM_END = /\b(?:WHERE|GROUP BY|HAVING|WINDOW|ORDER BY|LIMIT|OFFSET|FETCH|FOR|UNION|INTERSECT|EXCEPT)\b/;
const FROM_ITEM = /^(?:public\.)?([a-z_][a-z0-9_]*)(?: ([a-z_][a-z0-9_]*))?$/;

/**
 * The names one sub-select's own FROM clause binds (alias, or the table name when it has none) and their tables, or null when that FROM
 * clause is anything but a plain list of tables (a join, a function, a nested query, a set operation), which this checker does not read.
 */
function fromBindings(select: string): Map<string, string> | null {
  const top = topLevel(select).replace(/\s+/g, " ");
  const froms = [...top.matchAll(/\bFROM\b/g)];
  const out = new Map<string, string>();
  if (!froms.length) return out;
  if (froms.length > 1) return null;
  const rest = top.slice(froms[0].index! + "FROM".length);
  const end = FROM_END.exec(rest);
  for (const item of (end ? rest.slice(0, end.index) : rest).split(",").map((x) => x.trim())) {
    const m = FROM_ITEM.exec(item);
    if (!m) return null;
    const name = m[2] ?? m[1];
    if (out.has(name)) return null;
    out.set(name, m[1]);
  }
  return out;
}

/**
 * Resolves the table a call's column belongs to. A qualified column is looked up in the sub-selects that enclose the call, innermost
 * first, each in its own FROM clause only (PostgreSQL prints an alias unique against enclosing queries, but sibling sub-selects may
 * reuse one); a name no enclosing sub-select binds must be the policy's table. Anything else throws, so the proof fails closed.
 */
function columnTable(policyTable: string, expr: string, call: HelperCall): { table: string; col: string } {
  const arg = call.args[0];
  const selects = parenPairs(expr)
    .filter(([o, c]) => o < call.start && c >= call.end && /^\(\s*SELECT\b/.test(expr.slice(o, c + 1)))
    .sort((a, b) => b[0] - a[0]);
  if (!arg.includes(".")) {
    if (selects.length) throw new Error(`Cannot resolve unqualified column ${arg} inside a sub-select in: ${expr}`);
    return { table: policyTable, col: arg };
  }
  const [alias, col] = arg.split(".");
  for (const [o, c] of selects) {
    const binds = fromBindings(expr.slice(o + 1, c));
    if (!binds) throw new Error(`Cannot resolve alias ${alias}: an enclosing sub-select's FROM clause is not a plain list of tables in: ${expr}`);
    const table = binds.get(alias);
    if (table) return { table, col };
  }
  if (alias === policyTable) return { table: policyTable, col };
  throw new Error(`Cannot resolve alias ${alias} in: ${expr}`);
}

export interface ProofLine {
  policy: string;
  call: string;
  column: string;
  notNull: boolean;
  guarded: boolean;
  reference: string | null;
}

/**
 * For every call the migration rewrites: the column it passes is NOT NULL (or the call sits in a conjunction with `(col IS NOT NULL)`),
 * and a validated foreign key chain makes it an existing organizations.id. Under those two facts the candidate set of
 * permitted_orgs / accessible_orgs covers every organization where the per-row helper can be true (see the rollout doc).
 */
export async function proveColumns(db: Db, policies: PolicyRow[]): Promise<{ lines: ProofLine[]; failures: string[] }> {
  const { notnull, keys } = await readKeys(db);
  const lines: ProofLine[] = [];
  const failures: string[] = [];
  for (const p of selectPolicies(policies)) {
    const expr = p.qual ?? "";
    for (const call of findHelperCalls(expr)) {
      const { table, col } = columnTable(p.tablename, expr, call);
      const line: ProofLine = {
        policy: `${p.tablename}.${p.policyname}`,
        call: expr.slice(call.start, call.end),
        column: `${table}.${col}`,
        notNull: Boolean(notnull.get(`${table}.${col}`)),
        guarded: nullGuarded(expr, call),
        reference: orgReference(keys, notnull, table, col),
      };
      lines.push(line);
      if (!line.notNull && !line.guarded) failures.push(`${line.policy}: ${line.column} can be null and the call is not guarded by IS NOT NULL`);
      if (!line.reference) failures.push(`${line.policy}: no validated foreign key makes ${line.column} an organizations.id`);
    }
  }
  return { lines, failures };
}

/** SELECT policies that call a per-row helper: exactly the ones the migration rewrites. */
export function selectPolicies(policies: PolicyRow[]): PolicyRow[] {
  return policies.filter((p) => p.cmd === "SELECT" && p.qual && findHelperCalls(p.qual).length);
}

export async function functionBody(db: Db, name: string): Promise<string | null> {
  const { rows } = await db.query<{ src: string }>(
    "select p.prosrc as src from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname = $1",
    [name],
  );
  return rows[0]?.src ?? null;
}

export const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

// ------------------------------------------------------------------------------------------------------------------------------
// Rendering
// ------------------------------------------------------------------------------------------------------------------------------

const ident = (s: string) => (/^[a-z_][a-z0-9_]*$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;
function dollar(tag: string, s: string) {
  if (s.includes(`$${tag}$`)) throw new Error(`Expression contains $${tag}$: ${s}`);
  return `$${tag}$${s}$${tag}$`;
}

function targetProofChecks(proof: ProofLine[]): string[] {
  const grouped = new Map<string, ProofLine[]>();
  for (const line of proof) grouped.set(line.column, [...(grouped.get(line.column) ?? []), line]);
  return [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([column, lines]) => {
    const [table, col] = column.split(".");
    if (!table || !col || column.split(".").length !== 2) throw new Error(`Unexpected proof column: ${column}`);
    const mustBeNotNull = lines.some((line) => !line.guarded);
    return `select app.rls_initplan_expect_column(${lit(table)}, ${lit(col)}, ${mustBeNotNull});`;
  });
}

/** `helpers`: the definitions of PROOF_HELPERS read from the database the file is generated from (checked by helperDrift first). */
export function renderUp(before: PolicyRow[], helpers: HelperDefinition[], proof: ProofLine[]): string {
  const targets = selectPolicies(before);
  const drift = helperDrift(helpers);
  if (drift.length) throw new Error(`a helper the RLS proof relies on differs from the reviewed definition; nothing was generated:\n${drift.join("\n")}`);
  const helperOwner = helpers.find((r) => r.name === "has_permission")!.owner;
  const checks = PROOF_HELPERS.map((name) => {
    const h = helpers.find((r) => r.name === name)!;
    return `select app.rls_initplan_expect_function(${lit(name)}, ${lit(h.args)}, ${h.secdef}, ${lit(h.vol)}, ${lit(h.config)}, ${lit(h.owner)}, ${dollar("src", h.normalized)});`;
  });
  const out: string[] = [
    `-- ${NAME}: row-level security evaluated once per statement instead of once per row.`,
    "--",
    "-- GENERATED by scripts/rls-initplan.ts from pg_policies after every earlier migration. Do not edit by hand: change the generator",
    "-- or the earlier migration and run `node --import tsx scripts/rls-initplan.ts`. Proof, verification and rollout: docs/rls-performance-rollout.md.",
    "--",
    "-- Every SELECT policy that called app.has_permission(org_id, 'p'), app.can_access_org(org_id) or app.can_view_conversation(...) with the",
    "-- row's own columns ran that SECURITY DEFINER function for every row it read. Each call becomes a membership test against an array",
    "-- that an uncorrelated sub-select computes once per statement (an InitPlan):",
    "--   app.has_permission(C, 'p')  ->  (C = ANY ((SELECT app.permitted_orgs('p'))::uuid[]))",
    "--   app.can_access_org(C)       ->  (C = ANY ((SELECT app.accessible_orgs())::uuid[]))",
    "--   app.can_view_conversation(C, OWNER, ASSIGNED) -> its own body, with the two permission checks rewritten the same way and",
    "--                                    app.current_user_id() in a sub-select.",
    "-- permitted_orgs(p) combines membership grants with active client organizations allowed by agency scope and permission. CRM",
    "-- permissions also require the same active support-session mode as app.has_permission. accessible_orgs() lists every organization",
    "-- for an agency super admin and otherwise active memberships plus active client organizations in manager/staff scope. It returns",
    "-- an empty array for an inactive or unknown user; a per-row NULL is also non-true in a row policy. The generator checked that each",
    "-- rewritten column is NOT NULL or safely guarded by IS NOT NULL / IS NULL, and backed by a validated organization foreign key.",
    "-- Policies for INSERT, UPDATE, DELETE and ALL are",
    "-- not changed.",
    "--",
    "-- Before changing anything, the file checks that every helper the proof reads still has the definition it was proven against, and",
    "-- that each policy still has the expression it was generated from; if any differs (drift, a hotfix, or a newer PostgreSQL printing",
    "-- an expression differently), the migration stops and nothing changes. It also gives up after 5 s waiting for a table lock: run",
    "-- it in one transaction (the app's runner does), which holds every policy's ACCESS EXCLUSIVE lock until it commits.",
    "",
    LOCK_TIMEOUT_SQL,
    "",
    `-- The ${PROOF_HELPERS.length} definitions the proof reads; the check function is dropped right after.`,
    EXPECT_FUNCTION_SQL,
    ...checks,
    DROP_EXPECT_FUNCTION_SQL,
    "",
    EXPECT_COLUMN_SQL,
    ...targetProofChecks(proof),
    "",
    HELPERS_SQL,
    `alter function app.permitted_orgs(text) owner to ${ident(helperOwner)};`,
    `alter function app.accessible_orgs() owner to ${ident(helperOwner)};`,
    "",
    "-- Precondition check, dropped again at the end of this file.",
    EXPECT_SQL,
    "",
    `-- ${targets.length} SELECT policies.`,
  ];
  for (const p of targets) {
    const now = rewriteExpression(p.qual!, `${p.tablename}.${p.policyname}`)!;
    out.push(
      "",
      `-- ${p.tablename} / ${p.policyname}`,
      `select app.rls_initplan_expect(${lit(p.tablename)}, ${lit(p.policyname)}, ${dollar("was", p.qual!)});`,
      `alter policy ${ident(p.policyname)} on public.${ident(p.tablename)} using (${now});`,
    );
  }
  out.push("", DROP_EXPECT_SQL, DROP_EXPECT_COLUMN_SQL, "");
  return out.join("\n");
}

export function renderDown(before: PolicyRow[], after: PolicyRow[]): string {
  const targets = selectPolicies(before);
  const out: string[] = [
    `-- Rollback of ${NAME}. GENERATED by scripts/rls-initplan.ts together with the migration; do not edit by hand.`,
    "--",
    "-- Restores every rewritten SELECT policy to the exact expression it had before (checked by tests/rls-initplan-equivalence.test.ts),",
    "-- then drops the two statement-level helpers. Each policy is first checked against the expression the migration gave it; if a later",
    "-- change touched it, the rollback stops before changing anything (roll that change back first). No data is read or changed.",
    "-- Run it in one transaction (for example `psql --single-transaction -f`): it holds every policy's ACCESS EXCLUSIVE lock until it",
    "-- commits, and gives up after 5 s waiting for one.",
    "",
    LOCK_TIMEOUT_SQL,
    "",
    EXPECT_SQL,
  ];
  for (const p of targets) {
    const cur = after.find((a) => a.tablename === p.tablename && a.policyname === p.policyname && a.cmd === "SELECT");
    if (!cur?.qual) throw new Error(`${p.tablename}.${p.policyname} is missing after the migration`);
    out.push(
      "",
      `-- ${p.tablename} / ${p.policyname}`,
      `select app.rls_initplan_expect(${lit(p.tablename)}, ${lit(p.policyname)}, ${dollar("now", cur.qual)});`,
      `alter policy ${ident(p.policyname)} on public.${ident(p.tablename)} using (${p.qual});`,
    );
  }
  out.push("", DROP_EXPECT_SQL, "drop function app.accessible_orgs();", "drop function app.permitted_orgs(text);", "");
  return out.join("\n");
}

// ------------------------------------------------------------------------------------------------------------------------------
// Database
// ------------------------------------------------------------------------------------------------------------------------------

const MIGRATION_FILE = /^\d{4}_[a-z0-9_]+\.sql$/;

export function migrationFiles(root: string): string[] {
  return fs.readdirSync(path.join(root, "supabase", "migrations")).filter((f) => MIGRATION_FILE.test(f)).sort();
}

/** A fresh in-memory database with the local Supabase emulation and every migration numbered below `before` (all when omitted). */
export async function openDatabase(root: string, before?: string): Promise<PGlite> {
  const db = new PGlite({ extensions: { citext, pg_trgm, btree_gist } });
  await db.waitReady;
  await db.exec(fs.readFileSync(path.join(root, "supabase", "local-compat.sql"), "utf8"));
  for (const f of migrationFiles(root)) {
    if (before && f.slice(0, 4) >= before) continue;
    const sql = fs.readFileSync(path.join(root, "supabase", "migrations", f), "utf8");
    // Like the app's migration runner: one transaction per file.
    await db.transaction(async (tx) => {
      await tx.exec(sql);
    });
  }
  return db;
}

export async function runScript(db: PGlite, sql: string) {
  await db.transaction(async (tx) => {
    await tx.exec(sql);
  });
}

export interface Generated {
  up: string;
  down: string;
  rewritten: number;
  proof: ProofLine[];
  leftAlone: string[];
}

/**
 * Generates both files from a database at the state just before the migration, and proves on it that the rollback restores every
 * policy exactly. Runs inside the caller's transaction, applying the generated migration and rollback in it: the caller rolls back.
 */
export async function generateIn(db: VerifyDb): Promise<Generated> {
  const body = await functionBody(db, "can_view_conversation");
  if (normalize(body ?? "") !== normalize(CAN_VIEW_CONVERSATION_BODY)) {
    throw new Error(`app.can_view_conversation changed; update the expansion in scripts/rls-initplan.ts first:\n${body}`);
  }
  // The proof reads these definitions (a hotfix or an out-of-order migration on the source database would make it wrong): refuse unless
  // each exists once with the reviewed fingerprint. renderUp embeds them so the migration re-checks the target database too.
  const helpers = await readHelperDefinitions(db, PROOF_HELPERS);
  const drift = helperDrift(helpers);
  if (drift.length) throw new Error(`a helper the RLS proof relies on differs from the reviewed definition; nothing was generated:\n${drift.join("\n")}`);
  if (await functionBody(db, "permitted_orgs")) throw new Error("app.permitted_orgs already exists: generate from the state before the migration");
  const before = await readPoliciesIn(db);
  const { lines, failures } = await proveColumns(db, before);
  if (failures.length) throw new Error(`Cannot prove the rewrite equivalent:\n${failures.join("\n")}`);
  const leftAlone = before
    .filter((p) => p.cmd !== "SELECT" && findHelperCalls(`${p.qual ?? ""} ${p.with_check ?? ""}`).length)
    .map((p) => `${p.tablename}.${p.policyname} (${p.cmd})`);
  const up = renderUp(before, helpers, lines);
  await db.exec(up);
  const after = await readPoliciesIn(db);
  const stillPerRow = selectPolicies(after);
  if (stillPerRow.length) throw new Error(`Still calling a per-row helper: ${stillPerRow.map((p) => p.policyname).join(", ")}`);
  const down = renderDown(before, after);
  await db.exec(down);
  const restored = await readPoliciesIn(db);
  if (JSON.stringify(restored) !== JSON.stringify(before)) throw new Error("The generated rollback does not restore every policy exactly");
  if (await functionBody(db, "permitted_orgs")) throw new Error("The generated rollback left app.permitted_orgs behind");
  for (const temp of ["rls_initplan_expect", "rls_initplan_expect_function", "rls_initplan_expect_column"]) if (await functionBody(db, temp)) throw new Error(`The generated files left app.${temp} behind`);
  return { up, down, rewritten: selectPolicies(before).length, proof: lines, leftAlone };
}

class RolledBack extends Error {}

/** generateIn on a PGlite database, in a transaction that is rolled back: the database is left exactly as it was. */
export async function generateFrom(db: PGlite): Promise<Generated> {
  let out: Generated | null = null;
  try {
    await db.transaction(async (tx) => {
      out = await generateIn(tx);
      throw new RolledBack();
    });
  } catch (err) {
    if (!(err instanceof RolledBack)) throw err;
  }
  return out!;
}

// ------------------------------------------------------------------------------------------------------------------------------
// Verification on a restored copy (staging), inside one transaction that is always rolled back
// ------------------------------------------------------------------------------------------------------------------------------

/** What the verifier needs: a connection already inside a transaction that the caller rolls back. */
export interface VerifyDb extends Db {
  exec(sql: string): Promise<unknown>;
}

export interface VerifyResult {
  /** The chosen users plus the unknown id. */
  personas: number;
  /** How many chosen users came from each stratum (see PERSONA_STRATA_SQL). */
  strata: Record<string, number>;
  /** Chosen users with platform role none, an active account and an active membership in an organization that is not suspended or archived. */
  clientMembers: number;
  tables: number;
  rowsSeen: number;
  differences: string[];
  rollbackRestoresPolicies: boolean;
}

/**
 * Candidate personas, grouped into strata by everything the helpers read: platform role and account status; membership role and status
 * and organization status (one row per membership); whether the user has permission overrides, staff assignments, several memberships;
 * plus one stratum of members who own or are assigned a conversation where they lack inbox.view_all (their role does not grant it and no
 * override does). Up to $1 users per stratum (oldest first), ordered so that taking rows in order fills the strata round-robin: each
 * pass takes the next user of every stratum, alternating between the platform-role groups (client users first), so neither a large
 * agency nor one big stratum crowds out the others when the sample is small.
 */
export const PERSONA_STRATA_SQL = `with overrides as (
  select user_id, md5(string_agg(format('%s|%s|%s', org_id, permission, effect), E'\\n' order by org_id, permission, effect)) as signature
  from member_permission_overrides group by user_id),
assigned as (select distinct user_id from staff_assignments),
memberships as (select user_id, count(*) as n from organization_memberships group by user_id),
strata as (
  select u.id, u.created_at, coalesce(u.platform_role::text, '?') as grp,
         concat_ws(' ',
           coalesce(u.platform_role::text, '?') || '/' || coalesce(u.status::text, '?'),
           case when om.org_id is null then 'no membership'
                else coalesce(om.role::text, '?') || '/' || coalesce(om.status::text, '?') || ' in a ' || coalesce(o.status::text, '?') || ' org' end,
           case when ov.user_id is not null then '+overrides:' || ov.signature end,
           case when a.user_id is not null then '+staff assignments' end,
           case when coalesce(k.n, 0) > 1 then '+several orgs' end) as stratum
  from users u
  left join organization_memberships om on om.user_id = u.id
  left join organizations o on o.id = om.org_id
  left join overrides ov on ov.user_id = u.id
  left join assigned a on a.user_id = u.id
  left join memberships k on k.user_id = u.id
  union
  select u.id, u.created_at, 'none', 'owns or is assigned a conversation without inbox.view_all'::text
  from conversations c
  join organization_memberships om on om.org_id = c.org_id and om.user_id in (c.owner_user_id, c.assigned_user_id)
  join users u on u.id = om.user_id
  where not exists (select 1 from role_permissions rp where rp.role = om.role and rp.permission = 'inbox.view_all')
    and not exists (select 1 from member_permission_overrides x where x.org_id = om.org_id and x.user_id = om.user_id and x.permission = 'inbox.view_all' and x.effect = 'grant')
),
ranked as (select id, grp, stratum, row_number() over (partition by stratum order by created_at, id) as rn from strata),
kinds as (select stratum, dense_rank() over (partition by grp order by stratum) as kind_rank from (select distinct grp, stratum from strata) s)
select r.id::text as id, r.stratum from ranked r join kinds k on k.stratum = r.stratum
where r.rn <= $1 order by r.rn, k.kind_rank, (r.grp <> 'none'), r.grp, r.stratum, r.id`;

const CLIENT_MEMBERS_SQL = `select count(*)::int as n from users u
where u.id::text = any($1::text[]) and u.platform_role = 'none' and u.status = 'active'
  and exists (select 1 from organization_memberships m join organizations o on o.id = m.org_id
              where m.user_id = u.id and m.status = 'active' and o.status not in ('suspended', 'archived'))`;

/** Up to `limit` users, taken round-robin from the strata (at most `perStratum` from each), so no stratum crowds out the others. */
export async function choosePersonas(db: Db, limit: number, perStratum: number): Promise<{ ids: string[]; strata: Record<string, number>; clientMembers: number }> {
  const { rows } = await db.query<{ id: string; stratum: string }>(PERSONA_STRATA_SQL, [perStratum]);
  const chosen = new Map<string, string>();
  for (const r of rows) if (chosen.size < limit && !chosen.has(r.id)) chosen.set(r.id, r.stratum);
  const strata: Record<string, number> = {};
  for (const s of chosen.values()) strata[s] = (strata[s] ?? 0) + 1;
  const ids = [...chosen.keys()];
  const clientMembers = (await db.query<{ n: number }>(CLIENT_MEMBERS_SQL, [ids])).rows[0].n;
  return { ids, strata, clientMembers };
}

/**
 * Captures, for up to `limit` real users chosen across strata (choosePersonas) plus an unknown id, a count and a hash of the primary
 * keys each can see in every row-level-security table; applies the migration text; captures again; applies the rollback text; checks
 * every policy is back exactly and captures a third time. The caller must already be in a transaction and must roll it back: this
 * applies DDL (and holds its locks until then), so run it only on a restored copy, never on production.
 */
export async function verifyInTransaction(db: VerifyDb, up: string, down: string, limit = 25, perStratum = 3): Promise<VerifyResult> {
  if (await functionBody(db, "permitted_orgs")) throw new Error("app.permitted_orgs already exists: this copy already has 0050");
  const { ids: users, strata, clientMembers } = await choosePersonas(db, limit, perStratum);
  const ids = [...users, "00000000-0000-4000-8000-000000000000"];
  const tableRows = (await db.query<{ t: string; key: string }>(
    `select c.relname::text as t,
            coalesce(
              (select string_agg(format('%I', a.attname), ', ' order by a.attnum) from pg_index i join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
               where i.indrelid = c.oid and i.indisprimary and has_column_privilege('iaq_app_user', c.oid, a.attnum, 'select')),
              (select string_agg(format('%I', a.attname), ', ' order by a.attnum) from pg_attribute a
               where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped and has_column_privilege('iaq_app_user', c.oid, a.attnum, 'select'))) as key
     from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity order by 1`,
  )).rows.filter((r) => r.key);
  const snapshot = async () => {
    await db.query("set local search_path = public, pg_temp");
    return JSON.stringify((await db.query("select tablename, policyname, cmd, roles::text, permissive, qual, with_check from pg_policies where schemaname = 'public' order by 1, 2, 3")).rows);
  };
  let rowsSeen = 0;
  const capture = async () => {
    const out = new Map<string, string>();
    for (const id of ids) {
      await db.query("savepoint rls_persona");
      await db.query("select set_config('app.user_id', $1, true)", [id]);
      await db.query("set local role iaq_app_user");
      for (const t of tableRows) {
        await db.query("savepoint rls_table");
        try {
          const { rows } = await db.query<{ n: number; h: string | null }>(`select count(*)::int as n, md5(string_agg(row(${t.key})::text, ',' order by row(${t.key})::text)) as h from public.${t.t}`);
          out.set(`${id} / ${t.t}`, `${rows[0].n}:${rows[0].h ?? ""}`);
          rowsSeen += rows[0].n;
          await db.query("release savepoint rls_table");
        } catch (err) {
          await db.query("rollback to savepoint rls_table");
          out.set(`${id} / ${t.t}`, `error: ${(err as Error).message}`);
        }
      }
      await db.query("rollback to savepoint rls_persona");
    }
    return out;
  };
  const diff = (a: Map<string, string>, b: Map<string, string>, label: string) => [...a].filter(([k, v]) => b.get(k) !== v).map(([k, v]) => `${label}: ${k}: ${v} vs ${b.get(k)}`);
  const policies = await snapshot();
  const before = await capture();
  await db.exec(up);
  const after = await capture();
  await db.exec(down);
  const restored = (await snapshot()) === policies;
  const back = await capture();
  return {
    personas: ids.length,
    strata,
    clientMembers,
    tables: tableRows.length,
    rowsSeen,
    differences: [...diff(before, after, "with 0050"), ...diff(before, back, "after rollback")],
    rollbackRestoresPolicies: restored,
  };
}

const CONFIRM = "--yes-this-is-a-restored-copy";

/** The URL given after `flag`, refusing anything but an explicit postgres URL with the restored-copy confirmation. */
function stagingUrl(flag: string): string {
  const url = process.argv[process.argv.indexOf(flag) + 1];
  if (!url || !/^postgres(ql)?:\/\//.test(url)) throw new Error(`${flag} needs the connection URL of a restored copy as its argument (this script never reads .env)`);
  if (!process.argv.includes(CONFIRM)) {
    throw new Error(`${flag} applies the migration and its rollback inside one transaction (rolled back at the end) and holds table locks while it runs. Run it only on a restored copy, never on production, and pass ${CONFIRM} to confirm.`);
  }
  return url;
}

/** Runs `fn` on a restored copy inside one transaction that is always rolled back. */
async function onStaging<T>(url: string, fn: (db: VerifyDb) => Promise<T>): Promise<T> {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  console.log(`Connected to ${new URL(url).hostname}; everything below runs in one transaction that is rolled back at the end.`);
  try {
    await client.query("begin");
    await client.query("set local lock_timeout = '5s'");
    return await fn({
      query: async <R>(sql: string, params?: unknown[]) => ({ rows: (await client.query(sql, params)).rows as R[] }),
      exec: (sql: string) => client.query(sql),
    });
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

async function verifyStaging(root: string, url: string, limit: number, perStratum: number) {
  const r = await onStaging(url, (db) =>
    verifyInTransaction(db, fs.readFileSync(path.join(root, MIGRATION_PATH), "utf8"), fs.readFileSync(path.join(root, ROLLBACK_PATH), "utf8"), limit, perStratum),
  );
  console.log(`${r.personas} personas (${r.personas - 1} users, up to ${perStratum} per stratum, plus an unknown id) x ${r.tables} tables, ${r.rowsSeen} visible rows counted over the three captures.`);
  for (const [stratum, n] of Object.entries(r.strata).sort(([a], [b]) => a.localeCompare(b))) console.log(`  ${String(n).padStart(3)}  ${stratum}`);
  console.log(`Rollback restores every policy exactly: ${r.rollbackRestoresPolicies ? "yes" : "NO"}`);
  console.log(r.differences.length ? `DIFFERENCES (${r.differences.length}):\n${r.differences.slice(0, 50).join("\n")}` : "No differences: every persona saw the same rows in every table.");
  if (!r.clientMembers) {
    console.error("WARNING: no client member (platform role none, active account, active membership in an active organization) was compared, so this run proves nothing for client users. Use a copy with client data, or raise --personas.");
  }
  if (r.differences.length || !r.rollbackRestoresPolicies || !r.clientMembers) process.exitCode = 1;
}

/** The positive integer given after `flag`, or `fallback`. */
function intArg(flag: string, fallback: number): number {
  const i = process.argv.indexOf(flag);
  const n = i >= 0 ? Number(process.argv[i + 1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

async function main() {
  const root = process.cwd();
  if (process.argv.includes("--verify-staging")) {
    await verifyStaging(root, stagingUrl("--verify-staging"), intArg("--personas", 25), intArg("--per-stratum", 3));
    return;
  }
  const check = process.argv.includes("--check");
  // --from-database: generate from a restored copy's own catalog, for when its PostgreSQL prints policy expressions differently.
  let g: Generated;
  if (process.argv.includes("--from-database")) {
    g = await onStaging(stagingUrl("--from-database"), (db) => generateIn(db));
  } else {
    const db = await openDatabase(root, VERSION);
    try {
      g = await generateFrom(db);
    } finally {
      await db.close();
    }
  }
  const files: Array<[string, string]> = [
    [MIGRATION_PATH, g.up],
    [ROLLBACK_PATH, g.down],
  ];
  let drift = false;
  for (const [rel, text] of files) {
    const abs = path.join(root, rel);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : null;
    if (current === text) console.log(`${rel}: up to date`);
    else if (check) {
      drift = true;
      console.log(`${rel}: differs from the generator output`);
    } else {
      fs.writeFileSync(abs, text);
      console.log(`${rel}: written`);
    }
  }
  console.log(`${g.rewritten} SELECT policies rewritten; left alone (other commands): ${g.leftAlone.join(", ") || "none"}`);
  if (drift) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
