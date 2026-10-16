import Link from "next/link";
import { FolderKanban, Sparkles } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getMaintenancePlan, listMarketplaceServices } from "@/server/catalog/service";
import { Marketplace } from "@/components/projects/marketplace";
import { ButtonLink } from "@/components/ui/button";
import { PageHero } from "@/components/ui/workspace";
import { formatPrice } from "@/lib/projects";

export const metadata = { title: "Custom Projects & Add-ons" };

export default async function AddOnsPage() {
  const ctx = await requireOrgContext("projects.view");
  const [services, plan] = await Promise.all([listMarketplaceServices(ctx.user.id), getMaintenancePlan(ctx.user.id)]);
  return (
    <div className="space-y-6">
      <PageHero
        icon={<Sparkles className="size-4" />}
        eyebrow="Grow with iAcquire"
        title="Custom Projects & Add-ons"
        description="Extra automations, AI agents, websites and software built around your business. Everything here is optional, and you always see a written quote before anything is built."
        action={<>
          <ButtonLink href="/projects" variant="secondary">
            <FolderKanban className="size-4" /> My projects
          </ButtonLink>
          <ButtonLink href="/our-work" variant="outline">
            Selected work
          </ButtonLink>
        </>}
      />
      <Marketplace services={services} canRequest={ctx.can("projects.request")} maintenancePrice={plan?.price ? formatPrice(plan.price) : null} />
      <p className="text-center text-[12px] text-faint">
        Already working with us on something? Track it in <Link href="/projects" className="text-primary hover:underline">My projects</Link>.
      </p>
    </div>
  );
}
