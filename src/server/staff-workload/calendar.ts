import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { buildCalendar, type CalendarMilestone, type WorkloadCalendar } from "@/lib/staff-workload/calendar";
import type { WorkItem } from "@/lib/staff-workload/sources";
import { canSeeItem, splitVisible } from "@/lib/staff-workload/visibility";
import { loadWorkloadActor, throttle, type StaffUser } from "@/server/staff-workload/access";
import { computeTeam } from "@/server/staff-workload/engine";
import { loadMilestones, loadWorkItems } from "@/server/staff-workload/projection";
import { itemAccess } from "@/server/staff-workload/view";

// The workload calendar a holder of the team permission sees: the days of the planning horizon, the dated work and project milestones on each, what is already overdue,
// and the open items nobody dated. It reads the same items and the same access rules as the board; an item or milestone for a client the viewer cannot open is counted in
// `hidden`, never named.

export interface TeamCalendar {
  today: string;
  timeZone: string;
  dates: string[];
  calendar: WorkloadCalendar;
  hidden: number;
}

export async function loadTeamCalendar(user: StaffUser, opts: { now?: Date } = {}): Promise<TeamCalendar> {
  const actor = await loadWorkloadActor(user);
  if (!actor.caps.team) throw new AppError("forbidden", "Seeing the whole team's workload needs the workload team permission.");
  await throttle("staffWorkloadReadByUser", user.id);
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const team = await computeTeam(db, now);
    const unassigned = await loadWorkItems(db, { kind: "unassigned" });
    const milestones = await loadMilestones(db);
    const items: WorkItem[] = [...team.people.flatMap((p) => p.items), ...unassigned.items];
    const access = await itemAccess(db, actor.userId, [...items, ...milestones.map((m) => ({ orgId: m.orgId }))]);
    const visibleItems = splitVisible(items, access);
    const visibleMilestones: CalendarMilestone[] = [];
    let hidden = visibleItems.hidden;
    for (const milestone of milestones) {
      if (canSeeItem(access, { source: "project", orgId: milestone.orgId, assigneeId: milestone.assigneeId })) visibleMilestones.push(milestone);
      else hidden += 1;
    }
    const range = { from: team.dates[0], to: team.dates[team.dates.length - 1] };
    return {
      today: team.today,
      timeZone: team.timeZone,
      dates: team.dates,
      calendar: buildCalendar(visibleItems.visible, visibleMilestones, range, now, team.timeZone),
      hidden,
    };
  });
}
