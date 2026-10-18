// The Native CRM at realistic scale: one workspace with 50,000 contacts (tags and custom field values), 5,000 deals across three pipelines,
// 20,000 messages over 3,000 conversations and 2,000 appointments, next to two other workspaces of noise. It measures the real service
// functions behind the busiest screens and EXPLAINs their slowest statement in the same security context (row-level security for members).
//
// Opt-in only: `CRM_PERF=1 npx vitest run tests/perf` (vitest.config.ts leaves tests/perf out of the default suite).
//   CRM_PERF_SCALE=0.2   seeds a fifth of the data for a quick check
//   CRM_PERF_RUNS=5      timed calls per measurement (after one warm-up call); CRM_PERF_RUNS_PROPOSED for the 0050 phase
//   CRM_PERF_PHASE=label prefixes the phase names
//   CRM_PERF_PROPOSAL=0  skips the 0050 (row-level security once per statement) phase
//   CRM_PERF_STEPS=...   overrides the sequence (drop-0050, add-0050, drop-0038, add-0038, measure; proposed-rls is an alias of add-0050)
// Default phases, on the same data: the policies as they were before 0050 (its rollback runs first) without the 0038 indexes, with them,
// and with them plus migration 0050_rls_initplan (it replaced tests/perf/rls-initplan.proposal.sql, the experiment it was measured from).
// Every measured call's result is fingerprinted; all phases must return identical results.
// Results go to .data/perf/crm-scale-<phase>.json and the console, including which indexes each call scanned (pg_stat_user_indexes).
//
// Every number is from PGlite running in memory inside this process: indicative only, not a production latency. Hosted Postgres has a real
// buffer cache, parallel workers and a network hop; the useful signals here are the plan shapes, the query counts and the relative costs.
import { existsSync, readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { countContacts, listCompanies, listContacts } from "@/server/crm/directory";
import { createSmartList } from "@/server/crm/smart-lists";
import { BOARD_CARDS_PER_STAGE, getBoard, getPipelineMetrics, listOpportunities } from "@/server/crm/opportunities";
import { listPipelines } from "@/server/crm/pipelines";
import { listAppointmentPage, listBookableSlots, listSchedule } from "@/server/calendars/schedule";
import { getCrmReport } from "@/server/crm/reports/service";
import { getCrmOverview } from "@/server/crm/overview";
import { getDashboard } from "@/server/queries/dashboard";
import { getConversationDetail, listConversations } from "@/server/messaging/inbox";
import { crmOrg, type CrmOrg } from "../support/crm";
import { ctxFor } from "../support/fixtures";
import { analyzeAll, datasetCounts, NOISE, scaled, seedWorkspace, TARGET, TZ, type SeededWorkspace } from "./seed";
import { explain, indexesUsed, indexScans, measure, oneLine, PERF_LABEL, planSummary, slowestRead, sqlStatements, writeReport, type Measurement, type PerfReport } from "./harness";
import { runPairs } from "./pairs";

const RUN = process.env.CRM_PERF === "1";
const FACTOR = Number(process.env.CRM_PERF_SCALE ?? "1") || 1;
const RUNS = Number(process.env.CRM_PERF_RUNS ?? "5") || 5;
/** Timed calls per measurement once 0050 is in (each call takes milliseconds there, so more runs cost little). */
const RUNS_PROPOSED = Number(process.env.CRM_PERF_RUNS_PROPOSED ?? "5") || 5;
const LABEL = process.env.CRM_PERF_PHASE ? `${process.env.CRM_PERF_PHASE}-` : "";
const LONG = 120 * 60_000;
const MIGRATION = "supabase/migrations/0038_crm_performance.sql";
const ROLLBACK = "supabase/rollbacks/0038_crm_performance.down.sql";
const RLS_MIGRATION = "supabase/migrations/0050_rls_initplan.sql";
const RLS_ROLLBACK = "supabase/rollbacks/0050_rls_initplan.down.sql";
/** One clock for every phase, so time-relative reads (slots, upcoming) ask the same question each time. */
const NOW = new Date();
/**
 * Calls whose result can legitimately differ between phases: one saves a new list on every call (and the overview counts saved lists); the
 * others filter on now() inside SQL (closed in the last 30 days, new this week, the WhatsApp window), which moves while the suite runs.
 */
const NOT_COMPARED = new Set([
  "compile + save a list (validation compiles the filter)", "CRM overview (home)", "portal dashboard", "board: default pipeline (counts + cards per stage)",
  "board: search 'deal 12'", "inbox: open one conversation",
]);

let c: CrmOrg;
let other: CrmOrg;
let ws: SeededWorkspace;
const seedMs: Record<string, number> = {};
const reports: PerfReport[] = [];
let rlsStats: { rewritten: number; per_row_left: number } | null = null;

/** Runs a migration or rollback file in one transaction, as the migration runner does. */
async function runFile(file: string) {
  await withSystem(async (db) => {
    for (const stmt of sqlStatements(readFileSync(file, "utf8"))) await db.query(stmt);
  });
  await analyzeAll();
}

const rlsApplied = async () => (await withSystem((db) => db.query("select 1 from pg_proc where proname = 'permitted_orgs' and pronamespace = 'app'::regnamespace"))).rows.length > 0;

type Scenario = { group: string; name: string; fn: () => Promise<unknown>; note?: string; check?: (r: unknown) => void };

function scenarios(): Scenario[] {
  const owner = c.actor("owner");
  const ctx = ctxFor(c.people.owner, c.org, "owner");
  ctx.org.timezone = TZ;
  const main = ws.pipelines[0];
  const in30 = new Date(NOW.getTime() + 30 * 86_400_000);
  const rows = (max: number) => (r: unknown) => expect((r as { rows: unknown[] }).rows.length).toBeLessThanOrEqual(max);
  const f = (conditions: unknown[]) => ({ op: "and", conditions });
  return [
    // --- Contact directory -----------------------------------------------------------------------------------------------------
    { group: "directory", name: "contacts: first page (newest first, 25)", fn: () => listContacts(owner, { page: 1, pageSize: 25 }), check: rows(25) },
    { group: "directory", name: "contacts: first page, 100 per page", fn: () => listContacts(owner, { page: 1, pageSize: 100 }), check: rows(100), note: "same statement count as 25 per page (no N+1)" },
    { group: "directory", name: "contacts: page 200 (offset 4,975)", fn: () => listContacts(owner, { page: 200, pageSize: 25 }), check: rows(25) },
    { group: "directory", name: "contacts: sorted by name", fn: () => listContacts(owner, { sort: { by: "name", dir: "asc" }, pageSize: 25 }), check: rows(25), note: "A to Z: the Sort menu's second click on Name" },
    { group: "directory", name: "contacts: sorted by name (Z to A, the Sort menu's first click)", fn: () => listContacts(owner, { sort: { by: "name", dir: "desc" }, pageSize: 25 }), check: rows(25) },
    { group: "directory", name: "contacts: same first page as trusted code (no RLS)", fn: () => listContacts(c.system, { page: 1, pageSize: 25 }), check: rows(25), note: "row-level security overhead = difference with the first row" },
    { group: "directory", name: "search: name prefix", fn: () => listContacts(owner, { search: ws.probe.namePrefix }), check: rows(25) },
    { group: "directory", name: "search: exact email", fn: () => listContacts(owner, { search: ws.probe.email }), check: rows(25) },
    { group: "directory", name: "search: phone digits", fn: () => listContacts(owner, { search: ws.probe.phoneDigits }), check: rows(25) },
    { group: "directory", name: "filter: common tag", fn: () => listContacts(owner, { filter: f([{ field: "tags", op: "has_any", value: [ws.tags[0]] }]) }), check: rows(25) },
    { group: "directory", name: "filter: rare tag", fn: () => listContacts(owner, { filter: f([{ field: "tags", op: "has_any", value: [ws.tags[20]] }]) }), check: rows(25) },
    { group: "directory", name: "filter: has all of two tags", fn: () => listContacts(owner, { filter: f([{ field: "tags", op: "has_all", value: [ws.tags[0], ws.tags[10]] }]) }), check: rows(25) },
    { group: "directory", name: "filter: custom number > 900k", fn: () => listContacts(owner, { filter: f([{ field: `cf:${ws.fields.budget}`, op: "gt", value: 900000 }]) }), check: rows(25) },
    { group: "directory", name: "filter: custom select = condo", fn: () => listContacts(owner, { filter: f([{ field: `cf:${ws.fields.propertyType}`, op: "in", value: ["condo"] }]) }), check: rows(25) },
    {
      group: "directory", name: "filter: status + owner + tag",
      fn: () => listContacts(owner, { filter: f([{ field: "lead_status", op: "in", value: ["qualified", "contacted"] }, { field: "owner", op: "is_any_of", value: [c.people.sales.id] }, { field: "tags", op: "has_any", value: [ws.tags[1]] }]) }),
      check: rows(25),
    },
    { group: "directory", name: "companies: first page", fn: () => listCompanies(owner, { page: 1, pageSize: 25 }), check: rows(25) },
    { group: "directory", name: "companies: search", fn: () => listCompanies(owner, { search: "holdings" }), check: rows(25) },
    // --- Smart Lists -----------------------------------------------------------------------------------------------------------
    {
      group: "smart lists", name: "compile + save a list (validation compiles the filter)",
      fn: () => createSmartList(owner, { name: `Perf ${Math.random().toString(36).slice(2, 8)}`, filter: f([{ field: "tags", op: "has_any", value: [ws.tags[2]] }, { field: `cf:${ws.fields.budget}`, op: "gte", value: 500000 }]) }),
    },
    { group: "smart lists", name: "open a list: buyers 500k+ with tag (page + total)", fn: async () => listContacts(owner, { smartListId: await hotList() }), check: rows(25) },
    { group: "smart lists", name: "count a list: buyers 500k+ with tag", fn: async () => countContacts(owner, { smartListId: await hotList() }) },
    { group: "smart lists", name: "open a list: no activity, no deal, never contacted", fn: async () => listContacts(owner, { smartListId: await staleList() }), check: rows(25) },
    { group: "smart lists", name: "count a list: no activity, no deal, never contacted", fn: async () => countContacts(owner, { smartListId: await staleList() }) },
    // --- Pipeline board --------------------------------------------------------------------------------------------------------
    {
      group: "pipeline", name: "board: default pipeline (counts + cards per stage)", fn: () => getBoard(owner, main.id, {}),
      check: (r) => {
        for (const col of r as Array<{ cards: unknown[]; count: number }>) expect(col.cards.length).toBe(Math.min(BOARD_CARDS_PER_STAGE, col.count));
      },
    },
    { group: "pipeline", name: "board: search 'deal 12'", fn: () => getBoard(owner, main.id, { search: "deal 12" }) },
    { group: "pipeline", name: "board: metrics strip", fn: () => getPipelineMetrics(owner, main.id, { to: NOW }) },
    { group: "pipeline", name: "pipelines with stage counts", fn: () => listPipelines(owner) },
    { group: "pipeline", name: "deals table: first page", fn: () => listOpportunities(owner, { pipelineId: main.id, page: 1, pageSize: 25 }), check: rows(25) },
    // --- Calendar --------------------------------------------------------------------------------------------------------------
    { group: "calendar", name: "slots: busy host, next 30 days", fn: () => listBookableSlots(owner, { typeId: ws.typeId, from: NOW, to: in30, now: NOW }) },
    { group: "calendar", name: "schedule: 30-day window", fn: () => listSchedule(owner, { from: NOW, to: in30 }) },
    { group: "calendar", name: "appointments list: upcoming", fn: () => listAppointmentPage(owner, { when: "upcoming", now: NOW }) },
    { group: "calendar", name: "appointments list: past (newest first)", fn: () => listAppointmentPage(owner, { when: "past", now: NOW }) },
    // --- Reports and dashboards --------------------------------------------------------------------------------------------------
    { group: "reports", name: "reports: every section, last 90 days", fn: () => getCrmReport(owner, { filters: { range: "90d" } }, NOW) },
    { group: "reports", name: "reports: every section, last 30 days, one member", fn: () => getCrmReport(owner, { filters: { range: "30d", member: c.people.sales.id } }, NOW) },
    { group: "reports", name: "CRM overview (home)", fn: () => getCrmOverview(owner) },
    { group: "reports", name: "portal dashboard", fn: () => getDashboard(ctx) },
    // --- Unified inbox -----------------------------------------------------------------------------------------------------------
    { group: "inbox", name: "inbox: conversation list", fn: () => listConversations(ctx, {}), check: (r) => expect((r as unknown[]).length).toBeLessThanOrEqual(200) },
    { group: "inbox", name: "inbox: unread only", fn: () => listConversations(ctx, { unreadOnly: true }) },
    { group: "inbox", name: "inbox: search", fn: () => listConversations(ctx, { q: "viewing 12" }) },
    { group: "inbox", name: "inbox: open one conversation", fn: async () => getConversationDetail(ctx, await someConversation()) },
    { group: "inbox", name: "inbox: list as a sales rep (own + assigned only)", fn: () => listConversations(ctxFor(c.people.sales, c.org, "sales_rep"), {}) },
    // --- Isolation: the same answers for other roles and another workspace in every phase -------------------------------------------
    { group: "isolation", name: "another workspace's owner: contacts total", fn: async () => (await listContacts(other.actor("owner"), { pageSize: 5 })).total },
    { group: "isolation", name: "viewer: contacts total + deals table total", fn: async () => [(await listContacts(c.actor("viewer"), { pageSize: 5 })).total, (await listOpportunities(c.actor("viewer"), { pageSize: 5 }).catch((e: Error) => ({ total: e.message }))).total] },
    { group: "isolation", name: "support role: inbox list", fn: () => listConversations(ctxFor(c.people.support, c.org, "support"), {}).catch((e: Error) => e.message) },
  ];
}

let hot: string | null = null;
let stale: string | null = null;
async function hotList() {
  hot ??= (await createSmartList(c.actor("owner"), {
    name: "Buyers 500k+", visibility: "private",
    filter: { op: "and", conditions: [{ field: "tags", op: "has_any", value: [ws.tags[1]] }, { field: `cf:${ws.fields.budget}`, op: "gte", value: 500000 }, { field: "lead_status", op: "in", value: ["qualified", "contacted", "open"] }] },
  })).id;
  return hot;
}
async function staleList() {
  stale ??= (await createSmartList(c.actor("owner"), {
    name: "No activity, no deal", visibility: "private",
    filter: { op: "and", conditions: [{ field: "last_activity_at", op: "is_empty" }, { field: "opportunity", op: "has_none" }, { field: "conversation", op: "never_contacted" }] },
  })).id;
  return stale;
}
let conv: string | null = null;
async function someConversation() {
  conv ??= (await listConversations(ctxFor(c.people.owner, c.org, "owner"), {}))[3].id;
  return conv;
}

async function runPhase(phase: string, runs = RUNS) {
  const measurements: Measurement[] = [];
  const plans: PerfReport["plans"] = [];
  for (const s of scenarios()) {
    const before = await indexScans();
    const { m, last } = await measure(s.group, s.name, s.fn, { runs, note: s.note });
    m.indexes = indexesUsed(before, await indexScans());
    s.check?.(last.result);
    measurements.push(m);
    const q = slowestRead(last.queries);
    if (q) {
      const plan = await explain(q);
      plans.push({ name: s.name, rls: Boolean(q.userId), sql: oneLine(q.sql, 4000), summary: planSummary(plan), plan });
    }
  }
  // The statements the query fixes replaced, next to their replacements, timed in this same phase.
  const pairs = await runPairs(ws, c.people.owner.id, BOARD_CARDS_PER_STAGE);
  for (const p of pairs) if (p.name !== "board cards (default pipeline)") expect(p.sameResult, p.name).toBe(true);
  const counts = await datasetCounts(ws.orgId);
  const report: PerfReport = { label: PERF_LABEL, phase, startedAt: new Date().toISOString(), dataset: { scale: FACTOR, ...counts }, seedMs, measurements, plans, extra: { pairs, rlsStats } };
  writeReport(report);
  reports.push(report);
  return report;
}

describe.skipIf(!RUN)(`Native CRM at realistic scale (${PERF_LABEL})`, () => {
  beforeAll(async () => {
    const t0 = performance.now();
    c = await crmOrg({ name: "Perf Target Realty", timezone: TZ });
    ws = await seedWorkspace(c, scaled(TARGET, FACTOR), { n: 1, label: "target" });
    for (const [k, v] of Object.entries(ws.timings)) seedMs[`target:${k}`] = v;
    for (const n of [2, 3]) {
      const noise = await crmOrg({ name: `Perf Noise ${n}`, timezone: TZ });
      other ??= noise;
      const seeded = await seedWorkspace(noise, scaled(NOISE, FACTOR), { n, label: `noise${n}` });
      seedMs[`noise${n}`] = Object.values(seeded.timings).reduce((a, b) => a + b, 0);
    }
    const ta = performance.now();
    await analyzeAll();
    seedMs.analyze = performance.now() - ta;
    seedMs.total = performance.now() - t0;
  }, LONG);

  afterAll(() => {
    if (reports.length < 2) return;
    const first = reports[0];
    const lines = first.measurements.map((m) => `${m.group} | ${m.name} | ${reports.map((r) => r.measurements.find((x) => x.name === m.name)?.medianMs ?? "?").join(" -> ")} ms`);
    console.log(`Phase comparison (${PERF_LABEL}): ${reports.map((r) => r.phase).join(" -> ")}\n${lines.join("\n")}`);
  });

  it("measures the directory, Smart Lists, the board, slots, reports and the inbox", async () => {
    const counts = await datasetCounts(ws.orgId);
    expect(counts["contacts (workspace)"]).toBe(scaled(TARGET, FACTOR).contacts);
    // Same data, same code; only the indexes and (last) the policies change between measurements. The database starts with every
    // migration applied, so the default sequence first rolls 0050 back to measure the policies as they were before it.
    const has0038 = existsSync(MIGRATION) && existsSync(ROLLBACK);
    const has0050 = existsSync(RLS_MIGRATION) && existsSync(RLS_ROLLBACK);
    const state = { rls: (await rlsApplied()) ? "rls-0050" : "current-rls", idx: has0038 ? "with-0038" : "no-0038" };
    const steps = (process.env.CRM_PERF_STEPS ?? `drop-0050,drop-0038,measure,add-0038,measure${process.env.CRM_PERF_PROPOSAL === "0" ? "" : ",add-0050,measure"}`).split(",");
    for (const step of steps) {
      if (step === "drop-0038" && has0038) {
        await runFile(ROLLBACK);
        state.idx = "without-0038";
      } else if (step === "add-0038" && has0038) {
        await runFile(MIGRATION);
        state.idx = "with-0038";
      } else if (step === "drop-0050" && has0050 && (await rlsApplied())) {
        await runFile(RLS_ROLLBACK);
        state.rls = "current-rls";
      } else if ((step === "add-0050" || step === "proposed-rls") && has0050 && !(await rlsApplied())) {
        await runFile(RLS_MIGRATION);
        state.rls = "rls-0050";
        const { rows } = await withSystem((db) =>
          db.query<{ rewritten: number; per_row_left: number }>(
            `select count(*) filter (where qual ~ 'app\\.(permitted_orgs|accessible_orgs)\\(')::int as rewritten,
                    count(*) filter (where qual ~ 'app\\.(has_permission|can_view_conversation|can_access_org)\\(')::int as per_row_left
             from pg_policies where schemaname = 'public' and cmd = 'SELECT'`,
          ),
        );
        console.log(`0050: ${rows[0].rewritten} SELECT policies use the statement-level helpers; ${rows[0].per_row_left} still call a per-row permission function`);
        rlsStats = rows[0];
      } else if (step === "measure") {
        await runPhase(`${LABEL}${state.rls}-${state.idx}`, state.rls === "rls-0050" ? RUNS_PROPOSED : RUNS);
      }
    }
    // Every phase must have returned exactly the same thing for every compared call.
    const base = reports[0];
    for (const r of reports.slice(1)) {
      const differs = r.measurements.filter((m) => !NOT_COMPARED.has(m.name) && base.measurements.find((b) => b.name === m.name)?.fingerprint !== m.fingerprint).map((m) => m.name);
      expect(differs, `${base.phase} vs ${r.phase}`).toEqual([]);
    }
  }, LONG);
});
