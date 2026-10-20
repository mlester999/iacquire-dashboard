import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import {
  clientReply, countMyRequests, getRequestDetail, listMyRequests, markRequestRead, postClientMessage, reopenRequest, submitRequest,
} from "@/server/support/service";
import { agencyPostMessage, changeRequestStatus, getAgencyRequest, listAgencyRequests } from "@/server/support/agency";
import { updateSupportSettings } from "@/server/support/settings";
import { countRows, notificationsFor, resetRateLimits, supportWorld, ticketRow, type SupportWorld } from "./support/support-world";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);

const key = () => `key-${crypto.randomUUID()}`;

describe("submitting a request", () => {
  it("creates a real request with a reference, a first message, a timeline entry and a notice for the team", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Calendar will not sync", message: "My Google calendar shows no events since Monday.", category: "integrations", pageContext: "/crm/calendar" });
    expect(r.ref).toMatch(/^IAQ-\d+$/);
    expect(r).toMatchObject({ status: "new", existing: false, externalNotification: "not_configured", expectation: null });
    const t = await ticketRow(r.id);
    expect(t).toMatchObject({ status: "new", request_type: "support", category: "integrations", priority: "normal", created_by: w.people.member.id, org_id: w.org.id, page_context: "/crm/calendar", diagnostics: null });
    expect(await countRows("select 1 from support_messages where ticket_id = $1 and author_kind = 'client'", [r.id])).toBe(1);
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'created' and visibility = 'client'", [r.id])).toBe(1);
    const notified = await notificationsFor(w.raw.superAdmin.id, "support_ticket_created");
    expect(notified.some((n) => n.title.startsWith(r.ref) && n.link === `/admin/support/${r.id}`)).toBe(true);
    // Every delivery is on record; the in-app one is "delivered", and nothing claims an email that was never sent.
    const log = await withSystem((db) => db.query<{ channel: string; status: string }>("select channel, status from support_notification_log where ticket_id = $1 and event_kind = 'request_submitted'", [r.id]));
    expect(log.rows.every((l) => l.channel === "in_app" && l.status === "delivered")).toBe(true);
  });

  it("does not notify the client's own people, other clients' staff or staff outside the client's scope", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Who hears about this", message: "Only the right people should be told." });
    for (const outsider of [w.people.owner, w.people.admin, w.people.member, w.people.outsider, w.raw.outStaff]) {
      expect((await notificationsFor(outsider.id)).some((n) => n.title.startsWith(r.ref)), outsider.id).toBe(false);
    }
    expect((await notificationsFor(w.raw.staff.id)).some((n) => n.title.startsWith(r.ref))).toBe(true);
  });

  it("composes an issue report and stores technical details only when the person agrees", async () => {
    const withConsent = await submitRequest(w.ctx.member, {
      requestType: "issue", subject: "Contacts page keeps spinning", category: "feature_not_working", affectedFeature: "crm", clientUrgency: "soon",
      issue: { happened: "The page spins forever.", expected: "A list of contacts.", steps: "Open Contacts, click Filters." },
      shareDiagnostics: true,
      diagnostics: { page: "/crm/contacts?x=1", browser: "Chrome 129", os: "Windows", references: ["err_9f3a21"], authorization: "Bearer abc", apiKey: "sk-live-123456789012345" },
    });
    const t = await ticketRow(withConsent.id);
    expect(t).toMatchObject({ request_type: "issue", category: "feature_not_working", affected_feature: "crm", client_urgency: "soon", priority: "normal" });
    expect(t.diagnostics).toEqual({ page: "/crm/contacts", browser: "Chrome 129", os: "Windows", references: ["err_9f3a21"] });
    const body = (await withSystem((db) => db.query<{ body: string }>("select body from support_messages where ticket_id = $1", [withConsent.id]))).rows[0].body;
    expect(body).toBe("What happened:\nThe page spins forever.\n\nWhat I expected:\nA list of contacts.\n\nSteps to reproduce:\nOpen Contacts, click Filters.");

    const without = await submitRequest(w.ctx.member, {
      requestType: "issue", subject: "Another problem here", category: "performance", issue: { happened: "It is slow." },
      shareDiagnostics: false, diagnostics: { page: "/crm/contacts", browser: "Chrome 129" },
    });
    expect((await ticketRow(without.id)).diagnostics).toBeNull();
  });

  it("never lets a client set the priority the team works to", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Everything is urgent!!!", message: "This is the most urgent thing ever.", priority: "urgent" });
    expect(await ticketRow(r.id)).toMatchObject({ priority: "normal", client_urgency: "blocking" });
  });

  it("starts feedback at 'received' with its own default priority and its own categories", async () => {
    const f = await submitRequest(w.ctx.member, { requestType: "feedback", subject: "Dark mode for the inbox", message: "It would help at night.", category: "feature_suggestion" });
    expect(await ticketRow(f.id)).toMatchObject({ request_type: "feedback", feedback_stage: "received", status: "new", priority: "low" });
    await expect(submitRequest(w.ctx.member, { requestType: "feedback", subject: "Wrong category", message: "This category is a support one.", category: "billing" })).rejects.toThrow(/what this is about/i);
    await expect(submitRequest(w.ctx.member, { requestType: "issue", subject: "Wrong category too", category: "positive_feedback", issue: { happened: "Some problem here." } })).rejects.toThrow(/what this is about/i);
  });

  it("rejects incomplete requests and roles that cannot ask for help", async () => {
    await expect(submitRequest(w.ctx.member, { subject: "ab", message: "Long enough message." })).rejects.toThrow(/short title/i);
    await expect(submitRequest(w.ctx.member, { subject: "A fine subject", message: "hi" })).rejects.toThrow(/little more/i);
    await expect(submitRequest(w.ctx.member, { requestType: "issue", subject: "A fine subject", category: "other", issue: { expected: "something" } })).rejects.toThrow(/what happened/i);
    await expect(submitRequest(w.ctx.viewer, { subject: "Viewer request", message: "Viewers can't open requests." })).rejects.toThrow(/can't open/i);
  });

  it("returns the same request for a retried submission, even when the copies arrive together", async () => {
    const k = key();
    const input = { subject: "Retry me safely", message: "Double click on Send.", idempotencyKey: k };
    const results = await Promise.all([1, 2, 3, 4, 5].map(() => submitRequest(w.ctx.member, input)));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(results.filter((r) => !r.existing)).toHaveLength(1);
    expect(await countRows("select 1 from support_tickets where idempotency_key = $1", [k])).toBe(1);
    expect(await countRows("select 1 from support_messages where ticket_id = $1", [results[0].id])).toBe(1);
    // A different person using the same key is a different request.
    const other = await submitRequest(w.ctx.member2, input);
    expect(other.id).not.toBe(results[0].id);
  });
});

describe("who can see a request", () => {
  let mine: string;
  let theirs: string;
  beforeAll(async () => {
    mine = (await submitRequest(w.ctx.member, { subject: "Mia's private question", message: "Visible to Mia, owners and managers." })).id;
    theirs = (await submitRequest(w.ctx.member2, { subject: "Max's own question", message: "Visible to Max, owners and managers." })).id;
  });

  it("shows team members only the requests they opened", async () => {
    const miaIds = (await listMyRequests(w.ctx.member, { pageSize: 50 })).items.map((i) => i.id);
    expect(miaIds).toContain(mine);
    expect(miaIds).not.toContain(theirs);
    expect(await getRequestDetail(w.ctx.member, theirs)).toBeNull();
    expect(await getRequestDetail(w.ctx.member2, mine)).toBeNull();
    await expect(postClientMessage(w.ctx.member2, mine, { body: "Hello, this is not my request." })).rejects.toThrow(/not found/i);
    await expect(reopenRequest(w.ctx.member2, mine)).rejects.toThrow(/not found/i);
  });

  it("shows business owners and managers every request in the workspace, with an option to see only their own", async () => {
    for (const ctx of [w.ctx.owner, w.ctx.admin]) {
      const ids = (await listMyRequests(ctx, { pageSize: 50 })).items.map((i) => i.id);
      expect(ids).toEqual(expect.arrayContaining([mine, theirs]));
      expect((await getRequestDetail(ctx, theirs))?.ticket.id).toBe(theirs);
      expect((await listMyRequests(ctx, { pageSize: 50, scope: "mine" })).items.map((i) => i.id)).not.toContain(mine);
    }
  });

  it("keeps every workspace's requests from every other workspace, whatever id is forged", async () => {
    expect(await getRequestDetail(w.ctx.outsider, mine)).toBeNull();
    expect((await listMyRequests(w.ctx.outsider, { pageSize: 50 })).items).toEqual([]);
    await expect(postClientMessage(w.ctx.outsider, mine, { body: "Let me in, please." })).rejects.toThrow(/not found/i);
    // Even a context claiming the wrong organisation is refused by the database itself.
    const rows = await withUser(w.people.outsider.id, (db) => db.query("select id from support_tickets where org_id = $1", [w.org.id]));
    expect(rows.rows).toEqual([]);
    const messages = await withUser(w.people.outsider.id, (db) => db.query("select id from support_messages where org_id = $1", [w.org.id]));
    expect(messages.rows).toEqual([]);
    expect(await getRequestDetail(w.ctx.member, "00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await getRequestDetail(w.ctx.member, "not-a-uuid")).toBeNull();
  });

  it("applies the same rule inside the database for rows, messages, attachments and timeline", async () => {
    const own = await withUser(w.people.member2.id, async (db) => ({
      tickets: (await db.query<{ id: string }>("select id from support_tickets where org_id = $1", [w.org.id])).rows.map((r) => r.id),
      messages: (await db.query<{ ticket_id: string }>("select ticket_id from support_messages where org_id = $1", [w.org.id])).rows.map((r) => r.ticket_id),
      events: (await db.query<{ ticket_id: string }>("select ticket_id from support_ticket_events where org_id = $1", [w.org.id])).rows.map((r) => r.ticket_id),
    }));
    expect(own.tickets).toContain(theirs);
    expect(own.tickets).not.toContain(mine);
    expect(own.messages).not.toContain(mine);
    expect(own.events).not.toContain(mine);
    const viewer = await withUser(w.people.viewer.id, (db) => db.query("select id from support_tickets where org_id = $1", [w.org.id]));
    expect(viewer.rows).toEqual([]);
  });

  it("counts and filters only what the person may see", async () => {
    const counts = await countMyRequests(w.ctx.member2);
    expect(counts.all).toBe((await listMyRequests(w.ctx.member2, { pageSize: 50 })).total);
    const page = await listMyRequests(w.ctx.owner, { pageSize: 2, page: 2, sort: "oldest" });
    expect(page.page).toBe(2);
    expect(page.items).toHaveLength(2);
    expect(page.total).toBeGreaterThan(4);
    const issues = await listMyRequests(w.ctx.owner, { requestType: "issue", pageSize: 50 });
    expect(issues.items.every((i) => i.requestType === "issue")).toBe(true);
    const found = await listMyRequests(w.ctx.owner, { q: "Max's own", pageSize: 50 });
    expect(found.items.map((i) => i.id)).toEqual([theirs]);
    expect((await listMyRequests(w.ctx.owner, { q: "100%", pageSize: 50 })).items).toEqual([]);
  });
});

describe("the conversation", () => {
  it("keeps internal notes away from the client everywhere", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Notes stay private", message: "Please look at my account." });
    await agencyPostMessage(w.agency.superAdmin, r.id, { body: "INTERNAL-ONLY refund looks suspicious", internal: true });
    await agencyPostMessage(w.agency.superAdmin, r.id, { body: "Thanks, we are checking this today." });

    const detail = await getRequestDetail(w.ctx.member, r.id);
    expect(detail!.messages.map((m) => m.body)).toEqual(["Please look at my account.", "Thanks, we are checking this today."]);
    expect(JSON.stringify(detail)).not.toMatch(/INTERNAL-ONLY/);
    expect(detail!.timeline.map((e) => e.kind)).not.toContain("note");
    // Search never reaches a note for a client, and does for the team.
    expect((await listMyRequests(w.ctx.member, { q: "INTERNAL-ONLY", pageSize: 50 })).items).toEqual([]);
    expect((await listAgencyRequests(w.agency.superAdmin, { view: "all", q: "INTERNAL-ONLY" })).items.map((i) => i.id)).toEqual([r.id]);
    // The database itself withholds the note, whatever query is run as the client.
    const raw = await withUser(w.people.member.id, (db) => db.query<{ body: string }>("select body from support_messages where ticket_id = $1", [r.id]));
    expect(raw.rows.map((m) => m.body).join("|")).not.toMatch(/INTERNAL-ONLY/);
    // No client is notified about a note, and the reply's notice carries no note text.
    const clientNotices = await notificationsFor(w.people.member.id);
    expect(clientNotices.some((n) => /INTERNAL-ONLY/.test(`${n.title} ${n.body}`))).toBe(false);
    expect(await countRows("select 1 from support_notification_log where ticket_id = $1 and event_key like 'msg:%' and event_kind = 'agency_reply'", [r.id])).toBeGreaterThan(0);
    const team = await getAgencyRequest(w.agency.superAdmin, r.id);
    expect(team!.messages.some((m) => m.internal && /INTERNAL-ONLY/.test(m.body))).toBe(true);
    expect(team!.timeline.map((e) => e.kind)).toContain("note");
  });

  it("saves a retried reply once and keeps the conversation in order", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Ordering matters", message: "First message." });
    const id = crypto.randomUUID();
    const sent = await Promise.all([1, 2, 3].map(() => postClientMessage(w.ctx.member, r.id, { body: "Second message.", clientMessageId: id })));
    expect(new Set(sent.map((s) => s.id)).size).toBe(1);
    expect(sent.filter((s) => !s.existing)).toHaveLength(1);
    await postClientMessage(w.ctx.member, r.id, { body: "Third message.", clientMessageId: crypto.randomUUID() });
    const detail = await getRequestDetail(w.ctx.member, r.id);
    expect(detail!.messages.map((m) => m.body)).toEqual(["First message.", "Second message.", "Third message."]);
    expect(detail!.messages[1].clientMessageId).toBe(id);
  });

  it("moves a request that was waiting on the client back to the team when the client replies, and tells the team", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Waiting on me", message: "Initial question." });
    await agencyPostMessage(w.agency.staff, r.id, { body: "Which calendar do you use?" });
    expect((await ticketRow(r.id)).status).toBe("waiting_for_client");
    expect((await ticketRow(r.id)).first_responded_at).not.toBeNull();
    await clientReply(w.ctx.member, r.id, "Google Calendar.");
    expect((await ticketRow(r.id)).status).toBe("open");
    const notices = await notificationsFor(w.raw.staff.id, "support_reply");
    expect(notices.some((n) => n.title.startsWith(`${r.ref}: new reply`))).toBe(true);
    // The team's notice carries the reference and subject, not what the client wrote.
    expect(notices.every((n) => !/Google Calendar/.test(`${n.title} ${n.body}`))).toBe(true);
  });

  it("lets a client reopen a resolved request inside the window, and not outside it or once it is closed", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Please resolve then reopen", message: "Something to fix." });
    await changeRequestStatus(w.agency.superAdmin, r.id, "resolved", "Fixed the mapping.");
    expect((await getRequestDetail(w.ctx.member, r.id))!.canReopen).toBe(true);
    await reopenRequest(w.ctx.member, r.id, "It is still broken for one contact.");
    expect(await ticketRow(r.id)).toMatchObject({ status: "open", reopened_count: 1, resolved_at: null });
    expect(await countRows("select 1 from support_ticket_events where ticket_id = $1 and kind = 'reopened'", [r.id])).toBe(1);
    expect((await notificationsFor(w.raw.superAdmin.id, "support_status")).some((n) => n.title.startsWith(r.ref) && /reopened/.test(n.title))).toBe(true);

    await changeRequestStatus(w.agency.superAdmin, r.id, "resolved");
    await withSystem((db) => db.query("update support_tickets set resolved_at = now() - interval '30 days' where id = $1", [r.id]));
    const stale = await getRequestDetail(w.ctx.member, r.id);
    expect(stale).toMatchObject({ canReopen: false, canReply: false });
    await expect(reopenRequest(w.ctx.member, r.id)).rejects.toThrow(/Open a new request/);
    await expect(postClientMessage(w.ctx.member, r.id, { body: "One more thing." })).rejects.toThrow(/Open a new request/);

    await changeRequestStatus(w.agency.superAdmin, r.id, "closed");
    expect((await getRequestDetail(w.ctx.member, r.id))!.replyBlockedReason).toMatch(/closed/);
    await expect(postClientMessage(w.ctx.member, r.id, { body: "Anyone there?" })).rejects.toThrow(/closed/);
    await expect(reopenRequest(w.ctx.member, r.id)).rejects.toThrow(/Only a resolved/);
  });

  it("never reveals the team's priority, assignee name or escalation to the client", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "What does the client see", message: "Checking the client's view." });
    await agencyPostMessage(w.agency.superAdmin, r.id, { body: "On it." });
    const detail = await getRequestDetail(w.ctx.member, r.id);
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/"priority"|assignedTo|Superadmin|escalat|response_due/i);
    expect(detail!.ticket.isAssigned).toBe(true);
    // Agency authors show by first name only.
    expect(detail!.messages.find((m) => m.authorKind === "agency")!.authorName).toBe("Sam");
  });

  it("marks the team's replies as read only for the person who opened the request", async () => {
    const r = await submitRequest(w.ctx.member, { subject: "Unread indicator", message: "Is there a new reply?" });
    await agencyPostMessage(w.agency.superAdmin, r.id, { body: "Yes there is." });
    expect((await listMyRequests(w.ctx.member, { pageSize: 50 })).items.find((i) => i.id === r.id)!.hasUnreadReply).toBe(true);
    await markRequestRead(w.ctx.owner, r.id);
    expect((await listMyRequests(w.ctx.member, { pageSize: 50 })).items.find((i) => i.id === r.id)!.hasUnreadReply).toBe(true);
    await markRequestRead(w.ctx.member, r.id);
    expect((await listMyRequests(w.ctx.member, { pageSize: 50 })).items.find((i) => i.id === r.id)!.hasUnreadReply).toBe(false);
  });

  it("shows a response expectation only when the Super Admin configured and chose to show it", async () => {
    const before = await submitRequest(w.ctx.member, { subject: "No expectation yet", message: "Nothing is configured." });
    expect(before.expectation).toBeNull();
    const current = await withSystem((db) => db.query<{ revision: number }>("select revision from support_settings where id"));
    await updateSupportSettings(w.agency.superAdmin, { targetsEnabled: true, showTargetsToClients: true, firstResponseMinutes: { normal: 480 }, followUpMinutes: { normal: 240 } }, current.rows[0].revision);
    try {
      const after = await submitRequest(w.ctx.member, { subject: "Now there is one", message: "Targets are on." });
      expect(after.expectation).toBe("We aim to reply within 1 business day.");
      const detail = await getRequestDetail(w.ctx.member, after.id);
      expect(detail!.expectation).toBe("We aim to reply within 1 business day.");
      await agencyPostMessage(w.agency.superAdmin, after.id, { body: "Looking now." });
      expect((await getRequestDetail(w.ctx.member, after.id))!.expectation).toBeNull();
    } finally {
      const rev = await withSystem((db) => db.query<{ revision: number }>("select revision from support_settings where id"));
      await updateSupportSettings(w.agency.superAdmin, { targetsEnabled: false, showTargetsToClients: false }, rev.rows[0].revision);
    }
  });
});
