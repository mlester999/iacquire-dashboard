import "server-only";
import { AppError } from "@/server/errors";
import type { StaffUser } from "@/server/staff-workload/access";
import { loadEscalations, type Escalations } from "@/server/staff-workload/escalations";
import { loadProjectsHealth, type ProjectsHealth } from "@/server/staff-workload/projects";
import { loadMyWorkload, loadTeamWorkload, type MyWorkload, type TeamWorkload } from "@/server/staff-workload/view";

// What the workload screens ask for, before a component draws it. The data services already decide what this person may see; this file only decides which of the three
// honest states a page is in: the module is off, the person may see only their own load, or they hold the team permission and get everyone's. A page never catches an
// error into a blank screen: a refused request has a reason the page can show.

export type WorkloadGate =
  | { kind: "off"; canEnable: boolean }
  | { kind: "denied" }
  | { kind: "mine"; mine: MyWorkload }
  | { kind: "team"; team: TeamWorkload };

export type WorkloadHome = Exclude<WorkloadGate, { kind: "team" }> | { kind: "team"; team: TeamWorkload; projects: ProjectsHealth; escalations: Escalations };

const codeOf = (error: unknown): string | null => (error instanceof AppError ? error.code : null);

/**
 * The team view if this person holds the team permission, their own load if they only hold the view permission, and the reason there is nothing when the module is off or
 * they may not use it. `not_enabled` is checked before `forbidden` so a Super Admin who can switch it on is told so rather than being turned away.
 */
export async function loadWorkloadGate(user: StaffUser, opts: { now?: Date } = {}): Promise<WorkloadGate> {
  try {
    return { kind: "team", team: await loadTeamWorkload(user, opts) };
  } catch (error) {
    const code = codeOf(error);
    if (code === "not_enabled") return { kind: "off", canEnable: user.platformRole === "agency_super_admin" };
    if (code !== "forbidden") throw error;
    try {
      return { kind: "mine", mine: await loadMyWorkload(user, opts) };
    } catch (inner) {
      if (codeOf(inner) === "forbidden" || codeOf(inner) === "not_enabled") return { kind: "denied" };
      throw inner;
    }
  }
}

/** The overview: the gate, plus the project health and escalations a holder of the team permission may read. */
export async function loadWorkloadHome(user: StaffUser, opts: { now?: Date } = {}): Promise<WorkloadHome> {
  const gate = await loadWorkloadGate(user, opts);
  if (gate.kind !== "team") return gate;
  const [projects, escalations] = await Promise.all([loadProjectsHealth(user, opts), loadEscalations(user, opts)]);
  return { kind: "team", team: gate.team, projects, escalations };
}
