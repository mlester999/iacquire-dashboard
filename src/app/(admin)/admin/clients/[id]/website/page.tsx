import { notFound } from "next/navigation";
import { Globe } from "lucide-react";
import { requireAgency } from "@/server/tenancy/context";
import { getAgencyWebsiteView } from "@/server/websites/agency";
import { AppError } from "@/server/errors";
import { AgencyWebsitePanel } from "@/components/admin/agency-website-panel";
import { PageHero } from "@/components/ui/workspace";
import { StatusPill } from "@/components/ui/status";
import { HeroIdentity } from "@/components/admin/setup/ui";
import { websiteState } from "@/components/admin/setup/website-state";

export const metadata = { title: "Client website" };

export default async function ClientWebsitePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const user = await requireAgency();
  let data;
  try {
    data = await getAgencyWebsiteView(user, id);
  } catch (err) {
    if (err instanceof AppError && err.code === "not_found") notFound();
    throw err;
  }
  const state = websiteState(data);
  return (
    <div className="space-y-6">
      <PageHero
        eyebrow="Client website" title={data.orgName} icon={<Globe className="size-4" />} tone="neutral"
        aside={<HeroIdentity name={data.orgName} label="Website status"><StatusPill tone={state.tone}>{state.label}</StatusPill></HeroIdentity>}
        description="Whether the site is live and healthy, where it's reachable, and any domain waiting on a price or a purchase. The client's own content is theirs to edit; nothing here changes it."
      />
      <AgencyWebsitePanel orgId={id} data={JSON.parse(JSON.stringify(data))} timeZone={user.timezone} />
    </div>
  );
}
