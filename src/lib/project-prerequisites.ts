// What a person confirms before a custom project's work starts (or before it is handed over): the written agreement, a deposit, access, content. Pure rules shared by the
// server and the screens.
//
// A prerequisite is a record of a human check. Nothing here detects a payment or a signature, and nothing charges anyone: staff write down what they checked and where,
// or waive the item with a reason. Both are audited, and both are kept.

import { freeTextProblem } from "@/lib/invoices/guards";

export const PREREQUISITE_KINDS = ["agreement", "deposit", "access", "content", "change", "other"] as const;
export type PrerequisiteKind = (typeof PREREQUISITE_KINDS)[number];
export const PREREQUISITE_BLOCKS = ["start", "handover"] as const;
export type PrerequisiteBlocks = (typeof PREREQUISITE_BLOCKS)[number];
export const PREREQUISITE_STATUSES = ["pending", "satisfied", "waived"] as const;
export type PrerequisiteStatus = (typeof PREREQUISITE_STATUSES)[number];

export const PREREQUISITE_KIND_LABEL: Record<PrerequisiteKind, string> = {
  agreement: "Written agreement",
  deposit: "Payment",
  access: "Access",
  content: "Content",
  change: "Change",
  other: "Other",
};

export const PREREQUISITE_STATUS_LABEL: Record<PrerequisiteStatus, string> = { pending: "Waiting", satisfied: "Confirmed", waived: "Not needed" };

export const AGREEMENT_LABEL = "Written agreement confirmed";
export const PAYMENT_LABEL = "Payment confirmed as the quote's payment terms describe";

/** The two items asked for when a quote is accepted (only where the Super Admin switched prerequisites on): the agreement, and the payment when the quote has payment terms. */
export function defaultPrerequisites(paymentTerms: string): Array<{ kind: "agreement" | "deposit"; label: string; blocks: "start"; required: true }> {
  const items: Array<{ kind: "agreement" | "deposit"; label: string; blocks: "start"; required: true }> = [{ kind: "agreement", label: AGREEMENT_LABEL, blocks: "start", required: true }];
  if (paymentTerms.trim()) items.push({ kind: "deposit", label: PAYMENT_LABEL, blocks: "start", required: true });
  return items;
}

export interface PrerequisiteFact {
  id: string;
  kind: PrerequisiteKind;
  label: string;
  required: boolean;
  blocks: PrerequisiteBlocks;
  status: PrerequisiteStatus;
  /** For a change prerequisite: the status of the change it belongs to. It binds only once that change was accepted. */
  changeStatus?: string | null;
}

/** What is still in the way of a phase: required, waiting, for that phase, and (for a change) the change was accepted. */
export function blockers(items: readonly PrerequisiteFact[], phase: PrerequisiteBlocks): PrerequisiteFact[] {
  return items.filter((p) => p.required && p.status === "pending" && p.blocks === phase && (p.kind !== "change" || p.changeStatus === "accepted" || p.changeStatus === "applied"));
}

export function blockedMessage(phase: PrerequisiteBlocks, waiting: readonly PrerequisiteFact[]): string | null {
  if (!waiting.length) return null;
  const names = waiting.map((p) => `"${p.label}"`).join(", ");
  const what = phase === "start" ? "Work can't start yet" : "The project can't be handed over yet";
  return `${what}: ${waiting.length === 1 ? "one thing is" : `${waiting.length} things are`} still waiting to be confirmed or waived with a reason (${names}).`;
}

/** What a client reads on "Before we start". It names no evidence, no person and no payment detail. */
export function clientPrerequisiteSentence(p: Pick<PrerequisiteFact, "status" | "blocks">): string {
  if (p.status === "satisfied") return "Confirmed by the iAcquire team.";
  if (p.status === "waived") return "The team decided this is not needed.";
  return p.blocks === "start" ? "Waiting. Work starts once this is confirmed." : "Waiting. The project is handed over once this is confirmed.";
}

/** The evidence a person writes down: what they checked and where. 3 to 1,000 characters, and never a card number or a key. */
export function evidenceProblem(note: string | null | undefined): string | null {
  const text = (note ?? "").trim();
  if (text.length < 3) return "Write what you checked and where (at least a few words).";
  if (text.length > 1000) return "The note can be up to 1,000 characters.";
  return freeTextProblem("The note", text);
}

/** Why an item was waived: 5 to 1,000 characters. */
export function waiverProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? "").trim();
  if (text.length < 5) return "Say why this is not needed (at least a few words).";
  if (text.length > 1000) return "The reason can be up to 1,000 characters.";
  return freeTextProblem("The reason", text);
}
