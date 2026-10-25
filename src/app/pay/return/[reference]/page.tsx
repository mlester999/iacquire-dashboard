import type { Metadata } from "next";
import { requestMeta } from "@/server/auth/session";
import { loadReturn } from "@/server/invoices/public";
import { INVOICES_DISABLED_NOTICE } from "@/lib/invoices/public-http";
import { money } from "@/lib/invoices/labels";
import { ReturnStatus } from "@/components/invoices/public/return-status";
import { PublicNotice, PublicShell } from "@/components/invoices/public/shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your payment", robots: { index: false, follow: false }, referrer: "no-referrer" };

const one = (v: string | string[] | undefined): string | undefined => (typeof v === "string" ? v : undefined);

/**
 * Where the provider sends a customer after its payment page. The address carries one checkout's reference (never the invoice's link) and, for a provider where approving
 * does not take the money by itself, the checkout the customer approved. Neither changes what the page says: the page says "we are confirming your payment" until the
 * database holds a payment for this checkout, and it asks the server again for a few minutes.
 */
export default async function PaymentReturnPage({ params, searchParams }: { params: Promise<{ reference: string }>; searchParams: Promise<{ result?: string | string[]; token?: string | string[] }> }) {
  const { reference } = await params;
  const q = await searchParams;
  const meta = await requestMeta();
  const result = await loadReturn(reference, { ip: meta.ip, saidCancelled: one(q.result) === "cancelled" });

  if (result.state === "rate_limited") {
    return (
      <PublicShell business={null}>
        <PublicNotice kind="wait" title="One moment, please">
          <p>This page has been opened many times in a short while. Wait a few minutes, then open it again.</p>
        </PublicNotice>
      </PublicShell>
    );
  }
  if (result.state === "disabled") {
    return (
      <PublicShell business={null}>
        <PublicNotice kind="wait" title={INVOICES_DISABLED_NOTICE.title}>
          <p>{INVOICES_DISABLED_NOTICE.body} If you just paid and want to check on it, contact the business and tell them the time you paid.</p>
        </PublicNotice>
      </PublicShell>
    );
  }
  if (result.state === "invalid") {
    return (
      <PublicShell business={null}>
        <PublicNotice kind="invalid" title="This page isn't valid">
          <p>It may have been cut short when it was copied. If you just paid and want to check on it, contact the business and tell them the time you paid.</p>
        </PublicNotice>
      </PublicShell>
    );
  }
  const v = result.view;
  const approved = one(q.token);
  return (
    <PublicShell business={v.business}>
      <ReturnStatus reference={v.reference} initial={{ state: v.description.state, headline: v.description.headline, detail: v.description.detail, polling: v.description.polling, tone: v.description.tone }} approvedCheckoutId={approved && /^[A-Za-z0-9_-]{4,120}$/.test(approved) && v.description.polling ? approved : null} />
      <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-2xl border border-line bg-surface px-5 py-4 text-[14px]">
        {v.invoiceNumber && <><dt className="text-muted">Invoice</dt><dd className="font-medium tabular-nums text-ink">{v.invoiceNumber}{v.isTest ? " (a test invoice: no money moves)" : ""}</dd></>}
        <dt className="text-muted">Amount of this payment</dt><dd className="font-medium tabular-nums text-ink">{money(v.amountMinor, v.currency)}</dd>
        <dt className="text-muted">Reference</dt><dd className="break-all font-mono text-[13px] text-ink-2">{v.reference}</dd>
      </dl>
      <p className="mt-3 text-[13px] text-muted">Keep the reference if you need to ask {v.business.name} about this payment.</p>
    </PublicShell>
  );
}
