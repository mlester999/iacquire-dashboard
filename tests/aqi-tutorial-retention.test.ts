import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser } from "./support/fixtures";
import { purgeExpiredAqiTutorialEvents } from "@/server/aqi/retention";

async function fixture() {
  const org = await createOrg({ name: `Retention ${Math.random().toString(16).slice(2)}` });
  const user = await createUser({ name: "Retention User" });
  const inactive = await createUser({ name: "Retention Inactive" });
  await addMember(org.id, user.id, "owner");
  await addMember(org.id, inactive.id, "owner");
  const tutorial = await withSystem(async (db) => (await db.query<{ id: string }>("select id from aqi_tutorials where slug = 'getting-started'")).rows[0]);
  return { org, user, inactive, tutorial };
}

describe("AQi tutorial event retention", () => {
  it("deletes old events in bounded batches and never deletes active progress", async () => {
    const { org, user, inactive, tutorial } = await fixture();
    const now = new Date("2026-10-19T12:00:00.000Z");
    const old = new Date(now.getTime() - 400 * 86_400_000);
    const recent = new Date(now.getTime() - 10 * 86_400_000);

    await withSystem(async (db) => {
      await db.query(
        `insert into aqi_tutorial_events (org_id, user_id, tutorial_id, tutorial_version, attempt, step_key, kind, dedupe_key, created_at)
         values ($1, $2, $3, 1, 1, 'overview', 'started', $4, $5),
                ($1, $2, $3, 1, 1, 'overview', 'step_viewed', $6, $5),
                ($1, $7, $3, 1, 1, 'overview', 'started', $8, $5),
                ($1, $7, $3, 1, 1, 'overview', 'step_viewed', $9, $5),
                ($1, $2, $3, 1, 1, 'overview', 'started', $10, $11)`,
        [org.id, user.id, tutorial.id, `retention-old-${user.id}-1`, old, `retention-old-${user.id}-2`, inactive.id, `retention-inactive-${inactive.id}-1`, `retention-inactive-${inactive.id}-2`, `retention-recent-${user.id}`, recent],
      );
      await db.query(
        `insert into aqi_tutorial_progress (org_id, user_id, tutorial_id, tutorial_version, attempt, current_step, status)
         values ($1, $2, $3, 1, 1, 0, 'in_progress')`,
        [org.id, user.id, tutorial.id],
      );
      // An old event for an active person is kept while that progress is active.
      await db.query(
        `insert into aqi_tutorial_events (org_id, user_id, tutorial_id, tutorial_version, attempt, step_key, kind, dedupe_key, created_at)
         values ($1, $2, $3, 1, 1, 'overview', 'step_viewed', $4, $5)`,
        [org.id, user.id, tutorial.id, `retention-old-active-${user.id}`, old],
      );
    });

    const first = await purgeExpiredAqiTutorialEvents({ retentionDays: 365, batchSize: 1, now, orgId: org.id });
    expect(first.deleted).toBe(1);
    expect(first.retentionDays).toBe(365);
    expect(first.batchSize).toBe(1);

    const remaining = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_tutorial_events where org_id = $1",
      [org.id],
    )).rows[0].n);
    expect(remaining).toBe(5);

    const progress = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_tutorial_progress where org_id = $1",
      [org.id],
    )).rows[0].n);
    expect(progress).toBe(1);

    // Completing the progress makes its old events eligible.
    await withSystem((db) => db.query(
      "update aqi_tutorial_progress set status = 'completed', completed_at = now() where org_id = $1",
      [org.id],
    ));
    const second = await purgeExpiredAqiTutorialEvents({ retentionDays: 365, batchSize: 10, now, orgId: org.id });
    expect(second.deleted).toBe(4);
    const left = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_tutorial_events where org_id = $1",
      [org.id],
    )).rows[0].n);
    expect(left).toBe(1);

    const audit = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from audit_logs where action = 'aqi.tutorial_events_retention' and metadata->>'deleted' is not null",
    )).rows[0].n);
    expect(audit).toBeGreaterThanOrEqual(1);
  });

  it("keeps a bounded maximum and respects the minimum retention window", async () => {
    const result = await purgeExpiredAqiTutorialEvents({ retentionDays: 1, batchSize: 10_000, now: new Date("2026-10-19T12:00:00.000Z") });
    expect(result.retentionDays).toBe(30);
    expect(result.batchSize).toBe(2000);
    expect(result.deleted).toBeGreaterThanOrEqual(0);
  });
});
