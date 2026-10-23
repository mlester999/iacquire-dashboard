import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { listTemplates } from "@/server/proposals/templates";
import { TemplatesPanel } from "@/components/proposals/templates-panel";

export const metadata = { title: "Proposal templates" };

export default async function ProposalTemplatesPage() {
  const ctx = await requireOrgContext("proposals.view");
  const templates = await listTemplates(memberActor(ctx), { includeArchived: true });
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-[22px] font-semibold tracking-tight text-ink">Templates</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">Reusable wording and a starting set of price book items. Changing a template makes a new version, and the owner approves a version before anyone can start a proposal from it.</p>
      </header>
      <TemplatesPanel orgId={null} templates={templates} canEdit={ctx.can("proposals.catalog")} tz={ctx.org.timezone || "UTC"} />
    </div>
  );
}
