import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { addDays } from "@/lib/calendars/slots";
import { todayIn } from "@/lib/staff-workload/calendar";
import { canEditTimeOff, canSeeAway, canSeeProfileOf, canSeeTimeOffDetail } from "@/lib/staff-workload/visibility";
import { checkProfile, checkTimeOff, MAX_OPEN_TIME_OFF, type ProfileInput, type TimeOffInput, type TimeOffKind } from "@/lib/staff-workload/time-off";
import { isId, loadWorkloadActor, requireWorkloadCap, throttle, type StaffUser } from "@/server/staff-workload/access";
import { loadPeople, type PersonProfile } from "@/server/staff-workload/engine";

// A person's capacity, working days and skills (the manage permission's alone) and their time off (their own, or anyone's for the manage permission). All optional: a person
// with no profile works Monday to Friday and has the team default capacity, if the Super Admin set one. Nothing here is inferred from what a person did or from when they
// last signed in.

const NOT_FOUND_PERSON = "That person was not found on the agency team.";

/** An active agency account, or not found. The same words for a made-up id and for someone who left. */
async function requireAgencyPerson(db: Queryable, userId: unknown): Promise<string> {
  if (!isId(userId)) throw new AppError("not_found", NOT_FOUND_PERSON);
  const { rows } = await db.query<{ ok: boolean }>(
    "select exists (select 1 from users u where u.id = $1 and u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')) as ok", [userId],
  );
  if (!rows[0]?.ok) throw new AppError("not_found", NOT_FOUND_PERSON);
  return userId;
}

export interface ProfileView extends PersonProfile {
  userId: string;
}

/** A person's profile: their own, or anyone's for the team permission. A person with none yet has the defaults and revision 0. */
export async function getProfile(user: StaffUser, userId: string): Promise<ProfileView> {
  const actor = await loadWorkloadActor(user);
  if (!canSeeProfileOf(actor, userId)) throw new AppError("forbidden", "You can only see your own capacity unless you hold the workload team permission.");
  return withSystem(async (db) => {
    await requireAgencyPerson(db, userId);
    const [person] = await loadPeople(db, [userId]);
    return { userId, ...person.profile };
  });
}

/**
 * Changes a person's capacity, working days and skills. The manage permission only; `expectedRevision` is the revision the form was opened on (0 for a person with no profile
 * yet): if someone saved in between, nothing is written and the person is told to reload. Skills are the whole set (a skill left out is removed), each at level 1 to 3.
 */
export async function updateProfile(user: StaffUser, targetId: string, change: ProfileInput, expectedRevision: number): Promise<{ revision: number }> {
  const actor = await requireWorkloadCap(user, "manage");
  await throttle("staffWorkloadManageByUser", user.id);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) throw new AppError("invalid_input", "Reload the page and try again.");
  const checked = checkProfile(change);
  if (!checked.ok) throw new AppError("invalid_input", checked.message);
  const value = checked.value;
  return withSystem(async (db) => {
    const target = await requireAgencyPerson(db, targetId);
    const existing = (await db.query<{ revision: number }>("select revision from staff_work_profiles where user_id = $1 for update", [target])).rows[0];
    if ((existing?.revision ?? 0) !== expectedRevision) throw new AppError("conflict", "This profile was changed by someone else while you were editing. Reload the page to see the current one.");
    let revision: number;
    if (!existing) {
      const created = await db.query<{ revision: number }>(
        `insert into staff_work_profiles (user_id, org_id, capacity_points, working_days, skills, updated_by)
         values ($1, $2, $3, coalesce($4::smallint[], '{1,2,3,4,5}'::smallint[]), coalesce($5::jsonb, '{}'::jsonb), $6) returning revision`,
        [target, actor.agencyOrgId, value.capacityPoints ?? null, value.workingDays ?? null, value.skills ? JSON.stringify(value.skills) : null, user.id],
      );
      revision = created.rows[0].revision;
    } else {
      const sets: string[] = [];
      const params: unknown[] = [target, user.id];
      const add = (column: string, v: unknown, cast = "") => {
        params.push(v);
        sets.push(`${column} = $${params.length}${cast}`);
      };
      if (value.capacityPoints !== undefined) add("capacity_points", value.capacityPoints);
      if (value.workingDays !== undefined) add("working_days", value.workingDays, "::smallint[]");
      if (value.skills !== undefined) add("skills", JSON.stringify(value.skills), "::jsonb");
      const updated = await db.query<{ revision: number }>(`update staff_work_profiles set ${sets.join(", ")}, updated_by = $2 where user_id = $1 returning revision`, params);
      revision = updated.rows[0].revision;
    }
    await recordAudit({
      orgId: actor.agencyOrgId, actorUserId: user.id, actorKind: "agency", action: "staff_workload.profile_changed", targetType: "user", targetId: target, result: "success",
      metadata: { fields: Object.keys(value), revision },
    }, db);
    return { revision };
  });
}

export interface TimeOffView {
  id: string;
  userId: string;
  startsOn: string;
  endsOn: string;
  partDay: boolean;
  /** Null for a viewer who only sees that the person is away. */
  kind: TimeOffKind | null;
  note: string | null;
}

interface TimeOffRow {
  id: string;
  user_id: string;
  starts_on: string;
  ends_on: string;
  part_day: boolean;
  kind: TimeOffKind;
  note: string | null;
}

/** Time off that has not ended yet (or ended up to `sinceDays` ago), for one person. The kind and the note only for the person and the manage permission. */
export async function listTimeOff(user: StaffUser, userId: string, opts: { sinceDays?: number } = {}): Promise<TimeOffView[]> {
  const actor = await loadWorkloadActor(user);
  if (!canSeeAway(actor, userId)) throw new AppError("forbidden", "You can only see your own time off unless you hold the workload team permission.");
  const detail = canSeeTimeOffDetail(actor, userId);
  return withSystem(async (db) => {
    await requireAgencyPerson(db, userId);
    const today = todayIn(new Date(), actor.timeZone);
    const from = addDays(today, -Math.max(0, Math.min(366, opts.sinceDays ?? 0)));
    const { rows } = await db.query<TimeOffRow>(
      "select id::text, user_id::text, starts_on::text, ends_on::text, part_day, kind, note from staff_time_off where user_id = $1 and ends_on >= $2::date order by starts_on, id", [userId, from],
    );
    return rows.map((r) => ({ id: r.id, userId: r.user_id, startsOn: r.starts_on, endsOn: r.ends_on, partDay: r.part_day, kind: detail ? r.kind : null, note: detail ? r.note : null }));
  });
}

/**
 * Records time off for the person themself, or for someone else with the manage permission. The same entry recorded twice is one entry (a double click changes nothing).
 * Nothing about it is sent to anyone.
 */
export async function addTimeOff(user: StaffUser, input: TimeOffInput & { userId?: string }): Promise<{ id: string; created: boolean }> {
  const actor = await loadWorkloadActor(user);
  const targetId = input.userId ?? actor.userId;
  if (!canEditTimeOff(actor, targetId)) throw new AppError("forbidden", "Recording someone else's time off needs the workload manage permission.");
  await throttle("staffWorkloadManageByUser", user.id);
  const today = todayIn(new Date(), actor.timeZone);
  const checked = checkTimeOff(input, today);
  if (!checked.ok) throw new AppError("invalid_input", checked.message);
  const v = checked.value;
  return withSystem(async (db) => {
    const target = await requireAgencyPerson(db, targetId);
    const same = (await db.query<{ id: string }>(
      "select id::text from staff_time_off where user_id = $1 and starts_on = $2::date and ends_on = $3::date and part_day = $4 and kind = $5 order by created_at limit 1", [target, v.startsOn, v.endsOn, v.partDay, v.kind],
    )).rows[0];
    if (same) return { id: same.id, created: false };
    const open = (await db.query<{ n: number }>("select count(*)::int as n from staff_time_off where user_id = $1 and ends_on >= $2::date", [target, today])).rows[0].n;
    if (open >= MAX_OPEN_TIME_OFF) throw new AppError("conflict", "That is a lot of time off already recorded for this person. Remove entries that are no longer needed first.");
    const { rows } = await db.query<{ id: string }>(
      "insert into staff_time_off (org_id, user_id, starts_on, ends_on, part_day, kind, note, created_by) values ($1, $2, $3::date, $4::date, $5, $6, $7, $8) returning id::text",
      [actor.agencyOrgId, target, v.startsOn, v.endsOn, v.partDay, v.kind, v.note, user.id],
    );
    // The audit row names the person and the dates; the note stays in the table (it can be private).
    await recordAudit({
      orgId: actor.agencyOrgId, actorUserId: user.id, actorKind: "agency", action: "staff_workload.time_off_added", targetType: "user", targetId: target, result: "success",
      metadata: { startsOn: v.startsOn, endsOn: v.endsOn, partDay: v.partDay, kind: v.kind },
    }, db);
    return { id: rows[0].id, created: true };
  });
}

/** Removes an entry of time off: the person's own, or anyone's for the manage permission. Removing one that is already gone changes nothing. */
export async function removeTimeOff(user: StaffUser, id: string): Promise<{ removed: boolean }> {
  const actor = await loadWorkloadActor(user);
  await throttle("staffWorkloadManageByUser", user.id);
  if (!isId(id)) throw new AppError("not_found", "That entry was not found.");
  return withSystem(async (db) => {
    const row = (await db.query<{ user_id: string; starts_on: string; ends_on: string }>("select user_id::text, starts_on::text, ends_on::text from staff_time_off where id = $1 for update", [id])).rows[0];
    // Someone else's entry answers exactly as a missing one does to a person who may not change it, so an id cannot be used to find out whether it exists.
    if (!row || !canEditTimeOff(actor, row.user_id)) return { removed: false };
    await db.query("delete from staff_time_off where id = $1", [id]);
    await recordAudit({
      orgId: actor.agencyOrgId, actorUserId: user.id, actorKind: "agency", action: "staff_workload.time_off_removed", targetType: "user", targetId: row.user_id, result: "success",
      metadata: { startsOn: row.starts_on, endsOn: row.ends_on },
    }, db);
    return { removed: true };
  });
}
