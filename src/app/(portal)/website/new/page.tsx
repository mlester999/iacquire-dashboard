import { redirect } from "next/navigation";
import { Palette } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite } from "@/server/websites/service";
import { buildSiteDetails } from "@/server/websites/details";
import { NewWebsite } from "@/components/website/portal/new-website";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Choose a website style" };

export default async function NewWebsitePage() {
  const ctx = await requireOrgContext("website.edit");
  if (await getWebsite(ctx)) redirect("/website");
  const details = await buildSiteDetails(ctx);
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title="Pick a look. We'll write the first draft." icon={<Palette className="size-4" />} tone="neutral"
        description="Every style below is shown with your own business name, colours and services. Pick the one that feels right; you can change it later without losing a word. Nothing goes live until you publish."
      />
      <NewWebsite details={JSON.parse(JSON.stringify(details))} industry={details.industry} />
    </div>
  );
}
