import { requireOrgContext } from "@/server/tenancy/context";
import { listAgents } from "@/server/workforce/service";
import { withUser } from "@/server/db";
import { WorkforceGallery } from "@/components/workforce/gallery";
import { EmergencyControls } from "@/components/workforce/operating-controls";
import { getControlState } from "@/server/automation/controls";
import { ChevronDown,ShieldCheck } from "lucide-react";

export const metadata = { title: "AI Workforce" };
export default async function WorkforcePage() {
  const ctx = await requireOrgContext();
  const agents = await listAgents(ctx.user.id, ctx.org.orgId);
  const caps = await withUser(ctx.user.id, (db) => db.query<{ key: string; capabilities: string[] }>("select key, capabilities from agent_roles"));
  const capMap = Object.fromEntries(caps.rows.map((r) => [r.key, r.capabilities]));
  const controls = await withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId));
  return (
    <div className="space-y-6">
      <details className="group rounded-2xl border border-line bg-surface" open={controls.pauses.messaging.active||controls.pauses.outbound.active||controls.pauses.agency.active}>
        <summary className="flex min-h-14 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"><ShieldCheck className="size-4 shrink-0 text-primary" aria-hidden/><span className="min-w-0 flex-1 text-[13px] font-medium">Safety controls<span className="ml-2 hidden text-[12px] font-normal text-muted sm:inline">Pause messaging or outbound actions</span></span><span className="text-[11px] text-muted">{controls.pauses.agency.active?"Agency pause":controls.pauses.messaging.active||controls.pauses.outbound.active?"Pause in effect":"Review controls"}</span><ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden/></summary>
        <div className="border-t border-line p-3"><EmergencyControls messagingPaused={controls.pauses.messaging.active} outboundPaused={controls.pauses.outbound.active} agencyPaused={controls.pauses.agency.active} canPause={ctx.can("automation.pause")} /></div>
      </details>
      <WorkforceGallery agents={agents} capabilities={capMap} companyName={ctx.org.name} canConfigure={ctx.can("agents.configure")} canUse={ctx.can("agents.use")} />
    </div>
  );
}
