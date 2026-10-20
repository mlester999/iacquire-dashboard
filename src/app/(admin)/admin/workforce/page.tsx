import { requireAgency } from "@/server/tenancy/context";
import { listAgencyAgents, listAllAgents } from "@/server/admin/queries";
import { WorkforceManager } from "@/components/admin/workforce-manager";
import { AgencyWorkforceManager } from "@/components/admin/agency-workforce-manager";
import { withSystem } from "@/server/db";
import { listHermesGateways } from "@/server/integrations/hermes/gateways";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";
import { countInternalHeldConfigReviews } from "@/server/workforce/reviews";
import Link from "next/link";
import { ShieldAlert } from "lucide-react";

export const metadata = { title: "AI Workforce" };

export default async function AdminWorkforcePage() {
  const user = await requireAgency();
  if (user.platformRole === "agency_super_admin") await ensureAgencyWorkspace(user).catch(() => null);
  const [agents, agencyAgents, gateways, agencyTimezoneRows, internalReviewCount] = await Promise.all([
    listAllAgents(user),
    listAgencyAgents(user),
    user.platformRole === "agency_super_admin" ? withSystem(listHermesGateways) : Promise.resolve([]),
    withSystem((db) => db.query<{ timezone: string }>("select timezone from organizations where kind='agency' order by created_at limit 1")),
    user.platformRole === "agency_super_admin" ? countInternalHeldConfigReviews(user.id) : Promise.resolve(0),
  ]);
  return (
    <div className="module-stack">
      {user.platformRole === "agency_super_admin" && internalReviewCount > 0 && (
        <Link href="/admin/workforce/reviews" className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning-soft/40 px-4 py-3 text-[13px] text-warning-ink hover:bg-warning-soft/60">
          <ShieldAlert className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{internalReviewCount} internal configuration {internalReviewCount === 1 ? "change needs" : "changes need"} review.</span>{" "}
            Sensitive internal edits are held here, not in the client review queue.
          </span>
          <span className="font-medium">Review →</span>
        </Link>
      )}
      {user.platformRole === "agency_super_admin" && <AgencyWorkforceManager agents={agencyAgents} gateways={gateways} canManage timeZone={agencyTimezoneRows.rows[0]?.timezone ?? "UTC"} />}
      <WorkforceManager agents={agents} />
    </div>
  );
}
