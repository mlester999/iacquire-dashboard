import "server-only";
import { withSystem } from "@/server/db";

// How long Phase 2 keeps what it records. Run once a day by the scheduler (job "phase2Retention"). Bounded per run, oldest first, so a large backlog is
// worked off over several days instead of in one long statement.
//
//   finished missed-call cases (with their calls, actions and history)   730 days after they finished
//   lead assessments that are no longer current                          365 days, always keeping the newest ten of a contact
//   cleared lead-priority overrides                                      730 days after they were cleared
//   daily lead-scoring usage counters                                    400 days
//
// A privacy request removes a person's records at once (see erasure.ts); this is the routine clean-up for everyone else.

export const RETENTION = { casesDays: 730, assessmentsDays: 365, keepAssessments: 10, overridesDays: 730, usageDays: 400 } as const;

export interface RetentionResult {
  cases: number;
  assessments: number;
  overrides: number;
  usage: number;
}

export async function purgeExpiredPhase2Records(now = new Date(), limit = 2000): Promise<RetentionResult> {
  const day = 86_400_000;
  return withSystem(async (db) => {
    const cases = await db.query(
      `delete from missed_call_cases where id in (
         select id from missed_call_cases where state in ('recovered', 'completed_without_recovery', 'failed', 'canceled') and resolved_at < $1 order by resolved_at limit $2) returning id`,
      [new Date(now.getTime() - RETENTION.casesDays * day), limit],
    );
    const assessments = await db.query(
      `delete from lead_score_assessments where id in (
         select id from (
           select id, is_current, created_at, row_number() over (partition by contact_id order by seq desc) as rn from lead_score_assessments
           where contact_id in (select contact_id from lead_score_assessments where not is_current and created_at < $1 group by contact_id order by min(created_at) limit $3)
         ) ranked where rn > $2 and not is_current and created_at < $1 limit $4) returning id`,
      [new Date(now.getTime() - RETENTION.assessmentsDays * day), RETENTION.keepAssessments, limit, limit],
    );
    const overrides = await db.query("delete from lead_score_overrides where id in (select id from lead_score_overrides where cleared_at is not null and cleared_at < $1 order by cleared_at limit $2) returning id", [
      new Date(now.getTime() - RETENTION.overridesDays * day), limit,
    ]);
    const usage = await db.query("delete from lead_score_usage where day < $1::date returning org_id", [new Date(now.getTime() - RETENTION.usageDays * day).toISOString().slice(0, 10)]);
    return { cases: cases.rows.length, assessments: assessments.rows.length, overrides: overrides.rows.length, usage: usage.rows.length };
  });
}
