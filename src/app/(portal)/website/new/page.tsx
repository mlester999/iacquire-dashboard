import { redirect } from "next/navigation";
import { Palette } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite } from "@/server/websites/service";
import { buildSiteDetails } from "@/server/websites/details";
import { NewWebsite } from "@/components/website/portal/new-website";
import { listPublishedCards } from "@/server/websites/templates";
import { industryFilterFor } from "@/lib/website/gallery";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Choose a website style" };

export default async function NewWebsitePage() {
  const ctx = await requireOrgContext("website.create");
  if (await getWebsite(ctx)) redirect("/website");
  const details = await buildSiteDetails(ctx);
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title="Choose a design to start from." icon={<Palette className="size-4" />} tone="neutral"
        description="Browse complete designs, preview them on desktop, tablet and phone, and pick the one that feels right. It becomes your own website, and every part of it can be changed. Nothing goes live until you publish."
      />
      <NewWebsite cards={await listPublishedCards()} preferIndustry={industryFilterFor(details.industry)} />
    </div>
  );
}
