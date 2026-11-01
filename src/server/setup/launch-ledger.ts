import "server-only";
import { after } from "next/server";
import { withSystem, readSystem, NestedTransactionError, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { deriveLaunchReadiness, fingerprintOf, type LaunchReadiness, type LaunchState } from "@/lib/launch-readiness";
import { launchStallAlertKey, launchStallMinutes, loadLaunchFactsForOrg } from "@/server/setup/launch-readiness";

// The launch ledger: what remembers that a client's launch state moved. The panel derives its answer from the workspace's own rows on every read, which is honest but forgetful: it
// cannot say "blocked since Tuesday" or "reached 100% on the 3rd", and nobody is told when it changes. This writes ONE audit row (action setup.launch_state_changed) when, and only
// when, what matters about the readiness really changed, and tells the workspace's owners about the moments that are theirs: the first time something needs them, the moment
// everything is ready, and a step back from ready. It runs after something happened (an intent, the sweep, a payment clearing, evidence arriving) and NEVER on a page read: reading the
// panel stays free of writes.
//
// Safe to repeat and to run twice at once: an advisory lock per workspace serialises the compare-and-write, and an unchanged fingerprint writes nothing. The facts are read BEFORE the
// lock (reading them takes many transactions of their own, which cannot run inside the lock's), so a call also remembers the newest row it saw when it began, and under the lock it
// writes only if no other call wrote since: otherwise what it read may be older than that row, and it reads again instead of writing a stale state over a newer one. Every query names the workspace,
// and the notices go to that workspace's own members (or to the agency users whose scope includes it) and to nobody else. A workspace that is not a client's, and a sample workspace,
// are never recorded.

export const LAUNCH_LEDGER_ACTION = "setup.launch_state_changed";

export type LaunchActor = { kind: "user"; userId: string } | { kind: "system" };

export interface LaunchLedgerResult {
  /** A row was written by this call. False: nothing that matters had changed, or there was nothing to record yet. */
  recorded: boolean;
  state: LaunchState;
  percent: number;
  fingerprint: string;
}

/** The audit metadata of one ledger row (contract C7), with `items` kept beside it so the next row can say exactly what changed. */
export interface LaunchLedgerRow {
  from: LaunchState | null;
  to: LaunchState;
  percent: number;
  passed: number;
  total: number;
  fingerprint: string;
  needsYou: number;
  needsIacquire: number;
  topBlocker: { key: string; label: string; owner: string } | null;
  changed: Array<{ key: string; state: string; owner: string }>;
  items: Record<string, string>;
}

const MAX_CHANGED = 20;

/** The required, applicable items as "state/owner" by key: the part of a readiness the ledger compares. */
function itemStates(r: LaunchReadiness): Record<string, { state: string; owner: string }> {
  const out: Record<string, { state: string; owner: string }> = {};
  for (const i of r.steps.flatMap((s) => s.items)) if (i.required && i.state !== "not_applicable") out[i.key] = { state: i.state, owner: i.owner };
  return out;
}

function parseItems(raw: unknown): Record<string, { state: string; owner: string }> {
  const out: Record<string, { state: string; owner: string }> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const [state, owner] = value.split("/");
    if (state && owner) out[key] = { state, owner };
  }
  return out;
}

const isState = (v: unknown): v is LaunchState => typeof v === "string" && ["not_started", "questionnaire_submitted", "provisioning", "action_required", "ready_for_review", "ready_to_launch"].includes(v);

interface PriorRow {
  to: LaunchState;
  fingerprint: string;
  items: Record<string, { state: string; owner: string }>;
}

/** The newest ledger row of a workspace, read inside the lock. Ordered by the row's own sequence, which the lock makes the order they were written in. `id` is that row's sequence number. */
async function latestRow(db: Queryable, orgId: string): Promise<{ id: string | null; prior: PriorRow | null; count: number }> {
  const { rows } = await db.query<{ id: string; metadata: Record<string, unknown>; n: string }>(
    `select id::text as id, metadata, (select count(*) from audit_logs where org_id = $1 and action = $2) as n
       from audit_logs where org_id = $1 and action = $2 order by id desc limit 1`,
    [orgId, LAUNCH_LEDGER_ACTION],
  );
  const id = rows[0]?.id ?? null;
  const m = rows[0]?.metadata;
  if (!m || !isState(m.to) || typeof m.fingerprint !== "string") return { id, prior: null, count: 0 };
  return { id, prior: { to: m.to, fingerprint: m.fingerprint, items: parseItems(m.items) }, count: Number(rows[0].n) };
}

/** The sequence number of the newest ledger row of a workspace, or null when it has none: what a call saw before it began to read the facts. */
async function newestRowId(orgId: string): Promise<string | null> {
  const { rows } = await readSystem((db) => db.query<{ id: string | null }>("select max(id)::text as id from audit_logs where org_id = $1 and action = $2", [orgId, LAUNCH_LEDGER_ACTION]));
  return rows[0]?.id ?? null;
}

/** How many times a call reads the facts again after finding that another call wrote while it was reading. Past that, the other calls' rows are the fresher ones and this one stands down. */
const MAX_DERIVATIONS = 3;

function rowFor(readiness: LaunchReadiness, fingerprint: string, prior: PriorRow | null): LaunchLedgerRow {
  const now = itemStates(readiness);
  const before = prior?.items ?? {};
  const changed = Object.keys({ ...before, ...now })
    .filter((key) => before[key]?.state !== now[key]?.state || before[key]?.owner !== now[key]?.owner)
    .map((key) => ({ key, state: now[key]?.state ?? "not_applicable", owner: (now[key] ?? before[key]).owner }))
    // What still needs somebody first: a long list is cut, and the part that is cut should be the part that is done.
    .sort((a, b) => Number(a.state === "done") - Number(b.state === "done"))
    .slice(0, MAX_CHANGED);
  const top = readiness.blocking[0] ?? null;
  return {
    from: prior?.to ?? null, to: readiness.state, percent: readiness.percent, passed: readiness.passed, total: readiness.total, fingerprint,
    needsYou: readiness.blocking.filter((i) => i.owner === "you").length,
    needsIacquire: readiness.blocking.filter((i) => i.owner !== "you").length,
    topBlocker: top ? { key: top.key, label: top.label, owner: top.owner } : null,
    changed,
    items: Object.fromEntries(Object.entries(now).map(([key, v]) => [key, `${v.state}/${v.owner}`])),
  };
}

/**
 * Tells the workspace's owners about the moments that are theirs, once per moment: the first time something needs them (once, ever), the moment everything is ready (once per time
 * it gets there), and a step back from ready (once per time). A regression takes the place of a first-action notice, so one change never sends two. `count` is the number of rows
 * written before this one, which names this transition: a repeat of the same call cannot repeat the notice.
 */
async function notifyOwners(db: Queryable, orgId: string, row: LaunchLedgerRow, count: number): Promise<void> {
  const n = count + 1;
  if (row.to === "ready_to_launch" && row.from !== "ready_to_launch") {
    await notifyOrgRoles(db, orgId, ["owner"], {
      kind: "setup_ready", severity: "success", title: "Your setup is 100% ready to launch",
      body: "Every applicable setup and verification check has passed. Nothing customer-facing is switched on until you turn it on.",
      link: "/setup", dedupeKey: `launch-ready:${orgId}:${n}`,
    });
    return;
  }
  if (row.from === "ready_to_launch" && row.to !== "ready_to_launch") {
    await notifyOrgRoles(db, orgId, ["owner"], {
      kind: "setup_issue", severity: "warning", title: "Something in your launch setup needs another look",
      body: row.topBlocker ? `${row.topBlocker.label} is no longer ready. Open Setup to see what changed.` : "A check that had passed no longer does. Open Setup to see what changed.",
      link: "/setup", dedupeKey: `launch-regressed:${orgId}:${n}`,
    });
    return;
  }
  if (row.to === "action_required" && row.needsYou > 0) {
    await notifyOrgRoles(db, orgId, ["owner"], {
      kind: "setup_action_required", severity: "info", title: "Your launch setup needs something from you",
      body: row.topBlocker ? `${row.topBlocker.label}: open Setup to see what to do next.` : "Open Setup to see what to do next.",
      link: "/setup", dedupeKey: `launch-action-required:${orgId}`,
    });
  }
}

/**
 * Records the workspace's launch state if it changed, and tells iAcquire about a wait that has gone on too long. Returns null for a workspace that is not a client's, a sample
 * workspace, and a workspace that does not exist: nothing is written for those. `opts.now` is for tests and for a caller that already read the clock.
 */
export async function recordLaunchSnapshot(orgId: string, actor: LaunchActor, opts: { now?: Date } = {}): Promise<LaunchLedgerResult | null> {
  const org = (await withSystem((db) => db.query<{ kind: string; is_demo: boolean; name: string }>("select kind, is_demo, name from organizations where id = $1", [orgId]))).rows[0];
  if (!org || org.kind !== "client" || org.is_demo) return null;

  let latest: LaunchLedgerResult | null = null;
  for (let attempt = 0; attempt < MAX_DERIVATIONS; attempt += 1) {
    // What the ledger held when this read began: if it holds something else under the lock, another call wrote in between and these facts may be older than its row.
    const seen = await newestRowId(orgId);
    const facts = await loadLaunchFactsForOrg(orgId);
    if (!facts) return null;
    const readiness = deriveLaunchReadiness(facts, opts.now ?? new Date(), launchStallMinutes());
    const fingerprint = fingerprintOf(readiness);
    const result: LaunchLedgerResult = { recorded: false, state: readiness.state, percent: readiness.percent, fingerprint };
    latest = result;

    const written = await withSystem(async (db): Promise<LaunchLedgerResult | "raced"> => {
      // One writer at a time per workspace: the comparison and the insert are never apart, so two calls at once make one row.
      await db.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`launch-ledger:${orgId}`]);
      const { id, prior, count } = await latestRow(db, orgId);
      if (id !== seen) return "raced";
      // A long wait is told to the agency once per wait, whether or not the row below is needed: the notice's key names the item and when its wait began.
      for (const i of readiness.steps.flatMap((s) => s.items)) {
        if (!i.stalled || !i.stalledSince) continue;
        await notifyAgency(db, orgId, {
          kind: "setup_issue", severity: "warning", title: `${org.name}: ${i.label} is taking longer than expected`,
          body: "It has been waiting longer than it should. Open the client's page to review it. Nothing was changed.",
          link: `/admin/clients/${orgId}`, dedupeKey: launchStallAlertKey(orgId, i.key, i.stalledSince),
        });
      }
      const unchanged = prior?.fingerprint === fingerprint;
      // A client that has not started has nothing to remember yet.
      if (unchanged || (!prior && readiness.state === "not_started")) return result;
      const row = rowFor(readiness, fingerprint, prior);
      await recordAudit({
        orgId, actorUserId: actor.kind === "user" ? actor.userId : null, actorKind: actor.kind, action: LAUNCH_LEDGER_ACTION, targetType: "organization", targetId: orgId, result: "success",
        metadata: { ...row },
      }, db);
      await notifyOwners(db, orgId, row, count);
      return { ...result, recorded: true };
    });
    if (written !== "raced") return written;
  }
  // Every read raced another call's write: those rows are newer than anything this call read, so none of it is written from here.
  return latest;
}

/** The same, as an event hook: it never fails the action that called it. */
export async function recordLaunchSnapshotAfter(orgId: string, actor: LaunchActor, after: string): Promise<void> {
  try {
    await recordLaunchSnapshot(orgId, actor);
  } catch (err) {
    console.warn(`[iacquire] launch ledger after ${after} failed; the next event will record it.`, { error: err instanceof Error ? err.name : "unknown" });
  }
}

// ---------------------------------------------------------------------------
// After a payment: from inside a transaction, after it commits
// ---------------------------------------------------------------------------

const pending = new Set<Promise<void>>();
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Waits until the transaction this was called from has committed: the ledger must see the committed clearing, and a transaction may not be opened inside another one. */
async function untilOutsideTransaction(): Promise<boolean> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try {
      await withSystem(async () => undefined);
      return true;
    } catch (err) {
      if (!(err instanceof NestedTransactionError)) throw err;
      await pause(25);
    }
  }
  return false;
}

/**
 * Records the launch state after the response, for a trigger that fires inside a transaction (the setup fee clearing). Registered with Next's `after()` like the work runner;
 * outside a request (unit tests, scripts) a development run starts directly. It never throws and writes nothing when the state did not change.
 */
export function scheduleLaunchSnapshot(orgId: string, trigger: string): void {
  const execute = async () => {
    try {
      if (await untilOutsideTransaction()) await recordLaunchSnapshot(orgId, { kind: "system" });
    } catch (err) {
      console.warn(`[iacquire] launch ledger after ${trigger} failed.`, { error: err instanceof Error ? err.name : "unknown" });
    }
  };
  const track = () => {
    const run: Promise<void> = execute().finally(() => {
      pending.delete(run);
    });
    pending.add(run);
    return run;
  };
  try {
    after(track);
  } catch (err) {
    if (process.env.NODE_ENV !== "production") {
      void track();
      return;
    }
    console.warn(`[iacquire] could not schedule the launch ledger after ${trigger}: ${err instanceof Error ? err.name : "unknown"}`);
  }
}

/** Waits for every ledger run this process has scheduled. Tests and orderly shutdown only. */
export async function settleLaunchSnapshots(): Promise<void> {
  await Promise.allSettled([...pending]);
}

// ---------------------------------------------------------------------------
// For a list of clients
// ---------------------------------------------------------------------------

export interface LaunchCurrent {
  orgId: string;
  state: LaunchState;
  percent: number;
  passed: number;
  total: number;
  needsYou: number;
  needsIacquire: number;
  topBlocker: { key: string; label: string; owner: string } | null;
  /** When the workspace entered this state (ISO). */
  since: string;
  /** When the newest row was written (ISO). */
  updatedAt: string;
}

/**
 * The newest recorded launch state of each workspace, for the agency's list of clients: one cheap read of the ledger, no per-client fact loading (that would run calendar checks for
 * every client on every page load). A workspace with no row is simply absent. Trusted code: the caller has already limited `orgIds` to the clients the agency user may see, and
 * nothing here widens it.
 */
export async function readLaunchCurrent(orgIds: readonly string[]): Promise<Map<string, LaunchCurrent>> {
  const ids = [...new Set(orgIds)].slice(0, 500);
  const out = new Map<string, LaunchCurrent>();
  if (!ids.length) return out;
  const { rows } = await withSystem((db) => db.query<{ org_id: string; metadata: Record<string, unknown>; updated_at: Date | string; since: Date | string | null }>(
    `with ranked as (
       select org_id, id, created_at, metadata, metadata ->> 'to' as to_state,
              lag(metadata ->> 'to') over (partition by org_id order by id) as prev_state
         from audit_logs where org_id = any($1::uuid[]) and action = $2
     ), latest as (
       select distinct on (org_id) org_id, metadata, created_at from ranked order by org_id, id desc
     )
     select l.org_id, l.metadata, l.created_at as updated_at,
            (select max(r.created_at) from ranked r where r.org_id = l.org_id and r.prev_state is distinct from r.to_state) as since
       from latest l`,
    [ids, LAUNCH_LEDGER_ACTION],
  ));
  for (const r of rows) {
    const m = r.metadata;
    if (!isState(m.to)) continue;
    const top = m.topBlocker && typeof m.topBlocker === "object" ? (m.topBlocker as Record<string, unknown>) : null;
    out.set(r.org_id, {
      orgId: r.org_id, state: m.to, percent: Number(m.percent) || 0, passed: Number(m.passed) || 0, total: Number(m.total) || 0,
      needsYou: Number(m.needsYou) || 0, needsIacquire: Number(m.needsIacquire) || 0,
      topBlocker: top && typeof top.key === "string" && typeof top.label === "string" && typeof top.owner === "string" ? { key: top.key, label: top.label, owner: top.owner } : null,
      since: new Date(r.since ?? r.updated_at).toISOString(), updatedAt: new Date(r.updated_at).toISOString(),
    });
  }
  return out;
}
