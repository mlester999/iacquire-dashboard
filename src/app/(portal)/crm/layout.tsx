import { clientCrmActor } from "@/server/crm/page";
import { getWorkspace } from "@/server/crm/workspace";
import { CrmShell } from "@/components/crm/crm-shell";
import { navFor } from "@/lib/crm/nav";

export const metadata = { title: { default: "CRM", template: "%s · CRM" } };

export default async function CrmLayout({ children }: { children: React.ReactNode }) {
  const actor = await clientCrmActor();
  const ws = await getWorkspace(actor);
  return (
    <CrmShell base="/crm" sections={navFor((p) => actor.can(p), "client")} mode={ws.mode} capabilityOwners={ws.capabilities} orgName={actor.orgName}>
      {children}
    </CrmShell>
  );
}
