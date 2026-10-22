// The Unified Inbox's reads on one large workspace: tens of thousands of conversations and a few messages each, next to a second workspace of noise.
// It measures the real service functions behind the inbox screen and the change poll, as a workspace owner and as a restricted sales rep (row-level
// security on), and EXPLAINs the slowest statement of each in the same security context.
//
// Opt-in only (vitest.config.ts leaves tests/perf out of the default suite):
//   CRM_PERF=1 npx vitest run tests/perf/inbox-scale.perf.test.ts
//   INBOX_PERF_CONVERSATIONS=30000   conversations in the large workspace (default 30,000; five messages each)
//   CRM_PERF_RUNS=5                  timed calls per measurement (after one warm-up call)
// Results go to the console and .data/perf/inbox-scale.json.
//
// Every number is from PGlite running in memory inside this process: indicative only, not a production latency. Hosted Postgres has a real buffer
// cache, parallel workers and a network hop; the useful signals are the plan shapes, the statement counts and how the cost grows with the data.
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { inboxViewCounts, listConversationsPage, type ListPage } from "@/server/messaging/inbox-list";
import { inboxSync } from "@/server/messaging/inbox-sync";
import { notifyAwaitingReplies } from "@/server/messaging/attention";
import { messagingOrg, type MessagingOrg } from "../support/messaging";
import { analyzeAll } from "./seed";
import { explain, measure, oneLine, PERF_LABEL, planSummary, slowestRead, type Measurement } from "./harness";

const RUN = process.env.CRM_PERF === "1";
const CONVERSATIONS = Number(process.env.INBOX_PERF_CONVERSATIONS ?? "30000") || 30000;
const MESSAGES_EACH = 5;
const RUNS = Number(process.env.CRM_PERF_RUNS ?? "5") || 5;

let big: MessagingOrg;
let noise: MessagingOrg;

/** Contacts, conversations and messages for one workspace, by SQL. Times are spread over 90 days; a third of conversations wait on a customer. */
async function seed(org: MessagingOrg, conversations: number) {
  const orgId = org.org.id;
  await withSystem(async (db) => {
    await db.query(
      `insert into contacts (org_id, display_name, first_name, last_name, phone)
       select $1, 'Customer ' || g, 'Customer', g::text, '+1555' || lpad(g::text, 7, '0') from generate_series(1, $2::int) g`,
      [orgId, conversations],
    );
    await db.query(
      // updated_at and created_at are given explicitly: a row's default is the moment of the insert, which would make every conversation "changed in the
      // last minute" and turn the change poll into a full read, which is not what a real workspace looks like.
      `insert into conversations (org_id, contact_id, channel, status, owner_kind, owner_user_id, assigned_user_id, priority, unread_count,
                                  last_inbound_at, last_outbound_at, last_message_at, last_message_preview, created_at, updated_at)
       select $1, c.id, (array['sms','email','whatsapp'])[1 + c.k % 3], case when c.k % 10 < 6 then 'open' when c.k % 10 = 6 then 'snoozed' else 'closed' end,
              case c.k % 3 when 0 then 'ai' when 1 then 'unassigned' else 'human' end,
              case when c.k % 3 = 2 then $2::uuid end, case when c.k % 4 = 0 then $3::uuid end,
              case when c.k % 25 = 0 then 'urgent' when c.k % 10 = 0 then 'high' else 'normal' end, c.k % 4,
              now() - ((c.k * 13) % (90 * 24 * 60)) * interval '1 minute' - interval '5 minutes',
              case when c.k % 3 = 0 then null else now() - ((c.k * 13) % (90 * 24 * 60)) * interval '1 minute' end,
              now() - ((c.k * 13) % (90 * 24 * 60)) * interval '1 minute',
              'Thanks, see you at the viewing ' || c.k,
              now() - ((c.k * 13) % (90 * 24 * 60)) * interval '1 minute' - interval '1 day',
              now() - ((c.k * 13) % (90 * 24 * 60)) * interval '1 minute'
       from (select id, row_number() over (order by id)::int as k from contacts where org_id = $1) c`,
      [orgId, org.people.support.id, org.people.sales.id],
    );
    await db.query(
      `insert into conversation_messages (org_id, conversation_id, direction, author_kind, body, status, created_at, sent_at, delivered_at)
       select $1, cv.id, case when m % 2 = 0 then 'inbound' else 'outbound' end, case when m % 2 = 0 then 'contact' else 'ai' end, 'Message ' || m,
              case when m % 2 = 0 then 'received' else 'delivered' end, cv.last_message_at - (m * interval '3 minutes'),
              case when m % 2 = 1 then cv.last_message_at - (m * interval '3 minutes') end, case when m % 2 = 1 then cv.last_message_at - (m * interval '3 minutes') + interval '5 seconds' end
       from (select id, last_message_at from conversations where org_id = $1) cv, generate_series(1, $2::int) m`,
      [orgId, MESSAGES_EACH],
    );
    // The trigger stamps a message with the moment of its insert; a real workspace's messages were stamped when they last changed status.
    await db.query("update conversation_messages set status_changed_at = created_at where org_id = $1", [orgId]);
  });
}

beforeAll(async () => {
  if (!RUN) return;
  big = await messagingOrg({ name: "Inbox Scale Co" });
  noise = await messagingOrg({ name: "Inbox Noise Co" });
  const t0 = performance.now();
  await seed(big, CONVERSATIONS);
  await seed(noise, Math.max(1000, Math.round(CONVERSATIONS / 10)));
  // A busy minute: 100 conversations were touched just now, which is what the change poll finds.
  await withSystem((db) => db.query("update conversations set unread_count = unread_count where id in (select id from conversations where org_id = $1 order by id limit 100)", [big.org.id]));
  await analyzeAll();
  console.log(`seeded ${CONVERSATIONS} conversations and ${CONVERSATIONS * MESSAGES_EACH} messages (+ noise) in ${Math.round(performance.now() - t0)} ms`);
}, 900_000);

describe.skipIf(!RUN)("inbox reads at scale", () => {
  it("measures the inbox screen's reads, the counts and the change poll, and explains the slowest statement of each", async () => {
    const owner = big.ctx("owner");
    const sales = big.ctx("sales");
    const first = await listConversationsPage(owner, { limit: 50 });
    const scenarios: Array<{ name: string; fn: () => Promise<unknown>; check?: (r: unknown) => void }> = [
      { name: "page: All, Priority sort (the default)", fn: () => listConversationsPage(owner, { limit: 50 }), check: (r) => expect((r as ListPage).items.length).toBe(50) },
      { name: "page: All, Newest", fn: () => listConversationsPage(owner, { limit: 50, sort: "recent" }) },
      { name: "page: All, Longest waiting", fn: () => listConversationsPage(owner, { limit: 50, sort: "waiting_longest" }) },
      { name: "page: Unread", fn: () => listConversationsPage(owner, { view: "unread", limit: 50 }) },
      { name: "page: Needs attention", fn: () => listConversationsPage(owner, { view: "attention", limit: 50 }) },
      { name: "page: Waiting, longest first", fn: () => listConversationsPage(owner, { view: "waiting", sort: "waiting_longest", limit: 50 }) },
      { name: "page: Assigned to AI", fn: () => listConversationsPage(owner, { view: "ai", limit: 50 }) },
      { name: "page: Resolved", fn: () => listConversationsPage(owner, { view: "resolved", limit: 50 }) },
      { name: "page: search 'viewing 12'", fn: () => listConversationsPage(owner, { q: "viewing 12", limit: 50 }) },
      { name: "page: second page by cursor", fn: async () => (first.nextCursor ? listConversationsPage(owner, { limit: 50, cursor: first.nextCursor }) : first), check: (r) => expect((r as ListPage).items.length).toBeGreaterThan(0) },
      { name: "page: All as a sales rep (own and assigned only)", fn: () => listConversationsPage(sales, { limit: 50 }) },
      { name: "counts for every tab (owner)", fn: () => inboxViewCounts(owner) },
      { name: "counts for every tab (sales rep)", fn: () => inboxViewCounts(sales) },
      { name: "sync: the last minute, with counts", fn: () => inboxSync(owner, new Date(Date.now() - 60_000).toISOString(), { counts: true }) },
      { name: "sync: the last minute, no counts", fn: () => inboxSync(owner, new Date(Date.now() - 60_000).toISOString()) },
      // About one conversation in ninety last heard from the customer in the scan's 24-hour window, so this reads a few hundred rows and writes nothing new after the first call.
      { name: "scheduled scan: customers waiting (all workspaces)", fn: () => withSystem((db) => notifyAwaitingReplies(db, new Date())) },
    ];
    const rows: Array<Measurement & { plan?: { scans: string[]; executionMs: number | null; text: string; sql: string } }> = [];
    for (const s of scenarios) {
      const { m, last } = await measure("inbox", s.name, s.fn, { runs: RUNS });
      if (s.check) s.check(last.result);
      const slow = slowestRead(last.queries);
      const planText = slow ? await explain(slow) : "";
      const plan = slow ? planSummary(planText) : undefined;
      rows.push({ ...m, plan: plan ? { scans: plan.scans, executionMs: plan.executionMs, text: planText, sql: slow ? oneLine(slow.sql, 4000) : "" } : undefined });
      console.log(`${s.name.padEnd(56)} median ${String(m.medianMs).padStart(8)} ms  max ${String(m.maxMs).padStart(8)} ms  statements ${m.queries}  payload ${Math.round(m.payloadBytes / 1024)} KB  slowest-plan ${plan?.executionMs ?? "?"} ms  ${plan ? plan.scans.slice(0, 3).join(" | ") : ""}`);
      if (slow) console.log(`    slowest statement: ${oneLine(slow.sql, 160)}`);
    }
    // Whether this engine could build the optional trigram index for message search (hosted Postgres can; an embedded one may not have pg_trgm).
    const trigram = (await withSystem((db) => db.query("select 1 from pg_indexes where indexname = 'conversation_messages_body_trgm'"))).rows.length > 0;
    console.log(`trigram index for message search present: ${trigram}`);
    mkdirSync(".data/perf", { recursive: true });
    writeFileSync(".data/perf/inbox-scale.json", JSON.stringify({ label: PERF_LABEL, conversations: CONVERSATIONS, messages: CONVERSATIONS * MESSAGES_EACH, runs: RUNS, trigramIndexPresent: trigram, rows }, null, 2));
    // Pages and counts must not read the whole workspace into the application: a page is at most 50 items however large the workspace is.
    for (const r of rows.filter((x) => x.name.startsWith("page:"))) expect(r.payloadBytes, r.name).toBeLessThan(400_000);
    void noise;
  }, 900_000);

  // WHERE the search time goes. The same predicate the list uses (src/server/messaging/inbox-list.ts), one branch at a time and all together, as a workspace
  // member (row-level security) and as the system role (none), so the cost of the predicate can be told from the cost of row-level security. Diagnostic only:
  // it changes nothing in the application. A rewrite of the predicate as a union was tried on 2026-10-22 and was about four times slower under row-level security.
  it("attributes the cost of search to its branches and to row-level security", async () => {
    const owner = big.ctx("owner");
    const p = "%viewing 12%";
    const name = "k.display_name ilike $2";
    const text = "(c.last_message_preview ilike $2 or c.subject ilike $2)";
    const identity = "exists (select 1 from contact_identities i where i.contact_id = k.id and i.org_id = c.org_id and i.value ilike $2)";
    const body = "exists (select 1 from conversation_messages sm where sm.conversation_id = c.id and sm.org_id = c.org_id and sm.direction <> 'internal' and sm.body ilike $2)";
    const variants: Array<[string, string]> = [
      ["no search (the first page, for comparison)", "true"],
      ["name only", name],
      ["preview and subject only", text],
      ["identity only", identity],
      ["message text only", body],
      ["name or preview or subject", `(${name} or ${text})`],
      ["all five, as the list runs them", `(${name} or ${text} or ${identity} or ${body})`],
    ];
    const sql = (pred: string) => `select c.id from conversations c join contacts k on k.id = c.contact_id where c.org_id = $1 and ${pred} order by c.last_message_at desc nulls last limit 51`;
    const time = async (run: () => Promise<unknown>) => {
      await run();
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const t0 = performance.now();
        await run();
        samples.push(performance.now() - t0);
      }
      return Math.round(samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] * 10) / 10;
    };
    const rows: Array<{ variant: string; memberMs: number; systemMs: number }> = [];
    for (const [variant, pred] of variants) {
      const params = pred === "true" ? [big.org.id] : [big.org.id, p];
      const text2 = pred === "true" ? sql(pred) : sql(pred);
      const memberMs = await time(() => withUser(owner.user.id, (db) => db.query(text2, params)));
      const systemMs = await time(() => withSystem((db) => db.query(text2, params)));
      rows.push({ variant, memberMs, systemMs });
      console.log(`${variant.padEnd(46)} member ${String(memberMs).padStart(8)} ms   system ${String(systemMs).padStart(8)} ms`);
    }
    mkdirSync(".data/perf", { recursive: true });
    writeFileSync(".data/perf/inbox-search-attribution.json", JSON.stringify({ label: PERF_LABEL, conversations: CONVERSATIONS, term: "viewing 12", runs: RUNS, rows }, null, 2));
    expect(rows).toHaveLength(variants.length);
  }, 900_000);

  // A CANDIDATE, measured and then undone. conversation_messages' policy says a message is visible when an EXISTS lookup finds its conversation, so a text search does one
  // lookup per message before it can filter. This swaps in a policy with the same meaning that short-circuits for a workspace's people who see every conversation
  // (owner, admin), and checks that every role sees exactly the same messages. It is NOT in a migration: a change to a row-level security policy needs its own security
  // review. The original policy is restored at the end, whatever happens. Run last in this file.
  it("measures a candidate policy for conversation_messages, and proves it shows each role the same rows", async () => {
    const original = (await withSystem((db) => db.query<{ qual: string }>("select qual from pg_policies where tablename = 'conversation_messages' and policyname = 'conversation_messages_select'"))).rows[0].qual;
    expect(original).toMatch(/EXISTS/);
    const people = ["owner", "manager", "sales", "support", "viewer"] as const;
    const visible = async () => Object.fromEntries(await Promise.all(people.map(async (who) => [who, Number((await withUser(big.ctx(who).user.id, (db) => db.query<{ n: string }>("select count(*)::text as n from conversation_messages where org_id = $1", [big.org.id]))).rows[0].n)])));
    const search = (who: (typeof people)[number]) => async () => withUser(big.ctx(who).user.id, (db) => db.query(
      "select c.id from conversations c join contacts k on k.id = c.contact_id where c.org_id = $1 and exists (select 1 from conversation_messages sm where sm.conversation_id = c.id and sm.org_id = c.org_id and sm.direction <> 'internal' and sm.body ilike $2) order by c.last_message_at desc nulls last limit 51",
      [big.org.id, "%viewing 12%"],
    ));
    const median = async (run: () => Promise<unknown>) => {
      await run();
      const samples: number[] = [];
      for (let i = 0; i < RUNS; i += 1) {
        const t0 = performance.now();
        await run();
        samples.push(performance.now() - t0);
      }
      return Math.round(samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)] * 10) / 10;
    };
    const measure = async () => ({ owner: await median(search("owner")), sales: await median(search("sales")) });
    const before = { visible: await visible(), searchMs: await measure() };
    try {
      await withSystem(async (db) => {
        await db.query("drop policy conversation_messages_select on conversation_messages");
        await db.query(
          `create policy conversation_messages_select on conversation_messages for select using (
             org_id = any ((select app.permitted_orgs('inbox.view'))::uuid[])
             and (org_id = any ((select app.permitted_orgs('inbox.view_all'))::uuid[])
                  or exists (select 1 from conversations c where c.id = conversation_messages.conversation_id and c.org_id = conversation_messages.org_id)))`,
        );
      });
      const after = { visible: await visible(), searchMs: await measure() };
      mkdirSync(".data/perf", { recursive: true });
      writeFileSync(".data/perf/inbox-rls-candidate.json", JSON.stringify({ label: PERF_LABEL, conversations: CONVERSATIONS, term: "viewing 12", before, after }, null, 2));
      console.log(`candidate policy: owner search ${before.searchMs.owner} -> ${after.searchMs.owner} ms; sales rep ${before.searchMs.sales} -> ${after.searchMs.sales} ms; visible rows ${JSON.stringify(before.visible)} -> ${JSON.stringify(after.visible)}`);
      // The same messages are visible to every role.
      expect(after.visible).toEqual(before.visible);
    } finally {
      await withSystem(async (db) => {
        await db.query("drop policy if exists conversation_messages_select on conversation_messages");
        await db.query(`create policy conversation_messages_select on conversation_messages for select using (${original})`);
      });
    }
    expect((await withSystem((db) => db.query<{ qual: string }>("select qual from pg_policies where tablename = 'conversation_messages' and policyname = 'conversation_messages_select'"))).rows[0].qual).toBe(original);
  }, 900_000);
});
