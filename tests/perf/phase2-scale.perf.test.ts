// Missed-call recovery and lead scoring on one large workspace: tens of thousands of contacts with priorities, thousands of missed-call cases with their calls,
// actions and history, and a backlog of leads waiting to be scored again, next to a second workspace of noise. It measures the real service functions behind the
// screens and the two scheduler jobs, as the owner and as a restricted sales rep (row-level security on), and EXPLAINs the slowest statement of each read.
//
// Opt-in only (vitest.config.ts leaves tests/perf out of the default suite):
//   CRM_PERF=1 npx vitest run tests/perf/phase2-scale.perf.test.ts
//   PHASE2_PERF_CONTACTS=30000   contacts in the large workspace (default 30,000)
//   PHASE2_PERF_CASES=10000      missed-call cases in it (default 10,000, two calls, two actions, three history rows each)
//   CRM_PERF_RUNS=5              timed calls per measurement (after one warm-up call)
// Results go to the console and .data/perf/phase2-scale.json.
//
// Every number is from PGlite running in memory inside this process: indicative only, not a production latency. The useful signals are the plan shapes, the statement
// counts and how the cost grows with the data.
import { mkdirSync, writeFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { listContacts } from "@/server/crm/directory";
import { memberActor } from "@/server/crm/actor";
import { scoringStats } from "@/server/lead-scoring/priority";
import { processScoringQueue } from "@/server/lead-scoring/queue";
import { recoveryStats } from "@/server/missed-calls/analytics";
import { processMissedCalls } from "@/server/missed-calls/engine";
import { getCase, listCases } from "@/server/missed-calls/ops";
import { messagingOrg, type MessagingOrg } from "../support/messaging";
import { analyzeAll } from "./seed";
import { explain, measure, oneLine, PERF_LABEL, planSummary, slowestRead, type Measurement } from "./harness";

const RUN = process.env.CRM_PERF === "1";
const CONTACTS = Number(process.env.PHASE2_PERF_CONTACTS ?? "30000") || 30000;
const CASES = Number(process.env.PHASE2_PERF_CASES ?? "10000") || 10000;
const RUNS = Number(process.env.CRM_PERF_RUNS ?? "5") || 5;

let big: MessagingOrg;
let noise: MessagingOrg;

describe.skipIf(!RUN)("missed-call recovery and lead priority at scale", () => {
  beforeAll(async () => {
    big = await messagingOrg({ name: "Phase 2 Scale Co" });
    noise = await messagingOrg({ name: "Phase 2 Noise Co" });
    const t0 = performance.now();
    for (const [org, contacts, cases] of [[big, CONTACTS, CASES], [noise, Math.max(1000, Math.round(CONTACTS / 10)), Math.max(300, Math.round(CASES / 10))]] as const) {
      const orgId = org.org.id;
      await withSystem(async (db) => {
        await db.query("update organizations set timezone = 'UTC' where id = $1", [orgId]);
        await db.query(
          `insert into contacts (org_id, display_name, first_name, last_name, phone, priority_label, priority_score, priority_source, priority_evaluated_at, priority_reason, created_at)
           select $1, 'Customer ' || g, 'Customer', g::text, '+1555' || lpad(g::text, 7, '0'),
                  (array['hot','warm','cold','insufficient_data',null])[1 + g % 5],
                  case when g % 5 in (0, 1, 2) then (g * 7) % 100 end,
                  case when g % 5 = 4 then null else 'engine' end,
                  now() - ((g * 11) % (30 * 24 * 60)) * interval '1 minute',
                  case when g % 5 = 4 then null else 'Warm (55): in touch this week.' end,
                  now() - ((g * 13) % (90 * 24 * 60)) * interval '1 minute'
           from generate_series(1, $2::int) g`,
          [orgId, contacts],
        );
        // One call per case, plus its second call, each linked to the case's contact. Every case belongs to one of the first `cases` contacts.
        await db.query(
          `insert into crm_call_records (org_id, provider, provider_call_id, direction, status, from_number, to_number, contact_id, started_at, ended_at)
           select $1, 'vapi', 'perf-' || $1::text || '-' || k.n || '-' || c, 'inbound', 'no_answer', k.phone, '+15555550100', k.id,
                  now() - ((k.n * 17) % (60 * 24 * 60)) * interval '1 minute' - c * interval '10 minutes',
                  now() - ((k.n * 17) % (60 * 24 * 60)) * interval '1 minute' - c * interval '10 minutes' + interval '20 seconds'
           from (select id, phone, row_number() over (order by id)::int as n from contacts where org_id = $1) k, generate_series(1, 2) c where k.n <= $2`,
          [orgId, cases],
        );
        await db.query(
          `insert into missed_call_cases (org_id, contact_id, caller_number, business_number, classification, after_hours, provider, first_called_at, last_called_at, call_count, state, state_reason,
             next_action_at, attempts, owner_kind)
           select $1, k.id, k.phone, '+15555550100', (array['ring_no_answer','voicemail','abandoned'])[1 + k.n % 3], k.n % 4 = 0, 'vapi',
                  now() - ((k.n * 17) % (60 * 24 * 60)) * interval '1 minute' - interval '10 minutes', now() - ((k.n * 17) % (60 * 24 * 60)) * interval '1 minute', 2,
                  (array['detected','suppressed','awaiting_response','recovered','completed_without_recovery','scheduled','failed','canceled'])[1 + k.n % 8],
                  'seeded',
                  case when k.n % 8 in (0, 1, 2, 5) then now() - interval '1 minute' end, k.n % 3, 'unassigned'
           from (select id, phone, row_number() over (order by id)::int as n from contacts where org_id = $1) k where k.n <= $2`,
          [orgId, cases],
        );
        await db.query(
          `insert into missed_call_case_calls (org_id, case_id, call_record_id, classification, after_hours, called_at)
           select r.org_id, c.id, r.id, c.classification, c.after_hours, coalesce(r.started_at, now()) from missed_call_cases c join crm_call_records r on r.org_id = c.org_id and r.contact_id = c.contact_id
           where c.org_id = $1`,
          [orgId],
        );
        await db.query(
          `insert into missed_call_actions (org_id, case_id, kind, status, dedupe_key, attempt_no, executed_at)
           select org_id, id, a.kind, a.status, 'perf:' || id::text || ':' || a.kind, 0, now() from missed_call_cases, (values ('task', 'done'), ('notify', 'done')) as a(kind, status) where org_id = $1`,
          [orgId],
        );
        await db.query(
          `insert into missed_call_case_events (org_id, case_id, kind, to_state, actor_kind) select org_id, id, e.kind, e.state, 'system' from missed_call_cases, (values ('case_created', 'detected'), ('state_changed', 'awaiting_eligibility'), ('state_changed', 'suppressed')) as e(kind, state) where org_id = $1`,
          [orgId],
        );
        // A backlog of leads waiting to be scored again: due now.
        await db.query(
          `insert into lead_score_queue (contact_id, org_id, trigger, not_before) select id, org_id, 'perf', now() - interval '1 hour' from contacts where org_id = $1 and priority_label is null limit 3000`,
          [orgId],
        );
      });
    }
    await analyzeAll();
    console.log(`seeded ${CONTACTS} contacts, ${CASES} cases (+ noise) in ${Math.round(performance.now() - t0)} ms`);
  }, 1_200_000);

  it("measures the recovery tab's reads, the contact list by priority, the dashboards and both scheduler jobs", async () => {
    const owner = memberActor(big.ctx("owner"));
    const sales = memberActor(big.ctx("sales"));
    const firstCase = (await listCases(owner, { group: "all", pageSize: 25 })).rows[0].id;
    const scenarios: Array<{ name: string; fn: () => Promise<unknown>; check?: (r: unknown) => void; runs?: number }> = [
      { name: "cases: needs you, first page (owner)", fn: () => listCases(owner, { group: "needs_you", pageSize: 25 }), check: (r) => expect((r as { rows: unknown[] }).rows.length).toBe(25) },
      { name: "cases: all, second page (owner)", fn: () => listCases(owner, { group: "all", page: 2, pageSize: 25 }) },
      { name: "cases: waiting (owner)", fn: () => listCases(owner, { group: "waiting", pageSize: 25 }) },
      { name: "cases: needs you (sales rep, row-level security)", fn: () => listCases(sales, { group: "needs_you", pageSize: 25 }) },
      { name: "one case with its calls, actions and history", fn: () => getCase(owner, firstCase) },
      { name: "recovery dashboard, 30 days", fn: () => recoveryStats(owner, 30) },
      { name: "recovery dashboard, 90 days", fn: () => recoveryStats(owner, 90) },
      { name: "contacts: sorted by priority (owner)", fn: () => listContacts(owner, { sort: { by: "priority", dir: "desc" }, pageSize: 50 } as never), check: (r) => expect((r as { rows: unknown[] }).rows.length).toBe(50) },
      { name: "contacts: Hot only, sorted by priority", fn: () => listContacts(owner, { filter: { op: "and", conditions: [{ field: "priority_label", op: "in", value: ["hot"] }] }, sort: { by: "priority", dir: "desc" }, pageSize: 50 } as never) },
      { name: "contacts: score at least 80", fn: () => listContacts(owner, { filter: { op: "and", conditions: [{ field: "priority_score", op: "gte", value: 80 }] }, pageSize: 50 } as never) },
      { name: "lead priority dashboard", fn: () => scoringStats(owner) },
      { name: "recovery job: 20 due cases", fn: () => processMissedCalls({ limit: 20, perOrgLimit: 20, orgId: big.org.id }), runs: 1 },
      { name: "scoring job: 40 queued leads", fn: () => processScoringQueue({ limit: 40, perOrgLimit: 40, orgId: big.org.id }), runs: 1 },
    ];
    const rows: Array<Measurement & { plan?: { scans: string[]; executionMs: number | null; text: string; sql: string } }> = [];
    for (const s of scenarios) {
      const { m, last } = await measure("phase2", s.name, s.fn, { runs: s.runs ?? RUNS });
      if (s.check) s.check(last.result);
      const slow = slowestRead(last.queries);
      const planText = slow ? await explain(slow) : "";
      const plan = slow ? planSummary(planText) : undefined;
      rows.push({ ...m, plan: plan ? { scans: plan.scans, executionMs: plan.executionMs, text: planText, sql: slow ? oneLine(slow.sql, 4000) : "" } : undefined });
      console.log(`${s.name.padEnd(58)} median ${String(m.medianMs).padStart(8)} ms  max ${String(m.maxMs).padStart(8)} ms  statements ${String(m.queries).padStart(4)}  payload ${Math.round(m.payloadBytes / 1024)} KB  scans ${(plan?.scans ?? []).join(", ").slice(0, 120)}`);
      if (slow) console.log(`    slowest statement: ${oneLine(slow.sql, 160)}`);
    }
    mkdirSync(".data/perf", { recursive: true });
    writeFileSync(".data/perf/phase2-scale.json", JSON.stringify({ label: PERF_LABEL, contacts: CONTACTS, cases: CASES, runs: RUNS, rows }, null, 2));
    for (const r of rows.filter((x) => x.name.startsWith("cases:") || x.name.startsWith("contacts:"))) expect(r.payloadBytes, r.name).toBeLessThan(400_000);
    void noise;
  }, 1_200_000);
});
