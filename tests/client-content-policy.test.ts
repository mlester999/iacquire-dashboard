// Founder decision D70 is OPEN: should assigned agency staff need an audited support session to read a client's approvals, activity log, shared knowledge and leads? The stricter rule is
// built as a switch that is OFF, and with it off nothing may change. This proves both halves on embedded Postgres:
//   * with the switch OFF the two permission functions answer exactly as they did before migration 0112, for every permission, in every standing and every session state;
//   * with it ON, and only then, the four permissions need an active read or write support session on that client (like CRM), client members are unaffected, an expired or ended
//     session unlocks nothing, and the rows that RLS lets a person read are exactly the rows that answer says;
//   * only a Super Admin can change the switch, with a written reason, audited with who and when, and changing it to what it is writes nothing.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { PERMISSION_MATRIX } from "@/lib/permissions";
import { getClientContentPolicy, setClientContentPolicy } from "@/server/admin/client-content-policy";
import { getTenantDetail } from "@/server/admin/queries";
import { assignStaff } from "@/server/admin/tenants";
import { addMember, agencyUser, createOrg, createUser } from "./support/fixtures";
import { splitStatements } from "./support/staff-messages";

const FOUR = ["approvals.view", "activity.view", "knowledge.view", "leads.view"] as const;
let world: Awaited<ReturnType<typeof build>>;

async function build() {
  const org = await createOrg({ name: "Content Policy Client" });
  const other = await createOrg({ name: "Other Policy Client" });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const superAdmin = await createUser({ platformRole: "agency_super_admin" });
  const manager = await createUser({ platformRole: "agency_manager" });
  const assigned = await createUser({ platformRole: "agency_staff" });
  const withRead = await createUser({ platformRole: "agency_staff" });
  const withWrite = await createUser({ platformRole: "agency_staff" });
  const expired = await createUser({ platformRole: "agency_staff" });
  const ended = await createUser({ platformRole: "agency_staff" });
  const unassigned = await createUser({ platformRole: "agency_staff" });
  const admin = agencyUser(superAdmin, "agency_super_admin");
  for (const u of [assigned, withRead, withWrite, expired, ended, manager]) await assignStaff(admin, org.id, u.id, true);
  await withSystem(async (db) => {
    const session = (u: { id: string }, mode: string, expires: string, ended: boolean) => db.query(
      `insert into crm_support_sessions (org_id, user_id, mode, reason, expires_at, ended_at) values ($1, $2, $3, 'Looking into a support request', ${expires}, ${ended ? "now()" : "null"})`, [org.id, u.id, mode]);
    await session(withRead, "read", "now() + interval '30 minutes'", false);
    await session(withWrite, "write", "now() + interval '30 minutes'", false);
    // A session that ran its time (it began two hours ago and ran out five minutes ago).
    await db.query("insert into crm_support_sessions (org_id, user_id, mode, reason, started_at, expires_at) values ($1, $2, 'read', 'Looking into a support request', now() - interval '2 hours', now() - interval '5 minutes')", [org.id, expired.id]);
    await session(ended, "read", "now() + interval '30 minutes'", true);
    const agent = (await db.query<{ id: string }>("select id from agent_instances where org_id = $1 order by role_key limit 1", [org.id])).rows[0].id;
    await db.query("insert into approval_requests (org_id, agent_instance_id, kind, title, risk, status) values ($1, $2, 'outreach', 'POLICY-CANARY approval title', 'high', 'pending')", [org.id, agent]);
    await db.query("insert into leads (org_id, business_name, review_status) values ($1, 'POLICY-CANARY lead', 'pending')", [org.id]);
    await db.query("insert into company_knowledge (org_id, section, content) values ($1, 'faq', 'POLICY-CANARY knowledge') on conflict (org_id, section) do update set content = excluded.content", [org.id]);
    await db.query("insert into knowledge_documents (org_id, filename, mime_type, size_bytes, sha256, storage_key, status) values ($1, 'POLICY-CANARY.txt', 'text/plain', 10, repeat('a', 64), $2, 'ready')", [org.id, `policy-canary/${org.id}`]);
    await db.query("insert into agent_runs (org_id, agent_instance_id, purpose, idempotency_key, status) values ($1, $2, 'chat', $3, 'completed')", [org.id, agent, `policy-canary-${org.id}`]);
    await db.query("insert into audit_logs (org_id, actor_kind, action, target_type, result) values ($1, 'system', 'policy.canary', 'organization', 'success')", [org.id]);
  });
  return { org, other, owner, admin, superAdmin, manager, users: { assigned, withRead, withWrite, expired, ended, unassigned } };
}

beforeAll(async () => {
  world = await build();
});
afterEach(async () => {
  await withSystem((db) => db.query("update agency_policy_switches set enabled = false, changed_by = null, changed_at = null, note = null"));
});

const turnOn = () => setClientContentPolicy(world.admin, { sessionRequired: true, note: "Trying the stricter rule in a test" });

/** What a person reads of the client's content through row-level security: the way the application role would. */
async function readable(userId: string) {
  return withUser(userId, async (db) => ({
    approvals: (await db.query("select 1 from approval_requests where org_id = $1", [world.org.id])).rows.length,
    leads: (await db.query("select 1 from leads where org_id = $1", [world.org.id])).rows.length,
  }));
}

/** The same, for every kind of content the four permissions guard, and the audit log (which has a branch of its own for a Super Admin). */
async function readableEverywhere(userId: string) {
  return withUser(userId, async (db) => {
    const n = async (sql: string) => (await db.query(sql, [world.org.id])).rows.length;
    return {
      approvals: await n("select 1 from approval_requests where org_id = $1"),
      leads: await n("select 1 from leads where org_id = $1"),
      knowledge: await n("select 1 from company_knowledge where org_id = $1"),
      documents: await n("select 1 from knowledge_documents where org_id = $1"),
      runs: await n("select 1 from agent_runs where org_id = $1"),
      audit: await n("select 1 from audit_logs where org_id = $1 and action = 'policy.canary'"),
    };
  });
}
const ALL = { approvals: 1, leads: 1, knowledge: 1, documents: 1, runs: 1, audit: 1 };
const NONE = { approvals: 0, leads: 0, knowledge: 0, documents: 0, runs: 0, audit: 0 };

describe("the switch starts off, and off changes nothing", () => {
  it("is off after the migration and says so", async () => {
    expect(await getClientContentPolicy()).toEqual({ sessionRequired: false, changedAt: null, changedByName: null, note: null });
    expect((await withSystem((db) => db.query<{ on: boolean }>("select app.client_content_session_required() as on"))).rows[0].on).toBe(false);
  });

  it("lets assigned staff read a client's approvals and leads without a session, exactly as before (today's behaviour is kept)", async () => {
    for (const who of [world.users.assigned, world.users.withRead, world.users.withWrite, world.users.expired, world.users.ended, world.manager]) {
      expect(await readable(who.id), who.id).toEqual({ approvals: 1, leads: 1 });
    }
    expect(await readable(world.owner.id)).toEqual({ approvals: 1, leads: 1 });
    expect(await readable(world.users.unassigned.id)).toEqual({ approvals: 0, leads: 0 });
  });

  it("answers exactly as the functions did before 0112, for every permission, every standing and every session state", async () => {
    // The old functions are the ones in the rollback script, installed under other names for the length of this check.
    const down = readFileSync("supabase/rollbacks/0112_client_content_policy.down.sql", "utf8");
    const oldFns = down.match(/create or replace function app\.has_permission[\s\S]*?\n\$\$;/)?.[0] + "\n" + down.match(/create or replace function app\.permitted_orgs[\s\S]*?\n\$\$;/)?.[0];
    expect(oldFns).toContain("has_permission");
    const renamed = oldFns.replaceAll("app.has_permission", "app.has_permission_old").replaceAll("app.permitted_orgs", "app.permitted_orgs_old");
    const permissions = Object.keys(PERMISSION_MATRIX);
    expect(permissions.length).toBeGreaterThan(100);
    const people = [world.owner, world.superAdmin, world.manager, ...Object.values(world.users)];
    class Done extends Error {}
    const diffs: string[] = [];
    await withSystem(async (db) => {
      for (const stmt of splitStatements(renamed)) await db.query(stmt);
      for (const person of people) {
        await db.query("select set_config('app.user_id', $1, true)", [person.id]);
        for (const orgId of [world.org.id, world.other.id]) {
          for (const p of permissions) {
            const a = (await db.query<{ n: boolean; o: boolean }>("select app.has_permission($1, $2) as n, app.has_permission_old($1, $2) as o", [orgId, p])).rows[0];
            if (a.n !== a.o) diffs.push(`has_permission ${person.id} ${orgId === world.org.id ? "client" : "other"} ${p}: ${a.o} -> ${a.n}`);
          }
        }
        for (const p of permissions) {
          const b = (await db.query<{ n: string[]; o: string[] }>("select app.permitted_orgs($1)::text[] as n, app.permitted_orgs_old($1)::text[] as o", [p])).rows[0];
          if (JSON.stringify([...b.n].sort()) !== JSON.stringify([...b.o].sort())) diffs.push(`permitted_orgs ${person.id} ${p}`);
        }
      }
      throw new Done();
    }).catch((e) => {
      if (!(e instanceof Done)) throw e;
    });
    expect(diffs).toEqual([]);
  }, 120_000);
});

describe("with the switch ON, the four need a support session like CRM does", () => {
  it("takes them away from staff without a session, and from a session that expired or ended", async () => {
    await turnOn();
    for (const who of [world.users.assigned, world.users.expired, world.users.ended, world.manager]) expect(await readable(who.id), who.id).toEqual({ approvals: 0, leads: 0 });
    expect(await readable(world.users.unassigned.id)).toEqual({ approvals: 0, leads: 0 });
  });

  it("gives them back to a read session and a write session on that client", async () => {
    await turnOn();
    expect(await readable(world.users.withRead.id)).toEqual({ approvals: 1, leads: 1 });
    expect(await readable(world.users.withWrite.id)).toEqual({ approvals: 1, leads: 1 });
  });

  it("never touches client members", async () => {
    await turnOn();
    expect(await readable(world.owner.id)).toEqual({ approvals: 1, leads: 1 });
  });

  it("changes the answer for exactly the four permissions and no others", async () => {
    const people = [world.superAdmin, world.manager, ...Object.values(world.users)];
    const permissions = Object.keys(PERMISSION_MATRIX);
    const answers = async () => {
      const out: Record<string, boolean> = {};
      await withSystem(async (db) => {
        for (const person of people) {
          await db.query("select set_config('app.user_id', $1, true)", [person.id]);
          for (const p of permissions) out[`${person.id}|${p}`] = (await db.query<{ ok: boolean }>("select app.has_permission($1, $2) as ok", [world.org.id, p])).rows[0].ok;
        }
      });
      return out;
    };
    const before = await answers();
    await turnOn();
    const after = await answers();
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    expect(changed.length).toBeGreaterThan(0);
    for (const k of changed) {
      expect(FOUR as readonly string[], k).toContain(k.split("|")[1]);
      expect(before[k], k).toBe(true);
      expect(after[k], k).toBe(false);
    }
    // And nobody who holds a session lost anything.
    for (const who of [world.users.withRead, world.users.withWrite]) for (const p of FOUR) expect(after[`${who.id}|${p}`], `${who.id} ${p}`).toBe(before[`${who.id}|${p}`]);
  }, 120_000);

  it("is undone by switching it off again", async () => {
    await turnOn();
    await setClientContentPolicy(world.admin, { sessionRequired: false, note: "Back to assigned staff reading" });
    expect(await readable(world.users.assigned.id)).toEqual({ approvals: 1, leads: 1 });
  });
});

describe("who can change the switch, and what that leaves behind", () => {
  it("is for a Super Admin only, with a reason, and records who and why", async () => {
    for (const bad of [agencyUser(world.manager, "agency_manager"), agencyUser(world.users.assigned, "agency_staff"), { ...world.admin, platformRole: "none" as const }]) {
      await expect(setClientContentPolicy(bad, { sessionRequired: true, note: "Trying without the right role" })).rejects.toMatchObject({ code: "forbidden" });
    }
    await expect(setClientContentPolicy(world.admin, { sessionRequired: true, note: "short" })).rejects.toMatchObject({ code: "invalid_input" });
    // A session that says Super Admin but whose person is no longer one is refused by the database's own record.
    const demoted = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_super_admin");
    await expect(setClientContentPolicy(demoted, { sessionRequired: true, note: "Authorization has changed" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await getClientContentPolicy()).sessionRequired).toBe(false);
    const on = await setClientContentPolicy(world.admin, { sessionRequired: true, note: "Counsel asked for the stricter rule" });
    expect(on).toMatchObject({ sessionRequired: true, note: "Counsel asked for the stricter rule" });
    expect(on.changedAt).toBeTruthy();
    expect(on.changedByName).toBeTruthy();
    const audit = (await withSystem((db) => db.query<{ action: string; actor_user_id: string; metadata: Record<string, unknown> }>(
      "select action, actor_user_id, metadata from audit_logs where action like 'agency_policy.client_content%' order by created_at desc limit 1"))).rows[0];
    expect(audit).toMatchObject({ action: "agency_policy.client_content_session_required", actor_user_id: world.superAdmin.id });
    expect(audit.metadata).toMatchObject({ from: false, to: true, permissions: [...FOUR] });
  });

  it("writes nothing when asked to set what it already is, and is server-only for every signed-in role", async () => {
    const count = async () => Number((await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from audit_logs where action like 'agency_policy.%'"))).rows[0].n);
    const before = await count();
    await setClientContentPolicy(world.admin, { sessionRequired: false, note: "Already off, nothing to do" });
    expect(await count()).toBe(before);
    for (const role of ["iaq_app_user", "iaq_site_runtime"]) {
      const [t] = (await withSystem((db) => db.query<{ s: boolean; u: boolean }>("select has_table_privilege($1, 'agency_policy_switches', 'select') as s, has_table_privilege($1, 'agency_policy_switches', 'update') as u", [role]))).rows;
      expect(t, role).toEqual({ s: false, u: false });
    }
    // The staff are told when it changes.
    await turnOn();
    const told = await withSystem((db) => db.query<{ title: string }>("select title from notifications where kind = 'system' and title like 'Client approvals, activity, knowledge and leads now need%'"));
    expect(told.rows.length).toBeGreaterThan(0);
  });
});

describe("the rollback", () => {
  it("is refused while the switch is on, and otherwise puts the old functions back", async () => {
    const down = readFileSync("supabase/rollbacks/0112_client_content_policy.down.sql", "utf8");
    class Done extends Error {}
    await turnOn();
    await expect(withSystem(async (db) => {
      for (const stmt of splitStatements(down)) await db.query(stmt);
      throw new Done();
    })).rejects.toThrow(/Rollback refused: the client content policy is switched on/);
    await setClientContentPolicy(world.admin, { sessionRequired: false, note: "Off before the rollback" });
    await expect(withSystem(async (db) => {
      for (const stmt of splitStatements(down)) await db.query(stmt);
      const src = (await db.query<{ prosrc: string }>("select prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'app' and p.proname in ('has_permission', 'permitted_orgs')")).rows.map((r) => r.prosrc).join("\n");
      expect(src).not.toContain("client_content_session_required");
      expect((await db.query("select to_regclass('agency_policy_switches')::text as t")).rows[0]).toEqual({ t: null });
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});

describe("every kind of content the four permissions guard, read through row-level security", () => {
  it("is read by assigned staff, a manager and a Super Admin today, with the switch off", async () => {
    for (const who of [world.users.assigned, world.manager, world.superAdmin]) expect(await readableEverywhere(who.id), who.id).toEqual(ALL);
    expect(await readableEverywhere(world.owner.id)).toMatchObject({ approvals: 1, leads: 1, knowledge: 1, documents: 1 });
    expect(await readableEverywhere(world.users.unassigned.id)).toEqual({ ...NONE });
  });

  it("with the switch on is read by nobody on the agency side without a session, a Super Admin included, EXCEPT the audit log, which a Super Admin keeps reading", async () => {
    await turnOn();
    for (const who of [world.users.assigned, world.manager, world.users.expired, world.users.ended]) expect(await readableEverywhere(who.id), who.id).toEqual(NONE);
    // The audit log is the record of what staff did, including every support session: reading it cannot depend on a session a staff member opens. Documented in docs/staff-access-privacy.md.
    expect(await readableEverywhere(world.superAdmin.id)).toEqual({ ...NONE, audit: 1 });
  });

  it("with the switch on and a session, gives every kind back to that person", async () => {
    await turnOn();
    for (const who of [world.users.withRead, world.users.withWrite]) expect(await readableEverywhere(who.id), who.id).toEqual({ ...ALL, audit: 1 });
    expect(await readableEverywhere(world.owner.id)).toMatchObject({ approvals: 1, leads: 1, knowledge: 1, documents: 1 });
  });

  it("is a known list of policies: a new table guarded by one of the four, or a new way around the support session, is a decision for the founder and fails here until the document says so", async () => {
    const rows = (await withSystem((db) => db.query<{ tablename: string; qual: string }>(
      `select tablename, qual from pg_policies where schemaname = 'public' and cmd in ('SELECT', 'ALL')
          and qual ~ 'approvals\.view|activity\.view|knowledge\.view|leads\.view' order by tablename`))).rows;
    expect(rows.map((r) => r.tablename)).toEqual([
      "agent_runs", "ai_work_events", "ai_work_jobs", "ai_work_report_deliveries", "ai_work_reports", "approval_events", "approval_requests", "audit_logs", "company_knowledge", "crm_support_sessions",
      "employee_knowledge_entries", "knowledge_documents", "lead_research_requests", "lead_targeting_profiles", "leads",
    ]);
    // The only one of them with a way around the permission is the audit log's Super Admin branch.
    expect(rows.filter((r) => /is_agency_admin|is_agency_staff|platform_role/.test(r.qual)).map((r) => r.tablename)).toEqual(["audit_logs"]);
  });
});

describe("the admin screen's trusted reader asks the same question", () => {
  // The admin client detail reads with trusted server access, so row-level security cannot answer for it. It asks clientContentAccess() directly instead, or the
  // founder's stricter rule would cover every screen except the one where held client knowledge is read verbatim (docs/staff-access-privacy.md, option B).
  const held = async () => withSystem((db) => db.query(
    "update company_knowledge set review_status = 'pending_agency_review' where org_id = $1 and section = 'faq'", [world.org.id],
  ));
  const reset = async () => withSystem((db) => db.query("update company_knowledge set review_status = 'approved' where org_id = $1", [world.org.id]));
  afterEach(reset);

  it("shows a held entry with the switch off, which is today's behaviour and is not changed by this work", async () => {
    await held();
    const detail = await getTenantDetail(world.admin, world.org.id);
    expect(detail.contentAccess).toMatchObject({ sessionRequired: false, permitted: true, heldKnowledgeHidden: 0 });
    expect(detail.heldKnowledge.map((k) => k.section)).toContain("faq");
    expect(detail.heldKnowledge.find((k) => k.section === "faq")?.content).toContain("POLICY-CANARY knowledge");
  });

  it("withholds the text, and says how many entries it withheld, when the rule is on and the reader has no session", async () => {
    await held();
    await turnOn();
    const detail = await getTenantDetail(agencyUser(world.users.assigned, "agency_staff"), world.org.id);
    expect(detail.contentAccess).toMatchObject({ sessionRequired: true, hasSession: false, permitted: false, heldKnowledgeHidden: 1 });
    expect(detail.heldKnowledge).toEqual([]);
  });

  it("shows it again inside an active support session", async () => {
    await held();
    await turnOn();
    const detail = await getTenantDetail(agencyUser(world.users.withRead, "agency_staff"), world.org.id);
    expect(detail.contentAccess).toMatchObject({ sessionRequired: true, hasSession: true, permitted: true, heldKnowledgeHidden: 0 });
    expect(detail.heldKnowledge.map((k) => k.section)).toContain("faq");
  });

  it("is not reachable at all from a client membership, whatever the switch says", async () => {
    await expect(getTenantDetail({ ...world.admin, platformRole: "none" }, world.org.id)).rejects.toMatchObject({ code: "not_found" });
  });
});
