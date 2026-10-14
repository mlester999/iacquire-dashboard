import { redirect } from "next/navigation";
import { Globe } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite } from "@/server/websites/service";
import { dnsInstructions } from "@/server/websites/domains";
import { env } from "@/server/env";
import { DomainsView } from "@/components/website/portal/domains-view";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Website domains" };

export default async function DomainsPage() {
  const ctx = await requireOrgContext("website.view");
  const site = await getWebsite(ctx);
  if (!site) redirect("/website");
  const instructions = Object.fromEntries(site.domains.filter((d) => d.kind === "custom").map((d) => [d.id, dnsInstructions(d)]));
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title="Your website address" icon={<Globe className="size-4" />} tone="neutral"
        description="Your site works on its included address straight away. If you want your own name, connect a domain you own, or ask us to get one for you. We never buy a domain without your approval."
      />
      <DomainsView
        platformHost={site.platformHost} subdomain={site.subdomain} baseDomain={env().SITES_BASE_DOMAIN}
        domains={JSON.parse(JSON.stringify(site.domains))} instructions={JSON.parse(JSON.stringify(instructions))}
        canManage={ctx.can("website.domains")} canApprove={ctx.can("website.approve")} hasPublished={site.published !== null}
      />
    </div>
  );
}
