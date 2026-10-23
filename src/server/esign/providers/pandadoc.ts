import "server-only";
import { randomBytes } from "node:crypto";
import { env } from "@/server/env";
import { classifyEsignFailure } from "@/lib/esign/errors";
import { buildMultipart, type MultipartPart } from "@/lib/esign/multipart";
import { PROVIDER_CAN_CANCEL } from "@/lib/esign/state";
import { isPandaDocId, PANDADOC_LABEL, PANDADOC_ORIGIN, pandaDocSignatureValid, parseWebhookBody, readPandaDocStatus, referenceOf, splitName } from "@/lib/esign/pandadoc";
import { ProviderHttpError, providerBinaryRequest } from "@/server/esign/http";
import {
  EsignProviderError, type CreateInput, type CreateState, type DocumentStatus, type EsignCredentials, type EsignProvider, type ProviderHealth, type Reconciliation,
  type SignaturePlacement, type SignedCopies, type StepResult, type VerifiedDelivery,
} from "@/server/esign/providers/types";

// PandaDoc, as a signing service the CLIENT connects with its own account (so no per-document cost reaches iAcquire).
//
// UNEXERCISED, AND FROM MEMORY. This adapter has only ever been run against a replaced HTTP layer (tests/esign-pandadoc.test.ts). No network was available when it was written and no
// PandaDoc account exists for this deployment, so every endpoint, header, field name, status name and the webhook's signing scheme below is what the audit
// (docs/roadmap/phases-3-to-7/audit/5ab-proposals-esign.md) and the author remember of PandaDoc's public API reference. They MUST be re-read against PandaDoc's current documentation,
// and the whole flow tried in a PandaDoc sandbox with a founder-approved test key, before this is switched on for any client. Nothing here creates or sends anything unless
// ESIGN_WRITES_ENABLED is true. The things least certain, in order: where a signature field is placed (signatureFields), how a webhook is signed (src/lib/esign/pandadoc.ts),
// the document statuses, and whether a signed copy can be downloaded the way it is here.
//
// Remembered from the reference (all UNVERIFIED): the key goes in an `Authorization: API-Key <key>` header; a PDF is uploaded as multipart (`file` and a JSON `data` part naming
// the recipients) to POST /public/v1/documents, the document is made asynchronously (status document.uploaded, then document.draft), POST /public/v1/documents/{id}/send asks the
// recipients to sign, GET /public/v1/documents/{id} reads the status, GET /public/v1/documents/{id}/download returns the PDF. A way to withdraw a request is NOT assumed: the
// only call remembered that might do it deletes the document from the client's account, which is not something to guess at. `canCancel` is false, so a withdrawn request is
// recorded here, a later signature is set aside, and the business is asked to withdraw the document in PandaDoc itself.

export interface PandaDocRequest {
  method: "GET" | "POST";
  /** Path and nothing else; the origin is fixed. */
  path: string;
  query?: Record<string, string>;
  json?: unknown;
  multipart?: readonly MultipartPart[];
  apiKey: string;
  accept?: "json" | "pdf";
  /** The call could make something at PandaDoc, so an answer that never arrives means "unknown outcome" rather than "failed". */
  sent: boolean;
}

export interface PandaDocResponse {
  status: number;
  json: unknown;
  bytes: Buffer;
  retryAfter: string | null;
}

export type PandaDocHttp = (req: PandaDocRequest) => Promise<PandaDocResponse>;

/** The real HTTP layer: the fixed official origin, no redirects, the key in a header and never in the address, a time limit and a size cap on both directions. */
export const pandaDocHttp: PandaDocHttp = async (req) => {
  const url = new URL(`${PANDADOC_ORIGIN}${req.path}`);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, v);
  const headers: Record<string, string> = { Authorization: `API-Key ${req.apiKey}`, Accept: req.accept === "pdf" ? "application/pdf" : "application/json" };
  let body: Buffer | string | undefined;
  if (req.multipart) {
    const m = buildMultipart(req.multipart, `iacquire-${randomBytes(12).toString("hex")}`);
    headers["Content-Type"] = m.contentType;
    body = m.body;
  } else if (req.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(req.json);
  }
  const res = await providerBinaryRequest({ method: req.method, url: url.toString(), allowedOrigins: [PANDADOC_ORIGIN], headers, body, timeoutMs: 30_000 });
  let json: unknown = null;
  if ((res.headers.get("content-type") ?? "").includes("json") && res.body.length) {
    try {
      json = JSON.parse(res.body.toString("utf8"));
    } catch {
      json = null;
    }
  }
  return { status: res.status, json, bytes: res.body, retryAfter: res.headers.get("retry-after") };
};

/**
 * UNVERIFIED, and the least certain part of this adapter. What a signing service needs to place one signature field is a page, a position, a size and who signs; this builds that
 * from our own signature area and puts it in the shape the author guesses PandaDoc takes. It is NOT known to be PandaDoc's real field schema. Read PandaDoc's "create a document
 * from a PDF" reference for how fields are placed (and which way up its coordinates run) before relying on it.
 */
export function signatureFields(placement: SignaturePlacement, signerEmail: string): Record<string, unknown> {
  return {
    Signature: {
      type: "signature",
      assigned_to: { email: signerEmail },
      layout: { page: placement.page, position: { x: placement.x, y: placement.yTop }, size: { width: placement.width, height: placement.height } },
    },
  };
}

const idOf = (json: unknown): string | null => {
  const id = json && typeof json === "object" ? (json as { id?: unknown }).id : null;
  return isPandaDocId(id) ? id : null;
};
const statusOf = (json: unknown): unknown => (json && typeof json === "object" ? (json as { status?: unknown }).status : null);

export function createPandaDocProvider(deps: { http?: PandaDocHttp; writesEnabled?: () => boolean } = {}): EsignProvider {
  const http = deps.http ?? pandaDocHttp;
  const writesEnabled = deps.writesEnabled ?? (() => env().ESIGN_WRITES_ENABLED);
  const assertWrites = () => {
    if (!writesEnabled()) throw new EsignProviderError("blocked", "Sending signing requests to PandaDoc is switched off in this environment, so nothing was sent.");
  };

  /** One call. A failure becomes an EsignProviderError; an answer below 400 is returned for the caller to read. */
  async function call(req: PandaDocRequest): Promise<PandaDocResponse> {
    let res: PandaDocResponse;
    try {
      res = await http(req);
    } catch (e) {
      // Refused before it left: a definite "nothing was sent". Anything else (no answer, cut off, redirected) is silence, and silence after a call that could have made something is
      // an unknown outcome.
      if (e instanceof ProviderHttpError && e.kind === "refused") throw new EsignProviderError("invalid_content", e.message);
      const c = classifyEsignFailure({ httpStatus: null, sent: req.sent, providerLabel: PANDADOC_LABEL });
      throw new EsignProviderError(c.kind, c.message, { needsAttention: c.needsAttention, retryAfterSec: c.retryAfterSec });
    }
    if (res.status >= 400) {
      const c = classifyEsignFailure({ httpStatus: res.status, sent: req.sent && res.status >= 500, retryAfterHeader: res.retryAfter, providerLabel: PANDADOC_LABEL });
      throw new EsignProviderError(c.kind, c.message, { needsAttention: c.needsAttention, retryAfterSec: c.retryAfterSec, httpStatus: res.status });
    }
    return res;
  }

  async function sendDocument(creds: EsignCredentials, documentId: string, input: CreateInput): Promise<"sent" | "not_ready"> {
    try {
      await call({
        method: "POST", path: `/public/v1/documents/${documentId}/send`, apiKey: creds.apiKey, sent: true,
        json: { subject: input.emailSubject, message: input.emailMessage, silent: false },
      });
      return "sent";
    } catch (e) {
      // UNVERIFIED: a document that is still being made is remembered to answer 409. That is a definite "not yet", not a failure.
      if (e instanceof EsignProviderError && e.httpStatus === 409) return "not_ready";
      throw e;
    }
  }

  return {
    adapter: "pandadoc",
    label: PANDADOC_LABEL,
    canCancel: PROVIDER_CAN_CANCEL.pandadoc,

    mayCreate(state) {
      return !state.documentId || (Boolean(state.ready) && !state.sent);
    },

    async health(creds): Promise<ProviderHealth> {
      try {
        await call({ method: "GET", path: "/public/v1/documents", query: { count: "1" }, apiKey: creds.apiKey, sent: false });
        return { status: "connected", detail: "Connected.", accountLabel: null };
      } catch (e) {
        // Only a definite answer changes what a connection is shown as. A key PandaDoc refuses needs attention; another refusal is an error with its reason; silence, a server
        // error or a limit says nothing about the key, so it is thrown for the caller to treat as "could not check".
        if (e instanceof EsignProviderError && e.needsAttention) return { status: "needs_attention", detail: e.message, accountLabel: null };
        if (e instanceof EsignProviderError && e.kind === "invalid_content") return { status: "error", detail: e.message, accountLabel: null };
        throw e;
      }
    },

    async createRequest(creds, input: CreateInput, state: CreateState): Promise<StepResult> {
      if (state.sent) return { state };
      if (!state.documentId) {
        assertWrites();
        const { first, last } = splitName(input.signer.name);
        const data = {
          name: input.name,
          recipients: [{ email: input.signer.email, first_name: first, last_name: last, role: "Signer" }],
          parse_form_fields: false,
          fields: signatureFields(input.placement, input.signer.email),
          metadata: { iacquire_request: input.requestId, iacquire_key: input.idempotencyKey },
          tags: ["iacquire"],
        };
        const res = await call({
          method: "POST", path: "/public/v1/documents", apiKey: creds.apiKey, sent: true,
          multipart: [
            { name: "file", value: input.pdf, filename: input.pdfFilename, contentType: "application/pdf" },
            { name: "data", value: JSON.stringify(data) },
          ],
        });
        const id = idOf(res.json);
        // An answer that is not a document id is not a created document we can use; if PandaDoc made one, the reference in its name lets reconcile find it.
        if (!id) throw new EsignProviderError("unknown_outcome", "PandaDoc answered, but not with a document iAcquire could use. It is being checked and will not be sent again until that is known.");
        return { state: { documentId: id } };
      }
      if (!state.ready) {
        const res = await call({ method: "GET", path: `/public/v1/documents/${state.documentId}`, apiKey: creds.apiKey, sent: false });
        const reading = readPandaDocStatus(statusOf(res.json));
        // Already past draft (sent by hand in PandaDoc, or a send whose answer was lost): the signer has been asked, so there is nothing left to send.
        if (reading === "sent" || reading === "viewed" || reading === "completed") return { state: { documentId: state.documentId, ready: true, sent: true } };
        if (reading === "draft" && statusOf(res.json) === "document.draft") return { state: { ...state, ready: true } };
        return { state, waitSeconds: 3 };
      }
      assertWrites();
      if ((await sendDocument(creds, state.documentId, input)) === "not_ready") return { state: { documentId: state.documentId, ready: false }, waitSeconds: 5 };
      return { state: { documentId: state.documentId, ready: true, sent: true } };
    },

    async reconcile(creds, input, state): Promise<Reconciliation> {
      if (state.documentId) {
        try {
          const res = await call({ method: "GET", path: `/public/v1/documents/${state.documentId}`, apiKey: creds.apiKey, sent: false });
          const reading = readPandaDocStatus(statusOf(res.json));
          return { found: true, documentId: state.documentId, fact: reading ?? "draft" };
        } catch (e) {
          if (e instanceof EsignProviderError && e.httpStatus === 404) return { found: false };
          throw e;
        }
      }
      const ref = referenceOf(input.requestId);
      const res = await call({ method: "GET", path: "/public/v1/documents", query: { q: ref, count: "10" }, apiKey: creds.apiKey, sent: false });
      const results = res.json && typeof res.json === "object" ? (res.json as { results?: unknown }).results : null;
      const fits = (Array.isArray(results) ? results : []).filter((r): r is { id: unknown; name: unknown; status: unknown } => Boolean(r) && typeof r === "object" && typeof (r as { name?: unknown }).name === "string" && ((r as { name: string }).name.includes(ref)) && isPandaDocId((r as { id?: unknown }).id));
      if (fits.length === 1) return { found: true, documentId: fits[0].id as string, fact: readPandaDocStatus(fits[0].status) ?? "draft" };
      return fits.length ? { found: false, uncertain: true } : { found: false };
    },

    async getStatus(creds, documentId): Promise<DocumentStatus> {
      if (!isPandaDocId(documentId)) throw new EsignProviderError("invalid_content", "That is not a PandaDoc document id.");
      const res = await call({ method: "GET", path: `/public/v1/documents/${documentId}`, apiKey: creds.apiKey, sent: false });
      return { fact: readPandaDocStatus(statusOf(res.json)) };
    },

    async downloadSigned(creds, documentId): Promise<SignedCopies> {
      if (!isPandaDocId(documentId)) throw new EsignProviderError("invalid_content", "That is not a PandaDoc document id.");
      const res = await call({ method: "GET", path: `/public/v1/documents/${documentId}/download`, apiKey: creds.apiKey, accept: "pdf", sent: false });
      if (res.bytes.length < 8 || res.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new EsignProviderError("transient", "PandaDoc did not return a PDF for the signed copy yet.");
      // The completion certificate is a separate download in PandaDoc, and its address was not remembered with confidence, so none is fetched: the signed copy is kept and the
      // signing service itself holds the certificate.
      return { signedPdf: res.bytes, certificate: null };
    },

    async cancel(): Promise<void> {
      throw new EsignProviderError("blocked", "iAcquire cannot withdraw a request at PandaDoc. Withdraw the document in PandaDoc.");
    },

    verifyWebhook({ rawBody, query }, creds: EsignCredentials): VerifiedDelivery {
      if (!pandaDocSignatureValid(rawBody, query.get("signature"), creds.webhookKey)) return { ok: false, reason: "bad_signature" };
      const events = parseWebhookBody(rawBody);
      return events ? { ok: true, events } : { ok: false, reason: "malformed" };
    },
  };
}

export const pandaDocProvider: EsignProvider = createPandaDocProvider();
