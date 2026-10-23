import { Settings } from "lucide-react";
import { requireOrgContext } from "@/server/tenancy/context";
import { memberActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { listPipelines } from "@/server/crm/pipelines";
import { listTags } from "@/server/crm/tags";
import { getProposalSettings } from "@/server/proposals/settings";
import { ProposalSettingsPanel } from "@/components/proposals/settings-panel";

export const metadata = { title: "Proposal settings" };

export default async function ProposalSettingsPage() {
  const ctx = await requireOrgContext("proposals.view");
  const actor = memberActor(ctx);
  const canEdit = ctx.can("proposals.settings");
  // The tag and stage lists are only for the owner's choices. Someone who cannot see them still sees the settings.
  const [settings, workspace, tags, pipelines] = await Promise.all([
    getProposalSettings(actor),
    getWorkspace(actor),
    canEdit ? listTags(actor).catch(() => []) : Promise.resolve([]),
    canEdit ? listPipelines(actor).catch(() => []) : Promise.resolve([]),
  ]);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="flex items-center gap-2 text-[22px] font-semibold tracking-tight text-ink"><Settings className="size-5 text-muted" aria-hidden />Settings</h1>
        <p className="mt-1 max-w-2xl text-[13.5px] text-muted">Who has to approve proposals, what the AI may do, and what happens to the deal. Everything starts off or at its safest.</p>
      </header>
      <ProposalSettingsPanel
        settings={settings} currency={workspace.defaultCurrency} canEdit={canEdit}
        tags={tags.map((t) => ({ id: t.id, name: t.name }))}
        stages={pipelines.flatMap((p) => p.stages.filter((s) => s.kind === "open").map((s) => ({ id: s.id, name: s.name, pipelineName: p.name })))}
      />
    </div>
  );
}
