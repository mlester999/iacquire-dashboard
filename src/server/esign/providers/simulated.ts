import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { PROVIDER_CAN_CANCEL, PROVIDER_LABELS, type ProviderFact } from "@/lib/esign/state";
import type { WebhookEvent } from "@/lib/esign/pandadoc";
import { PdfDocument } from "@/lib/pdf/writer";
import { sha256Hex } from "@/lib/proposals/hash";
import {
  EsignProviderError, type CreateInput, type CreateState, type DocumentStatus, type EsignCredentials, type EsignProvider, type ProviderHealth, type Reconciliation, type SignedCopies,
  type StepResult, type VerifiedDelivery,
} from "@/server/esign/providers/types";

// A stand-in for a signing service that lives inside this process. It signs nothing for anyone and sends nothing anywhere. It exists so the whole signing pipeline (the request,
// retries, duplicate protection, a lost answer, a webhook, a late or replayed delivery, a withdrawn request, a signed copy that cannot be fetched yet) can be tested and clicked
// through without a PandaDoc account, and it refuses to run in production (see providers/index.ts).
//
// It behaves the way a real service is documented to in the ways that matter for safety: creating a document is NOT repeatable (asking twice makes two documents, which is exactly
// what the duplicate-protection tests count), a document is only readable by the id the service gave it, a delivery is signed over its exact bytes with a shared key and a
// timestamp, and it can be told to fail, to go quiet after doing the work (so the caller never learns the outcome), or to have lost its key. Whatever it was asked to do is
// visible in `world`.

export type SimStatus = "draft" | "sent" | "viewed" | "completed" | "declined" | "expired" | "voided";

export interface SimDocument {
  id: string;
  name: string;
  signerName: string;
  signerEmail: string;
  status: SimStatus;
  pdf: Buffer;
  idempotencyKey: string;
  createdAt: Date;
}

type Step = "create" | "ready" | "send" | "reconcile" | "health" | "status" | "download" | "cancel";

interface World {
  docs: SimDocument[];
  seq: number;
  failures: Array<{ step: Step; error: EsignProviderError }>;
  /** Do the work, then fail with an unknown outcome. */
  lose: Step[];
  /** How many times the service answers "not ready yet" before a document is ready to send. */
  notReady: number;
  revoked: Set<string>;
  log: Array<{ step: Step; at: number }>;
}

const fresh = (): World => ({ docs: [], seq: 0, failures: [], lose: [], notReady: 0, revoked: new Set(), log: [] });
// Kept on globalThis as well, so a server action and the scheduler's route (which the framework may load as separate copies of this file) talk to the same stand-in service
// when someone clicks through the simulated flow in a browser.
type Shared = typeof globalThis & { __iacquireSimulatedEsign?: World };
let world: World = ((globalThis as Shared).__iacquireSimulatedEsign ??= fresh());

export const SIM_SIGNATURE_HEADER = "x-simulated-signature";
export const SIM_TIMESTAMP_HEADER = "x-simulated-timestamp";
/** A delivery older than this is refused, so a captured one cannot be replayed later. */
export const SIM_TOLERANCE_SECONDS = 300;

const FACTS: Record<SimStatus, ProviderFact | "draft"> = { draft: "draft", sent: "sent", viewed: "viewed", completed: "completed", declined: "declined", expired: "expired", voided: "voided" };

export const simulatedEsign = {
  reset() {
    world = fresh();
    (globalThis as Shared).__iacquireSimulatedEsign = world;
  },
  documents(): SimDocument[] {
    return world.docs.map((d) => ({ ...d }));
  },
  document(id: string): SimDocument | undefined {
    return world.docs.find((d) => d.id === id);
  },
  /** The next time the service is asked to do this step, it refuses with this error (once). */
  failNext(step: Step, error: EsignProviderError) {
    world.failures.push({ step, error });
  },
  /** The next time the service is asked to do this step, it does the work and then never answers. */
  loseResponseNext(step: Step) {
    world.lose.push(step);
  },
  /** The next `times` readiness checks answer "not ready yet". */
  holdReady(times: number) {
    world.notReady = times;
  },
  revoke(apiKey: string) {
    world.revoked.add(apiKey);
  },
  calls(step?: Step): number {
    return world.log.filter((l) => !step || l.step === step).length;
  },
  /** What the signer does at the service: opens it, signs it, declines it, lets it run out. Changes the document only; nothing is told to iAcquire until a delivery is made. */
  signerAction(documentId: string, action: "view" | "complete" | "decline" | "expire" | "void") {
    const doc = world.docs.find((d) => d.id === documentId);
    if (!doc) throw new Error("No such simulated document.");
    doc.status = ({ view: "viewed", complete: "completed", decline: "declined", expire: "expired", void: "voided" } as const)[action];
  },
  /** A delivery of the document's current state, signed the way the simulated service signs: what the webhook route receives. `at` is the time on its stamp. */
  delivery(documentId: string, webhookKey: string, opts: { at?: Date; eventId?: string; status?: SimStatus } = {}): { rawBody: Buffer; headers: Headers; query: URLSearchParams } {
    const doc = world.docs.find((d) => d.id === documentId);
    if (!doc) throw new Error("No such simulated document.");
    const id = opts.eventId ?? `simev-${documentId}-${opts.status ?? doc.status}`;
    const rawBody = Buffer.from(JSON.stringify({ id, type: "document.status", documentId, status: opts.status ?? doc.status }), "utf8");
    return signedDelivery(rawBody, webhookKey, opts.at ?? new Date());
  },
};

/** Signs raw bytes the way the simulated service does: HMAC-SHA256 under the shared key over "<seconds>.<body>", hex. */
export function signedDelivery(rawBody: Buffer, webhookKey: string, at: Date): { rawBody: Buffer; headers: Headers; query: URLSearchParams } {
  const stamp = String(Math.floor(at.getTime() / 1000));
  const digest = createHmac("sha256", webhookKey).update(`${stamp}.`).update(rawBody).digest("hex");
  return { rawBody, headers: new Headers({ [SIM_SIGNATURE_HEADER]: digest, [SIM_TIMESTAMP_HEADER]: stamp, "content-type": "application/json" }), query: new URLSearchParams() };
}

function enter(step: Step) {
  world.log.push({ step, at: Date.now() });
  const i = world.failures.findIndex((f) => f.step === step);
  if (i >= 0) throw world.failures.splice(i, 1)[0].error;
}

/** After the work is done: if the service was told to go quiet on this step, the caller never learns the outcome. */
function maybeLose(step: Step) {
  const i = world.lose.indexOf(step);
  if (i >= 0) {
    world.lose.splice(i, 1);
    throw new EsignProviderError("unknown_outcome", "The signing service did not confirm whether this was sent. It is being checked and will not be sent again until that is known.");
  }
}

function checkKey(creds: EsignCredentials) {
  if (world.revoked.has(creds.apiKey)) throw new EsignProviderError("auth", "The signing service no longer accepts this key. Connect it again.", { needsAttention: true });
}

const referenceIn = (name: string) => /ref ([0-9a-f]{8})\b/.exec(name)?.[1] ?? null;

/** A small, valid PDF that says plainly it is not a real certificate. */
function certificatePdf(doc: SimDocument): Buffer {
  const pdf = new PdfDocument({ title: "Simulated certificate of completion", createdAt: new Date(0), idSeed: sha256Hex(doc.id) });
  pdf.text(0, pdf.margin, pdf.margin + 14, "Simulated certificate of completion", { font: "bold", size: 16 });
  pdf.text(0, pdf.margin, pdf.margin + 40, "This was produced by the simulated signing service. It is not a real signature and is not legally binding.", { size: 10 });
  pdf.text(0, pdf.margin, pdf.margin + 60, `Document ${doc.id}, signer ${doc.signerName}.`, { size: 10 });
  return pdf.build();
}

export const simulatedProvider: EsignProvider = {
  adapter: "simulated",
  label: PROVIDER_LABELS.simulated,
  canCancel: PROVIDER_CAN_CANCEL.simulated,

  mayCreate(state) {
    // Making the document, and sending it, each show something at the service; asking whether it is ready shows nothing.
    return !state.documentId || (Boolean(state.ready) && !state.sent);
  },

  async health(creds): Promise<ProviderHealth> {
    enter("health");
    if (world.revoked.has(creds.apiKey)) return { status: "needs_attention", detail: "The simulated service no longer accepts this key.", accountLabel: null };
    return { status: "connected", detail: "Connected (simulated).", accountLabel: "Simulated signing service" };
  },

  async createRequest(creds, input: CreateInput, state: CreateState): Promise<StepResult> {
    checkKey(creds);
    if (state.sent) return { state };
    if (!state.documentId) {
      enter("create");
      // Not repeatable: asking twice makes two documents. That is exactly what the worker must never do.
      const doc: SimDocument = { id: `simdoc_${++world.seq}`, name: input.name, signerName: input.signer.name, signerEmail: input.signer.email, status: "draft", pdf: input.pdf, idempotencyKey: input.idempotencyKey, createdAt: new Date() };
      world.docs.push(doc);
      maybeLose("create");
      return { state: { documentId: doc.id } };
    }
    const doc = world.docs.find((d) => d.id === state.documentId);
    if (!doc) throw new EsignProviderError("invalid_content", "The signing service no longer has the document that was prepared.");
    if (!state.ready) {
      enter("ready");
      if (world.notReady > 0) {
        world.notReady -= 1;
        return { state, waitSeconds: 2 };
      }
      return { state: { ...state, ready: true } };
    }
    enter("send");
    if (doc.status === "draft") doc.status = "sent";
    maybeLose("send");
    return { state: { documentId: doc.id, ready: true, sent: true } };
  },

  async reconcile(creds, input, state): Promise<Reconciliation> {
    checkKey(creds);
    enter("reconcile");
    if (state.documentId) {
      const doc = world.docs.find((d) => d.id === state.documentId);
      return doc ? { found: true, documentId: doc.id, fact: FACTS[doc.status] } : { found: false };
    }
    const ref = referenceIn(input.name);
    const fits = world.docs.filter((d) => (ref && referenceIn(d.name) === ref) || d.idempotencyKey === input.idempotencyKey);
    if (fits.length === 1) return { found: true, documentId: fits[0].id, fact: FACTS[fits[0].status] };
    return fits.length ? { found: false, uncertain: true } : { found: false };
  },

  async getStatus(creds, documentId): Promise<DocumentStatus> {
    checkKey(creds);
    enter("status");
    const doc = world.docs.find((d) => d.id === documentId);
    if (!doc) throw new EsignProviderError("invalid_content", "The signing service has no such document.", { httpStatus: 404 });
    return { fact: FACTS[doc.status] };
  },

  async downloadSigned(creds, documentId): Promise<SignedCopies> {
    checkKey(creds);
    enter("download");
    const doc = world.docs.find((d) => d.id === documentId);
    if (!doc) throw new EsignProviderError("invalid_content", "The signing service has no such document.", { httpStatus: 404 });
    if (doc.status !== "completed") throw new EsignProviderError("invalid_content", "The signing service has no signed copy yet.", { httpStatus: 409 });
    return { signedPdf: Buffer.concat([doc.pdf, Buffer.from(`\n% SIMULATED SIGNATURE: not a real signature (${doc.id})\n`, "latin1")]), certificate: certificatePdf(doc) };
  },

  async cancel(creds, documentId): Promise<void> {
    checkKey(creds);
    enter("cancel");
    const doc = world.docs.find((d) => d.id === documentId);
    if (doc && (doc.status === "draft" || doc.status === "sent" || doc.status === "viewed")) doc.status = "voided";
  },

  verifyWebhook({ rawBody, headers }, creds): VerifiedDelivery {
    const stamp = headers.get(SIM_TIMESTAMP_HEADER);
    const provided = headers.get(SIM_SIGNATURE_HEADER);
    if (!stamp || !/^\d{9,12}$/.test(stamp) || !provided || !/^[0-9a-f]{64}$/.test(provided) || !creds.webhookKey) return { ok: false, reason: "bad_signature" };
    if (Math.abs(Date.now() / 1000 - Number(stamp)) > SIM_TOLERANCE_SECONDS) return { ok: false, reason: "bad_signature" };
    const expected = createHmac("sha256", creds.webhookKey).update(`${stamp}.`).update(rawBody).digest();
    if (!timingSafeEqual(expected, Buffer.from(provided, "hex"))) return { ok: false, reason: "bad_signature" };
    try {
      const j = JSON.parse(rawBody.toString("utf8")) as { id?: unknown; type?: unknown; documentId?: unknown; status?: unknown };
      if (typeof j.id !== "string" || typeof j.documentId !== "string" || typeof j.status !== "string" || !/^[A-Za-z0-9_-]{1,80}$/.test(j.documentId) || !/^[A-Za-z0-9_-]{1,120}$/.test(j.id)) return { ok: false, reason: "malformed" };
      const fact = Object.hasOwn(FACTS, j.status) ? FACTS[j.status as SimStatus] : null;
      const event: WebhookEvent = { name: "status", documentId: j.documentId, status: j.status, fact: fact && fact !== "draft" ? fact : null, eventId: `sim:${j.id}` };
      return { ok: true, events: [event] };
    } catch {
      return { ok: false, reason: "malformed" };
    }
  },
};
