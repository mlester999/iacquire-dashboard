import { requireOrgContext } from "@/server/tenancy/context";
import { getTargeting, listLeads, listResearchRequests } from "@/server/leads/service";
import { getAgentByRole } from "@/server/workforce/service";
import { LeadsWorkspace } from "@/components/leads/leads-workspace";
import { canChat } from "@/lib/agents";

export const metadata = { title: "Leads" };

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { tab } = await searchParams;
  const ctx = await requireOrgContext("leads.view");
  const [leads, requests, targeting, hunter] = await Promise.all([
    listLeads(ctx, "all"),
    listResearchRequests(ctx),
    getTargeting(ctx),
    getAgentByRole(ctx.user.id, ctx.org.orgId, "lead_hunter"),
  ]);
  return (
    <LeadsWorkspace
      leads={JSON.parse(JSON.stringify(leads))}
      requests={JSON.parse(JSON.stringify(requests))}
      targeting={targeting}
      hunterReady={Boolean(hunter?.enabled && canChat(hunter.status))}
      hunterStatus={hunter?.enabled ? hunter.status : "disabled"}
      canResearch={ctx.can("leads.research")}
      canReview={ctx.can("leads.review")}
      canExport={ctx.can("leads.export")}
      initialTab={tab ?? "review"}
      timeZone={ctx.org.timezone}
    />
  );
}
