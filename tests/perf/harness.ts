// Measurement helpers for the CRM performance suite (tests/perf). Every number they produce comes from the embedded PGlite database
// running in memory inside the test process: indicative only, never a production latency.
//
// `capture` records every statement a service call sends to the database, with its own timing and whether it ran under row-level security
// as a member (withUser) or as trusted code (withSystem). That gives the per-call query count (an N+1 shows up as a count that grows with
// the page size) and the slowest statements, which `explain` then runs again with EXPLAIN (ANALYZE, BUFFERS) in the same security context.
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withSystem, type Queryable, type QueryResult } from "@/server/db";

export const PERF_LABEL = "PGlite in-memory, indicative only";

export interface CapturedQuery {
  sql: string;
  params: unknown[];
  ms: number;
  rows: number;
  /** The member whose row-level security applied, or null for trusted (system) code. */
  userId: string | null;
}

type DriverLike = { transaction: <T>(fn: (tx: Queryable) => Promise<T>) => Promise<T> };

async function driverObject(): Promise<DriverLike> {
  await withSystem((db) => db.query("select 1"));
  const holder = (globalThis as unknown as { __iaqDb?: { promise?: Promise<DriverLike> } }).__iaqDb;
  if (!holder?.promise) throw new Error("The database driver is not initialised.");
  return holder.promise;
}

/** Session plumbing that withUser adds to every transaction; not part of what a service asks for. */
const PLUMBING = /^\s*(select set_config\('app\.user_id'|set local role)/i;

/** Runs `fn` and returns what it sent to the database. Not re-entrant: one capture at a time. */
export async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; queries: CapturedQuery[]; ms: number }> {
  const d = await driverObject();
  const original = d.transaction;
  const queries: CapturedQuery[] = [];
  d.transaction = <R>(inner: (tx: Queryable) => Promise<R>) =>
    original.call(d, (tx: Queryable) => {
      let userId: string | null = null;
      const wrapped: Queryable = {
        async query<Row>(sql: string, params?: unknown[]): Promise<QueryResult<Row>> {
          if (/set_config\('app\.user_id'/.test(sql)) userId = String(params?.[0] ?? "");
          const t = performance.now();
          const res = await tx.query<Row>(sql, params);
          if (!PLUMBING.test(sql)) queries.push({ sql, params: params ?? [], ms: performance.now() - t, rows: res.rows.length, userId });
          return res;
        },
      };
      return inner(wrapped);
    }) as Promise<R>;
  const t0 = performance.now();
  try {
    const result = await fn();
    return { result, queries, ms: performance.now() - t0 };
  } finally {
    d.transaction = original;
  }
}

/** EXPLAIN (ANALYZE, BUFFERS) of a captured read, in the security context it originally ran in (member under RLS, or system). */
export async function explain(q: Pick<CapturedQuery, "sql" | "params" | "userId">): Promise<string> {
  if (!/^\s*(select|with)\b/i.test(q.sql)) return "(not a read)";
  return withSystem(async (db) => {
    if (q.userId) {
      await db.query("select set_config('app.user_id', $1, true)", [q.userId]);
      await db.query("set local role iaq_app_user");
    }
    const { rows } = await db.query<{ "QUERY PLAN": string }>(`explain (analyze, buffers) ${q.sql}`, q.params);
    return rows.map((r) => r["QUERY PLAN"]).join("\n");
  });
}

/** The plan's headline: scan types used, and the planning/execution time lines. */
export function planSummary(plan: string): { scans: string[]; executionMs: number | null; planningMs: number | null } {
  const scans = [...new Set(plan.split("\n").map((l) => l.trim().replace(/^->\s*/, "")).filter((l) => /(Seq Scan|Index Scan|Index Only Scan|Bitmap Index Scan|Bitmap Heap Scan)/.test(l)).map((l) => l.replace(/\s+\(cost=.*$/, "")))];
  const num = (re: RegExp) => {
    const m = plan.match(re);
    return m ? Number(m[1]) : null;
  };
  return { scans, executionMs: num(/Execution Time: ([\d.]+) ms/), planningMs: num(/Planning Time: ([\d.]+) ms/) };
}

export interface Measurement {
  name: string;
  group: string;
  runs: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
  /** Statements one call sends (constant across page sizes when there is no N+1). */
  queries: number;
  /** Size of the result as JSON: roughly what a server component hands to the browser. */
  payloadBytes: number;
  /** Digest of the result, to prove two phases returned the same thing. Time-relative fields (daysInStage) are left out. */
  fingerprint: string;
  slowest: Array<{ ms: number; rows: number; rls: boolean; sql: string }>;
  /** Indexes the call's statements scanned (all of its calls together, from pg_stat_user_indexes), most scanned first. */
  indexes?: Array<{ name: string; scans: number }>;
  note?: string;
}

/**
 * Index scan counters for every public index (pg_stat_user_indexes, which PGlite keeps like PostgreSQL). Pending counters are flushed
 * first: pg_stat_force_next_flush makes the end of that transaction report them, and the next transaction reads them.
 */
export async function indexScans(): Promise<Map<string, number>> {
  await withSystem((db) => db.query("select pg_stat_force_next_flush()"));
  const { rows } = await withSystem((db) => db.query<{ name: string; scans: string }>("select indexrelname as name, idx_scan::text as scans from pg_stat_user_indexes where schemaname = 'public'"));
  return new Map(rows.map((r) => [r.name, Number(r.scans)]));
}

/** The indexes whose scan counter moved between two snapshots, most scanned first. */
export function indexesUsed(before: Map<string, number>, after: Map<string, number>): Array<{ name: string; scans: number }> {
  return [...after.entries()].map(([name, n]) => ({ name, scans: n - (before.get(name) ?? 0) })).filter((x) => x.scans > 0).sort((a, b) => b.scans - a.scans || a.name.localeCompare(b.name));
}

const round = (n: number) => Math.round(n * 10) / 10;
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const oneLine = (sql: string, max = 220) => sql.replace(/\s+/g, " ").trim().slice(0, max);

/** One warm-up call, then `runs` timed calls of the real service function. */
export async function measure<T>(group: string, name: string, fn: () => Promise<T>, opts: { runs?: number; note?: string } = {}): Promise<{ m: Measurement; last: { result: T; queries: CapturedQuery[] } }> {
  const runs = opts.runs ?? 5;
  await fn();
  const times: number[] = [];
  let last: { result: T; queries: CapturedQuery[]; ms: number } | null = null;
  for (let i = 0; i < runs; i++) {
    last = await capture(fn);
    times.push(last.ms);
  }
  const q = last!.queries;
  const json = JSON.stringify(last!.result ?? null) ?? "null";
  const m: Measurement = {
    name, group, runs, medianMs: round(median(times)), minMs: round(Math.min(...times)), maxMs: round(Math.max(...times)), queries: q.length,
    payloadBytes: Buffer.byteLength(json), fingerprint: fingerprint(last!.result),
    slowest: [...q].sort((a, b) => b.ms - a.ms).slice(0, 3).map((x) => ({ ms: round(x.ms), rows: x.rows, rls: Boolean(x.userId), sql: oneLine(x.sql) })),
    note: opts.note,
  };
  return { m, last: { result: last!.result, queries: q } };
}

/** A stable digest of a result, ignoring fields that depend on the clock (daysInStage, generatedAt) and ids of rows created per call. */
export function fingerprint(value: unknown): string {
  const json = JSON.stringify(value ?? null, (k, v) => (k === "daysInStage" || k === "generatedAt" ? undefined : v)) ?? "null";
  return createHash("sha1").update(json).digest("hex").slice(0, 12);
}

/** Splits a SQL script into statements, keeping `$$ ... $$` bodies whole (the driver runs one statement per call). */
export function sqlStatements(sql: string): string[] {
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
  if (cur.join("").trim()) out.push(cur.join("\n"));
  return out;
}

/** The slowest captured read of a call, for EXPLAIN. */
export const slowestRead = (queries: CapturedQuery[]) => [...queries].filter((q) => /^\s*(select|with)\b/i.test(q.sql)).sort((a, b) => b.ms - a.ms)[0];

export interface PerfReport {
  label: string;
  phase: string;
  startedAt: string;
  dataset: Record<string, number | string>;
  seedMs: Record<string, number>;
  measurements: Measurement[];
  plans: Array<{ name: string; rls: boolean; sql: string; summary: ReturnType<typeof planSummary>; plan: string }>;
  extra: Record<string, unknown>;
}

/** Writes the report under .data/perf (git-ignored) and prints a compact table. */
export function writeReport(report: PerfReport): string {
  const dir = path.resolve(process.cwd(), ".data", "perf");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `crm-scale-${report.phase}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  const lines = [
    `CRM performance (${report.label}), phase=${report.phase}`,
    `dataset: ${Object.entries(report.dataset).map(([k, v]) => `${k}=${v}`).join(", ")}`,
    `seed: ${Object.entries(report.seedMs).map(([k, v]) => `${k}=${Math.round(v)}ms`).join(", ")}`,
    "",
    "| group | measurement | median ms | min | max | queries | payload KB | slowest statement (ms, rows, rls) |",
    "|---|---|---:|---:|---:|---:|---:|---|",
    ...report.measurements.map((m) => `| ${m.group} | ${m.name} | ${m.medianMs} | ${m.minMs} | ${m.maxMs} | ${m.queries} | ${Math.round(m.payloadBytes / 102.4) / 10} | ${m.slowest[0] ? `${m.slowest[0].ms} ms, ${m.slowest[0].rows} rows, ${m.slowest[0].rls ? "rls" : "system"}: ${m.slowest[0].sql.slice(0, 90)}` : ""} |`),
    "",
    ...report.plans.map((p) => `plan ${p.name} [${p.rls ? "rls" : "system"}]: exec ${p.summary.executionMs} ms; ${p.summary.scans.join(" | ")}`),
    "",
    ...report.measurements.map((m) => `indexes ${m.name}: ${(m.indexes ?? []).map((i) => `${i.name}×${i.scans}`).join(", ") || "none"}`),
  ];
  console.log(lines.join("\n"));
  return file;
}
