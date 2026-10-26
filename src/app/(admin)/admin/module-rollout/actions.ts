"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import { setModuleSwitch } from "@/server/admin/module-rollout";

// Super Admin only: the call checks the signed-in person's platform role on the server (and so does each module's own service). The change must be confirmed, the key must be one
// of the six modules, and nothing here writes org_features: the module's own audited service does. Nothing here connects an account or switches a provider on.

/** Switches one module on or off for one client workspace. `confirmed` is the person's yes in the confirmation dialog; without it nothing happens. */
export async function setModuleSwitchAction(orgId: string, key: string, enabled: boolean, confirmed: boolean) {
  return guard(async () => {
    const out = await setModuleSwitch(await requireAgencyOrThrow("super_admin"), { orgId, key, enabled: enabled === true, confirmed: confirmed === true });
    revalidatePath("/admin/module-rollout");
    return out;
  });
}
