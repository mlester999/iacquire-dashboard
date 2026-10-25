// Purchase intents: the commercial rules are plain data. A row freezes the price and terms it was created with, and every transition is decided here so the screen, the
// service and a test agree. The approved model is US$1,499 setup and the optional US$299/month plan; this file does not compute a price from user input.

import { MAINTENANCE_MONTHLY_USD, SETUP_FEE_USD, usdToMicros } from "@/lib/billing";

export const PURCHASE_STATUSES = ["invited", "started", "payment_verified", "provisioned", "cancelled", "expired"] as const;
export type PurchaseStatus = (typeof PURCHASE_STATUSES)[number];

export const PURCHASE_STATUS_TEXT: Record<PurchaseStatus, string> = {
  invited: "Invitation sent",
  started: "Buyer confirmed",
  payment_verified: "Payment verified",
  provisioned: "Workspace created",
  cancelled: "Cancelled",
  expired: "Link expired",
};

export const PURCHASE_STATUS_TONE: Record<PurchaseStatus, "neutral" | "primary" | "warning" | "success" | "danger"> = {
  invited: "neutral",
  started: "primary",
  payment_verified: "warning",
  provisioned: "success",
  cancelled: "danger",
  expired: "neutral",
};

export const PURCHASE_EVENT_TEXT: Record<string, string> = {
  created: "Invitation created",
  link_rotated: "A new public link was issued",
  started: "Buyer confirmed the purchase",
  payment_verified: "Payment verified by a Super Admin",
  workspace_created: "Client workspace created",
  provisioned: "Setup payment recorded and provisioning opened",
  cancelled: "Purchase cancelled",
  expired: "Link expired",
  checkout_started: "Online checkout opened",
  checkout_failed: "Online checkout could not be opened",
  checkout_expired: "An unpaid online checkout was closed",
  payment_received: "Payment confirmed by the payment provider's signed notice",
  payment_mismatch: "A payment did not match its checkout",
  payment_held: "The provider reported a refund or dispute: provisioning is on hold",
  provision_failed: "Creating the workspace did not finish",
  provision_retried: "Creating the workspace was tried again",
};

/** An online checkout, as the buyer's page and the Super Admin's page tell it. "paid" is only ever set by the provider's signed notice, never by the buyer's return to the site. */
export const CHECKOUT_STATUSES = ["creating", "pending", "paid", "failed", "cancelled", "expired", "mismatch", "refunded", "disputed"] as const;
export type CheckoutStatus = (typeof CHECKOUT_STATUSES)[number];

export const CHECKOUT_STATUS_TEXT: Record<CheckoutStatus, string> = {
  creating: "Opening checkout",
  pending: "Waiting for the payment",
  paid: "Paid",
  failed: "Could not be opened",
  cancelled: "Closed",
  expired: "Closed unpaid",
  mismatch: "Paid amount did not match",
  refunded: "Refunded",
  disputed: "Disputed",
};

/** A checkout nobody finished is closed after this long. A payment that arrives for it later is still recorded: the money is real whenever it comes. */
export const CHECKOUT_STALE_HOURS = 48;
/** A checkout row that never got a provider session (a crash between the two steps) is given up on after this long. */
export const CHECKOUT_CREATING_GRACE_MINUTES = 5;
/** The most checkouts one intent may ever open (retries after a failed or abandoned one), so a loop cannot fill the table. */
export const MAX_CHECKOUTS_PER_INTENT = 8;

export interface CheckoutGateInput {
  status: PurchaseStatus;
  expiresAt: string;
  /** The provider said a refund or dispute happened, or an amount did not match. */
  hold: "refunded" | "disputed" | "mismatch" | null;
  /** A checkout of this intent was already paid (the signed notice arrived). */
  hasPaidCheckout: boolean;
  checkoutsSoFar: number;
}

/** The buyer may open (or reopen) an online checkout only after confirming, only while the link is open, and never once a payment already counts. */
export function canStartCheckout(input: CheckoutGateInput, now: Date): PurchaseTransition {
  const status = effectiveStatus({ status: input.status, expiresAt: input.expiresAt }, now);
  if (input.hasPaidCheckout || status === "payment_verified" || status === "provisioned") return no("This purchase is already paid.");
  if (input.hold) return no("This purchase is on hold. iAcquire will contact you.");
  if (status === "invited") return no("Confirm the purchase first.");
  if (status === "expired") return no("This purchase link has expired. Ask iAcquire for a new one.");
  if (status === "cancelled") return no("This purchase was cancelled.");
  if (input.checkoutsSoFar >= MAX_CHECKOUTS_PER_INTENT) return no("Too many checkouts were opened for this purchase. Ask iAcquire to help.");
  return yes();
}

/** Why a verified payment must not turn into a workspace yet, in words a Super Admin can act on. Null when nothing holds it. */
export function provisionHoldText(hold: "refunded" | "disputed" | "mismatch" | null): string | null {
  if (hold === "refunded") return "The payment provider reported a refund for this payment. Check it with the provider, then decide whether to create the workspace.";
  if (hold === "disputed") return "The payment provider reported a dispute on this payment. Nothing is created until it is resolved.";
  if (hold === "mismatch") return "A payment arrived that did not match what was asked for. Check it with the provider before creating the workspace.";
  return null;
}

/** What the buyer reads after coming back from the provider's page: the site never says "paid" on the strength of a redirect. */
export function checkoutReturnText(status: CheckoutStatus | null, purchase: PurchaseStatus | null, leftThePaymentPage = false): { tone: "neutral" | "success" | "warning" | "danger"; title: string; body: string } {
  // A refund, dispute or mismatch comes first: the money is not simply "confirmed" while a person is looking at it.
  if (status === "refunded" || status === "disputed" || status === "mismatch") return { tone: "warning", title: "Your payment needs a person to look at it", body: "iAcquire will contact you at the email address on your purchase. Nothing more is charged." };
  if (purchase === "provisioned") return { tone: "success", title: "Your workspace is ready", body: "iAcquire sent an invitation to the email address on your purchase. Open it to set a password and start." };
  if (purchase === "payment_verified" || status === "paid") return { tone: "success", title: "Payment confirmed", body: "The payment provider confirmed your payment. iAcquire is creating your workspace now and will email your invitation." };
  if (status === "failed" || status === "cancelled" || status === "expired") return { tone: "danger", title: "The payment did not go through", body: "Nothing was charged. You can try again from your purchase link." };
  // The provider's cancel link adds a hint. It never says anything was paid or cancelled (only the provider's signed notice does that); it only stops this page waiting for a payment
  // the buyer walked away from, and tells them how to come back.
  if (leftThePaymentPage && (status === "pending" || status === "creating")) return { tone: "neutral", title: "You left the payment page", body: "If you did not finish paying, nothing was charged. Open the purchase link from your email to try again. If you did pay, this page changes once the payment provider confirms it." };
  return { tone: "neutral", title: "Waiting for the payment provider", body: "This page does not decide whether you have paid: only the payment provider's confirmation does. Refresh in a minute; if you completed the payment, iAcquire will email you." };
}

/** The whole commercial offer as one frozen row: a later price change cannot rewrite what a buyer was shown. */
export interface PriceSnapshot {
  setupFeeCents: number;
  maintenanceMonthlyCents: number;
  currency: "USD";
  maintenanceSelected: boolean;
  productVersion: string;
}

export const PRODUCT_VERSION = "launch-2026-10";
export const PURCHASE_LINK_DAYS = 14;
export const MIN_PAYMENT_NOTE_CHARS = 10;

export const priceSnapshot = (maintenanceSelected: boolean): PriceSnapshot => ({
  setupFeeCents: SETUP_FEE_USD * 100,
  maintenanceMonthlyCents: MAINTENANCE_MONTHLY_USD * 100,
  currency: "USD",
  maintenanceSelected,
  productVersion: PRODUCT_VERSION,
});

export const formatUsdCents = (cents: number): string =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(cents / 100);

/** The price the row says it froze, expressed in micro-dollars for the existing billing helpers. */
export const setupFeeMicros = (cents: number): number => usdToMicros(cents / 100);
export const maintenanceMicros = (cents: number): number => usdToMicros(cents / 100);

export interface PurchaseState {
  status: PurchaseStatus;
  expiresAt: string;
}

export interface PurchaseTransition {
  ok: boolean;
  reason?: string;
}

const no = (reason: string): PurchaseTransition => ({ ok: false, reason });
const yes = (): PurchaseTransition => ({ ok: true });

/** The status a viewer should see for the row now: an open invitation past its day is shown expired even before a job writes it. */
export function effectiveStatus(state: PurchaseState, now: Date): PurchaseStatus {
  if ((state.status === "invited" || state.status === "started") && Date.parse(state.expiresAt) <= now.getTime()) return "expired";
  return state.status;
}

/** The buyer may confirm an invitation while it is open and unexpired. Repeating a confirmation is harmless. */
export function canBuyerStart(state: PurchaseState, now: Date): PurchaseTransition {
  const status = effectiveStatus(state, now);
  if (status === "invited") return yes();
  if (status === "started") return yes();
  if (status === "expired") return no("This purchase link has expired. Ask iAcquire for a new one.");
  if (status === "cancelled") return no("This purchase was cancelled.");
  return no("This purchase has already been confirmed.");
}

/** A Super Admin may record the verified payment once the buyer confirmed, and before a workspace exists. */
export function canVerifyPayment(state: PurchaseState, now: Date): PurchaseTransition {
  const status = effectiveStatus(state, now);
  if (status === "started") return yes();
  if (status === "payment_verified") return no("The payment is already verified. Create the workspace next.");
  if (status === "provisioned") return no("This purchase already has a client workspace.");
  if (status === "expired") return no("The link expired before the buyer confirmed. Send a new link.");
  if (status === "cancelled") return no("This purchase was cancelled.");
  return no("The buyer has not confirmed the purchase yet.");
}

/** Provisioning requires verified payment evidence and no workspace yet. Repeating it returns the existing workspace instead. */
export function canProvision(state: PurchaseState, clientOrgId: string | null, now: Date, hold: "refunded" | "disputed" | "mismatch" | null = null): PurchaseTransition {
  const status = effectiveStatus(state, now);
  if (clientOrgId || status === "provisioned") return yes();
  if (status === "payment_verified") return hold ? no(provisionHoldText(hold) as string) : yes();
  if (status === "started") return no("Record the verified payment before creating the workspace.");
  if (status === "expired") return no("The link expired before the purchase was completed.");
  if (status === "cancelled") return no("This purchase was cancelled.");
  return no("The buyer has not confirmed the purchase yet.");
}

/** The buyer has not paid, so an invitation can be withdrawn; a verified payment needs the refund path, not a cancel. */
export function canCancel(state: PurchaseState, now: Date): PurchaseTransition {
  const status = effectiveStatus(state, now);
  if (status === "invited" || status === "started") return yes();
  if (status === "payment_verified") return no("The payment is verified. Record a refund if the purchase must be stopped.");
  if (status === "provisioned") return no("A workspace already exists. Use the client offboarding path.");
  return no("There is nothing open to cancel.");
}

/** A fresh link can be issued while the purchase is still open (a lost email, an expired link that has not been used). */
export function canRotateLink(state: PurchaseState, now: Date): PurchaseTransition {
  const status = effectiveStatus(state, now);
  if (status === "invited" || status === "started" || status === "expired") return yes();
  if (status === "payment_verified") return no("The payment is verified; the purchase link is no longer needed.");
  if (status === "provisioned") return no("The workspace already exists.");
  return no("A cancelled purchase cannot be reopened with a new link.");
}
