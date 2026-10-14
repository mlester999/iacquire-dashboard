"use server";

import { revalidatePath } from "next/cache";
import { actionError, AppError } from "@/server/errors";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { approveProviderFee, startTopUp, updateBillingSettings } from "@/server/billing/service";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns the PayMongo page to send the person to. Nothing is charged until they pay there. */
export async function startTopUpAction(amountUsd: number) {
  try {
    const ctx = await requireOrgContextOrThrow("credits.topup");
    const limit = await consumeRateLimit(RATE_LIMITS.topupByOrg, ctx.org.orgId);
    if (!limit.allowed) throw new AppError("rate_limited", "Too many checkout attempts. Please wait a little and try again.", { retryAfterSeconds: limit.retryAfterSeconds });
    const out = await startTopUp(ctx, Number(amountUsd));
    return { ok: true as const, data: { checkoutUrl: out.checkoutUrl, referenceNumber: out.referenceNumber } };
  } catch (err) {
    return actionError(err);
  }
}

export async function updateBillingSettingsAction(input: { monthlyBudgetUsd: number | null; warnAtPercent: number; lowBalanceUsd: number; hardStop: boolean }) {
  try {
    const ctx = await requireOrgContextOrThrow("billing.configure");
    await updateBillingSettings(ctx, {
      monthlyBudgetUsd: input.monthlyBudgetUsd === null ? null : Number(input.monthlyBudgetUsd),
      warnAtPercent: Number(input.warnAtPercent),
      lowBalanceUsd: Number(input.lowBalanceUsd),
      hardStop: input.hardStop === true,
    });
    revalidatePath("/settings/billing");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}

export async function approveProviderFeeAction(feeId: string) {
  try {
    if (!uuid.test(feeId)) throw new AppError("invalid_input", "Choose a fee.");
    const ctx = await requireOrgContextOrThrow();
    await approveProviderFee(ctx, feeId);
    revalidatePath("/settings/billing");
    return { ok: true as const };
  } catch (err) {
    return actionError(err);
  }
}
