import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { addMember, agencyUser, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";
import { createAqiSupportTicket } from "@/server/aqi/support";

function viewerFor(ctx: ReturnType<typeof ctxFor>): AqiViewer {
  return { user: ctx.user, org: { orgId: ctx.org.orgId, name: ctx.org.name, kind: ctx.org.kind, role: ctx.org.role }, permissions: ctx.permissions, can: ctx.can, agencyRole: null };
}

describe("AQi support escalation", () => {
  it("requires consent and creates a real support request exactly once", async () => {
    const org = await createOrg({ name: "AQi Support Audit" });
    const owner = await createUser();
    await addMember(org.id, owner.id, "owner");
    const viewer = viewerFor(ctxFor(owner, org, "owner"));
    const conversationId = await withUser(owner.id, async (db) => {
      const { rows } = await db.query<{ id: string }>("insert into aqi_conversations (org_id, user_id, title) values ($1,$2,'Support audit chat') returning id", [org.id, owner.id]);
      await db.query("insert into aqi_messages (conversation_id, org_id, user_id, role, content, status) values ($1,$2,$3,'user','I need help with AQi.','complete')", [rows[0].id, org.id, owner.id]);
      return rows[0].id;
    });
    await expect(createAqiSupportTicket(viewer, conversationId, "Need help", false)).rejects.toThrow(/consent/i);
    const first = await createAqiSupportTicket(viewer, conversationId, "Need help", true);
    expect(first.ref).toBeTruthy();
    const second = await createAqiSupportTicket(viewer, conversationId, "Need help", true);
    expect(second).toMatchObject({ id: first.id, ref: first.ref, existing: true });
    const row = await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from support_tickets where id = $1 and org_id = $2", [first.id, org.id]));
    expect(row.rows[0].n).toBe(1);
  });

  it("refuses agency viewers without a client workspace", async () => {
    const user = agencyUser(await createUser({ platformRole: "agency_staff" }), "agency_staff");
    const agency: AqiViewer = { user, org: null, permissions: [], can: () => false, agencyRole: "agency_staff" };
    await expect(createAqiSupportTicket(agency, "00000000-0000-0000-0000-000000000000", "help", true)).rejects.toThrow(/client workspace/i);
  });
});
