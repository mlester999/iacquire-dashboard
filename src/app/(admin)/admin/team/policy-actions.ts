"use server";

import { revalidatePath } from "next/cache";
import { guard } from "@/server/action-guard";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { setClientContentPolicy } from "@/server/admin/client-content-policy";

/** A Super Admin turns the stricter rule for a client's approvals, activity, knowledge and leads on or off, saying why (founder decision D70, open). */
export async function setClientContentPolicyAction(sessionRequired: boolean, note: string) {
  return guard(async () => {
    const user = await requireAgencyOrThrow("super_admin");
    const out = await setClientContentPolicy(user, { sessionRequired: sessionRequired === true, note: String(note ?? "") });
    revalidatePath("/admin/team");
    return out;
  });
}
