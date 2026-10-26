import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { resetRateLimits } from "./support/support-world";
import { approvedProject, projectsWorld, type ProjectsWorld } from "./support/projects-world";
import { createUser } from "./support/fixtures";

// Migration 0098: the schema, who can read it, what the database itself refuses, and a rollback that never drops a client's request, change order, recorded answer or scope.
// Each rollback case runs inside a transaction that is always rolled back, so the shared test database is untouched.

class Done extends Error {}
const UP = readFileSync("supabase/migrations/0098_requests_completion.sql", "utf8");
const DOWN = readFileSync("supabase/rollbacks/0098_requests_completion.down.sql", "utf8");

/** Splits a script into statements, keeping `$$ ... $$` bodies whole (the test driver runs one statement per call). */
function statements(sql: string): string[] {
  const out: string[] = [];
  let cur: string[] = [];
  let inside = false;
  for (const raw of sql.split("\n")) {
    const line = raw.replace("\r", "");
    if (!inside && (line.trim() === "" || line.trim().startsWith("--"))) continue;
    cur.push(line);
    if (line.split("$$").length % 2 === 0) inside = !inside;
    if (!inside && line.trimEnd().endsWith(";")) {
      out.push(cur.join("\n"));
      cur = [];
    }
  }
  return out;
}

type Db = { query: <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }> };
const run = async (db: Db, sql: string) => {
  for (const statement of statements(sql)) await db.query(statement);
};

/** Runs a statement that the database must refuse, inside a savepoint so the transaction survives; returns the message, or null when it was accepted. */
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

const TABLES = [
  "support_ticket_change", "project_change_orders", "project_change_order_decisions", "project_scope_amendments", "project_prerequisites", "support_message_mentions",
  "support_ticket_ai_triage", "support_surveys",
];
const NEW_KINDS = ["support_mention", "support_survey", "project_change_order", "project_prerequisite", "project_review_overdue"];
const NEW_CATEGORIES = ["change_ai_employee", "change_website", "change_automation", "change_integration", "change_project", "change_other"];
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

let w: ProjectsWorld;
let otherProject: string;
beforeAll(async () => {
  w = await projectsWorld();
  // A project agreed in the second workspace, written directly: the tests below try to cross from the first workspace into it.
  await withSystem(async (db) => {
    otherProject = (await db.query<{ id: string }>("insert into client_project_requests (org_id, created_by, title, status) values ($1, $2, 'Other workspace project', 'approved') returning id", [w.otherOrg.id, w.people.outsider.id])).rows[0].id;
    await db.query("insert into client_projects (request_id, org_id, agreed_price_cents, currency) values ($1, $2, 90000, 'USD')", [otherProject, w.otherOrg.id]);
  });
});
beforeEach(resetRateLimits);

const ticketSql = "insert into support_tickets (org_id, created_by, subject, category, request_type, project_id) values ($1, $2, $3, $4, $5, $6) returning id";
const ticket = (db: Db, subject: string, opts: { type?: string; category?: string; project?: string | null; org?: string; by?: string } = {}) =>
  db.query<{ id: string }>(ticketSql, [opts.org ?? w.org.id, opts.by ?? w.people.owner.id, subject, opts.category ?? "general", opts.type ?? "support", opts.project ?? null]).then((r) => r.rows[0].id);
const changeTicket = (db: Db, subject: string, project: string | null = null) => ticket(db, subject, { type: "change", category: project ? "change_project" : "change_other", project });

const orderSql = "insert into project_change_orders (org_id, request_id, title, description, requested_by) values ($1, $2, $3, 'Please connect a second calendar for the front desk.', $4) returning id";
const newOrder = (db: Db, project: string, title = "Add a second calendar") => db.query<{ id: string }>(orderSql, [w.org.id, project, title, w.people.owner.id]).then((r) => r.rows[0].id);
const review = (db: Db, id: string, classification = "out_of_scope") => db.query("update project_change_orders set status = 'under_review', classification = $2 where id = $1", [id, classification]);
const QUOTE_SQL = `update project_change_orders set status = 'quoted', quote_version = quote_version + 1, quoted_by = $2, quoted_at = now(), additional_cents = $3, currency = 'USD',
  additional_weeks_min = 1, additional_weeks_max = 2, terms_text = 'Seed terms', content_hash = $4 where id = $1`;
const quote = (db: Db, id: string, cents = 25000, hash = HASH) => db.query(QUOTE_SQL, [id, w.raw.staff.id, cents, hash]);
const decide = (db: Db, id: string, decision: "accepted" | "declined", opts: { version?: number; hash?: string } = {}) =>
  db.query("insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, $3, $4, $5, $6, 'I accept this change and its price.')",
    [id, w.org.id, opts.version ?? 1, decision, w.people.owner.id, opts.hash ?? HASH]);
const orderRow = async (db: Db, id: string) => (await db.query<Record<string, unknown>>("select * from project_change_orders where id = $1", [id])).rows[0];

const count = (userId: string, table: string) => withUser(userId, async (db) => Number((await db.query<{ n: string }>(`select count(*)::text as n from ${table}`)).rows[0].n));

describe("the migration file", () => {
  it("is additive: it drops no table, column or row, and touches only the lists it extends, one foreign key and one trigger function of 0015", () => {
    const code = UP.replace(/--[^\n]*/g, "");
    expect(code).not.toMatch(/\bdrop\s+(table|column|index|function|trigger|policy)\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\btruncate\b/i);
    expect(code).not.toMatch(/\bupdate\s+[a-z_]+\s+set\b/i);
    expect([...code.matchAll(/drop constraint (\w+)/gi)].map((m) => m[1]).sort()).toEqual(["notifications_kind_check", "support_tickets_project_id_fkey"]);
    expect([...code.matchAll(/create or replace function ([\w.]+)/gi)].map((m) => m[1])).toEqual(["app.quote_approvals_append_only"]);
    expect([...code.matchAll(/insert\s+into\s+(\w+)/gi)].map((m) => m[1])).toEqual(["support_notification_rules"]);
    // Nothing is granted but SELECT, and nothing to a role other than the application role.
    expect([...code.matchAll(/\bgrant\s+(\w+)/gi)].map((m) => m[1].toLowerCase()).filter((g) => g !== "select")).toEqual([]);
    expect([...code.matchAll(/\bgrant\b[^;]*\bto\s+([\w, ]+);/gi)].flatMap((m) => m[1].split(",").map((r) => r.trim())).filter((r) => r !== "iaq_app_user")).toEqual([]);
    // A job registers nothing here: no job, no scheduler setting, no feature switch.
    expect(code).not.toMatch(/org_features/);
  });
});

describe("the schema is closed by default", () => {
  it("has row-level security on every table and no access for anon, authenticated, PUBLIC or the published-site role", async () => {
    await withSystem(async (db) => {
      const meta = (await db.query<{ relname: string; relrowsecurity: boolean; relacl: string | null }>("select relname, relrowsecurity, relacl::text as relacl from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).rows;
      expect(meta.map((m) => m.relname).sort()).toEqual([...TABLES].sort());
      for (const m of meta) {
        expect(m.relrowsecurity, m.relname).toBe(true);
        expect(m.relacl ?? "", m.relname).not.toMatch(/(^\{|,)=/);
        for (const role of ["anon", "authenticated", "iaq_site_runtime"]) expect(m.relacl ?? "", `${m.relname} ${role}`).not.toContain(`${role}=`);
      }
      const priv = (await db.query<{ t: string; ok: boolean }>(
        `select t, bool_or(has_any_column_privilege(r, format('public.%I', t), 'select, insert, update, references')) as ok from unnest($1::text[]) t, unnest(array['anon', 'authenticated', 'iaq_site_runtime']) r group by t`, [TABLES],
      )).rows;
      expect(priv.filter((x) => x.ok)).toEqual([]);
    });
  });

  it("gives the application role select only, with one select policy per table through the viewer's permission", async () => {
    await withSystem(async (db) => {
      const grants = (await db.query<{ t: string; write: boolean; read: boolean }>(
        `select t, has_any_column_privilege('iaq_app_user', format('public.%I', t), 'insert, update') or has_table_privilege('iaq_app_user', format('public.%I', t), 'delete, truncate') as write,
           has_any_column_privilege('iaq_app_user', format('public.%I', t), 'select') as read from unnest($1::text[]) t`, [TABLES],
      )).rows;
      for (const g of grants) {
        expect(g.write, `${g.t} must not be writable by the application role`).toBe(false);
        expect(g.read, g.t).toBe(true);
      }
      const policies = (await db.query<{ tablename: string; cmd: string; qual: string }>("select tablename, cmd, qual from pg_policies where tablename = any($1::text[]) order by tablename", [TABLES])).rows;
      expect(policies.map((p) => p.tablename).sort()).toEqual([...TABLES].sort());
      for (const p of policies) {
        expect(p.cmd).toBe("SELECT");
        expect(p.qual, p.tablename).toMatch(/permitted_orgs\('(projects\.view|agency\.support\.view)'/);
      }
    });
  });

  it("keeps the team's own columns out of the client's reach", async () => {
    await withSystem(async (db) => {
      const can = async (table: string, column: string) => (await db.query<{ ok: boolean }>("select has_column_privilege('iaq_app_user', $1, $2, 'select') as ok", [`public.${table}`, column])).rows[0].ok;
      for (const column of ["internal_notes", "idempotency_key", "quoted_by", "applied_by"]) expect(await can("project_change_orders", column), `project_change_orders.${column}`).toBe(false);
      for (const column of ["title", "description", "status", "additional_cents", "terms_text", "content_hash"]) expect(await can("project_change_orders", column), `project_change_orders.${column}`).toBe(true);
      expect(await can("project_change_order_decisions", "ip_hash")).toBe(false);
      expect(await can("project_change_order_decisions", "acknowledgement")).toBe(true);
      for (const column of ["evidence_note", "waived_reason", "satisfied_by", "waived_by", "created_by", "source_id"]) expect(await can("project_prerequisites", column), `project_prerequisites.${column}`).toBe(false);
      for (const column of ["label", "status", "kind", "satisfied_at"]) expect(await can("project_prerequisites", column), `project_prerequisites.${column}`).toBe(true);
    });
  });
});

describe("who reads what", () => {
  it("shows a change order to the workspace that owns it and the team that works on it, and to no one else", async () => {
    const { id: project } = await approvedProject(w, "Read project");
    const order = await withSystem((db) => newOrder(db, project, "Read me"));
    for (const id of [w.people.owner.id, w.people.admin.id, w.people.member.id, w.raw.staff.id, w.raw.superAdmin.id]) {
      const seen = await withUser(id, async (db) => (await db.query<{ id: string }>("select id from project_change_orders where id = $1", [order])).rows);
      expect(seen, id).toHaveLength(1);
    }
    for (const id of [w.people.outsider.id, w.raw.outStaff.id]) {
      const seen = await withUser(id, async (db) => (await db.query<{ id: string }>("select id from project_change_orders where id = $1", [order])).rows);
      expect(seen, id).toHaveLength(0);
    }
    await expect(withUser(w.people.owner.id, (db) => db.query("select internal_notes from project_change_orders"))).rejects.toThrow(/permission denied/);
    await expect(withUser(w.people.owner.id, (db) => db.query("select idempotency_key from project_change_orders"))).rejects.toThrow(/permission denied/);
    await expect(withUser(w.people.owner.id, (db) => db.query("update project_change_orders set title = 'Changed by a client' where id = $1", [order]))).rejects.toThrow(/permission denied/);
    await expect(withUser(w.people.owner.id, (db) => db.query("delete from project_change_orders where id = $1", [order]))).rejects.toThrow(/permission denied/);
  });

  it("keeps the classification, the mentions and the triage record away from clients, and shows them to the team", async () => {
    const t = await withSystem(async (db) => {
      const id = await changeTicket(db, "Team-only records");
      await db.query("insert into support_ticket_change (ticket_id, org_id, target_kind, classification, classified_by, classified_at) values ($1, $2, 'other', 'covered', $3, now())", [id, w.org.id, w.raw.staff.id]);
      const note = (await db.query<{ id: string }>("insert into support_messages (ticket_id, org_id, author_id, author_kind, body, internal) values ($1, $2, $3, 'agency', 'Private note', true) returning id", [id, w.org.id, w.raw.staff.id])).rows[0].id;
      await db.query("insert into support_message_mentions (message_id, ticket_id, org_id, mentioned_user_id, created_by) values ($1, $2, $3, $4, $4)", [note, id, w.org.id, w.raw.staff2.id]);
      await db.query("insert into support_ticket_ai_triage (ticket_id, org_id) values ($1, $2)", [id, w.org.id]);
      return id;
    });
    for (const table of ["support_ticket_change", "support_message_mentions", "support_ticket_ai_triage"]) {
      expect(await count(w.people.owner.id, table), `owner reads ${table}`).toBe(0);
      expect(await count(w.people.admin.id, table), `admin reads ${table}`).toBe(0);
      expect(await count(w.raw.outStaff.id, table), `out-of-scope staff reads ${table}`).toBe(0);
      expect(await count(w.raw.staff.id, table), `staff reads ${table}`).toBeGreaterThanOrEqual(1);
    }
    expect(t).toBeTruthy();
  });

  it("shows a survey to the person it was sent to, to the people who see the whole workspace's requests, and to the team", async () => {
    const id = await withSystem(async (db) => {
      const tid = await ticket(db, "Survey subject", { by: w.people.member.id });
      await db.query("insert into support_surveys (org_id, kind, ticket_id, requested_for_user_id) values ($1, 'ticket_resolution', $2, $3)", [w.org.id, tid, w.people.member.id]);
      return tid;
    });
    const seen = (userId: string) => withUser(userId, async (db) => (await db.query("select 1 from support_surveys where ticket_id = $1", [id])).rows.length);
    expect(await seen(w.people.member.id)).toBe(1);
    expect(await seen(w.people.owner.id)).toBe(1);
    expect(await seen(w.people.admin.id)).toBe(1);
    expect(await seen(w.raw.staff.id)).toBe(1);
    // Another member of the same workspace, a person of another workspace and a team member who does not work on this client see nothing.
    const colleague = await createUser();
    await withSystem((db) => db.query("insert into organization_memberships (org_id, user_id, role) values ($1, $2, 'member')", [w.org.id, colleague.id]));
    expect(await seen(colleague.id)).toBe(0);
    expect(await seen(w.people.outsider.id)).toBe(0);
    expect(await seen(w.raw.outStaff.id)).toBe(0);
  });
});

describe("the request types, categories, timeline kinds and notification kinds", () => {
  it("accept the new values alongside every old one, and still refuse an unknown one", async () => {
    await withSystem(async (db) => {
      const sql = "insert into support_tickets (org_id, created_by, subject, category, request_type) values ($1, $2, $3, $4, $5)";
      for (const category of NEW_CATEGORIES) await db.query(sql, [w.org.id, w.people.owner.id, `Change in ${category}`, category, "change"]);
      for (const [type, category] of [["support", "billing"], ["issue", "feature_not_working"], ["support", "bug"], ["support", "maintenance"], ["support", "project"]] as const) {
        await db.query(sql, [w.org.id, w.people.owner.id, `Old ${category}`, category, type]);
      }
      await db.query("insert into support_tickets (org_id, created_by, subject, category, request_type, feedback_stage) values ($1, $2, 'Feedback still works', 'improvement', 'feedback', 'received')", [w.org.id, w.people.owner.id]);
      expect(await refused(db, sql, [w.org.id, w.people.owner.id, "Unknown type", "general", "complaint"])).toMatch(/support_tickets_request_type_check/);
      expect(await refused(db, sql, [w.org.id, w.people.owner.id, "Unknown category", "change_everything", "change"])).toMatch(/support_tickets_category_check/);
      // A change is not feedback: the feedback stage rule is untouched.
      expect(await refused(db, "insert into support_tickets (org_id, created_by, subject, request_type, category, feedback_stage) values ($1, $2, 'x y z', 'change', 'change_other', 'received')", [w.org.id, w.people.owner.id])).toMatch(/support_tickets_feedback_type_check/);
    });
  });

  it("accept the four new timeline kinds and the two new notification events, with their rules seeded in-app", async () => {
    await withSystem(async (db) => {
      const t = await ticket(db, "Kinds");
      for (const kind of ["mentioned", "change_classified", "survey_answered", "ai_triage_applied", "created", "ai_assist"]) {
        await db.query("insert into support_ticket_events (ticket_id, org_id, kind, visibility, actor_kind) values ($1, $2, $3, 'internal', 'agency')", [t, w.org.id, kind]);
      }
      expect(await refused(db, "insert into support_ticket_events (ticket_id, org_id, kind) values ($1, $2, 'gossip')", [t, w.org.id])).toMatch(/support_ticket_events_kind_check/);
      for (const event of ["staff_mention", "survey_requested", "request_submitted", "closed"]) {
        await db.query("insert into support_notification_log (ticket_id, org_id, event_kind, event_key, recipient_user_id, channel, status) values ($1, $2, $3, $4, $5, 'in_app', 'delivered')", [t, w.org.id, event, `kinds-${event}`, w.raw.staff.id]);
      }
      expect(await refused(db, "insert into support_notification_log (ticket_id, org_id, event_kind, event_key, recipient_user_id, channel, status) values ($1, $2, 'gossip', 'kinds-gossip', $3, 'in_app', 'delivered')", [t, w.org.id, w.raw.staff.id])).toMatch(/support_notification_log_event_kind_check/);
      const rules = (await db.query<{ event_kind: string; mode: string }>("select event_kind, mode from support_notification_rules order by event_kind")).rows;
      expect(rules).toHaveLength(13);
      expect(rules.filter((r) => ["staff_mention", "survey_requested"].includes(r.event_kind))).toEqual([{ event_kind: "staff_mention", mode: "in_app" }, { event_kind: "survey_requested", mode: "in_app" }]);
    });
  });

  it("accept the five new notification kinds, keep the older ones, and refuse an unknown kind", async () => {
    await withSystem(async (db) => {
      const def = (await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check'")).rows[0].d;
      const allowed = new Set([...def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]));
      for (const kind of [...NEW_KINDS, "support_reply", "support_status", "project_quote", "invoice_paid", "proposal_accepted", "social_post_failed", "conversation_assigned"]) expect(allowed.has(kind), kind).toBe(true);
      for (const kind of NEW_KINDS) await db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, $3, 'probe')", [w.org.id, w.people.owner.id, kind]);
      expect(await refused(db, "insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'project_nonsense', 'probe')", [w.org.id, w.people.owner.id])).toMatch(/notifications_kind_check/);
    });
  });
});

describe("a Request a Change record", () => {
  it("belongs only to a change request, names the project the request names, and is classified or not as a pair", async () => {
    const { id: project } = await approvedProject(w, "Change record project");
    await withSystem(async (db) => {
      const plain = await ticket(db, "A plain question");
      const issue = await ticket(db, "An issue", { type: "issue", category: "feature_not_working" });
      const other = await changeTicket(db, "Change to the website");
      const forProject = await changeTicket(db, "Change to the project", project);
      const insert = "insert into support_ticket_change (ticket_id, org_id, target_kind, project_id) values ($1, $2, $3, $4)";
      expect(await refused(db, insert, [plain, w.org.id, "other", null])).toMatch(/Request a Change/);
      expect(await refused(db, insert, [issue, w.org.id, "other", null])).toMatch(/Request a Change/);
      // A project target must name a project (and the other way round), and it must be the project the request itself carries.
      expect(await refused(db, insert, [other, w.org.id, "project", null])).toMatch(/support_ticket_change_check/);
      expect(await refused(db, insert, [other, w.org.id, "website", project])).toMatch(/support_ticket_change_check|Request a Change/);
      expect(await refused(db, insert, [forProject, w.org.id, "project", otherProject])).not.toBeNull();
      expect(await refused(db, insert, [other, w.otherOrg.id, "website", null])).not.toBeNull();
      expect(await refused(db, insert, [forProject, w.org.id, "project", project])).toBeNull();
      await db.query(insert, [other, w.org.id, "website", null]);
      expect(await refused(db, "update support_ticket_change set classification = 'covered' where ticket_id = $1", [other])).toMatch(/support_ticket_change_check/);
      expect(await refused(db, "update support_ticket_change set classification = 'free_of_charge', classified_at = now() where ticket_id = $1", [other])).toMatch(/classification_check/);
      expect(await refused(db, "update support_ticket_change set classification = 'managed_allowance', classified_at = now(), classified_by = $2 where ticket_id = $1", [other, w.raw.staff.id])).toBeNull();
    });
  });

  it("cannot point a request at another workspace's project, and clears the link when a project is removed", async () => {
    const { id: project } = await approvedProject(w, "Link project");
    await withSystem(async (db) => {
      expect(await refused(db, ticketSql, [w.org.id, w.people.owner.id, "Forged link", "project", "support", otherProject])).toMatch(/support_tickets_project_org_fkey/);
      expect(await refused(db, ticketSql, [w.org.id, w.people.owner.id, "Own link", "project", "support", project])).toBeNull();
    });
    // A project that is removed leaves the request in place with the link cleared, as before.
    await expect(withSystem(async (db) => {
      const bare = (await db.query<{ id: string }>("insert into client_project_requests (org_id, created_by, title) values ($1, $2, 'A project nobody agreed') returning id", [w.org.id, w.people.owner.id])).rows[0].id;
      const linked = await ticket(db, "Linked and removed", { category: "project", project: bare });
      await db.query("delete from client_project_requests where id = $1", [bare]);
      const row = (await db.query<{ project_id: string | null }>("select project_id from support_tickets where id = $1", [linked])).rows[0];
      expect(row).toEqual({ project_id: null });
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("lets a purge delete a project whose quote was decided, which 0015 alone never allowed", async () => {
    const { id: project, quoteId } = await approvedProject(w, "Purge project");
    await withSystem(async (db) => {
      // Outside a purge a recorded decision is still untouchable, by update or by delete.
      expect(await refused(db, "delete from quote_approvals where quote_id = $1", [quoteId])).toMatch(/append-only/);
      expect(await refused(db, "update quote_approvals set note = 'rewritten' where quote_id = $1", [quoteId])).toMatch(/append-only/);
      expect(await refused(db, "delete from client_project_requests where id = $1", [project])).toMatch(/append-only/);
      // A purge removes it with the rest of the workspace's data; it still cannot edit one.
      await db.query("select set_config('iaq.purge', 'on', false)");
      try {
        expect(await refused(db, "update quote_approvals set note = 'rewritten' where quote_id = $1", [quoteId])).toMatch(/append-only/);
      } finally {
        await db.query("select set_config('iaq.purge', '', false)");
      }
    });
    await expect(withSystem(async (db) => {
      await db.query("select set_config('iaq.purge', 'on', true)");
      await db.query("delete from client_projects where request_id = $1", [project]);
      await db.query("delete from client_project_requests where id = $1", [project]);
      expect((await db.query("select 1 from quote_approvals where quote_id = $1", [quoteId])).rows).toHaveLength(0);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});

describe("a project change order", () => {
  it("starts submitted, unquoted and unclassified, keeps what was asked, and is never priced before a quote is sent", async () => {
    const { id: project } = await approvedProject(w, "Order shape project");
    await withSystem(async (db) => {
      const id = await newOrder(db, project);
      const row = await orderRow(db, id);
      expect(row).toMatchObject({ status: "submitted", classification: "undetermined", quote_version: 0, additional_cents: null, currency: null, content_hash: null });
      expect(row.ref).toMatch(/^CHG-\d+$/);
      expect(await refused(db, "insert into project_change_orders (org_id, request_id, title, description, status) values ($1, $2, 'Straight to quoted', 'x', 'under_review')", [w.org.id, project])).toMatch(/starts as submitted/);
      expect(await refused(db, "insert into project_change_orders (org_id, request_id, title, description, classification) values ($1, $2, 'Pre classified', 'x', 'out_of_scope')", [w.org.id, project])).toMatch(/starts as submitted/);
      // Another workspace's project cannot be named, and a ticket of another workspace cannot be linked.
      expect(await refused(db, orderSql, [w.org.id, otherProject, "Forged project", w.people.owner.id])).toMatch(/project_change_orders_request_id_org_id_fkey|violates foreign key/);
      const foreignTicket = await ticket(db, "Foreign ticket", { org: w.otherOrg.id, by: w.people.outsider.id });
      expect(await refused(db, "insert into project_change_orders (org_id, request_id, ticket_id, title, description) values ($1, $2, $3, 'Forged ticket', 'x')", [w.org.id, project, foreignTicket])).toMatch(/violates foreign key/);
      // What was asked does not change, and neither does the project it belongs to.
      expect(await refused(db, "update project_change_orders set title = 'Renamed' where id = $1", [id])).toMatch(/never changes/);
      expect(await refused(db, "update project_change_orders set description = 'Rewritten' where id = $1", [id])).toMatch(/never changes/);
      expect(await refused(db, "update project_change_orders set request_id = $2 where id = $1", [id, otherProject])).not.toBeNull();
      // A price, weeks, terms or a hash without a sent quote are refused, and a sent quote has all of them.
      expect(await refused(db, "update project_change_orders set additional_cents = 1000, currency = 'USD' where id = $1", [id])).toMatch(/priced_only_when_quoted/);
      expect(await refused(db, "update project_change_orders set terms_text = 'Free for a week' where id = $1", [id])).toMatch(/priced_only_when_quoted/);
      expect(await refused(db, "update project_change_orders set content_hash = $2 where id = $1", [id, HASH])).toMatch(/priced_only_when_quoted/);
      await review(db, id);
      expect(await refused(db, "update project_change_orders set status = 'quoted', quote_version = 1, quoted_at = now() where id = $1", [id])).toMatch(/priced_only_when_quoted/);
      expect(await refused(db, QUOTE_SQL, [id, w.raw.staff.id, 25000, "not a hash"])).toMatch(/content_hash_check/);
      expect(await refused(db, QUOTE_SQL, [id, w.raw.staff.id, -5, HASH])).toMatch(/additional_cents_check/);
      expect(await refused(db, "update project_change_orders set status = 'quoted', quote_version = 1, quoted_at = now(), additional_cents = 1, currency = 'usd', content_hash = $2 where id = $1", [id, HASH])).toMatch(/currency_check/);
      expect(await refused(db, "update project_change_orders set status = 'quoted', quote_version = 1, quoted_at = now(), additional_cents = 1, currency = 'USD', additional_weeks_min = 3, additional_weeks_max = 2, content_hash = $2 where id = $1", [id, HASH])).toMatch(/check/);
      expect(await refused(db, QUOTE_SQL, [id, w.raw.staff.id, 25000, HASH])).toBeNull();
    });
  });

  it("never prices an in-scope revision, and never quotes, accepts or applies a change nobody classified", async () => {
    const { id: project } = await approvedProject(w, "Order classification project");
    await withSystem(async (db) => {
      const revision = await newOrder(db, project, "A revision");
      await review(db, revision, "in_scope_revision");
      expect(await refused(db, QUOTE_SQL, [revision, w.raw.staff.id, 100, HASH])).not.toBeNull();
      const raw = await newOrder(db, project, "Unclassified");
      await db.query("update project_change_orders set status = 'under_review' where id = $1", [raw]);
      expect(await refused(db, "update project_change_orders set status = 'applied', applied_at = now() where id = $1", [raw])).toMatch(/classified_states/);
      expect(await refused(db, QUOTE_SQL, [raw, w.raw.staff.id, 100, HASH])).not.toBeNull();
      expect(await refused(db, "update project_change_orders set status = 'applied' where id = $1", [revision])).toMatch(/applied_shape/);
      expect(await refused(db, "update project_change_orders set applied_at = now() where id = $1", [revision])).toMatch(/applied_shape/);
      expect(await refused(db, "update project_change_orders set status = 'applied', applied_at = now(), applied_by = $2 where id = $1", [revision, w.raw.staff.id])).toBeNull();
    });
  });

  it("moves only along the allowed transitions, from every state to every other", async () => {
    const { id: project } = await approvedProject(w, "Order transitions project");
    const LEGAL: Record<string, string[]> = {
      submitted: ["under_review", "declined", "withdrawn"],
      under_review: ["needs_info", "quoted", "applied", "declined", "withdrawn"],
      needs_info: ["under_review", "declined", "withdrawn"],
      quoted: ["under_review", "accepted", "declined", "withdrawn"],
      accepted: ["applied"],
      declined: [],
      withdrawn: [],
      applied: [],
    };
    await withSystem(async (db) => {
      const reach = async (state: string) => {
        const id = await newOrder(db, project, `Walk ${state}`);
        if (state === "submitted") return id;
        if (state === "declined" || state === "withdrawn") {
          await db.query("update project_change_orders set status = $2 where id = $1", [id, state]);
          return id;
        }
        await review(db, id);
        if (state === "needs_info") await db.query("update project_change_orders set status = 'needs_info' where id = $1", [id]);
        if (state === "applied") await db.query("update project_change_orders set status = 'applied', applied_at = now() where id = $1", [id]);
        if (state === "quoted" || state === "accepted") await quote(db, id);
        if (state === "accepted") {
          await decide(db, id, "accepted");
          await db.query("update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [id]);
        }
        return id;
      };
      for (const [from, legal] of Object.entries(LEGAL)) {
        const id = await reach(from);
        expect((await orderRow(db, id)).status, `reached ${from}`).toBe(from);
        for (const to of Object.keys(LEGAL).filter((s) => s !== from)) {
          await db.query("savepoint walk");
          let message: string | null = null;
          try {
            // The rows a legal move to this state needs travel with it: a quote's terms, the client's recorded answer, the date it was applied.
            if (from === "quoted" && to === "accepted") await decide(db, id, "accepted");
            if (from === "quoted" && to === "declined") await decide(db, id, "declined");
            if (to === "quoted") await db.query(QUOTE_SQL, [id, w.raw.staff.id, 31000, OTHER_HASH]);
            else if (to === "accepted") await db.query("update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [id]);
            else if (to === "applied") await db.query("update project_change_orders set status = 'applied', applied_at = now() where id = $1", [id]);
            else await db.query("update project_change_orders set status = $2 where id = $1", [id, to]);
          } catch (e) {
            message = String((e as Error).message);
          }
          await db.query("rollback to savepoint walk");
          expect(message === null, `${from} -> ${to}${message ? ` was refused: ${message}` : " was accepted"}`).toBe(legal.includes(to));
        }
        // The project has one live quote at a time: this one is done with, so the next state can have its own.
        if (from === "quoted") await db.query("update project_change_orders set status = 'withdrawn' where id = $1", [id]);
      }
    });
  });

  it("freezes a sent quote: its terms change only by sending a new version, one at a time, from review", async () => {
    const { id: project } = await approvedProject(w, "Quote freeze project");
    await withSystem(async (db) => {
      const id = await newOrder(db, project);
      await review(db, id);
      await quote(db, id, 25000, HASH);
      expect(await refused(db, "update project_change_orders set additional_cents = 1 where id = $1", [id])).toMatch(/cannot be edited/);
      expect(await refused(db, "update project_change_orders set terms_text = 'Cheaper' where id = $1", [id])).toMatch(/cannot be edited/);
      expect(await refused(db, "update project_change_orders set valid_until = '2031-01-01' where id = $1", [id])).toMatch(/cannot be edited/);
      expect(await refused(db, "update project_change_orders set content_hash = $2 where id = $1", [id, OTHER_HASH])).toMatch(/cannot be edited/);
      expect(await refused(db, "update project_change_orders set classification = 'in_scope_revision' where id = $1", [id])).not.toBeNull();
      expect(await refused(db, "update project_change_orders set quote_version = 2 where id = $1", [id])).toMatch(/only when a new quote is sent/);
      // The team pulls the quote back to revise it, and sends version 2 with its new terms in one statement.
      await db.query("update project_change_orders set status = 'under_review' where id = $1", [id]);
      expect(await refused(db, "update project_change_orders set additional_cents = 1 where id = $1", [id])).toMatch(/cannot be edited/);
      expect(await refused(db, QUOTE_SQL.replace("quote_version + 1", "quote_version + 2"), [id, w.raw.staff.id, 26000, OTHER_HASH])).toMatch(/only when a new quote is sent/);
      await db.query(QUOTE_SQL, [id, w.raw.staff.id, 26000, OTHER_HASH]);
      expect(await orderRow(db, id)).toMatchObject({ quote_version: 2, additional_cents: 26000, content_hash: OTHER_HASH, status: "quoted" });
    });
  });

  it("is accepted or declined only against the client's recorded answer to this very quote", async () => {
    const { id: project } = await approvedProject(w, "Order decision project");
    await withSystem(async (db) => {
      const id = await newOrder(db, project);
      await review(db, id);
      // Nothing is waiting yet, so no answer can be recorded against it.
      expect(await refused(db, "insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, 1, 'accepted', $3, $4, 'ok')", [id, w.org.id, w.people.owner.id, HASH])).toMatch(/only against the quote that is waiting/);
      await quote(db, id, 25000, HASH);
      expect(await refused(db, "update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [id])).toMatch(/recorded acceptance/);
      expect(await refused(db, "update project_change_orders set status = 'declined' where id = $1", [id])).toMatch(/recorded answer/);
      // An answer to another version, to another hash, or in another workspace's name is refused.
      expect(await refused(db, "insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, 2, 'accepted', $3, $4, 'ok')", [id, w.org.id, w.people.owner.id, HASH])).toMatch(/only against the quote that is waiting/);
      expect(await refused(db, "insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, 1, 'accepted', $3, $4, 'ok')", [id, w.org.id, w.people.owner.id, OTHER_HASH])).toMatch(/only against the quote that is waiting/);
      expect(await refused(db, "insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, 1, 'accepted', $3, $4, 'ok')", [id, w.otherOrg.id, w.people.outsider.id, HASH])).not.toBeNull();
      expect(await refused(db, "insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, 1, 'maybe', $3, $4, 'ok')", [id, w.org.id, w.people.owner.id, HASH])).toMatch(/decision_check/);
      await decide(db, id, "accepted");
      // One answer per version, ever.
      expect(await refused(db, "insert into project_change_order_decisions (change_order_id, org_id, quote_version, decision, decided_by, content_hash, acknowledgement) values ($1, $2, 1, 'declined', $3, $4, 'ok')", [id, w.org.id, w.people.owner.id, HASH])).toMatch(/duplicate key/);
      expect(await refused(db, "update project_change_orders set status = 'declined' where id = $1", [id])).toMatch(/recorded answer/);
      await db.query("update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [id]);
      expect(await refused(db, "update project_change_orders set status = 'accepted', decided_at = null where id = $1", [id])).toMatch(/accepted_decided/);
      // The answer cannot be edited or removed.
      expect(await refused(db, "update project_change_order_decisions set decision = 'declined' where change_order_id = $1", [id])).toMatch(/append-only/);
      expect(await refused(db, "update project_change_order_decisions set note = 'second thoughts' where change_order_id = $1", [id])).toMatch(/append-only/);
      expect(await refused(db, "delete from project_change_order_decisions where change_order_id = $1", [id])).toMatch(/append-only/);
    });
  });

  it("has one live quote per project, and a pulled-back quote frees the slot", async () => {
    const { id: project } = await approvedProject(w, "Live quote project");
    await withSystem(async (db) => {
      const first = await newOrder(db, project, "First change");
      const second = await newOrder(db, project, "Second change");
      await review(db, first);
      await review(db, second);
      await quote(db, first, 10000, HASH);
      expect(await refused(db, QUOTE_SQL, [second, w.raw.staff.id, 20000, OTHER_HASH])).toMatch(/one_live_quote|duplicate key/);
      await db.query("update project_change_orders set status = 'withdrawn' where id = $1", [first]);
      expect(await refused(db, QUOTE_SQL, [second, w.raw.staff.id, 20000, OTHER_HASH])).toBeNull();
    });
  });

  it("is retried safely: one request per key and person, one change per ticket", async () => {
    const { id: project } = await approvedProject(w, "Idempotent order project");
    await withSystem(async (db) => {
      const insert = "insert into project_change_orders (org_id, request_id, ticket_id, title, description, requested_by, idempotency_key) values ($1, $2, $3, $4, 'x', $5, $6)";
      const t = await changeTicket(db, "Change with an order", project);
      await db.query(insert, [w.org.id, project, null, "Keyed order", w.people.owner.id, "retry-key-0001"]);
      expect(await refused(db, insert, [w.org.id, project, null, "Keyed again", w.people.owner.id, "retry-key-0001"])).toMatch(/idempotency_idx|duplicate key/);
      expect(await refused(db, insert, [w.org.id, project, null, "Keyed by a colleague", w.people.admin.id, "retry-key-0001"])).toBeNull();
      expect(await refused(db, insert, [w.org.id, project, null, "Short key", w.people.owner.id, "short"])).toMatch(/idempotency_key_check/);
      await db.query(insert, [w.org.id, project, t, "From the ticket", w.people.owner.id, null]);
      expect(await refused(db, insert, [w.org.id, project, t, "Second from the ticket", w.people.owner.id, null])).toMatch(/ticket_idx|duplicate key/);
    });
  });

  it("is never deleted, except by the purge of a departed client's data", async () => {
    const { id: project } = await approvedProject(w, "Never deleted project");
    await withSystem(async (db) => {
      const id = await newOrder(db, project);
      await db.query("update project_change_orders set status = 'withdrawn' where id = $1", [id]);
      expect(await refused(db, "delete from project_change_orders where id = $1", [id])).toMatch(/never deleted/);
      expect(await refused(db, "delete from client_project_requests where id = $1", [project])).not.toBeNull();
    });
    await expect(withSystem(async (db) => {
      const id = await newOrder(db, project, "Purged");
      await db.query("select set_config('iaq.purge', 'on', true)");
      await db.query("delete from project_change_orders where id = $1", [id]);
      expect((await db.query("select 1 from project_change_orders where id = $1", [id])).rows).toHaveLength(0);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("keeps a message or a file attached to a change order of the same project only", async () => {
    const a = await approvedProject(w, "Attach project A");
    const b = await approvedProject(w, "Attach project B");
    await withSystem(async (db) => {
      const onA = await newOrder(db, a.id);
      const insert = "insert into project_messages (request_id, org_id, author_id, author_kind, body, client_message_id, change_order_id) values ($1, $2, $3, 'client', 'About the change', $4, $5)";
      expect(await refused(db, insert, [a.id, w.org.id, w.people.owner.id, crypto.randomUUID(), onA])).toBeNull();
      expect(await refused(db, insert, [b.id, w.org.id, w.people.owner.id, crypto.randomUUID(), onA])).toMatch(/violates foreign key/);
      // A retried message with the same id is one message.
      const retried = crypto.randomUUID();
      await db.query(insert, [a.id, w.org.id, w.people.owner.id, retried, null]);
      expect(await refused(db, insert, [a.id, w.org.id, w.people.owner.id, retried, null])).toMatch(/client_id_idx|duplicate key/);
      const file = (await db.query<{ id: string }>("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'project-uploads', $2, 'brief.pdf', 'application/pdf', 100, 'ready') returning id", [w.org.id, `${w.org.id}/${crypto.randomUUID()}.pdf`])).rows[0].id;
      expect(await refused(db, "insert into project_files (request_id, org_id, private_file_id, uploaded_by_kind, change_order_id) values ($1, $2, $3, 'client', $4)", [b.id, w.org.id, file, onA])).toMatch(/violates foreign key/);
      expect(await refused(db, "insert into project_files (request_id, org_id, private_file_id, uploaded_by_kind, change_order_id) values ($1, $2, $3, 'client', $4)", [a.id, w.org.id, file, onA])).toBeNull();
    });
  });
});

describe("the scope a change added", () => {
  const acceptedOrder = async (db: Db, project: string, cents = 25000) => {
    const id = await newOrder(db, project, `Amend ${cents}`);
    await review(db, id);
    await quote(db, id, cents, HASH);
    await decide(db, id, "accepted");
    await db.query("update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [id]);
    return id;
  };
  const amend = "insert into project_scope_amendments (org_id, request_id, change_order_id, added_scope, added_cents, currency, agreed_by) values ($1, $2, $3, 'A second calendar', $4, $5, $6)";

  it("records exactly the accepted price and currency, once, and only for an accepted out-of-scope change", async () => {
    const { id: project } = await approvedProject(w, "Amendment project");
    await withSystem(async (db) => {
      const quoted = await newOrder(db, project, "Still quoted");
      await review(db, quoted);
      await quote(db, quoted, 7000, HASH);
      expect(await refused(db, amend, [w.org.id, project, quoted, 7000, "USD", w.people.owner.id])).toMatch(/exactly the price and currency of an accepted change/);
      await db.query("update project_change_orders set status = 'withdrawn' where id = $1", [quoted]);
      const id = await acceptedOrder(db, project, 25000);
      expect(await refused(db, amend, [w.org.id, project, id, 24999, "USD", w.people.owner.id])).toMatch(/exactly the price and currency/);
      expect(await refused(db, amend, [w.org.id, project, id, 25000, "PHP", w.people.owner.id])).toMatch(/exactly the price and currency|violates foreign key/);
      expect(await refused(db, amend, [w.org.id, otherProject, id, 25000, "USD", w.people.owner.id])).not.toBeNull();
      expect(await refused(db, amend, [w.org.id, project, id, 25000, "USD", w.people.owner.id])).toBeNull();
      await db.query(amend, [w.org.id, project, id, 25000, "USD", w.people.owner.id]);
      expect(await refused(db, amend, [w.org.id, project, id, 25000, "USD", w.people.owner.id])).toMatch(/duplicate key/);
      expect((await db.query("select 1 from project_scope_amendments where request_id = $1", [project])).rows).toHaveLength(1);
      // A revision that was applied adds no scope and no price.
      const revision = await newOrder(db, project, "Applied revision");
      await review(db, revision, "in_scope_revision");
      await db.query("update project_change_orders set status = 'applied', applied_at = now() where id = $1", [revision]);
      expect(await refused(db, amend, [w.org.id, project, revision, 0, "USD", w.people.owner.id])).toMatch(/exactly the price and currency/);
    });
  });

  it("is a ledger: it cannot be edited or removed, and the agreed scope is never overwritten", async () => {
    const { id: project } = await approvedProject(w, "Ledger project");
    await withSystem(async (db) => {
      const before = (await db.query<{ scope: string; agreed_price_cents: number }>("select scope, agreed_price_cents from client_projects where request_id = $1", [project])).rows[0];
      const id = await acceptedOrder(db, project, 5000);
      await db.query(amend, [w.org.id, project, id, 5000, "USD", w.people.owner.id]);
      expect(await refused(db, "update project_scope_amendments set added_cents = 1 where change_order_id = $1", [id])).toMatch(/append-only/);
      expect(await refused(db, "delete from project_scope_amendments where change_order_id = $1", [id])).toMatch(/append-only/);
      expect((await db.query("select scope, agreed_price_cents from client_projects where request_id = $1", [project])).rows[0]).toEqual(before);
    });
  });

  it("cannot be in another currency than the agreed project's, and needs an agreed project", async () => {
    const { id: project } = await approvedProject(w, "Currency project");
    await withSystem(async (db) => {
      expect(await refused(db, "update client_projects set currency = 'PHP' where request_id = $1", [project])).toBeNull();
      const id = await acceptedOrder(db, project, 100);
      // The change order is in USD like the project; an amendment in any other currency has no project row to point at.
      expect(await refused(db, amend, [w.org.id, project, id, 100, "EUR", w.people.owner.id])).not.toBeNull();
      expect(await refused(db, "update client_projects set currency = 'PHP' where request_id = $1", [project])).toBeNull();
      await db.query(amend, [w.org.id, project, id, 100, "USD", w.people.owner.id]);
      // Once an amendment exists the project's currency is pinned by the key that names it.
      expect(await refused(db, "update client_projects set currency = 'PHP' where request_id = $1", [project])).toMatch(/violates foreign key/);
      expect(await refused(db, "insert into client_projects (request_id, org_id, agreed_price_cents, currency) values ($1, $2, 1, 'USD')", [project, w.org.id])).toMatch(/duplicate key/);
    });
  });
});

describe("project prerequisites", () => {
  const insert = "insert into project_prerequisites (request_id, org_id, kind, label, status, evidence_note, satisfied_at, waived_reason, waived_at, created_by) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";

  it("are a person's record: confirmed with evidence, waived with a reason, and neither on a pending one", async () => {
    const { id: project } = await approvedProject(w, "Prerequisite project");
    await withSystem(async (db) => {
      const by = w.raw.staff.id;
      expect(await refused(db, insert, [project, w.org.id, "access", "Share the calendar login", "pending", null, null, null, null, by])).toBeNull();
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the logo", "satisfied", null, new Date(), null, null, by])).toMatch(/satisfied_check/);
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the logo", "satisfied", "ok", new Date(), null, null, by])).toMatch(/satisfied_check/);
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the logo", "satisfied", "Seen in the shared drive", null, null, null, by])).toMatch(/satisfied_check/);
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the logo", "satisfied", "Seen in the shared drive", new Date(), null, null, by])).toBeNull();
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the photos", "waived", null, null, "no", new Date(), by])).toMatch(/waived_check/);
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the photos", "waived", null, null, "Client has none yet", null, by])).toMatch(/waived_check/);
      expect(await refused(db, insert, [project, w.org.id, "content", "Send the photos", "waived", null, null, "Client has none yet", new Date(), by])).toBeNull();
      expect(await refused(db, insert, [project, w.org.id, "content", "Pending with a date", "pending", null, new Date(), null, null, by])).toMatch(/pending_check/);
      expect(await refused(db, insert, [project, w.org.id, "payroll", "Unknown kind", "pending", null, null, null, null, by])).toMatch(/kind_check/);
      expect(await refused(db, insert, [project, w.otherOrg.id, "access", "Wrong workspace", "pending", null, null, null, null, by])).not.toBeNull();
      expect(await refused(db, "insert into project_prerequisites (request_id, org_id, kind, label, blocks) values ($1, $2, 'access', 'Blocks nothing known', 'lunch')", [project, w.org.id])).toMatch(/blocks_check/);
      expect(await refused(db, "insert into project_prerequisites (request_id, org_id, kind, label, source_kind) values ($1, $2, 'other', 'A source without an id', 'invoice')", [project, w.org.id])).toMatch(/check/);
    });
  });

  it("ask for the agreement and the deposit once per project, and keep a confirmed one as the record of it", async () => {
    const { id: project } = await approvedProject(w, "Prerequisite once project");
    await withSystem(async (db) => {
      const seed = "insert into project_prerequisites (request_id, org_id, kind, label) values ($1, $2, $3, $4)";
      await db.query(seed, [project, w.org.id, "agreement", "Written agreement confirmed"]);
      await db.query(seed, [project, w.org.id, "deposit", "Payment verified per the quote's terms"]);
      expect(await refused(db, seed, [project, w.org.id, "agreement", "Written agreement confirmed again"])).toMatch(/once_idx|duplicate key/);
      expect(await refused(db, seed, [project, w.org.id, "access", "Share the calendar"])).toBeNull();
      await db.query(seed, [project, w.org.id, "access", "Share the calendar"]);
      expect(await refused(db, seed, [project, w.org.id, "access", "Share the second calendar"])).toBeNull();
      // A pending one may be taken back; a confirmed or waived one is the record of what a person checked.
      expect(await refused(db, "delete from project_prerequisites where request_id = $1 and kind = 'access' and label = 'Share the calendar'", [project])).toBeNull();
      await db.query("update project_prerequisites set status = 'satisfied', satisfied_at = now(), evidence_note = 'Bank statement of 3 November', satisfied_by = $2 where request_id = $1 and kind = 'agreement'", [project, w.raw.staff.id]);
      expect(await refused(db, "delete from project_prerequisites where request_id = $1 and kind = 'agreement'", [project])).toMatch(/kept as the record/);
    });
  });

  it("can name a change order of the same project only", async () => {
    const a = await approvedProject(w, "Prerequisite change A");
    const b = await approvedProject(w, "Prerequisite change B");
    await withSystem(async (db) => {
      const order = await newOrder(db, a.id);
      const sql = "insert into project_prerequisites (request_id, org_id, kind, label, change_order_id) values ($1, $2, 'change', 'Confirm the extra work', $3)";
      expect(await refused(db, sql, [b.id, w.org.id, order])).toMatch(/violates foreign key/);
      expect(await refused(db, sql, [a.id, w.org.id, order])).toBeNull();
    });
  });
});

describe("warranty, revisions and the retry keys on a project request", () => {
  it("hold a warranty window only with its length, and never count more revisions than were included", async () => {
    const { id: project } = await approvedProject(w, "Warranty project");
    await withSystem(async (db) => {
      const set = (sql: string) => refused(db, `update client_projects set ${sql} where request_id = $1`, [project]);
      expect(await set("warranty_ends_on = current_date + 30")).toMatch(/warranty_check/);
      expect(await set("warranty_days = -1")).toMatch(/warranty_days_check/);
      expect(await set("warranty_days = 4000")).toMatch(/warranty_days_check/);
      expect(await set("warranty_days = 30, warranty_ends_on = current_date + 30")).toBeNull();
      expect(await set("revisions_used = 1")).toBeNull();
      expect(await set("revisions_included = 2, revisions_used = 3")).toMatch(/revisions_check/);
      expect(await set("revisions_included = 2, revisions_used = 2")).toBeNull();
      expect(await set("revisions_used = -1")).toMatch(/revisions_used_check/);
      expect(await set("revisions_included = 101")).toMatch(/revisions_included_check/);
      await db.query("update client_projects set revisions_included = 2, revisions_used = 2 where request_id = $1", [project]);
      expect(await set("revisions_included = 1")).toMatch(/revisions_check/);
      const fresh = (await db.query<Record<string, unknown>>("select warranty_days, revisions_included, revisions_used from client_projects where request_id = $1", [otherProject])).rows[0];
      expect(fresh).toEqual({ warranty_days: null, revisions_included: null, revisions_used: 0 });
    });
  });

  it("make a double submit one request: a retry key is unique per workspace and person", async () => {
    await withSystem(async (db) => {
      const sql = "insert into client_project_requests (org_id, created_by, title, idempotency_key) values ($1, $2, $3, $4)";
      await db.query(sql, [w.org.id, w.people.owner.id, "First submit", "submit-key-0001"]);
      expect(await refused(db, sql, [w.org.id, w.people.owner.id, "Second submit", "submit-key-0001"])).toMatch(/idempotency_idx|duplicate key/);
      expect(await refused(db, sql, [w.org.id, w.people.admin.id, "A colleague", "submit-key-0001"])).toBeNull();
      expect(await refused(db, sql, [w.otherOrg.id, w.people.outsider.id, "Another workspace", "submit-key-0001"])).toBeNull();
      expect(await refused(db, sql, [w.org.id, w.people.owner.id, "Too short a key", "short"])).toMatch(/idempotency_key_check/);
      expect(await refused(db, sql, [w.org.id, w.people.owner.id, "No key twice", null])).toBeNull();
      await db.query(sql, [w.org.id, w.people.owner.id, "No key", null]);
      expect(await refused(db, sql, [w.org.id, w.people.owner.id, "No key again", null])).toBeNull();
    });
  });
});

describe("mentions", () => {
  it("exist only on internal notes, and only for a team member who works on that client", async () => {
    await withSystem(async (db) => {
      const t = await ticket(db, "Mention me");
      const note = (await db.query<{ id: string }>("insert into support_messages (ticket_id, org_id, author_id, author_kind, body, internal) values ($1, $2, $3, 'agency', 'Internal note', true) returning id", [t, w.org.id, w.raw.staff.id])).rows[0].id;
      const reply = (await db.query<{ id: string }>("insert into support_messages (ticket_id, org_id, author_id, author_kind, body, internal) values ($1, $2, $3, 'agency', 'Public reply', false) returning id", [t, w.org.id, w.raw.staff.id])).rows[0].id;
      const mention = "insert into support_message_mentions (message_id, ticket_id, org_id, mentioned_user_id, created_by) values ($1, $2, $3, $4, $5)";
      // A public reply can never carry a mention; neither can a note of another request.
      expect(await refused(db, mention, [reply, t, w.org.id, w.raw.staff2.id, w.raw.staff.id])).toMatch(/violates foreign key/);
      const otherTicket = await ticket(db, "Another request");
      expect(await refused(db, mention, [note, otherTicket, w.org.id, w.raw.staff2.id, w.raw.staff.id])).toMatch(/violates foreign key/);
      // A client, a team member outside this client's scope and an unknown user cannot be mentioned.
      expect(await refused(db, mention, [note, t, w.org.id, w.people.owner.id, w.raw.staff.id])).toMatch(/works on this client/);
      expect(await refused(db, mention, [note, t, w.org.id, w.raw.outStaff.id, w.raw.staff.id])).toMatch(/works on this client/);
      expect(await refused(db, mention, [note, t, w.org.id, crypto.randomUUID(), w.raw.staff.id])).not.toBeNull();
      await db.query(mention, [note, t, w.org.id, w.raw.staff2.id, w.raw.staff.id]);
      await db.query(mention, [note, t, w.org.id, w.raw.superAdmin.id, w.raw.staff.id]);
      expect(await refused(db, mention, [note, t, w.org.id, w.raw.staff2.id, w.raw.staff.id])).toMatch(/duplicate key/);
      // While a mention names the note, the note cannot be turned into a public message.
      expect(await refused(db, "update support_messages set internal = false where id = $1", [note])).toMatch(/violates foreign key/);
      // Removing the request or the note removes the mention with it.
      await db.query("delete from support_messages where id = $1", [note]);
      expect((await db.query("select 1 from support_message_mentions where message_id = $1", [note])).rows).toHaveLength(0);
    });
  });
});

describe("the triage record", () => {
  it("keeps a person's answer and its outcome together, and a bounded shape for what was suggested", async () => {
    await withSystem(async (db) => {
      const make = async (subject: string) => ticket(db, subject);
      const t = await make("Triage shape");
      await db.query("insert into support_ticket_ai_triage (ticket_id, org_id) values ($1, $2)", [t, w.org.id]);
      expect((await db.query("select status, source, attempts from support_ticket_ai_triage where ticket_id = $1", [t])).rows[0]).toEqual({ status: "pending", source: "rules", attempts: 0 });
      const set = (sql: string, params: unknown[] = []) => refused(db, `update support_ticket_ai_triage set ${sql} where ticket_id = $1`, [t, ...params]);
      expect(await set("status = 'applied'")).toMatch(/check/);
      expect(await set("status = 'applied', review_outcome = 'dismissed', reviewed_at = now()")).toMatch(/check/);
      expect(await set("status = 'dismissed', review_outcome = 'accepted', reviewed_at = now()")).toMatch(/check/);
      expect(await set("review_outcome = 'accepted'")).toMatch(/check/);
      expect(await set("status = 'applied', review_outcome = 'edited', reviewed_at = now(), reviewed_by = $2", [w.raw.staff.id])).toBeNull();
      expect(await set("status = 'dismissed', review_outcome = 'dismissed', reviewed_at = now()")).toBeNull();
      expect(await set("status = 'working'")).toMatch(/status_check/);
      expect(await set("source = 'robot'")).toMatch(/source_check/);
      expect(await set("suggested_priority = 'critical'")).toMatch(/priority_check/);
      expect(await set("suggested_request_type = 'complaint'")).toMatch(/request_type_check/);
      expect(await set("intent = 'Not A Code'")).toMatch(/intent_check/);
      expect(await set("routing = '[]'::jsonb")).toMatch(/routing_check/);
      expect(await set("duplicate_candidates = '{}'::jsonb")).toMatch(/duplicate_candidates_check/);
      expect(await set("clarifying_questions = '[\"a\", \"b\", \"c\", \"d\", \"e\"]'::jsonb")).toMatch(/clarifying_questions_check/);
      expect(await set("clarifying_questions = '[\"a\", \"b\", \"c\", \"d\"]'::jsonb")).toBeNull();
      expect(await set("next_actions = to_jsonb(array_fill('x'::text, array[9]))")).toMatch(/next_actions_check/);
      expect(await set("context_summary = repeat('x', 4001)")).toMatch(/context_summary_check/);
      expect(await set("ai_error = repeat('x', 301)")).toMatch(/ai_error_check/);
      // One record per request, in the request's own workspace.
      expect(await refused(db, "insert into support_ticket_ai_triage (ticket_id, org_id) values ($1, $2)", [t, w.org.id])).toMatch(/duplicate key/);
      expect(await refused(db, "insert into support_ticket_ai_triage (ticket_id, org_id) values ($1, $2)", [await make("Wrong workspace"), w.otherOrg.id])).toMatch(/violates foreign key/);
    });
  });
});

describe("satisfaction surveys", () => {
  const insert = "insert into support_surveys (org_id, kind, ticket_id, project_request_id, requested_for_user_id) values ($1, $2, $3, $4, $5) returning id";

  it("are one per request and per project, and name a target that matches their kind", async () => {
    const { id: project } = await approvedProject(w, "Survey project");
    await withSystem(async (db) => {
      const t = await ticket(db, "Survey me");
      const person = w.people.owner.id;
      expect(await refused(db, insert, [w.org.id, "ticket_resolution", null, null, person])).toMatch(/check/);
      expect(await refused(db, insert, [w.org.id, "ticket_resolution", t, project, person])).toMatch(/check/);
      expect(await refused(db, insert, [w.org.id, "project_completion", t, null, person])).toMatch(/check/);
      expect(await refused(db, insert, [w.org.id, "ticket_resolution", null, project, person])).toMatch(/check/);
      expect(await refused(db, insert, [w.org.id, "weekly_pulse", t, null, person])).toMatch(/check/);
      expect(await refused(db, insert, [w.org.id, "ticket_resolution", t, null, crypto.randomUUID()])).toMatch(/violates foreign key/);
      expect(await refused(db, insert, [w.otherOrg.id, "ticket_resolution", t, null, person])).toMatch(/violates foreign key/);
      expect(await refused(db, insert, [w.org.id, "project_completion", null, otherProject, person])).toMatch(/violates foreign key/);
      await db.query(insert, [w.org.id, "ticket_resolution", t, null, person]);
      expect(await refused(db, insert, [w.org.id, "ticket_resolution", t, null, person])).toMatch(/ticket_idx|duplicate key/);
      await db.query(insert, [w.org.id, "project_completion", null, project, person]);
      expect(await refused(db, insert, [w.org.id, "project_completion", null, project, w.people.admin.id])).toMatch(/project_idx|duplicate key/);
    });
  });

  it("are answered once with a rating, and are a record afterwards", async () => {
    await withSystem(async (db) => {
      const t = await ticket(db, "Answer me");
      const id = (await db.query<{ id: string }>(insert, [w.org.id, "ticket_resolution", t, null, w.people.owner.id])).rows[0].id;
      const set = (sql: string, params: unknown[] = []) => refused(db, `update support_surveys set ${sql} where id = $1`, [id, ...params]);
      // The answer needs a rating and a time, a rating is 1 to 5, a comment is bounded, and an unanswered survey holds no answer.
      expect(await set("status = 'answered', answered_at = now()")).toMatch(/answered_check/);
      expect(await set("status = 'answered', rating = 6, answered_at = now()")).toMatch(/rating_check/);
      expect(await set("status = 'answered', rating = 0, answered_at = now()")).toMatch(/rating_check/);
      expect(await set("status = 'answered', rating = 4, answered_at = now(), comment = repeat('x', 1001)")).toMatch(/comment_check/);
      expect(await set("rating = 4")).toMatch(/answered_check/);
      expect(await set("status = 'sleeping'")).toMatch(/status_check/);
      expect(await set("requested_for_user_id = $2", [w.people.admin.id])).toMatch(/stays with the request and the person/);
      expect(await set("status = 'answered', rating = 4, helpful = true, comment = 'Quick and clear', answered_by = $2, answered_at = now()", [w.people.owner.id])).toBeNull();
      await db.query("update support_surveys set status = 'answered', rating = 4, helpful = true, comment = 'Quick and clear', answered_by = $2, answered_at = now() where id = $1", [id, w.people.owner.id]);
      expect(await set("rating = 1")).toMatch(/does not change/);
      expect(await set("comment = 'Changed my mind'")).toMatch(/does not change/);
      expect(await set("status = 'expired', rating = null, helpful = null, comment = null, answered_at = null")).toMatch(/does not change/);
      expect(await set("status = 'requested', rating = null, helpful = null, comment = null, answered_at = null")).toMatch(/does not change/);
      // A survey that expired or was skipped is also final.
      const t2 = await ticket(db, "Expire me");
      const expired = (await db.query<{ id: string }>(insert, [w.org.id, "ticket_resolution", t2, null, w.people.owner.id])).rows[0].id;
      await db.query("update support_surveys set status = 'expired' where id = $1", [expired]);
      expect(await refused(db, "update support_surveys set status = 'answered', rating = 5, answered_at = now() where id = $1", [expired])).toMatch(/does not change/);
    });
  });
});

describe("the settings switches", () => {
  it("ship off or empty, and a project target shown to clients must exist", async () => {
    await withSystem(async (db) => {
      const row = (await db.query<Record<string, unknown>>("select surveys_enabled, survey_delay_hours, ai_triage_enabled, project_review_target_hours, show_project_targets_to_clients, project_prerequisites_enabled from support_settings")).rows[0];
      expect(row).toEqual({ surveys_enabled: false, survey_delay_hours: 24, ai_triage_enabled: true, project_review_target_hours: null, show_project_targets_to_clients: false, project_prerequisites_enabled: false });
      expect(await refused(db, "update support_settings set show_project_targets_to_clients = true")).toMatch(/project_target_check/);
      expect(await refused(db, "update support_settings set project_review_target_hours = 0")).toMatch(/project_review_target_hours_check/);
      expect(await refused(db, "update support_settings set project_review_target_hours = 721")).toMatch(/project_review_target_hours_check/);
      expect(await refused(db, "update support_settings set survey_delay_hours = -1")).toMatch(/survey_delay_hours_check/);
      expect(await refused(db, "update support_settings set project_review_target_hours = 24, show_project_targets_to_clients = true")).toBeNull();
    });
  });
});

describe("change-review tasks", () => {
  it("name a change of their own project, and only a change-review task names one", async () => {
    const { id: project } = await approvedProject(w, "Task key project");
    const { id: other } = await approvedProject(w, "Task key other project");
    await expect(withSystem(async (db) => {
      const change = await newOrder(db, project, "Task key change");
      const insert = "insert into project_review_tasks (request_id, org_id, kind, title, change_order_id) values ($1, $2, $3, 'Probe', $4)";
      expect(await refused(db, insert, [project, w.org.id, "review_change", change])).toBeNull();
      expect(await refused(db, insert, [project, w.org.id, "review_change", null])).toMatch(/project_review_tasks_change_kind_check/);
      expect(await refused(db, insert, [project, w.org.id, "initial_review", change])).toMatch(/project_review_tasks_change_kind_check/);
      expect(await refused(db, insert, [other, w.org.id, "review_change", change])).toMatch(/project_review_tasks_change_fkey/);
      // The four kinds that were there before still work, and an unknown kind is still refused.
      for (const kind of ["initial_review", "respond_to_client", "prepare_quote", "review_decision"]) expect(await refused(db, insert, [project, w.org.id, kind, null]), kind).toBeNull();
      expect(await refused(db, insert, [project, w.org.id, "gossip", null])).toMatch(/project_review_tasks_kind_check/);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("are removed with the change they were made for, and the project's other tasks stay", async () => {
    const { id: project } = await approvedProject(w, "Task cascade project");
    await expect(withSystem(async (db) => {
      const change = await newOrder(db, project, "Task cascade change");
      await db.query("insert into project_review_tasks (request_id, org_id, kind, title, change_order_id) values ($1, $2, 'review_change', 'Probe', $3)", [project, w.org.id, change]);
      const before = (await db.query<{ n: number }>("select count(*)::int as n from project_review_tasks where request_id = $1", [project])).rows[0].n;
      await db.query("select set_config('iaq.purge', 'on', true)");
      await db.query("delete from project_change_orders where id = $1", [change]);
      const after = (await db.query<{ n: number }>("select count(*)::int as n from project_review_tasks where request_id = $1", [project])).rows[0].n;
      expect(after).toBe(before - 1);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});

describe("the overdue-review index", () => {
  it("is a partial index on open tasks with a time, and the resolved-request index only on resolved ones", async () => {
    await withSystem(async (db) => {
      const idx = (await db.query<{ indexname: string; indexdef: string }>("select indexname, indexdef from pg_indexes where indexname in ('project_review_tasks_due_idx', 'support_tickets_resolved_idx')")).rows;
      expect(idx.find((i) => i.indexname === "project_review_tasks_due_idx")!.indexdef).toMatch(/where.*status = 'open'/i);
      expect(idx.find((i) => i.indexname === "support_tickets_resolved_idx")!.indexdef).toMatch(/where.*status = 'resolved'/i);
    });
  });
});

/** What an operator does before a rollback that is allowed to run: everything the guard looks at is exported and removed. */
const clearAll = async (db: Db) => {
  await db.query("select set_config('iaq.purge', 'on', true)");
  for (const t of ["support_surveys", "support_ticket_ai_triage", "support_message_mentions", "project_prerequisites", "project_scope_amendments", "project_change_order_decisions", "project_change_orders", "support_ticket_change"]) {
    await db.query(`delete from ${t}`);
  }
  await db.query("delete from support_tickets where request_type = 'change' or category = any($1::text[])", [NEW_CATEGORIES]);
  await db.query("delete from support_ticket_events where kind in ('mentioned', 'change_classified', 'survey_answered', 'ai_triage_applied')");
  await db.query("delete from support_notification_log where event_kind in ('staff_mention', 'survey_requested')");
  await db.query("delete from notifications where kind = any($1::text[])", [NEW_KINDS]);
  await db.query("update client_projects set warranty_days = null, warranty_ends_on = null, revisions_included = null, revisions_used = 0");
};

describe("the rollback", () => {
  const originalLists: Record<string, string[]> = {
    support_tickets_request_type_check: ["support", "issue", "feedback"],
    support_tickets_category_check: [
      "general", "account", "crm", "ai_employees", "integrations", "website", "billing", "other", "feature_not_working", "incorrect_information", "performance", "access", "feature_suggestion",
      "improvement", "ux_feedback", "positive_feedback", "general_suggestion", "bug", "onboarding", "project", "maintenance",
    ],
    support_ticket_events_kind_check: [
      "created", "reply", "note", "attachment", "status_changed", "feedback_stage", "assigned", "unassigned", "priority_changed", "escalated", "de_escalated", "reopened", "resolved", "closed", "linked",
      "merged", "sla_alert", "ai_assist",
    ],
    support_notification_rules_event_kind_check: ["request_submitted", "assigned", "agency_reply", "client_reply", "status_changed", "priority_escalated", "response_approaching", "response_overdue", "resolved", "reopened", "closed"],
    support_notification_log_event_kind_check: ["request_submitted", "assigned", "agency_reply", "client_reply", "status_changed", "priority_escalated", "response_approaching", "response_overdue", "resolved", "reopened", "closed"],
    project_review_tasks_kind_check: ["initial_review", "respond_to_client", "prepare_quote", "review_decision"],
  };
  const listOf = async (db: Db, name: string) => {
    const def = (await db.query<{ d: string }>("select pg_get_constraintdef(oid) as d from pg_constraint where conname = $1", [name])).rows[0].d;
    return [...def.matchAll(/'([a-z0-9_]+)'::text/g)].map((m) => m[1]);
  };

  it("removes what 0098 added, puts every list back exactly as it was, and can be applied again", async () => {
    let report: Record<string, unknown> = {};
    await expect(withSystem(async (db) => {
      const before: Record<string, string[]> = {};
      for (const name of Object.keys(originalLists)) before[name] = await listOf(db, name);
      for (const name of Object.keys(originalLists)) expect(before[name].length, name).toBeGreaterThan(originalLists[name].length);
      await clearAll(db);
      await run(db, DOWN);
      const q = async (sql: string, params: unknown[] = []) => (await db.query<Record<string, unknown>>(sql, params)).rows;
      const after: Record<string, string[]> = {};
      for (const name of Object.keys(originalLists)) after[name] = await listOf(db, name);
      const def = (await q("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'notifications_kind_check'"))[0].d as string;
      report = {
        tables: (await q("select relname from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES])).length,
        lists: after,
        kinds: NEW_KINDS.filter((k) => def.includes(`'${k}'`)),
        oldKinds: ["support_reply", "invoice_paid", "proposal_accepted", "social_post_failed"].filter((k) => def.includes(`'${k}'`)),
        columns: (await q("select table_name, column_name from information_schema.columns where table_schema = 'public' and ((table_name = 'client_projects' and column_name in ('warranty_days', 'warranty_ends_on', 'revisions_included', 'revisions_used')) or (table_name = 'client_project_requests' and column_name = 'idempotency_key') or (table_name = 'project_messages' and column_name in ('client_message_id', 'change_order_id')) or (table_name = 'project_files' and column_name = 'change_order_id') or (table_name = 'project_review_tasks' and column_name in ('change_order_id', 'overdue_notified_at')) or (table_name = 'support_settings' and column_name in ('surveys_enabled', 'survey_delay_hours', 'ai_triage_enabled', 'project_review_target_hours', 'show_project_targets_to_clients', 'project_prerequisites_enabled')))")).length,
        functions: (await q("select p.proname from pg_proc p where p.pronamespace = 'app'::regnamespace and p.proname in ('support_ticket_change_guard', 'project_change_order_guard', 'project_change_order_decisions_guard', 'project_scope_amendments_guard', 'project_prerequisites_guard', 'support_message_mention_guard', 'support_surveys_guard')")).length,
        sequence: (await q("select 1 from pg_class where relname = 'project_change_order_ref_seq'")).length,
        projectKey: (await q("select pg_get_constraintdef(oid) as d from pg_constraint where conname = 'support_tickets_project_id_fkey'"))[0]?.d,
        compositeKey: (await q("select 1 from pg_constraint where conname = 'support_tickets_project_org_fkey'")).length,
        mentionKey: (await q("select 1 from pg_constraint where conname = 'support_messages_mention_target_key'")).length,
        rules: (await q("select count(*)::int as n from support_notification_rules"))[0].n,
      };
      // And it applies again on the rolled-back schema: the tables, the lists and the rules come back.
      await run(db, UP);
      expect((await q("select count(*)::int as n from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES]))[0].n).toBe(TABLES.length);
      expect(await listOf(db, "support_tickets_request_type_check")).toContain("change");
      expect((await q("select count(*)::int as n from support_notification_rules"))[0].n).toBe(13);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
    expect(report).toEqual({
      tables: 0,
      lists: originalLists,
      kinds: [],
      oldKinds: ["support_reply", "invoice_paid", "proposal_accepted", "social_post_failed"],
      columns: 0,
      functions: 0,
      sequence: 0,
      projectKey: "FOREIGN KEY (project_id) REFERENCES client_project_requests(id) ON DELETE SET NULL",
      compositeKey: 0,
      mentionKey: 0,
      rules: 11,
    });
    // It was only rolled back in a transaction: everything is still there.
    expect((await withSystem((db) => db.query("select 1 from pg_class where relnamespace = 'public'::regnamespace and relname = any($1::text[])", [TABLES]))).rows).toHaveLength(TABLES.length);
  });

  it("refuses while a Request a Change request, a change order, a prerequisite, a mention, a triage record, a survey, a recorded warranty or a notice of the new kinds exists", async () => {
    const { id: project } = await approvedProject(w, "Rollback project");
    const cases: Array<[string, (db: Db) => Promise<unknown>, RegExp]> = [
      ["a Request a Change request", (db) => changeTicket(db, "Rollback probe"), /Request a Change requests exist/],
      ["a request filed under a change category", (db) => ticket(db, "Rollback category probe", { category: "change_other" }), /Request a Change requests exist/],
      ["a change order", (db) => newOrder(db, project, "Rollback order"), /project change requests/],
      ["a prerequisite", (db) => db.query("insert into project_prerequisites (request_id, org_id, kind, label) values ($1, $2, 'access', 'Rollback probe')", [project, w.org.id]), /prerequisites exist/],
      ["a warranty window", (db) => db.query("update client_projects set warranty_days = 30 where request_id = $1", [project]), /warranty window or a revision count/],
      ["a revision count", (db) => db.query("update client_projects set revisions_included = 2, revisions_used = 1 where request_id = $1", [project]), /warranty window or a revision count/],
      ["a mention", async (db) => {
        const t = await ticket(db, "Rollback mention");
        const note = (await db.query<{ id: string }>("insert into support_messages (ticket_id, org_id, author_id, author_kind, body, internal) values ($1, $2, $3, 'agency', 'Note', true) returning id", [t, w.org.id, w.raw.staff.id])).rows[0].id;
        await db.query("insert into support_message_mentions (message_id, ticket_id, org_id, mentioned_user_id, created_by) values ($1, $2, $3, $4, $4)", [note, t, w.org.id, w.raw.staff.id]);
      }, /mentions exist/],
      ["a triage record", async (db) => db.query("insert into support_ticket_ai_triage (ticket_id, org_id) values ($1, $2)", [await ticket(db, "Rollback triage"), w.org.id]), /triage records exist/],
      ["a survey", async (db) => db.query("insert into support_surveys (org_id, kind, ticket_id, requested_for_user_id) values ($1, 'ticket_resolution', $2, $3)", [w.org.id, await ticket(db, "Rollback survey"), w.people.owner.id]), /surveys exist/],
      ["a timeline entry of a new kind", async (db) => db.query("insert into support_ticket_events (ticket_id, org_id, kind) values ($1, $2, 'mentioned')", [await ticket(db, "Rollback event"), w.org.id]), /timeline entries of the new kinds/],
      ["a delivery-log row of a new kind", async (db) => db.query("insert into support_notification_log (ticket_id, org_id, event_kind, event_key, recipient_user_id, channel, status) values ($1, $2, 'staff_mention', 'rollback-probe', $3, 'in_app', 'delivered')", [await ticket(db, "Rollback log"), w.org.id, w.raw.staff.id]), /delivery log/],
      ["a notification of a new kind", (db) => db.query("insert into notifications (org_id, user_id, kind, title) values ($1, $2, 'support_survey', 'Rollback probe')", [w.org.id, w.people.owner.id]), /notifications of the new kinds/],
    ];
    for (const [what, add, message] of cases) {
      await expect(withSystem(async (db) => {
        await clearAll(db);
        await add(db);
        await run(db, DOWN);
        throw new Done();
      }), what).rejects.toThrow(message);
    }
  });

  it("refuses to drop a recorded decision or the scope it added, and leaves them where they are", async () => {
    const { id: project } = await approvedProject(w, "Rollback ledger project");
    await expect(withSystem(async (db) => {
      await clearAll(db);
      const id = await newOrder(db, project, "Ledger probe");
      await review(db, id);
      await quote(db, id, 12000, HASH);
      await decide(db, id, "accepted");
      await db.query("update project_change_orders set status = 'accepted', decided_at = now() where id = $1", [id]);
      await db.query("insert into project_scope_amendments (org_id, request_id, change_order_id, added_scope, added_cents, currency, agreed_by) values ($1, $2, $3, 'A second calendar', 12000, 'USD', $4)", [w.org.id, project, id, w.people.owner.id]);
      await db.query("savepoint attempt");
      const message = await run(db, DOWN).then(() => null, (e: Error) => e.message);
      await db.query("rollback to savepoint attempt");
      expect(message).toMatch(/Rollback refused: project change requests, their recorded decisions or the scope they added exist/);
      expect((await db.query("select 1 from project_scope_amendments")).rows).toHaveLength(1);
      expect((await db.query("select 1 from project_change_order_decisions")).rows).toHaveLength(1);
      expect((await db.query("select 1 from pg_class where relname = 'project_change_orders'")).rows).toHaveLength(1);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });

  it("runs once a client has exported and cleared everything the guard looks at", async () => {
    await expect(withSystem(async (db) => {
      await clearAll(db);
      await run(db, DOWN);
      throw new Done();
    })).rejects.toBeInstanceOf(Done);
  });
});
