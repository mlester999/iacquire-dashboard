// The sentence a customer ticks before accepting, and what a recorded answer is called. DRAFT WORDING FOR COUNSEL: it has not been reviewed by a lawyer, and the module must not
// be enabled for a real client until the owner of the terms has approved the final text (docs/roadmap/phases-3-to-7/blockers.md).
//
// Honest by construction: it says what is recorded (the decision, the time, the email address the person verified, the exact document) and says what is not (an electronic
// signature, a verification by a signing service). A typed name, a ticked box or an emailed code is never described as a legally enforceable signature.

/** Bumped whenever the wording changes; every recorded answer stores the version it was shown with, next to the text itself. */
export const PROPOSAL_ACKNOWLEDGEMENT_VERSION = 1;

export function acknowledgementText(number: string, version: number): string {
  return `I confirm I have reviewed proposal ${number} (version ${version}). Accepting records my decision, the time, and the email address I verified against this exact document. It is not an electronic signature and has not been verified by a signing service.`;
}

/** How an answer recorded by a person at the business reads wherever it is shown. */
export const recordedByLabel = (name: string): string => `Recorded by ${name}; not verified by the client.`;

export const DECISION_METHOD_LABELS = {
  verified_acknowledgement: "Accepted online with a verified email address (not an electronic signature)",
  provider_signature: "Signed through a signing service",
  recorded_by_staff: "Recorded by the business; not verified by the client",
} as const;
