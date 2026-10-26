// The "Setup payment" line at the top of a client's Setup Center. It is driven by the one yes or no the database gives a member of the workspace (app.setup_payment_cleared:
// the status behind it, and any waiver reason, stay with billing.view), so it can say "confirmed" or "waiting" and nothing finer. It never says a payment was detected, and
// it says nothing at all when the question could not be answered. Pure: the screen renders what this returns.
import { PAYMENT_REQUIRED_SENTENCE } from "@/lib/billing-clearance";

export interface SetupPaymentLine {
  state: "confirmed" | "waiting";
  title: string;
  detail: string;
}

export const SETUP_PAYMENT_CONFIRMED: SetupPaymentLine = {
  state: "confirmed",
  title: "Setup payment confirmed",
  detail: "iAcquire has confirmed your setup payment, so your AI team can be set up.",
};

export const SETUP_PAYMENT_WAITING: SetupPaymentLine = {
  state: "waiting",
  title: "Setup payment not confirmed yet",
  detail: `${PAYMENT_REQUIRED_SENTENCE}. iAcquire records the payment when it is received. If you have already paid, message the team from the help button.`,
};

/** `cleared` is the database's answer; null or undefined means it was not asked or could not be read, and then nothing is claimed. */
export function setupPaymentLine(cleared: boolean | null | undefined): SetupPaymentLine | null {
  if (cleared === true) return SETUP_PAYMENT_CONFIRMED;
  if (cleared === false) return SETUP_PAYMENT_WAITING;
  return null;
}
