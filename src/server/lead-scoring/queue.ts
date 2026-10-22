import "server-only";
import crypto from "node:crypto";
import { withSystem, type Queryable } from "@/server/db";
import { logSafeServerDiagnostic } from "@/server/diagnostics";
import { assessContact } from "@/server/lead-scoring/service";
import type { ExtractionDeps } from "@/server/lead-scoring/ai";

// The reassessment queue. New information about a contact asks for a new look; a burst of asks becomes one assessment after a short quiet period
// (the debounce), never later than an hour after the first ask. A worker leases a row, assesses, and deletes the row only if nothing newer was asked
// for meanwhile. Failures back off and give up after five tries, with the reason kept. A workspace has a daily ceiling on assessments so a data
// import or a runaway automation can't spend without limit.

const LEASE_MINUTES = 5;
const MAX_WAIT_MINUTES = 60;
const MAX_ATTEMPTS = 5;
/** Assessments one workspace can have in a day (UTC). A rule-only assessment is cheap, but the cost is bounded all the same. */
export const DAILY_ASSESSMENT_CEILING = 5000;

/** Asks for a new look at a contact. Safe to call from anywhere, any number of times: it adds one row or moves the one that exists. */
export async function requestReassessment(db: Queryable, orgId: string, contactId: string, trigger: string, opts: { now?: Date; debounceMinutes?: number } = {}): Promise<void> {
  const now = opts.now ?? new Date();
  const debounce = opts.debounceMinutes ?? (await db.query<{ d: number }>("select debounce_minutes as d from lead_scoring_profiles where org_id = $1", [orgId])).rows[0]?.d ?? 10;
  const enabled = await db.query<{ enabled: boolean }>("select enabled from lead_scoring_profiles where org_id = $1", [orgId]);
  if (enabled.rows[0] && !enabled.rows[0].enabled) return;
  await db.query(
    `insert into lead_score_queue (contact_id, org_id, trigger, first_requested_at, requested_at, not_before)
     select c.id, c.org_id, $3, $4, $4, $4::timestamptz + make_interval(mins => $5) from contacts c where c.id = $1 and c.org_id = $2 and c.deleted_at is null
     on conflict (contact_id) do update set
       generation = lead_score_queue.generation + 1, trigger = excluded.trigger, requested_at = excluded.requested_at,
       not_before = least(lead_score_queue.first_requested_at + make_interval(mins => $6), excluded.not_before),
       attempts = 0, last_error = null`,
    [contactId, orgId, trigger.slice(0, 60), now, debounce, MAX_WAIT_MINUTES],
  );
}

export interface ScoringRun {
  claimed: number;
  assessed: number;
  unchanged: number;
  skipped: number;
  errors: number;
  deferred: number;
}

export interface ScoringRunOptions {
  now?: Date;
  limit?: number;
  perOrgLimit?: number;
  orgId?: string;
  worker?: string;
  ai?: ExtractionDeps;
}

export async function processScoringQueue(opts: ScoringRunOptions = {}): Promise<ScoringRun> {
  const now = opts.now ?? new Date();
  const limit = Math.min(200, Math.max(1, opts.limit ?? 40));
  const perOrg = Math.min(50, Math.max(1, opts.perOrgLimit ?? 10));
  const worker = opts.worker ?? `s-${crypto.randomBytes(4).toString("hex")}`;
  const run: ScoringRun = { claimed: 0, assessed: 0, unchanged: 0, skipped: 0, errors: 0, deferred: 0 };

  const claimed = await withSystem(async (db) => {
    const candidates = await db.query<{ contact_id: string }>(
      `select contact_id from (
         select contact_id, org_id, not_before, row_number() over (partition by org_id order by not_before) as rn
         from lead_score_queue where not_before <= $1 and (lease_owner is null or lease_expires_at <= $1) and attempts < $4 and ($2::uuid is null or org_id = $2)
       ) due where rn <= $3 order by not_before limit $5`,
      [now, opts.orgId ?? null, perOrg, MAX_ATTEMPTS, limit],
    );
    if (!candidates.rows.length) return [];
    const got = await db.query<{ contact_id: string; org_id: string; generation: number; trigger: string }>(
      `update lead_score_queue set lease_owner = $1, lease_expires_at = $2
       where contact_id = any($3::uuid[]) and (lease_owner is null or lease_expires_at <= $4) returning contact_id, org_id, generation, trigger`,
      [worker, new Date(now.getTime() + LEASE_MINUTES * 60_000), candidates.rows.map((r) => r.contact_id), now],
    );
    return got.rows;
  });
  run.claimed = claimed.length;

  for (const q of claimed) {
    try {
      const over = await withSystem(async (db) => (await db.query<{ n: number }>("select assessments as n from lead_score_usage where org_id = $1 and day = $2", [q.org_id, now.toISOString().slice(0, 10)])).rows[0]?.n ?? 0);
      if (over >= DAILY_ASSESSMENT_CEILING) {
        // Over the day's ceiling: try again after midnight UTC, with the row (and what it was asked for) kept.
        const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5));
        await withSystem((db) => db.query("update lead_score_queue set lease_owner = null, lease_expires_at = null, not_before = $3 where contact_id = $1 and lease_owner = $2", [q.contact_id, worker, tomorrow]));
        run.deferred += 1;
        continue;
      }
      const r = await assessContact(q.org_id, q.contact_id, { now, trigger: q.trigger, ai: opts.ai });
      if (r.outcome === "created") run.assessed += 1;
      else if (r.outcome === "unchanged") run.unchanged += 1;
      else run.skipped += 1;
      // Finished: remove the row unless something newer was asked for while this ran, in which case it stays for another look.
      await withSystem(async (db) => {
        await db.query("delete from lead_score_queue where contact_id = $1 and lease_owner = $2 and generation = $3", [q.contact_id, worker, q.generation]);
        await db.query("update lead_score_queue set lease_owner = null, lease_expires_at = null, attempts = 0 where contact_id = $1 and lease_owner = $2", [q.contact_id, worker]);
      });
    } catch (err) {
      run.errors += 1;
      const message = (err instanceof Error ? `${err.name}${"code" in err && typeof (err as { code?: unknown }).code === "string" ? ` ${(err as { code: string }).code}` : ""}` : "Error").slice(0, 200);
      if (process.env.MCC_DEBUG) console.error("[iacquire] lead scoring failed (debug)", err);
      else if (process.env.NODE_ENV !== "test") logSafeServerDiagnostic("lead scoring failed", err, "lead_scoring");
      await withSystem((db) =>
        db.query(
          `update lead_score_queue set lease_owner = null, lease_expires_at = null, attempts = attempts + 1, last_error = $3,
             not_before = $4::timestamptz + make_interval(mins => least(60, power(2, least(attempts + 1, 6))::int)) where contact_id = $1 and lease_owner = $2`,
          [q.contact_id, worker, message, now],
        ),
      );
    }
  }
  return run;
}

/** Puts contacts that have never been assessed into the queue, a bounded number at a time. Returns how many were added. */
export async function enqueueUnscored(db: Queryable, orgId: string, limit = 500, now = new Date()): Promise<number> {
  const r = await db.query(
    `insert into lead_score_queue (contact_id, org_id, trigger, not_before)
     select c.id, c.org_id, 'backfill', $3 from contacts c where c.org_id = $1 and c.deleted_at is null and c.priority_label is null
       and not exists (select 1 from lead_score_queue q where q.contact_id = c.id)
     order by c.created_at desc limit $2 on conflict (contact_id) do nothing returning contact_id`,
    [orgId, Math.min(2000, Math.max(1, limit)), now],
  );
  return r.rows.length;
}
