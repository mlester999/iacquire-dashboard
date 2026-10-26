"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { guard } from "@/server/action-guard";
import { AppError } from "@/server/errors";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import {
  cancelPurchaseIntent, createPurchaseIntent, provisionPurchaseIntent, releasePurchaseHold, rotatePurchaseLink, setPurchaseCheckoutEnabled, startPurchase, verifyPurchasePayment,
  createPurchaseIntentSchema, purchasePaymentSchema,
} from "@/server/purchase-intents/service";
import { completePaypalPurchaseReturn, startPurchaseCheckout } from "@/server/purchase-intents/checkout";

// Server actions for purchase intents. The admin ones start from a signed-in agency account and the service re-reads the permission from the database. The public one is
// the buyer confirming a link: it takes only the token, is rate-limited by address, and creates no account and no payment. A token never appears in a log or an audit row.

const uuid = z.string({ error: "That purchase was not found." }).uuid({ error: "That purchase was not found." });
const token = z.string({ error: "That link is not valid." }).regex(/^[A-Za-z0-9_-]{43}$/, { error: "That link is not valid." });

type AgencySession = Awaited<ReturnType<typeof requireAgencyOrThrow>>;

async function act<T>(fn: (session: AgencySession) => Promise<T>) {
  return guard(async () => fn(await requireAgencyOrThrow()));
}

async function clientIp(): Promise<string | null> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || null;
}

const publicPath = (raw: string) => `/purchase/${raw}`;

export async function createPurchaseIntentAction(input: z.input<typeof createPurchaseIntentSchema>) {
  return act(async (session) => {
    const created = await createPurchaseIntent(session, createPurchaseIntentSchema.parse(input));
    // Do not revalidate this route here: the one visible copy of the public link lives in the form's answer, and a server-action refresh would replace that panel.
    // The list is fetched again on the next navigation or reload.
    return { id: created.id, reference: created.reference, path: publicPath(created.token), expiresAt: created.expiresAt };
  });
}

export async function verifyPurchasePaymentAction(input: { id: string } & z.input<typeof purchasePaymentSchema>) {
  return act(async (session) => {
    const { id, ...payment } = input;
    const view = await verifyPurchasePayment(session, uuid.parse(id), purchasePaymentSchema.parse(payment));
    revalidatePath("/admin/purchase-intents");
    revalidatePath(`/admin/purchase-intents/${view.id}`);
    return view;
  });
}

export async function provisionPurchaseIntentAction(id: string) {
  return act(async (session) => {
    const result = await provisionPurchaseIntent(session, uuid.parse(id));
    revalidatePath("/admin/purchase-intents");
    revalidatePath(`/admin/purchase-intents/${result.intent.id}`);
    revalidatePath("/admin/clients");
    return result;
  });
}

export async function rotatePurchaseLinkAction(id: string) {
  return act(async (session) => {
    const rotated = await rotatePurchaseLink(session, uuid.parse(id));
    revalidatePath(`/admin/purchase-intents/${id}`);
    return { path: publicPath(rotated.token), expiresAt: rotated.expiresAt };
  });
}

export async function cancelPurchaseIntentAction(input: { id: string; reason: string }) {
  return act(async (session) => {
    const view = await cancelPurchaseIntent(session, uuid.parse(input.id), input.reason);
    revalidatePath("/admin/purchase-intents");
    revalidatePath(`/admin/purchase-intents/${view.id}`);
    return view;
  });
}

/** A Super Admin who checked with the provider releases the hold a refund, dispute or mismatch report put on a purchase. The note says what they checked. */
export async function releasePurchaseHoldAction(input: { id: string; note: string }) {
  return act(async (session) => {
    const view = await releasePurchaseHold(session, uuid.parse(input.id), z.string({ error: "Say what you checked with the payment provider." }).parse(input.note));
    revalidatePath("/admin/purchase-intents");
    revalidatePath(`/admin/purchase-intents/${view.id}`);
    revalidatePath("/admin/clients");
    return view;
  });
}

/** The buyer's one public write: confirms the invitation. A token-shaped value only; a malformed or unknown one is refused before any lookup writes. */
export async function startPurchaseAction(rawToken: string) {
  return guard(async () => {
    const value = token.parse(rawToken);
    const ip = await clientIp();
    const result = await consumeRateLimit(RATE_LIMITS.purchaseIntentStartByIp, ip ?? "unknown");
    if (!result.allowed) throw new AppError("rate_limited", "Too many attempts. Wait a moment and try again.", { retryAfterSeconds: result.retryAfterSeconds });
    const view = await startPurchase(value);
    // Refresh the public page after the buyer's confirmation so its status and next step are not the pre-confirmation render.
    revalidatePath(`/purchase/${value}`, "page");
    return view;
  });
}

/**
 * The buyer presses Pay: opens (or resumes) the one hosted checkout for the frozen fee and hands back the provider's page. Only the token is taken from the browser: the amount, the
 * currency and the buyer are all the purchase's own. Nothing is charged here.
 */
export async function startPurchaseCheckoutAction(rawToken: string, rawProvider?: string) {
  return guard(async () => {
    const value = token.parse(rawToken);
    const provider = z.enum(["paymongo", "paypal"]).default("paymongo").parse(rawProvider ?? "paymongo");
    const started = await startPurchaseCheckout(value, { ip: await clientIp(), provider });
    revalidatePath(`/purchase/${value}`, "page");
    return { checkoutUrl: started.checkoutUrl, reference: started.reference, resumed: started.resumed };
  });
}

/**
 * The buyer is back from PayPal's page: this server takes the payment the buyer approved and records what PayPal itself reports. Only the checkout's reference is taken from the
 * browser (it names a row of ours; the PayPal order id is the one we stored), and it answers with a state, never with a claim that a payment was received.
 */
export async function completePaypalReturnAction(rawReference: string) {
  return guard(async () => {
    const reference = z.string().regex(/^IAQ-[A-Z0-9]{8,40}$/, { error: "That payment reference is not valid." }).parse(rawReference);
    return completePaypalPurchaseReturn(reference, { ip: await clientIp() });
  });
}

/** A Super Admin opens or closes online checkout for purchases (the billing settings carry the switch; it is off until someone turns it on). */
export async function setPurchaseCheckoutEnabledAction(enabled: boolean) {
  return act(async (session) => {
    const view = await setPurchaseCheckoutEnabled(session, z.boolean().parse(enabled));
    revalidatePath("/admin/purchase-intents");
    return view;
  });
}
