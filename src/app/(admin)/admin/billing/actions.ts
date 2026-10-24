"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { guard } from "@/server/action-guard";
import { recordManualPayment, recordRefundAction, waiveSetupFee } from "@/server/billing/manual";
import { setAutoPastDue } from "@/server/billing/service";

// Super Admin only. Each call below re-checks billing.agency_manage in the database against the client named, validates every field again on the server, and writes an
// audit entry. Nothing here contacts a payment provider: a payment recorded here is money a person saw arrive, and the screens say exactly that.

const uuid = z.string().uuid();
const text = (max: number) => z.string().max(max);
const paymentSchema = z.object({
  kind: text(30),
  amount: text(40),
  method: text(30),
  externalReference: text(500),
  paidOn: text(12),
  note: text(2000),
  paidThroughOn: text(12).optional().nullable(),
  billingStartOn: text(12).optional().nullable(),
});

function refresh(orgId?: string) {
  revalidatePath("/admin/billing");
  if (orgId) revalidatePath(`/admin/clients/${orgId}`);
}

/** Records money a Super Admin saw arrive outside a provider. The same bank reference never records twice. */
export async function recordManualPaymentAction(orgId: string, input: z.input<typeof paymentSchema>) {
  return guard(async () => {
    const admin = await requireAgencyOrThrow("super_admin");
    const id = uuid.parse(orgId);
    const out = await recordManualPayment(admin, id, paymentSchema.parse(input));
    refresh(id);
    return out;
  });
}

/** Waives the setup fee with a reason a person states. */
export async function waiveSetupFeeAction(orgId: string, reason: string) {
  return guard(async () => {
    const admin = await requireAgencyOrThrow("super_admin");
    const id = uuid.parse(orgId);
    const out = await waiveSetupFee(admin, id, { reason: text(2000).parse(reason) });
    refresh(id);
    return out;
  });
}

/** Switches the renewal sweep's automatic past-due step on or off (off by default). A Super Admin only; audited. */
export async function setAutoPastDueAction(enabled: boolean) {
  return guard(async () => {
    const admin = await requireAgencyOrThrow("super_admin");
    const on = z.boolean().parse(enabled);
    await setAutoPastDue(admin, on);
    refresh();
    return { enabled: on };
  });
}

/** Records a refund made with the provider or by hand, and tells the client's owners. */
export async function recordRefundForPaymentAction(paymentId: string, amount: string, reason: string) {
  return guard(async () => {
    const admin = await requireAgencyOrThrow("super_admin");
    const out = await recordRefundAction(admin, uuid.parse(paymentId), { amount: text(40).parse(amount), reason: text(2000).parse(reason) });
    refresh();
    revalidatePath("/admin/clients/[id]", "page");
    return out;
  });
}
