import "server-only";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import type { OrgContext } from "@/server/tenancy/context";
import { toDecimalString, type CurrencyCode } from "@/lib/money";
import { checkoutBlock, type ConnectionMode, type ConnectionStatus, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import { assertInvoicesAvailable } from "@/server/invoices/feature";
import { loadInvoiceRow, toMinor } from "@/server/invoices/core";
import { checkoutTarget } from "@/server/invoices/public";
import { startCheckout } from "@/server/customer-payments/attempts";
import { paymentSwitches } from "@/server/customer-payments/switches";
import type { ProviderResolver } from "@/server/customer-payments/providers";

// A test payment: the owner opens the provider's payment page for one of their own issued invoices through a connection that is in TEST mode, to see that the whole path
// works before any customer is sent there. A test moves no real money. It is recorded as a payment the provider confirmed in test mode, which counts toward THAT invoice's
// paid amount (and so marks it paid) but never as revenue, never starts an automation and never changes a deal. Use an invoice made for the purpose.

/** Whether a test payment could be started in this currency now: a connection in test mode that is ready and authorized, and the owner is the one asking. */
export async function testPaymentPossible(ctx: OrgContext, currency: CurrencyCode): Promise<boolean> {
  if (!ctx.can("invoices.connect_payments")) return false;
  const sw = paymentSwitches();
  const { rows } = await withSystem((db) =>
    db.query<{ provider: PaymentProviderId; mode: ConnectionMode; status: ConnectionStatus; supported_currencies: string[]; authorized_at: Date | null; live_confirmed_at: Date | null }>(
      "select provider, mode, status, supported_currencies, authorized_at, live_confirmed_at from customer_payment_connections where org_id = $1 and mode = 'test' and status <> 'revoked'", [ctx.org.orgId],
    ),
  );
  return rows.some((c) => checkoutBlock({ provider: c.provider, mode: c.mode, status: c.status, supportedCurrencies: c.supported_currencies, authorizedAt: c.authorized_at, liveConfirmedAt: c.live_confirmed_at }, currency, sw, "member") === null);
}

export interface TestPaymentResult {
  url: string;
  invoiceNumber: string | null;
  amountMinor: number;
}

export async function startTestPayment(ctx: OrgContext, invoiceId: string, deps: { providerFor?: ProviderResolver; now?: Date } = {}): Promise<TestPaymentResult> {
  if (!ctx.can("invoices.connect_payments")) throw new AppError("forbidden", "Only the business owner can run a test payment.");
  const inv = await withSystem(async (db) => {
    await assertInvoicesAvailable(db, ctx);
    const row = await loadInvoiceRow(db, ctx.org.orgId, invoiceId);
    if (!row) throw new AppError("not_found", "That invoice was not found.");
    return row;
  });
  const started = await startCheckout({ orgId: ctx.org.orgId, invoiceId, audience: "member", actorUserId: ctx.user.id, onlyMode: "test" }, { providerFor: deps.providerFor, now: deps.now });
  const url = checkoutTarget(started.provider, started.attemptId, started.checkoutUrl);
  if (!url) throw new AppError("conflict", "The test payment page is not available here.");
  await withSystem((db) =>
    recordAudit({
      orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "payments.test_payment_started", targetType: "customer_invoice", targetId: invoiceId, result: "success",
      metadata: { number: inv.number, provider: started.provider, amount: toDecimalString(started.amountMinor, started.currency), currency: started.currency },
    }, db),
  );
  return { url, invoiceNumber: inv.number, amountMinor: toMinor(started.amountMinor) };
}
