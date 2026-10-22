import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { CRM_EVENT_COLUMNS, toCrmEventRow, type CrmEventDbRow, type CrmEventRow } from "@/server/crm/events";
import { startRunsForEvent } from "@/server/crm/workflows/triggers";
import { autoAssignForEvent } from "@/server/crm/assignment";
import { followUpsOnEvent } from "@/server/messaging/followups";
import { enqueueWebhookDeliveries } from "@/server/crm/webhooks";
import { switchingSql } from "@/server/crm/provider-guard";
import { missedCallsOnEvent } from "@/server/missed-calls/subscriber";
import { leadScoringOnEvent } from "@/server/lead-scoring/subscriber";

/**
 * The CRM event dispatcher (tick job "crmEventDispatch"): hands every event in the transactional outbox (crm_events) to its subscribers,
 * once, in a fixed order.
 *
 *  1. Workflows: starts a run of each active workflow whose trigger matches (one run per workflow and event, enforced by the database).
 *     Each workflow is checked on its own savepoint, so one whose trigger filter stopped working is skipped (and reported) alone.
 *  2. Lead assignment: routes a new contact or deal through the workspace's assignment rules.
 *  3. Follow-ups: a booking or a withdrawn consent stops the contact's follow-up sequence.
 *  4. Outbound webhooks: queues a delivery for each subscription that asked for this event type.
 *  5. Missed-call recovery: wakes an open case for the contact when something happened that could settle or stop it.
 *  6. Lead scoring: asks for a new look at the contact's priority when something that could change it happened.
 *
 * Claiming: a batch is claimed with `for update skip locked` (dispatch_claimed_at, dispatch_attempts + 1), so two ticks never take the same
 * event; a claim older than five minutes counts as abandoned and is taken over. Each event is processed in its own transaction, and each
 * subscriber inside its own savepoint: one failing subscriber is recorded (dispatch_error) without undoing the others, and the event is
 * tried again on a later tick. Every subscriber is idempotent, so a repeat changes nothing that already happened. After five attempts the
 * event is dead-lettered: marked dispatched with the error kept, so it never blocks the outbox.
 *
 * While a workspace is switching CRM providers (crm_workspaces.switching), its events are not claimed at all: they wait in the outbox with
 * no attempt counted, and are dispatched once each after the switch (src/server/crm/provider-switch.ts). A claim made just before a cutover
 * is checked again when its event is handled, under a key-share lock on the workspace row (the cutover and rollback lock that row for update
 * first, so neither can commit while an event is being handled): an event of a workspace that started switching is handed back unhandled,
 * with no attempt counted. Events a GoHighLevel migration wrote are already marked dispatched, so they never run here.
 */

export const DISPATCH_MAX_ATTEMPTS = 5;
const CLAIM_STALE_SECONDS = 5 * 60;

export type Subscriber = { name: string; run: (db: Queryable, event: CrmEventRow, now: Date) => Promise<unknown> };

/** The subscribers, in the order they run. Exported for tests. */
export const SUBSCRIBERS: readonly Subscriber[] = [
  { name: "workflows", run: (db, e, now) => startRunsForEvent(db, e, now) },
  { name: "assignment", run: (db, e, now) => autoAssignForEvent(db, e, { now }) },
  { name: "followups", run: (db, e) => followUpsOnEvent(db, e) },
  { name: "webhooks", run: (db, e) => enqueueWebhookDeliveries(db, e) },
  // Wakes an open missed-call case when something happened to its contact that could settle or stop it (the worker re-reads the facts).
  { name: "missedCalls", run: (db, e, now) => missedCallsOnEvent(db, e, now) },
  // Asks for a new look at the contact's priority (debounced into one queue row); the scheduler's scoring job does the assessing.
  { name: "leadScoring", run: (db, e, now) => leadScoringOnEvent(db, e, now) },
];

export interface DispatchResult {
  claimed: number;
  dispatched: number;
  /** Events that will be tried again (a subscriber failed). */
  retrying: number;
  /** Events given up after the last attempt. */
  dead: number;
}

const short = (err: unknown) => {
  if (err instanceof AppError) return err.message;
  const code = (err as { code?: unknown })?.code;
  return `${err instanceof Error ? err.name : "Error"}${typeof code === "string" ? ` ${code}` : ""}`;
};

async function claim(now: Date, limit: number): Promise<Array<{ id: number; token: string; attempts: number }>> {
  return withSystem(async (db) => {
    // Events abandoned on their last attempt (a worker stopped mid-way) can't be claimed again: dead-letter them here.
    await db.query(
      `update crm_events set dispatched_at = $1, dispatch_claimed_at = null,
         dispatch_error = left('Gave up after ' || dispatch_attempts || ' attempts: ' || coalesce(dispatch_error, 'the dispatcher stopped while handling it.'), 300)
       where id in (select id from crm_events where dispatched_at is null and dispatch_attempts >= $2
         and (dispatch_claimed_at is null or dispatch_claimed_at < $1::timestamptz - make_interval(secs => $3)) order by id limit 100 for update skip locked)`,
      [now.toISOString(), DISPATCH_MAX_ATTEMPTS, CLAIM_STALE_SECONDS],
    );
    const { rows } = await db.query<{ id: string; dispatch_attempts: number; dispatch_claimed_at: Date }>(
      `update crm_events set dispatch_claimed_at = $1, dispatch_attempts = dispatch_attempts + 1
       where id in (select id from crm_events where dispatched_at is null and dispatch_attempts < $2
         and (dispatch_claimed_at is null or dispatch_claimed_at < $1::timestamptz - make_interval(secs => $3))
         and not ${switchingSql("crm_events.org_id")}
         order by id limit $4 for update skip locked)
       returning id, dispatch_attempts, dispatch_claimed_at`,
      [now.toISOString(), DISPATCH_MAX_ATTEMPTS, CLAIM_STALE_SECONDS, limit],
    );
    return rows.map((r) => ({ id: Number(r.id), token: new Date(r.dispatch_claimed_at).toISOString(), attempts: r.dispatch_attempts })).sort((a, b) => a.id - b.id);
  });
}

/** Runs every subscriber for one claimed event, in one transaction. Returns how the event ended. */
async function dispatchOne(c: { id: number; token: string; attempts: number }, now: Date, subscribers: readonly Subscriber[]): Promise<"dispatched" | "retrying" | "dead" | "lost" | "held"> {
  return withSystem(async (db) => {
    const { rows } = await db.query<CrmEventDbRow & { dispatch_claimed_at: Date | null }>(
      `select ${CRM_EVENT_COLUMNS}, dispatch_claimed_at from crm_events where id = $1 and dispatched_at is null for update`,
      [c.id],
    );
    const row = rows[0];
    // Taken over (the claim was stale and another tick claimed it) or already dispatched: leave it to its current owner.
    if (!row || !row.dispatch_claimed_at || new Date(row.dispatch_claimed_at).toISOString() !== c.token) return "lost";
    const event = toCrmEventRow(row);
    // Claimed just before the workspace started switching providers: hand it back unhandled (no attempt counted); it runs after the switch.
    const ws = await db.query<{ switching: boolean }>("select switching from crm_workspaces where org_id = $1 for key share", [event.orgId]);
    if (ws.rows[0]?.switching) {
      await db.query("update crm_events set dispatch_claimed_at = null, dispatch_attempts = greatest(0, dispatch_attempts - 1) where id = $1 and dispatch_claimed_at = $2", [c.id, c.token]);
      return "held";
    }
    const failures: string[] = [];
    for (const s of subscribers) {
      await db.query("savepoint crm_dispatch_subscriber");
      try {
        await s.run(db, event, now);
        await db.query("release savepoint crm_dispatch_subscriber");
      } catch (err) {
        await db.query("rollback to savepoint crm_dispatch_subscriber");
        failures.push(`${s.name}: ${short(err)}`);
        if (process.env.NODE_ENV !== "test") console.error("[iacquire] crm event subscriber failed", { subscriber: s.name, eventType: event.type, error: short(err) });
      }
    }
    if (!failures.length) {
      await db.query("update crm_events set dispatched_at = $2, dispatch_claimed_at = null, dispatch_error = null where id = $1", [c.id, now.toISOString()]);
      return "dispatched";
    }
    const error = failures.join("; ").slice(0, 300);
    if (c.attempts >= DISPATCH_MAX_ATTEMPTS) {
      await db.query("update crm_events set dispatched_at = $2, dispatch_claimed_at = null, dispatch_error = $3 where id = $1", [c.id, now.toISOString(), `Gave up after ${c.attempts} attempts: ${error}`.slice(0, 300)]);
      return "dead";
    }
    // The claim time stays, so the event is due again once the claim goes stale (five minutes): a simple backoff.
    await db.query("update crm_events set dispatch_error = $2 where id = $1", [c.id, error]);
    return "retrying";
  });
}

/** Gives back claims a tick had no time left for, without counting them as attempts. */
async function release(claims: Array<{ id: number; token: string }>) {
  if (!claims.length) return;
  await withSystem((db) =>
    db.query(
      `update crm_events e set dispatch_claimed_at = null, dispatch_attempts = greatest(0, dispatch_attempts - 1)
       from unnest($1::bigint[], $2::timestamptz[]) as c(id, token) where e.id = c.id and e.dispatch_claimed_at = c.token and e.dispatched_at is null`,
      [claims.map((c) => c.id), claims.map((c) => c.token)],
    ),
  );
}

/** The tick job. Small batches; it stops taking events when its share of the tick's time is used. */
export async function crmEventDispatch(opts: { limit?: number; now?: Date; budgetMs?: number; subscribers?: readonly Subscriber[] } = {}): Promise<DispatchResult> {
  const started = Date.now();
  const budget = opts.budgetMs ?? 20_000;
  const clock = () => opts.now ?? new Date();
  const out: DispatchResult = { claimed: 0, dispatched: 0, retrying: 0, dead: 0 };
  const claims = await claim(clock(), Math.max(1, Math.min(500, opts.limit ?? 200)));
  out.claimed = claims.length;
  for (let i = 0; i < claims.length; i++) {
    if (Date.now() - started > budget) {
      await release(claims.slice(i));
      break;
    }
    const r = await dispatchOne(claims[i], clock(), opts.subscribers ?? SUBSCRIBERS);
    if (r === "dispatched") out.dispatched += 1;
    else if (r === "retrying") out.retrying += 1;
    else if (r === "dead") out.dead += 1;
  }
  return out;
}
