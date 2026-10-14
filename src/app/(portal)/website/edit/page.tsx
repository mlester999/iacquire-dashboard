import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { getDraft, getWebsite } from "@/server/websites/service";
import { buildSiteDetails } from "@/server/websites/details";
import { listAssets } from "@/server/assets/service";
import { SiteEditor } from "@/components/website/studio/site-editor";

export const metadata = { title: "Edit website" };

export default async function EditWebsitePage() {
  const ctx = await requireOrgContext("website.edit");
  const [site, draft] = await Promise.all([getWebsite(ctx), getDraft(ctx)]);
  if (!site || !draft) redirect("/website/new");
  const [assets, details] = await Promise.all([listAssets(ctx), buildSiteDetails(ctx)]);
  const primary = site.domains.find((d) => d.isPrimary && d.status === "active") ?? null;
  return (
    <SiteEditor
      site={{
        content: draft.content, revision: draft.revision, templateKey: draft.templateKey, platformHost: site.platformHost,
        liveHost: site.published ? (primary?.hostname ?? site.platformHost) : null, approval: site.approval.status, isLive: site.published !== null,
      }}
      initialAssets={JSON.parse(JSON.stringify(assets))}
      details={JSON.parse(JSON.stringify(details))}
      industry={details.industry}
      canPublish={ctx.can("website.publish")}
      year={new Date().getFullYear()}
    />
  );
}
