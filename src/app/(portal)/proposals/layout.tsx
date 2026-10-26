import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { featureOn, PROPOSALS_FEATURE } from "@/server/proposals/features";
import { listProposals } from "@/server/proposals/proposals";
import { ProposalsClientOnly, ProposalsNotEnabled } from "@/components/proposals/notices";
import { ProposalsSubnav } from "@/components/proposals/subnav";

export default async function ProposalsLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireOrgContext("proposals.view");
  // Proposals are a client workspace's own offer to its own customers. An agency workspace gets an honest notice, and its pages are never rendered (so they query nothing).
  if (ctx.org.kind !== "client") return <ProposalsClientOnly canOpenClients={ctx.user.platformRole !== "none"} />;
  // A Super Admin switches the module on per workspace. Until then every page of it says so, and nothing is read.
  if (!(await featureOn(ctx.org.orgId, PROPOSALS_FEATURE))) return <ProposalsNotEnabled isOwner={ctx.role === "owner"} />;
  const waiting = (await listProposals(memberActor(ctx), { statuses: ["pending_approval"], limit: 200 })).length;
  return (
    <div className="space-y-5">
      <ProposalsSubnav waiting={waiting} />
      {children}
    </div>
  );
}
