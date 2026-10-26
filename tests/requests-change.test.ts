import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { getRequestDetail, submitRequest, listMyRequests } from "@/server/support/service";
import { getAgencyRequest, listAgencyRequests } from "@/server/support/agency";
import { classifyChangeRequest } from "@/server/support/change";
import { loadChangeFormContext } from "@/server/support/change-form";
import { setRequestChangesEnabled } from "@/server/support/change-feature";
import { loadSupportSettings, updateSupportSettings } from "@/server/support/settings";
import { aqiSupportSubmitSchema } from "@/server/aqi/support";
import { getProject } from "@/server/projects/client";
import { updateProjectStatus } from "@/server/projects/agency";
import { allowanceSentence } from "@/lib/support/change";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { countRows, notificationsFor, resetRateLimits } from "./support/support-world";
import { approvedProject, projectsWorld, quotedProject, type ProjectsWorld } from "./support/projects-world";

// Request a Change as a request: the new type and its categories, the dormant switch, what only the team records about one, the project it names, and the entry on the
// project's change list it can also be filed as. Synthetic people and workspaces only.

let w: ProjectsWorld;
beforeAll(async () => {
  w = await projectsWorld();
  await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
});
beforeEach(resetRateLimits);
afterEach(async () => {
  await withSystem((db) => db.query("delete from agency_user_permission_overrides"));
});

const rows = async (sql: string, params: unknown[] = []) => (await withSystem((db) => db.query<Record<string, unknown>>(sql, params))).rows;
const base = { requestType: "change" as const, subject: "Make the greeting warmer", message: "Please change how our AI employee greets new callers on the phone.", category: "change_ai_employee" };
const file = (over: Record<string, unknown> = {}, ctx = w.ctx.owner) => submitRequest(ctx, { ...base, ...over } as never);
const liveProject = (title: string) => approvedProject(w, title, { start: true }).then((p) => p.id);
const changeRecord = async (ticketId: string) => (await rows("select * from support_ticket_change where ticket_id = $1", [ticketId]))[0];

describe("the request type", () => {
  it("opens a change request with its own record of what it is about, a normal priority and the team told once", async () => {
    const r = await file();
    expect(r).toMatchObject({ status: "new", existing: false, changeOrderRef: null });
    const t = (await rows("select * from support_tickets where id = $1", [r.id]))[0];
    expect(t).toMatchObject({ request_type: "change", category: "change_ai_employee", priority: "normal", status: "new", project_id: null, created_by: w.people.owner.id });
    expect(await changeRecord(r.id)).toMatchObject({ target_kind: "ai_employee", project_id: null, classification: null, classified_by: null, org_id: w.org.id });
    const told = await notificationsFor(w.raw.staff.id, "support_ticket_created");
    expect(told.filter((n) => n.dedupe_key?.includes(r.id) || n.link?.includes(r.id))).toHaveLength(1);
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'created'", [r.id])).toBe(1);
  });

  it("reads what a change is about from its category, for each of the six", async () => {
    const targets: Record<string, string> = { change_ai_employee: "ai_employee", change_website: "website", change_automation: "automation", change_integration: "integration", change_other: "other" };
    for (const [category, target] of Object.entries(targets)) {
      const r = await file({ category, subject: `Change about ${target}` });
      expect((await changeRecord(r.id)).target_kind).toBe(target);
    }
  });

  it("keeps the categories of the types apart", async () => {
    await expect(file({ category: "general" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(file({ category: "feature_not_working" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(file({ category: "nonsense" })).rejects.toMatchObject({ code: "invalid_input" });
    // A change category is not a category of any other type.
    for (const requestType of ["support", "issue", "feedback"]) {
      await expect(file({ requestType, category: "change_website", message: "A real description of the problem here.", issue: { happened: "A real description of the problem here." } })).rejects.toMatchObject({ code: "invalid_input" });
    }
  });

  it("is dormant until a Super Admin switches it on for the workspace, and says so", async () => {
    await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, false);
    try {
      await expect(file({ subject: "Dormant switch change" })).rejects.toMatchObject({ code: "not_enabled", message: expect.stringMatching(/Request a Change isn't switched on/) });
      expect(await countRows("select 1 from support_tickets where subject = 'Dormant switch change'")).toBe(0);
      // Every other request type still works, so support never depends on this switch.
      await expect(submitRequest(w.ctx.owner, { subject: "A plain question", message: "How do I add a team member?", category: "account" })).resolves.toMatchObject({ existing: false });
      expect((await loadChangeFormContext(w.ctx.owner)).enabled).toBe(false);
    } finally {
      await setRequestChangesEnabled(w.agency.superAdmin, w.org.id, true);
    }
    expect((await loadChangeFormContext(w.ctx.owner)).enabled).toBe(true);
  });

  it("is switched on per workspace: a second workspace is not affected", async () => {
    await expect(file({}, w.ctx.outsider)).rejects.toMatchObject({ code: "not_enabled" });
    expect(await countRows("select 1 from support_tickets where org_id = $1 and request_type = 'change'", [w.otherOrg.id])).toBe(0);
    expect(await countRows("select 1 from org_features where org_id = $1 and feature = 'request_changes'", [w.otherOrg.id])).toBe(0);
  });

  it("is open to everyone who can open a request, and the viewer who cannot gets the usual refusal", async () => {
    await expect(file({ subject: "From a plain member" }, w.ctx.member)).resolves.toMatchObject({ existing: false });
    const viewer = await createUser({ name: "Vera Viewer" });
    await addMember(w.org.id, viewer.id, "viewer");
    await expect(file({ subject: "From a viewer" }, ctxFor(viewer, w.org, "viewer"))).rejects.toMatchObject({ code: "forbidden" });
    expect(await countRows("select 1 from support_tickets where subject = 'From a viewer'")).toBe(0);
  });

  it("keeps a retry of the same submission to one request and one record", async () => {
    const key = "change-retry-0001";
    const first = await file({ idempotencyKey: key, subject: "Retry this change" });
    const second = await file({ idempotencyKey: key, subject: "Retry this change" });
    expect(second).toMatchObject({ id: first.id, existing: true });
    const [a, b] = await Promise.all([file({ idempotencyKey: "change-retry-0002", subject: "Race this change" }), file({ idempotencyKey: "change-retry-0002", subject: "Race this change" })]);
    expect(a.id).toBe(b.id);
    expect(await countRows("select 1 from support_tickets where idempotency_key = any($1::text[])", [[key, "change-retry-0002"]])).toBe(2);
    expect(await countRows("select 1 from support_ticket_change c join support_tickets t on t.id = c.ticket_id where t.idempotency_key = any($1::text[])", [[key, "change-retry-0002"]])).toBe(2);
  });

  it("takes the starting priority from the settings, and falls back to normal when the saved row has none for a change", async () => {
    expect((await loadSupportSettings()).defaultPriority).toMatchObject({ support: "normal", change: "normal" });
    const rev = (await loadSupportSettings()).revision;
    await updateSupportSettings(w.agency.superAdmin, { defaultPriority: { change: "high" } }, rev);
    try {
      const r = await file({ subject: "Priority from settings" });
      expect((await rows("select priority from support_tickets where id = $1", [r.id]))[0].priority).toBe("high");
    } finally {
      await updateSupportSettings(w.agency.superAdmin, { defaultPriority: { change: "normal" } }, (await loadSupportSettings()).revision);
    }
  });

  it("is not offered to the assistant, which has no target or project to give it", () => {
    const common = { conversationId: "3f1a7e0e-6a43-4a43-9a58-8d6d1b6f9a10", subject: "A change please", description: "Please change the greeting of my AI employee." };
    expect(aqiSupportSubmitSchema.safeParse({ ...common, requestType: "change" }).success).toBe(false);
    expect(aqiSupportSubmitSchema.safeParse({ ...common, requestType: "support" }).success).toBe(true);
  });

  it("appears in My Requests and in the team's queue under its own type, and nowhere in a second workspace", async () => {
    const r = await file({ subject: "Listed change request" });
    const mine = await listMyRequests(w.ctx.owner, { requestType: "change", pageSize: 50 });
    expect(mine.items.map((i) => i.id)).toContain(r.id);
    expect(mine.items.every((i) => i.requestType === "change")).toBe(true);
    const queue = await listAgencyRequests(w.agency.staff, { view: "all", requestType: "change", pageSize: 100 });
    expect(queue.items.map((i) => i.id)).toContain(r.id);
    const theirs = await listMyRequests(w.ctx.outsider, { requestType: "change", pageSize: 50 });
    expect(theirs.items.map((i) => i.id)).not.toContain(r.id);
    expect((await listAgencyRequests(w.agency.outStaff, { view: "all", requestType: "change", pageSize: 100 })).items.map((i) => i.id)).not.toContain(r.id);
  });
});

describe("a change about a project", () => {
  it("needs a project that is the workspace's own and agreed, and every other target must not name one", async () => {
    const projectId = await liveProject("Named project");
    await expect(file({ category: "change_project" })).rejects.toThrow(/Choose the project/);
    await expect(file({ category: "change_website", projectId })).rejects.toThrow(/Choose "A custom project"/);
    await expect(file({ category: "change_project", projectId: "00000000-0000-4000-8000-000000000000" })).rejects.toMatchObject({ code: "not_found" });
    // Another workspace's project reads as not found, even with the same permission.
    await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, true);
    try {
      await expect(file({ category: "change_project", projectId }, w.ctx.outsider)).rejects.toMatchObject({ code: "not_found" });
    } finally {
      await setRequestChangesEnabled(w.agency.superAdmin, w.otherOrg.id, false);
    }
    const quoted = await quotedProject(w, "Still quoted");
    await expect(file({ category: "change_project", projectId: quoted.id })).rejects.toThrow(/once a project is agreed/);
    const cancelled = await liveProject("Cancelled named project");
    await updateProjectStatus(w.agency.staff, cancelled, { status: "cancelled", reason: "The client changed plans" });
    await expect(file({ category: "change_project", projectId: cancelled })).rejects.toThrow(/once a project is agreed/);
    const ok = await file({ category: "change_project", projectId, subject: "Change the project" });
    expect((await rows("select project_id from support_tickets where id = $1", [ok.id]))[0].project_id).toBe(projectId);
    expect(await changeRecord(ok.id)).toMatchObject({ target_kind: "project", project_id: projectId });
    expect((await getProject(w.ctx.owner, projectId))!.tickets.map((t) => t.id)).toContain(ok.id);
  });

  it("is also filed as a change to what was agreed when the owner or an admin asks, as one linked record in one go", async () => {
    const projectId = await liveProject("Linked project");
    const r = await file({ category: "change_project", projectId, asChangeOrder: true, subject: "Add a second calendar", message: "We now have two front desks and each needs its own calendar." });
    expect(r.changeOrderRef).toMatch(/^CHG-\d+$/);
    const order = (await rows("select * from project_change_orders where ticket_id = $1", [r.id]))[0];
    expect(order).toMatchObject({ request_id: projectId, title: "Add a second calendar", status: "submitted", requested_by: w.people.owner.id, ref: r.changeOrderRef });
    expect(await countRows("select 1 from project_change_orders where request_id = $1", [projectId])).toBe(1);
    // The client's request page points at the entry on the project's list; the team's page does too.
    const detail = (await getRequestDetail(w.ctx.owner, r.id))!;
    expect(detail.linkedChange).toMatchObject({ ref: r.changeOrderRef, status: "submitted", projectId });
    const team = (await getAgencyRequest(w.agency.staff, r.id))!;
    expect(team.change?.linked).toMatchObject({ ref: r.changeOrderRef, projectId });
    expect(team.change?.project).toMatchObject({ id: projectId });
    // An admin can too; a member cannot, and nothing is made when the request is refused.
    await expect(file({ category: "change_project", projectId, asChangeOrder: true, subject: "Linked from a member" }, w.ctx.member)).rejects.toMatchObject({ code: "forbidden" });
    await expect(file({ category: "change_project", projectId, asChangeOrder: true, subject: "Linked from an admin" }, w.ctx.admin)).resolves.toMatchObject({ changeOrderRef: expect.stringMatching(/^CHG-/) });
    expect(await countRows("select 1 from support_tickets where subject = 'Linked from a member'")).toBe(0);
  });

  it("keeps a long description whole in the request and shortens it only on the change list", async () => {
    const projectId = await liveProject("Long description project");
    const long = `${"We would like the reminder changed in a number of ways. ".repeat(86)}`.slice(0, 4800);
    const r = await file({ category: "change_project", projectId, asChangeOrder: true, subject: "A very long change", message: long });
    const order = (await rows("select description from project_change_orders where ticket_id = $1", [r.id]))[0];
    expect((order.description as string).length).toBe(4000);
    expect((await rows("select body from support_messages where ticket_id = $1 and author_kind = 'client'", [r.id]))[0].body).toBe(long.trim());
  });

  it("makes one request and one change from a retry, and nothing from a request that is refused half way", async () => {
    const projectId = await liveProject("Linked retry project");
    const key = "linked-retry-0001";
    const a = await file({ category: "change_project", projectId, asChangeOrder: true, idempotencyKey: key, subject: "Linked retry" });
    const b = await file({ category: "change_project", projectId, asChangeOrder: true, idempotencyKey: key, subject: "Linked retry" });
    expect(b).toMatchObject({ id: a.id, existing: true });
    expect(await countRows("select 1 from project_change_orders where request_id = $1", [projectId])).toBe(1);
    // The project cannot take a change (on hold), so neither the request nor the change is kept.
    const held = await liveProject("Held linked project");
    await updateProjectStatus(w.agency.staff, held, { status: "on_hold", reason: "Waiting for the client" });
    await expect(file({ category: "change_project", projectId: held, asChangeOrder: true, subject: "Held linked change" })).rejects.toThrow(/on hold/);
    expect(await countRows("select 1 from project_change_orders where request_id = $1", [held])).toBe(0);
    expect(await countRows("select 1 from support_tickets where subject = 'Held linked change'")).toBe(0);
    expect(await countRows("select 1 from support_ticket_change c join support_tickets t on t.id = c.ticket_id where t.project_id = $1", [held])).toBe(0);
  });

  it("refuses to file as a change when the target is not a project, or the type is not a change", async () => {
    await expect(file({ asChangeOrder: true })).rejects.toThrow(/Only a change to a custom project/);
    await expect(submitRequest(w.ctx.owner, { subject: "A question", message: "How do I do this?", category: "general", asChangeOrder: true })).rejects.toThrow(/Only a change request/);
  });
});

describe("what the team records", () => {
  it("is a classification with a note that only the team can read, with a line on the team's own timeline", async () => {
    const r = await file({ subject: "Classify me" });
    expect(await classifyChangeRequest(w.agency.staff, r.id, { classification: "needs_quote", note: "Several days of work; quote it." })).toEqual({ changed: true });
    expect(await changeRecord(r.id)).toMatchObject({ classification: "needs_quote", classified_by: w.raw.staff.id, resolution_note: "Several days of work; quote it." });
    const event = (await rows("select * from support_ticket_events where ticket_id = $1 and kind = 'change_classified'", [r.id]))[0];
    expect(event).toMatchObject({ visibility: "internal", actor_kind: "agency", to_value: "needs_quote", from_value: null });
    // Saying the same thing again changes nothing; a different answer is a second line.
    expect(await classifyChangeRequest(w.agency.staff, r.id, { classification: "needs_quote", note: "Several days of work; quote it." })).toEqual({ changed: false });
    expect(await classifyChangeRequest(w.agency.staff2, r.id, { classification: "covered" })).toEqual({ changed: true });
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'change_classified'", [r.id])).toBe(2);
    expect((await getAgencyRequest(w.agency.staff, r.id))!.change).toMatchObject({ classification: "covered", classifiedByName: "Sia Staffer", targetKind: "ai_employee" });
    expect(await countRows("select 1 from audit_logs where action = 'support.change_classified' and target_id = $1", [r.id])).toBe(2);
  });

  it("never reaches the client: not the row, not the timeline, not the page, not an export of the request", async () => {
    const r = await file({ subject: "Hidden classification" });
    await classifyChangeRequest(w.agency.staff, r.id, { classification: "out_of_scope", note: "CLASSIFIED-MARKER-4821 we will not do this" });
    // A client's own session reads no row of the team's record at all.
    expect(await withUser(w.people.owner.id, async (db) => (await db.query("select * from support_ticket_change")).rows)).toEqual([]);
    expect(await withUser(w.people.owner.id, async (db) => (await db.query("select * from support_ticket_events where ticket_id = $1 and kind = 'change_classified'", [r.id])).rows)).toEqual([]);
    const detail = (await getRequestDetail(w.ctx.owner, r.id))!;
    expect(JSON.stringify(detail)).not.toMatch(/CLASSIFIED-MARKER|out_of_scope|change_classified/);
    expect(detail.timeline.map((e) => e.kind)).not.toContain("change_classified");
    expect(await withUser(w.people.admin.id, async (db) => (await db.query("select * from support_ticket_change")).rows)).toEqual([]);
    expect(await countRows("select 1 from notifications where title like '%CLASSIFIED-MARKER%' or body like '%CLASSIFIED-MARKER%'")).toBe(0);
    expect(await countRows("select 1 from audit_logs where metadata::text like '%CLASSIFIED-MARKER%'")).toBe(0);
  });

  it("is written only by team members who work on that client and may work its requests", async () => {
    const r = await file({ subject: "Who may classify" });
    await expect(classifyChangeRequest(w.agency.outStaff, r.id, { classification: "covered" })).rejects.toMatchObject({ code: "not_found" });
    await updateAgencyUserPermission(w.agency.superAdmin, { userId: w.raw.staff2.id, permission: "agency.support.manage" as never, effect: "deny" });
    await expect(classifyChangeRequest(w.agency.staff2, r.id, { classification: "covered" })).rejects.toMatchObject({ code: "forbidden" });
    await expect(classifyChangeRequest({ ...w.agency.staff, platformRole: "none" }, r.id, { classification: "covered" })).rejects.toMatchObject({ code: "forbidden" });
    expect((await changeRecord(r.id)).classification).toBeNull();
  });

  it("refuses an unknown classification, a request that is not a change, and a card number in the note", async () => {
    const r = await file({ subject: "Bad inputs" });
    await expect(classifyChangeRequest(w.agency.staff, r.id, { classification: "free" })).rejects.toMatchObject({ code: "invalid_input" });
    await expect(classifyChangeRequest(w.agency.staff, r.id, { classification: "covered", note: "Customer gave 4242 4242 4242 4242" })).rejects.toThrow(/card number/);
    const plain = await submitRequest(w.ctx.owner, { subject: "Just a question", message: "How do I add a user?", category: "account" });
    await expect(classifyChangeRequest(w.agency.staff, plain.id, { classification: "covered" })).rejects.toThrow(/Only a change request/);
    await expect(classifyChangeRequest(w.agency.staff, "not-an-id", { classification: "covered" })).rejects.toMatchObject({ code: "not_found" });
    expect((await changeRecord(r.id)).classification).toBeNull();
  });

  it("is checked by the database: a change record belongs only to a change request and the project that request names", async () => {
    const plain = await submitRequest(w.ctx.owner, { subject: "Plain request", message: "How do I add a user?", category: "account" });
    await expect(withSystem((db) => db.query("insert into support_ticket_change (ticket_id, org_id, target_kind) values ($1, $2, 'other')", [plain.id, w.org.id]))).rejects.toThrow(/only to a Request a Change/);
    // A change that names a project is held to the project the request itself names.
    const projectId = await liveProject("Mismatch project");
    const other = await file({ subject: "Names no project" });
    await expect(withSystem((db) => db.query("delete from support_ticket_change where ticket_id = $1", [other.id]))).resolves.toBeDefined();
    await expect(withSystem((db) => db.query("insert into support_ticket_change (ticket_id, org_id, target_kind, project_id) values ($1, $2, 'project', $3)", [other.id, w.org.id, projectId]))).rejects.toThrow(/only to a Request a Change/);
  });
});

describe("the page's context", () => {
  it("lists the projects a change can be about and who can file one as a change to what was agreed", async () => {
    const live = await liveProject("Context live project");
    const quoted = await quotedProject(w, "Context quoted project");
    const done = await liveProject("Context held project");
    await updateProjectStatus(w.agency.staff, done, { status: "on_hold", reason: "Waiting for the client" });
    const owner = await loadChangeFormContext(w.ctx.owner);
    const byId = new Map(owner.projects.map((p) => [p.id, p]));
    expect(byId.get(live)).toMatchObject({ canFileAsChange: true, status: "in_development" });
    expect(byId.get(done)).toMatchObject({ canFileAsChange: false, status: "on_hold" });
    expect(byId.has(quoted.id)).toBe(false);
    expect(owner.canFileAsChange).toBe(true);
    const member = await loadChangeFormContext(w.ctx.member);
    expect(member.canFileAsChange).toBe(false);
    expect(member.projects.find((p) => p.id === live)?.canFileAsChange).toBe(false);
    // Another workspace's projects are never listed.
    expect((await loadChangeFormContext(w.ctx.outsider)).projects).toEqual([]);
  });

  it("shows an allowance only when an active plan has one, and it is the plan's own number", async () => {
    const org = await createOrg({ name: "Plan Context Co" });
    const owner = await createUser({ name: "Pat Planner" });
    await addMember(org.id, owner.id, "owner");
    const ctx = ctxFor(owner, org, "owner");
    await setRequestChangesEnabled(w.agency.superAdmin, org.id, true);
    expect((await loadChangeFormContext(ctx)).allowance).toBeNull();
    expect(allowanceSentence((await loadChangeFormContext(ctx)).allowance)).toBeNull();
    await withSystem(async (db) => {
      await db.query(
        `insert into maintenance_subscriptions (org_id, status, monthly_price_cents, monthly_request_allowance, terms_version, accepted_by, activated_by, activated_at, billing_start_on, paid_through_on)
         values ($1, 'active', 29900, 7, 'test', $2, $2, now(), current_date, current_date + 30)`, [org.id, owner.id],
      );
    });
    const withPlan = await loadChangeFormContext(ctx);
    expect(withPlan.allowance).toMatchObject({ total: 7, used: 0, remaining: 7 });
    expect(allowanceSentence(withPlan.allowance)).toMatch(/includes 7 managed requests a month \(7 left this month\)/);
    // A plan that was cancelled shows nothing.
    await withSystem((db) => db.query("update maintenance_subscriptions set status = 'cancelled', cancelled_at = now() where org_id = $1", [org.id]));
    expect((await loadChangeFormContext(ctx)).allowance).toBeNull();
  });
});
