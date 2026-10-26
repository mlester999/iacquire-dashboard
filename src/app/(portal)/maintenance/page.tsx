import { requireOrgContext } from "@/server/tenancy/context";
import { getMaintenanceOverview } from "@/server/maintenance/service";
import { Wrench } from "lucide-react";
import { PageHero } from "@/components/ui/workspace";
import { MaintenancePanel } from "@/components/projects/maintenance-panel";
import { ReturnRefresh } from "@/components/purchase-intents/return-refresh";

export const metadata = { title: "Managed maintenance" };

export default async function MaintenancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const back = Array.isArray(q.return) ? q.return[0] : q.return;
  const ctx = await requireOrgContext("maintenance.view");
  const overview = await getMaintenanceOverview(ctx);
  return (
    <div className="space-y-6">
      {back === "success" && (
        <p role="status" className="rounded-xl border border-line bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink-2">
          Thank you. PayMongo confirms a payment to iAcquire directly, and your plan updates when it does, usually within a minute. This page does not decide that a payment arrived; it looks again every few seconds and shows the new paid-through date once PayMongo has confirmed.
        </p>
      )}
      {back === "success" && <ReturnRefresh active />}
      {back === "cancelled" && (
        <p role="status" className="rounded-xl border border-line bg-surface px-4 py-3 text-[14px] leading-relaxed text-ink-2">You left PayMongo&apos;s page without paying. Nothing was charged and your plan has not changed.</p>
      )}
      <PageHero icon={<Wrench className="size-4" />} eyebrow="Optional" title="Managed maintenance" description="Hands-on upkeep for your live iAcquire system. It's never required to use what you already have, and nothing here enrolls you automatically." />
      <MaintenancePanel overview={overview} timeZone={ctx.org.timezone} canManagePlan={ctx.can("maintenance.manage_plan")} canRequest={ctx.can("maintenance.request")} />
    </div>
  );
}
