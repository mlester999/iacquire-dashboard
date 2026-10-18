// Cheap, always-on guards for the CRM performance work. The measurements themselves live in tests/perf and run only with CRM_PERF=1
// (docs/crm-performance.md). Here: the 0038 indexes exist with the definitions the queries rely on and the planner picks them for the
// shapes they serve; every list read the screens use sends a bounded LIMIT whatever page size is asked for; a full board column never
// starves the others; an inbox conversation opens even when it is not among the newest listed, and with its newest page of messages only;
// a short page needs no count; the rewritten search and tag conditions return the same records as before; and naming many tags costs
// no more to plan than naming two. Synthetic workspaces only.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { countContacts, listCompanies, listContacts, matchingContactIds, MAX_PAGE_SIZE, pageTotal } from "@/server/crm/directory";
import { digitsPattern } from "@/server/crm/filter-sql";
import { MAX_FILTER_LIST_VALUES } from "@/lib/crm/filters";
import { createContact } from "@/server/crm/contacts";
import { createTag } from "@/server/crm/tags";
import { BOARD_CARDS_PER_STAGE, getBoard, listOpportunities } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { CONVERSATION_MESSAGE_PAGE, getConversationDetail, listConversations } from "@/server/messaging/inbox";
import { listAppointmentPage, listSchedule, SCHEDULE_LIMIT } from "@/server/calendars/schedule";
import { capture, explain, planSummary, sqlStatements, type CapturedQuery } from "./perf/harness";
import { crmOrg, type CrmOrg } from "./support/crm";
import { ctxFor } from "./support/fixtures";

const MIGRATION = readFileSync("supabase/migrations/0038_crm_performance.sql", "utf8");
const ROLLBACK = readFileSync("supabase/rollbacks/0038_crm_performance.down.sql", "utf8");
const INDEXES: Record<string, { table: string; columns: string; where?: string }> = {
  contacts_directory_recent_idx: { table: "contacts", columns: "(org_id, created_at DESC NULLS LAST, id DESC)", where: "((deleted_at IS NULL) AND (archived_at IS NULL))" },
  contacts_directory_name_idx: { table: "contacts", columns: "(org_id, lower(NULLIF(display_name, ''::text)), id)", where: "((deleted_at IS NULL) AND (archived_at IS NULL))" },
  contacts_directory_name_desc_idx: { table: "contacts", columns: "(org_id, lower(NULLIF(display_name, ''::text)) DESC NULLS LAST, id DESC)", where: "((deleted_at IS NULL) AND (archived_at IS NULL))" },
  conversation_messages_org_created_idx: { table: "conversation_messages", columns: "(org_id, created_at)" },
  message_delivery_events_org_occurred_idx: { table: "message_delivery_events", columns: "(org_id, occurred_at)" },
  appointment_refs_native_end_idx: { table: "appointment_refs", columns: "(org_id, end_at)", where: "(provider = 'native'::text)" },
  crm_busy_blocks_user_end_idx: { table: "crm_busy_blocks", columns: "(org_id, user_id, ends_at)", where: "(released_at IS NULL)" },
};
/** Measured in tests/perf and left out of 0038 because no query scanned them; they must not come back unmeasured. */
const LEFT_OUT = ["crm_contact_tags_tag_contact_idx", "crm_opportunities_board_order_idx", "crm_external_busy_user_end_idx"];

/** The plan PostgreSQL picks for a statement, with sequential scans priced out so an index is chosen whenever one fits. */
async function planFor(sql: string, params: unknown[], setup?: string): Promise<string> {
  return withSystem(async (db) => {
    if (setup) await db.query(setup);
    await db.query("set local enable_seqscan = off");
    const { rows } = await db.query<{ "QUERY PLAN": string }>(`explain (costs off) ${sql}`, params);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  });
}

const limitsIn = (sql: string) => [...sql.matchAll(/\blimit (\d+)\b/gi)].map((m) => Number(m[1]));
const reads = <Q extends { sql: string }>(qs: Q[]) => qs.filter((q) => /^\s*(select|with)\b/i.test(q.sql));

let a: CrmOrg;
let b: CrmOrg;
beforeAll(async () => {
  a = await crmOrg({ name: "Perf Guard A" });
  b = await crmOrg({ name: "Perf Guard B" });
});

describe("0038 performance indexes", () => {
  it("exist with the definitions the queries rely on, every one leading with the organization", async () => {
    const { rows } = await withSystem((db) => db.query<{ indexname: string; tablename: string; indexdef: string }>("select indexname, tablename, indexdef from pg_indexes where schemaname = 'public' and indexname = any($1::text[])", [Object.keys(INDEXES)]));
    expect(rows.map((r) => r.indexname).sort()).toEqual(Object.keys(INDEXES).sort());
    const leftOut = await withSystem((db) => db.query("select indexname from pg_indexes where schemaname = 'public' and indexname = any($1::text[])", [LEFT_OUT]));
    expect(leftOut.rows).toEqual([]);
    for (const r of rows) {
      const want = INDEXES[r.indexname];
      expect(r.tablename).toBe(want.table);
      expect(r.indexdef).toContain(` USING btree ${want.columns}`);
      expect(r.indexdef.replace(/^.* USING btree \((\w+).*$/, "$1")).toBe("org_id");
      if (want.where) expect(r.indexdef).toContain(`WHERE ${want.where}`);
      else expect(r.indexdef).not.toContain(" WHERE ");
    }
  });

  it("only adds indexes, and the rollback drops exactly those", () => {
    const created = sqlStatements(MIGRATION);
    expect(created.length).toBe(Object.keys(INDEXES).length);
    for (const s of created) expect(s).toMatch(/^create index if not exists (\w+) on \w+ \(/);
    const dropped = sqlStatements(ROLLBACK).map((s) => s.match(/^drop index if exists (\w+);$/)?.[1]);
    expect(dropped.sort()).toEqual(Object.keys(INDEXES).sort());
  });

  it("are what the planner uses for the directory pages, report periods and slot windows", async () => {
    const org = a.org.id;
    expect(await planFor("select c.id from contacts c where c.org_id = $1 and c.deleted_at is null and c.archived_at is null order by c.created_at desc nulls last, c.id desc limit 25", [org])).toContain("contacts_directory_recent_idx");
    expect(await planFor("select c.id from contacts c where c.org_id = $1 and c.deleted_at is null and c.archived_at is null order by lower(nullif(c.display_name, '')) asc nulls last, c.id asc limit 25", [org])).toContain("contacts_directory_name_idx");
    // Z to A is the Sort menu's first click on Name; contactOrderBy keeps nulls last, which the A-to-Z index read backwards cannot give.
    const zToA = await planFor("select c.id from contacts c where c.org_id = $1 and c.deleted_at is null and c.archived_at is null order by lower(nullif(c.display_name, '')) desc nulls last, c.id desc limit 25", [org]);
    expect(zToA).toContain("contacts_directory_name_desc_idx");
    expect(zToA).not.toMatch(/^\s*(->\s*)?Sort\b/m);
    // ...and that is the order the directory sends for it (the statement above is the one these indexes are matched against).
    const sent = await capture(() => listContacts(a.actor("owner"), { sort: { by: "name", dir: "desc" }, pageSize: 25 }));
    expect(reads(sent.queries).some((q) => q.sql.includes("order by lower(nullif(c.display_name, '')) desc nulls last, c.id desc"))).toBe(true);
    expect(await planFor("select count(*) from conversation_messages m where m.org_id = $1 and m.created_at >= $2 and m.created_at < $3", [org, new Date(Date.now() - 86_400_000 * 30), new Date()])).toContain("conversation_messages_org_created_idx");
    expect(await planFor("select count(*) from message_delivery_events e where e.org_id = $1 and e.occurred_at >= $2 and e.occurred_at < $3", [org, new Date(Date.now() - 86_400_000 * 30), new Date()])).toContain("message_delivery_events_org_occurred_idx");

    // A host with a long history and a few upcoming blocks: the overlap read for next month's slots goes by when blocks end.
    const host = a.people.sales.id;
    await withSystem((db) =>
      db.query(
        `insert into crm_busy_blocks (org_id, user_id, starts_at, ends_at)
         select $1::uuid, $2::uuid, now() - (g * interval '5 hours'), now() - (g * interval '5 hours') + interval '1 hour' from generate_series(10, 2009) g
         union all select $1::uuid, $2::uuid, now() + (g * interval '1 day'), now() + (g * interval '1 day') + interval '1 hour' from generate_series(1, 3) g`,
        [org, host],
      ),
    );
    const plan = await planFor(
      "select b.id from crm_busy_blocks b where b.org_id = $1 and b.user_id = any($2::uuid[]) and b.released_at is null and b.ends_at > $3 and b.starts_at < $4",
      [org, [host], new Date(), new Date(Date.now() + 30 * 86_400_000)],
      "analyze crm_busy_blocks",
    );
    expect(plan).toContain("crm_busy_blocks_user_end_idx");
    await withSystem((db) => db.query("delete from crm_busy_blocks where org_id = $1 and user_id = $2 and appointment_id is null", [org, host]));
  });
});

describe("list reads stay bounded whatever is asked for", () => {
  it("contacts, companies and deals pages cap at the maximum page size, in the statement itself", async () => {
    const owner = a.actor("owner");
    const contacts = await capture(() => listContacts(owner, { pageSize: 10_000 }));
    expect(contacts.result.pageSize).toBe(MAX_PAGE_SIZE);
    expect(reads(contacts.queries).some((q) => limitsIn(q.sql).includes(MAX_PAGE_SIZE))).toBe(true);
    const companies = await capture(() => listCompanies(owner, { pageSize: 10_000 }));
    expect(reads(companies.queries).some((q) => limitsIn(q.sql).includes(MAX_PAGE_SIZE))).toBe(true);
    const deals = await capture(() => listOpportunities(owner, { pageSize: 10_000 }));
    expect(reads(deals.queries).some((q) => limitsIn(q.sql).includes(100))).toBe(true);
    const ids = await capture(() => matchingContactIds(owner, {}, 1_000_000));
    expect(reads(ids.queries).some((q) => limitsIn(q.sql).includes(5000))).toBe(true);
  });

  it("the inbox, the calendar and the appointments list send a LIMIT parameter no larger than their caps", async () => {
    const inbox = await capture(() => listConversations(ctxFor(a.people.owner, a.org, "owner"), { limit: 100_000 }));
    expect(inbox.queries.at(-1)?.params.at(-1)).toBe(200);
    const from = new Date();
    const schedule = await capture(() => listSchedule(a.actor("owner"), { from, to: new Date(from.getTime() + 30 * 86_400_000) }));
    expect(schedule.queries.at(-1)?.params.at(-1)).toBe(SCHEDULE_LIMIT);
    const page = await capture(() => listAppointmentPage(a.actor("owner"), { when: "upcoming", pageSize: 10_000 }));
    expect(page.result.pageSize).toBe(100);
    expect(reads(page.queries).some((q) => q.params.includes(100) && /\blimit \$\d+/.test(q.sql))).toBe(true);
  });

  it("totals a short page from the page itself and counts only a full one, with the same answer", async () => {
    expect(await pageTotal(1, 25, 7, async () => 999)).toBe(7);
    expect(await pageTotal(1, 25, 0, async () => 999)).toBe(0);
    expect(await pageTotal(3, 25, 4, async () => 999)).toBe(54);
    expect(await pageTotal(1, 25, 25, async () => 999)).toBe(999);
    expect(await pageTotal(4, 25, 0, async () => 60)).toBe(60);

    const owner = a.actor("owner");
    const tag = await createTag(owner, { name: "Page total" });
    for (let i = 0; i < 3; i++) await createContact(owner, { firstName: "Short", lastName: `Page ${i}`, email: `short.page.${i}@example.test`, tagIds: [tag.id] });
    const filter = { op: "and", conditions: [{ field: "tags", op: "has_any", value: [tag.id] }] };
    const short = await capture(() => listContacts(owner, { filter, pageSize: 25 }));
    expect(short.result.total).toBe(3);
    expect(short.queries.some((q) => /select count\(\*\)/.test(q.sql))).toBe(false);
    const full = await capture(() => listContacts(owner, { filter, pageSize: 2 }));
    expect(full.result).toMatchObject({ total: 3 });
    expect(full.queries.some((q) => /select count\(\*\)/.test(q.sql))).toBe(true);
    const second = await listContacts(owner, { filter, pageSize: 2, page: 2 });
    expect(second).toMatchObject({ total: 3 });
    expect(second.rows).toHaveLength(1);
    expect((await listContacts(owner, { filter, pageSize: 2, page: 9 })).total).toBe(3);
    expect(await countContacts(owner, { filter })).toBe(3);
    // A search counts its matches in the same pass as the page, full page or not.
    const search = await capture(() => listContacts(owner, { search: "short.page", pageSize: 2 }));
    expect(search.result).toMatchObject({ total: 3, page: 1 });
    expect(search.result.rows).toHaveLength(2);
    expect(search.queries.some((q) => /select count\(\*\)::text/.test(q.sql))).toBe(false);
    expect((await listContacts(owner, { search: "short.page", pageSize: 2, page: 2 })).rows).toHaveLength(1);
    expect((await listContacts(owner, { search: "short.page", pageSize: 2, page: 5 })).total).toBe(3);
  });
});

describe("query rewrites keep the same answers", () => {
  it("a full board column never empties the others: each stage shows its own newest cards", async () => {
    const owner = a.actor("owner");
    const [pipeline] = await listPipelines(owner, { ensureDefault: true });
    const [busy, quiet] = pipeline.stages.filter((s) => s.kind === "open");
    // 2,100 recent deals in one stage and three older ones in the next: one LIMIT across the board used to return only the busy stage.
    await withSystem((db) =>
      db.query(
        `insert into crm_opportunities (org_id, provider, name, status, pipeline_ref, stage_ref, currency, stage_entered_at, created_via)
         select $1::uuid, 'native', 'Busy ' || g, 'open', $2::uuid, $3::uuid, 'USD', now() - (g * interval '1 minute'), 'manual' from generate_series(1, 2100) g
         union all select $1::uuid, 'native', 'Quiet ' || g, 'open', $2::uuid, $4::uuid, 'USD', now() - interval '30 days' - (g * interval '1 hour'), 'manual' from generate_series(1, 3) g`,
        [a.org.id, pipeline.id, busy.id, quiet.id],
      ),
    );
    const board = await getBoard(owner, pipeline.id);
    const col = (id: string) => board.find((c) => c.stage.id === id)!;
    expect(col(busy.id)).toMatchObject({ count: 2100, truncated: true });
    expect(col(busy.id).cards).toHaveLength(BOARD_CARDS_PER_STAGE);
    expect(col(busy.id).cards.map((c) => c.name).slice(0, 3)).toEqual(["Busy 1", "Busy 2", "Busy 3"]);
    expect(col(quiet.id)).toMatchObject({ count: 3, truncated: false });
    expect(col(quiet.id).cards.map((c) => c.name)).toEqual(["Quiet 1", "Quiet 2", "Quiet 3"]);
    // Search still narrows both the counts and the cards.
    const searched = await getBoard(owner, pipeline.id, { search: "quiet 2" });
    expect(searched.find((c) => c.stage.id === quiet.id)).toMatchObject({ count: 1, cards: [expect.objectContaining({ name: "Quiet 2" })] });
    expect(searched.find((c) => c.stage.id === busy.id)).toMatchObject({ count: 0, cards: [] });
    await withSystem((db) => db.query("delete from crm_opportunities where org_id = $1 and pipeline_ref = $2", [a.org.id, pipeline.id]));
  });

  it("opens a conversation that is older than the newest 200 listed, still under row-level security", async () => {
    await withSystem(async (db) => {
      await db.query(
        `insert into contacts (org_id, display_name, first_name, email) select $1, 'Thread ' || g, 'Thread', 'thread.' || g || '@example.test' from generate_series(1, 205) g`,
        [b.org.id],
      );
      await db.query(
        `insert into conversations (org_id, contact_id, channel, status, owner_kind, last_message_at, last_message_preview)
         select org_id, id, 'email', 'open', 'ai', now() - (substring(display_name from 8)::int * interval '1 hour'), 'Hello' from contacts where org_id = $1 and display_name like 'Thread %'`,
        [b.org.id],
      );
    });
    const owner = ctxFor(b.people.owner, b.org, "owner");
    const listed = await listConversations(owner, { limit: 200 });
    const oldest = (await withSystem((db) => db.query<{ id: string }>("select id from conversations where org_id = $1 order by last_message_at limit 1", [b.org.id]))).rows[0].id;
    expect(listed.some((c) => c.id === oldest)).toBe(false);
    const detail = await getConversationDetail(owner, oldest);
    expect(detail.conversation).toMatchObject({ id: oldest, contactName: "Thread 205" });
    // Another workspace, a malformed id and a role without the inbox still get "not found" / "forbidden", as before.
    await expect(getConversationDetail(ctxFor(a.people.owner, a.org, "owner"), oldest)).rejects.toThrow(/not found/i);
    await expect(getConversationDetail(owner, "not-a-uuid")).rejects.toThrow(/not found/i);
    await expect(getConversationDetail(ctxFor(b.people.viewer, b.org, "viewer"), oldest)).rejects.toThrow(/not found/i);
  });

  it("search matches any recorded email or phone of this workspace only; has-all tags means every tag", async () => {
    const owner = a.actor("owner");
    const kept = await createContact(owner, { firstName: "Imelda", lastName: "Quist", email: "imelda.q@example.test", emails: ["second.alias.zx@example.test"], phones: ["+15550199887"] });
    await createContact(b.actor("owner"), { firstName: "Other", lastName: "Tenant", email: "other.t@example.test", emails: ["second.alias.zx@example.test"] });
    const found = (q: string) => listContacts(owner, { search: q }).then((p) => p.rows.map((r) => r.id));
    expect(await found("second.alias.zx")).toEqual([kept.id]);
    expect(await found("0199887")).toEqual([kept.id]);
    expect(await found("555 019-9887")).toEqual([kept.id]);
    expect(await found("(555) 019 9888")).toEqual([]);
    expect(await found("imelda")).toEqual([kept.id]);
    expect(await countContacts(owner, { search: "second.alias.zx" })).toBe(1);

    const [t1, t2, t3] = await Promise.all(["All one", "All two", "All three"].map((name) => createTag(owner, { name })));
    const both = await createContact(owner, { firstName: "Both", lastName: "Tags", tagIds: [t1.id, t2.id] });
    await createContact(owner, { firstName: "One", lastName: "Tag", tagIds: [t1.id] });
    const all = (ids: string[]) => listContacts(owner, { filter: { op: "and", conditions: [{ field: "tags", op: "has_all", value: ids }] } }).then((p) => p.rows.map((r) => r.id));
    expect(await all([t1.id, t2.id])).toEqual([both.id]);
    expect(await all([t1.id, t2.id, t3.id])).toEqual([]);
    expect(await all([t1.id, t1.id])).toHaveLength(2);
  });

  it("has-all tags on companies means every tag too, and only this workspace's links count", async () => {
    const owner = a.actor("owner");
    const [t1, t2] = await Promise.all(["Co all one", "Co all two"].map((name) => createTag(owner, { name })));
    const { rows: cos } = await withSystem((db) =>
      db.query<{ id: string; name: string }>("insert into crm_companies (org_id, name) values ($1, 'Both Tags Co'), ($1, 'One Tag Co') returning id, name", [a.org.id]),
    );
    const byName = Object.fromEntries(cos.map((r) => [r.name, r.id]));
    await withSystem((db) =>
      db.query("insert into crm_company_tags (org_id, company_id, tag_id) values ($1, $2, $3), ($1, $2, $4), ($1, $5, $3)", [a.org.id, byName["Both Tags Co"], t1.id, t2.id, byName["One Tag Co"]]),
    );
    const all = (ids: string[]) => listCompanies(owner, { filter: { op: "and", conditions: [{ field: "tags", op: "has_all", value: ids }] } }).then((p) => p.rows.map((r) => r.id));
    expect(await all([t1.id, t2.id])).toEqual([byName["Both Tags Co"]]);
    expect((await all([t1.id])).sort()).toEqual([byName["Both Tags Co"], byName["One Tag Co"]].sort());
    expect(await listCompanies(b.actor("owner"), { filter: { op: "and", conditions: [{ field: "tags", op: "has_all", value: [t1.id] }] } }).then((p) => p.rows)).toEqual([]);
  });

  it("the digits pattern answers exactly what the digits-only copy answered, for contains, equals and starts with", async () => {
    // Phone-like and email-like values with separators, letters and runs of digits, against digit strings that do and don't occur.
    const values = ["+15550199887", "+1 (555) 019-9887", "555.019.9887 ext 12", "maria.27068@example.test", "a1b2c3d4", "0000", "", "no digits", "12-34-56", "+639171234567"];
    const needles = ["5550199887", "0199887", "15550", "1234", "27068", "9887", "000", "3456", "9171", "88"];
    const { rows } = await withSystem((db) =>
      db.query<{ mismatches: string }>(
        `select count(*) filter (where (regexp_replace(v, '\\D', '', 'g') like '%' || d || '%') <> (v ~ c)
                               or (regexp_replace(v, '\\D', '', 'g') = d) <> (v ~ e)
                               or (regexp_replace(v, '\\D', '', 'g') like d || '%') <> (v ~ s))::text as mismatches
         from unnest($1::text[]) v cross join unnest($2::text[], $3::text[], $4::text[], $5::text[]) as n(d, c, e, s)`,
        [values, needles, needles.map((d) => digitsPattern(d, "contains")), needles.map((d) => digitsPattern(d, "equals")), needles.map((d) => digitsPattern(d, "starts_with"))],
      ),
    );
    expect(rows[0].mismatches).toBe("0");
    expect(() => digitsPattern("12a", "contains")).toThrow();
  });
});

describe("costs that must not grow with what a request names", () => {
  const someIds = (n: number) => Array.from({ length: n }, () => randomUUID());
  /** The page statement a listing sent (the one reading the tag links), planned and run again in the same security context. */
  async function tagStatementPlanningMs(queries: CapturedQuery[], table: string): Promise<number> {
    const q = reads(queries).find((x) => x.sql.includes(table));
    expect(q, `a statement reading ${table}`).toBeDefined();
    const ms = planSummary(await explain(q!)).planningMs;
    expect(ms).not.toBeNull();
    return ms!;
  }

  it("has all of 200 tags, and a filter of 40 such conditions, plan in milliseconds (contacts and companies)", async () => {
    // Tag ids are only format-checked, so any member can name 200 of them, 40 times over. One existence check per tag took seconds to plan
    // at 100 tags and never finished at 200 (40 conditions of 4 tags each: 2.6 s); the grouped form plans in about a millisecond for one
    // condition and under 100 ms for 40, whatever the tag count. The ceilings leave room for a loaded machine.
    // Since the whole-filter cap (MAX_FILTER_LIST_VALUES, 1,000 values in total), 40 conditions of 200 tags are refused before any SQL is
    // built; the planning guard runs on the largest filter that is still accepted: 5 conditions of 200 tags (1,000 values).
    const owner = a.actor("owner");
    const one = { op: "and", conditions: [{ field: "tags", op: "has_all", value: someIds(200) }] };
    const forty = { op: "and", conditions: Array.from({ length: 40 }, () => ({ field: "tags", op: "has_all", value: someIds(200) })) };
    for (const list of [listContacts, listCompanies]) {
      await expect(list(owner, { filter: forty })).rejects.toMatchObject({ code: "invalid_input", message: expect.stringMatching(/at most 1,000 values in total/) });
    }
    const atCap = { op: "and", conditions: Array.from({ length: MAX_FILTER_LIST_VALUES / 200 }, () => ({ field: "tags", op: "has_all", value: someIds(200) })) };
    for (const [filter, ceilingMs] of [[one, 100], [atCap, 1_000]] as const) {
      const t0 = performance.now();
      const contacts = await capture(() => listContacts(owner, { filter }));
      expect(contacts.result.total).toBe(0);
      expect(performance.now() - t0).toBeLessThan(5_000);
      expect(await tagStatementPlanningMs(contacts.queries, "crm_contact_tags")).toBeLessThan(ceilingMs);
      const companies = await capture(() => listCompanies(owner, { filter }));
      expect(companies.result.total).toBe(0);
      expect(await tagStatementPlanningMs(companies.queries, "crm_company_tags")).toBeLessThan(ceilingMs);
    }
  });

  it("a long conversation opens with its newest page of messages, oldest first, and keeps older drafts that still need approval", async () => {
    const owner = ctxFor(b.people.owner, b.org, "owner");
    const total = CONVERSATION_MESSAGE_PAGE + 40;
    const convId = await withSystem(async (db) => {
      const k = await db.query<{ id: string }>("insert into contacts (org_id, display_name, first_name) values ($1, 'Long Thread', 'Long') returning id", [b.org.id]);
      const conv = await db.query<{ id: string }>(
        "insert into conversations (org_id, contact_id, channel, status, owner_kind, last_message_at, last_message_preview) values ($1, $2, 'sms', 'open', 'ai', now(), 'Latest') returning id",
        [b.org.id, k.rows[0].id],
      );
      // Message g is g minutes old; the oldest one is an AI draft still waiting for approval, the rest alternate inbound and sent.
      await db.query(
        `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, scope, created_at)
         select $1, $2, case when g = $3 then 'outbound' when g % 2 = 0 then 'inbound' else 'outbound' end,
                case when g = $3 then 'ai' when g % 2 = 0 then 'contact' else 'human' end, 'Message ' || g,
                case when g = $3 then 'draft' when g % 2 = 0 then 'received' else 'sent' end,
                case when g = $3 then 'reply' when g % 2 = 0 then null else 'human' end, now() - (g * interval '1 minute')
         from generate_series(1, $3) g`,
        [b.org.id, conv.rows[0].id, total],
      );
      return conv.rows[0].id;
    });
    const opened = await capture(() => getConversationDetail(owner, convId));
    const detail = opened.result;
    // The held draft first (it is the oldest), then the newest page in time order, ending with the newest message.
    expect(detail.messages).toHaveLength(CONVERSATION_MESSAGE_PAGE + 1);
    expect(detail.messages[0]).toMatchObject({ body: `Message ${total}`, status: "draft", authorKind: "ai" });
    expect(detail.messages.slice(1).map((m) => m.body)).toEqual(Array.from({ length: CONVERSATION_MESSAGE_PAGE }, (_, i) => `Message ${CONVERSATION_MESSAGE_PAGE - i}`));
    expect(detail.olderMessages).toEqual({ beforeId: detail.messages[1].id });
    expect(detail.timeline.some((t) => t.text === "AI drafted a reply for approval")).toBe(true);
    // Every message read is bounded in the statement itself.
    const messageReads = reads(opened.queries).filter((q) => /from conversation_messages m/.test(q.sql));
    expect(messageReads.length).toBeGreaterThan(0);
    for (const q of messageReads) expect(/\blimit \$\d+/.test(q.sql) && q.params.some((p) => typeof p === "number" && p <= CONVERSATION_MESSAGE_PAGE + 1)).toBe(true);

    // A short thread is unchanged: every message, oldest first, and no "older" marker.
    await withSystem((db) => db.query("delete from conversation_messages where conversation_id = $1 and created_at < now() - interval '270 seconds'", [convId]));
    const short = await getConversationDetail(owner, convId);
    expect(short.messages.map((m) => m.body)).toEqual(["Message 4", "Message 3", "Message 2", "Message 1"]);
    expect("olderMessages" in short).toBe(false);
  });
});
