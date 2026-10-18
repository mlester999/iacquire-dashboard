import { getAgentToolsOverview } from "@/server/crm/agent-tools/overview";
import { auditSupportView, type CrmActor } from "@/server/crm/actor";
import type { CrmScope } from "@/server/crm/page";
import { AiToolsScreen } from "@/components/crm/agent-tools/ai-tools-screen";

export async function AiToolsView({ actor, scope }: { actor: CrmActor; scope: CrmScope }) {
  const overview = await getAgentToolsOverview(actor);
  await auditSupportView(actor, "crm_ai_tools");
  return <AiToolsScreen scope={scope} overview={overview} />;
}
