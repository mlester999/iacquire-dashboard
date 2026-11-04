import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { withSystem, withUser } from "@/server/db";
import { applyRetention, getConversation, listConversations } from "@/server/chat/service";
import { getGrowthPartnerConversationPage, searchGrowthPartnerConversation } from "@/server/ai-growth-partner/service";
import { getDashboard } from "@/server/queries/dashboard";
import { agentId, addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

describe("AI Growth Partner canonical conversation foundation", () => {
  it("shares exactly one tenant thread with authorized members and keeps it beyond legacy retention", async () => {
    const org = await createOrg({ name: "Shared Growth Partner Conversation" });
    const otherOrg = await createOrg({ name: "Isolated Growth Partner Conversation" });
    const ownerA = await createUser({ name: "Owner A" });
    const ownerB = await createUser({ name: "Owner B" });
    const otherOwner = await createUser();
    await addMember(org.id, ownerA.id, "owner");
    await addMember(org.id, ownerB.id, "owner");
    await addMember(otherOrg.id, otherOwner.id, "owner");
    const runtimeId = await withSystem(async (db) => {
      await db.query(
        `insert into agent_roles (key, name, short_name, tagline, description, capabilities, default_tools, accent, sort_order)
         values ('growth_partner', 'AI Growth Partner', 'Growth Partner', 'One partner', 'Unified test identity', '[]'::jsonb, '[]'::jsonb, '#6d63d8', 7)
         on conflict (key) do nothing`,
      );
      return (await db.query<{ id: string }>(
        "insert into agent_instances (org_id, role_key, display_name) values ($1, 'growth_partner', 'AI Growth Partner') returning id",
        [org.id],
      )).rows[0].id;
    });
    const partner = await withSystem(async (db) => (await db.query<{ id: string }>(
      "insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2) returning id",
      [org.id, runtimeId],
    )).rows[0]);
    const legacyRuntimeId = await agentId(org.id, "sales_assistant");
    await expect(withSystem((db) => db.query(
      "update ai_growth_partners set runtime_agent_instance_id = $2 where id = $1",
      [partner.id, legacyRuntimeId],
    ))).rejects.toThrow(/growth_partner_requires_dedicated_runtime/);
    await expect(withSystem((db) => db.query(
      "update agent_instances set role_key = 'sales_assistant' where id = $1",
      [runtimeId],
    ))).rejects.toThrow(/growth_partner_runtime_role_is_immutable/);
    const thread = await withUser(ownerA.id, async (db) => (await db.query<{ id: string }>(
      `insert into chat_conversations (org_id, agent_instance_id, user_id, growth_partner_id, title, hermes_session_id)
       values ($1, $2, null, $3, 'AI Growth Partner', $4) returning id`,
      [org.id, runtimeId, partner.id, `growth-partner-${randomUUID()}`],
    )).rows[0]);

    const readyDashboard = await getDashboard(ctxFor(ownerA, org, "owner"));
    expect(readyDashboard.setup.find((item) => item.key === "chat")).toMatchObject({
      label: "Permanent Growth Partner conversation ready",
      done: true,
      href: "/growth-partner/conversation",
    });
    await withSystem((db) => db.query("update chat_conversations set deleted_at = now() where id = $1", [thread.id]));
    const deletedDashboard = await getDashboard(ctxFor(ownerA, org, "owner"));
    expect(deletedDashboard.setup.find((item) => item.key === "chat")).toMatchObject({ done: false });
    await withSystem((db) => db.query("update chat_conversations set deleted_at = null where id = $1", [thread.id]));

    await withUser(ownerA.id, (db) => db.query(
      `insert into chat_messages (conversation_id, org_id, role, content, author_user_id)
       values ($1, $2, 'user', 'A durable shared request', $3)`,
      [thread.id, org.id, ownerA.id],
    ));
    const shared = await withUser(ownerB.id, async (db) => ({
      conversations: await db.query<{ id: string }>(
        "select id from chat_conversations where org_id = $1 and growth_partner_id = $2",
        [org.id, partner.id],
      ),
      messages: await db.query<{ content: string; author_user_id: string | null }>(
      "select content, author_user_id from chat_messages where conversation_id = $1",
        [thread.id],
      ),
    }));
    expect(shared.conversations.rows.map((row) => row.id)).toEqual([thread.id]);
    expect(shared.messages.rows.map((row) => row.content)).toEqual(["A durable shared request"]);
    expect(shared.messages.rows[0].author_user_id).toBe(ownerA.id);

    const history = await getGrowthPartnerConversationPage(ctxFor(ownerB, org, "owner"));
    expect(history).toMatchObject({ conversation: { id: thread.id }, hasMore: false });
    expect(history?.messages).toMatchObject([{ role: "user", authorUserId: ownerA.id, authorLabel: "Owner A", content: "A durable shared request" }]);
    expect(await searchGrowthPartnerConversation(ctxFor(ownerB, org, "owner"), "durable shared")).toMatchObject([
      { id: expect.any(String), role: "user", authorLabel: "Owner A", excerpt: "A durable shared request" },
    ]);
    expect(await searchGrowthPartnerConversation(ctxFor(otherOwner, otherOrg, "owner"), "durable shared")).toEqual([]);

    await expect(withUser(ownerB.id, (db) => db.query(
      `insert into chat_conversations (org_id, agent_instance_id, user_id, growth_partner_id, title, hermes_session_id)
       values ($1, $2, null, $3, 'Duplicate', $4)`,
      [org.id, runtimeId, partner.id, `growth-partner-${randomUUID()}`],
    ))).rejects.toThrow();

    const otherTenantRows = await withUser(otherOwner.id, (db) => db.query<{ id: string }>(
      "select id from chat_conversations where id = $1",
      [thread.id],
    ));
    expect(otherTenantRows.rows).toHaveLength(0);
    expect(await getConversation(ctxFor(ownerB, org, "owner"), thread.id)).toBeNull();
    expect(await listConversations(ctxFor(ownerB, org, "owner"), runtimeId)).toHaveLength(0);

    const privateThread = await withUser(ownerA.id, async (db) => (await db.query<{ id: string }>(
      `insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id)
       values ($1, $2, $3, 'Old private chat', $4) returning id`,
      [org.id, runtimeId, ownerA.id, `private-${randomUUID()}`],
    )).rows[0]);
    await withUser(ownerA.id, (db) => db.query(
      `insert into chat_messages (conversation_id, org_id, role, content)
       values ($1, $2, 'user', 'Private history can follow the workspace retention setting')`,
      [privateThread.id, org.id],
    ));
    await withSystem(async (db) => {
      await db.query("update company_profiles set ai_preferences = jsonb_set(ai_preferences, '{chatRetentionDays}', '30'::jsonb, true) where org_id = $1", [org.id]);
      await db.query("update chat_conversations set last_message_at = now() - interval '90 days' where id in ($1, $2)", [thread.id, privateThread.id]);
    });
    await applyRetention(org.id);
    const retained = await withSystem(async (db) => ({
      conversations: await db.query<{ id: string; deleted_at: Date | null }>(
        "select id, deleted_at from chat_conversations where id in ($1, $2)",
        [thread.id, privateThread.id],
      ),
      messages: await db.query<{ conversation_id: string; content: string }>(
        "select conversation_id, content from chat_messages where conversation_id in ($1, $2)",
        [thread.id, privateThread.id],
      ),
    }));
    const canonicalAfterRetention = retained.conversations.rows.find((row) => row.id === thread.id);
    const privateAfterRetention = retained.conversations.rows.find((row) => row.id === privateThread.id);
    expect(canonicalAfterRetention?.deleted_at).toBeNull();
    expect(privateAfterRetention?.deleted_at).not.toBeNull();
    expect(retained.messages.rows.find((row) => row.conversation_id === thread.id)?.content).toBe("A durable shared request");
    expect(retained.messages.rows.find((row) => row.conversation_id === privateThread.id)?.content).toBe("");

    await withSystem((db) => db.query("delete from users where id = $1", [ownerA.id]));
    const afterStarterRemoval = await withSystem(async (db) => ({
      conversation: await db.query<{ user_id: string | null }>(
        "select user_id from chat_conversations where id = $1",
        [thread.id],
      ),
      message: await db.query<{ content: string; author_user_id: string | null }>(
        "select content, author_user_id from chat_messages where conversation_id = $1",
        [thread.id],
      ),
    }));
    expect(afterStarterRemoval.conversation.rows[0]?.user_id).toBeNull();
    expect(afterStarterRemoval.message.rows[0]).toMatchObject({ content: "A durable shared request", author_user_id: null });
  });
});
