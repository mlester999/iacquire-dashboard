"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { actionError } from "@/server/errors";
import { addFinanceEntry, saveFinanceSettings, voidFinanceEntry } from "@/server/billing/finance";
import { addProviderFee, adjustOrgCredits, confirmLivePaymentsReview, publishUnitRate, setExchangeRate } from "@/server/billing/service";

const uuid = z.string().uuid();

async function run<T>(fn: (user: Awaited<ReturnType<typeof requireAgencyOrThrow>>) => Promise<T>) {
  try {
    const user = await requireAgencyOrThrow();
    const data = await fn(user);
    revalidatePath("/admin/billing");
    return { ok: true as const, data };
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false as const, error: err.issues[0]?.message ?? "Check the form.", code: "invalid_input" as const };
    return actionError(err);
  }
}

// Every service call below re-checks that the caller is a super admin (or, for staff-visible reads, assigned to the client).
export const addFinanceEntryAction = async (input: Parameters<typeof addFinanceEntry>[1]) => run((u) => addFinanceEntry(u, input));
export const voidFinanceEntryAction = async (id: string, reason: string) => run((u) => voidFinanceEntry(u, uuid.parse(id), reason));
export const saveFinanceSettingsAction = async (input: Parameters<typeof saveFinanceSettings>[1]) => run((u) => saveFinanceSettings(u, input));
export const setExchangeRateAction = async (usdPhpRate: number, source: string) => run((u) => setExchangeRate(u, { usdPhpRate, source }));
export const confirmLiveReviewAction = async (confirmed: boolean) => run((u) => confirmLivePaymentsReview(u, confirmed));
/** The price is typed in dollars per unit for readability and stored exactly in micro-dollars. */
export const publishUnitRateAction = async (provider: string, unitType: string, wholesaleUsdPerUnit: number, note?: string) =>
  run((u) => publishUnitRate(u, { provider, unitType, wholesaleMicrosPerUnit: Math.round(wholesaleUsdPerUnit * 1_000_000), note }));
export const adjustCreditsAction = async (orgId: string, deltaUsd: number, reason: string) => run((u) => adjustOrgCredits(u, { orgId: uuid.parse(orgId), deltaUsd, reason }));
export const addProviderFeeAction = async (input: { orgId: string; provider: string; kind: "number_rental" | "sender_registration" | "whatsapp_connection" | "domain" | "other"; description: string; amountUsd: number; recurrence: "one_time" | "monthly" | "annual" }) =>
  run((u) => addProviderFee(u, { ...input, orgId: uuid.parse(input.orgId) }));
