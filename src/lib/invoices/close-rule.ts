// What happens to the deal linked to an invoice when the invoice is paid. Pure; src/server/invoices/close-rules.ts reads the facts and acts on the answer.
//
// The rule is the owner's setting, default "none". Money arriving never silently changes a deal: a partial payment, a deposit or a refund never does anything to
// it; "task" asks the deal's owner a question; "won" happens only for an invoice a person marked, paid in full by a payment the provider confirmed (or one recorded by
// hand, when the owner counts those), with the deal still open and no dispute.

export const CLOSE_RULES = ["none", "task", "auto_won"] as const;
export type CloseRule = (typeof CLOSE_RULES)[number];

export const CLOSE_RULE_LABELS: Record<CloseRule, string> = {
  none: "Do nothing to the deal",
  task: "Ask the deal's owner whether to mark it won",
  auto_won: "Mark the deal won when an invoice I marked is paid in full",
};

export interface CloseRuleFacts {
  rule: CloseRule;
  /** A person marked this invoice as the one that closes its deal. */
  closesDeal: boolean;
  invoiceStatus: "draft" | "pending_approval" | "issued" | "void";
  paymentStatus: "unpaid" | "partially_paid" | "paid" | "disputed" | "credited";
  hasDispute: boolean;
  /** The linked deal's state, or null when the invoice has no deal. */
  dealStatus: "open" | "won" | "lost" | null;
  /** Every payment that counts toward the invoice was confirmed by the provider. */
  allProviderConfirmed: boolean;
  /** The owner counts payments recorded by hand as verified. */
  countManualAsVerified: boolean;
  /** This rule already acted on this invoice. */
  alreadyApplied: boolean;
  /** Some payment that counts toward the invoice moved no real money (a payment provider's test mode). A test never changes a deal, however it is paid. */
  hasTestPayment?: boolean;
  /** The invoice is a test invoice: nothing was owed and no money moved, so it never acts on a deal. */
  isTest?: boolean;
}

export type CloseRuleDecision = { action: "none"; reason: "rule_none" | "no_deal" | "deal_not_open" | "not_fully_paid" | "dispute" | "already_applied" | "not_marked" | "test_payment" | "test_invoice" } | { action: "task" } | { action: "won" };

export function decideCloseRule(f: CloseRuleFacts): CloseRuleDecision {
  if (f.alreadyApplied) return { action: "none", reason: "already_applied" };
  if (f.isTest) return { action: "none", reason: "test_invoice" };
  if (f.rule === "none") return { action: "none", reason: "rule_none" };
  if (f.dealStatus === null) return { action: "none", reason: "no_deal" };
  if (f.dealStatus !== "open") return { action: "none", reason: "deal_not_open" };
  if (f.invoiceStatus !== "issued") return { action: "none", reason: "not_fully_paid" };
  if (f.paymentStatus === "disputed" || f.hasDispute) return { action: "none", reason: "dispute" };
  if (f.paymentStatus !== "paid") return { action: "none", reason: "not_fully_paid" };
  if (f.hasTestPayment) return { action: "none", reason: "test_payment" };
  if (f.rule === "task") return { action: "task" };
  if (!f.closesDeal) return { action: "none", reason: "not_marked" };
  // Marked, but paid by hand and the owner does not count that as verified: a person decides.
  if (!f.allProviderConfirmed && !f.countManualAsVerified) return { action: "task" };
  return { action: "won" };
}
