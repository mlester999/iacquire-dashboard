"use server";

import { revalidatePath } from "next/cache";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { activateMaintenance, resolveMaintenanceSubscription, updateMaintenanceRequest } from "@/server/maintenance/service";
import { expireSubscription, recordPaymentFailed, recordVerifiedPayment } from "@/server/automation-studio/lifecycle";
import { cancelAgreementAsAgency, releaseAgreementHold, setRecurringBillingEnabled } from "@/server/maintenance/agreement-service";

const refresh = () => {
  revalidatePath("/admin/maintenance");
  revalidatePath("/maintenance");
};

export async function activateMaintenanceAction(id: string, billingStartOn: string | undefined, paidThroughOn: string, paymentConfirmed: boolean) {
  return guard(async () => {
    // The person confirms they checked the payment in their own billing records: a payment is never inferred, and a plan never starts without one.
    if (paymentConfirmed !== true) throw new AppError("invalid_input", "Confirm that you verified the payment in your billing records first.");
    await activateMaintenance(await requireAgencyOrThrow(), id, { billingStartOn, payment: { verified: true, paidThroughOn } });
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

// Automation Studio plan lifecycle. Each is an agency member recording what they know; nothing here charges, detects or assumes a payment.
export async function recordPaymentFailedAction(id: string, graceDays?: number) {
  return guard(async () => {
    const out = await recordPaymentFailed(await requireAgencyOrThrow(), id, graceDays === undefined ? {} : { graceDays });
    refresh();
    return out;
  });
}
export async function recordVerifiedPaymentAction(id: string, paidThroughOn: string, confirmed: boolean) {
  return guard(async () => {
    // The person confirms they checked the payment in their own billing records: a payment is never inferred.
    if (confirmed !== true) throw new AppError("invalid_input", "Confirm that you verified this payment in your billing records first.");
    const out = await recordVerifiedPayment(await requireAgencyOrThrow(), id, { paidThroughOn });
    refresh();
    return out;
  });
}
export async function expireSubscriptionAction(id: string) {
  return guard(async () => {
    const out = await expireSubscription(await requireAgencyOrThrow(), id);
    refresh();
    return out;
  });
}

// The optional automatic monthly payment (a PayPal subscription). The team can stop a client's, release the hold a refund or a dispute put on it (saying why), and a Super Admin opens or
// closes the whole feature. None of these records a payment or extends a plan by itself: a hold's release applies charges PayPal already confirmed, through the usual transition.
export async function releaseAgreementHoldAction(agreementId: string, note: string) {
  return guard(async () => {
    const out = await releaseAgreementHold(await requireAgencyOrThrow(), agreementId, note);
    refresh();
    return out;
  });
}
export async function stopAgreementAction(agreementId: string) {
  return guard(async () => {
    await cancelAgreementAsAgency(await requireAgencyOrThrow(), agreementId);
    refresh();
  });
}
export async function setRecurringBillingAction(enabled: boolean) {
  return guard(async () => {
    const out = await setRecurringBillingEnabled(await requireAgencyOrThrow(), enabled === true);
    refresh();
    return out;
  });
}
