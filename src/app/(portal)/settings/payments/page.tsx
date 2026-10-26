import { CreditCard } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { invoicesEnabled } from "@/server/invoices/feature";
import { listConnections } from "@/server/customer-payments/connections";
import { paymentSwitches } from "@/server/customer-payments/switches";
import { PAYMENT_PROVIDERS, type PaymentProviderId } from "@/lib/invoices/connection-rules";
import { InvoicesClientOnly, InvoicesNotEnabled } from "@/components/invoices/notices";
import { ConnectionsPanel } from "@/components/invoices/connections-panel";

export const metadata = { title: "Customer payments" };

/** The business's own payment account for taking customers' invoice payments. Owner only. This is not iAcquire's billing, which is under Billing & credits. */
export default async function CustomerPaymentsSettingsPage() {
  const ctx = await requireOrgContext("invoices.connect_payments");
  if (ctx.org.kind !== "client") return <InvoicesClientOnly canOpenClients={ctx.user.platformRole !== "none"} />;
  if (!(await invoicesEnabled(ctx.org.orgId))) return <InvoicesNotEnabled isOwner={ctx.role === "owner"} />;
  const sw = paymentSwitches();
  const connections = await listConnections(ctx);
  const providers: PaymentProviderId[] = PAYMENT_PROVIDERS.filter((p) => p !== "simulated" || sw.simulatedAllowed);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><CreditCard className="size-5 text-muted" aria-hidden />Customer payments</h1>
        <p className="mt-1 max-w-2xl text-[14px] text-muted">Where your customers&apos; invoice payments go. This is your own payment provider account, not iAcquire&apos;s: iAcquire&apos;s own billing is under Billing &amp; credits.</p>
      </header>
      <ConnectionsPanel connections={connections} providers={providers} callsEnabled={sw.writesEnabled} liveEnabled={sw.liveEnabled} tz={ctx.org.timezone || "UTC"} />
    </div>
  );
}
