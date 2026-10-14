import { requireOrgContext } from "@/server/tenancy/context";
import { withUser } from "@/server/db";
import { getBillingOverview } from "@/server/billing/service";
import { BillingWorkspace } from "@/components/billing/billing-workspace";
import { SETUP_FEE_USD } from "@/lib/billing";

export const metadata = { title: "Billing & credits" };

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ return?: string }> }) {
  const ctx = await requireOrgContext("usage.view");
  const { return: returned } = await searchParams;
  const overview = await getBillingOverview(ctx);
  const canSeePayments = ctx.can("billing.view");
  // Invoice, receipt and terms text is owner-only, as before.
  const legacy = canSeePayments
    ? (
        await withUser(ctx.user.id, (db) =>
          db.query<{ setup_fee_cents: number; currency: string; setup_payment_status: string; activation_status: string; invoice_url: string | null; receipt_url: string | null; service_terms: string | null }>(
            "select setup_fee_cents, currency, setup_payment_status, activation_status, invoice_url, receipt_url, service_terms from billing_accounts where org_id = $1",
            [ctx.org.orgId],
          ),
        )
      ).rows[0]
    : undefined;
  const fee = new Intl.NumberFormat("en-US", { style: "currency", currency: legacy?.currency ?? "USD", maximumFractionDigits: 0 }).format((legacy?.setup_fee_cents ?? SETUP_FEE_USD * 100) / 100);
  return (
    <BillingWorkspace
      overview={overview}
      canTopUp={ctx.can("credits.topup")}
      canConfigure={ctx.can("billing.configure")}
      isOwner={ctx.role === "owner"}
      canSeePayments={canSeePayments}
      timeZone={ctx.org.timezone}
      returned={returned === "success" || returned === "cancelled" ? returned : null}
      legacy={{
        setupFeeLabel: fee,
        setupStatus: legacy?.setup_payment_status ?? overview.setup.status,
        activation: legacy?.activation_status ?? "pending",
        invoiceUrl: legacy?.invoice_url ?? null,
        receiptUrl: legacy?.receipt_url ?? null,
        serviceTerms: legacy?.service_terms ?? null,
      }}
    />
  );
}
