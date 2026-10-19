import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { addMember, createOrg, createUser, ctxFor } from "./support/fixtures";
import type { AqiViewer } from "@/server/aqi/access";
import { getAqiConversation, runAqiTurn } from "@/server/aqi/service";

async function ownerViewer() {
  const org = await createOrg({ name: `Guide chat ${Math.random().toString(16).slice(2)}` });
  const owner = await createUser({ name: "Guide Owner" });
  await addMember(org.id, owner.id, "owner");
  const ctx = ctxFor(owner, { ...org, slug: "x" }, "owner");
  const viewer: AqiViewer = {
    user: ctx.user,
    org: { orgId: org.id, name: org.name, kind: "client", role: "owner" },
    permissions: ctx.permissions,
    can: ctx.can,
    agencyRole: null,
  };
  return { org, owner, viewer };
}

async function turn(viewer: AqiViewer, message: string) {
  const events: Array<Record<string, unknown>> = [];
  for await (const event of runAqiTurn(viewer, { message, pathname: "/overview" }, new AbortController().signal)) events.push(event as unknown as Record<string, unknown>);
  const meta = events.find((event) => event.type === "meta") as { conversationId: string; messageId: string } | undefined;
  return { events, meta };
}

describe("AQi chat guide actions", () => {
  it("attaches a server-validated guide action for a real how-to question and persists it", async () => {
    const { org, owner, viewer } = await ownerViewer();
    const { events, meta } = await turn(viewer, "How do I add a contact?");
    expect(meta).toBeTruthy();
    const context = await withSystem(async (db) => (await db.query<{ guide: { slug: string; title: string; stepCount: number; version: number } | null }>(
      "select context->'guide' as guide from aqi_messages where id = $1",
      [meta!.messageId],
    )).rows[0].guide);
    expect(context).toMatchObject({ slug: "create-contact", stepCount: 4, version: 2 });
    expect(context?.title).toMatch(/contact/i);

    // The offer is recorded as a privacy-conscious signal, not as a completed tutorial.
    const offers = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_usage_events where org_id = $1 and user_id = $2 and kind = 'guidance_offer'",
      [org.id, owner.id],
    )).rows[0].n);
    expect(offers).toBe(1);
    const completions = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_usage_events where org_id = $1 and kind = 'guidance_accept'",
      [org.id],
    )).rows[0].n);
    expect(completions).toBe(0);

    const conversation = await getAqiConversation(viewer, meta!.conversationId);
    expect(conversation.messages.find((message) => message.id === meta!.messageId)?.guide).toMatchObject({ slug: "create-contact" });
    expect(events.some((event) => event.type === "error")).toBe(true);
  });

  it("never attaches a walkthrough to a greeting or a simple unrelated question", async () => {
    const { viewer } = await ownerViewer();
    const greeting = await turn(viewer, "hey");
    const greetingContext = await withSystem(async (db) => (await db.query<{ guide: unknown }>(
      "select context->'guide' as guide from aqi_messages where id = $1",
      [greeting.meta!.messageId],
    )).rows[0].guide);
    expect(greetingContext).toBeNull();
    expect(greeting.events.some((event) => event.type === "error")).toBe(true);

    const billing = await turn(viewer, "What does my billing page show?");
    const billingContext = await withSystem(async (db) => (await db.query<{ guide: unknown }>(
      "select context->'guide' as guide from aqi_messages where id = $1",
      [billing.meta!.messageId],
    )).rows[0].guide);
    expect(billingContext).toBeNull();
  });
});
