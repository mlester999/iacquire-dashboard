import { redirect } from "next/navigation";
import { requireOrgContext } from "@/server/tenancy/context";
import { listAgents } from "@/server/workforce/service";
import { isSetupPaymentClearedFor } from "@/server/billing/clearance";
import { withUser } from "@/server/db";
import { WorkforceGallery } from "@/components/workforce/gallery";
import { WorkforceSafetyControls } from "@/components/workforce/safety-controls";
import { getControlState } from "@/server/automation/controls";
import { currentTime } from "@/lib/utils";

export const metadata = { title: "Existing employee profiles" };
export default async function WorkforcePage() {
  const ctx = await requireOrgContext();
  if (ctx.org.kind !== "client") redirect(ctx.user.platformRole === "agency_super_admin" ? "/admin/employees" : ctx.user.platformRole === "agency_staff" ? "/admin/employees/clients" : "/no-workspace");
  const agents = await listAgents(ctx.user.id, ctx.org.orgId);
  // New and fully migrated workspaces use the unified control center. Legacy records remain in
  // the database; this route stays available only while an old profile is still enabled.
  if (!agents.some((agent) => agent.enabled)) redirect("/growth-partner");
  const caps = await withUser(ctx.user.id, (db) => db.query<{ key: string; capabilities: string[] }>("select key, capabilities from agent_roles"));
  const capMap = Object.fromEntries(caps.rows.map((r) => [r.key, r.capabilities]));
  const controls = await withUser(ctx.user.id, (db) => getControlState(db, ctx.org.orgId));
  const paymentCleared = await isSetupPaymentClearedFor(ctx.user.id, ctx.org.orgId);
  return (
    <div className="space-y-6">
      <WorkforceSafetyControls
        messagingPaused={controls.pauses.messaging.active}
        outboundPaused={controls.pauses.outbound.active}
        agencyPaused={controls.pauses.agency.active}
        canPause={ctx.can("automation.pause")}
      />
      <div role="status" className="rounded-xl border border-warning/25 bg-warning-soft/60 px-4 py-3 text-[13px] leading-relaxed text-warning-ink">
        This workspace still has enabled profiles from its previous setup. Their settings, schedules and history remain in place while a Growth Partner migration is reviewed.
      </div>
      <WorkforceGallery agents={agents} capabilities={capMap} companyName={ctx.org.name} canConfigure={ctx.can("agents.configure")} canUse={ctx.can("agents.use")} evaluatedAt={currentTime()} paymentCleared={paymentCleared} />
    </div>
  );
}
