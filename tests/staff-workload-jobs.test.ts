import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { staffWorkloadSnapshots } from "@/server/staff-workload/job";
import { makeTicket, setWorkload, workloadWorld } from "./support/staff-workload";

// The scheduled job the production scheduler names `staffWorkloadSnapshots`: it is dormant until a Super Admin switches the module on, writes the same labels the screens
// show, opens an alert when a person is Overloaded or Critical, tells the managers once, and writes nothing new on a second run with the same facts. No provider, no AI,
// no client name in a notice.

const NOW = new Date("2026-10-26T09:00:00Z"); // Monday, in the agency's default UTC day.
const PAST = new Date("2026-10-24T09:00:00Z");

const snapshots = (userId: string) =>
  withSystem((db) =>
    db.query<{ kind: string; label: string | null; points: number }>("select kind, label, points from staff_workload_snapshots where user_id = $1 order by id", [userId]),
  ).then((r) => r.rows);

const notices = (userId: string, kind: string) =>
  withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from notifications where user_id = $1 and kind = $2", [userId, kind])).then((r) => Number(r.rows[0]?.n ?? 0));

describe("the staff workload snapshot job", () => {
  it("does nothing at all while the module is switched off", async () => {
    const w = await workloadWorld();
    await setWorkload(false);
    const result = await staffWorkloadSnapshots({ now: NOW, budgetMs: 60_000, batch: 50 });
    expect(result.people).toBe(0);
    expect(result.snapshots).toBe(0);
    expect(result.alertsOpened).toBe(0);
    expect(await snapshots(w.staff.id)).toEqual([]);
    await setWorkload(true);
  });

  it("rates an overloaded person, opens one alert, tells a manager once, and writes no second row on an unchanged run", async () => {
    const w = await workloadWorld();
    // A small capacity makes the five urgent, overdue requests comfortably Critical; the label is also floored by five overdue items.
    await withSystem((db) =>
      db.query(
        `insert into staff_work_profiles (user_id, org_id, capacity_points, working_days, skills, updated_by)
         values ($1, $2, 1, '{1,2,3,4,5,6,7}'::smallint[], '{}'::jsonb, $1)
         on conflict (user_id) do update set capacity_points = 1, working_days = '{1,2,3,4,5,6,7}'::smallint[], skills = '{}'::jsonb`,
        [w.staff.id, w.agencyId],
      ),
    );
    for (let i = 0; i < 5; i++) await makeTicket(w.clientA.id, { assignedTo: w.staff.id, priority: "urgent", dueAt: PAST.toISOString(), subject: `Overdue workload job ${i}` });

    const first = await staffWorkloadSnapshots({ now: NOW, budgetMs: 60_000, batch: 50 });
    expect(first.people).toBeGreaterThanOrEqual(5);
    expect(first.failed).toBe(0);
    expect(first.snapshots).toBeGreaterThanOrEqual(1);
    expect(first.alertsOpened).toBeGreaterThanOrEqual(1);
    expect(first.managerNotices).toBeGreaterThanOrEqual(1);

    const mine = await snapshots(w.staff.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "daily", label: "critical" });
    const alert = await withSystem((db) => db.query<{ label: string; resolved_at: Date | null }>("select label, resolved_at from staff_workload_alerts where user_id = $1", [w.staff.id]));
    expect(alert.rows).toHaveLength(1);
    expect(alert.rows[0]).toMatchObject({ label: "critical", resolved_at: null });
    expect(await notices(w.manager.id, "staff_workload_alert")).toBeGreaterThanOrEqual(1);

    // The same facts at the same moment: the daily row exists and nothing changed, so the job writes no history, opens no second alert and does not tell the manager again.
    const second = await staffWorkloadSnapshots({ now: NOW, budgetMs: 60_000, batch: 50 });
    expect(second.snapshots).toBe(0);
    expect(second.alertsOpened).toBe(0);
    expect(second.managerNotices).toBe(0);
    expect(await snapshots(w.staff.id)).toHaveLength(1);
    expect(await withSystem((db) => db.query<{ n: string }>("select count(*)::text as n from staff_workload_alerts where user_id = $1", [w.staff.id]))).toMatchObject({ rows: [{ n: "1" }] });
  });
});
