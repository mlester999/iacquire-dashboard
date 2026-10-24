// The projectReviewOverdue job: a review task that went past its time is announced to the team once, to the person the project is assigned to or else to the people who manage
// that client's projects. It changes no task, sends nothing outside the portal, repeats nothing a client wrote, has a time budget, and runs through the real tick endpoint only
// when SCHEDULER_JOBS_ONLY names it. Embedded Postgres only; every outbound switch is forced off.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const CRON = "review-overdue-secret-0123456789abcdef0123456789";
process.env.CRON_SECRET = CRON;
process.env.SCHEDULER_ENABLED = "true";
for (const key of ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED", "META_SOCIAL_WRITES_ENABLED", "N8N_ACTIONS_ENABLED", "WORKFORCE_SCHEDULES_ENABLED", "WORKFORCE_TRIGGERS_ENABLED", "WORKFORCE_BRIEFINGS_ENABLED"]) process.env[key] = "false";

import { resetEnvCache } from "@/server/env";
import { POST as tick } from "@/app/api/internal/tick/route";
import { JOBS } from "@/server/ops/tick";
import { JOB_LABELS } from "@/lib/ops";
import { withSystem } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { runProjectReviewOverdue, PROJECT_REVIEW_OVERDUE_BUDGET_MS } from "@/server/projects/jobs";
import { assignProject, completeReviewTask, updateProjectStatus } from "@/server/projects/agency";
import { createProjectRequest } from "@/server/projects/client";
import { notificationsFor, resetRateLimits } from "./support/support-world";
import { projectInput, projectsWorld, type ProjectsWorld } from "./support/projects-world";

let w: ProjectsWorld;
let fetchSpy: ReturnType<typeof vi.spyOn>;
beforeAll(async () => {
  resetEnvCache();
  fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    throw new Error(`network access is not allowed in this test: ${String(input)}`);
  });
  w = await projectsWorld();
});
afterAll(() => fetchSpy.mockRestore());
beforeEach(resetRateLimits);
afterEach(async () => {
  delete process.env.SCHEDULER_JOBS_ONLY;
  resetEnvCache();
  await withSystem((db) => db.query("delete from agency_user_permission_overrides"));
});

const rows = async (sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
/** A new project request with its first review task already past its time. */
async function overdueProject(title: string, hoursLate = 2) {
  const { id } = await createProjectRequest(w.ctx.owner, projectInput(title));
  await withSystem((db) => db.query("update project_review_tasks set due_at = now() - make_interval(hours => $2::int) where request_id = $1 and kind = 'initial_review'", [id, hoursLate]));
  const task = (await rows("select id, due_at from project_review_tasks where request_id = $1 and kind = 'initial_review'", [id]))[0];
  return { id, taskId: task.id as string, dueAt: task.due_at as Date };
}
const overdueNotices = async (userId: string) => (await notificationsFor(userId, "project_review_overdue"));
const setOnly = (value: string | undefined) => {
  if (value === undefined) delete process.env.SCHEDULER_JOBS_ONLY;
  else process.env.SCHEDULER_JOBS_ONLY = value;
  resetEnvCache();
};
async function runTick() {
  await withSystem((db) => db.query("update worker_job_runs set last_finished_at = now() - interval '5 minutes' where job_name = 'scheduler_tick' and last_finished_at is not null"));
  const res = await tick(new Request("http://localhost/api/internal/tick", { method: "POST", headers: { authorization: `Bearer ${CRON}` } }));
  expect(res.status).toBe(200);
  return ((await res.json()) as { ran: Record<string, number | string> }).ran;
}

describe("the job in the registry", () => {
  it("is registered once, every fifteen minutes, with the support jobs, a plain name for the health page and a time budget", () => {
    const names = JOBS.map((j) => j.name);
    expect(names.filter((n) => n === "projectReviewOverdue")).toHaveLength(1);
    expect(JOBS.find((j) => j.name === "projectReviewOverdue")?.everyMinutes).toBe(15);
    expect(names.indexOf("projectReviewOverdue")).toBe(names.indexOf("supportAttachmentCleanup") + 1);
    expect(JOB_LABELS.projectReviewOverdue).toMatch(/custom project reviews/i);
    expect(PROJECT_REVIEW_OVERDUE_BUDGET_MS).toBeLessThan(120_000);
    expect(PROJECT_REVIEW_OVERDUE_BUDGET_MS).toBeGreaterThan(0);
  });
});

describe("who is told, and when", () => {
  it("tells the team members who manage that client's projects once when nobody holds the project, and never again", async () => {
    const { id, taskId } = await overdueProject("Overdue, unassigned");
    expect(await runProjectReviewOverdue()).toBeGreaterThanOrEqual(1);
    for (const person of [w.raw.staff, w.raw.staff2, w.raw.watcher]) {
      const mine = (await overdueNotices(person.id)).filter((n) => n.link === `/admin/projects/${id}`);
      expect(mine, person.id).toHaveLength(1);
      expect(mine[0].dedupe_key).toMatch(new RegExp(`^project:${id}:review-overdue:${taskId}:\\d+$`));
      expect(mine[0].title).toMatch(/is overdue$/);
    }
    // Staff outside the client's scope hear nothing, and a second run announces nothing again.
    expect((await overdueNotices(w.raw.outStaff.id)).filter((n) => n.link === `/admin/projects/${id}`)).toHaveLength(0);
    const before = (await rows("select count(*)::int as n from notifications where kind = 'project_review_overdue'"))[0].n;
    expect(await runProjectReviewOverdue()).toBe(0);
    expect((await rows("select count(*)::int as n from notifications where kind = 'project_review_overdue'"))[0].n).toBe(before);
    expect((await rows("select overdue_notified_at from project_review_tasks where id = $1", [taskId]))[0].overdue_notified_at).not.toBeNull();
  });

  it("tells only the person the project is assigned to, when they still work on that client and may see projects", async () => {
    const { id } = await overdueProject("Overdue, assigned");
    await assignProject(w.agency.superAdmin, id, w.raw.staff2.id);
    await runProjectReviewOverdue();
    const about = (userId: string) => overdueNotices(userId).then((l) => l.filter((n) => n.link === `/admin/projects/${id}`));
    expect(await about(w.raw.staff2.id)).toHaveLength(1);
    expect(await about(w.raw.staff.id)).toHaveLength(0);
    expect(await about(w.raw.watcher.id)).toHaveLength(0);
  });

  it("falls back to the managers when the assignee no longer works on that client, or can no longer see projects", async () => {
    const gone = await overdueProject("Overdue, assignee left");
    await assignProject(w.agency.superAdmin, gone.id, w.raw.staff2.id);
    await withSystem((db) => db.query("delete from staff_assignments where org_id = $1 and user_id = $2", [w.org.id, w.raw.staff2.id]));
    try {
      await runProjectReviewOverdue();
      const told = (userId: string) => overdueNotices(userId).then((l) => l.filter((n) => n.link === `/admin/projects/${gone.id}`));
      expect(await told(w.raw.staff2.id)).toHaveLength(0);
      expect(await told(w.raw.staff.id)).toHaveLength(1);
    } finally {
      await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3) on conflict do nothing", [w.org.id, w.raw.staff2.id, w.raw.superAdmin.id]));
    }
    const blind = await overdueProject("Overdue, assignee cannot see projects");
    await assignProject(w.agency.superAdmin, blind.id, w.raw.staff2.id);
    await updateAgencyUserPermission(w.agency.superAdmin, { userId: w.raw.staff2.id, permission: "projects.view" as never, effect: "deny" });
    await runProjectReviewOverdue();
    // The managers hear of it (and the person who can no longer see projects is not the one singled out as its owner).
    expect((await overdueNotices(w.raw.staff.id)).filter((n) => n.link === `/admin/projects/${blind.id}`)).toHaveLength(1);
  });

  it("says nothing about a task that is not late, was finished, or belongs to a project that is closed or a workspace that is stopped", async () => {
    const early = await createProjectRequest(w.ctx.owner, projectInput("Not late yet"));
    const finished = await overdueProject("Finished in time");
    await completeReviewTask(w.agency.staff, finished.taskId);
    const cancelled = await overdueProject("Cancelled project");
    await updateProjectStatus(w.agency.staff, cancelled.id, { status: "cancelled", reason: "The client changed plans" });
    await withSystem((db) => db.query("update project_review_tasks set status = 'open', completed_at = null where request_id = $1", [cancelled.id]));
    const stopped = await overdueProject("Stopped workspace");
    await withSystem((db) => db.query("update organizations set status = 'suspended' where id = $1", [w.org.id]));
    try {
      const keep = await overdueProject("Overdue in a stopped workspace");
      await runProjectReviewOverdue();
      for (const p of [early, finished, cancelled, stopped, keep]) {
        const id = "id" in p ? (p as { id: string }).id : "";
        expect((await overdueNotices(w.raw.staff.id)).filter((n) => n.link === `/admin/projects/${id}`), id).toHaveLength(0);
      }
    } finally {
      await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [w.org.id]));
    }
    // Once the workspace is back, the late tasks that were skipped are announced, and the one nobody can act on still is not.
    await runProjectReviewOverdue();
    expect((await overdueNotices(w.raw.staff.id)).filter((n) => n.link === `/admin/projects/${stopped.id}`)).toHaveLength(1);
    expect((await overdueNotices(w.raw.staff.id)).filter((n) => n.link === `/admin/projects/${cancelled.id}`)).toHaveLength(0);
  });

  it("names the project and the client, never what the client wrote, and changes no task and writes no client notice", async () => {
    const marker = "CLIENT-WORDS-MARKER-9034";
    const { id } = await overdueProject(`Overdue ${marker}`);
    const task = (await rows("select status, completed_at from project_review_tasks where request_id = $1 and kind = 'initial_review'", [id]))[0];
    await runProjectReviewOverdue();
    const notices = await rows("select title, body, user_id from notifications where kind = 'project_review_overdue' and link = $1", [`/admin/projects/${id}`]);
    expect(notices.length).toBeGreaterThan(0);
    for (const n of notices) {
      expect(`${n.title} ${n.body}`).not.toContain(marker);
      expect(n.body).toBe("Projects Co");
    }
    expect((await rows("select status, completed_at from project_review_tasks where request_id = $1 and kind = 'initial_review'", [id]))[0]).toEqual(task);
    for (const person of [w.people.owner, w.people.admin, w.people.member]) expect(await overdueNotices(person.id)).toEqual([]);
  });

  it("stops at its time budget, leaving the rest for the next run, and loses nothing", async () => {
    const a = await overdueProject("Budget one");
    const b = await overdueProject("Budget two");
    expect(await runProjectReviewOverdue({ budgetMs: 0 })).toBe(0);
    expect((await rows("select count(*)::int as n from project_review_tasks where id = any($1::uuid[]) and overdue_notified_at is null", [[a.taskId, b.taskId]]))[0].n).toBe(2);
    expect(await runProjectReviewOverdue()).toBeGreaterThanOrEqual(2);
    expect((await rows("select count(*)::int as n from project_review_tasks where id = any($1::uuid[]) and overdue_notified_at is null", [[a.taskId, b.taskId]]))[0].n).toBe(0);
  });

  it("works through every workspace's late tasks in one run, not just the busiest one's", async () => {
    // Twelve late tasks in one workspace (more than the per-workspace share of one pass) and one in another.
    const busy = await overdueProject("Many late tasks");
    await withSystem((db) => db.query(
      "insert into project_review_tasks (request_id, org_id, kind, title, due_at) select $1, $2, 'respond_to_client', 'Reply number ' || g, now() - interval '2 hours' from generate_series(1, 11) g", [busy.id, w.org.id],
    ));
    // (Tasks of a cancelled project are never announced, so they are left out of the count.)
    const waiting = async () => (await rows(
      `select count(*)::int as n from project_review_tasks t join client_project_requests r on r.id = t.request_id
       where t.overdue_notified_at is null and t.due_at < now() and t.status = 'open' and r.status not in ('cancelled', 'completed')`,
    ))[0].n;
    expect(await waiting()).toBe(12);
    await withSystem(async (db) => {
      const other = (await db.query<{ id: string }>("insert into client_project_requests (org_id, created_by, title, summary) values ($1, $2, 'Other workspace late project', 'Needs a first look soon.') returning id", [w.otherOrg.id, w.people.outsider.id])).rows[0].id;
      await db.query("insert into project_review_tasks (request_id, org_id, kind, title, due_at) values ($1, $2, 'initial_review', 'Review the other workspace project', now() - interval '3 hours')", [other, w.otherOrg.id]);
    });
    expect(await waiting()).toBe(13);
    expect(await runProjectReviewOverdue()).toBe(13);
    expect(await waiting()).toBe(0);
    // Each task was announced once under its own key.
    expect((await rows("select count(distinct dedupe_key)::int as n from notifications where kind = 'project_review_overdue' and dedupe_key like $1", [`project:${busy.id}:review-overdue:%`]))[0].n).toBe(12);
  });
});

describe("through the real tick endpoint", () => {
  it("does nothing, and writes no heartbeat, while other jobs are the ones named", async () => {
    const { taskId } = await overdueProject("Dormant while others run");
    setOnly("aiWorkRecovery");
    const ran = await runTick();
    expect(Object.keys(ran)).toEqual(["aiWorkRecovery"]);
    expect((await rows("select overdue_notified_at from project_review_tasks where id = $1", [taskId]))[0].overdue_notified_at).toBeNull();
    expect((await rows("select job_name from worker_job_runs where job_name = 'projectReviewOverdue'"))).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs when it is named, announces the late task, then waits out its rhythm and runs again a day later", async () => {
    const { taskId } = await overdueProject("Named in the stage");
    setOnly("projectReviewOverdue");
    const first = await runTick();
    expect(Object.keys(first)).toEqual(["projectReviewOverdue"]);
    expect(first.projectReviewOverdue).toBeGreaterThanOrEqual(1);
    expect((await rows("select overdue_notified_at from project_review_tasks where id = $1", [taskId]))[0].overdue_notified_at).not.toBeNull();
    expect(await runTick()).toEqual({ projectReviewOverdue: "skipped" });
    await withSystem((db) => db.query("update worker_job_runs set last_started_at = now() - interval '2 days', last_finished_at = now() - interval '2 days' where job_name = 'projectReviewOverdue'"));
    expect(await runTick()).toEqual({ projectReviewOverdue: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
