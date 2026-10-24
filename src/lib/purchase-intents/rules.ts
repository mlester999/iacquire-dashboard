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
};

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
export function canProvision(state: PurchaseState, clientOrgId: string | null, now: Date): PurchaseTransition {
  const status = effectiveStatus(state, now);
  if (clientOrgId || status === "provisioned") return yes();
  if (status === "payment_verified") return yes();
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
