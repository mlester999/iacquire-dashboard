// UNEXERCISED. The PandaDoc adapter has only ever been run against a replaced HTTP layer, in this file. No PandaDoc account was available and no request was made to PandaDoc: every
// endpoint, header, field name, status name and the way a notice is signed is what the audit remembers of PandaDoc's public API reference, and each must be re-read against
// PandaDoc's current documentation and tried in its sandbox before this is switched on for anyone. A green run here proves that the adapter does what it was WRITTEN to do (it asks
// the questions in the right order, never repeats a step that may have made something, maps a refusal to the right action, and refuses a notice that is not signed). It proves
// nothing about what PandaDoc really answers.
import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { documentName, PANDADOC_ORIGIN } from "@/lib/esign/pandadoc";
import { ProviderHttpError } from "@/server/esign/http";
import {
  createPandaDocProvider, pandaDocHttp, signatureFields, type PandaDocHttp, type PandaDocRequest, type PandaDocResponse,
} from "@/server/esign/providers/pandadoc";
import { EsignProviderError, type CreateInput, type CreateState, type EsignCredentials } from "@/server/esign/providers/types";

const CREDS: EsignCredentials = { apiKey: "pd_test_key_0123456789abcdef", webhookKey: "shared-secret-from-the-service" };
const REQUEST_ID = "0f3b1f6e-9a4b-4f55-a1c2-123456789abc";
const DOC_ID = "BhVzRcxH9Z2LgfPPGXFUBa";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.from([0xff, 0xfe, 0x00, 0x80]), Buffer.from("\n%%EOF\n", "latin1")]);
const INPUT: CreateInput = {
  requestId: REQUEST_ID, idempotencyKey: "proposal:p1:2:0", name: documentName("P-0007", 2, REQUEST_ID), signer: { name: "Maria de la Cruz", email: "maria@example.test" }, pdf: PDF,
  pdfFilename: "Proposal-P-0007-v2.pdf", placement: { page: 3, x: 72, yTop: 500, width: 220, height: 56 }, emailSubject: "Acme asks you to sign proposal P-0007", emailMessage: "Hello Maria,\n\nPlease sign.",
};

const reply = (status: number, json: unknown = null, retryAfter: string | null = null): PandaDocResponse => ({ status, json, bytes: Buffer.from(json ? JSON.stringify(json) : ""), retryAfter });

function harness(handler: (req: PandaDocRequest, n: number) => PandaDocResponse | Promise<PandaDocResponse>, opts: { writes?: boolean } = {}) {
  const calls: PandaDocRequest[] = [];
  const state = { writes: opts.writes ?? true };
  const http: PandaDocHttp = async (req) => {
    calls.push(req);
    return handler(req, calls.length);
  };
  return { provider: createPandaDocProvider({ http, writesEnabled: () => state.writes }), calls, state };
}

async function rejects(p: Promise<unknown>): Promise<EsignProviderError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(EsignProviderError);
    return e as EsignProviderError;
  }
  throw new Error("expected the step to be refused");
}

describe("making and sending a request, one step at a time", () => {
  it("creates the document from the PDF with the signer and a signature field, and keeps only the id it was given", async () => {
    const h = harness(() => reply(201, { id: DOC_ID, status: "document.uploaded" }));
    const r = await h.provider.createRequest(CREDS, INPUT, {});
    expect(r.state).toEqual({ documentId: DOC_ID });
    expect(h.calls).toHaveLength(1);
    const c = h.calls[0];
    expect(c).toMatchObject({ method: "POST", path: "/public/v1/documents", apiKey: CREDS.apiKey, sent: true });
    expect(c.multipart?.map((p) => p.name)).toEqual(["file", "data"]);
    expect(c.multipart?.[0]).toMatchObject({ filename: "Proposal-P-0007-v2.pdf", contentType: "application/pdf" });
    expect((c.multipart?.[0].value as Buffer).equals(PDF)).toBe(true);
    const data = JSON.parse(c.multipart?.[1].value as string);
    expect(data).toMatchObject({
      name: INPUT.name, recipients: [{ email: "maria@example.test", first_name: "Maria de la", last_name: "Cruz", role: "Signer" }], parse_form_fields: false,
      metadata: { iacquire_request: REQUEST_ID, iacquire_key: "proposal:p1:2:0" }, tags: ["iacquire"],
    });
    expect(data.fields.Signature).toMatchObject({ type: "signature", assigned_to: { email: "maria@example.test" }, layout: { page: 3, position: { x: 72, y: 500 }, size: { width: 220, height: 56 } } });
    // The signer's email, the subject and the message are not put in the address.
    expect(JSON.stringify(c.query ?? {})).not.toContain("maria@example.test");
  });

  it("waits while the document is still being made, becomes ready at draft, and sends it with the fixed words", async () => {
    const statuses = ["document.uploaded", "document.draft"];
    const h = harness((req) => {
      if (req.method === "GET") return reply(200, { id: DOC_ID, status: statuses.shift() });
      return reply(200, { id: DOC_ID, status: "document.sent" });
    });
    const one = await h.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID });
    expect(one).toEqual({ state: { documentId: DOC_ID }, waitSeconds: 3 });
    const two = await h.provider.createRequest(CREDS, INPUT, one.state);
    expect(two.state).toEqual({ documentId: DOC_ID, ready: true });
    expect(two.waitSeconds).toBeUndefined();
    const three = await h.provider.createRequest(CREDS, INPUT, two.state);
    expect(three.state).toEqual({ documentId: DOC_ID, ready: true, sent: true });
    const send = h.calls[2];
    expect(send).toMatchObject({ method: "POST", path: `/public/v1/documents/${DOC_ID}/send`, sent: true, json: { subject: INPUT.emailSubject, message: INPUT.emailMessage, silent: false } });
  });

  it("does nothing more once the signer has been asked, and treats a document already past draft as asked (sent by hand, or a send whose answer was lost)", async () => {
    const h = harness(() => reply(200, { id: DOC_ID, status: "document.viewed" }));
    expect(await h.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID, ready: true, sent: true })).toEqual({ state: { documentId: DOC_ID, ready: true, sent: true } });
    expect(h.calls).toHaveLength(0);
    for (const status of ["document.sent", "document.viewed", "document.completed"]) {
      const g = harness(() => reply(200, { id: DOC_ID, status }));
      const r = await g.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID });
      expect(r.state, status).toEqual({ documentId: DOC_ID, ready: true, sent: true });
      expect(g.calls.map((c) => c.method), status).toEqual(["GET"]);
    }
  });

  it("treats a status it does not understand as 'not ready yet', and never sends on it", async () => {
    for (const status of ["document.waiting_approval", "weird", undefined]) {
      const h = harness(() => reply(200, { id: DOC_ID, status }));
      const r = await h.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID });
      expect(r.state).toEqual({ documentId: DOC_ID });
      expect(r.waitSeconds).toBe(3);
      expect(h.calls.every((c) => c.method === "GET")).toBe(true);
    }
  });

  it("takes a 409 on send as 'the service is not ready', not as a failure", async () => {
    const h = harness(() => reply(409, { detail: "Document status is not draft" }));
    const r = await h.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID, ready: true });
    expect(r.state).toEqual({ documentId: DOC_ID, ready: false });
    expect(r.waitSeconds).toBe(5);
  });

  it("answers an unusable answer to a create as an unknown outcome: the document may exist, so it is checked and not made again", async () => {
    for (const body of [null, {}, { id: "../x" }, { id: 5 }, { id: "short" }, "text"]) {
      const h = harness(() => reply(201, body));
      const e = await rejects(h.provider.createRequest(CREDS, INPUT, {}));
      expect(e.kind, JSON.stringify(body)).toBe("unknown_outcome");
    }
  });
});

describe("the write switch", () => {
  it("makes and sends nothing while writes are off, and says so as a blocked step (not a failure) before any call is made", async () => {
    const h = harness(() => reply(200, {}), { writes: false });
    const a = await rejects(h.provider.createRequest(CREDS, INPUT, {}));
    const b = await rejects(h.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID, ready: true }));
    expect(a).toMatchObject({ kind: "blocked", needsAttention: false });
    expect(b.kind).toBe("blocked");
    expect(a.message).toContain("switched off in this environment");
    expect(h.calls).toHaveLength(0);
  });

  it("still asks questions with writes off, because asking changes nothing at the service", async () => {
    const h = harness((req) => (req.path.endsWith("/download") ? { status: 200, json: null, bytes: PDF, retryAfter: null } : reply(200, { id: DOC_ID, status: "document.draft", results: [] })), { writes: false });
    await h.provider.health(CREDS);
    await h.provider.getStatus(CREDS, DOC_ID);
    await h.provider.reconcile(CREDS, { requestId: REQUEST_ID, idempotencyKey: "k", name: INPUT.name }, { documentId: DOC_ID });
    await h.provider.downloadSigned(CREDS, DOC_ID);
    // Even the step that only waits for readiness is a question.
    const r = await h.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID });
    expect(r.state).toEqual({ documentId: DOC_ID, ready: true });
    expect(h.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("says which of its steps could make something at the service", () => {
    const { provider } = harness(() => reply(200));
    expect(provider.mayCreate({})).toBe(true);
    expect(provider.mayCreate({ documentId: DOC_ID })).toBe(false);
    expect(provider.mayCreate({ documentId: DOC_ID, ready: true })).toBe(true);
    expect(provider.mayCreate({ documentId: DOC_ID, ready: true, sent: true })).toBe(false);
  });
});

describe("what a refusal means", () => {
  const step = async (status: number, state: CreateState, retryAfter: string | null = null) => {
    const h = harness(() => reply(status, { detail: "the service's own words" }, retryAfter));
    return rejects(h.provider.createRequest(CREDS, INPUT, state));
  };

  it("a key the service refuses needs attention, and its own words are never repeated", async () => {
    const a = await step(401, {});
    const b = await step(403, { documentId: DOC_ID, ready: true });
    expect(a).toMatchObject({ kind: "auth", needsAttention: true, httpStatus: 401 });
    expect(b).toMatchObject({ kind: "permission", needsAttention: true, httpStatus: 403 });
    for (const e of [a, b]) expect(e.message).not.toContain("the service's own words");
  });

  it("slow down is a retry with the wait the service named", async () => {
    expect(await step(429, {}, "90")).toMatchObject({ kind: "rate_limited", retryAfterSec: 90 });
    expect(await step(429, {})).toMatchObject({ kind: "rate_limited", retryAfterSec: 900 });
  });

  it("a definite refusal of the content is final, and a server error after a create is an unknown outcome", async () => {
    expect(await step(400, {})).toMatchObject({ kind: "invalid_content", httpStatus: 400 });
    expect(await step(422, {})).toMatchObject({ kind: "invalid_content" });
    expect(await step(500, {})).toMatchObject({ kind: "unknown_outcome" });
    expect(await step(502, { documentId: DOC_ID, ready: true })).toMatchObject({ kind: "unknown_outcome" });
  });

  it("a server error on a question is only a temporary problem: asking made nothing", async () => {
    const e = await step(500, { documentId: DOC_ID });
    expect(e.kind).toBe("transient");
  });

  it("a call that never answered is an unknown outcome after a create or a send, and a temporary problem after a question", async () => {
    for (const kind of ["timeout", "unreachable", "redirect", "too_large"] as const) {
      const h = harness(() => { throw new ProviderHttpError(kind, "x"); });
      expect((await rejects(h.provider.createRequest(CREDS, INPUT, {}))).kind, kind).toBe("unknown_outcome");
      const g = harness(() => { throw new ProviderHttpError(kind, "x"); });
      expect((await rejects(g.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID, ready: true }))).kind, kind).toBe("unknown_outcome");
      const q = harness(() => { throw new ProviderHttpError(kind, "x"); });
      expect((await rejects(q.provider.createRequest(CREDS, INPUT, { documentId: DOC_ID }))).kind, kind).toBe("transient");
    }
  });

  it("a call refused before it left is a definite 'nothing was sent'", async () => {
    const h = harness(() => { throw new ProviderHttpError("refused", "Only https addresses are called, so nothing was sent."); });
    const e = await rejects(h.provider.createRequest(CREDS, INPUT, {}));
    expect(e).toMatchObject({ kind: "invalid_content" });
    expect(e.message).toContain("nothing was sent");
  });
});

describe("checking and reading", () => {
  it("health is a read, reports connected, and tells a refused key from a service that could not be reached", async () => {
    const ok = harness(() => reply(200, { results: [] }));
    expect(await ok.provider.health(CREDS)).toMatchObject({ status: "connected" });
    expect(ok.calls[0]).toMatchObject({ method: "GET", path: "/public/v1/documents", query: { count: "1" }, sent: false, apiKey: CREDS.apiKey });
    const refused = harness(() => reply(401, {}));
    expect(await refused.provider.health(CREDS)).toMatchObject({ status: "needs_attention" });
    const forbidden = harness(() => reply(403, {}));
    expect(await forbidden.provider.health(CREDS)).toMatchObject({ status: "needs_attention" });
    const odd = harness(() => reply(404, {}));
    expect(await odd.provider.health(CREDS)).toMatchObject({ status: "error" });
    // Silence, a server error and a limit say nothing about the key: they are thrown for the caller to treat as 'could not check'.
    for (const status of [429, 500, 503]) await rejects(harness(() => reply(status, {})).provider.health(CREDS));
    await rejects(harness(() => { throw new ProviderHttpError("timeout", "x"); }).provider.health(CREDS));
  });

  it("maps a document's status to a fact, and an unknown status to nothing", async () => {
    for (const [status, fact] of [["document.sent", "sent"], ["document.viewed", "viewed"], ["document.completed", "completed"], ["document.declined", "declined"], ["document.expired", "expired"], ["document.voided", "voided"], ["document.draft", "draft"], ["document.paid", null], ["???", null]] as const) {
      const h = harness(() => reply(200, { id: DOC_ID, status }));
      expect((await h.provider.getStatus(CREDS, DOC_ID)).fact, status).toBe(fact);
    }
  });

  it("refuses a document id that is not the usual shape without making any call", async () => {
    const h = harness(() => reply(200, {}));
    for (const id of ["../x", "a b c d e f", "x", "", "abc/def/ghi"]) {
      await rejects(h.provider.getStatus(CREDS, id));
      await rejects(h.provider.downloadSigned(CREDS, id));
    }
    expect(h.calls).toHaveLength(0);
  });

  it("downloads the signed copy only if it is a PDF, and says so when it is not there yet", async () => {
    const good = harness(() => ({ status: 200, json: null, bytes: PDF, retryAfter: null }));
    const r = await good.provider.downloadSigned(CREDS, DOC_ID);
    expect(r.signedPdf.equals(PDF)).toBe(true);
    // The certificate is not fetched: its address was not remembered with confidence.
    expect(r.certificate).toBeNull();
    expect(good.calls[0]).toMatchObject({ method: "GET", path: `/public/v1/documents/${DOC_ID}/download`, accept: "pdf", sent: false });
    for (const bytes of [Buffer.alloc(0), Buffer.from("%PDF"), Buffer.from("<html>not ready</html>"), Buffer.from("{\"detail\":\"x\"}")]) {
      const h = harness(() => ({ status: 200, json: null, bytes, retryAfter: null }));
      expect((await rejects(h.provider.downloadSigned(CREDS, DOC_ID))).kind).toBe("transient");
    }
    await rejects(harness(() => reply(404, {})).provider.downloadSigned(CREDS, DOC_ID));
  });

  it("cannot withdraw a document, and says so as a block instead of guessing at a call that might delete it", async () => {
    const h = harness(() => reply(200, {}));
    expect(h.provider.canCancel).toBe(false);
    expect((await rejects(h.provider.cancel(CREDS, DOC_ID))).kind).toBe("blocked");
    expect(h.calls).toHaveLength(0);
  });
});

describe("finding a document after an answer was lost", () => {
  const ASK = { requestId: REQUEST_ID, idempotencyKey: "k", name: INPUT.name };

  it("looks a document up by the id it was told, and says 'not found' for a 404", async () => {
    const found = harness(() => reply(200, { id: DOC_ID, status: "document.sent" }));
    expect(await found.provider.reconcile(CREDS, ASK, { documentId: DOC_ID })).toEqual({ found: true, documentId: DOC_ID, fact: "sent" });
    const gone = harness(() => reply(404, {}));
    expect(await gone.provider.reconcile(CREDS, ASK, { documentId: DOC_ID })).toEqual({ found: false });
    const unknownStatus = harness(() => reply(200, { id: DOC_ID, status: "document.paid" }));
    expect(await unknownStatus.provider.reconcile(CREDS, ASK, { documentId: DOC_ID })).toMatchObject({ found: true, fact: "draft" });
    await rejects(harness(() => reply(500, {})).provider.reconcile(CREDS, ASK, { documentId: DOC_ID }));
  });

  it("without an id, searches for the request's reference and accepts exactly one document that carries it", async () => {
    const h = harness(() => reply(200, { results: [
      { id: DOC_ID, name: INPUT.name, status: "document.draft" },
      { id: "AnotherDocumentId123456", name: "Proposal P-0001 (version 1) ref deadbeef", status: "document.sent" },
      { id: "../bad", name: INPUT.name, status: "document.sent" },
      { name: INPUT.name, status: "document.sent" },
    ] }));
    expect(await h.provider.reconcile(CREDS, ASK, {})).toEqual({ found: true, documentId: DOC_ID, fact: "draft" });
    expect(h.calls[0]).toMatchObject({ method: "GET", path: "/public/v1/documents", query: { q: "ref 0f3b1f6e", count: "10" }, sent: false });
  });

  it("says it cannot tell when two documents carry the reference, and 'not found' when none does", async () => {
    const two = harness(() => reply(200, { results: [{ id: DOC_ID, name: INPUT.name, status: "document.sent" }, { id: "AnotherDocumentId123456", name: INPUT.name, status: "document.draft" }] }));
    expect(await two.provider.reconcile(CREDS, ASK, {})).toEqual({ found: false, uncertain: true });
    for (const body of [{ results: [] }, { results: [{ id: DOC_ID, name: "other", status: "document.sent" }] }, {}, null, { results: "x" }]) {
      const none = harness(() => reply(200, body));
      expect(await none.provider.reconcile(CREDS, ASK, {}), JSON.stringify(body)).toEqual({ found: false });
    }
  });
});

describe("a notice from the service", () => {
  const body = Buffer.from(JSON.stringify([{ event: "document_state_changed", data: { id: DOC_ID, status: "document.completed", date_modified: "2026-10-23T10:00:00Z" } }]));
  const sign = (raw: Buffer, key = CREDS.webhookKey) => createHmac("sha256", key).update(raw).digest("hex");
  const { provider } = harness(() => reply(200));
  const verify = (raw: Buffer, query: Record<string, string>, headers: Record<string, string> = {}) =>
    provider.verifyWebhook({ rawBody: raw, headers: new Headers(headers), query: new URLSearchParams(query) }, CREDS);

  it("is believed only when its signature, over the exact bytes, matches the connection's own shared key", () => {
    const ok = verify(body, { signature: sign(body) });
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.events).toEqual([expect.objectContaining({ documentId: DOC_ID, fact: "completed" })]);
    expect(verify(body, { signature: sign(body, "someone-elses-key") })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(Buffer.concat([body, Buffer.from("\n")]), { signature: sign(body) })).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(body, {})).toEqual({ ok: false, reason: "bad_signature" });
    expect(verify(body, { signature: "" })).toEqual({ ok: false, reason: "bad_signature" });
    // Only the address's signature counts: a header of the same name does not.
    expect(verify(body, {}, { signature: sign(body), "x-signature": sign(body) })).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("is malformed, and records nothing, when it is signed but is not what a notice looks like", () => {
    for (const raw of [Buffer.from("not json"), Buffer.from("[]"), Buffer.from(JSON.stringify([{ event: "x" }]))]) {
      expect(verify(raw, { signature: sign(raw) }), raw.toString()).toEqual({ ok: false, reason: "malformed" });
    }
  });
});

describe("the signature field the adapter places (its schema is a guess, and says so)", () => {
  it("is built from our own signature area and the signer's address, and from nothing the business typed", () => {
    const f = signatureFields({ page: 2, x: 72, yTop: 480, width: 200, height: 50 }, "m@example.test");
    expect(f).toEqual({ Signature: { type: "signature", assigned_to: { email: "m@example.test" }, layout: { page: 2, position: { x: 72, y: 480 }, size: { width: 200, height: 50 } } } });
  });
});

describe("the real HTTP layer, with the network replaced", () => {
  const withFetch = async (answer: (url: URL, init: RequestInit) => Response, run: (calls: Array<{ url: URL; init: RequestInit }>) => Promise<void>) => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (input: URL | string, init?: RequestInit) => {
      calls.push({ url: new URL(String(input)), init: init ?? {} });
      return answer(new URL(String(input)), init ?? {});
    });
    try {
      await run(calls);
    } finally {
      vi.unstubAllGlobals();
    }
  };
  const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

  it("calls only PandaDoc's address, with the key in a header and never in the address, and reads a JSON answer", async () => {
    await withFetch(() => new Response(JSON.stringify({ results: [] }), { status: 200, headers: { "content-type": "application/json", "retry-after": "5" } }), async (calls) => {
      const r = await pandaDocHttp({ method: "GET", path: "/public/v1/documents", query: { count: "1", q: "ref 0f3b1f6e" }, apiKey: CREDS.apiKey, sent: false });
      expect(r).toMatchObject({ status: 200, json: { results: [] }, retryAfter: "5" });
      expect(calls).toHaveLength(1);
      expect(calls[0].url.origin).toBe(PANDADOC_ORIGIN);
      expect(calls[0].url.pathname).toBe("/public/v1/documents");
      expect(calls[0].url.searchParams.get("q")).toBe("ref 0f3b1f6e");
      expect(calls[0].url.toString()).not.toContain(CREDS.apiKey);
      expect(headersOf(calls[0].init)).toMatchObject({ Authorization: `API-Key ${CREDS.apiKey}`, Accept: "application/json" });
      expect(calls[0].init).toMatchObject({ method: "GET", redirect: "manual" });
    });
  });

  it("uploads the PDF as bytes inside a multipart body, and a JSON call as JSON", async () => {
    await withFetch(() => new Response(JSON.stringify({ id: DOC_ID }), { status: 201, headers: { "content-type": "application/json" } }), async (calls) => {
      await pandaDocHttp({ method: "POST", path: "/public/v1/documents", apiKey: CREDS.apiKey, sent: true, multipart: [{ name: "file", value: PDF, filename: "p.pdf", contentType: "application/pdf" }, { name: "data", value: "{}" }] });
      const ct = headersOf(calls[0].init)["Content-Type"];
      expect(ct).toMatch(/^multipart\/form-data; boundary=iacquire-[0-9a-f]{24}$/);
      expect(Buffer.from(calls[0].init.body as Uint8Array).includes(PDF)).toBe(true);
      await pandaDocHttp({ method: "POST", path: `/public/v1/documents/${DOC_ID}/send`, apiKey: CREDS.apiKey, sent: true, json: { subject: "s", message: "m", silent: false } });
      expect(headersOf(calls[1].init)["Content-Type"]).toBe("application/json");
      expect(Buffer.from(calls[1].init.body as Uint8Array).toString("utf8")).toBe(JSON.stringify({ subject: "s", message: "m", silent: false }));
    });
  });

  it("returns a PDF answer's bytes unchanged and reads a JSON answer only when it says it is one", async () => {
    await withFetch(() => new Response(PDF, { status: 200, headers: { "content-type": "application/pdf" } }), async (calls) => {
      const r = await pandaDocHttp({ method: "GET", path: `/public/v1/documents/${DOC_ID}/download`, apiKey: CREDS.apiKey, accept: "pdf", sent: false });
      expect(r.bytes.equals(PDF)).toBe(true);
      expect(r.json).toBeNull();
      expect(headersOf(calls[0].init).Accept).toBe("application/pdf");
    });
    await withFetch(() => new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }), async () => {
      expect((await pandaDocHttp({ method: "GET", path: "/public/v1/documents", apiKey: CREDS.apiKey, sent: false })).json).toBeNull();
    });
  });

  it("through the whole adapter: a redirect is never followed and is an unknown outcome after a create", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: URL | string) => {
      calls.push(String(input));
      return { status: 302, headers: new Headers({ location: "https://evil.example.test/" }), body: null } as unknown as Response;
    });
    try {
      const provider = createPandaDocProvider({ writesEnabled: () => true });
      const e = await rejects(provider.createRequest(CREDS, INPUT, {}));
      expect(e.kind).toBe("unknown_outcome");
      expect(calls).toHaveLength(1);
      expect(calls[0].startsWith(PANDADOC_ORIGIN)).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
