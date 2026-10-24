import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { getAgencyProject, recordHandover, saveMilestone, setMilestoneStatus, setProjectTerms, updateProjectStatus } from "@/server/projects/agency";
import { getProject } from "@/server/projects/client";
import { resetRateLimits } from "./support/support-world";
import { approvedProject, projectsWorld, type ProjectsWorld } from "./support/projects-world";

// What the team records about a project's revisions and support period, what the handover fixes, and what the client then reads. Nothing is assumed when the quote is silent.

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
});
beforeEach(resetRateLimits);
afterEach(async () => {
  vi.useRealTimers();
  await withSystem((db) => db.query("delete from agency_user_permission_overrides"));
});

const rows = async (sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
const terms = async (projectId: string) => (await rows("select warranty_days, warranty_ends_on::text as warranty_ends_on, revisions_included, revisions_used from client_projects where request_id = $1", [projectId]))[0];
const NOTES = "Delivered the voice agent and wrote the usage guide.";

/** A project the team has finished building and put up for the client's review. */
async function readyProject(title: string) {
  const { id } = await approvedProject(w, title, { start: true });
  await saveMilestone(w.agency.staff, id, { title: "Everything built", requiresClientApproval: false });
  const milestone = (await getAgencyProject(w.agency.staff, id))!.milestones[0];
  await setMilestoneStatus(w.agency.staff, id, milestone.id, "completed");
  await updateProjectStatus(w.agency.staff, id, { status: "testing" });
  await updateProjectStatus(w.agency.staff, id, { status: "ready_for_review" });
  return id;
}

describe("the numbers the team records while the project is being built", () => {
  it("start empty: nothing is assumed from a quote that is silent", async () => {
    const { id } = await approvedProject(w, "Empty terms project", { start: true });
    expect(await terms(id)).toEqual({ warranty_days: null, warranty_ends_on: null, revisions_included: null, revisions_used: 0 });
    const d = (await getProject(w.ctx.owner, id))!.delivery!;
    expect(d).toMatchObject({ warrantyDays: null, warrantyEndsOn: null, revisionsIncluded: null, revisionsUsed: 0 });
  });

  it("are recorded by the team, changed while the project is open, and cleared again", async () => {
    const { id } = await approvedProject(w, "Record terms project", { start: true });
    await setProjectTerms(w.agency.staff, id, { revisionsIncluded: 3, warrantyDays: 30 });
    expect(await terms(id)).toMatchObject({ revisions_included: 3, warranty_days: 30, warranty_ends_on: null });
    await setProjectTerms(w.agency.staff, id, { revisionsIncluded: 5 });
    expect(await terms(id)).toMatchObject({ revisions_included: 5, warranty_days: 30 });
    await setProjectTerms(w.agency.staff, id, { revisionsIncluded: null, warrantyDays: null });
    expect(await terms(id)).toMatchObject({ revisions_included: null, warranty_days: null });
    expect((await rows("select metadata from audit_logs where action = 'project.terms_recorded' and target_id = $1 order by created_at", [id])).length).toBe(3);
  });

  it("are checked: whole numbers in range, never below the revisions already used, and only by someone who manages projects", async () => {
    const { id } = await approvedProject(w, "Terms rules project", { start: true });
    for (const bad of [{ revisionsIncluded: -1 }, { revisionsIncluded: 101 }, { revisionsIncluded: 1.5 }, { warrantyDays: -1 }, { warrantyDays: 3651 }, { warrantyDays: 2.5 }]) {
      await expect(setProjectTerms(w.agency.staff, id, bad), JSON.stringify(bad)).rejects.toMatchObject({ code: "invalid_input" });
    }
    await withSystem((db) => db.query("update client_projects set revisions_included = 3, revisions_used = 2 where request_id = $1", [id]));
    await expect(setProjectTerms(w.agency.staff, id, { revisionsIncluded: 1 })).rejects.toThrow(/2 revisions are already used/);
    await expect(setProjectTerms(w.agency.staff, id, { revisionsIncluded: 2 })).resolves.toBeUndefined();
    await updateAgencyUserPermission(w.agency.superAdmin, { userId: w.raw.watcher.id, permission: "projects.manage" as never, effect: "deny" });
    await expect(setProjectTerms(w.agency.watcher, id, { revisionsIncluded: 9 })).rejects.toMatchObject({ code: "forbidden" });
    await expect(setProjectTerms(w.agency.outStaff, id, { revisionsIncluded: 9 })).rejects.toMatchObject({ code: "not_found" });
    expect((await terms(id)).revisions_included).toBe(2);
  });

  it("need an agreed project, and are fixed once it is handed over", async () => {
    const quotedOnly = await approvedProject(w, "Fixed terms project", { start: true });
    await withSystem((db) => db.query("delete from project_change_orders where request_id = $1", [quotedOnly.id]));
    const id = await readyProject("Handed over terms project");
    await recordHandover(w.agency.staff, id, NOTES);
    await expect(setProjectTerms(w.agency.staff, id, { revisionsIncluded: 2 })).rejects.toThrow(/fixed when it was handed over/);
  });
});

describe("the handover", () => {
  it("fixes the support period from the day of handover in the workspace's own calendar, and the client reads the date", async () => {
    // 20:00 UTC on 24 October is already the 25th in Auckland.
    await withSystem((db) => db.query("update organizations set timezone = 'Pacific/Auckland' where id = $1", [w.org.id]));
    try {
      const id = await readyProject("Calendar project");
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-24T20:00:00Z"));
      await recordHandover(w.agency.staff, id, NOTES, { warrantyDays: 10, revisionsIncluded: 4 });
      expect(await terms(id)).toMatchObject({ warranty_days: 10, warranty_ends_on: "2026-11-04", revisions_included: 4, revisions_used: 0 });
      const view = (await getProject(w.ctx.owner, id))!.delivery!;
      expect(view).toMatchObject({ warrantyDays: 10, warrantyEndsOn: "2026-11-04", revisionsIncluded: 4 });
      expect(view.completedAt).not.toBeNull();
    } finally {
      vi.useRealTimers();
      await withSystem((db) => db.query("update organizations set timezone = 'UTC' where id = $1", [w.org.id]));
    }
  });

  it("keeps what was recorded earlier when the handover form says nothing, and states no period when none was recorded", async () => {
    const earlier = await readyProject("Earlier terms project");
    await setProjectTerms(w.agency.staff, earlier, { warrantyDays: 14, revisionsIncluded: 2 });
    await recordHandover(w.agency.staff, earlier, NOTES);
    const kept = await terms(earlier);
    expect(kept).toMatchObject({ warranty_days: 14, revisions_included: 2 });
    expect(kept.warranty_ends_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const silent = await readyProject("Silent terms project");
    await recordHandover(w.agency.staff, silent, NOTES);
    expect(await terms(silent)).toEqual({ warranty_days: null, warranty_ends_on: null, revisions_included: null, revisions_used: 0 });
  });

  it("lets the handover form set a period of zero days, which ends the same day", async () => {
    const id = await readyProject("Zero day project");
    await recordHandover(w.agency.staff, id, NOTES, { warrantyDays: 0 });
    const t = await terms(id);
    expect(t.warranty_days).toBe(0);
    expect(t.warranty_ends_on).toBe(new Date().toISOString().slice(0, 10));
  });

  it("refuses numbers that cannot be right, and a revisions-included below the revisions used, without completing the project", async () => {
    const id = await readyProject("Handover rules project");
    await expect(recordHandover(w.agency.staff, id, NOTES, { warrantyDays: -3 })).rejects.toMatchObject({ code: "invalid_input" });
    await withSystem((db) => db.query("update client_projects set revisions_included = 3, revisions_used = 3 where request_id = $1", [id]));
    await expect(recordHandover(w.agency.staff, id, NOTES, { revisionsIncluded: 1 })).rejects.toThrow(/3 revisions are already used/);
    expect((await rows("select status from client_project_requests where id = $1", [id]))[0].status).toBe("ready_for_review");
    expect((await rows("select completed_at from client_projects where request_id = $1", [id]))[0].completed_at).toBeNull();
    await expect(recordHandover(w.agency.staff, id, NOTES)).resolves.toBeUndefined();
  });

  it("is refused before the project is ready for review, or without notes, and only completes once", async () => {
    const { id } = await approvedProject(w, "Early handover project", { start: true });
    await expect(recordHandover(w.agency.staff, id, NOTES)).rejects.toThrow(/Ready for Review/);
    const ready = await readyProject("Once handover project");
    await expect(recordHandover(w.agency.staff, ready, "short")).rejects.toMatchObject({ code: "invalid_input" });
    await recordHandover(w.agency.staff, ready, NOTES);
    await expect(recordHandover(w.agency.staff, ready, NOTES)).rejects.toThrow(/Ready for Review/);
  });

  it("shows a finished project its support period and links to report an issue with it or share feedback, with that project attached", async () => {
    const id = await readyProject("Closed project");
    await recordHandover(w.agency.staff, id, NOTES, { warrantyDays: 30 });
    const closed = (await getProject(w.ctx.owner, id))!;
    expect(closed.request.status).toBe("completed");
    expect(closed.delivery!.warrantyEndsOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A second workspace never sees it.
    expect(await getProject(w.ctx.outsider, id)).toBeNull();
  });
});
