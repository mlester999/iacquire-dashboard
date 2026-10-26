import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { AGENCY_DELEGABLE_PERMISSIONS, PERMISSION_MATRIX } from "@/lib/permissions";
import { SKILLS } from "@/lib/staff-workload/sources";
import { agencyOrgId, rows, setWorkload, splitStatements, staffPerson } from "./support/staff-workload";
import { createOrg } from "./support/fixtures";

// Migration 0097: the schema is closed by default, who may read it, what the database itself refuses, and a rollback that never drops a colleague's time off or the founder's
// rules. Each case that changes anything runs in a transaction that is always rolled back, so the shared test database is untouched.

class Done extends Error {}
const down = readFileSync("supabase/rollbacks/0097_staff_workload.down.sql", "utf8");

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const runDown = async (db: Db) => {
  for (const stmt of splitStatements(down)) await db.query(stmt);
};
const rolledBack = (fn: (db: Db) => Promise<void>) =>
  withSystem(async (db) => {
    await fn(db);
    throw new Done();
  }).catch((e) => {
    if (!(e instanceof Done)) throw e;
  });

const TABLES = ["staff_work_profiles", "staff_time_off", "staff_workload_settings", "staff_workload_snapshots", "staff_workload_alerts", "work_assignment_events"];
const FUNCTIONS = ["staff_workload_enabled()", "staff_workload_allowed()", "staff_workload_team_allowed()", "staff_workload_manage_allowed()", "can_view_staff_workload(uuid)"];
const AGENCY_ROLES = ["agency_staff", "agency_manager", "agency_super_admin"];
const KINDS = ["staff_workload_alert", "staff_work_overdue"];

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

async function people() {
  return { agency: await agencyOrgId(), a: (await staffPerson("agency_staff")).id, b: (await staffPerson("agency_manager")).id, none: (await staffPerson("none")).id };
}

const probe = async (fn: (db: Db, who: Awaited<ReturnType<typeof people>>) => Promise<void>) => {
  const who = await people();
  await rolledBack((db) => fn(db, who));
};

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
      expect(p.qual, p.tablename).toMatch(/staff_workload_(allowed|team_allowed|manage_allowed)/);
      // No policy reads a client workspace, a membership or a client role.
      expect(p.qual, p.tablename).not.toMatch(/organization_memberships|permitted_orgs|has_permission\(|can_access_org/);
    }
  });

  it("makes the helper functions callable by the application role and by no browser role, with a pinned search path", async () => {
    const acl = await rows<{ sig: string; grantees: string[]; definer: boolean; config: string[] | null }>(
      `select p.oid::regprocedure::text as sig, p.prosecdef as definer, p.proconfig as config,
         (select coalesce(array_agg(coalesce(nullif(x.grantee, 0)::regrole::text, 'PUBLIC')), '{}') from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x where x.privilege_type = 'EXECUTE') as grantees
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.oid::regprocedure::text = any($1::text[])`,
      [FUNCTIONS.map((f) => `app.${f}`)],
    );
    expect(acl.map((a) => a.sig).sort()).toEqual(FUNCTIONS.map((f) => `app.${f}`).sort());
    for (const a of acl) {
      expect(a.definer, a.sig).toBe(true);
      for (const role of ["PUBLIC", "anon", "authenticated"]) expect(a.grantees, `${a.sig} ${role}`).not.toContain(role);
      expect(a.grantees, a.sig).toContain("iaq_app_user");
      expect((a.config ?? []).join(","), a.sig).toMatch(/search_path=/);
    }
    const guards = await rows<{ proname: string; proconfig: string[] | null }>(
      "select proname, proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and proname in ('staff_workload_org_guard', 'staff_workload_person_guard', 'staff_work_profile_guard', 'staff_workload_snapshot_guard', 'work_assignment_events_guard')",
    );
    expect(guards).toHaveLength(5);
    for (const g of guards) expect((g.proconfig ?? []).join(","), g.proname).toMatch(/search_path=/);
  });

  it("seeds no row of its own: the migration file inserts permissions and nothing else, so a feature nobody switched on holds no data", () => {
    const sql = readFileSync("supabase/migrations/0097_staff_workload.sql", "utf8");
    const inserts = [...sql.matchAll(/^\s*insert into ([a-z_]+)/gim)].map((m) => m[1]);
    expect(inserts).toEqual(["role_permissions"]);
  });
});

describe("the permissions", () => {
  it("are seeded for the agency roles the product says, and for no client role", async () => {
    const seeded = await rows<{ role: string; permission: string }>("select role, permission from role_permissions where permission like 'agency.workload.%' order by permission, role");
    const by = (perm: string) => seeded.filter((r) => r.permission === perm).map((r) => r.role).sort();
    expect(by("agency.workload.view")).toEqual([...AGENCY_ROLES].sort());
    for (const perm of ["team", "assign", "manage"]) expect(by(`agency.workload.${perm}`)).toEqual(["agency_manager", "agency_super_admin"]);
    expect(by("agency.workload.settings")).toEqual(["agency_super_admin"]);
    expect(seeded.every((r) => AGENCY_ROLES.includes(r.role))).toBe(true);
    expect(seeded).toHaveLength(10);
  });

  it("agree with the permission matrix in the code, and only the four delegable ones can be changed one person at a time", () => {
    for (const [perm, roles] of [
      ["agency.workload.view", AGENCY_ROLES], ["agency.workload.team", ["agency_manager", "agency_super_admin"]], ["agency.workload.assign", ["agency_manager", "agency_super_admin"]],
      ["agency.workload.manage", ["agency_manager", "agency_super_admin"]], ["agency.workload.settings", ["agency_super_admin"]],
    ] as const) {
      expect([...PERMISSION_MATRIX[perm as keyof typeof PERMISSION_MATRIX]].sort(), perm).toEqual([...roles].sort());
    }
    expect([...AGENCY_DELEGABLE_PERMISSIONS].filter((p) => p.startsWith("agency.workload."))).toEqual(["agency.workload.view", "agency.workload.team", "agency.workload.assign", "agency.workload.manage"]);
  });

  it("are accepted by both per-person override lists (the four delegable ones), keep every earlier entry, and refuse the settings one", async () => {
    for (const table of ["agency_user_permission_overrides", "invitation_agency_permission_overrides"]) {
      const [c] = await rows<{ def: string }>("select pg_get_constraintdef(k.oid) as def from pg_constraint k where k.conname = $1 and k.conrelid = $2::regclass", [`${table}_permission_check`, table]);
      const listed = [...c.def.matchAll(/'([a-z0-9_.]+)'::text/g)].map((m) => m[1]);
      expect(listed.length, table).toBeGreaterThanOrEqual(56);
      for (const p of ["agency.workload.view", "agency.workload.team", "agency.workload.assign", "agency.workload.manage", "agency.messages.use", "agency.messages.channels", "agency.support.priority", "agency.crm.read"]) {
        expect(listed, `${table} ${p}`).toContain(p);
      }
      expect(listed, table).not.toContain("agency.workload.settings");
      expect(new Set(listed).size, table).toBe(listed.length);
    }
    const user = await staffPerson("agency_staff");
    await rolledBack(async (db) => {
      for (const p of ["view", "team", "assign", "manage"]) expect(await refused(db, "insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, $2, 'deny')", [user.id, `agency.workload.${p}`]), p).toBeNull();
      expect(await refused(db, "insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.workload.settings', 'allow')", [user.id])).toMatch(/permission_check/);
    });
  });

  it("does not change the notification kinds or the audience: they were 0096's", async () => {
    const [kinds] = await rows<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'notifications_kind_check' and conrelid = 'notifications'::regclass");
    for (const k of KINDS) expect(kinds.def).toContain(`'${k}'`);
    const sql = readFileSync("supabase/migrations/0097_staff_workload.sql", "utf8");
    expect(sql).not.toMatch(/notifications_kind_check|notifications_audience_check|app\.notification_visible/);
  });
});

describe("what the database itself refuses", () => {
  it("keeps every row in the one agency workspace and about agency people", async () => {
    const client = await createOrg();
    await probe(async (db, who) => {
      expect(await refused(db, "insert into staff_work_profiles (user_id, org_id) values ($1, $2)", [who.a, client.id])).toMatch(/staff_workload_agency_only/);
      expect(await refused(db, "insert into staff_time_off (org_id, user_id, starts_on, ends_on) values ($1, $2, current_date, current_date)", [client.id, who.a])).toMatch(/staff_workload_agency_only/);
      expect(await refused(db, "insert into staff_workload_settings (org_id) values ($1)", [client.id])).toMatch(/staff_workload_agency_only/);
      expect(await refused(db, "insert into work_assignment_events (org_id, source, item_id, actor_id, via) values ($1, 'support', gen_random_uuid(), $2, 'board')", [client.id, who.a])).toMatch(/staff_workload_agency_only/);
      expect(await refused(db, "insert into staff_workload_alerts (org_id, user_id, label, critical_since) values ($1, $2, 'critical', now())", [client.id, who.a])).toMatch(/staff_workload_agency_only/);
      expect(await refused(db, "insert into staff_workload_snapshots (org_id, user_id, day, kind, points, overdue, items, capacity_source, rules_revision) values ($1, $2, current_date, 'daily', 1, 0, 1, 'none', 0)", [client.id, who.a])).toMatch(/staff_workload_agency_only/);
      // The workspace is right but the person is not on the agency team: a client user has no capacity, time off, history or alert.
      expect(await refused(db, "insert into staff_work_profiles (user_id, org_id) values ($1, $2)", [who.none, who.agency])).toMatch(/staff_workload_person_must_be_agency_staff/);
      expect(await refused(db, "insert into staff_time_off (org_id, user_id, starts_on, ends_on) values ($1, $2, current_date, current_date)", [who.agency, who.none])).toMatch(/staff_workload_person_must_be_agency_staff/);
      expect(await refused(db, "insert into staff_workload_alerts (org_id, user_id, label, critical_since) values ($1, $2, 'critical', now())", [who.agency, who.none])).toMatch(/staff_workload_person_must_be_agency_staff/);
      expect(await refused(db, "insert into staff_workload_snapshots (org_id, user_id, day, kind, points, overdue, items, capacity_source, rules_revision) values ($1, $2, current_date, 'daily', 1, 0, 1, 'none', 0)", [who.agency, who.none])).toMatch(/staff_workload_person_must_be_agency_staff/);
      expect(await refused(db, "insert into staff_work_profiles (user_id, org_id) values ($1, $2)", [who.a, who.agency])).toBeNull();
    });
  });

  it("holds the shape of a profile: capacity 1 to 200, one to seven distinct days from Monday to Sunday, the nine skills at level 1 to 3, and a revision that rises", async () => {
    await probe(async (db, who) => {
      const ins = (cols: string, vals: string, params: unknown[] = []) => refused(db, `insert into staff_work_profiles (user_id, org_id, ${cols}) values ($1, $2, ${vals})`, [who.a, who.agency, ...params]);
      for (const bad of [0, 201, -5]) expect(await ins("capacity_points", "$3", [bad]), String(bad)).toMatch(/check/);
      expect(await ins("capacity_points", "$3", [200])).toBeNull();
      expect(await ins("capacity_points", "null")).toBeNull();
      expect(await ins("working_days", "'{}'::smallint[]")).toMatch(/check/);
      expect(await ins("working_days", "'{0}'::smallint[]")).toMatch(/check/);
      expect(await ins("working_days", "'{8}'::smallint[]")).toMatch(/check/);
      expect(await ins("working_days", "'{1,1}'::smallint[]")).toMatch(/staff_work_profile_working_days_repeat/);
      expect(await ins("working_days", "'{1,2,3,4,5,6,7}'::smallint[]")).toBeNull();
      expect(await ins("working_days", "'{6,7}'::smallint[]")).toBeNull();
      for (const skill of SKILLS) expect(await ins("skills", "$3::jsonb", [JSON.stringify({ [skill]: 3 })]), skill).toBeNull();
      expect(await ins("skills", "$3::jsonb", [JSON.stringify(Object.fromEntries(SKILLS.map((s) => [s, 1])))])).toBeNull();
      expect(await ins("skills", "$3::jsonb", [JSON.stringify({ juggling: 2 })])).toMatch(/staff_work_profile_skills_invalid/);
      expect(await ins("skills", "$3::jsonb", [JSON.stringify({ support: 4 })])).toMatch(/staff_work_profile_skills_invalid/);
      expect(await ins("skills", "$3::jsonb", [JSON.stringify({ support: 0 })])).toMatch(/staff_work_profile_skills_invalid/);
      expect(await ins("skills", "$3::jsonb", [JSON.stringify({ support: 2.5 })])).toMatch(/staff_work_profile_skills_invalid/);
      expect(await ins("skills", "$3::jsonb", [JSON.stringify({ support: "3" })])).toMatch(/staff_work_profile_skills_invalid/);
      expect(await ins("skills", "$3::jsonb", [JSON.stringify([1, 2])])).toMatch(/check|cannot call/);
      expect(await ins("skills", "$3::jsonb", [JSON.stringify({ support: 1, pad: "x".repeat(600) })])).toMatch(/check|staff_work_profile_skills_invalid/);
      await db.query("insert into staff_work_profiles (user_id, org_id) values ($1, $2)", [who.a, who.agency]);
      const revision = async () => (await db.query<{ revision: number }>("select revision from staff_work_profiles where user_id = $1", [who.a])).rows[0].revision;
      expect(await revision()).toBe(1);
      await db.query("update staff_work_profiles set capacity_points = 20 where user_id = $1", [who.a]);
      await db.query("update staff_work_profiles set capacity_points = 25 where user_id = $1", [who.a]);
      expect(await revision()).toBe(3);
      expect(await refused(db, "update staff_work_profiles set user_id = $2 where user_id = $1", [who.a, who.b])).toMatch(/staff_work_profile_identity_is_fixed/);
      expect(await refused(db, "update staff_work_profiles set capacity_points = 0 where user_id = $1", [who.a])).toMatch(/check/);
    });
  });

  it("holds the shape of time off: the last day not before the first, at most 366 days, half a day only for one day, a listed kind and a short note", async () => {
    await probe(async (db, who) => {
      const ins = (starts: string, ends: string, extra = "", params: unknown[] = []) =>
        refused(db, `insert into staff_time_off (org_id, user_id, starts_on, ends_on${extra ? ", " + extra.split("=")[0] : ""}) values ($1, $2, $3::date, $4::date${extra ? ", " + extra.split("=")[1] : ""})`, [who.agency, who.a, starts, ends, ...params]);
      expect(await ins("2026-10-27", "2026-10-26")).toMatch(/check/);
      expect(await ins("2026-10-27", "2026-10-27")).toBeNull();
      expect(await ins("2026-01-01", "2026-12-31")).toBeNull(); // 365 days after the first
      expect(await ins("2026-01-01", "2027-01-02")).toMatch(/check/);
      expect(await ins("2026-10-27", "2026-10-28", "part_day=true")).toMatch(/check/);
      expect(await ins("2026-10-27", "2026-10-27", "part_day=true")).toBeNull();
      for (const kind of ["leave", "sick", "holiday", "training", "other"]) expect(await ins("2026-10-27", "2026-10-27", "kind=$5", [kind]), kind).toBeNull();
      expect(await ins("2026-10-27", "2026-10-27", "kind=$5", ["vacation"])).toMatch(/check/);
      expect(await ins("2026-10-27", "2026-10-27", "note=$5", ["x".repeat(200)])).toBeNull();
      expect(await ins("2026-10-27", "2026-10-27", "note=$5", ["x".repeat(201)])).toMatch(/check/);
    });
  });

  it("keeps one settings row, holding only a small object of overrides, with a revision", async () => {
    await probe(async (db, who) => {
      expect(await refused(db, "insert into staff_workload_settings (org_id, rules) values ($1, '[]'::jsonb)", [who.agency])).toMatch(/check/);
      expect(await refused(db, "insert into staff_workload_settings (org_id, rules) values ($1, $2::jsonb)", [who.agency, JSON.stringify({ pad: "x".repeat(9000) })])).toMatch(/check/);
      expect(await refused(db, "insert into staff_workload_settings (id, org_id) values (false, $1)", [who.agency])).toMatch(/check/);
      await db.query("insert into staff_workload_settings (org_id, rules) values ($1, '{\"horizonDays\": 10}')", [who.agency]);
      expect(await refused(db, "insert into staff_workload_settings (org_id) values ($1)", [who.agency])).toMatch(/duplicate key/);
      expect((await db.query<{ revision: number }>("select revision from staff_workload_settings")).rows[0].revision).toBe(1);
    });
  });

  it("keeps the history append-only, one daily row a day for a person, and lets old rows go only after 400 days, when the person is gone, or in a purge", async () => {
    await probe(async (db, who) => {
      const snap = (extra: string, params: unknown[] = []) =>
        refused(db, `insert into staff_workload_snapshots (org_id, user_id, day, kind, label, points, capacity, overdue, items, capacity_source, rules_revision ${extra ? ", taken_at" : ""})
          values ($1, $2, current_date, $3, 'busy', 18.5, 20, 1, 6, 'person', 1 ${extra ? ", " + extra : ""})`, [who.agency, who.a, ...params]);
      expect(await snap("", ["daily"])).toBeNull();
      await db.query("insert into staff_workload_snapshots (org_id, user_id, day, kind, label, points, capacity, overdue, items, capacity_source, rules_revision) values ($1, $2, current_date, 'daily', 'busy', 18.5, 20, 1, 6, 'person', 1)", [who.agency, who.a]);
      expect(await snap("", ["daily"])).toMatch(/duplicate key/);
      expect(await snap("", ["change"])).toBeNull();
      expect(await snap("", ["hourly"])).toMatch(/check/);
      for (const bad of [
        "label = 'fine'", "points = -1", "capacity = -1", "overdue = -1", "items = -1", "capacity_source = 'guess'", "kind = 'weekly'",
      ]) {
        const [col, val] = bad.split(" = ");
        const cols = { label: "'busy'", points: "1", capacity: "1", overdue: "0", items: "1", capacity_source: "'person'", kind: "'change'" } as Record<string, string>;
        cols[col] = val;
        expect(await refused(db, `insert into staff_workload_snapshots (org_id, user_id, day, label, points, capacity, overdue, items, capacity_source, rules_revision, kind) values ($1, $2, current_date, ${cols.label}, ${cols.points}, ${cols.capacity}, ${cols.overdue}, ${cols.items}, ${cols.capacity_source}, 1, ${cols.kind})`, [who.agency, who.a]), bad).toMatch(/check/);
      }
      expect(await refused(db, "insert into staff_workload_snapshots (org_id, user_id, day, kind, label, points, overdue, items, capacity_source, rules_revision) values ($1, $2, current_date, 'change', null, 3, 0, 2, 'none', 0)", [who.agency, who.a])).toBeNull();
      // Append-only.
      expect(await refused(db, "update staff_workload_snapshots set points = 1 where user_id = $1", [who.a])).toMatch(/append-only/);
      expect(await refused(db, "delete from staff_workload_snapshots where user_id = $1", [who.a])).toMatch(/append-only/);
      // Old rows can go: after 400 days, in a purge, and when the person no longer exists.
      await db.query("insert into staff_workload_snapshots (org_id, user_id, day, kind, label, points, overdue, items, capacity_source, rules_revision, taken_at) values ($1, $2, current_date - 500, 'change', null, 1, 0, 1, 'none', 0, now() - interval '401 days')", [who.agency, who.a]);
      expect(await refused(db, "delete from staff_workload_snapshots where user_id = $1 and taken_at < now() - interval '400 days'", [who.a])).toBeNull();
      expect(await refused(db, "delete from staff_workload_snapshots where user_id = $1 and taken_at > now() - interval '399 days'", [who.a])).toMatch(/append-only/);
      await db.query("select set_config('iaq.purge', 'on', true)");
      expect(await refused(db, "delete from staff_workload_snapshots where user_id = $1", [who.a])).toBeNull();
      await db.query("select set_config('iaq.purge', '', true)");
      expect(await refused(db, "delete from staff_workload_snapshots where user_id = $1", [who.a])).toMatch(/append-only/);
      await db.query("delete from users where id = $1", [who.a]);
      expect((await db.query<{ n: string }>("select count(*)::text as n from staff_workload_snapshots where user_id = $1", [who.a])).rows[0].n).toBe("0");
    });
  });

  it("keeps one open alert for a person, and only an Overloaded or Critical one, with the Critical clock only while Critical", async () => {
    await probe(async (db, who) => {
      const open = (label: string, critical: string | null, extra = "") =>
        refused(db, `insert into staff_workload_alerts (org_id, user_id, label, critical_since ${extra ? ", resolved_at" : ""}) values ($1, $2, $3, $4::timestamptz ${extra ? ", " + extra : ""})`, [who.agency, who.a, label, critical]);
      expect(await open("busy", null)).toMatch(/check/);
      expect(await open("overloaded", "2026-10-26T00:00:00Z")).toMatch(/check/);
      expect(await open("critical", null)).toMatch(/check/);
      expect(await open("overloaded", null)).toBeNull();
      await db.query("insert into staff_workload_alerts (org_id, user_id, label) values ($1, $2, 'overloaded')", [who.agency, who.a]);
      expect(await open("critical", "2026-10-26T00:00:00Z")).toMatch(/duplicate key/);
      // Once it is resolved a new one can open, and a resolved row cannot end before it began.
      await db.query("update staff_workload_alerts set resolved_at = now() where user_id = $1", [who.a]);
      expect(await open("critical", "2026-10-26T00:00:00Z")).toBeNull();
      expect(await refused(db, "update staff_workload_alerts set resolved_at = since - interval '1 hour' where user_id = $1 and resolved_at is not null", [who.a])).toMatch(/check/);
    });
  });

  it("keeps the board history append-only, with ids only and a real change", async () => {
    await probe(async (db, who) => {
      const ins = (over: string, params: unknown[] = []) =>
        refused(db, `insert into work_assignment_events (org_id, source, item_id, from_user, to_user, actor_id, via) values ($1, ${over})`, [who.agency, ...params]);
      expect(await ins("'support', gen_random_uuid(), $2, $3, $2, 'board'", [who.a, who.b])).toBeNull();
      expect(await ins("'support', gen_random_uuid(), null, $2, $2, 'suggestion'", [who.a])).toBeNull();
      expect(await ins("'support', gen_random_uuid(), $2, null, $2, 'board'", [who.a])).toBeNull();
      expect(await ins("'support', gen_random_uuid(), $2, $2, $2, 'board'", [who.a])).toMatch(/check/);
      expect(await ins("'crm', gen_random_uuid(), null, $2, $2, 'board'", [who.a])).toMatch(/check/);
      expect(await ins("'support', gen_random_uuid(), null, $2, $2, 'script'", [who.a])).toMatch(/check/);
      await db.query("insert into work_assignment_events (org_id, source, item_id, to_user, actor_id, via) values ($1, 'project', gen_random_uuid(), $2, $2, 'board')", [who.agency, who.a]);
      expect(await refused(db, "update work_assignment_events set via = 'suggestion'")).toMatch(/append-only/);
      expect(await refused(db, "delete from work_assignment_events")).toMatch(/append-only/);
      await db.query("select set_config('iaq.purge', 'on', true)");
      expect(await refused(db, "delete from work_assignment_events")).toBeNull();
      // It names a person and a client workspace by id and nothing else: no title, no name.
      const cols = (await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'work_assignment_events' order by ordinal_position")).rows.map((c) => c.column_name);
      expect(cols).toEqual(["id", "org_id", "source", "item_id", "client_ref", "from_user", "to_user", "actor_id", "via", "created_at"]);
      const fks = (await db.query<{ conname: string; def: string }>("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'work_assignment_events'::regclass and contype = 'f'")).rows;
      expect(fks.map((f) => f.def).join(" ")).not.toMatch(/users|client/);
    });
  });

  it("answers the helper functions for the person asking, not for the account that owns them", async () => {
    await setWorkload(true);
    const staff = await staffPerson("agency_staff");
    const manager = await staffPerson("agency_manager");
    const client = await staffPerson("none");
    const as = async (userId: string) =>
      withSystem(async (db) => {
        await db.query("select set_config('app.user_id', $1, true), set_config('role', 'iaq_app_user', true)", [userId]);
        const r = await db.query<{ allowed: boolean; team: boolean; manage: boolean; self: boolean; other: boolean }>(
          "select app.staff_workload_allowed() as allowed, app.staff_workload_team_allowed() as team, app.staff_workload_manage_allowed() as manage, app.can_view_staff_workload($1) as self, app.can_view_staff_workload($2) as other",
          [userId, staff.id === userId ? manager.id : staff.id],
        );
        return r.rows[0];
      });
    expect(await as(staff.id)).toEqual({ allowed: true, team: false, manage: false, self: true, other: false });
    expect(await as(manager.id)).toEqual({ allowed: true, team: true, manage: true, self: true, other: true });
    expect(await as(client.id)).toEqual({ allowed: false, team: false, manage: false, self: false, other: false });
    await setWorkload(false);
    expect(await as(manager.id)).toEqual({ allowed: false, team: false, manage: false, self: false, other: false });
    await setWorkload(null);
    expect(await as(manager.id)).toEqual({ allowed: false, team: false, manage: false, self: false, other: false });
    await setWorkload(true);
  });
});

describe("the rollback", () => {
  const clearAll = async (db: Db) => {
    await db.query("select set_config('iaq.purge', 'on', true)");
    for (const t of ["work_assignment_events", "staff_workload_snapshots", "staff_workload_alerts", "staff_time_off", "staff_work_profiles", "staff_workload_settings"]) await db.query(`delete from ${t}`);
    await db.query("select set_config('iaq.purge', '', true)");
    await db.query("delete from notifications where kind = any($1::text[])", [KINDS]);
  };

  it("refuses while a profile, time off, a history row, an alert, an assignment or a changed rule exists, and says what to do", async () => {
    const who = await people();
    const cases: Array<[string, string, unknown[]]> = [
      ["a profile", "insert into staff_work_profiles (user_id, org_id, capacity_points) values ($1, $2, 20)", [who.a, who.agency]],
      ["time off", "insert into staff_time_off (org_id, user_id, starts_on, ends_on) values ($2, $1, current_date, current_date)", [who.a, who.agency]],
      ["a snapshot", "insert into staff_workload_snapshots (org_id, user_id, day, kind, points, overdue, items, capacity_source, rules_revision) values ($2, $1, current_date, 'daily', 1, 0, 1, 'none', 0)", [who.a, who.agency]],
      ["an alert", "insert into staff_workload_alerts (org_id, user_id, label) values ($2, $1, 'overloaded')", [who.a, who.agency]],
      ["an assignment", "insert into work_assignment_events (org_id, source, item_id, to_user, actor_id, via) values ($2, 'support', gen_random_uuid(), $1, $1, 'board')", [who.a, who.agency]],
      ["changed rules", "insert into staff_workload_settings (org_id, rules) values ($1, '{\"horizonDays\": 10}')", [who.agency]],
    ];
    for (const [label, sql, params] of cases) {
      await rolledBack(async (db) => {
        await clearAll(db);
        await db.query(sql, params);
        await expect(runDown(db), label).rejects.toThrow(/Rollback refused: staff workload profiles, time off, history, alerts, assignments or changed rules exist/);
      });
    }
  });

  it("does not refuse for a settings row that changes nothing", async () => {
    const who = await people();
    await rolledBack(async (db) => {
      await clearAll(db);
      await db.query("insert into staff_workload_settings (org_id) values ($1)", [who.agency]);
      await runDown(db);
    });
  });

  it("takes everything it added away when nothing was used: the tables, the functions, the permissions, the override entries, the module switch and the workload notices", async () => {
    const who = await people();
    const before = (await rows<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'agency_user_permission_overrides_permission_check'"))[0].def.match(/'[a-z0-9_.]+'::text/g)?.length ?? 0;
    await rolledBack(async (db) => {
      await clearAll(db);
      await db.query("insert into org_features (org_id, feature, enabled) values ($1, 'staff_workload', true) on conflict do nothing", [who.agency]);
      for (const kind of KINDS) await db.query("insert into notifications (audience, user_id, kind, title) values ('staff', $1, $2, 'A workload notice')", [who.a, kind]);
      await db.query("insert into notifications (audience, user_id, kind, title) values ('staff', $1, 'staff_message_direct', 'A message notice')", [who.a]);
      await db.query("insert into agency_user_permission_overrides (user_id, permission, effect) values ($1, 'agency.workload.view', 'deny')", [who.a]);
      await runDown(db);
      const q = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T & Record<string, unknown>>(sql, params)).rows;
      expect(await q("select relname from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).toEqual([]);
      expect(await q("select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and proname like any(array['staff\\_workload%', 'can\\_view\\_staff\\_workload', 'staff\\_work\\_profile%', 'work\\_assignment%'])")).toEqual([]);
      expect(await q("select 1 from role_permissions where permission like 'agency.workload.%'")).toEqual([]);
      expect(await q("select 1 from org_features where feature = 'staff_workload'")).toEqual([]);
      // The notices the module made go with it (0096's rollback would refuse on them), and the message notice is left alone.
      expect(await q("select kind from notifications where kind = any($1::text[])", [KINDS])).toEqual([]);
      expect(await q("select kind from notifications where kind = 'staff_message_direct' and user_id = $1", [who.a])).toHaveLength(1);
      expect(await q("select 1 from agency_user_permission_overrides where permission like 'agency.workload.%'")).toEqual([]);
      for (const table of ["agency_user_permission_overrides", "invitation_agency_permission_overrides"]) {
        const [c] = await q<{ def: string }>("select pg_get_constraintdef(k.oid) as def from pg_constraint k where k.conname = $1 and k.conrelid = $2::regclass", [`${table}_permission_check`, table]);
        expect(c.def, table).not.toContain("agency.workload");
        expect(c.def, table).toContain("agency.messages.use");
        expect(c.def, table).toContain("agency.support.priority");
      }
      const [after] = await q<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'agency_user_permission_overrides_permission_check'");
      expect(after.def.match(/'[a-z0-9_.]+'::text/g)?.length).toBe(before - 4);
    });
    // After the throwaway rollback it is all still there.
    expect((await rows("select relname from pg_class where relnamespace = 'public'::regnamespace and relname = 'staff_work_profiles'")).length).toBe(1);
  });

  it("runs before 0096's rollback: with workload notices present 0096 refuses, and with 0097 rolled back first it does not", async () => {
    const who = await people();
    const downMessages = readFileSync("supabase/rollbacks/0096_staff_messages.down.sql", "utf8");
    const clearMessages = async (db: Db) => {
      await db.query("alter table staff_conversation_events disable trigger staff_conversation_events_immutable");
      await db.query("delete from staff_conversations");
      await db.query("alter table staff_conversation_events enable trigger staff_conversation_events_immutable");
      await db.query("delete from private_files where bucket = 'staff-messages'");
      await db.query("delete from notifications where audience = 'staff'");
    };
    await rolledBack(async (db) => {
      await clearAll(db);
      await clearMessages(db);
      await db.query("insert into notifications (audience, user_id, kind, title) values ('staff', $1, 'staff_workload_alert', 'A workload notice')", [who.a]);
      await expect((async () => { for (const s of splitStatements(downMessages)) await db.query(s); })()).rejects.toThrow(/Rollback refused: staff notifications exist/);
    });
    await rolledBack(async (db) => {
      await clearAll(db);
      await clearMessages(db);
      await db.query("insert into notifications (audience, user_id, kind, title) values ('staff', $1, 'staff_workload_alert', 'A workload notice')", [who.a]);
      await runDown(db);
      for (const s of splitStatements(downMessages)) await db.query(s);
    });
  });
});
