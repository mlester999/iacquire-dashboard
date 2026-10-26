// The life of a signature request, and the rules for when a signature may become an acceptance. Pure: the server enforces these and the interface only reads them.
//
// A request is one ask, to one signer, to sign one frozen version of one proposal at the client's own signing service. The service's word is what moves it forward (a signed
// webhook, or a status read with the client's own key); nothing here is ever set from a guess. A request can only move forward: a "viewed" that arrives after "completed" changes
// nothing. A completion becomes an ACCEPTANCE of the proposal only if the proposal is still on the version that was sent for signing, still unanswered and not past its date;
// otherwise the signature is kept as the service's fact and set aside with the reason, for a person to look at.
import type { ProposalStatus } from "@/lib/proposals/state";

export const REQUEST_STATUSES = ["queued", "sending", "sent", "viewed", "completed", "declined", "expired", "voided", "failed", "unknown", "superseded"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A request in one of these is still out: it holds the version's single slot, and the customer cannot be asked again until it ends. */
export const LIVE_STATUSES: readonly RequestStatus[] = ["queued", "sending", "sent", "viewed", "unknown"];
export const isLive = (s: RequestStatus): boolean => LIVE_STATUSES.includes(s);
/** Nothing more happens to it except a late word from the service (a signature that arrives after it was withdrawn) and the fetching of the signed copy. */
export const isEnded = (s: RequestStatus): boolean => !isLive(s);

export const STATUS_LABELS: Record<RequestStatus, string> = {
  queued: "Waiting to be sent",
  sending: "Being sent",
  sent: "Sent for signing",
  viewed: "Opened by the signer",
  completed: "Signed",
  declined: "Declined",
  expired: "Expired",
  voided: "Withdrawn",
  failed: "Could not be sent",
  unknown: "Checking",
  superseded: "Replaced by a newer version",
};

export type SigningMode = "sandbox" | "live" | "simulated";

export const PROVIDERS = ["pandadoc", "simulated"] as const;
export type SigningProvider = (typeof PROVIDERS)[number];

/** How a service is named to a person, and whether iAcquire can withdraw a request at it. PandaDoc cannot be withdrawn from here (see src/server/esign/providers/pandadoc.ts). */
export const PROVIDER_LABELS: Record<SigningProvider, string> = { pandadoc: "PandaDoc", simulated: "the simulated signing service" };
export const PROVIDER_CAN_CANCEL: Record<SigningProvider, boolean> = { pandadoc: false, simulated: true };

/** One line saying what a status means, never softer than the truth. "Signed" is only ever the signing service's word. */
export function statusExplain(status: RequestStatus, o: { signerName: string; mode: SigningMode; providerLabel: string }): string {
  const who = o.signerName || "the signer";
  const simulated = o.mode === "simulated";
  switch (status) {
    case "queued": return `Waiting to be handed to ${o.providerLabel}. Nothing has reached ${who} yet.`;
    case "sending": return `Being handed to ${o.providerLabel} now. Nothing has reached ${who} yet.`;
    case "sent": return simulated ? `Simulated: no real document was sent to ${who} and nothing here is legally binding.` : `${o.providerLabel} has been asked to send the document to ${who}. Nothing is signed yet.`;
    case "viewed": return simulated ? `Simulated: ${who} is pretending to have opened it. Nothing is legally binding.` : `${o.providerLabel} reports that ${who} opened the document. Nothing is signed yet.`;
    case "completed": return simulated ? "Simulated: this was signed by the stand-in service. It is not a real signature and nothing here is legally binding." : `${o.providerLabel} reports that ${who} signed. The signature itself is held by ${o.providerLabel}.`;
    case "declined": return `${o.providerLabel} reports that ${who} declined to sign.`;
    case "expired": return `${o.providerLabel} reports that the request ran out before ${who} signed.`;
    case "voided": return "A person withdrew this request, or the proposal was closed. Nothing signed after this was applied to the proposal.";
    case "failed": return `${o.providerLabel} did not accept the request, so nothing was sent to ${who}.`;
    case "unknown": return `iAcquire could not confirm whether ${o.providerLabel} sent this. It is being checked with them and will not be sent again until that is known.`;
    case "superseded": return "The proposal was revised after this was sent. This request is for the older version and can no longer be applied.";
  }
}

// ---------------------------------------------------------------------------
// The service's word
// ---------------------------------------------------------------------------

/** What a signing service can tell us about a document, in our terms. */
export type ProviderFact = "sent" | "viewed" | "completed" | "declined" | "expired" | "voided";

const RANK: Partial<Record<RequestStatus, number>> = { queued: 0, sending: 1, unknown: 1, sent: 2, viewed: 3 };

export type FactResult = { change: RequestStatus } | { ignore: "no_change" | "behind" | "conflict" };

/**
 * Where a request goes when the service reports a fact. Forward only. Completed is accepted from any state except declined (a document cannot have been both), because a
 * signature that arrives after a request was withdrawn or replaced is still a signature: it is recorded, and set aside by completionVerdict. Declined, expired and withdrawn
 * apply only to a request that is still out. Sent and viewed only move a live request forward.
 */
export function applyFact(current: RequestStatus, fact: ProviderFact): FactResult {
  if (fact === "completed") {
    if (current === "completed") return { ignore: "no_change" };
    if (current === "declined") return { ignore: "conflict" };
    return { change: "completed" };
  }
  if (!isLive(current)) return { ignore: "behind" };
  if (fact === "declined" || fact === "expired" || fact === "voided") return { change: fact };
  const from = RANK[current] ?? 0;
  const to = fact === "viewed" ? 3 : 2;
  return to > from ? { change: fact } : { ignore: "no_change" };
}

// ---------------------------------------------------------------------------
// When a signature becomes an acceptance
// ---------------------------------------------------------------------------

export type NotAppliedReason = "superseded" | "voided" | "proposal_closed" | "expired" | "already_answered" | "integrity";

export interface CompletionFacts {
  /** The request's status before the service's word arrived. */
  requestStatus: RequestStatus;
  requestVersion: number;
  proposalStatus: ProposalStatus;
  proposalVersion: number;
  sentVersion: number | null;
  /** The frozen version still hashes to what the request was made for. */
  versionIntact: boolean;
  /** An accepted or declined answer is already recorded for this version. */
  alreadyAnswered: boolean;
  /** The proposal's valid-until date has passed in the workspace's own calendar. */
  pastDate: boolean;
}

/**
 * Whether a completion is applied to the proposal. The first rule that does not hold wins, and its reason is what a person is shown. Applied only when the request was still
 * out (queued, being sent, sent, opened or being checked), the proposal is still sent on the very version the signer was asked to sign, nobody answered it, and it is not past
 * its date.
 */
export function completionVerdict(f: CompletionFacts): { apply: true } | { apply: false; reason: NotAppliedReason } {
  if (f.requestStatus === "superseded" || f.proposalVersion !== f.requestVersion) return { apply: false, reason: "superseded" };
  // A request that had already ended (withdrawn, closed, could not be sent, ran out) is not revived by a late word from the service: the business was told it was over.
  if (f.requestStatus === "completed") return { apply: false, reason: "already_answered" };
  if (!isLive(f.requestStatus)) return { apply: false, reason: "voided" };
  if (f.alreadyAnswered || f.proposalStatus === "accepted" || f.proposalStatus === "declined") return { apply: false, reason: "already_answered" };
  if (f.proposalStatus === "expired" || (f.proposalStatus === "sent" && f.pastDate)) return { apply: false, reason: "expired" };
  if (f.proposalStatus !== "sent" || f.sentVersion !== f.requestVersion) return { apply: false, reason: "proposal_closed" };
  if (!f.versionIntact) return { apply: false, reason: "integrity" };
  return { apply: true };
}

export const NOT_APPLIED_TEXT: Record<NotAppliedReason, string> = {
  superseded: "The signer signed an older version. The proposal was revised after the request was sent, so this signature was not applied to the new version.",
  voided: "The signing request had already ended (it was withdrawn, closed, could not be sent or ran out) when the signature arrived, so this signature was not applied to the proposal.",
  proposal_closed: "The proposal was no longer open when the signature arrived (it was withdrawn or taken back), so this signature was not applied to it.",
  expired: "The proposal's valid-until date had passed when the signature arrived, so this signature was not applied to it.",
  already_answered: "The proposal already had an answer recorded for this version, so this signature was not applied to it.",
  integrity: "The saved version no longer matches the document the signer was sent, so this signature was not applied. Contact support.",
};

// ---------------------------------------------------------------------------
// The connection, and whether a request can be made
// ---------------------------------------------------------------------------

export type ConnectionStatus = "connected" | "needs_attention" | "error" | "revoked" | "disconnected";

export const REAL_WRITES_OFF_MESSAGE = "Sending signing requests to a real signing service is switched off in this environment. Ask your iAcquire contact when it will be switched on.";
export const SIMULATED_NOTICE = "Simulated: no real document is sent and nothing here is legally binding.";
export const SANDBOX_NOTICE = "Sandbox: this is a test account at the signing service, not a live one.";
export const ESIGN_NOT_ENABLED_MESSAGE = "Electronic signing isn't switched on for your workspace yet. Ask your iAcquire contact to switch it on.";

/** What a person should know about a connection before trusting what it does. */
export function connectionNotice(c: { mode: SigningMode; writesEnabled: boolean }): string | null {
  if (c.mode === "simulated") return SIMULATED_NOTICE;
  if (!c.writesEnabled) return REAL_WRITES_OFF_MESSAGE;
  return c.mode === "sandbox" ? SANDBOX_NOTICE : null;
}

export interface RequestFacts {
  esignOn: boolean;
  connection: { status: ConnectionStatus; mode: SigningMode; detail: string | null } | null;
  /** ESIGN_WRITES_ENABLED. Not needed for a simulated connection. */
  writesEnabled: boolean;
  proposal: { status: ProposalStatus; version: number; sentVersion: number | null; requiresSignature: boolean; pastDate: boolean };
  /** A request for this version is already out. */
  liveRequest: boolean;
}

/** Why a signing request cannot be made right now, in words a person can act on, or null when it can. The server asks the same question again on every request. */
export function requestBlockedReason(f: RequestFacts): string | null {
  if (!f.esignOn) return ESIGN_NOT_ENABLED_MESSAGE;
  if (!f.proposal.requiresSignature) return "This proposal doesn't ask for a signature. Turn that on and send a new version first.";
  if (f.proposal.status !== "sent" || f.proposal.sentVersion !== f.proposal.version) return "Only a proposal that has been sent can be sent for signing.";
  if (f.proposal.pastDate) return "The proposal's valid-until date has passed.";
  if (!f.connection || f.connection.status === "disconnected" || f.connection.status === "revoked") return "No signing service is connected. Connect one in the proposal settings.";
  if (f.connection.status !== "connected") {
    const why = f.connection.detail ? `: ${f.connection.detail.replace(/[.\s]+$/, "")}` : "";
    return `The signing service needs attention${why}. Connect it again in the proposal settings.`;
  }
  if (f.connection.mode !== "simulated" && !f.writesEnabled) return REAL_WRITES_OFF_MESSAGE;
  if (f.liveRequest) return "A signing request is already out for this version.";
  return null;
}

// ---------------------------------------------------------------------------
// A request's stable parts
// ---------------------------------------------------------------------------

/**
 * proposal : id : version : n, where n counts the requests already made for that version. The first request for a version names the same key every time, so a doubled click
 * finds the first one; a later request (after one ended) is a deliberate new ask and gets the next number.
 */
export const requestKey = (proposalId: string, version: number, ordinal: number): string => `proposal:${proposalId}:${version}:${Math.max(0, Math.floor(ordinal))}`;

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type SignerParse = { ok: true; name: string; email: string } | { ok: false; message: string };

/** Who is asked to sign: a name and an email address that look right. Nothing else is accepted, and the address is lower-cased. */
export function parseSigner(input: { name?: string | null; email?: string | null }): SignerParse {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim();
  const email = (input.email ?? "").trim().toLowerCase();
  if (!name) return { ok: false, message: "Say who should sign." };
  if (name.length > 160) return { ok: false, message: "The signer's name can be at most 160 characters." };
  if (!email) return { ok: false, message: "The signer needs an email address, because the signing service sends the document there." };
  if (email.length > 254 || !EMAIL_RE.test(email)) return { ok: false, message: "That email address doesn't look right." };
  return { ok: true, name, email };
}

/**
 * The words the signing service puts in the email it sends the signer. Fixed text: nothing a model wrote and nothing the business typed in a free field goes into it, and it
 * names no price, discount or date. The business and signer names are cut to a sensible length.
 */
export function signingEmail(o: { business: string; signerName: string; number: string; version: number }): { subject: string; message: string } {
  const from = o.business.replace(/\s+/g, " ").trim().slice(0, 80) || "A business";
  const to = o.signerName.replace(/\s+/g, " ").trim().slice(0, 100) || "there";
  return {
    subject: `${from} asks you to sign proposal ${o.number}`,
    message: `Hello ${to},\n\n${from} has asked you to review and sign proposal ${o.number} (version ${o.version}). Use the button in this email to open it. If you weren't expecting this, you can ignore the email.`,
  };
}

/** Masks an address for an audit line or a notice: the first letter and the domain. */
export function maskedEmail(email: string): string {
  const at = email.lastIndexOf("@");
  if (at < 1) return "an address on file";
  return `${email[0]}***${email.slice(at)}`;
}
