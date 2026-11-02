import { Landmark } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getFinancialReport } from "@/server/billing/finance";
import { getAgencyBillingOverview } from "@/server/billing/service";
import { listCurrentUnitRates } from "@/server/billing/rates";
import { listAgencyPayments } from "@/server/billing/payments-view";
import { getPaymentHealthFor } from "@/server/billing/provider-health";
import { FinanceWorkspace } from "@/components/admin/finance-workspace";
import { PageHero } from "@/components/ui/workspace";
import { isPeriodKey, resolvePeriod } from "@/lib/finance";

export const metadata = { title: "Billing & finance" };
export const dynamic = "force-dynamic";

const TABS = ["statement", "entries", "payments", "rates", "providers", "clients"] as const;

export default async function AdminBillingPage({ searchParams }: { searchParams: Promise<{ tab?: string; period?: string }> }) {
  const user = await requireAgency();
  const q = await searchParams;
  const periodKey = isPeriodKey(q.period) ? q.period : "this_month";
  const tab = (TABS as readonly string[]).includes(q.tab ?? "") ? (q.tab as (typeof TABS)[number]) : "statement";
  // The payment providers' health is read (never the providers themselves) only where it is shown: its own tab, and the status line on Rates & payments.
  const [report, overview, rates, paymentList, paymentHealth] = await Promise.all([
    getFinancialReport(user, resolvePeriod(periodKey)), getAgencyBillingOverview(user), listCurrentUnitRates(), listAgencyPayments(user),
    tab === "providers" || tab === "rates" ? getPaymentHealthFor(user) : Promise.resolve(null),
  ]);
  return (
    <div className="module-stack space-y-6">
      <PageHero
        icon={<Landmark />}
        eyebrow="Billing & finance"
        title="Know where the money actually is."
        description="Cash received, prepaid credit, usage margin, fees, costs, tax and the operating reserve, each on its own line. Gross revenue is never called profit, and the one planning estimate says what it leaves out."
      />
      <FinanceWorkspace report={report} overview={overview} rates={rates} canManage={user.platformRole === "agency_super_admin"} tab={tab} period={periodKey} payments={paymentList.payments} paymentClients={paymentList.clients} timeZone={user.timezone} paymentHealth={paymentHealth} />
    </div>
  );
}
