import "server-only";
import { withSystem, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { dueDay } from "@/lib/staff-workload/calendar";
import { LABELS, type WorkloadLabel, type WorkloadResult } from "@/lib/staff-workload/labels";
import { COUNTS_ONLY_NOTE, itemPointsCenti, NOT_A_SCORE_NOTE, RULE_STATEMENTS, describeRules, type WorkloadRules } from "@/lib/staff-workload/rules";
import { isOverdue, type DueKind, type WorkItem, type WorkSource } from "@/lib/staff-workload/sources";
import { canSeeAway, canSeeLabelOf, canSeeProfileOf, canSeeTimeOffDetail, ITEM_ACCESS_PERMISSIONS, splitVisible, type ItemAccess } from "@/lib/staff-workload/visibility";
import { loadWorkItems } from "@/server/staff-workload/projection";
import { isId, loadWorkloadActor, throttle, type StaffUser, type WorkloadActor } from "@/server/staff-workload/access";
import { computeTeam, type PersonProfile, type PersonLoad, type TeamLoad } from "@/server/staff-workload/engine";

// What a viewer is shown. The engine rates everyone from all of their work; this file decides what of that a particular viewer may see:
//   * the person's label, points and counts: the person themself and holders of the team permission (never a client, never a peer);
//   * an item's details (title, client): only for a client the viewer can open and only with the permission to read that kind of work. The rest of the person's work still counts
//     in their points, and the viewer is told how many items are not shown ("hidden"), never which;
//   * time off: the person's own and the manage permission's in full; the team permission only learns whether someone is away.
// Every number comes from the same engine the snapshot job uses, so a screen and the history can never disagree about a rule.

export interface ItemView {
  source: WorkSource;
  itemId: string;
  orgId: string;
  orgName: string;
  assigneeId: string | null;
  ref: string | null;
  title: string;
  status: string;
  priority: string | null;
  points: number;
  dueAt: string | null;
  dueOn: string | null;
  dueKind: DueKind | null;
  /** The day it is due in the agency's time zone, or null when nobody set a date. */
  dueDay: string | null;
  overdue: boolean;
  escalated: boolean;
  blocked: boolean;
  waitingOnClient: boolean;
  openReviewTasks: number;
}

export interface PersonView {
  userId: string;
  name: string;
  role: string;
  /** The aggregate over all of the person's work, including what this viewer cannot open. */
  result: WorkloadResult;
  /** Details of the items this viewer may see, most overdue first. */
  items: ItemView[];
  /** How many of the person's items are counted but not shown to this viewer. */
  hiddenItems: number;
  /** Capacity, working days and skills, for the person and the team permission. */
  profile: PersonProfile | null;
  /** Away for every working day of the planning period. Known to the person, the team permission and the manage permission. */
  away: boolean | null;
}

export interface LaneView {
  items: ItemView[];
  hidden: number;
  /** How many exist of each kind, before the list was capped. */
  totals: Record<WorkSource, number>;
}

export interface WorkloadNotes {
  countsOnly: string;
  notAScore: string;
  statements: readonly string[];
}

export interface Frame {
  /** The moment every label on this page was computed from, ISO; relative times use it instead of reading a clock during render. */
  now: string;
  today: string;
  timeZone: string;
  /** The days the planning period covers. */
  dates: string[];
  horizonDays: number;
  rulesRevision: number;
  /** Stored rules that could not be read (the defaults are in force). Empty when all is well. */
  ruleProblems: string[];
  supportTargetsEnabled: boolean;
  /** True when no team default capacity is set: people with no capacity of their own get no label. */
  noTeamDefaultCapacity: boolean;
  notes: WorkloadNotes;
}

const NOTES: WorkloadNotes = { countsOnly: COUNTS_ONLY_NOTE, notAScore: NOT_A_SCORE_NOTE, statements: RULE_STATEMENTS };

function frameOf(team: TeamLoad): Frame {
  return {
    now: team.now.toISOString(),
    today: team.today,
    timeZone: team.timeZone,
    dates: team.dates,
    horizonDays: team.rules.rules.horizonDays,
    rulesRevision: team.rules.revision,
    ruleProblems: team.rules.problems,
    supportTargetsEnabled: team.supportTargetsEnabled,
    noTeamDefaultCapacity: team.rules.rules.defaultCapacityPoints === null,
    notes: NOTES,
  };
}

/** What this viewer can open right now, asked of the database once for every client that appears in the items. */
export async function itemAccess(db: Queryable, viewerId: string, items: ReadonlyArray<Pick<WorkItem, "orgId">>): Promise<ItemAccess> {
  const orgs = [...new Set(items.map((i) => i.orgId))];
  const reachable = orgs.length
    ? (await db.query<{ id: string }>("select o.id::text from unnest($2::uuid[]) as o(id) where app.user_can_access_org($1::uuid, o.id)", [viewerId, orgs])).rows.map((r) => r.id)
    : [];
  const held = (await db.query<{ permission: string }>(
    "select p.permission from unnest($2::text[]) as p(permission) where coalesce(app.user_has_agency_permission($1::uuid, p.permission), false)", [viewerId, [...ITEM_ACCESS_PERMISSIONS]],
  )).rows.map((r) => r.permission);
  return { userId: viewerId, accessibleOrgs: new Set(reachable), permissions: new Set(held) };
}

export function toItemView(item: WorkItem, rules: WorkloadRules, team: Pick<TeamLoad, "now" | "today" | "timeZone">): ItemView {
  return {
    source: item.source,
    itemId: item.itemId,
    orgId: item.orgId,
    orgName: item.orgName,
    assigneeId: item.assigneeId,
    ref: item.ref,
    title: item.title,
    status: item.status,
    priority: item.priority,
    points: itemPointsCenti(item, rules) / 100,
    dueAt: item.dueAt,
    dueOn: item.dueOn,
    dueKind: item.dueKind,
    dueDay: dueDay(item, team.timeZone),
    overdue: isOverdue(item, team.now, team.today),
    escalated: item.escalated,
    blocked: item.blocked,
    waitingOnClient: item.waitingOnClient,
    openReviewTasks: item.openReviewTasks,
  };
}

/** Overdue first, then the soonest due, then the most points, then the oldest: the order a person would work through them. */
function byUrgency(a: ItemView, b: ItemView): number {
  return Number(b.overdue) - Number(a.overdue)
    || (a.dueDay ?? "9999-99-99").localeCompare(b.dueDay ?? "9999-99-99")
    || b.points - a.points
    || a.itemId.localeCompare(b.itemId);
}

function personView(load: PersonLoad, team: TeamLoad, access: ItemAccess, viewer: { userId: string; caps: WorkloadActor["caps"] }): PersonView {
  const { visible, hidden } = splitVisible(load.items, access);
  const subject = load.person.userId;
  return {
    userId: subject,
    name: load.person.name,
    role: load.person.role,
    result: load.result,
    items: visible.map((i) => toItemView(i, team.rules.rules, team)).sort(byUrgency),
    hiddenItems: hidden,
    profile: canSeeProfileOf(viewer, subject) ? load.person.profile : null,
    away: canSeeAway(viewer, subject) ? load.result.away : null,
  };
}

function laneView(team: TeamLoad, access: ItemAccess, items: readonly WorkItem[], totals: Record<WorkSource, number>): LaneView {
  const { visible, hidden } = splitVisible(items, access);
  return { items: visible.map((i) => toItemView(i, team.rules.rules, team)).sort(byUrgency), hidden, totals };
}

export interface MyWorkload {
  frame: Frame;
  /** What this person may do in the module right now; the screens use it to offer only actions the server will accept. */
  caps: WorkloadActor["caps"];
  me: PersonView;
  /** The Rules panel: every number in force, grouped. */
  rules: { groups: ReturnType<typeof describeRules> };
}

/** The signed-in person's own workload. */
export async function loadMyWorkload(user: StaffUser, opts: { now?: Date } = {}): Promise<MyWorkload> {
  const actor = await loadWorkloadActor(user);
  await throttle("staffWorkloadReadByUser", user.id);
  return withSystem(async (db) => {
    const team = await computeTeam(db, opts.now ?? new Date(), { userIds: [actor.userId] });
    const load = team.people[0];
    if (!load) throw new AppError("forbidden", "Agency access is required; authorization has changed.");
    const access = await itemAccess(db, actor.userId, load.items);
    return { frame: frameOf(team), caps: actor.caps, me: personView(load, team, access, actor), rules: { groups: describeRules(team.rules.rules) } };
  });
}

export interface TeamSummary {
  byLabel: Record<WorkloadLabel, number>;
  /** People whose capacity is not set, so they have no label. */
  noLabel: number;
  away: number;
  people: number;
  overdueItems: number;
}

export interface TeamWorkload {
  frame: Frame;
  /** What the viewer may do in the module right now; the screens use it to offer only actions the server will accept. */
  caps: WorkloadActor["caps"];
  people: PersonView[];
  summary: TeamSummary;
  /** Open work nobody holds (of the setup steps, only the ones the agency does). */
  unassigned: LaneView;
  /** Open work held by someone who is no longer an active agency account. */
  orphaned: LaneView;
}

/** Everyone's workload, for a holder of the team permission, with the work nobody holds and the work held by someone who left. */
export async function loadTeamWorkload(user: StaffUser, opts: { now?: Date } = {}): Promise<TeamWorkload> {
  const actor = await loadWorkloadActor(user);
  if (!actor.caps.team) throw new AppError("forbidden", "Seeing the whole team's workload needs the workload team permission.");
  await throttle("staffWorkloadReadByUser", user.id);
  return withSystem(async (db) => {
    const team = await computeTeam(db, opts.now ?? new Date());
    const unassigned = await loadWorkItems(db, { kind: "unassigned" });
    const everything = [...team.people.flatMap((p) => p.items), ...team.orphaned, ...unassigned.items];
    const access = await itemAccess(db, actor.userId, everything);
    const people = team.people.map((p) => personView(p, team, access, actor));
    const byLabel = Object.fromEntries(LABELS.map((l) => [l, 0])) as Record<WorkloadLabel, number>;
    let noLabel = 0;
    for (const p of people) {
      if (p.result.label) byLabel[p.result.label] += 1;
      else noLabel += 1;
    }
    const orphanTotals = { support: 0, setup_task: 0, project: 0, maintenance: 0 } as Record<WorkSource, number>;
    for (const i of team.orphaned) orphanTotals[i.source] += 1;
    return {
      frame: frameOf(team),
      caps: actor.caps,
      people,
      summary: { byLabel, noLabel, away: people.filter((p) => p.away === true).length, people: people.length, overdueItems: people.reduce((n, p) => n + p.result.overdue, 0) },
      unassigned: laneView(team, access, unassigned.items, unassigned.totals),
      orphaned: laneView(team, access, team.orphaned, orphanTotals),
    };
  });
}

export interface PersonWorkload {
  frame: Frame;
  /** What the viewer may do in the module right now; the person page offers editing only when the manage permission is held. */
  caps: WorkloadActor["caps"];
  person: PersonView;
  /** Whether this viewer may read the kind and the note of the person's time off (the person, or the manage permission). */
  timeOffDetail: boolean;
}

/** One person's workload: the signed-in person's own, or anyone's for the team permission. A person the viewer may not see reads as not found, as a made-up id does. */
export async function loadPersonWorkload(user: StaffUser, userId: string, opts: { now?: Date } = {}): Promise<PersonWorkload> {
  const actor = await loadWorkloadActor(user);
  if (!isId(userId) || !canSeeLabelOf(actor, userId)) throw new AppError("not_found", "That person was not found on the agency team.");
  await throttle("staffWorkloadReadByUser", user.id);
  return withSystem(async (db) => {
    const team = await computeTeam(db, opts.now ?? new Date(), { userIds: [userId] });
    const load = team.people[0];
    if (!load) throw new AppError("not_found", "That person was not found on the agency team.");
    const access = await itemAccess(db, actor.userId, load.items);
    return { frame: frameOf(team), caps: actor.caps, person: personView(load, team, access, actor), timeOffDetail: canSeeTimeOffDetail(actor, userId) };
  });
}
