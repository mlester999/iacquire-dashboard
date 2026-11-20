import { afterEach, describe, expect, it, vi } from "vitest";
import { withSystem } from "@/server/db";
import { emailReadiness, OUTBOX_HELD_NOTE, OUTBOUND_HELD_EMAIL_TEMPLATES, sendEmail, type EmailTemplate } from "@/server/email";
import { resetEnvCache } from "@/server/env";
import { dispatchMessage, queueOutbound } from "@/server/messaging/send";
import { OUTBOUND_DISABLED_REASON } from "@/server/messaging/outbound-policy";
import { outboundMessagingEnabled, transportWritesEnabled } from "@/server/messaging/transports/policy";
import { inbound, messagingOrg, messageRow, recordingProvider } from "./support/messaging";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("OUTBOUND_MESSAGING_ENABLED", () => {
  it("defaults to off and blocks a queued conversation message before any provider call", async () => {
    vi.stubEnv("OUTBOUND_MESSAGING_ENABLED", "true");
    vi.stubEnv("TWILIO_WRITES_ENABLED", "true");
    resetEnvCache();
    const org = await messagingOrg({ provider: { sms: "twilio" } });
    const incoming = await inbound(org.org.id, { provider: "twilio" });
    const queued = await withSystem((db) => queueOutbound(db, {
      orgId: org.org.id,
      conversationId: incoming.conversationId,
      scope: "reply",
      actor: { kind: "ai", agentId: org.salesAgentId },
      body: "A synthetic reply for the outbound switch test.",
    }));
    expect(queued.status).toBe("queued");

    // The outbound default is a genuine unset environment variable, after an allowed message has already been queued.
    delete process.env.OUTBOUND_MESSAGING_ENABLED;
    resetEnvCache();
    expect(outboundMessagingEnabled()).toBe(false);
    expect(transportWritesEnabled("twilio")).toBe(false);
    const recorder = recordingProvider("twilio");
    expect(await dispatchMessage(queued.messageId, { transport: recorder.transport })).toEqual({ status: "blocked" });
    expect(recorder.calls).toHaveLength(0);
    expect(await messageRow(queued.messageId)).toMatchObject({ status: "blocked", blocked_reason: OUTBOUND_DISABLED_REASON });
  });

  it("holds prospect/customer emails for a real provider while account mail still goes out", async () => {
    vi.stubEnv("OUTBOUND_MESSAGING_ENABLED", "false");
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "re_test_not_a_real_key_123");
    vi.stubEnv("EMAIL_FROM", "iAcquire <no-reply@iacquire.online>");
    vi.stubEnv("APP_URL", "https://www.iacquire.online");
    resetEnvCache();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ id: "re_test_message" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }));

    expect(outboundMessagingEnabled()).toBe(false);
    expect(emailReadiness().ready).toBe(false);
    expect(OUTBOUND_HELD_EMAIL_TEMPLATES).toEqual(["support_reply", "proposal_code", "demo_link", "purchase_invitation"]);

    const heldTemplates: EmailTemplate[] = ["support_reply", "proposal_code", "demo_link", "purchase_invitation"];
    const recipients = new Map<EmailTemplate, string>();
    for (const template of heldTemplates) {
      const to = `${template.replaceAll("_", "-")}-${Date.now()}@example.test`;
      recipients.set(template, to);
      await expect(sendEmail({ to, template, subject: "Synthetic outbound hold", text: "No external email should be sent." }, undefined, { wait: true }))
        .resolves.toMatchObject({ status: "captured" });
    }
    const invitationTo = `account-invitation-${Date.now()}@example.test`;
    const resetTo = `account-reset-${Date.now()}@example.test`;
    await expect(sendEmail({ to: invitationTo, template: "invitation", subject: "Synthetic invitation", text: "Account access email." }, undefined, { wait: true }))
      .resolves.toMatchObject({ status: "sent" });
    await expect(sendEmail({ to: resetTo, template: "password_reset", subject: "Synthetic reset", text: "Account recovery email." }, undefined, { wait: true }))
      .resolves.toMatchObject({ status: "sent" });

    for (const [template, to] of recipients) {
      const record = await withSystem((db) => db.query<{ status: string; error: string | null; provider: string }>(
        "select status, error, provider from email_outbox where to_email = $1 and template = $2 order by created_at desc limit 1",
        [to, template],
      ));
      expect(record.rows[0]).toEqual({ status: "captured", error: OUTBOX_HELD_NOTE, provider: "resend" });
    }
    expect(await withSystem((db) => db.query<{ n: number }>("select count(*)::int as n from email_outbox where to_email in ($1, $2) and status = 'sent'", [invitationTo, resetTo]))).toMatchObject({ rows: [{ n: 2 }] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
