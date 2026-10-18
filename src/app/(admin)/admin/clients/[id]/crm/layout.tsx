import { agencyCrmClient } from "@/server/crm/agency-page";
import { agencyActor } from "@/server/crm/actor";
import { getWorkspace } from "@/server/crm/workspace";
import { navFor } from "@/lib/crm/nav";
import { CrmShell } from "@/components/crm/crm-shell";
import { SupportBanner, SupportGate } from "@/components/crm/agency-support";

export const metadata = { title: { default: "Client CRM", template: "%s · Client CRM" } };

export default async function AgencyClientCrmLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { user, org, session } = await agencyCrmClient(id);
  if (!session) return <SupportGate orgId={org.id} orgName={org.name} canWrite={user.platformRole === "agency_super_admin"} />;
  const actor = await agencyActor(user, org.id);
  const ws = await getWorkspace(actor);
  return (
    <CrmShell
      base={`/admin/clients/${org.id}/crm`}
      sections={navFor((p) => actor.can(p), "agency")}
      mode={ws.mode}
      capabilityOwners={ws.capabilities}
      orgName={org.name}
      banner={<SupportBanner orgId={org.id} mode={actor.supportMode === "write" ? "write" : "read"} reason={session.reason} expiresAt={session.expiresAt} initialNow={Date.parse(session.startedAt)} />}
    >
      {children}
    </CrmShell>
  );
}
