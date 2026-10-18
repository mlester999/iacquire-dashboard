"use server";

import { actionError } from "@/server/errors";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { listOnboardingBlueprintChoices } from "@/server/admin/tenants";

/**
 * The CRM setups the create-client dialog offers: published Blueprints and the iAcquire starters not yet in the library. Creating clients is
 * for super admins, so this is too. Loaded when the dialog opens, so the client list page doesn't read the library on every visit.
 */
export async function onboardingBlueprintChoicesAction() {
  try {
    const admin = await requireAgencyOrThrow("super_admin");
    return { ok: true as const, data: await listOnboardingBlueprintChoices(admin) };
  } catch (err) {
    return actionError(err);
  }
}
