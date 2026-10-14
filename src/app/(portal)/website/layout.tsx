import { requireOrgContext } from "@/server/tenancy/context";
import { getWebsite } from "@/server/websites/service";
import { WebsiteSubnav } from "@/components/website/portal/website-subnav";

export default async function WebsiteLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("website.view");
  const site = await getWebsite(ctx);
  return (
    <div className="space-y-5">
      <WebsiteSubnav hasSite={site !== null} canEdit={ctx.can("website.edit")} />
      {children}
    </div>
  );
}
