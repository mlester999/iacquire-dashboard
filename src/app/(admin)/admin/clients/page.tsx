import { requireAgency } from "@/server/tenancy/context";
import { listClientSetupOverview } from "@/server/setup/snapshots";
import { PageHero } from "@/components/ui/workspace";
import { CreateClientButton } from "@/components/admin/create-client";
import { ClientsTable } from "@/components/admin/clients-table";
import { Card, EmptyState } from "@/components/ui/primitives";
import { Building2 } from "lucide-react";

export const metadata = { title: "Clients" };

export default async function ClientsPage() {
  const user = await requireAgency();
  const rows = await listClientSetupOverview(user);
  const superAdmin = user.platformRole === "agency_super_admin";
  return (
    <div className="module-stack">
      <PageHero
        eyebrow="Client management"
        icon={<Building2 className="size-5"/>}
        title="Every client, in clear view."
        description={superAdmin ? "A living directory of your client workspaces. Follow each setup journey, inspect connection readiness, and keep the right people close to the work." : "Your assigned client workspaces, setup journeys and recorded system health."}
        action={superAdmin ? <CreateClientButton /> : undefined}
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
