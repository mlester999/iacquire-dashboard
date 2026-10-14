"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAgencyOrgAccessOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { quoteDomainPurchase, recordDomainPurchase } from "@/server/websites/domains";

const uuid = z.string().uuid();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date like 2027-10-14.");

/** Agency staff act on a client's domain only if they are assigned to that client; the service writes the audit entry. */
async function run<T>(orgId: string, fn: (adminId: string) => Promise<T>) {
  try {
    if (!uuid.safeParse(orgId).success) return { ok: false as const, error: "Client not found.", code: "not_found" as const };
    const admin = await requireAgencyOrgAccessOrThrow(orgId);
    const data = await fn(admin.id);
    revalidatePath(`/admin/clients/${orgId}/website`);
    return { ok: true as const, data };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    return actionError(err);
  }
}

/** Records the first-year price found for a domain the client asked for. The client sees it and decides; nothing is bought. */
export const quoteDomainAction = async (orgId: string, domainId: string, costUsd: number, renewsAt: string) =>
  run(orgId, async (adminId) => {
    await quoteDomainPurchase(adminId, { orgId, domainId: uuid.parse(domainId), costUsd: z.number().parse(costUsd), renewsAt: renewsAt ? date.parse(renewsAt) : undefined });
    return {};
  });

/** After registering the domain in the client's own name (and only after they approved it), record where it is held and when it renews. */
export const recordDomainPurchasedAction = async (orgId: string, domainId: string, registrar: string, renewsAt: string) =>
  run(orgId, async (adminId) => {
    await recordDomainPurchase(adminId, { orgId, domainId: uuid.parse(domainId), registrar: z.string().max(80).parse(registrar), renewsAt: date.parse(renewsAt) });
    return {};
  });
