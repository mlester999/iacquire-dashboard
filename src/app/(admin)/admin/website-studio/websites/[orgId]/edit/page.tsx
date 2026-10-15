import { notFound, redirect } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { listAssets } from "@/server/assets/service";
import { getDraft, getWebsite } from "@/server/websites/service";
import { studioContext } from "@/server/websites/studio-ctx";
import { assistantAiAvailable } from "@/server/websites/assistant";
import { listComponents } from "@/server/websites/components";
import { SiteEditor } from "@/components/website/editor/editor";

export const metadata = { title: "Website Editor" };

/** An agency user in a client's editor. Access is the same as the client team's, scoped to the clients they are assigned to. */
export default async function AgencyEditPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) notFound();
  await requireAgency();
  let ctx;
  try {
    ctx = await studioContext(orgId, "website.edit");
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  const [site, draft] = await Promise.all([getWebsite(ctx), getDraft(ctx)]);
  if (!site || !draft) redirect(`/admin/website-studio/websites/${orgId}`);
  const [assets, aiAvailable, saved] = await Promise.all([listAssets(ctx), assistantAiAvailable(), listComponents(ctx).catch(() => [])]);
  const primary = site.domains.find((d) => d.isPrimary && d.status === "active") ?? null;
  return (
    <SiteEditor
      agency
      site={{
        name: site.name, content: draft.content, revision: draft.revision, templateKey: draft.templateKey, platformHost: site.platformHost,
        liveHost: site.published ? (primary?.hostname ?? site.platformHost) : null, approval: site.approval.status, isLive: site.published !== null, hasUnpublishedChanges: site.hasUnpublishedChanges,
        orgId, clientName: ctx.org.name,
      }}
      initialAssets={JSON.parse(JSON.stringify(assets))}
      canPublish={ctx.can("website.publish")}
      canApprove={ctx.can("website.approve")}
      canUpload={ctx.can("workspace.manage_profile")}
      assistant={{ ai: aiAvailable }}
      initialSaved={JSON.parse(JSON.stringify(saved))}
      backHref={`/admin/website-studio/websites/${orgId}`}
    />
  );
}
