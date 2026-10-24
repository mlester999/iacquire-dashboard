import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { todayIn } from "@/lib/staff-workload/calendar";
import { HEALTH_STATES, projectHealth, type ProjectHealth, type ProjectHealthState } from "@/lib/staff-workload/health";
import { canSeeItem } from "@/lib/staff-workload/visibility";
import { loadWorkloadActor, throttle, type StaffUser } from "@/server/staff-workload/access";
import { loadAgencyTimeZone } from "@/server/staff-workload/engine";
import { loadHealthFacts } from "@/server/staff-workload/projection";
import { loadRules } from "@/server/staff-workload/settings";
import { itemAccess } from "@/server/staff-workload/view";

// The health of the open custom projects, from rows somebody recorded (src/lib/staff-workload/health.ts has the rule). A project whose client the viewer cannot open, or who lacks
// the permission to view projects, is counted and not shown.

export interface ProjectHealthView {
  requestId: string;
  orgId: string;
  orgName: string;
  ref: string;
  title: string;
  assigneeId: string | null;
  assigneeName: string | null;
  health: ProjectHealth;
}

export interface ProjectsHealth {
  today: string;
  projects: ProjectHealthView[];
  hidden: number;
  byState: Record<ProjectHealthState, number>;
}

const ORDER: Record<ProjectHealthState, number> = { off_track: 0, at_risk: 1, not_enough_data: 2, on_track: 3 };

/** Health of every open project the viewer may see, worst first. The workload team permission. */
export async function loadProjectsHealth(user: StaffUser, opts: { now?: Date } = {}): Promise<ProjectsHealth> {
  const actor = await loadWorkloadActor(user);
  if (!actor.caps.team) throw new AppError("forbidden", "Seeing the whole team's workload needs the workload team permission.");
  await throttle("staffWorkloadReadByUser", user.id);
  const now = opts.now ?? new Date();
  return withSystem(async (db) => {
    const { rules } = await loadRules(db);
    const today = todayIn(now, await loadAgencyTimeZone(db));
    const rows = await loadHealthFacts(db);
    const access = await itemAccess(db, actor.userId, rows);
    const names = new Map<string, string>();
    const assignees = [...new Set(rows.map((r) => r.assigneeId).filter((id): id is string => id !== null))];
    if (assignees.length) {
      const found = await db.query<{ id: string; name: string }>("select id::text, coalesce(nullif(full_name, ''), split_part(email::text, '@', 1)) as name from users where id = any($1::uuid[])", [assignees]);
      for (const n of found.rows) names.set(n.id, n.name);
    }
    const byState = Object.fromEntries(HEALTH_STATES.map((s) => [s, 0])) as Record<ProjectHealthState, number>;
    const projects: ProjectHealthView[] = [];
    let hidden = 0;
    for (const r of rows) {
      if (!canSeeItem(access, { source: "project", orgId: r.orgId, assigneeId: r.assigneeId })) {
        hidden += 1;
        continue;
      }
      const health = projectHealth(r.facts, rules, now, today);
      byState[health.state] += 1;
      projects.push({ requestId: r.requestId, orgId: r.orgId, orgName: r.orgName, ref: r.ref, title: r.title, assigneeId: r.assigneeId, assigneeName: r.assigneeId ? (names.get(r.assigneeId) ?? null) : null, health });
    }
    projects.sort((a, b) => ORDER[a.health.state] - ORDER[b.health.state] || a.ref.localeCompare(b.ref));
    return { today, projects, hidden, byState };
  });
}
