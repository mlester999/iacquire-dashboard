import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createAqiSupportTicket, prepareAqiSupportDraft, submitAqiSupportRequest } from "@/server/aqi/support";
import { listOpsConversations, getOpsConversation, deleteOpsConversation, renameOpsConversation } from "@/server/aqi/ops/conversations";
import { purgeExpiredOpsConversations } from "@/server/aqi/ops/conversations";
import type { AqiViewer } from "@/server/aqi/access";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";

describe("Super Admin AQi does not create customer-facing support requests", () => {
  it("refuses every customer support entry point for a Super Admin, even one with an agency workspace membership", async () => {
    const agency = await createOrg({ name: "Agency Home", kind: "agency" });
    const admin = await createUser({ platformRole: "agency_super_admin" });
    await addMember(agency.id, admin.id, "owner");
    const session = agencyUser(admin, "agency_super_admin");
    const ctx = ctxFor(admin, agency, "owner");
    const viewer: AqiViewer = { user: session, org: { orgId: agency.id, name: agency.name, kind: "agency", role: "owner" }, permissions: ctx.permissions, can: ctx.can, agencyRole: "agency_super_admin" };
    const conversationId = (await withSystem((db) => db.query<{ id: string }>("insert into aqi_conversations (user_id, org_id, title) values ($1, $2, 'x') returning id", [admin.id, agency.id]))).rows[0].id;
    await expect(createAqiSupportTicket(viewer, conversationId, "Need help", true)).rejects.toThrow(/internal issue/i);
    await expect(prepareAqiSupportDraft(viewer, conversationId)).rejects.toThrow(/internal issue/i);
    await expect(submitAqiSupportRequest(viewer, { conversationId, subject: "Need help", description: "Please help with this", consent: true })).rejects.toThrow(/internal issue/i);
    const tickets = await withSystem((db) => db.query("select 1 from support_tickets where org_id = $1", [agency.id]));
    expect(tickets.rows).toHaveLength(0);
  });
});

describe("investigation history", () => {
  it("is private to the administrator, never listed for others, and deletable", async () => {
    const a = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const b = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const make = async (user: typeof a, title: string, daysAgo = 0) => (await withSystem((db) => db.query<{ id: string }>(
      "insert into aqi_conversations (user_id, title, surface, saved_at, last_message_at) values ($1, $2, 'operations', now(), now() - ($3 || ' days')::interval) returning id", [user.id, title, daysAgo],
    ))).rows[0].id;
    const mine = await make(a, "My latency investigation");
    await make(b, "Someone else's investigation");
    const list = await listOpsConversations(a);
    expect(list.conversations.map((c) => c.title)).toEqual(["My latency investigation"]);
    await expect(getOpsConversation(b, mine)).rejects.toThrow(/not found/i);
    await expect(renameOpsConversation(b, mine, "Hijacked")).rejects.toThrow(/not found/i);
    await expect(deleteOpsConversation(b, mine)).rejects.toThrow(/not found/i);
    expect(await renameOpsConversation(a, mine, "Renamed")).toBe("Renamed");
    await deleteOpsConversation(a, mine);
    expect((await listOpsConversations(a)).conversations).toHaveLength(0);
    const manager = agencyUser(await createUser({ platformRole: "agency_manager" }), "agency_manager");
    await expect(listOpsConversations(manager)).rejects.toThrow(/Super Admins only/);
  });

  it("expires old investigations but keeps the audit trail of confirmed actions", async () => {
    const admin = agencyUser(await createUser({ platformRole: "agency_super_admin" }), "agency_super_admin");
    const old = (await withSystem((db) => db.query<{ id: string }>("insert into aqi_conversations (user_id, title, surface, saved_at, last_message_at) values ($1, 'Old', 'operations', now(), now() - interval '200 days') returning id", [admin.id]))).rows[0].id;
    const fresh = (await withSystem((db) => db.query<{ id: string }>("insert into aqi_conversations (user_id, title, surface, saved_at) values ($1, 'Fresh', 'operations', now()) returning id", [admin.id]))).rows[0].id;
    await withSystem((db) => db.query(
      "insert into aqi_ops_actions (conversation_id, requested_by, tool_id, scope_type, risk, approval, status, verified, idempotency_key) values ($1, $2, 'incident.acknowledge', 'incident', 'low', 'confirm', 'succeeded', true, 'retention-key-1')", [old, admin.id],
    ));
    const clientConversation = (await withSystem((db) => db.query<{ id: string }>("insert into aqi_conversations (user_id, title, saved_at, last_message_at) values ($1, 'Client style', now(), now() - interval '400 days') returning id", [admin.id]))).rows[0].id;
    const purged = await purgeExpiredOpsConversations();
    expect(purged).toBeGreaterThanOrEqual(1);
    const left = await withSystem((db) => db.query<{ id: string }>("select id from aqi_conversations where id = any($1::uuid[])", [[old, fresh, clientConversation]]));
    expect(left.rows.map((r) => r.id).sort()).toEqual([fresh, clientConversation].sort());
    const action = await withSystem((db) => db.query<{ conversation_id: string | null; status: string }>("select conversation_id, status from aqi_ops_actions where idempotency_key = 'retention-key-1'"));
    expect(action.rows[0]).toEqual({ conversation_id: null, status: "succeeded" });
  });
});
