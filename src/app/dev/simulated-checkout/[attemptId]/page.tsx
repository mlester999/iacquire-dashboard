import { notFound } from "next/navigation";
import { FlaskConical } from "lucide-react";
import { Logo } from "@/components/brand";
import { Button } from "@/components/ui/button";
import { money } from "@/lib/invoices/labels";
import { loadSimulatedAttempt } from "@/server/customer-payments/dev-checkout";
import { simulatedAllowed } from "@/server/customer-payments/switches";

export const dynamic = "force-dynamic";
export const metadata = { title: "Testing checkout", robots: { index: false, follow: false } };

/**
 * Development only: stands in for a payment provider's page when the business's connection is the simulated provider. Nothing here is a real payment. It posts a signed event
 * to the real webhook route, as a provider would, and the customer is sent on to the same page a real provider sends them to. Returns 404 in production.
 */
export default async function SimulatedCheckoutPage({ params }: { params: Promise<{ attemptId: string }> }) {
  if (!simulatedAllowed()) notFound();
  const { attemptId } = await params;
  const a = await loadSimulatedAttempt(attemptId);
  if (!a) notFound();
  const open = a.status === "created" || a.status === "redirected";
  const action = `/dev/simulated-checkout/${a.attemptId}/complete`;
  return (
    <main className="mx-auto max-w-md px-4 py-10">
      <Logo />
      <div className="mt-6 rounded-2xl border border-warning-ink/30 bg-warning-soft px-4 py-3 text-[14px] text-warning-ink" role="note">
        <p className="flex items-center gap-2 font-semibold"><FlaskConical className="size-4" aria-hidden />Testing checkout</p>
        <p className="mt-1">This stands in for a payment provider&apos;s page. No card is asked for and no money moves.</p>
      </div>
      <h1 className="mt-6 text-[22px] font-semibold tracking-tight text-ink">Pay {money(a.amountMinor, a.currency)}</h1>
      <p className="mt-1 text-[14px] text-muted">{a.invoiceNumber ? `Invoice ${a.invoiceNumber}` : "An invoice"}. Reference <span className="break-all font-mono text-[13px]">{a.reference}</span></p>
      {open ? (
        <div className="mt-6 space-y-3">
          <form method="post" action={action}><input type="hidden" name="choice" value="pay" /><Button type="submit" variant="brand" size="lg" className="w-full">Pay as a test</Button></form>
          <form method="post" action={action}><input type="hidden" name="choice" value="decline" /><Button type="submit" variant="secondary" size="lg" className="w-full">Decline the payment</Button></form>
          <form method="post" action={action}><input type="hidden" name="choice" value="cancel" /><Button type="submit" variant="ghost" size="lg" className="w-full">Cancel and go back</Button></form>
        </div>
      ) : (
        <p role="status" className="mt-6 rounded-xl border border-line bg-surface-2 px-4 py-3 text-[14px] text-ink-2">This checkout is closed ({a.status.replace(/_/g, " ")}), so it cannot be paid.</p>
      )}
    </main>
  );
}
