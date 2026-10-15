import { notFound } from "next/navigation";
import { Globe } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { AppError } from "@/server/errors";
import { getManagedWebsite } from "@/server/websites/admin";
import { listComments, reviewSummary } from "@/server/websites/review";
import { getWebsite, listPublications, preflight } from "@/server/websites/service";
import { studioContext } from "@/server/websites/studio-ctx";
import { listPublishedCards } from "@/server/websites/templates";
import { PageHero } from "@/components/ui/workspace";
import { ClientWebsiteWorkspace } from "@/components/website/admin/client-website-workspace";
import { CreateForClient } from "@/components/website/admin/create-for-client";

export const metadata = { title: "Client website" };

export default async function ClientWebsitePage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) notFound();
  const user = await requireAgency();
  let ctx;
  try {
    ctx = await studioContext(orgId, "website.view");
  } catch (err) {
    if (err instanceof AppError) notFound();
    throw err;
  }
  const site = await getWebsite(ctx);
  if (!site) {
    return (
      <div className="module-stack">
        <PageHero eyebrow="Website Studio" icon={<Globe className="size-5" />} title={`Create a website for ${ctx.org.name}`} description="Choose a design. We write a private first draft from the client's own business details; nothing goes live until it is published." />
        <CreateForClient orgId={orgId} clientName={ctx.org.name} cards={await listPublishedCards()} canCreate={ctx.can("website.edit")} />
      </div>
    );
  }
  const [managed, review, comments, publications, pf] = await Promise.all([getManagedWebsite(user, orgId), reviewSummary(ctx), listComments(ctx), listPublications(ctx), preflight(ctx)]);
  if (!managed) notFound();
  return (
    <ClientWebsiteWorkspace
      orgId={orgId} timeZone={user.timezone}
      site={JSON.parse(JSON.stringify(managed))} summary={JSON.parse(JSON.stringify(site))} review={JSON.parse(JSON.stringify(review))}
      comments={JSON.parse(JSON.stringify(comments))} publications={JSON.parse(JSON.stringify(publications))} preflight={JSON.parse(JSON.stringify(pf))}
      perms={{ edit: ctx.can("website.edit"), publish: ctx.can("website.publish"), review: ctx.can("website.review"), domains: ctx.can("website.domains") }}
    />
  );
}
