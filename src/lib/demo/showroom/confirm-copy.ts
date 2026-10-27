// The words of the two confirmation dialogs, in one place so a test can hold every sentence to the same rules: no payment, subscription, workspace or booking is promised or implied,
// and the two prices are the ones passed in (src/lib/billing.ts), never typed here. Pure.

export type ConfirmKind = "consultation" | "buy";
export const isConfirmKind = (v: unknown): v is ConfirmKind => v === "consultation" || v === "buy";

export const CONSULT_CONFIRM = {
  title: "Let's talk about your business.",
  description: (business: string | null) => (business ? `A free conversation with the iAcquire team about ${business}.` : "A free conversation with the iAcquire team about your business."),
  purposeHeading: "What the consultation is for",
  purpose: [
    "To understand what you want your AI team and CRM to do, and how you work today",
    "To see whether the core implementation fits, and what it would involve",
    "To answer your questions about pricing, Managed Maintenance and what is not included",
  ],
  free: "The consultation is free. Confirming does not charge you, start a subscription or create an account.",
  nextHeading: "What happens next",
  next: (hasLink: boolean) => [
    "We record that you would like to talk and tell the iAcquire team.",
    hasLink
      ? "You will be offered a link to choose a meeting time. Confirming your interest does not itself reserve a meeting."
      : "A member of the team will follow up with you. A scheduling page is not set up yet, so no time is offered here.",
  ],
  cancel: "Not now",
  confirm: "Confirm my request",
  sending: "Sending your request",
  successTitle: "Request received",
  success: (hasLink: boolean) =>
    hasLink
      ? "The team has your request. Your meeting is not booked until you choose a time on the scheduling page."
      : "The team has your request and will follow up with you. No appointment has been booked.",
  schedule: "Choose a meeting time",
  close: "Close",
} as const;

export const BUY_CONFIRM = {
  title: "Start your implementation",
  description: "Tell the iAcquire team you are ready. This only informs the team: it is not a purchase.",
  summaryHeading: "What this would involve",
  implementationLabel: "One-time implementation",
  implementationNote: "Starting price, paid once. The exact scope and price are confirmed in writing before any work starts.",
  maintenanceLabel: "Optional Managed Maintenance",
  maintenanceNote: "A recurring monthly plan you can choose later. It is never required to use your core system, and adds monitoring, troubleshooting and Automation Studio.",
  usageLabel: "Usage and provider costs",
  usageNote: "Separate from both prices: for example AI model calls, messaging and third-party subscriptions. They are shown in your portal and billed by those providers.",
  oneTimeVsMonthly: "The implementation is a one-time charge. Managed Maintenance, if you add it, is a separate monthly charge.",
  nextHeading: "What happens after you confirm",
  next: [
    "We record that you are ready and tell the iAcquire team.",
    "The team contacts you to agree the scope and price in writing.",
    "Nothing is charged, no subscription starts and no workspace is created by confirming. Online checkout is not open yet.",
  ],
  cancel: "Not yet",
  confirm: "Confirm my interest",
  sending: "Sending your interest",
  successTitle: "The team knows you are ready",
  success: "The iAcquire team has your interest and will contact you. Nothing was charged, no subscription started and no workspace was created.",
  close: "Close",
} as const;
