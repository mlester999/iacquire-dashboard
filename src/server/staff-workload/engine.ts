import "server-only";
import type { Queryable } from "@/server/db";
import { availableHalfDays, horizonDates, todayIn, DEFAULT_WORKING_DAYS, type TimeOffSpan } from "@/lib/staff-workload/calendar";
import { computeWorkload, resolveCapacity, type WorkloadResult } from "@/lib/staff-workload/labels";
import { isSkill, type Skill, type WorkItem } from "@/lib/staff-workload/sources";
import { loadWorkItems } from "@/server/staff-workload/projection";
import { loadRules, type RulesInForce } from "@/server/staff-workload/settings";
import type { AgencyRole } from "@/server/staff-workload/access";

// The engine's server half: it reads the people, their capacity and time off, the rules in force and the open work, and hands them to the pure rules. It reads for the whole
// agency and knows nothing about who is asking: what a viewer may see of it is decided by the services in view.ts.

export interface PersonProfile {
  capacityPoints: number | null;
  workingDays: number[];
  skills: Partial<Record<Skill, number>>;
  /** 0 when the person has no profile row yet. */
  revision: number;
}

export interface Person {
  userId: string;
  name: string;
  role: AgencyRole;
  /** Whether they may open the workload pages (the view permission), so a notice that links there is only sent to someone who can follow it. */
  canView: boolean;
  profile: PersonProfile;
}

export interface PersonLoad {
  person: Person;
  result: WorkloadResult;
  items: WorkItem[];
  timeOff: TimeOffSpan[];
}

export interface TeamLoad {
  now: Date;
  /** Today in the agency workspace's time zone. */
  today: string;
  timeZone: string;
  /** The working days the planning horizon covers. */
  dates: string[];
  rules: RulesInForce;
  supportTargetsEnabled: boolean;
  people: PersonLoad[];
  /** Open work held by someone who is no longer an active agency account. Nobody's load includes it, so it is listed here, never dropped. Empty when only some people were asked for. */
  orphaned: WorkItem[];
}

interface PersonRow {
  id: string;
  name: string;
  platform_role: AgencyRole;
  can_view: boolean;
  capacity_points: number | null;
  working_days: number[] | null;
  skills: unknown;
  revision: number | null;
}

/** Skills as a manager recorded them: known skills at level 1 to 3, nothing else. */
export function readSkills(value: unknown): Partial<Record<Skill, number>> {
  const out: Partial<Record<Skill, number>> = {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) return out;
  for (const [key, level] of Object.entries(value)) {
    if (isSkill(key) && (level === 1 || level === 2 || level === 3)) out[key] = level;
  }
  return out;
}

export async function loadAgencyTimeZone(db: Queryable): Promise<string> {
  return (await db.query<{ timezone: string | null }>("select timezone from organizations where kind = 'agency'")).rows[0]?.timezone ?? "UTC";
}

export async function loadSupportTargetsEnabled(db: Queryable): Promise<boolean> {
  return (await db.query<{ enabled: boolean }>("select coalesce(bool_or(targets_enabled), false) as enabled from support_settings")).rows[0]?.enabled === true;
}

/** Every active agency account (or the ones named), with their profile. People who left or were demoted are not here: they have no load. */
export async function loadPeople(db: Queryable, userIds?: readonly string[]): Promise<Person[]> {
  const { rows } = await db.query<PersonRow>(
    `select u.id::text as id, coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1)) as name, u.platform_role,
            coalesce(app.user_has_agency_permission(u.id, 'agency.workload.view'), false) as can_view,
            p.capacity_points, p.working_days, p.skills, p.revision
       from users u left join staff_work_profiles p on p.user_id = u.id
      where u.status = 'active' and u.platform_role in ('agency_staff', 'agency_manager', 'agency_super_admin')
        and ($1::uuid[] is null or u.id = any($1::uuid[]))
      order by lower(coalesce(nullif(u.full_name, ''), split_part(u.email::text, '@', 1))), u.id`,
    [userIds ? [...userIds] : null],
  );
  return rows.map((r) => ({
    userId: r.id,
    name: r.name,
    role: r.platform_role,
    canView: r.can_view,
    profile: { capacityPoints: r.capacity_points, workingDays: r.working_days ?? [...DEFAULT_WORKING_DAYS], skills: readSkills(r.skills), revision: r.revision ?? 0 },
  }));
}

/** The time off that touches the days from `from` to `to`, by person. */
export async function loadTimeOff(db: Queryable, from: string, to: string, userIds?: readonly string[]): Promise<Map<string, TimeOffSpan[]>> {
  const { rows } = await db.query<{ user_id: string; starts_on: string; ends_on: string; part_day: boolean }>(
    `select user_id::text, starts_on::text, ends_on::text, part_day from staff_time_off
      where ends_on >= $1::date and starts_on <= $2::date and ($3::uuid[] is null or user_id = any($3::uuid[]))`,
    [from, to, userIds ? [...userIds] : null],
  );
  const out = new Map<string, TimeOffSpan[]>();
  for (const r of rows) out.set(r.user_id, [...(out.get(r.user_id) ?? []), { startsOn: r.starts_on, endsOn: r.ends_on, partDay: r.part_day }]);
  return out;
}

/** Everything the engine needs to rate the people named (everyone, when none are named), as of `now`. */
export async function computeTeam(db: Queryable, now: Date, opts: { userIds?: readonly string[] } = {}): Promise<TeamLoad> {
  const rules = await loadRules(db);
  const timeZone = await loadAgencyTimeZone(db);
  const today = todayIn(now, timeZone);
  const dates = horizonDates(today, rules.rules.horizonDays);
  const people = await loadPeople(db, opts.userIds);
  const ids = people.map((p) => p.userId);
  const timeOff = ids.length ? await loadTimeOff(db, dates[0], dates[dates.length - 1], ids) : new Map<string, TimeOffSpan[]>();
  const supportTargetsEnabled = await loadSupportTargetsEnabled(db);
  // When the whole team is asked for, everything that is assigned is read, so work held by someone who is no longer on the team is found (it belongs to nobody's load).
  const { items } = await loadWorkItems(db, opts.userIds ? { kind: "assigned", userIds: ids } : { kind: "assigned" });
  const known = new Set(ids);
  const byPerson = new Map<string, WorkItem[]>();
  const orphaned: WorkItem[] = [];
  for (const item of items) {
    if (item.assigneeId && known.has(item.assigneeId)) byPerson.set(item.assigneeId, [...(byPerson.get(item.assigneeId) ?? []), item]);
    else if (!opts.userIds) orphaned.push(item);
  }
  const loads = people.map((person): PersonLoad => {
    const spans = timeOff.get(person.userId) ?? [];
    const half = availableHalfDays(dates, person.profile.workingDays, spans);
    const capacity = resolveCapacity(person.profile.capacityPoints, rules.rules, half);
    const mine = byPerson.get(person.userId) ?? [];
    return { person, items: mine, timeOff: spans, result: computeWorkload({ items: mine, capacity, rules: rules.rules, now, today, supportTargetsEnabled }) };
  });
  return { now, today, timeZone, dates, rules, supportTargetsEnabled, people: loads, orphaned };
}
