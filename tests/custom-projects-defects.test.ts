import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { notifyAgency } from "@/server/notifications";
import {
  addProgressUpdate, assignProject, deleteMilestone, getAgencyProject, postAgencyMessage, recordHandover, saveMilestone, saveQuoteDraft, sendQuote, setMilestoneStatus, updateProjectStatus,
} from "@/server/projects/agency";
import { createProjectRequest, decideQuote, getProject, listProjects, markQuoteViewed, postClientMessage, respondToMilestone } from "@/server/projects/client";
import { addMember, agencyUser, createUser } from "./support/fixtures";
import { notificationsFor, resetRateLimits } from "./support/support-world";
import { approvedProject, fullQuote, projectInput, projectsWorld, quotedProject, type ProjectsWorld } from "./support/projects-world";

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
});
beforeEach(resetRateLimits);

const deny = (userId: string, permission: string) => updateAgencyUserPermission(w.agency.superAdmin, { userId, permission: permission as never, effect: "deny" });
const clearOverrides = (userId: string) => withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = $1", [userId]));
const milestoneRow = async (id: string) => (await withSystem((db) => db.query<{ title: string; description: string | null; due_on: string | null; requires_client_approval: boolean; client_approved_at: Date | null; status: string }>(
  "select title, description, due_on::text as due_on, requires_client_approval, client_approved_at, status from project_milestones where id = $1", [id],
))).rows[0];
const milestonesOf = async (projectId: string) => (await getAgencyProject(w.agency.staff, projectId))!.milestones;

describe("a milestone the client approved or the team completed is protected", () => {
  it("cannot be deleted once the client approved it, and the approval stays on record", async () => {
    const { id } = await approvedProject(w, "Milestone approval project", { start: true });
    await saveMilestone(w.agency.staff, id, { title: "Voice agent build", description: "Build the agent", requiresClientApproval: true });
    const m = (await milestonesOf(id))[0];
    await setMilestoneStatus(w.agency.staff, id, m.id, "awaiting_approval");
    await respondToMilestone(w.ctx.owner, m.id, "approve", "Looks right.");
    expect((await milestoneRow(m.id)).client_approved_at).not.toBeNull();

    await expect(deleteMilestone(w.agency.staff, id, m.id)).rejects.toThrow(/already approved/);
    const after = await milestoneRow(m.id);
    expect(after).toMatchObject({ title: "Voice agent build", status: "completed" });
    expect(after.client_approved_at).not.toBeNull();
  });

  it("cannot be deleted once it is completed, even if it never needed the client's approval", async () => {
    const { id } = await approvedProject(w, "Milestone completed project", { start: true });
    await saveMilestone(w.agency.staff, id, { title: "Discovery", requiresClientApproval: false });
    const m = (await milestonesOf(id))[0];
    await setMilestoneStatus(w.agency.staff, id, m.id, "completed");
    await expect(deleteMilestone(w.agency.staff, id, m.id)).rejects.toThrow(/completed/);
    expect(await milestoneRow(m.id)).toMatchObject({ title: "Discovery", status: "completed" });
  });

  it("cannot have its wording or its approval rule changed afterwards, but its date and order can move", async () => {
    const { id } = await approvedProject(w, "Milestone wording project", { start: true });
    await saveMilestone(w.agency.staff, id, { title: "Voice agent build", description: "Build the agent", requiresClientApproval: true });
    const m = (await milestonesOf(id))[0];
    await setMilestoneStatus(w.agency.staff, id, m.id, "awaiting_approval");
    await respondToMilestone(w.ctx.owner, m.id, "approve");

    const same = { id: m.id, title: "Voice agent build", description: "Build the agent", requiresClientApproval: true };
    await expect(saveMilestone(w.agency.staff, id, { ...same, title: "Voice agent build and billing" })).rejects.toThrow(/already approved/);
    await expect(saveMilestone(w.agency.staff, id, { ...same, description: "Something else entirely" })).rejects.toThrow(/already approved/);
    await expect(saveMilestone(w.agency.staff, id, { ...same, requiresClientApproval: false })).rejects.toThrow(/already approved/);
    expect(await milestoneRow(m.id)).toMatchObject({ title: "Voice agent build", description: "Build the agent", requires_client_approval: true });

    await saveMilestone(w.agency.staff, id, { ...same, dueOn: "2031-02-03", sortOrder: 5 });
    expect((await milestoneRow(m.id)).due_on).toBe("2031-02-03");
  });

  it("cannot be reworded while the client is being asked to approve it, and can once changes were requested", async () => {
    const { id } = await approvedProject(w, "Milestone pending project", { start: true });
    await saveMilestone(w.agency.staff, id, { title: "Greeting script", description: "Draft", requiresClientApproval: true });
    const m = (await milestonesOf(id))[0];
    await setMilestoneStatus(w.agency.staff, id, m.id, "awaiting_approval");
    await expect(saveMilestone(w.agency.staff, id, { id: m.id, title: "Greeting script v2", description: "Draft", requiresClientApproval: true })).rejects.toThrow(/waiting for the client/);
    await respondToMilestone(w.ctx.owner, m.id, "request_changes", "Please soften the greeting.");
    await saveMilestone(w.agency.staff, id, { id: m.id, title: "Greeting script v2", description: "Softer draft", requiresClientApproval: true });
    expect((await milestoneRow(m.id)).title).toBe("Greeting script v2");
  });

  it("still lets the team remove or reword a milestone nobody has acted on, and the audit row names it", async () => {
    const { id } = await approvedProject(w, "Milestone free project", { start: true });
    await saveMilestone(w.agency.staff, id, { title: "Draft plan", requiresClientApproval: false });
    const m = (await milestonesOf(id))[0];
    await saveMilestone(w.agency.staff, id, { id: m.id, title: "Draft plan, revised", requiresClientApproval: false });
    await deleteMilestone(w.agency.staff, id, m.id);
    expect(await milestonesOf(id)).toHaveLength(0);
    const audit = (await withSystem((db) => db.query<{ metadata: { title?: string } }>("select metadata from audit_logs where target_id = $1 and action = 'project.milestone_removed'", [id]))).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata.title).toBe("Draft plan, revised");
  });

  it("answers not found for a milestone that is not this project's", async () => {
    const a = await approvedProject(w, "Milestone owner project", { start: true });
    const b = await approvedProject(w, "Milestone other project", { start: true });
    await saveMilestone(w.agency.staff, a.id, { title: "Only on A", requiresClientApproval: false });
    const onA = (await milestonesOf(a.id))[0];
    await expect(deleteMilestone(w.agency.staff, b.id, onA.id)).rejects.toThrow(/not found/i);
    expect(await milestoneRow(onA.id)).toBeTruthy();
  });
});

describe("cancelling a project withdraws the quote that was still waiting", () => {
  it("marks a sent quote withdrawn so the client is not shown a quote waiting on a closed project", async () => {
    const { id, quoteId } = await quotedProject(w, "Cancel with a live quote");
    expect((await listProjects(w.ctx.owner)).find((p) => p.id === id)!.quoteWaiting).toBe(true);
    await updateProjectStatus(w.agency.staff, id, { status: "cancelled", reason: "The client changed plans." });
    const status = (await withSystem((db) => db.query<{ status: string }>("select status from project_quotes where id = $1", [quoteId]))).rows[0].status;
    expect(status).toBe("withdrawn");
    expect((await listProjects(w.ctx.owner)).find((p) => p.id === id)!.quoteWaiting).toBe(false);
    await expect(decideQuote(w.ctx.owner, quoteId, "accepted")).rejects.toThrow(/no longer open/);
  });

  it("leaves the quote alone when the project is only put on hold, so it can be decided after the project resumes", async () => {
    const { id, quoteId } = await quotedProject(w, "Hold with a live quote");
    await updateProjectStatus(w.agency.staff, id, { status: "on_hold", reason: "Waiting for the budget." });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from project_quotes where id = $1", [quoteId]))).rows[0].status).toBe("sent");
    await updateProjectStatus(w.agency.staff, id, { resume: true });
    expect((await decideQuote(w.ctx.owner, quoteId, "accepted")).decision).toBe("accepted");
  });

  it("does not touch a quote that was already decided", async () => {
    const { id, quoteId } = await approvedProject(w, "Cancel after acceptance");
    await updateProjectStatus(w.agency.staff, id, { status: "cancelled", reason: "Stopped after the agreement." });
    expect((await withSystem((db) => db.query<{ status: string }>("select status from project_quotes where id = $1", [quoteId]))).rows[0].status).toBe("accepted");
  });
});

describe("project notices go to the people whose permission covers projects, once", () => {
  it("lets notifyAgency name a permission, and keeps its old behaviour when none is named", async () => {
    const project = await approvedProject(w, "Notice permission project");
    await deny(w.raw.watcher.id, "projects.view");
    try {
      const key = `test:permission:${project.id}`;
      await withSystem((db) => notifyAgency(db, w.org.id, { kind: "project_update", title: "Filtered notice", dedupeKey: key }, { permission: "projects.view" }));
      await withSystem((db) => notifyAgency(db, w.org.id, { kind: "project_update", title: "Unfiltered notice", dedupeKey: `${key}:all` }));
      const titles = async (userId: string) => (await notificationsFor(userId, "project_update")).map((n) => n.title);
      expect(await titles(w.raw.staff.id)).toEqual(expect.arrayContaining(["Filtered notice", "Unfiltered notice"]));
      expect(await titles(w.raw.watcher.id)).toContain("Unfiltered notice");
      expect(await titles(w.raw.watcher.id)).not.toContain("Filtered notice");
      expect(await titles(w.raw.outStaff.id)).not.toContain("Filtered notice");
    } finally {
      await clearOverrides(w.raw.watcher.id);
    }
  });

  it("keeps a team member whose projects.view was withdrawn out of a client's new project request and messages", async () => {
    await deny(w.raw.watcher.id, "projects.view");
    try {
      const request = await createProjectRequest(w.ctx.owner, projectInput("Permission filtered request"));
      await postClientMessage(w.ctx.owner, request.id, "A question about the scope.");
      // Earlier tests left notices from before the permission was withdrawn: only this request's own notices count.
      const seen = (await notificationsFor(w.raw.watcher.id)).filter((n) => n.title.startsWith(`${request.ref}:`) || n.link === `/admin/projects/${request.id}`);
      expect(seen).toEqual([]);
      const colleague = (await notificationsFor(w.raw.staff2.id)).filter((n) => n.link === `/admin/projects/${request.id}`);
      expect(colleague.map((n) => n.kind).sort()).toEqual(["project_message", "project_submitted"]);
    } finally {
      await clearOverrides(w.raw.watcher.id);
    }
  });

  it("announces the same event once however many times it is handled", async () => {
    const project = await approvedProject(w, "Replay project");
    const key = `test:replay:${project.id}`;
    for (let i = 0; i < 3; i += 1) await withSystem((db) => notifyAgency(db, w.org.id, { kind: "project_message", title: "Replayed notice", dedupeKey: key }, { permission: "projects.view" }));
    expect((await notificationsFor(w.raw.staff.id, "project_message")).filter((n) => n.title === "Replayed notice")).toHaveLength(1);
  });

  it("gives every notice a project flow sends a dedupe key, so a replayed event is dropped", async () => {
    const owner = w.ctx.owner;
    const request = await createProjectRequest(owner, projectInput("Dedupe key project"));
    await updateProjectStatus(w.agency.staff, request.id, { status: "under_review" });
    await postAgencyMessage(w.agency.staff, request.id, "Which calendar do you use?", { infoRequest: true });
    await postClientMessage(owner, request.id, "Google Calendar.");
    await addProgressUpdate(w.agency.staff, request.id, "Kick-off call booked.", "client");
    await assignProject(w.agency.staff, request.id, w.raw.staff2.id);
    const quote = (await saveQuoteDraft(w.agency.staff, request.id, fullQuote())).id;
    await sendQuote(w.agency.staff, request.id, quote);
    await markQuoteViewed(owner, quote);
    await decideQuote(owner, quote, "accepted");
    await updateProjectStatus(w.agency.staff, request.id, { status: "in_development" });
    await saveMilestone(w.agency.staff, request.id, { title: "Voice agent build", requiresClientApproval: true });
    const m = (await getAgencyProject(w.agency.staff, request.id))!.milestones[0];
    await setMilestoneStatus(w.agency.staff, request.id, m.id, "awaiting_approval");
    await respondToMilestone(owner, m.id, "approve");

    const rows = (await withSystem((db) => db.query<{ kind: string; title: string; dedupe_key: string | null }>(
      "select kind, title, dedupe_key from notifications where link like $1 or link like $2", [`%/${request.id}`, `%/${request.id}?%`],
    ))).rows;
    expect(rows.length).toBeGreaterThan(6);
    expect(rows.filter((r) => !r.dedupe_key).map((r) => `${r.kind}: ${r.title}`)).toEqual([]);
    // The keys name the event, so they differ for different events and never collide across projects.
    expect(new Set(rows.filter((r) => r.kind === "project_update").map((r) => r.dedupe_key)).size).toBeGreaterThan(2);
  });

  it("does not notify again when the same person is assigned twice in a row", async () => {
    const { id } = await approvedProject(w, "Double assignment");
    await assignProject(w.agency.staff, id, w.raw.staff2.id);
    await assignProject(w.agency.staff, id, w.raw.staff2.id);
    const link = `/admin/projects/${id}`;
    expect((await notificationsFor(w.raw.staff2.id, "project_update")).filter((n) => n.link === link)).toHaveLength(1);
  });
});

describe("a client never sees a full name of the iAcquire team", () => {
  it("shows the team's lines to the client without their names, and in full to the team", async () => {
    const { id } = await approvedProject(w, "Team names project");
    await postAgencyMessage(w.agency.staff, id, "We have started the build.");
    await addProgressUpdate(w.agency.staff, id, "The first workflow is running.", "client");
    const client = (await getProject(w.ctx.owner, id))!;
    // A client's session cannot read the team's user rows at all (they share no workspace), so the lines arrive unnamed.
    expect(client.messages.filter((m) => m.authorKind === "agency").map((m) => m.authorName)).toEqual([null]);
    expect(client.updates.some((u) => u.body.includes("first workflow"))).toBe(true);
    expect(JSON.stringify(client)).not.toContain("Staffer");
    const team = (await getAgencyProject(w.agency.staff, id))!;
    expect(team.messages.some((m) => m.authorName === "Stan Staffer")).toBe(true);
    // The client's own colleagues keep their full names.
    expect(client.updates.some((u) => u.authorName === "Olivia Owner")).toBe(true);
  });

  it("reduces a team member the client's session can read to a first name", async () => {
    // A team member who also belongs to the client's workspace is readable by its members: the page still names them by first name only.
    const visitor = await createUser({ platformRole: "agency_staff", name: "Vera Visiting" });
    await addMember(w.org.id, visitor.id, "member");
    await withSystem((db) => db.query("insert into staff_assignments (org_id, user_id, assigned_by) values ($1, $2, $3)", [w.org.id, visitor.id, w.raw.superAdmin.id]));
    const { id } = await approvedProject(w, "Visitor names project");
    await postAgencyMessage(agencyUser(visitor, "agency_staff"), id, "Hello from the team.");
    await addProgressUpdate(agencyUser(visitor, "agency_staff"), id, "A visit is booked.", "client");
    const client = (await getProject(w.ctx.owner, id))!;
    expect(client.messages.filter((m) => m.authorKind === "agency").map((m) => m.authorName)).toEqual(["Vera"]);
    expect(client.updates.filter((u) => u.body.includes("visit is booked")).map((u) => u.authorName)).toEqual(["Vera"]);
    expect(JSON.stringify(client)).not.toContain("Vera Visiting");
    const team = (await getAgencyProject(w.agency.staff, id))!;
    expect(team.messages.some((m) => m.authorName === "Vera Visiting")).toBe(true);
  });
});

describe("a handover still records the project as complete", () => {
  it("is unaffected by the milestone protection", async () => {
    const { id } = await approvedProject(w, "Handover after protection", { start: true });
    await saveMilestone(w.agency.staff, id, { title: "Build", requiresClientApproval: true });
    const m = (await milestonesOf(id))[0];
    await setMilestoneStatus(w.agency.staff, id, m.id, "awaiting_approval");
    await respondToMilestone(w.ctx.owner, m.id, "approve");
    await updateProjectStatus(w.agency.staff, id, { status: "testing" });
    await updateProjectStatus(w.agency.staff, id, { status: "ready_for_review" });
    await recordHandover(w.agency.staff, id, "Delivered with documentation and a walkthrough recording.");
    expect((await getProject(w.ctx.owner, id))!.request.status).toBe("completed");
  });
});
