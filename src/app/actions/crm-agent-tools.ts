"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { resolveCrmActor } from "@/server/crm/request";
import { revokeAgentToolAccess } from "@/server/crm/agent-tools/tokens";

const uuid = z.string().uuid();
const orgArg = z.string().uuid().nullable().optional();

/** Emergency control on CRM Settings → AI Employee Tools: ends every live CRM tool credential of one AI employee now. */
export async function revokeAgentToolAccessAction(orgId: string | null, agentId: string) {
  return guard(async () => {
    const actor = await resolveCrmActor(orgArg.parse(orgId) ?? null, "automation.pause");
    const out = await revokeAgentToolAccess(actor, uuid.parse(agentId));
    revalidatePath("/crm/settings/ai-tools");
    return out;
  });
}
