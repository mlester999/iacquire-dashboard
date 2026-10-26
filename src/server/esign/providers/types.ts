import type { ProviderFact } from "@/lib/esign/state";
import type { WebhookEvent } from "@/lib/esign/pandadoc";
import type { FailureKind } from "@/lib/esign/errors";

// The contract between the signing worker and a signing service. The worker knows nothing about PandaDoc: it saves a small `CreateState` after every step, so a worker that dies and
// a worker that takes over continue from the same place, and it asks the adapter to `reconcile` when an answer never arrived, so a request is never sent twice by guesswork.

export class EsignProviderError extends Error {
  readonly kind: FailureKind;
  /** The connection's key no longer works: only connecting again helps. */
  readonly needsAttention: boolean;
  readonly retryAfterSec: number | null;
  readonly httpStatus: number | null;
  constructor(kind: FailureKind, message: string, opts: { needsAttention?: boolean; retryAfterSec?: number | null; httpStatus?: number | null } = {}) {
    super(message);
    this.name = "EsignProviderError";
    this.kind = kind;
    this.needsAttention = opts.needsAttention ?? false;
    this.retryAfterSec = opts.retryAfterSec ?? null;
    this.httpStatus = opts.httpStatus ?? null;
  }
}

/** A connection's decrypted keys. Held in memory only for the length of a call. */
export interface EsignCredentials {
  apiKey: string;
  /** The shared key the service signs its webhook deliveries with. */
  webhookKey: string;
}

export interface ProviderHealth {
  status: "connected" | "needs_attention" | "error";
  detail: string;
  /** The account's name at the service, when it said. */
  accountLabel: string | null;
}

export interface Signer {
  name: string;
  email: string;
}

/** Where on the document's last page the signature goes: points from the page's top-left corner. */
export interface SignaturePlacement {
  page: number;
  x: number;
  yTop: number;
  width: number;
  height: number;
}

export interface CreateInput {
  requestId: string;
  /** Stable for the request. Adapters that can pass one to the service do; the rest rely on the saved state and on `reconcile`. */
  idempotencyKey: string;
  /** The document's name at the service: the signer sees it. */
  name: string;
  signer: Signer;
  pdf: Buffer;
  pdfFilename: string;
  placement: SignaturePlacement;
  emailSubject: string;
  emailMessage: string;
}

/**
 * What has already happened at the service for one request. Saved after every step. `sendingAt` and `step` are written BEFORE a step that could make something at the service
 * (a document in the client's account, or a message to the signer) and removed once the step has a definite answer, so a crash in between is recognised as "possibly done" and
 * checked, never repeated.
 */
export interface CreateState {
  documentId?: string;
  /** The service holds the document and it is ready to be sent. */
  ready?: boolean;
  /** The service confirmed that the signer has been asked. */
  sent?: boolean;
  sendingAt?: string;
  step?: "create" | "send";
}

export interface StepResult {
  state: CreateState;
  /** When the service is not ready yet, seconds to wait before the next step. */
  waitSeconds?: number;
}

export interface Reconciliation {
  found: boolean;
  documentId?: string;
  /** What the service says the document is: "draft" means it holds it and has not sent it. */
  fact?: ProviderFact | "draft";
  /** Only with `found: false`. The service's answer cannot settle it (several documents fit): a person has to look in the signing account. */
  uncertain?: boolean;
}

export interface DocumentStatus {
  /** null: a status this adapter does not understand, which changes nothing. */
  fact: ProviderFact | "draft" | null;
}

export interface SignedCopies {
  signedPdf: Buffer;
  /** The completion certificate, when the service has one and the adapter knows how to fetch it. */
  certificate: Buffer | null;
}

export type VerifiedDelivery = { ok: true; events: WebhookEvent[] } | { ok: false; reason: "bad_signature" | "malformed" };

export interface EsignProvider {
  readonly adapter: "pandadoc" | "simulated";
  /** How the service is named to a person. */
  readonly label: string;
  /** Whether iAcquire can withdraw a request at the service. When it cannot, withdrawing says so and asks the business to do it there. */
  readonly canCancel: boolean;
  /** Whether the NEXT step could make something at the service. The worker records the intent before such a step. */
  mayCreate(state: CreateState): boolean;
  health(creds: EsignCredentials): Promise<ProviderHealth>;
  /** Performs the next step and returns the state after it. Throws EsignProviderError. */
  createRequest(creds: EsignCredentials, input: CreateInput, state: CreateState): Promise<StepResult>;
  /** Asks the service whether this request exists. Used only when an answer was lost. */
  reconcile(creds: EsignCredentials, input: Pick<CreateInput, "requestId" | "idempotencyKey" | "name">, state: CreateState): Promise<Reconciliation>;
  getStatus(creds: EsignCredentials, documentId: string): Promise<DocumentStatus>;
  downloadSigned(creds: EsignCredentials, documentId: string): Promise<SignedCopies>;
  cancel(creds: EsignCredentials, documentId: string): Promise<void>;
  /** Checks a delivery's signature over the exact bytes received, then reads its events. Never trusts anything in a body that was not verified. */
  verifyWebhook(req: { rawBody: Buffer; headers: Headers; query: URLSearchParams }, creds: EsignCredentials): VerifiedDelivery;
}
