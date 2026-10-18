import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { getCrmSetupGuide } from "@/server/setup/crm-guide";
import { CrmSetupGuide } from "@/components/setup/crm-setup-guide";

/** CRM → Setup guide (/crm/setup, and the agency's view of a client). Anyone who can open the CRM sees it; owners and admins answer it. */
export async function CrmSetupView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const data = await getCrmSetupGuide(actor);
  await auditSupportView(actor, "crm_setup_guide");
  return <CrmSetupGuide scope={scope} data={JSON.parse(JSON.stringify(data))} />;
}
