import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";
import { notifyStaff, notifyStaffBatch, type StaffNoticeInput } from "@/server/notifications";
import { decideAlert, isAlertLabel, managerNoticeKey, overdueNoticeKey, snapshotKind, HISTORY_RETENTION_DAYS, SNAPSHOT_BUDGET_MS, TIME_OFF_RETENTION_DAYS, type AlertLabel, type OpenAlert } from "@/lib/staff-workload/alerts";
import { addDays } from "@/lib/calendars/slots";
import { FORMER_PERSON_TEXT, managerAlertNotice, overdueNotice } from "@/lib/staff-workload/notices";
import { isOverdue, type WorkSource } from "@/lib/staff-workload/sources";
import { computeTeam, type PersonLoad, type TeamLoad } from "@/server/staff-workload/engine";
import { staffWorkloadEnabled } from "@/server/staff-workload/settings";

// The scheduled job staffWorkloadSnapshots (every 15 minutes, off until the scheduler stage that names it; it does nothing at all while a Super Admin has the module switched
// off). For every active agency person, from the same engine the screens use:
//   * writes a row of history when their label or points changed since the last row, and one each day (a second run on the same day writes none);
//   * opens an alert when they become Overloaded or Critical, follows it between the two, and ends it as soon as the label is anything else;
//   * tells the people who hold the team permission about an alert once for each person, label and day (never the person themself: they see their own label), with counts only;
//   * tells a person once a day that items assigned to them are past their due time, if they can open the workload page the notice links to;
//   * tidies up after people who left: ends their alerts, clears the notes of their time off and replaces their name in the notices about them;
//   * removes history and finished alerts older than 400 days, and time off that ended more than 400 days ago.
// It contacts nobody outside the portal, calls no provider and sends no email (the notices are in-app only). One person is written in one short transaction under a lock for that
// person, so two runs at once leave one row; a person it does not reach before the time budget ends waits for the next run. There is one agency workspace, so there is no
// fairness to keep between workspaces.

export interface SnapshotJobResult {
  people: number;
  snapshots: number;
  alertsOpened: number;
  alertsChanged: number;
  alertsResolved: number;
  managerNotices: number;
  overdueNotices: number;
  departed: number;
  purged: number;
  failed: number;
  /** The time budget ended before every person was reached. */
  stoppedEarly: boolean;
}

const ZERO: SnapshotJobResult = { people: 0, snapshots: 0, alertsOpened: 0, alertsChanged: 0, alertsResolved: 0, managerNotices: 0, overdueNotices: 0, departed: 0, purged: 0, failed: 0, stoppedEarly: false };

const AGENCY_ROLES = "('agency_staff', 'agency_manager', 'agency_super_admin')";

interface AlertRow {
  id: string;
  label: AlertLabel;
  since: Date;
  critical_since: Date | null;
}

const asIso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

async function managersWhoSee(db: Queryable): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>(
    `select u.id::text as id from users u
      where u.status = 'active' and u.platform_role in ${AGENCY_ROLES}
        and coalesce(app.user_has_agency_permission(u.id, 'agency.workload.view'), false) and coalesce(app.user_has_agency_permission(u.id, 'agency.workload.team'), false)
      order by u.id`,
  );
  return rows.map((r) => r.id);
}

/**
 * One person: history, alert, notices. Idempotent: run again with nothing changed and it writes nothing. Returns what this person's transaction did, to be added up only
 * once it has committed.
 */
async function processPerson(db: Queryable, load: PersonLoad, team: TeamLoad, managers: readonly string[]): Promise<SnapshotJobResult> {
  const result: SnapshotJobResult = { ...ZERO };
  const userId = load.person.userId;
  const r = load.result;
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`staffWorkloadSnapshots:${userId}`]);
  const agency = (await db.query<{ id: string }>("select id::text from organizations where kind = 'agency'")).rows[0]?.id;
  if (!agency) return result;

  // History.
  const last = (await db.query<{ label: string | null; points_centi: number }>(
    "select label, round(points * 100)::int as points_centi from staff_workload_snapshots where user_id = $1 order by id desc limit 1", [userId],
  )).rows[0];
  const dailyDone = (await db.query<{ ok: boolean }>("select exists (select 1 from staff_workload_snapshots where user_id = $1 and day = $2::date and kind = 'daily') as ok", [userId, team.today])).rows[0].ok;
  const kind = snapshotKind(last ? { label: last.label as typeof r.label, pointsCenti: last.points_centi } : null, { label: r.label, pointsCenti: r.pointsCenti }, dailyDone);
  if (kind) {
    const written = await db.query(
      `insert into staff_workload_snapshots (org_id, user_id, day, kind, label, points, capacity, overdue, items, escalated, capacity_source, rules_revision, taken_at)
       values ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::timestamptz) on conflict (user_id, day) where kind = 'daily' do nothing`,
      [agency, userId, team.today, kind, r.label, r.points, r.capacity, r.overdue, r.items, r.escalated, r.capacitySource, team.rules.revision, team.now.toISOString()],
    );
    result.snapshots += written.rowCount;
  }

  // The alert.
  const open = (await db.query<AlertRow>("select id::text, label, since, critical_since from staff_workload_alerts where user_id = $1 and resolved_at is null for update", [userId])).rows[0];
  const current: OpenAlert | null = open ? { label: open.label, since: new Date(open.since).toISOString(), criticalSince: asIso(open.critical_since) } : null;
  const decision = decideAlert(current, r.label, team.now);
  let alertId: string | null = open?.id ?? null;
  let effective: OpenAlert | null = current;
  if (decision.action === "open") {
    const created = await db.query<{ id: string }>(
      "insert into staff_workload_alerts (org_id, user_id, label, since, critical_since) values ($1, $2, $3, $4::timestamptz, $5::timestamptz) on conflict (user_id) where resolved_at is null do nothing returning id::text",
      [agency, userId, decision.label, decision.since, decision.criticalSince],
    );
    if (created.rows[0]) {
      alertId = created.rows[0].id;
      effective = { label: decision.label, since: decision.since, criticalSince: decision.criticalSince };
      result.alertsOpened += 1;
    }
  } else if (decision.action === "change" && open) {
    await db.query("update staff_workload_alerts set label = $2, critical_since = $3::timestamptz where id = $1", [open.id, decision.label, decision.criticalSince]);
    effective = { label: decision.label, since: current!.since, criticalSince: decision.criticalSince };
    result.alertsChanged += 1;
  } else if (decision.action === "resolve" && open) {
    await db.query("update staff_workload_alerts set resolved_at = $2::timestamptz where id = $1", [open.id, team.now.toISOString()]);
    effective = null;
    alertId = null;
    result.alertsResolved += 1;
  }

  // The managers, once for each person, label and day.
  if (effective && alertId && isAlertLabel(r.label)) {
    const notice = managerAlertNotice({ userId, name: load.person.name, label: effective.label, result: r, since: effective.since, criticalSince: effective.criticalSince, now: team.now });
    const notices: StaffNoticeInput[] = managers.filter((m) => m !== userId).map((m) => ({
      userId: m, kind: "staff_workload_alert", severity: effective!.label === "critical" ? "critical" : "warning", title: notice.title, body: notice.body, link: notice.link,
      dedupeKey: managerNoticeKey(userId, effective!.label, team.today),
    }));
    const told = await notifyStaffBatch(db, notices);
    if (told.length) {
      result.managerNotices += told.length;
      await db.query("update staff_workload_alerts set notified_at = $2::timestamptz where id = $1", [alertId, team.now.toISOString()]);
    }
  }

  // The person, once a day, about what is past its time. Only if they can open the page the notice points to.
  if (r.overdue > 0 && load.person.canView) {
    const by: Partial<Record<WorkSource, number>> = {};
    for (const item of load.items) if (isOverdue(item, team.now, team.today)) by[item.source] = (by[item.source] ?? 0) + 1;
    const n = overdueNotice(by);
    const id = await notifyStaff(db, userId, { kind: "staff_work_overdue", severity: "warning", title: n.title, body: n.body, link: n.link, dedupeKey: overdueNoticeKey(userId, team.today) });
    if (id) result.overdueNotices += 1;
  }
  return result;
}

/** People who are no longer on the team: their alerts end, the notes on their time off go, and notices that name them lose the name. */
async function tidyDeparted(db: Queryable, now: Date, limit: number): Promise<number> {
  let n = 0;
  // The expression is interpolated as a value, never through String.replace: a replacement string treats `$'` specially and used to mangle the UUID pattern in the notice query.
  const gone = (id: string) => `not exists (select 1 from users u where u.id = ${id} and u.status = 'active' and u.platform_role in ${AGENCY_ROLES})`;
  const alerts = await db.query(
    `update staff_workload_alerts a set resolved_at = greatest($1::timestamptz, a.since) where a.id in (select x.id from staff_workload_alerts x where x.resolved_at is null and ${gone("x.user_id")} limit $2)`,
    [now.toISOString(), limit],
  );
  n += alerts.rowCount;
  const notes = await db.query(
    `update staff_time_off t set note = null where t.id in (select x.id from staff_time_off x where x.note is not null and ${gone("x.user_id")} limit $1)`, [limit],
  );
  n += notes.rowCount;
  const notices = await db.query(
    `update notifications set title = $1, body = $2
      where id in (select x.id from notifications x
                    where x.kind = 'staff_workload_alert' and x.dedupe_key ~ '^workload:[0-9a-f-]{36}:' and x.title <> $1
                      and ${gone("(case when split_part(x.dedupe_key, ':', 2) ~ '^[0-9a-f-]{36}$' then split_part(x.dedupe_key, ':', 2)::uuid end)")} limit $3)`,
    [FORMER_PERSON_TEXT, "This notice was about a person who is no longer on the agency team.", limit],
  );
  n += notices.rowCount;
  return n;
}

/** Removes what is past its retention. The database's own clock decides (the same one its guard uses), so a job run with a pretend "now" can never fail on the guard. */
async function purgeOld(db: Queryable, today: string, limit: number): Promise<number> {
  const snaps = await db.query(
    `delete from staff_workload_snapshots where id in (select id from staff_workload_snapshots where taken_at < now() - make_interval(days => $1) order by id limit $2)`, [HISTORY_RETENTION_DAYS, limit],
  );
  const alerts = await db.query(
    `delete from staff_workload_alerts where id in (select id from staff_workload_alerts where resolved_at is not null and resolved_at < now() - make_interval(days => $1) order by id limit $2)`, [HISTORY_RETENTION_DAYS, limit],
  );
  const off = await db.query(
    `delete from staff_time_off where id in (select id from staff_time_off where ends_on < $1::date order by id limit $2)`, [addDays(today, -TIME_OFF_RETENTION_DAYS), limit],
  );
  return snaps.rowCount + alerts.rowCount + off.rowCount;
}

export async function staffWorkloadSnapshots(opts: { now?: Date; budgetMs?: number; batch?: number } = {}): Promise<SnapshotJobResult> {
  if (!(await staffWorkloadEnabled())) return { ...ZERO };
  const now = opts.now ?? new Date();
  const batch = opts.batch ?? 200;
  const deadline = Date.now() + (opts.budgetMs ?? SNAPSHOT_BUDGET_MS);
  const result: SnapshotJobResult = { ...ZERO };
  const { team, managers } = await withSystem(async (db) => ({ team: await computeTeam(db, now), managers: await managersWhoSee(db) }));
  result.people = team.people.length;
  for (const load of team.people) {
    if (Date.now() > deadline) {
      result.stoppedEarly = true;
      break;
    }
    try {
      const done = await withSystem((db) => processPerson(db, load, team, managers));
      result.snapshots += done.snapshots;
      result.alertsOpened += done.alertsOpened;
      result.alertsChanged += done.alertsChanged;
      result.alertsResolved += done.alertsResolved;
      result.managerNotices += done.managerNotices;
      result.overdueNotices += done.overdueNotices;
    } catch (e) {
      // One person's failure must not stop the others; the next run tries again. The class of error is kept, never the message (it can carry a name).
      result.failed += 1;
      console.error(`[staffWorkloadSnapshots] a person could not be processed (${e instanceof Error ? e.name : "error"})`);
    }
  }
  if (!result.stoppedEarly) {
    await withSystem(async (db) => {
      result.departed = await tidyDeparted(db, now, batch);
      result.purged = await purgeOld(db, team.today, batch);
      if (result.departed) {
        const agency = (await db.query<{ id: string }>("select id::text from organizations where kind = 'agency'")).rows[0]?.id;
        if (agency) await recordAudit({ orgId: agency, actorKind: "system", action: "staff_workload.departed_tidied", targetType: "organization", targetId: agency, result: "success", metadata: { changed: result.departed } }, db);
      }
    });
  }
  if (result.people > 0 && result.failed === result.people) throw new Error("staffWorkloadSnapshots could not process any person");
  return result;
}

/** The scheduler's entry: the number of things done. */
export async function runStaffWorkloadSnapshots(opts: { now?: Date; budgetMs?: number; batch?: number } = {}): Promise<number> {
  const r = await staffWorkloadSnapshots(opts);
  return r.snapshots + r.alertsOpened + r.alertsChanged + r.alertsResolved + r.managerNotices + r.overdueNotices + r.departed + r.purged;
}
