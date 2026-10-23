// What a signing request's history says, in words. Pure. A line is written for a person who has to decide what to do next, so it states who said what and never turns the signing
// service's word into iAcquire's: "the signing service reports that Maria signed" is a statement about the service, not about the world.

export type EventSourceName = "user" | "system" | "provider_webhook" | "provider_poll";

export const SOURCE_LABELS: Record<EventSourceName, string> = {
  user: "A person",
  system: "iAcquire",
  provider_webhook: "The signing service",
  provider_poll: "The signing service (read by iAcquire)",
};

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 200) : null);

/** One sentence for one line of a request's history. An unknown kind is shown as its own name, never hidden and never guessed at. */
export function eventSentence(kind: string, d: Record<string, unknown> = {}): string {
  switch (kind) {
    case "created": return "Asked for a signature.";
    case "sent": return "The signing service reports that the signer has been asked to sign.";
    case "viewed": return "The signing service reports that the signer opened the document.";
    case "completed": return "The signing service reports that the document was signed.";
    case "declined": return "The signing service reports that the signer declined.";
    case "expired": return "The signing service reports that the request ran out before it was signed.";
    case "voided": return str(d.reason) ? `Ended: ${str(d.reason)}` : "Withdrawn.";
    case "superseded": return str(d.reason) ? `Ended: ${str(d.reason)}` : "Replaced by a newer version of the proposal.";
    case "failed": return str(d.message) ? `Could not be sent: ${str(d.message)}` : "Could not be sent.";
    case "retry_scheduled": return "The signing service had a problem; it will be tried again.";
    case "outcome_unknown": return "The answer from the signing service was lost, so it is being checked and will not be sent again until that is known.";
    case "worker_lost_while_sending": return "The process handing this over stopped part-way; the result is being checked.";
    case "worker_lost_resumed": return "The process handing this over stopped before anything was sent; it was started again.";
    case "reconciled_found": return "Checked with the signing service: the document was already there.";
    case "reconciled_resumed": return "Checked with the signing service: the document was there but not sent, so sending continued.";
    case "reconciled_not_found": return "Checked with the signing service: it has no such document, so nothing reached the signer.";
    case "signature_applied": return "The signature was applied to the proposal, which is now accepted.";
    case "signature_not_applied": return `The signature was kept but not applied to the proposal${str(d.reason) ? ` (${str(d.reason)?.replace(/_/g, " ")})` : ""}.`;
    case "copy_stored": return d.certificate === true ? "The signed copy and its certificate were stored." : "The signed copy was stored.";
    case "copy_failed": return "The signed copy could not be fetched yet; it will be tried again.";
    case "copy_gave_up": return "The signed copy could not be fetched. Download it from the signing service.";
    case "cancel_done": return "The signing service was told to withdraw the document.";
    case "cancel_failed": return "The signing service could not be told to withdraw the document; it will be tried again.";
    case "cancel_manual": return "iAcquire could not withdraw the document at the signing service. Withdraw it there.";
    case "delivery_noted": return "The signing service sent a notice that says nothing about the signature.";
    case "delivery_ignored": return "A notice from the signing service changed nothing (it was old or out of order).";
    case "effect_failed": return "A follow-up (a notice or a timeline entry) could not be made. The signature itself was recorded.";
    case "document_left_behind": return "The request was withdrawn while the signing service was being asked, so a document may exist there. Withdraw it there.";
    default: return kind.replace(/_/g, " ");
  }
}

/** The connection's status as a short label. */
export const CONNECTION_STATUS_LABELS: Record<string, string> = {
  connected: "Connected",
  needs_attention: "Needs attention",
  error: "Problem",
  revoked: "Revoked",
  disconnected: "Disconnected",
};
