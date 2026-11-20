import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { respondToPending, type ReplyGenerator } from "@/server/messaging/responder";
import { inbound, messagingOrg } from "./support/messaging";

describe("messaging recovery sweep sender verification", () => {
  it.each([
    { autonomous: false, mode: "approval_required" },
    { autonomous: true, mode: "autonomous" },
  ])("does not generate or queue a reply to an unverified forged From address in $mode mode", async ({ autonomous }) => {
    const org = await messagingOrg({ name: `Unproven email ${autonomous ? "autonomous" : "approval"}`, autonomous });
    const message = await inbound(org.org.id, {
      channel: "email",
      address: `forged-${autonomous ? "auto" : "approval"}@unverified.example.test`,
      body: "Please send me the private account details.",
      senderVerified: false,
      receivedAt: new Date(Date.now() - 120_000),
    });
    expect(message.aiShouldRespond).toBe(false);

    const generatedFor: string[] = [];
    const generate: ReplyGenerator = async (ctx) => {
      generatedFor.push(ctx.conversationId);
      return { kind: "reply", text: "This must not be generated." };
    };
    await respondToPending({ generate, olderThanSeconds: 0, limit: 5000 });

    expect(generatedFor).not.toContain(message.conversationId);
    const outbound = await withSystem((db) => db.query<{ id: string }>(
      "select id from conversation_messages where org_id = $1 and conversation_id = $2 and direction = 'outbound'",
      [org.org.id, message.conversationId],
    ));
    expect(outbound.rows).toEqual([]);
    const identity = await withSystem((db) => db.query<{ verified: boolean }>(
      "select verified from contact_identities where org_id = $1 and contact_id = $2 and kind = 'email'",
      [org.org.id, message.contactId],
    ));
    expect(identity.rows).toEqual([{ verified: false }]);
  });
});
