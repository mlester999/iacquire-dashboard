import "server-only";
import { withSystem } from "@/server/db";
import { recordAudit } from "@/server/audit";

const DEFAULT_RETENTION_DAYS = 365;
const MIN_RETENTION_DAYS = 30;
const MAX_RETENTION_DAYS = 3650;
const DEFAULT_BATCH = 500;
const MAX_BATCH = 2_000;

function configuredRetentionDays(): number {
  const raw = Number(process.env.AQI_TUTORIAL_EVENT_RETENTION_DAYS ?? DEFAULT_RETENTION_DAYS);
  if (!Number.isFinite(raw)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(raw)));
}

export interface AqiTutorialRetentionResult {
  deleted: number;
  cutoff: string;
  retentionDays: number;
  batchSize: number;
}

/**
 * Removes a bounded batch of old tutorial analytics events.
 *
 * It never deletes progress rows. Events belonging to a person who is still in progress on the same
 * tutorial are kept, so a resumed walkthrough keeps its recent history even if the event is old.
 * `orgId` limits the batch to one tenant; omitting it lets the scheduled job clean every tenant in
 * bounded batches. The delete is a single statement with a bounded `limit`, safe to run while new
 * events are written.
 */
export async function purgeExpiredAqiTutorialEvents(options: {
  retentionDays?: number;
  batchSize?: number;
  now?: Date;
  orgId?: string | null;
} = {}): Promise<AqiTutorialRetentionResult> {
  const retentionDays = Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.round(options.retentionDays ?? configuredRetentionDays())));
  const batchSize = Math.min(MAX_BATCH, Math.max(1, Math.round(options.batchSize ?? DEFAULT_BATCH)));
  const now = options.now ?? new Date();
  const orgId = options.orgId?.trim() || null;
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);

  return withSystem(async (db) => {
    const deleted = (await db.query<{ id: string }>(
      `with doomed as (
         select e.id
           from aqi_tutorial_events e
          where e.created_at < $1
            and ($3::uuid is null or e.org_id = $3)
            and not exists (
              select 1 from aqi_tutorial_progress p
               where p.user_id = e.user_id
                 and p.tutorial_id = e.tutorial_id
                 and p.org_id is not distinct from e.org_id
                 and p.status in ('in_progress', 'paused')
            )
          order by e.created_at asc
          limit $2
       )
       delete from aqi_tutorial_events e
        using doomed d
        where e.id = d.id
       returning e.id`,
      [cutoff, batchSize, orgId],
    )).rows.length;

    if (deleted > 0) {
      await recordAudit({
        orgId,
        actorKind: "system",
        action: "aqi.tutorial_events_retention",
        targetType: "aqi_tutorial_events",
        result: "success",
        metadata: { deleted, cutoff: cutoff.toISOString(), retentionDays, batchSize },
      }, db);
    }
    return { deleted, cutoff: cutoff.toISOString(), retentionDays, batchSize };
  });
}
