import type { Metadata } from "next";
import { requestMeta } from "@/server/auth/session";
import { loadPublicInvoice } from "@/server/invoices/public";
import { InvoiceDocument } from "@/components/invoices/public/invoice-document";
import { PayPanel } from "@/components/invoices/public/pay-panel";
import { PublicNotice, PublicShell } from "@/components/invoices/public/shell";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Your invoice", robots: { index: false, follow: false }, referrer: "no-referrer" };

/**
 * Where a customer lands from the link in an invoice. The token in the address is the only credential: the business, the invoice and the amount are read from the
 * link's own row. Reading it needs no script; paying does. It never says "paid" until the database does, and it asks the server for the provider's page rather than
 * deciding anything itself.
 */
export default async function InvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const meta = await requestMeta();
  const result = await loadPublicInvoice(token, { ip: meta.ip });

  if (result.state === "rate_limited") {
    return (
      <PublicShell business={null}>
        <PublicNotice kind="wait" title="One moment, please">
          <p>This link has been opened many times in a short while. Wait a few minutes, then open it again.</p>
        </PublicNotice>
      </PublicShell>
    );
  }
  if (result.state === "invalid") {
    return (
      <PublicShell business={null}>
        <PublicNotice kind="invalid" title="This link isn't valid">
          <p>It may have been cut short when it was copied, or the business may have replaced it with a new one. Open the link straight from the message you received, or ask the business for a new one.</p>
        </PublicNotice>
      </PublicShell>
    );
  }
  const i = result.invoice;
  return (
    <PublicShell business={i.business} wide>
      <InvoiceDocument invoice={i} />
      <PayPanel token={token} canPay={i.canPayOnline} balanceMinor={i.balanceMinor} currency={i.currency} />
    </PublicShell>
  );
}
