import "server-only";
import type { Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { markSetupFeePaid } from "@/server/billing/clearance";
import { afterSetupCleared } from "@/server/billing/after-clearing";

/**
 * A setup fee that the payment provider itself confirmed, written as the canonical payment of the client workspace that the purchase created. The money was confirmed by a
 * signed notice against a checkout of a purchase intent (src/server/purchase-intents/checkout.ts) BEFORE this workspace existed, so this does not verify anything: it adopts
 * that checkout's evidence into the workspace's own payment record, the same row shape a checkout started from inside a workspace would have produced. Everything that
 * follows is then the existing path: the setup fee is marked paid against this payment, the AI employees' provisioning requests open, and a later refund or dispute notice
 * for this payment finds this row (by the provider's payment id) and is reported like any other.
 *
 * Repeating it for the same checkout returns the same payment and writes nothing twice (the database allows one payment per provider checkout).
 */

export interface AdoptedCheckout {
  id: string;
  provider: "paymongo" | "paypal";
  reference_number: string;
  usd_amount_cents: number;
  charged_currency: string;
  charged_amount_minor: string | number;
  fx_rate: string | number | null;
  fx_source: string | null;
  fx_at: Date | string | null;
  livemode: boolean;
  provider_checkout_id: string | null;
  provider_payment_id: string | null;
  fee_minor: string | number | null;
  paid_at: Date | string | null;
  status: string;
}

export interface ProviderSetupPaymentResult {
  paymentId: string;
  /** The payment already existed for this checkout: nothing was written. */
  duplicate: boolean;
  clearedSetup: boolean;
  provisioningRequested: number;
}

export async function recordProviderSetupPayment(db: Queryable, o: { orgId: string; checkout: AdoptedCheckout; actorUserId: string | null }): Promise<ProviderSetupPaymentResult> {
  const c = o.checkout;
  if (c.status !== "paid" || !c.provider_checkout_id || !c.provider_payment_id || !c.paid_at) throw new AppError("conflict", "That checkout was not confirmed paid by the payment provider.");
  const existing = (await db.query<{ id: string; org_id: string }>("select id, org_id from payments where provider = $1 and provider_checkout_id = $2", [c.provider, c.provider_checkout_id])).rows[0];
  if (existing) {
    if (existing.org_id !== o.orgId) throw new AppError("conflict", "That payment already belongs to another workspace.");
    return { paymentId: existing.id, duplicate: true, clearedSetup: false, provisioningRequested: 0 };
  }
  const account = (await db.query<{ setup_fee_cents: number; setup_payment_status: string }>("select setup_fee_cents, setup_payment_status from billing_accounts where org_id = $1 for update", [o.orgId])).rows[0];
  if (!account) throw new AppError("not_found", "This client has no billing account.");
  if (account.setup_fee_cents !== c.usd_amount_cents) throw new AppError("conflict", "The paid amount is not this workspace's agreed setup fee.");
  const inserted = (await db.query<{ id: string }>(
    `insert into payments (org_id, kind, status, description, usd_amount_micros, charged_currency, charged_amount_minor, fx_rate, fx_source, fx_at, provider, livemode, reference_number,
       provider_checkout_id, provider_payment_id, fee_minor, paid_at)
     values ($1, 'setup_fee', 'paid', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
    [o.orgId, "Setup fee (paid online before the workspace was created)", c.usd_amount_cents * 10_000, c.charged_currency, c.charged_amount_minor, c.fx_rate, c.fx_source, c.fx_at, c.provider, c.livemode,
      c.reference_number, c.provider_checkout_id, c.provider_payment_id, c.fee_minor, c.paid_at],
  )).rows[0];
  const marked = await markSetupFeePaid(db, { orgId: o.orgId, paymentId: inserted.id, updatedBy: o.actorUserId });
  let provisioningRequested = 0;
  if (marked.first) provisioningRequested = (await afterSetupCleared(db, o.orgId, { actorUserId: o.actorUserId, how: "payment", eventKey: inserted.id })).provisioningRequested;
  await recordAudit({
    orgId: o.orgId, actorUserId: o.actorUserId, actorKind: o.actorUserId ? "agency" : "system", action: "billing.provider_setup_payment_adopted", targetType: "payment", targetId: inserted.id, result: "success",
    metadata: { reference: c.reference_number, provider: c.provider, clearedSetup: marked.first },
  }, db);
  return { paymentId: inserted.id, duplicate: false, clearedSetup: marked.first, provisioningRequested };
}
