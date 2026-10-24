// Pure rules about phone numbers and email addresses that only a website visitor typed. No I/O here, so every case is easy to test.
//
// A visitor can type anyone's number or address into the chat's details form. Until the address itself proves it is theirs (a message arrives from it, or a person
// of the business confirms it), it must not be reachable by anything the business did not decide one message at a time: not a workflow, a campaign, a reminder, a
// retention program, a follow-up or an AI employee on its own. A person writing one reply to a visitor who is in the chat is still fine.

/** The reason evaluateSend records when it refuses such a message. */
export const IDENTITY_UNVERIFIED = "identity_unverified" as const;

export const IDENTITY_UNVERIFIED_DETAIL = "The visitor typed this number or address and it has not been confirmed.";

/** The consent source the website chat's details form records. A grant with this source was ticked by whoever typed the details. */
export const TYPED_CONSENT_SOURCE = "website_chat_form";

/** The wording stored with a consent event the details form records. It says plainly that the details were typed and not checked. */
export function typedConsentEvidence(notice: string, host: string): string {
  return `Typed by the visitor in the website chat, unverified. ${notice} Website chat form on ${host}.`;
}

/**
 * What is known about the address a message would go to, read from the address itself (contact_identities) and not from the contact it sits on: a merge moves the address
 * to another contact, and it must stay typed. `verified` is null when no identity row was found.
 */
export interface DestinationFacts {
  typedByVisitor: boolean;
  verified: boolean | null;
}

export interface SendFacts {
  actor: "ai" | "human" | "system";
  /** An AI employee's message that a person approved by name (the same exception the AI gate makes for a paused conversation). */
  approvedByPerson: boolean;
  /** The send scope (reply, human, followup, reminder, retention, and any scope added later). Only a reply or a person's own message is one-to-one. */
  scope: string;
  purpose: "service" | "marketing";
}

/** The address came only from a website visitor's typing and nothing has confirmed it since. */
export const typedByVisitorOnly = (dest: DestinationFacts): boolean => dest.typedByVisitor && dest.verified === false;

/** Added to the evidence of a typed consent grant that a merge carries to the kept contact. The grant keeps its source and its words; this only says it was carried. */
export const MERGE_CARRIED_NOTE = "Carried to this contact when two contacts were merged.";

/** The scopes that are one message to one person. Every other scope (follow-ups, reminders, program messages, and any added later) is a program and fails closed. */
const ONE_TO_ONE_SCOPES = new Set(["reply", "human"]);

/**
 * Whether a message must be refused because its address is one a visitor typed and nobody has confirmed. Allowed: a person's own one-to-one reply (or an AI
 * draft that person approved by name) with the service purpose. Refused: everything automated, every promotional message, and every follow-up, reminder
 * and program message, whoever is named as the sender.
 */
export function unverifiedIdentityRefusal(dest: DestinationFacts, send: SendFacts): { reason: typeof IDENTITY_UNVERIFIED; detail: string } | null {
  if (!typedByVisitorOnly(dest)) return null;
  const aPersonWrote = send.actor === "human" || (send.actor === "ai" && send.approvedByPerson);
  const oneToOne = aPersonWrote && ONE_TO_ONE_SCOPES.has(send.scope);
  if (send.purpose === "marketing" || !oneToOne) return { reason: IDENTITY_UNVERIFIED, detail: IDENTITY_UNVERIFIED_DETAIL };
  return null;
}
