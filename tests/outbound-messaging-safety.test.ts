import crypto from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sendVerificationEmail } from "@/server/auth/service";
import { env, resetEnvCache } from "@/server/env";
import { withSystem } from "@/server/db";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { transportFor } from "@/server/messaging/transports";
import { answer, chatOrg, clientId, embedCall, start, viewOf } from "./support/webchat";
import { createUser } from "./support/fixtures";
import { inbound, messageRow, messagingOrg, recordingProvider } from "./support/messaging";

const providerSwitches = ["GHL_WRITES_ENABLED", "RESEND_WRITES_ENABLED", "TWILIO_WRITES_ENABLED", "META_WHATSAPP_WRITES_ENABLED"] as const;
const originalProviderSwitches = Object.fromEntries(providerSwitches.map((key) => [key, process.env[key]]));
const setOutbound = (enabled: boolean | undefined) => {
  if (enabled === undefined) delete process.env.OUTBOUND_MESSAGING_ENABLED;
  else process.env.OUTBOUND_MESSAGING_ENABLED = String(enabled);
  resetEnvCache();
};

beforeEach(() => setOutbound(true));
afterEach(() => {
  // Vitest reuses workers across files; restore the explicit synthetic opt-in, not the production default.
  setOutbound(true);
  for (const key of providerSwitches) {
    const value = originalProviderSwitches[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  delete process.env.EMAIL_PROVIDER;
  resetEnvCache();
});

describe("the environment-wide outbound messaging stop", () => {
  it("defaults off and blocks AI sends at the application queue", async () => {
    setOutbound(undefined);
    expect(env().OUTBOUND_MESSAGING_ENABLED).toBe(false);

    const org = await messagingOrg({ name: "Outbound disabled default" });
    const inboundMessage = await inbound(org.org.id);
    const queued = await withSystem((db) => queueOutbound(db, {
      orgId: org.org.id,
      conversationId: inboundMessage.conversationId,
      scope: "reply",
      actor: { kind: "ai", agentId: org.salesAgentId },
      body: "This must not leave the test environment.",
    }));

    expect(queued).toMatchObject({ status: "blocked", reason: "outbound_disabled" });
    expect(await messageRow(queued.messageId)).toMatchObject({ status: "blocked", blocked_reason: "outbound_disabled" });
  });

  it("rechecks the stop at dispatch so queued work and provider adapters cannot bypass it", async () => {
    const org = await messagingOrg({ name: "Outbound disabled dispatch" });
    const inboundMessage = await inbound(org.org.id);
    const now = new Date(Date.now() + 60_000);
    const queued = await withSystem((db) => queueOutbound(db, {
      orgId: org.org.id,
      conversationId: inboundMessage.conversationId,
      scope: "reply",
      actor: { kind: "ai", agentId: org.salesAgentId },
      body: "Queued before the stop changed.",
      now,
    }));
    expect(queued.status).toBe("queued");

    setOutbound(false);
    const recorder = recordingProvider();
    await expect(dispatchMessage(queued.messageId, { provider: recorder.provider, now })).resolves.toEqual({ status: "blocked" });
    expect(recorder.calls).toHaveLength(0);
    expect(await messageRow(queued.messageId)).toMatchObject({ status: "blocked", blocked_reason: "outbound_disabled" });
  });

  it("closes every provider adapter even when its own switch is enabled", async () => {
    setOutbound(false);
    for (const key of providerSwitches) process.env[key] = "true";
    resetEnvCache();
    const names = ["ghl", "resend", "twilio", "meta_whatsapp"] as const;

    const channels = { ghl: "sms", resend: "email", twilio: "sms", meta_whatsapp: "whatsapp" } as const;
    const results = await Promise.all(names.map((name) => transportFor(name).send({
      orgId: crypto.randomUUID(),
      channel: channels[name],
      messageId: crypto.randomUUID(),
      to: channels[name] === "email" ? "person@example.test" : "+15555550123",
      contactRef: "synthetic-contact",
      body: "Synthetic message blocked by the deployment-wide stop.",
      sender: { identity: "sender@example.test", senderId: "123456", accountId: "123456", credentialId: "00000000-0000-4000-8000-000000000000" },
    })));
    expect(results).toHaveLength(4);
    for (const result of results) expect(result).toMatchObject({ ok: false, blocked: true, error: "Outbound customer messaging is disabled for this environment. Nothing was sent." });
  });

  it("blocks website visitor replies instead of exposing the generated answer", async () => {
    setOutbound(false);
    const site = await chatOrg({ title: "Outbound stop test" });
    const token = await start(site);
    const generated = answer("Synthetic reply that must remain private.");
    const response = await embedCall(site, {
      action: "send",
      token,
      body: { text: "Can you help me?", clientMessageId: clientId() },
      generate: generated.generate,
    });

    expect(response.status).toBe(200);
    expect(viewOf(response).messages.some((message) => message.text.includes("Synthetic reply that must remain private."))).toBe(false);
    const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
    const messages = await withSystem((db) => db.query<{ direction: string; status: string; blocked_reason: string | null }>(
      `select direction, status, blocked_reason from conversation_messages
       where conversation_id = (select conversation_id from web_chat_sessions where token_hash = $1)
       order by created_at`,
      [tokenHash],
    ));
    expect(messages.rows.some((message) => message.direction === "outbound" && message.status === "blocked" && message.blocked_reason === "outbound_disabled")).toBe(true);
  });

  it("leaves account verification email available through its separate outbox", async () => {
    setOutbound(false);
    process.env.EMAIL_PROVIDER = "capture";
    resetEnvCache();
    const user = await createUser({ email: `verification-${Date.now()}@example.test` });
    await withSystem((db) => db.query("update users set email_verified_at = null where id = $1", [user.id]));

    await expect(sendVerificationEmail(user.id)).resolves.toEqual({ ok: true });
    const outbox = await withSystem((db) => db.query<{ status: string; template: string }>(
      "select status, template from email_outbox where to_email = $1 order by created_at desc limit 1",
      [user.email],
    ));
    expect(outbox.rows[0]).toEqual({ status: "captured", template: "verify_email" });
  });

  it("refuses a person's direct channel send with a clear message", async () => {
    setOutbound(false);
    const org = await messagingOrg({ name: "Outbound disabled human send" });
    const inboundMessage = await inbound(org.org.id);
    await expect(withSystem((db) => queueOutbound(db, {
      orgId: org.org.id,
      conversationId: inboundMessage.conversationId,
      scope: "human",
      actor: { kind: "human", userId: org.people.owner.id },
      body: "This must also be blocked.",
    }))).rejects.toThrow(/Outbound customer messaging is disabled/);
  });
});
