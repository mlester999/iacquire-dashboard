import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getGrowthPartnerConversationPage } from "@/server/ai-growth-partner/service";
import { withSystem, withUser } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";

async function createPermanentThread() {
  const org = await createOrg({ name: "Conversation Paging" });
  const owner = await createUser();
  await addMember(org.id, owner.id, "owner");
  const runtime = await withSystem(async (db) => {
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
  const partner = (await withSystem((db) => db.query<{ id: string }>(
    "insert into ai_growth_partners (org_id, runtime_agent_instance_id) values ($1, $2) returning id",
    [org.id, runtime],
  ))).rows[0];
  const thread = (await withUser(owner.id, (db) => db.query<{ id: string }>(
    `insert into chat_conversations (org_id, agent_instance_id, user_id, growth_partner_id, title, hermes_session_id)
     values ($1, $2, null, $3, 'AI Growth Partner', $4) returning id`,
    [org.id, runtime, partner.id, `growth-partner-${randomUUID()}`],
  ))).rows[0];
  return { org, owner, runtime, thread, ctx: ctxFor(owner, org, "owner") };
}

describe("Growth Partner conversation paging and recovery", () => {
  it("pages through equal timestamps with a stable (created_at, id) cursor and no gaps", async () => {
    const { org, owner, thread, ctx } = await createPermanentThread();
    const createdAt = new Date("2026-05-01T10:00:00.000Z");
    const expectedIds = Array.from({ length: 75 }, (_, index) => `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`);
    await withUser(owner.id, async (db) => {
      for (const [index, id] of expectedIds.entries()) {
        await db.query(
          "insert into chat_messages (id, conversation_id, org_id, role, content, created_at) values ($1, $2, $3, 'user', $4, $5)",
          [id, thread.id, org.id, `message-${index}`, createdAt.toISOString()],
        );
      }
    });

    const first = await getGrowthPartnerConversationPage(ctx);
    expect(first?.messages).toHaveLength(60);
    expect(first?.nextCursor).toMatchObject({ id: expectedIds[15], createdAt });

    let page = first!;
    let collected = page.messages.map((message) => message.id);
    while (page.hasMore && page.nextCursor) {
      page = (await getGrowthPartnerConversationPage(ctx, {
        createdAt: page.nextCursor.createdAt,
        id: page.nextCursor.id,
      }))!;
      collected = [...page.messages.map((message) => message.id), ...collected];
    }

    expect(collected).toEqual(expectedIds);
    expect(new Set(collected).size).toBe(75);
  });

  it("repairs terminal and timed-out streams while leaving a live run alone", async () => {
    const { org, owner, runtime, thread, ctx } = await createPermanentThread();
    const otherConversation = (await withUser(owner.id, (db) => db.query<{ id: string }>(
      `insert into chat_conversations (org_id, agent_instance_id, user_id, title, hermes_session_id)
       values ($1, $2, $3, 'Other thread', $4) returning id`,
      [org.id, runtime, owner.id, `other-${randomUUID()}`],
    ))).rows[0].id;
    const runs = await withSystem(async (db) => {
      const insertRun = async (key: string, status: string, started: string) => (await db.query<{ id: string }>(
        `insert into agent_runs (org_id, agent_instance_id, user_id, purpose, idempotency_key, status, started_at)
         values ($1, $2, $3, 'chat', $4, $5, $6) returning id`,
        [org.id, runtime, owner.id, key, status, started],
      )).rows[0].id;
      const terminalRun = await insertRun(`terminal-${randomUUID()}`, "failed", new Date().toISOString());
      const oldRun = await insertRun(`old-${randomUUID()}`, "running", new Date(Date.now() - 75_000).toISOString());
      const liveRun = await insertRun(`live-${randomUUID()}`, "running", new Date().toISOString());
      const otherRun = await insertRun(`other-${randomUUID()}`, "failed", new Date().toISOString());
      const messageIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
      const messageRuns = [terminalRun, oldRun, liveRun, otherRun];
      return { messageIds, messageRuns };
    });
    await withSystem(async (db) => {
      for (let index = 0; index < runs.messageIds.length; index += 1) {
        await db.query(
          `insert into chat_messages (id, conversation_id, org_id, role, content, status, run_id)
           values ($1, $2, $3, 'assistant', '', 'streaming', $4)`,
          [runs.messageIds[index], index === 3 ? otherConversation : thread.id, org.id, runs.messageRuns[index]],
        );
      }
    });

    const page = await getGrowthPartnerConversationPage(ctx);
    const returned = new Map(page?.messages.map((message) => [message.id, message]));
    expect(returned.get(runs.messageIds[0])).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(returned.get(runs.messageIds[1])).toMatchObject({ status: "failed", errorCode: "interrupted" });
    expect(returned.get(runs.messageIds[2])).toMatchObject({ status: "streaming", errorCode: null });
    const stored = await withSystem((db) => db.query<{ id: string; status: string; error_code: string | null }>(
      "select id, status, error_code from chat_messages where id = any($1::uuid[])",
      [runs.messageIds],
    ));
    expect(new Map(stored.rows.map((message) => [message.id, message.status])).get(runs.messageIds[3])).toBe("streaming");
    expect(stored.rows.find((message) => message.id === runs.messageIds[0])).toMatchObject({ status: "failed", error_code: "interrupted" });
    expect(stored.rows.find((message) => message.id === runs.messageIds[1])).toMatchObject({ status: "failed", error_code: "interrupted" });
    expect(stored.rows.find((message) => message.id === runs.messageIds[2])?.status).toBe("streaming");
  });
});
