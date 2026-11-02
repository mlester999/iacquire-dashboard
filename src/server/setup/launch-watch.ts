import "server-only";
import { withSystem } from "@/server/db";
import { reverifyCalendarsAfterChange } from "@/server/calendars/reverify";
import { sweepLaunchVerification } from "@/server/setup/launch-sweep";
import { readLaunchCurrent, recordLaunchSnapshot, type LaunchCurrent } from "@/server/setup/launch-ledger";

// The launch watch: what notices a launch that went quiet. Everything else that records a client's launch state runs after something happened (a button, a payment, a finished
// check). Time passing is not an event: a profile job that never finishes, a check that never starts, or a calendar whose Google sign-in broke on the provider's side change nothing
// anywhere, so without a clock nobody would ever be told. Every pass, for each client that has submitted its questionnaire, paid (or been waived) and is active, this
//   1. re-runs the calendar checks (read-only) so a provider-side break that no write path saw is recorded, once, when it appears and again when it clears,
//   2. starts the final check of any employee that is ready and has none for its current configuration (the same sweep an event runs; nothing starts twice), and
//   3. records the launch state in the ledger, which writes a row only when something changed, tells the client's owners about the moments that are theirs, and tells iAcquire ONCE
//      about each wait that went on too long (the notice is keyed by the item and when its wait began, so a repeat pass sends nothing). A client that has no ledger row yet (one
//      that was live before this watch existed) gets its first row as a silent baseline: the owners are told about what changes from there, not about a flow they never started.
// It sends nothing to a customer, changes no configuration, switches nothing on and never retries a check that failed. A sample workspace, the agency's own workspace, a suspended
// workspace and a client that has not paid are never examined, and every query and notice names one workspace, so one client's stall never reaches another.
//
// A client already at 100% is still looked at (that is how a step back from ready is noticed without anybody editing anything), after every client that is not. When there are more
// clients than one pass can look at, the order rotates with the clock, so every client is reached.

/** The most one pass spends: the tick is cut off at 120 seconds and the jobs after it wait. */
export const LAUNCH_WATCH_BUDGET_MS = 45_000;
/** The most clients one pass examines. */
export const LAUNCH_WATCH_MAX_CLIENTS = 200;
const ROTATE_MINUTES = 10;

export interface LaunchWatchResult {
  /** Clients examined this pass. */
  examined: number;
  /** Final checks this pass started. */
  checksQueued: number;
  /** Ledger rows this pass wrote (a changed state). */
  recorded: number;
  /** Clients that were at 100% and are not now. */
  regressions: number;
  /** Calendars whose checks started failing, or that were failing and pass again, since the last pass. */
  calendarChanges: number;
  /** Clients where a step failed (the rest of the pass went on; the next pass tries again). */
  failed: number;
  /** The pass stopped early (its time or its client limit) with clients left for the next one. */
  cutOff: boolean;
}

const READY = "ready_to_launch";

/** The ids of the clients worth looking at, in the order to look. A client that has never been recorded counts as not ready. */
async function clientsToWatch(now: Date): Promise<{ ids: string[]; current: Map<string, LaunchCurrent> }> {
  // "Has paid" is the one payment gate (setup fee paid or waived with a reason), not a date the billing record carries: a refunded client keeps its paid date but is no longer cleared.
  const bucket = String(Math.floor(now.getTime() / (ROTATE_MINUTES * 60_000)));
  const { rows } = await withSystem((db) => db.query<{ id: string }>(
    `select o.id from organizations o
      where o.kind = 'client' and not o.is_demo and o.status = 'active' and o.onboarding_completed_at is not null
        and app.setup_payment_cleared(o.id)
      order by md5(o.id::text || $1), o.id`,
    [bucket],
  ));
  const all = rows.map((r) => r.id);
  const current = new Map<string, LaunchCurrent>();
  for (let i = 0; i < all.length; i += 500) for (const [id, row] of await readLaunchCurrent(all.slice(i, i + 500))) current.set(id, row);
  const notReady = all.filter((id) => current.get(id)?.state !== READY);
  const ready = all.filter((id) => current.get(id)?.state === READY);
  return { ids: [...notReady, ...ready], current };
}

/** One step of a client's pass. A failure is counted and logged without details (which could name records); the pass goes on with the next step and the next client. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false }> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    console.warn(`[iacquire] launch watch: ${name} failed; the next pass tries again.`, { error: err instanceof Error ? err.name : "unknown" });
    return { ok: false };
  }
}

export async function runLaunchWatch(opts: { now?: Date; budgetMs?: number; maxClients?: number } = {}): Promise<LaunchWatchResult> {
  const now = opts.now ?? new Date();
  const started = Date.now();
  const budgetMs = opts.budgetMs ?? LAUNCH_WATCH_BUDGET_MS;
  const limit = opts.maxClients ?? LAUNCH_WATCH_MAX_CLIENTS;
  const result: LaunchWatchResult = { examined: 0, checksQueued: 0, recorded: 0, regressions: 0, calendarChanges: 0, failed: 0, cutOff: false };
  const { ids, current } = await clientsToWatch(now);

  for (const orgId of ids) {
    if (result.examined >= limit || Date.now() - started > budgetMs) {
      result.cutOff = true;
      break;
    }
    result.examined += 1;
    let failed = false;

    // The calendar checks first, so the snapshot below reads a calendar whose change has already been recorded and told.
    const calendars = await step("calendar re-check", () => withSystem((db) => reverifyCalendarsAfterChange(db, orgId, "watch", { now })));
    if (calendars.ok) result.calendarChanges += calendars.value.drifted.length + calendars.value.recovered.length;
    else failed = true;

    const swept = await step("final check sweep", () => sweepLaunchVerification(orgId));
    if (swept.ok) result.checksQueued += swept.value.queued.length;
    else failed = true;

    const snapshot = await step("launch ledger", () => recordLaunchSnapshot(orgId, { kind: "system" }, { now, baseline: true }));
    if (snapshot.ok) {
      if (snapshot.value?.recorded) result.recorded += 1;
      if (snapshot.value && snapshot.value.state !== READY && current.get(orgId)?.state === READY) result.regressions += 1;
    } else failed = true;

    if (failed) result.failed += 1;
  }
  return result;
}
