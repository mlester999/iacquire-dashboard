"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import { activateMaintenance, resolveMaintenanceSubscription, updateMaintenanceRequest } from "@/server/maintenance/service";

const refresh = () => {
  revalidatePath("/admin/maintenance");
  revalidatePath("/maintenance");
};

export async function activateMaintenanceAction(id: string, billingStartOn?: string) {
  return guard(async () => {
    await activateMaintenance(await requireAgencyOrThrow(), id, { billingStartOn });
    refresh();
  });
}
export async function resolveMaintenanceAction(id: string, action: "decline" | "confirm_cancellation") {
  return guard(async () => {
    await resolveMaintenanceSubscription(await requireAgencyOrThrow(), id, action);
    refresh();
  });
}
export async function updateMaintenanceRequestAction(id: string, changes: Parameters<typeof updateMaintenanceRequest>[2]) {
  return guard(async () => {
    await updateMaintenanceRequest(await requireAgencyOrThrow(), id, changes);
    refresh();
  });
}
