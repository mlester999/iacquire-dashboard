import { requireOrgContext } from "@/server/tenancy/context";
import { listAgents } from "@/server/workforce/service";
import { withUser } from "@/server/db";
import { WorkforceGallery } from "@/components/workforce/gallery";
import { EmergencyControls } from "@/components/workforce/operating-controls";
import { getControlState } from "@/server/automation/controls";
import { ChevronDown,ShieldCheck } from "lucide-react";
import { StatusPill } from "@/components/ui/status";
import { IconTile } from "@/components/overview/panel";

export const metadata = { title: "AI Workforce" };
export default async function WorkforcePage() {
  const ctx = await requireOrgContext();
  const agents = await listAgents(ctx.user.id, ctx.org.orgId);
  const caps = await withUser(ctx.user.id, (db) => db.query<{ key: string; capabilities: string[] }>("select key, capabilities from agent_roles"));
  const capMap = Object.fromEntries(caps.rows.map((r) => [r.key, r.capabilities]));
  const controls = await withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId));
  const paused=controls.pauses.messaging.active||controls.pauses.outbound.active||controls.pauses.agency.active;
  return (
    <div className="space-y-6">
      <details className="group card-surface overflow-hidden rounded-2xl" open={paused}>
        <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 transition-colors hover:bg-surface-2/50 focus-visible:outline-2 focus-visible:outline-offset-[-3px] focus-visible:outline-primary [&::-webkit-details-marker]:hidden"><IconTile tone={paused?"warning":"primary"}><ShieldCheck/></IconTile><span className="min-w-0 flex-1"><span className="block text-[14px] font-semibold tracking-tight">Safety controls</span><span className="mt-0.5 hidden text-[12.5px] text-muted sm:block">Pause messaging or outbound actions at any time.</span></span>{controls.pauses.agency.active?<StatusPill tone="danger">Agency pause</StatusPill>:controls.pauses.messaging.active||controls.pauses.outbound.active?<StatusPill tone="warning">Pause in effect</StatusPill>:<StatusPill tone="success">Nothing paused</StatusPill>}<ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden/></summary>
        <div className="border-t border-line p-3"><EmergencyControls messagingPaused={controls.pauses.messaging.active} outboundPaused={controls.pauses.outbound.active} agencyPaused={controls.pauses.agency.active} canPause={ctx.can("automation.pause")} /></div>
      </details>
      <WorkforceGallery agents={agents} capabilities={capMap} companyName={ctx.org.name} canConfigure={ctx.can("agents.configure")} canUse={ctx.can("agents.use")} />
    </div>
  );
}
