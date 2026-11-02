import "server-only";
import type { Queryable } from "@/server/db";
import { recordAudit } from "@/server/audit";

// The email provider's own later notice about a purchase invitation. A message the provider accepted is only "sent" (src/server/purchase-intents/invitations.ts); it becomes "delivered"
// or "bounced" here, and only when the provider's signed webhook says so (the Resend webhook route hands any event it cannot match to a workspace message to this function). The notice
// is matched by the provider's id for the message, which was stored when the message was accepted; nothing in a notice is trusted beyond that id and its type. Nothing moves backwards: a
// bounce is final, a delivery never overwrites it, and a notice for an invitation that was never emailed matches nothing.
//
// This file imports almost nothing on purpose: it runs inside the webhook's transaction, and the webhook must not pull the whole purchase service in with it.

export interface InvitationEmailNotice {
  /** The provider's id for the message (the "email_id" of its event). */
  emailId: string;
  /** The provider's event name without its prefix: delivered, bounced, failed, suppressed, sent, delivery_delayed, complained, opened, clicked... */
  type: string;
  bounceType?: string | null;
  suppressedReason?: string | null;
  failedReason?: string | null;
}

export interface InvitationNoticeResult {
  result: "applied" | "no_change";
  agencyOrgId: string;
}

const words = (text: string | null | undefined, max: number) => (text ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);

/** Applies one provider notice to the invitation delivery it is about, or returns null when it is about none (the caller then treats it as it would any other notice). */
export async function applyInvitationEmailNotice(db: Queryable, notice: InvitationEmailNotice): Promise<InvitationNoticeResult | null> {
  // A database that has not had migration 0119 applied has no deliveries: nothing here can match, and nothing must fail.
  const present = (await db.query<{ ok: boolean }>("select to_regclass('public.purchase_intent_deliveries') is not null as ok")).rows[0]?.ok === true;
  if (!present) return null;
  const row = (await db.query<{ id: string; intent_id: string; agency_org_id: string; kind: string; status: string }>(
    "select id, intent_id, agency_org_id, kind, status from purchase_intent_deliveries where provider_message_id = $1 for update",
    [notice.emailId],
  )).rows[0];
  if (!row) return null;

  let next: { status: "delivered" | "bounced" | "failed"; reason: string | null; error: string | null } | null = null;
  if ((notice.type === "delivered" || notice.type === "complained") && row.status === "sent") {
    // A spam complaint is a notice about a message that reached an inbox: it is delivered, whatever the buyer then did with it.
    next = { status: "delivered", reason: null, error: null };
  } else if (notice.type === "bounced" && (row.status === "sent" || row.status === "delivered")) {
    const kind = words(notice.bounceType, 40).toLowerCase();
    next = { status: "bounced", reason: null, error: kind ? `${kind} bounce` : null };
  } else if ((notice.type === "failed" || notice.type === "suppressed") && row.status === "sent") {
    // The provider took the message and then did not send it (an address on its suppression list, a send that failed): it never reached the buyer.
    const why = words(notice.suppressedReason ?? notice.failedReason, 80).replace(/_/g, " ");
    const what = notice.type === "suppressed" ? "suppressed by the provider" : "failed at the provider";
    next = { status: "failed", reason: "provider_refused", error: why ? `${what}: ${why}` : what };
  }
  if (!next) return { result: "no_change", agencyOrgId: row.agency_org_id };

  await db.query("update purchase_intent_deliveries set status = $2, reason = $3, error = $4 where id = $1", [row.id, next.status, next.reason, next.error]);
  await db.query(
    "insert into purchase_intent_events (intent_id, agency_org_id, kind, detail, actor_kind) values ($1, $2, 'invitation_email', $3::jsonb, 'system')",
    [row.intent_id, row.agency_org_id, JSON.stringify({ deliveryId: row.id, kind: row.kind, status: next.status, reason: next.reason, source: "email_provider_notice" })],
  );
  await recordAudit({
    orgId: row.agency_org_id, actorKind: "system", action: `purchase_intent.invitation_${next.status}`, targetType: "purchase_intent", targetId: row.intent_id,
    result: next.status === "delivered" ? "success" : "failure", metadata: { deliveryId: row.id, kind: row.kind, status: next.status, source: "email_provider_notice" },
  }, db);
  return { result: "applied", agencyOrgId: row.agency_org_id };
}
