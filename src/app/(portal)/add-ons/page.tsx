import Link from "next/link";
import { FolderKanban } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getMaintenancePlan, listMarketplaceServices } from "@/server/catalog/service";
import { Marketplace } from "@/components/projects/marketplace";
import { ButtonLink } from "@/components/ui/button";
import { formatPrice } from "@/lib/projects";

export const metadata = { title: "Custom Projects & Add-ons" };

export default async function AddOnsPage() {
  const ctx = await requireOrgContext("projects.view");
  const [services, plan] = await Promise.all([listMarketplaceServices(ctx.user.id), getMaintenancePlan(ctx.user.id)]);
  return (
    <div className="space-y-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-[.12em] text-primary">Grow with iAcquire</p>
          <h2 className="text-[26px] font-semibold tracking-[-0.02em]">Custom Projects &amp; Add-ons</h2>
          <p className="mt-1 max-w-2xl text-[14px] text-muted">
            Extra automations, AI agents, websites and software built around your business. Everything here is optional, and you always see a written quote before anything is built.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <ButtonLink href="/projects" variant="secondary">
            <FolderKanban className="size-4" /> My projects
          </ButtonLink>
          <ButtonLink href="/our-work" variant="outline">
            Selected work
          </ButtonLink>
        </div>
      </div>
      <Marketplace services={services} canRequest={ctx.can("projects.request")} maintenancePrice={plan?.price ? formatPrice(plan.price) : null} />
      <p className="text-center text-[12px] text-faint">
        Already working with us on something? Track it in <Link href="/projects" className="text-primary hover:underline">My projects</Link>.
      </p>
    </div>
  );
}
