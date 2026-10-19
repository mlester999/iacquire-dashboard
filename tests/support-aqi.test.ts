import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { createAqiSupportTicket, prepareAqiSupportDraft, submitAqiSupportRequest } from "@/server/aqi/support";
import type { AqiViewer } from "@/server/aqi/access";
import { agencyUser, createUser } from "./support/fixtures";
import { countRows, resetRateLimits, supportWorld, ticketRow, type SupportWorld } from "./support/support-world";
import type { OrgContext } from "@/server/tenancy/context";

let w: SupportWorld;
beforeAll(async () => {
  w = await supportWorld();
});
beforeEach(resetRateLimits);

const viewerFor = (ctx: OrgContext): AqiViewer => ({ user: ctx.user, org: { orgId: ctx.org.orgId, name: ctx.org.name, kind: ctx.org.kind, role: ctx.org.role }, permissions: ctx.permissions, can: ctx.can, agencyRole: null });

async function conversation(ctx: OrgContext, lines: Array<["user" | "assistant", string]>, title = "My integration is not working", route: string | null = "/crm/calendar") {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ id: string }>("insert into aqi_conversations (org_id, user_id, title, page_route) values ($1, $2, $3, $4) returning id", [ctx.org.orgId, ctx.user.id, title, route]);
    for (const [role, content] of lines) {
      await db.query("insert into aqi_messages (conversation_id, org_id, user_id, role, content, status) values ($1, $2, $3, $4, $5, 'complete')", [rows[0].id, ctx.org.orgId, ctx.user.id, role, content]);
    }
    return rows[0].id;
  });
}

const talk: Array<["user" | "assistant", string]> = [
  ["user", "My Google calendar integration is not working and events are missing."],
  ["assistant", "Try reconnecting it from Settings, then check the status badge."],
  ["user", "I reconnected it but it still fails. My key is sk-live-abcdefghijklmnop if that helps."],
  ["assistant", "I'm not able to see your connection. Would you like help from the iAcquire team?"],
];

describe("AQi helps prepare a support request", () => {
  it("proposes a subject, description, topic and the exact conversation that would be shared, and creates nothing", async () => {
    const id = await conversation(w.ctx.member, talk);
    const before = await countRows("select 1 from support_tickets");
    const draft = await prepareAqiSupportDraft(viewerFor(w.ctx.member), id);
    expect(draft.subject).toBe("My integration is not working");
    expect(draft.description).toContain("I asked AQi for help with: My Google calendar integration is not working and events are missing.");
    expect(draft.description).toContain("My latest message: I reconnected it but it still fails.");
    expect(draft.description).toMatch(/AQi wasn't able to fully resolve this/);
    expect(draft).toMatchObject({ requestType: "issue", category: "integrations", pageContext: "/crm/calendar" });
    expect(draft.excerpt).toHaveLength(4);
    // Credentials are removed from what could be shared.
    expect(JSON.stringify(draft)).not.toMatch(/sk-live-abcdefghijklmnop/);
    expect(draft.excerpt[2].text).toContain("[secret removed]");
    expect(draft.sharedSummary).toMatch(/last 4 messages.*passwords and keys removed/);
    expect(await countRows("select 1 from support_tickets")).toBe(before);
  });

  it("needs something to prepare from, and only works on the person's own conversation in their own workspace", async () => {
    const empty = await conversation(w.ctx.member, [["assistant", "Hi, how can I help?"]]);
    await expect(prepareAqiSupportDraft(viewerFor(w.ctx.member), empty)).rejects.toThrow(/Ask AQi something first/);
    const mine = await conversation(w.ctx.member, talk);
    await expect(prepareAqiSupportDraft(viewerFor(w.ctx.member2), mine)).rejects.toThrow(/not found/i);
    await expect(prepareAqiSupportDraft(viewerFor(w.ctx.owner), mine)).rejects.toThrow(/not found/i);
    await expect(prepareAqiSupportDraft(viewerFor(w.ctx.outsider), mine)).rejects.toThrow(/not found/i);
    await expect(prepareAqiSupportDraft(viewerFor(w.ctx.viewer), mine)).rejects.toThrow(/can't open/);
    const agency: AqiViewer = { user: agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff"), org: null, permissions: [], can: () => false, agencyRole: "agency_staff" };
    await expect(prepareAqiSupportDraft(agency, mine)).rejects.toThrow(/client workspace/);
  });
});

describe("AQi submits only what the person approved", () => {
  const base = { subject: "Calendar integration problem", description: "My Google calendar stopped syncing on Monday and I reconnected it twice.", requestType: "issue" as const, category: "integrations" };

  it("refuses to share the conversation without explicit consent, and creates nothing", async () => {
    const id = await conversation(w.ctx.member, talk);
    const before = await countRows("select 1 from support_tickets");
    await expect(submitAqiSupportRequest(viewerFor(w.ctx.member), { ...base, conversationId: id, includeConversation: true, consent: false })).rejects.toThrow(/consent/i);
    expect(await countRows("select 1 from support_tickets")).toBe(before);
  });

  it("shares the excerpt when the person agrees, using the text they edited, and returns the real reference", async () => {
    const id = await conversation(w.ctx.member, talk);
    const r = await submitAqiSupportRequest(viewerFor(w.ctx.member), { ...base, conversationId: id, includeConversation: true, consent: true });
    expect(r).toMatchObject({ status: "new", existing: false, externalNotification: "not_configured" });
    expect(r.ref).toMatch(/^IAQ-\d+$/);
    const t = await ticketRow(r.id);
    expect(t).toMatchObject({ request_type: "issue", category: "integrations", subject: "Calendar integration problem", page_context: "/crm/calendar", created_by: w.people.member.id });
    const body = (await withSystem((db) => db.query<{ body: string }>("select body from support_messages where ticket_id = $1", [r.id]))).rows[0].body;
    expect(body.startsWith("My Google calendar stopped syncing on Monday")).toBe(true);
    expect(body).toContain("AQi conversation, shared with the person's permission");
    expect(body).toContain("Me: My Google calendar integration is not working");
    expect(body).toContain("AQi: Try reconnecting it");
    expect(body).not.toMatch(/sk-live-abcdefghijklmnop/);
    expect(body.length).toBeLessThanOrEqual(5000);
  });

  it("shares nothing from the conversation when the person chooses not to", async () => {
    const id = await conversation(w.ctx.member, talk);
    const r = await submitAqiSupportRequest(viewerFor(w.ctx.member), { ...base, conversationId: id, includeConversation: false, consent: false });
    const body = (await withSystem((db) => db.query<{ body: string }>("select body from support_messages where ticket_id = $1", [r.id]))).rows[0].body;
    expect(body).toBe(base.description);
    expect(body).not.toMatch(/AQi:|Try reconnecting|sk-live/);
  });

  it("recognises a retry as the same submission and never makes two requests", async () => {
    const id = await conversation(w.ctx.member, talk);
    const input = { ...base, conversationId: id, includeConversation: false, consent: false, idempotencyKey: `aqi-key-${crypto.randomUUID()}` };
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => submitAqiSupportRequest(viewerFor(w.ctx.member), input)));
    expect(new Set([a.id, b.id, c.id]).size).toBe(1);
    expect([a, b, c].filter((x) => !x.existing)).toHaveLength(1);
    // With no key at all, an immediate repeat is still recognised.
    const again = { ...base, subject: "A different subject here", conversationId: id, includeConversation: false, consent: false };
    const first = await submitAqiSupportRequest(viewerFor(w.ctx.member), again);
    const second = await submitAqiSupportRequest(viewerFor(w.ctx.member), again);
    expect(second).toMatchObject({ id: first.id, existing: true });
  });

  it("claims no request when creating one fails", async () => {
    const id = await conversation(w.ctx.member, talk);
    const before = await countRows("select 1 from support_tickets");
    await expect(submitAqiSupportRequest(viewerFor(w.ctx.member), { ...base, conversationId: id, attachmentIds: [crypto.randomUUID()] })).rejects.toThrow(/no longer available/);
    await expect(submitAqiSupportRequest(viewerFor(w.ctx.member), { ...base, conversationId: id, description: "hi" })).rejects.toThrow(/little more/);
    expect(await countRows("select 1 from support_tickets")).toBe(before);
  });

  it("will not use someone else's conversation, a closed-off role or an agency account", async () => {
    const mine = await conversation(w.ctx.member, talk);
    const before = await countRows("select 1 from support_tickets");
    await expect(submitAqiSupportRequest(viewerFor(w.ctx.member2), { ...base, conversationId: mine, includeConversation: true, consent: true })).rejects.toThrow(/not found/i);
    await expect(submitAqiSupportRequest(viewerFor(w.ctx.viewer), { ...base, conversationId: mine })).rejects.toThrow(/can't open/);
    expect(await countRows("select 1 from support_tickets")).toBe(before);
  });

  it("keeps the earlier one-step entry point working, with consent required", async () => {
    const id = await conversation(w.ctx.owner, talk, "Owner chat");
    await expect(createAqiSupportTicket(viewerFor(w.ctx.owner), id, "Need help", false)).rejects.toThrow(/consent/i);
    const first = await createAqiSupportTicket(viewerFor(w.ctx.owner), id, "Need help", true);
    const second = await createAqiSupportTicket(viewerFor(w.ctx.owner), id, "Need help", true);
    expect(second).toMatchObject({ id: first.id, ref: first.ref, existing: true });
    expect(await countRows("select 1 from support_tickets where id = $1", [first.id])).toBe(1);
  });
});
