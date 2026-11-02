import "server-only";
import { z } from "zod";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { appUrl, emailReadiness, sendEmail, type EmailDelivery } from "@/server/email";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import type { SessionUser } from "@/server/auth/service";
import { buildInvitationEmail, IDEMPOTENCY_KEY, type DeliveryKind, type DeliveryReason, type DeliveryStatus, type DeliveryView } from "@/lib/purchase-intents/delivery";
import {
  addEvent, createPurchaseIntentSchema, createPurchaseIntentWithDelivery, deliveryViewOf, DELIVERY_COLUMNS, getPurchaseIntent, reissuePurchaseLink,
  type DeliveryRequest, type DeliveryRow, type IntentRow, type PurchaseIntentView, SELECT,
} from "@/server/purchase-intents/service";

// Putting a purchase link in a buyer's hands, by email, honestly. A purchase link is a bearer credential and only its hash is stored, so:
//   * the email is sent from the request that makes the link: the raw link exists in memory for that long and nowhere else, and the outbox keeps a copy of the email with the link cut out;
//   * "send it again" is "make a NEW link and send that", because the old one cannot be recovered (and the old one stops working, which is also what a lost or leaked link needs);
//   * what happened is a row (purchase_intent_deliveries), written before the email is attempted and settled by the provider's answer: pending, sent (the provider accepted it, which is
//     not proof of delivery), failed, or manual (no email was attempted, a person shares the link). Nothing here ever writes "delivered": only the provider's own notice can.
// The browser never sends email. If email is not ready the invitation is still made and the link is handed to the Super Admin to share, with the reason in words.

export const inviteBuyerSchema = createPurchaseIntentSchema.extend({
  /** "Send the invitation by email": on unless the Super Admin turns it off. */
  sendEmail: z.boolean().optional().default(true),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY, "Reload the form and try again.").optional(),
});
export type InviteBuyerInput = z.input<typeof inviteBuyerSchema>;

export interface InviteResult {
  /** True when an earlier request with the same key already made this invitation: nothing new was made and nothing more was sent. */
  replayed: boolean;
  intent: PurchaseIntentView;
  /** The raw link token. Null on a replay. It is shown to the Super Admin (never stored): behind a button when the email went out, up front when it did not. */
  token: string | null;
  delivery: DeliveryView | null;
}

const failureReasonOf = (error: string | null): DeliveryReason => (error?.startsWith("Provider responded") ? "provider_refused" : "provider_unreachable");

/** Maps what the mail layer answered to the delivery's own words. */
export function settleOutcome(outcome: Pick<EmailDelivery, "status" | "error" | "providerId">): { status: Exclude<DeliveryStatus, "pending" | "delivered" | "bounced">; reason: DeliveryReason | null; error: string | null; providerMessageId: string | null } {
  if (outcome.status === "sent") return { status: "sent", reason: null, error: null, providerMessageId: outcome.providerId ?? null };
  // "captured" means the environment stores mail without sending it; "queued" cannot happen when the caller waits. Neither is a send.
  if (outcome.status === "captured" || outcome.status === "queued") return { status: "manual", reason: "email_off", error: null, providerMessageId: null };
  return { status: "failed", reason: failureReasonOf(outcome.error ?? null), error: (outcome.error ?? "The email could not be sent.").slice(0, 300), providerMessageId: null };
}

interface SendInput {
  user: SessionUser;
  row: Pick<IntentRow, "id" | "agency_org_id" | "reference" | "buyer_name" | "buyer_email" | "company" | "setup_fee_cents" | "maintenance_selected" | "maintenance_monthly_cents" | "timezone">;
  deliveryId: string;
  kind: Exclude<DeliveryKind, "rotation">;
  token: string;
  expiresAt: string;
  now: Date;
}

/**
 * Sends the invitation email for a delivery that is pending, waits for the provider's answer, and settles the delivery, the timeline and the audit trail with what really happened.
 * Never throws for a delivery problem: a provider that is down or refuses the sender becomes a "failed" delivery the Super Admin can see and act on.
 */
async function sendInvitationEmail(input: SendInput): Promise<void> {
  const link = appUrl(`/purchase/${input.token}`);
  const built = buildInvitationEmail({
    kind: input.kind, buyerName: input.row.buyer_name, company: input.row.company, reference: input.row.reference, setupFeeCents: input.row.setup_fee_cents,
    maintenanceSelected: input.row.maintenance_selected, maintenanceMonthlyCents: input.row.maintenance_monthly_cents, expiresAt: input.expiresAt, timezone: input.row.timezone, link,
  });
  let outcome: EmailDelivery;
  let outboxId: string | null = null;
  try {
    outcome = await sendEmail({ to: input.row.buyer_email, template: "purchase_invitation", subject: built.subject, text: built.text, storedText: built.storedText }, undefined, { wait: true });
    outboxId = outcome.id;
  } catch {
    outcome = { id: "", status: "failed", error: "The email could not be queued." };
  }
  const settled = settleOutcome(outcome);
  await withSystem(async (db) => {
    const done = await db.query(
      `update purchase_intent_deliveries set status = $2, reason = $3, outbox_id = $4, provider_message_id = $5, error = $6, attempts = attempts + 1, completed_at = $7
        where id = $1 and status = 'pending'`,
      [input.deliveryId, settled.status, settled.reason, outboxId, settled.providerMessageId, settled.error, input.now.toISOString()],
    );
    if (!done.rowCount) return;
    await addEvent(db, input.row.id, input.row.agency_org_id, "invitation_email", { deliveryId: input.deliveryId, kind: input.kind, status: settled.status, reason: settled.reason }, input.user.id, "user");
    await recordAudit({
      orgId: input.row.agency_org_id, actorUserId: input.user.id, actorKind: "agency", action: `purchase_intent.invitation_${settled.status}`, targetType: "purchase_intent", targetId: input.row.id,
      result: settled.status === "failed" ? "failure" : "success", metadata: { reference: input.row.reference, deliveryId: input.deliveryId, kind: input.kind, status: settled.status, reason: settled.reason },
    }, db);
  });
}

const rowFor = async (id: string): Promise<IntentRow> => {
  const row = (await withSystem((db) => db.query<IntentRow>(`${SELECT} where id = $1`, [id]))).rows[0];
  if (!row) throw new AppError("not_found", "That purchase was not found.");
  return row;
};

const currentDelivery = async (id: string | null, now: Date): Promise<DeliveryView | null> => {
  if (!id) return null;
  const row = (await withSystem((db) => db.query<DeliveryRow>(`select ${DELIVERY_COLUMNS} from purchase_intent_deliveries where id = $1`, [id]))).rows[0];
  return row ? deliveryViewOf(row, now) : null;
};

const readinessFor = (): DeliveryRequest["readiness"] => {
  const r = emailReadiness();
  return { ready: r.ready, reason: r.reason, provider: r.provider };
};

async function limitInvitations(user: SessionUser) {
  const limit = await consumeRateLimit(RATE_LIMITS.purchaseInviteByUser, user.id);
  if (!limit.allowed) throw new AppError("rate_limited", `Too many invitations were made in the last hour. Try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`, { retryAfterSeconds: limit.retryAfterSeconds });
}

/**
 * The invitation form's one action: creates the invitation (freezing the approved price), records how the link will reach the buyer, and, when asked and ready, emails it. Safe to
 * repeat with the same idempotency key (one invitation, one email). If email is off or fails the invitation still exists and the Super Admin is handed the link with the reason.
 */
export async function inviteBuyer(user: SessionUser, rawInput: InviteBuyerInput, opts: { now?: Date } = {}): Promise<InviteResult> {
  const input = inviteBuyerSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  await limitInvitations(user);
  const { sendEmail: wantEmail, idempotencyKey, ...intentInput } = input;
  const request: DeliveryRequest = { email: wantEmail, readiness: readinessFor(), idempotencyKey: idempotencyKey ?? null };
  let created;
  try {
    created = await createPurchaseIntentWithDelivery(user, intentInput, { now, delivery: request });
  } catch (error) {
    // Two requests with one key can both pass the first look and meet at the database's one-open-purchase-per-buyer rule: the loser reads the winner's invitation instead of failing.
    if (idempotencyKey && /duplicate key|unique/i.test(error instanceof Error ? error.message : "")) created = await createPurchaseIntentWithDelivery(user, intentInput, { now, delivery: request });
    else throw error;
  }
  if (created.replayed) {
    return { replayed: true, intent: await getPurchaseIntent(user, created.id, { now }), token: null, delivery: await currentDelivery(created.deliveryId, now) };
  }
  if (created.deliveryId && created.token) {
    const deliveryNow = await currentDelivery(created.deliveryId, now);
    if (deliveryNow?.status === "pending") {
      await sendInvitationEmail({ user, row: await rowFor(created.id), deliveryId: created.deliveryId, kind: "invitation", token: created.token, expiresAt: created.expiresAt, now });
    }
  }
  return { replayed: false, intent: await getPurchaseIntent(user, created.id, { now }), token: created.token, delivery: await currentDelivery(created.deliveryId, now) };
}

export const resendSchema = z.object({
  /** True: make a new link and email it. False: make a new link and hand it to the Super Admin to share. */
  email: z.boolean().optional().default(true),
  idempotencyKey: z.string().regex(IDEMPOTENCY_KEY, "Reload the page and try again.").optional(),
});
export type ResendInput = z.input<typeof resendSchema>;

/**
 * Makes a NEW link for an open purchase (the old one stops working at once: this is also the answer to a lost, expired or leaked link) and emails it. A repeated press with the same
 * key finds the link already made instead of making another, so a double click cannot kill the link that was just emailed.
 */
export async function resendInvitation(user: SessionUser, id: string, rawInput: ResendInput = {}, opts: { now?: Date } = {}): Promise<InviteResult> {
  const input = resendSchema.parse(rawInput);
  const now = opts.now ?? new Date();
  await limitInvitations(user);
  const request: DeliveryRequest & { kind: "resend" | "rotation" } = { kind: input.email ? "resend" : "rotation", email: input.email, readiness: readinessFor(), idempotencyKey: input.idempotencyKey ?? null };
  const made = await reissuePurchaseLink(user, id, { now, delivery: request });
  if (made.replayed || !made.token || !made.deliveryId) {
    return { replayed: true, intent: await getPurchaseIntent(user, id, { now }), token: null, delivery: await currentDelivery(made.deliveryId, now) };
  }
  const deliveryNow = await currentDelivery(made.deliveryId, now);
  if (deliveryNow?.status === "pending") {
    await sendInvitationEmail({ user, row: await rowFor(id), deliveryId: made.deliveryId, kind: "resend", token: made.token, expiresAt: made.expiresAt, now });
  }
  return { replayed: false, intent: await getPurchaseIntent(user, id, { now }), token: made.token, delivery: await currentDelivery(made.deliveryId, now) };
}
