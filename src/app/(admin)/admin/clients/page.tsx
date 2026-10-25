import { requireAgency } from "@/server/tenancy/context";
import { listClientSetupOverview } from "@/server/setup/snapshots";
import { CoverageBar, PageHero } from "@/components/ui/workspace";
import { CreateClientButton } from "@/components/admin/create-client";
import { ClientsTable } from "@/components/admin/clients-table";
import { countStates, STATE, STATE_ORDER, type StateKey } from "@/components/admin/client-state";
import { Card, EmptyState } from "@/components/ui/primitives";
import { Building2 } from "lucide-react";

export const metadata = { title: "Clients" };

const STATE_COLOR: Record<StateKey, string> = {
  awaiting_onboarding: "var(--warning)",
  in_setup: "var(--primary)",
  ready_for_review: "var(--violet)",
  activated: "var(--success)",
  not_started: "var(--faint)",
  suspended: "var(--danger)",
};

export default async function ClientsPage() {
  const user = await requireAgency();
  const rows = await listClientSetupOverview(user);
  const superAdmin = user.platformRole === "agency_super_admin";
  const counts = countStates(rows);
  return (
    <div className="module-stack">
      <PageHero
        eyebrow="Client management"
        icon={<Building2 className="size-5" />}
        title="Every client, in clear view."
        description={superAdmin ? "A living directory of your client workspaces. Follow each setup journey, inspect connection readiness, and keep the right people close to the work." : "Your assigned client workspaces, setup journeys and recorded system health."}
        action={superAdmin ? <CreateClientButton /> : undefined}
        aside={
          rows.length > 0 ? (
            <div className="w-full rounded-2xl border border-line-strong bg-surface/85 p-4 shadow-card sm:p-5 lg:w-[340px]">
              <div className="flex items-baseline justify-between gap-3">
                <p className="text-[12px] font-semibold uppercase tracking-[0.14em] text-muted">Pipeline at a glance</p>
                <p className="text-[12px] text-muted">
                  <strong className="text-[15px] font-semibold tabular-nums tracking-tight text-ink">{rows.length}</strong> {rows.length === 1 ? "client" : "clients"}
                </p>
              </div>
              <div className="mt-4">
                <CoverageBar label="Clients by state" parts={STATE_ORDER.filter((k) => counts[k] > 0).map((k) => ({ label: STATE[k].label, count: counts[k], color: STATE_COLOR[k] }))} />
              </div>
            </div>
          ) : undefined
        }
      />
      {rows.length === 0 ? (
        <Card>
          <EmptyState icon={<Building2 className="size-5" />} title="No clients yet" description="Create a client workspace to invite its owner and start onboarding." action={superAdmin ? <CreateClientButton /> : undefined} />
        </Card>
      ) : (
        <ClientsTable rows={rows} timeZone={user.timezone} />
      )}
    </div>
  );
}
