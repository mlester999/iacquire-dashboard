import { requireOrgContext } from "@/server/tenancy/context";
import { listAgents } from "@/server/workforce/service";
import { withUser } from "@/server/db";
import { WorkforceGallery } from "@/components/workforce/gallery";
import { EmergencyControls } from "@/components/workforce/operating-controls";
import { getControlState } from "@/server/automation/controls";

export const metadata = { title: "AI Workforce" };
export default async function WorkforcePage() {
  const ctx = await requireOrgContext();
  const agents = await listAgents(ctx.user.id, ctx.org.orgId);
  const caps = await withUser(ctx.user.id, (db) => db.query<{ key: string; capabilities: string[] }>("select key, capabilities from agent_roles"));
  const capMap = Object.fromEntries(caps.rows.map((r) => [r.key, r.capabilities]));
  const controls = await withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId));
  return (
    <div className="space-y-6">
      <EmergencyControls messagingPaused={controls.pauses.messaging.active} outboundPaused={controls.pauses.outbound.active} agencyPaused={controls.pauses.agency.active} canPause={ctx.can("automation.pause")} />
      <WorkforceGallery agents={agents} capabilities={capMap} companyName={ctx.org.name} canConfigure={ctx.can("agents.configure")} canUse={ctx.can("agents.use")} />
    </div>
  );
}
