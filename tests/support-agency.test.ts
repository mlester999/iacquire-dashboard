import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { updateAgencyUserPermission } from "@/server/admin/team";
import { getRequestDetail, submitRequest } from "@/server/support/service";
import {
  agencyPostMessage, assignRequest, changePriority, changeRequestStatus, clearEscalation, escalateRequest, getAgencyRequest, linkRequests, listAgencyRequests, mergeRequest, setFeedbackStage,
} from "@/server/support/agency";
import { listAssignableStaff } from "@/server/support/access";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import { countRows, notificationsFor, resetRateLimits, supportWorld, ticketRow, type SupportWorld } from "./support/support-world";
import type { SessionUser } from "@/server/auth/service";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);

const open = async (subject = "A request for the team", ctx = w.ctx.member) => (await submitRequest(ctx, { subject, message: "Please help with this." })).id;
const asUser = (u: { id: string; email: string }, platformRole: SessionUser["platformRole"]): SessionUser => ({ sessionId: "s", id: u.id, email: u.email, fullName: "x", platformRole, timezone: "UTC", preferences: {}, emailVerified: true });
const deny = (userId: string, permission: string) => updateAgencyUserPermission(w.agency.superAdmin, { userId, permission: permission as never, effect: "deny" });
const clearOverrides = (userId: string) => withSystem((db) => db.query("delete from agency_user_permission_overrides where user_id = $1", [userId]));

describe("support permissions are granular and enforced on the server", () => {
  it("gives each agency role its default support actions", async () => {
    const id = await open();
    // Staff can read, reply, add notes, resolve and take a request for themselves.
    await agencyPostMessage(w.agency.staff, id, { body: "Looking into this." });
    await agencyPostMessage(w.agency.staff, id, { body: "Private thought.", internal: true });
    await assignRequest(w.agency.staff, id, w.agency.staff.id);
    // ...but not hand it to others, or change its priority.
    await expect(assignRequest(w.agency.staff, id, w.agency.staff2.id)).rejects.toThrow(/does not allow/);
    await expect(changePriority(w.agency.staff, id, "urgent")).rejects.toThrow(/does not allow/);
    // Managers and Super Admins can.
    await changePriority(w.agency.manager, id, "high");
    await assignRequest(w.agency.manager, id, w.agency.staff2.id);
    expect(await ticketRow(id)).toMatchObject({ priority: "high", assigned_to: w.raw.staff2.id });
    await changePriority(w.agency.superAdmin, id, "normal", "Customer says it is fine");
  });

  it("lets the Super Admin withdraw one action without touching the others", async () => {
    const id = await open();
    await deny(w.raw.staff.id, "agency.support.notes");
    await expect(agencyPostMessage(w.agency.staff, id, { body: "A note", internal: true })).rejects.toThrow(/does not allow/);
    await agencyPostMessage(w.agency.staff, id, { body: "A public reply is still fine." });
    await clearOverrides(w.raw.staff.id);

    await deny(w.raw.staff.id, "agency.support.resolve");
    await expect(changeRequestStatus(w.agency.staff, id, "resolved")).rejects.toThrow(/does not allow/);
    await expect(agencyPostMessage(w.agency.staff, id, { body: "Done.", status: "closed" })).rejects.toThrow(/does not allow/);
    await changeRequestStatus(w.agency.staff, id, "in_progress");
    expect((await ticketRow(id)).status).toBe("in_progress");
    await clearOverrides(w.raw.staff.id);

    await deny(w.raw.staff.id, "agency.support.manage");
    await expect(agencyPostMessage(w.agency.staff, id, { body: "No write grant." })).rejects.toThrow(/does not allow/);
    await expect(changeRequestStatus(w.agency.staff, id, "open")).rejects.toThrow(/does not allow/);
    await clearOverrides(w.raw.staff.id);
  });

  it("limits a person without the full-queue permission to the requests assigned to them", async () => {
    const mine = await open("Assigned to Stan");
    const unassigned = await open("Nobody has this yet");
    await assignRequest(w.agency.superAdmin, mine, w.raw.staff.id);
    await deny(w.raw.staff.id, "agency.support.queue");
    try {
      const list = await listAgencyRequests(w.agency.staff, { view: "all", pageSize: 100 });
      expect(list.items.map((i) => i.id)).toContain(mine);
      expect(list.items.map((i) => i.id)).not.toContain(unassigned);
      expect(await getAgencyRequest(w.agency.staff, unassigned)).toBeNull();
      await expect(agencyPostMessage(w.agency.staff, unassigned, { body: "Not mine." })).rejects.toThrow(/not found/i);
      expect((await getAgencyRequest(w.agency.staff, mine))?.ticket.id).toBe(mine);
      // New requests do not notify someone who cannot see the queue.
      const fresh = await open("Another one for the queue");
      const freshRef = (await ticketRow(fresh)).ref as string;
      expect((await notificationsFor(w.raw.staff.id)).some((n) => n.title.startsWith(freshRef))).toBe(false);
    } finally {
      await clearOverrides(w.raw.staff.id);
    }
  });

  it("refuses staff outside the client's scope and anyone who is not agency staff", async () => {
    const id = await open();
    await expect(agencyPostMessage(w.agency.outStaff, id, { body: "Out of scope." })).rejects.toThrow(/not found/i);
    await expect(changeRequestStatus(w.agency.outStaff, id, "resolved")).rejects.toThrow(/not found/i);
    await expect(changePriority(w.agency.outStaff, id, "urgent")).rejects.toThrow(/not found/i);
    await expect(assignRequest(w.agency.outStaff, id, w.raw.outStaff.id)).rejects.toThrow(/not found/i);
    await expect(escalateRequest(w.agency.outStaff, id, "because")).rejects.toThrow(/not found/i);
    expect(await getAgencyRequest(w.agency.outStaff, id)).toBeNull();
    expect((await listAgencyRequests(w.agency.outStaff, { view: "all", pageSize: 100 })).items.map((i) => i.id)).not.toContain(id);
    // A client user presenting themselves as agency is refused: authorization is re-read from the database.
    const forged = asUser(w.people.owner, "agency_super_admin");
    await expect(listAgencyRequests(forged)).rejects.toThrow(/Agency access|authorization has changed/);
    await expect(agencyPostMessage(forged, id, { body: "I am the agency." })).rejects.toThrow(/Agency access|authorization has changed/);
    const honest = asUser(w.people.owner, "none");
    await expect(agencyPostMessage(honest, id, { body: "I am a client." })).rejects.toThrow(/Agency access/);
    // Nothing a forged caller tried changed the request.
    expect((await ticketRow(id)).status).toBe("new");
  });
});

describe("assignment", () => {
  it("assigns only to people who can work this client's requests, and tells them", async () => {
    const id = await open();
    const stranger = await createUser({ platformRole: "agency_staff" });
    await expect(assignRequest(w.agency.manager, id, w.raw.outStaff.id)).rejects.toThrow(/can't work this client/);
    await expect(assignRequest(w.agency.manager, id, stranger.id)).rejects.toThrow(/can't work this client/);
    await expect(assignRequest(w.agency.manager, id, w.people.member.id)).rejects.toThrow(/can't work this client/);
    await expect(assignRequest(w.agency.manager, id, "not-a-uuid")).rejects.toThrow(/Choose a team member/);
    await deny(w.raw.staff2.id, "agency.support.view");
    await expect(assignRequest(w.agency.manager, id, w.raw.staff2.id)).rejects.toThrow(/can't work this client/);
    await clearOverrides(w.raw.staff2.id);

    await assignRequest(w.agency.manager, id, w.raw.staff2.id);
    expect(await ticketRow(id)).toMatchObject({ assigned_to: w.raw.staff2.id, status: "open" });
    const notices = (await notificationsFor(w.raw.staff2.id, "support_assigned")).filter((n) => n.link === `/admin/support/${id}`);
    expect(notices).toHaveLength(1);
    // The person who made the assignment is not notified of their own action.
    expect((await notificationsFor(w.raw.manager.id, "support_assigned")).filter((n) => n.link === `/admin/support/${id}`)).toHaveLength(0);
    await assignRequest(w.agency.manager, id, w.raw.staff2.id);
    expect((await notificationsFor(w.raw.staff2.id, "support_assigned")).filter((n) => n.link === `/admin/support/${id}`)).toHaveLength(1);

    // The client learns only that someone picked it up, with no name; the team's timeline names people.
    const client = await getRequestDetail(w.ctx.member, id);
    expect(JSON.stringify(client)).not.toMatch(/Sia|Maya|Staff|Manager/);
    expect(client!.timeline.filter((e) => e.kind === "assigned")).toHaveLength(1);
    const team = await getAgencyRequest(w.agency.superAdmin, id);
    expect(team!.timeline.some((e) => e.kind === "assigned" && /Sia/.test(e.to ?? ""))).toBe(true);
    expect(await countRows("select 1 from audit_logs where target_id = $1 and action = 'support.assigned'", [id])).toBe(1);

    await expect(assignRequest(w.agency.staff, id, null)).rejects.toThrow(/does not allow/);
    await assignRequest(w.agency.manager, id, null);
    expect((await ticketRow(id)).assigned_to).toBeNull();
  });

  it("lists assignable people with a real count of their open requests, never a score", async () => {
    const id = await open();
    await assignRequest(w.agency.manager, id, w.raw.staff.id);
    const staff = await listAssignableStaff(w.org.id);
    const ids = staff.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining([w.raw.staff.id, w.raw.staff2.id, w.raw.manager.id, w.raw.superAdmin.id]));
    expect(ids).not.toContain(w.raw.outStaff.id);
    expect(staff.find((s) => s.id === w.raw.staff.id)!.openAssigned).toBeGreaterThanOrEqual(1);
    expect(Object.keys(staff[0]).sort()).toEqual(["id", "name", "openAssigned", "role"]);
  });
});

describe("priority and escalation", () => {
  it("records priority changes for the team only and tells managers when a request is raised", async () => {
    const id = await open();
    await changePriority(w.agency.manager, id, "urgent", "Customer cannot take payments");
    expect((await ticketRow(id)).priority).toBe("urgent");
    expect((await getAgencyRequest(w.agency.superAdmin, id))!.timeline.find((e) => e.kind === "priority_changed")).toMatchObject({ from: "normal", to: "urgent", detail: "Customer cannot take payments" });
    expect((await getRequestDetail(w.ctx.member, id))!.timeline.map((e) => e.kind)).not.toContain("priority_changed");
    // The super admin hears about it; the person who changed it does not.
    expect((await notificationsFor(w.raw.superAdmin.id, "support_escalated")).some((n) => /raised to urgent/.test(n.title))).toBe(true);
    expect((await notificationsFor(w.raw.manager.id, "support_escalated")).some((n) => /raised to urgent/.test(n.title))).toBe(false);
    // Lowering it is recorded without alarming anyone.
    const before = (await notificationsFor(w.raw.superAdmin.id, "support_escalated")).length;
    await changePriority(w.agency.manager, id, "low");
    expect((await notificationsFor(w.raw.superAdmin.id, "support_escalated")).length).toBe(before);
    await expect(changePriority(w.agency.manager, id, "critical" as never)).rejects.toThrow(/Unknown priority/);
  });

  it("escalates once, hides it from the client, and clears only with the priority permission", async () => {
    const id = await open();
    await escalateRequest(w.agency.staff, id, "Client is threatening to leave");
    await escalateRequest(w.agency.staff, id, "Again");
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'escalated'", [id])).toBe(1);
    const team = await getAgencyRequest(w.agency.superAdmin, id);
    expect(team!.ticket.escalation).toMatchObject({ reason: "Client is threatening to leave" });
    expect(JSON.stringify(await getRequestDetail(w.ctx.member, id))).not.toMatch(/threatening|escalat/i);
    expect((await listAgencyRequests(w.agency.superAdmin, { view: "escalated", pageSize: 100 })).items.map((i) => i.id)).toContain(id);
    await expect(clearEscalation(w.agency.staff, id)).rejects.toThrow(/does not allow/);
    await clearEscalation(w.agency.manager, id);
    expect((await getAgencyRequest(w.agency.superAdmin, id))!.ticket.escalation).toBeNull();
    await expect(escalateRequest(w.agency.staff, id, "x")).rejects.toThrow(/briefly why/);
  });
});

describe("status lifecycle", () => {
  it("moves along the lifecycle, stamps resolution and closing, and tells the client", async () => {
    const id = await open();
    await changeRequestStatus(w.agency.staff, id, "in_progress");
    await expect(changeRequestStatus(w.agency.staff, id, "new" as never)).rejects.toThrow(/Unknown status/);
    await changeRequestStatus(w.agency.staff, id, "resolved", "Reconnected your calendar.");
    expect((await ticketRow(id)).resolved_at).not.toBeNull();
    expect((await notificationsFor(w.people.member.id, "support_status")).some((n) => /marked resolved/.test(n.title))).toBe(true);
    await expect(changeRequestStatus(w.agency.staff, id, "in_progress")).rejects.toThrow(/can't move/);
    await changeRequestStatus(w.agency.staff, id, "closed");
    expect((await ticketRow(id)).closed_at).not.toBeNull();
    await changeRequestStatus(w.agency.staff, id, "open");
    expect(await ticketRow(id)).toMatchObject({ status: "open", closed_at: null, resolved_at: null, reopened_count: 1 });
    const kinds = (await getAgencyRequest(w.agency.superAdmin, id))!.timeline.map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(["created", "status_changed", "resolved", "closed", "reopened"]));
  });

  it("sends one notice when a reply also resolves the request, and honours the reply's own text", async () => {
    const id = await open();
    await agencyPostMessage(w.agency.staff, id, { body: "All sorted, closing this out.", status: "resolved" });
    const notices = (await notificationsFor(w.people.member.id)).filter((n) => n.title.includes((/IAQ-\d+/.exec(JSON.stringify(n)) ?? [""])[0]) || true);
    const ref = (await ticketRow(id)).ref as string;
    const forThis = notices.filter((n) => n.title.includes(ref));
    expect(forThis).toHaveLength(1);
    expect(forThis[0].title).toMatch(/marked resolved/);
    expect(forThis[0].body).toMatch(/All sorted/);
  });

  it("uses feedback stages, not raw statuses, for feedback", async () => {
    const f = (await submitRequest(w.ctx.member, { requestType: "feedback", subject: "Show tags in the inbox", message: "Tags would help.", category: "improvement" })).id;
    await expect(changeRequestStatus(w.agency.staff, f, "resolved")).rejects.toThrow(/feedback status control/);
    await setFeedbackStage(w.agency.staff, f, "under_review");
    expect(await ticketRow(f)).toMatchObject({ status: "open", feedback_stage: "under_review" });
    await setFeedbackStage(w.agency.staff, f, "planned", "Scheduled for the next release train.");
    expect(await ticketRow(f)).toMatchObject({ status: "in_progress", feedback_stage: "planned" });
    await setFeedbackStage(w.agency.staff, f, "completed");
    expect(await ticketRow(f)).toMatchObject({ status: "resolved", feedback_stage: "completed" });
    // A finished item can be taken back to an earlier stage; it passes through the reopen path.
    await setFeedbackStage(w.agency.staff, f, "planned");
    expect(await ticketRow(f)).toMatchObject({ status: "in_progress", feedback_stage: "planned", reopened_count: 1 });
    await setFeedbackStage(w.agency.staff, f, "not_planned");
    expect(await ticketRow(f)).toMatchObject({ status: "closed", feedback_stage: "not_planned" });
    const client = await getRequestDetail(w.ctx.member, f);
    expect(client!.ticket.feedbackStage).toBe("not_planned");
    await expect(setFeedbackStage(w.agency.staff, await open(), "planned")).rejects.toThrow(/Only feedback/);
    await deny(w.raw.staff.id, "agency.support.resolve");
    await expect(setFeedbackStage(w.agency.staff, f, "completed")).rejects.toThrow(/does not allow/);
    await clearOverrides(w.raw.staff.id);
  });

  it("closes a reopened request only through the rules: staff need the resolve permission to reopen a closed request", async () => {
    const id = await open();
    await changeRequestStatus(w.agency.superAdmin, id, "closed");
    await deny(w.raw.staff.id, "agency.support.resolve");
    await expect(changeRequestStatus(w.agency.staff, id, "open")).rejects.toThrow(/does not allow/);
    await clearOverrides(w.raw.staff.id);
  });
});

describe("linking and merging", () => {
  it("links and merges requests from the same client only", async () => {
    const a = await open("Calendar broken");
    const b = await open("Calendar not syncing");
    const foreign = (await submitRequest(w.ctx.outsider, { subject: "Other client's request", message: "Belongs elsewhere." })).id;
    await linkRequests(w.agency.staff, a, b, "related");
    await linkRequests(w.agency.staff, a, b, "related");
    expect(await countRows("select 1 from support_ticket_links where ticket_id = $1", [a])).toBe(1);
    await expect(linkRequests(w.agency.superAdmin, a, foreign, "related")).rejects.toThrow(/not found/i);
    await expect(mergeRequest(w.agency.superAdmin, a, foreign)).rejects.toThrow(/not found/i);
    await expect(mergeRequest(w.agency.superAdmin, a, a)).rejects.toThrow(/different request/);
    // The database refuses a cross-client link even if the code were bypassed.
    await expect(withSystem((db) => db.query("insert into support_ticket_links (ticket_id, related_ticket_id, org_id, kind) values ($1, $2, $3, 'related')", [a, foreign, w.org.id]))).rejects.toThrow();

    await expect(mergeRequest(w.agency.staff, a, b)).rejects.toThrow(/does not allow/);
    await mergeRequest(w.agency.manager, a, b);
    expect(await ticketRow(a)).toMatchObject({ status: "closed" });
    expect((await ticketRow(b)).status).toBe("new");
    const detail = await getAgencyRequest(w.agency.superAdmin, a);
    expect(detail!.links.some((l) => l.kind === "merged_into" && l.id === b)).toBe(true);
    const client = await getRequestDetail(w.ctx.member, a);
    expect(client!.messages.at(-1)!.body).toMatch(/merged into IAQ-\d+/);
    expect((await getAgencyRequest(w.agency.superAdmin, b))!.timeline.some((e) => e.kind === "merged")).toBe(true);
    await expect(mergeRequest(w.agency.manager, a, b)).rejects.toThrow(/Only an active/);
  });
});

describe("the team's queue", () => {
  it("filters, searches, sorts and counts what the person may see", async () => {
    const urgent = await open("ZZZ urgent queue item");
    await changePriority(w.agency.superAdmin, urgent, "urgent");
    const waiting = await open("ZZZ waiting queue item");
    await agencyPostMessage(w.agency.staff, waiting, { body: "Which account?" });
    const q = await listAgencyRequests(w.agency.superAdmin, { view: "active", q: "ZZZ", sort: "priority", pageSize: 10 });
    expect(q.items.map((i) => i.id)).toEqual([urgent, waiting]);
    expect(q.items[0].orgName).toBe("Support Co");
    expect((await listAgencyRequests(w.agency.superAdmin, { view: "waiting_on_client", q: "ZZZ" })).items.map((i) => i.id)).toEqual([waiting]);
    expect((await listAgencyRequests(w.agency.superAdmin, { view: "unassigned", q: "ZZZ" })).items.map((i) => i.id)).toEqual([urgent]);
    expect((await listAgencyRequests(w.agency.staff, { view: "mine", q: "ZZZ" })).items.map((i) => i.id)).toEqual([waiting]);
    expect((await listAgencyRequests(w.agency.superAdmin, { priority: "urgent", view: "all", q: "ZZZ" })).items.map((i) => i.id)).toEqual([urgent]);
    expect((await listAgencyRequests(w.agency.superAdmin, { orgId: w.otherOrg.id, view: "all", q: "ZZZ" })).items).toEqual([]);
    const counts = (await listAgencyRequests(w.agency.superAdmin, {})).counts;
    expect(counts.unassigned).toBeGreaterThanOrEqual(1);
    expect(counts.waitingOnClient).toBeGreaterThanOrEqual(1);
    // Page size is honoured and total reflects the whole result.
    const page = await listAgencyRequests(w.agency.superAdmin, { view: "all", pageSize: 3, page: 2 });
    expect(page.items).toHaveLength(3);
    expect(page.total).toBeGreaterThan(3);
  });

  it("flags a request when the client has written since the team last looked", async () => {
    const id = await open("ZZZ client replied");
    await agencyPostMessage(w.agency.staff, id, { body: "Question for you." });
    const before = (await listAgencyRequests(w.agency.staff, { view: "all", q: "ZZZ client replied" })).items[0];
    expect(before.clientWaiting).toBe(false);
    const { clientReply } = await import("@/server/support/service");
    await clientReply(w.ctx.member, id, "Here is the answer.");
    expect((await listAgencyRequests(w.agency.staff, { view: "client_replied", q: "ZZZ client replied" })).items.map((i) => i.id)).toEqual([id]);
  });

  it("keeps a second client's workspace out of the first client's team view", async () => {
    const other = await createOrg({ name: "Third Co" });
    const owner = await createUser();
    await addMember(other.id, owner.id, "owner");
    const id = (await submitRequest(ctxFor(owner, other, "owner"), { subject: "Third company request", message: "Hello from the third company." })).id;
    // Staff assigned to Support Co only never see it; the Super Admin does.
    expect((await listAgencyRequests(w.agency.staff, { view: "all", pageSize: 100 })).items.map((i) => i.id)).not.toContain(id);
    expect((await listAgencyRequests(w.agency.superAdmin, { view: "all", pageSize: 100 })).items.map((i) => i.id)).toContain(id);
  });
});
