import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { emailReadiness } from "@/server/email";
import { env } from "@/server/env";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { SessionUser } from "@/server/auth/service";
import { testResendCapability } from "@/server/messaging/transports/resend";
import { actorFor, requireManage } from "@/server/purchase-intents/service";

// "Check email setup": whether a purchase invitation sent from this environment would really leave, and whether the provider's later notices (delivered, bounced) would be accepted.
// Configuration alone cannot say that: only the email provider knows whether the sender's domain is verified. So this asks it, with iAcquire's own key, using the same read-only
// check the workspace channels use (testResendCapability): the key is accepted, the sender's domain is in the account and verified for sending, and the account's webhook to this
// site is signed with RESEND_WEBHOOK_SECRET. It sends nothing, creates nothing and never returns the key. A Super Admin only, and rate-limited.
//
// What it cannot prove is said, not hidden: a key that can only send cannot read a domain's status, so the answer is "could not be checked", never "verified".

export interface EmailSetupCheck {
  ok: boolean;
  checkedAt: string;
  /** The sender as configured (an address, not a secret). */
  sender: string;
  /** One sentence for the whole answer. */
  headline: string;
  checks: Array<{ label: string; ok: boolean; detail: string }>;
}

/** The workspace Inbox's reply checks are about receiving customers' replies, which a purchase invitation does not use. */
const NOT_ABOUT_INVITATIONS = new Set(["Replies"]);

export async function checkEmailSetup(user: SessionUser, deps: { fetch?: typeof fetch; now?: Date } = {}): Promise<EmailSetupCheck> {
  const now = deps.now ?? new Date();
  const agencyId = await withSystem(async (db) => requireManage(await actorFor(db, user)));
  const limit = await consumeRateLimit(RATE_LIMITS.emailSetupCheckByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", `The email setup was checked several times already. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`, { retryAfterSeconds: limit.retryAfterSeconds });

  const readiness = emailReadiness();
  let result: EmailSetupCheck;
  if (!readiness.ready) {
    // Nothing to ask the provider yet: say what is missing, by the name of the setting.
    result = {
      ok: false,
      checkedAt: now.toISOString(),
      sender: readiness.sender,
      headline: "Email is not set up in this environment, so an invitation would be created but not emailed.",
      checks: readiness.problems.map((detail) => ({ label: "Configuration", ok: false, detail })),
    };
  } else {
    const e = env();
    const asked = await testResendCapability({ secret: e.RESEND_API_KEY ?? "", senderIdentity: e.EMAIL_FROM, inboundAddress: null }, { fetch: deps.fetch, now });
    const checks = [{ label: "Configuration", ok: true, detail: "EMAIL_PROVIDER, RESEND_API_KEY and EMAIL_FROM are set." }, ...asked.checks.filter((c) => !NOT_ABOUT_INVITATIONS.has(c.label))];
    const webhook = checks.find((c) => c.label === "Webhooks");
    const ok = checks.every((c) => c.ok);
    result = {
      ok,
      checkedAt: asked.checkedAt,
      sender: readiness.sender,
      headline: ok
        ? `Email can be sent from ${readiness.sender}, and the provider's delivery notices will be accepted.`
        : checks.find((c) => !c.ok && c.label !== "Webhooks")
          ? "Email could not be confirmed as ready: fix the first item below, then check again."
          : `Email can be sent, but delivery notices are not confirmed (${webhook?.detail ?? "the webhook was not checked"}). Invitations will stay at "Sent to the email provider" until they are.`,
      checks,
    };
  }

  await recordAudit({
    orgId: agencyId, actorUserId: user.id, actorKind: "agency", action: "email_setup.checked", targetType: "email_setup", result: result.ok ? "success" : "failure",
    metadata: { ok: result.ok, failed: result.checks.filter((c) => !c.ok).map((c) => c.label), sender: result.sender },
  });
  return result;
}
