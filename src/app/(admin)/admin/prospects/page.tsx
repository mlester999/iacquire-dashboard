import { redirect } from "next/navigation";
import { requireAgency } from "@/server/tenancy/context";
import { prospectsCapabilities } from "@/server/demo/access";
import { assignableOwners, listProspects, prospectsSummary } from "@/server/demo/admin";
import { getDemoSettings } from "@/server/demo/settings";
import { demoDeploymentEnabled, demoPublicDisabled } from "@/server/demo/switch";
import { demoModelState } from "@/server/demo/generator";
import { parseListQuery } from "@/lib/demo/admin-view";
import { ProspectsList } from "@/components/demo/admin/prospects-list";

export const metadata = { title: "Demo prospects" };
export const dynamic = "force-dynamic";

export default async function ProspectsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireAgency();
  // The page is for agency managers and Super Admins. Anyone else is sent to the overview; the functions below check again, from the database, on this request.
  const caps = await prospectsCapabilities(user);
  if (!caps.view) redirect("/admin");
  const query = parseListQuery(await searchParams);
  const now = new Date();
  const [summary, list, owners, stored, model] = await Promise.all([
    prospectsSummary(user, now),
    listProspects(user, { status: query.status, owner: query.owner || undefined, search: query.search, after: query.after ?? undefined, limit: 25 }, now),
    assignableOwners(user),
    getDemoSettings(user),
    demoModelState(),
  ]);
  return (
    <ProspectsList
      summary={summary}
      rows={list.rows}
      hasMore={list.hasMore}
      query={query}
      owners={owners}
      switches={{ environment: demoDeploymentEnabled(), emergencyStop: demoPublicDisabled(), enabled: stored.settings.enabled, aiEnabled: stored.settings.aiEnabled, modelReady: model.ready }}
      canManage={caps.manage}
      timeZone={user.timezone}
      now={now.toISOString()}
    />
  );
}
