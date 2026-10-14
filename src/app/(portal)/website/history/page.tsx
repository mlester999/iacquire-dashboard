import { redirect } from "next/navigation";
import { History } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite, listPublications, listVersions } from "@/server/websites/service";
import { listAssets } from "@/server/assets/service";
import { HistoryView } from "@/components/website/portal/history-view";
import { PageHero } from "@/components/ui/workspace";

export const metadata = { title: "Website history" };

export default async function WebsiteHistoryPage() {
  const ctx = await requireOrgContext("website.view");
  const site = await getWebsite(ctx);
  if (!site) redirect("/website");
  const [versions, publications, assets] = await Promise.all([listVersions(ctx), listPublications(ctx), listAssets(ctx)]);
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Website" title="History and rollback" icon={<History className="size-4" />} tone="neutral"
        description="Every draft you've saved and every version you've published is kept. Nothing you do here can lose your work."
      />
      <HistoryView
        versions={JSON.parse(JSON.stringify(versions))} publications={JSON.parse(JSON.stringify(publications))} assets={JSON.parse(JSON.stringify(assets))}
        draftRevision={site.draftRevision} canEdit={ctx.can("website.edit")} canPublish={ctx.can("website.publish")} timeZone={ctx.org.timezone}
      />
    </div>
  );
}
