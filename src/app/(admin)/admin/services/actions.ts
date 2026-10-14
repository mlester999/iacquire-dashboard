"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import { listPriceHistory, saveCategory, saveService, setServiceFlags, categoryInputSchema, type ServiceInput } from "@/server/catalog/service";
import type { z } from "zod";
import type { ServiceAvailability } from "@/lib/projects";

const refresh = () => {
  revalidatePath("/admin/services");
  revalidatePath("/add-ons");
};

export async function saveServiceAction(input: ServiceInput) {
  return guard(async () => {
    const r = await saveService(await requireAgencyOrThrow("super_admin"), input);
    refresh();
    return r;
  });
}
export async function setServiceFlagsAction(id: string, flags: { visible?: boolean; featured?: boolean; availability?: ServiceAvailability }) {
  return guard(async () => {
    await setServiceFlags(await requireAgencyOrThrow("super_admin"), id, flags);
    refresh();
  });
}
export async function priceHistoryAction(id: string) {
  return guard(async () => {
    const rows = await listPriceHistory(await requireAgencyOrThrow("super_admin"), id);
    return rows.map((r) => ({
      version: r.version,
      type: r.price_type,
      minCents: r.min_cents,
      maxCents: r.max_cents,
      note: r.note,
      source: r.source,
      at: new Date(r.effective_at).toISOString(),
      by: r.by,
    }));
  });
}

export async function saveCategoryAction(input: z.input<typeof categoryInputSchema>) {
  return guard(async () => {
    const r = await saveCategory(await requireAgencyOrThrow("super_admin"), input);
    refresh();
    return r;
  });
}
