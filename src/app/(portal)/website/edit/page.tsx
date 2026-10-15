import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { getDraft, getWebsite } from "@/server/websites/service";
import { listAssets } from "@/server/assets/service";
import { assistantAiAvailable } from "@/server/websites/assistant";
import { listComponents } from "@/server/websites/components";
import { SiteEditor } from "@/components/website/editor/editor";

export const metadata = { title: "Edit website" };

export default async function EditWebsitePage() {
  const ctx = await requireOrgContext("website.edit");
  const [site, draft] = await Promise.all([getWebsite(ctx), getDraft(ctx)]);
  if (!site || !draft) redirect("/website/new");
  const [assets, aiAvailable, saved] = await Promise.all([listAssets(ctx), assistantAiAvailable(), listComponents(ctx).catch(() => [])]);
  const primary = site.domains.find((d) => d.isPrimary && d.status === "active") ?? null;
  return (
    <SiteEditor
      site={{
        name: site.name, content: draft.content, revision: draft.revision, templateKey: draft.templateKey, platformHost: site.platformHost,
        liveHost: site.published ? (primary?.hostname ?? site.platformHost) : null, approval: site.approval.status, isLive: site.published !== null, hasUnpublishedChanges: site.hasUnpublishedChanges,
      }}
      initialAssets={JSON.parse(JSON.stringify(assets))}
      canPublish={ctx.can("website.publish")}
      canApprove={ctx.can("website.approve")}
      canUpload={ctx.can("workspace.manage_profile")}
      assistant={{ ai: aiAvailable }}
      initialSaved={JSON.parse(JSON.stringify(saved))}
      backHref="/website"
    />
  );
}
