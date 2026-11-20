import { requireAgency } from "@/server/tenancy/context";
import { listAgencyAgents, listAllAgents, listGrowthPartners } from "@/server/admin/queries";
import { WorkforceManager } from "@/components/admin/workforce-manager";
import { GrowthPartnerManager } from "@/components/admin/growth-partner-manager";
import { AgencyWorkforceManager } from "@/components/admin/agency-workforce-manager";
import { withSystem } from "@/server/db";
import { listHermesGateways } from "@/server/integrations/hermes/gateways";
import { ensureAgencyWorkspace } from "@/server/workforce/agency";
import { countInternalHeldConfigReviews } from "@/server/workforce/reviews";
import Link from "next/link";
import { ChevronDown, ShieldAlert } from "lucide-react";
import { Card, CardContent } from "@/components/ui/primitives";

export const metadata = { title: "AI Growth Partner Operations" };

export default async function AdminWorkforcePage() {
  const user = await requireAgency();
  if (user.platformRole === "agency_super_admin") await ensureAgencyWorkspace(user).catch(() => null);
  const [agents, partnerResult, agencyAgents, gateways, agencyTimezoneRows, internalReviewCount] = await Promise.all([
    listAllAgents(user),
    listGrowthPartners(user).then((partners) => ({ partners, error: false })).catch(() => ({ partners: [], error: true })),
    listAgencyAgents(user),
    user.platformRole === "agency_super_admin" ? withSystem(listHermesGateways) : Promise.resolve([]),
    withSystem((db) => db.query<{ timezone: string }>("select timezone from organizations where kind='agency' order by created_at limit 1")),
    user.platformRole === "agency_super_admin" ? countInternalHeldConfigReviews(user.id) : Promise.resolve(0),
  ]);
  const { partners } = partnerResult;
  return (
    <div className="module-stack">
      {partnerResult.error && (
        <Card role="alert" aria-label="Growth Partner fleet unavailable" className="border-danger/25 bg-danger-soft/30">
          <CardContent className="py-5 text-sm text-danger-ink">Growth Partner fleet status could not be loaded. Refresh the page to try again.</CardContent>
        </Card>
      )}
      {user.platformRole === "agency_super_admin" && internalReviewCount > 0 && (
        <Link href="/admin/employees/reviews" className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning-soft/40 px-4 py-3 text-[14px] text-warning-ink hover:bg-warning-soft/60">
          <ShieldAlert className="size-4 shrink-0" aria-hidden />
          <span className="min-w-0 flex-1">
            <span className="font-semibold">{internalReviewCount} internal configuration {internalReviewCount === 1 ? "change needs" : "changes need"} review.</span>{" "}
            Sensitive internal edits are held here, not in the client review queue.
          </span>
          <span className="font-medium">Review →</span>
        </Link>
      )}
      {!partnerResult.error && <GrowthPartnerManager partners={partners} />}
      <details className="group rounded-2xl border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none flex-wrap items-center gap-2 px-5 py-3 [&::-webkit-details-marker]:hidden">
          <span className="font-semibold text-ink">Previous profile activity</span>
          <span className="text-sm text-muted">{agents.length} client records</span>
          <ChevronDown className="ml-auto size-4 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-line p-3 sm:p-5"><WorkforceManager agents={agents} /></div>
      </details>
      {user.platformRole === "agency_super_admin" && <details className="group rounded-2xl border border-line bg-surface">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-2 px-5 py-3 font-semibold text-ink [&::-webkit-details-marker]:hidden">
          Internal agency profiles and gateways
          <ChevronDown className="size-4 shrink-0 text-muted transition-transform group-open:rotate-180" aria-hidden />
        </summary>
        <div className="border-t border-line p-3 sm:p-5"><AgencyWorkforceManager agents={agencyAgents} gateways={gateways} canManage timeZone={agencyTimezoneRows.rows[0]?.timezone ?? "UTC"} /></div>
      </details>}
    </div>
  );
}
