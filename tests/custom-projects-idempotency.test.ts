import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { loadSupportSettings, updateSupportSettings } from "@/server/support/settings";
import { createProjectRequest, postClientMessage } from "@/server/projects/client";
import { getAgencyProject } from "@/server/projects/agency";
import { notificationsFor, resetRateLimits } from "./support/support-world";
import { approvedProject, projectInput, projectsWorld, type ProjectsWorld } from "./support/projects-world";

// A form sent twice (a double click, a dropped connection) makes one request and one message, and announces it once. Without a key nothing changes.

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
});
beforeEach(resetRateLimits);

const rows = async (sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
const count = async (sql: string, params: unknown[] = []) => (await rows(`select count(*)::int as n from (${sql}) x`, params))[0].n as number;

describe("a project request sent twice", () => {
  it("is one request with one set of answers, one review task and one notice to the team", async () => {
    const key = "project-form-0001";
    const first = await createProjectRequest(w.ctx.owner, { ...projectInput("Sent twice"), idempotencyKey: key });
    const second = await createProjectRequest(w.ctx.owner, { ...projectInput("Sent twice"), idempotencyKey: key });
    expect(second).toMatchObject({ id: first.id, ref: first.ref, existing: true });
    expect(first.existing).toBeUndefined();
    expect(await count("select 1 from client_project_requests where idempotency_key = $1", [key])).toBe(1);
    expect(await count("select 1 from project_requirements where request_id = $1", [first.id])).toBe(7);
    expect(await count("select 1 from project_review_tasks where request_id = $1", [first.id])).toBe(1);
    expect(await count("select 1 from project_updates where request_id = $1", [first.id])).toBe(1);
    expect((await notificationsFor(w.raw.staff.id, "project_submitted")).filter((n) => n.dedupe_key === `project:${first.id}:submitted`)).toHaveLength(1);
  });

  it("is one request when two sends arrive at the same moment", async () => {
    const key = "project-form-0002";
    const [a, b] = await Promise.all([createProjectRequest(w.ctx.owner, { ...projectInput("Sent at once"), idempotencyKey: key }), createProjectRequest(w.ctx.owner, { ...projectInput("Sent at once"), idempotencyKey: key })]);
    expect(a.id).toBe(b.id);
    expect(await count("select 1 from client_project_requests where idempotency_key = $1", [key])).toBe(1);
    expect(await count("select 1 from project_requirements where request_id = $1", [a.id])).toBe(7);
    expect(await count("select 1 from project_review_tasks where request_id = $1", [a.id])).toBe(1);
  });

  it("belongs to the person who sent it: the same key from someone else makes its own request", async () => {
    const key = "project-form-0003";
    const owner = await createProjectRequest(w.ctx.owner, { ...projectInput("Mine"), idempotencyKey: key });
    const admin = await createProjectRequest(w.ctx.admin, { ...projectInput("Mine too"), idempotencyKey: key });
    expect(admin.id).not.toBe(owner.id);
    expect(admin.existing).toBeUndefined();
    expect(await count("select 1 from client_project_requests where idempotency_key = $1", [key])).toBe(2);
  });

  it("keeps working without a key, and checks the key's length", async () => {
    const a = await createProjectRequest(w.ctx.owner, projectInput("No key one"));
    const b = await createProjectRequest(w.ctx.owner, projectInput("No key one"));
    expect(b.id).not.toBe(a.id);
    await expect(createProjectRequest(w.ctx.owner, { ...projectInput("Short key"), idempotencyKey: "short" })).rejects.toThrow();
    expect(await count("select 1 from client_project_requests where title = 'Short key'")).toBe(0);
  });

  it("does not use up the person's hourly allowance for a repeat", async () => {
    const key = "project-form-0004";
    await createProjectRequest(w.ctx.admin, { ...projectInput("Allowance"), idempotencyKey: key });
    for (let i = 0; i < 20; i += 1) expect(await createProjectRequest(w.ctx.admin, { ...projectInput("Allowance"), idempotencyKey: key })).toMatchObject({ existing: true });
  });
});

describe("a project message sent twice", () => {
  const id = "3f1a7e0e-6a43-4a43-9a58-8d6d1b6f9a11";

  it("is one message, one task for the team and one notice", async () => {
    const { id: projectId } = await approvedProject(w, "Message twice project", { start: true });
    const first = await postClientMessage(w.ctx.owner, projectId, "Could we meet on Thursday to go through the build?", id);
    const second = await postClientMessage(w.ctx.owner, projectId, "Could we meet on Thursday to go through the build?", id);
    expect(first.existing).toBe(false);
    expect(second).toEqual({ id: first.id, existing: true });
    expect(await count("select 1 from project_messages where request_id = $1 and client_message_id = $2", [projectId, id])).toBe(1);
    expect(await count("select 1 from project_review_tasks where request_id = $1 and kind = 'respond_to_client'", [projectId])).toBe(1);
    expect((await notificationsFor(w.raw.staff.id, "project_message")).filter((n) => n.dedupe_key === `project:${projectId}:message:${first.id}`)).toHaveLength(1);
    expect((await getAgencyProject(w.agency.staff, projectId))!.messages.filter((m) => m.authorKind === "client")).toHaveLength(1);
  });

  it("is one message when two sends arrive at the same moment, and a new id is a new message", async () => {
    const { id: projectId } = await approvedProject(w, "Message at once project", { start: true });
    const same = "3f1a7e0e-6a43-4a43-9a58-8d6d1b6f9a12";
    const [a, b] = await Promise.all([postClientMessage(w.ctx.owner, projectId, "Sent twice at once.", same), postClientMessage(w.ctx.owner, projectId, "Sent twice at once.", same)]);
    expect(a.id).toBe(b.id);
    expect(await count("select 1 from project_messages where request_id = $1 and client_message_id = $2", [projectId, same])).toBe(1);
    expect(await count("select 1 from project_review_tasks where request_id = $1 and kind = 'respond_to_client'", [projectId])).toBe(1);
    const other = await postClientMessage(w.ctx.owner, projectId, "A different message.", "3f1a7e0e-6a43-4a43-9a58-8d6d1b6f9a13");
    expect(other.id).not.toBe(a.id);
  });

  it("keeps a repeat inside the person's workspace: the same id on another project is a new message, and a bad id is refused", async () => {
    const one = await approvedProject(w, "Same id project one", { start: true });
    const two = await approvedProject(w, "Same id project two", { start: true });
    const shared = "3f1a7e0e-6a43-4a43-9a58-8d6d1b6f9a14";
    const a = await postClientMessage(w.ctx.owner, one.id, "On the first project.", shared);
    const b = await postClientMessage(w.ctx.owner, two.id, "On the second project.", shared);
    expect(b.id).not.toBe(a.id);
    await expect(postClientMessage(w.ctx.owner, one.id, "Bad id.", "not-a-uuid")).rejects.toMatchObject({ code: "invalid_input" });
    // Another workspace's owner cannot learn that a message exists by repeating its id.
    await expect(postClientMessage(w.ctx.outsider, one.id, "Probing.", shared)).rejects.toMatchObject({ code: "not_found" });
    expect(await count("select 1 from project_messages where request_id = $1", [one.id])).toBe(1);
  });

  it("still works without an id, as before", async () => {
    const { id: projectId } = await approvedProject(w, "No id project", { start: true });
    const a = await postClientMessage(w.ctx.owner, projectId, "First without an id.");
    const b = await postClientMessage(w.ctx.owner, projectId, "Second without an id.");
    expect(a.id).not.toBe(b.id);
    expect(await count("select 1 from project_messages where request_id = $1", [projectId])).toBe(2);
  });
});

describe("the first look at a new request", () => {
  it("is due in two days unless a Super Admin set a target in hours", async () => {
    const dueHours = async (id: string) => Number((await rows("select extract(epoch from (due_at - created_at)) / 3600 as h from project_review_tasks where request_id = $1 and kind = 'initial_review'", [id]))[0].h);
    const plain = await createProjectRequest(w.ctx.owner, projectInput("Default target"));
    expect(Math.round(await dueHours(plain.id))).toBe(48);
    const s = await loadSupportSettings();
    const saved = await updateSupportSettings(w.agency.superAdmin, { projectReviewTargetHours: 4 }, s.revision);
    try {
      const targeted = await createProjectRequest(w.ctx.owner, projectInput("Set target"));
      expect(Math.round(await dueHours(targeted.id))).toBe(4);
    } finally {
      await updateSupportSettings(w.agency.superAdmin, { projectReviewTargetHours: null, showProjectTargetsToClients: false }, saved.revision);
    }
  });
});
