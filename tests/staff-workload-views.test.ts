import { describe, expect, it } from "vitest";
import { loadMyWorkload, loadTeamWorkload } from "@/server/staff-workload/view";
import { loadTeamCalendar } from "@/server/staff-workload/calendar";
import { loadWorkloadHome } from "@/server/staff-workload/overview";
import { makeTicket, setWorkload, workloadWorld } from "./support/staff-workload";

// The read models behind the workload pages: the off/mine/team decision, what the team view carries, and that a plain staff member cannot ask for the team calendar or
// another person's team board.

describe("the workload pages' read models", () => {
  it("says the module is off before it says anything about anyone's load", async () => {
    const w = await workloadWorld();
    await setWorkload(false);
    const home = await loadWorkloadHome(w.staff);
    expect(home.kind).toBe("off");
    expect(await loadWorkloadHome(w.superAdmin)).toMatchObject({ kind: "off", canEnable: true });
    await setWorkload(true);
  });

  it("gives a plain staff member their own view, a manager the team view, and refuses the team services to the staff member", async () => {
    const w = await workloadWorld();
    const staffHome = await loadWorkloadHome(w.staff);
    expect(staffHome.kind).toBe("mine");
    if (staffHome.kind === "mine") {
      expect(staffHome.mine.me.userId).toBe(w.staff.id);
      expect(staffHome.mine.caps).toMatchObject({ view: true, team: false, assign: false, manage: false, settings: false });
    }
    const managerHome = await loadWorkloadHome(w.manager);
    expect(managerHome.kind).toBe("team");
    if (managerHome.kind === "team") {
      expect(managerHome.team.caps).toMatchObject({ view: true, team: true, assign: true, manage: true });
      expect(managerHome.team.people.map((p) => p.userId)).toEqual(expect.arrayContaining([w.staff.id, w.manager.id]));
      expect(managerHome.projects.projects).toBeInstanceOf(Array);
      expect(managerHome.escalations.entries).toBeInstanceOf(Array);
    }
    await expect(loadTeamWorkload(w.staff)).rejects.toMatchObject({ code: "forbidden" });
    await expect(loadTeamCalendar(w.staff)).rejects.toMatchObject({ code: "forbidden" });
    const mine = await loadMyWorkload(w.staff);
    expect(mine.me.userId).toBe(w.staff.id);
    expect(mine.caps.team).toBe(false);
  });

  it("puts a dated item on the team calendar on its day, and never offers a staff member the team calendar", async () => {
    const w = await workloadWorld();
    const due = new Date(Date.now() + 36 * 3_600_000).toISOString();
    await makeTicket(w.clientA.id, { assignedTo: w.staff.id, subject: "Calendar ticket", dueAt: due });
    const calendar = await loadTeamCalendar(w.manager);
    expect(calendar.dates).toHaveLength(5);
    expect(calendar.calendar.days).toHaveLength(5);
    const titles = calendar.calendar.days.flatMap((d) => d.entries.map((e) => e.title));
    expect(titles).toContain("Calendar ticket");
    await expect(loadTeamCalendar(w.staff)).rejects.toMatchObject({ code: "forbidden" });
  });
});
