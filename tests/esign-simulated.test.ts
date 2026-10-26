// The stand-in signing service itself. Everything else in the signing tests leans on it, so what it promises is checked here: creating a document is NOT repeatable (asking twice
// makes two, which is what the duplicate-protection tests count), a lost answer does the work first, a delivery is signed over its exact bytes with a stamp, and it says in the
// files it makes that they are not real. It signs nothing for anyone and sends nothing anywhere.
import { beforeEach, describe, expect, it } from "vitest";
import { pdfPageCount } from "@/lib/pdf/info";
import { SIM_SIGNATURE_HEADER, SIM_TIMESTAMP_HEADER, SIM_TOLERANCE_SECONDS, signedDelivery, simulatedEsign, simulatedProvider } from "@/server/esign/providers/simulated";
import { EsignProviderError, type CreateInput, type EsignCredentials } from "@/server/esign/providers/types";

const CREDS: EsignCredentials = { apiKey: "sim_key_1", webhookKey: "sim_webhook_key" };
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n", "latin1"), Buffer.from("body"), Buffer.from("\n%%EOF\n", "latin1")]);
const input = (n = 1): CreateInput => ({
  requestId: `0f3b1f6e-9a4b-4f55-a1c2-12345678900${n}`, idempotencyKey: `proposal:p:1:${n}`, name: `Proposal P-000${n} (version 1) ref 0f3b1f6e`, signer: { name: "Maria Santos", email: "maria@example.test" }, pdf: PDF,
  pdfFilename: "p.pdf", placement: { page: 1, x: 1, yTop: 1, width: 1, height: 1 }, emailSubject: "s", emailMessage: "m",
});

beforeEach(() => simulatedEsign.reset());

async function sendIt(over: CreateInput = input()) {
  let s = (await simulatedProvider.createRequest(CREDS, over, {})).state;
  s = (await simulatedProvider.createRequest(CREDS, over, s)).state;
  s = (await simulatedProvider.createRequest(CREDS, over, s)).state;
  return s;
}

describe("making and sending a document", () => {
  it("makes the document, reports it ready, then sends it: three steps, each of which says whether it could make something", async () => {
    expect(simulatedProvider.mayCreate({})).toBe(true);
    const a = await simulatedProvider.createRequest(CREDS, input(), {});
    expect(a.state).toEqual({ documentId: "simdoc_1" });
    expect(simulatedProvider.mayCreate(a.state)).toBe(false);
    const b = await simulatedProvider.createRequest(CREDS, input(), a.state);
    expect(b.state).toEqual({ documentId: "simdoc_1", ready: true });
    expect(simulatedProvider.mayCreate(b.state)).toBe(true);
    const c = await simulatedProvider.createRequest(CREDS, input(), b.state);
    expect(c.state).toEqual({ documentId: "simdoc_1", ready: true, sent: true });
    expect(simulatedProvider.mayCreate(c.state)).toBe(false);
    expect(simulatedEsign.document("simdoc_1")).toMatchObject({ status: "sent", signerName: "Maria Santos", signerEmail: "maria@example.test", idempotencyKey: "proposal:p:1:1" });
    // Once sent, asking again does nothing.
    expect((await simulatedProvider.createRequest(CREDS, input(), c.state)).state).toEqual(c.state);
    expect(simulatedEsign.calls("send")).toBe(1);
  });

  it("makes a second document when asked a second time with nothing remembered: that is the mistake the worker's saved state exists to prevent", async () => {
    await simulatedProvider.createRequest(CREDS, input(), {});
    await simulatedProvider.createRequest(CREDS, input(), {});
    expect(simulatedEsign.documents().map((d) => d.id)).toEqual(["simdoc_1", "simdoc_2"]);
  });

  it("answers 'not ready yet' as many times as it is told to", async () => {
    simulatedEsign.holdReady(2);
    const s = (await simulatedProvider.createRequest(CREDS, input(), {})).state;
    for (let n = 0; n < 2; n += 1) {
      const r = await simulatedProvider.createRequest(CREDS, input(), s);
      expect(r).toEqual({ state: s, waitSeconds: 2 });
    }
    expect((await simulatedProvider.createRequest(CREDS, input(), s)).state).toEqual({ documentId: "simdoc_1", ready: true });
  });

  it("refuses once, when told to, before doing the work; and when told to go quiet it does the work and then never answers", async () => {
    const boom = new EsignProviderError("transient", "down");
    simulatedEsign.failNext("create", boom);
    await expect(simulatedProvider.createRequest(CREDS, input(), {})).rejects.toBe(boom);
    expect(simulatedEsign.documents()).toEqual([]);
    expect((await simulatedProvider.createRequest(CREDS, input(), {})).state.documentId).toBe("simdoc_1");
    simulatedEsign.loseResponseNext("create");
    await expect(simulatedProvider.createRequest(CREDS, input(2), {})).rejects.toMatchObject({ kind: "unknown_outcome" });
    expect(simulatedEsign.documents()).toHaveLength(2);
    simulatedEsign.loseResponseNext("send");
    const s = (await simulatedProvider.createRequest(CREDS, input(), { documentId: "simdoc_1" })).state;
    await expect(simulatedProvider.createRequest(CREDS, input(), s)).rejects.toMatchObject({ kind: "unknown_outcome" });
    expect(simulatedEsign.document("simdoc_1")?.status).toBe("sent");
  });

  it("refuses a key it was told no longer works, on every step", async () => {
    simulatedEsign.revoke(CREDS.apiKey);
    const refused = { kind: "auth", needsAttention: true };
    await expect(simulatedProvider.createRequest(CREDS, input(), {})).rejects.toMatchObject(refused);
    await expect(simulatedProvider.getStatus(CREDS, "simdoc_1")).rejects.toMatchObject(refused);
    await expect(simulatedProvider.downloadSigned(CREDS, "simdoc_1")).rejects.toMatchObject(refused);
    await expect(simulatedProvider.cancel(CREDS, "simdoc_1")).rejects.toMatchObject(refused);
    await expect(simulatedProvider.reconcile(CREDS, input(), {})).rejects.toMatchObject(refused);
    expect(await simulatedProvider.health(CREDS)).toMatchObject({ status: "needs_attention" });
    expect(await simulatedProvider.health({ ...CREDS, apiKey: "another" })).toMatchObject({ status: "connected", accountLabel: "Simulated signing service" });
  });
});

describe("finding, reading and withdrawing", () => {
  it("finds a document by the id it was told, or by the reference in its name, and says when two fit", async () => {
    await sendIt();
    expect(await simulatedProvider.reconcile(CREDS, input(), { documentId: "simdoc_1" })).toEqual({ found: true, documentId: "simdoc_1", fact: "sent" });
    expect(await simulatedProvider.reconcile(CREDS, input(), { documentId: "simdoc_99" })).toEqual({ found: false });
    expect(await simulatedProvider.reconcile(CREDS, input(), {})).toEqual({ found: true, documentId: "simdoc_1", fact: "sent" });
    expect(await simulatedProvider.reconcile(CREDS, { ...input(), name: "Proposal unknown ref deadbeef", idempotencyKey: "other" }, {})).toEqual({ found: false });
    await simulatedProvider.createRequest(CREDS, input(), {});
    expect(await simulatedProvider.reconcile(CREDS, input(), {})).toEqual({ found: false, uncertain: true });
  });

  it("reports what the signer did, and hands over a signed copy only for a document that was signed", async () => {
    await sendIt();
    await expect(simulatedProvider.downloadSigned(CREDS, "simdoc_1")).rejects.toMatchObject({ kind: "invalid_content", httpStatus: 409 });
    for (const [action, fact] of [["view", "viewed"], ["decline", "declined"], ["expire", "expired"], ["void", "voided"], ["complete", "completed"]] as const) {
      simulatedEsign.signerAction("simdoc_1", action);
      expect((await simulatedProvider.getStatus(CREDS, "simdoc_1")).fact).toBe(fact);
    }
    const copies = await simulatedProvider.downloadSigned(CREDS, "simdoc_1");
    expect(copies.signedPdf.subarray(0, PDF.length).equals(PDF)).toBe(true);
    expect(copies.signedPdf.toString("latin1")).toContain("% SIMULATED SIGNATURE: not a real signature (simdoc_1)");
    expect(copies.certificate?.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(pdfPageCount(copies.certificate as Buffer)).toBe(1);
    expect(copies.certificate?.toString("latin1")).toContain("not a real signature and is not legally binding");
    await expect(simulatedProvider.getStatus(CREDS, "simdoc_77")).rejects.toMatchObject({ httpStatus: 404 });
    expect(() => simulatedEsign.signerAction("simdoc_77", "complete")).toThrow(/No such simulated document/);
  });

  it("withdraws a document that is still out, and leaves one that is finished as it is", async () => {
    await sendIt();
    await simulatedProvider.cancel(CREDS, "simdoc_1");
    expect(simulatedEsign.document("simdoc_1")?.status).toBe("voided");
    await sendIt(input(2));
    simulatedEsign.signerAction("simdoc_2", "complete");
    await simulatedProvider.cancel(CREDS, "simdoc_2");
    expect(simulatedEsign.document("simdoc_2")?.status).toBe("completed");
    await simulatedProvider.cancel(CREDS, "simdoc_404");
  });

  it("forgets everything when reset, so one test cannot see another's documents", () => {
    simulatedEsign.reset();
    expect(simulatedEsign.documents()).toEqual([]);
    expect(simulatedEsign.calls()).toBe(0);
  });
});

describe("a delivery", () => {
  const good = () => {
    simulatedEsign.reset();
    return sendIt().then(() => simulatedEsign.delivery("simdoc_1", CREDS.webhookKey));
  };
  const verify = (d: { rawBody: Buffer; headers: Headers; query: URLSearchParams }, key = CREDS.webhookKey) => simulatedProvider.verifyWebhook(d, { ...CREDS, webhookKey: key });

  it("is signed over a stamp and its exact bytes, and read back as one event with a stable id", async () => {
    const d = await good();
    expect(d.headers.get(SIM_SIGNATURE_HEADER)).toMatch(/^[0-9a-f]{64}$/);
    expect(d.headers.get(SIM_TIMESTAMP_HEADER)).toMatch(/^\d{10}$/);
    const v = verify(d);
    expect(v).toEqual({ ok: true, events: [{ name: "status", documentId: "simdoc_1", status: "sent", fact: "sent", eventId: "sim:simev-simdoc_1-sent" }] });
    expect(simulatedEsign.delivery("simdoc_1", CREDS.webhookKey, { eventId: "custom" }).rawBody.toString()).toContain('"id":"custom"');
  });

  it("is refused when the key, the body or the stamp is wrong, or when it is too old", async () => {
    const d = await good();
    const bad = { ok: false, reason: "bad_signature" };
    expect(verify(d, "another-key")).toEqual(bad);
    expect(verify({ ...d, rawBody: Buffer.from(d.rawBody.toString().replace("sent", "completed")) })).toEqual(bad);
    expect(verify(signedDelivery(d.rawBody, CREDS.webhookKey, new Date(Date.now() - (SIM_TOLERANCE_SECONDS + 5) * 1000)))).toEqual(bad);
    expect(verify(signedDelivery(d.rawBody, CREDS.webhookKey, new Date(Date.now() + (SIM_TOLERANCE_SECONDS + 5) * 1000)))).toEqual(bad);
    expect(verify({ ...d, headers: new Headers() })).toEqual(bad);
    expect(verify(d, "")).toEqual(bad);
  });

  it("is malformed, not merely unsigned, when it is signed but is not a notice", async () => {
    for (const raw of ["not json", JSON.stringify({ id: 1, documentId: "x", status: "sent" }), JSON.stringify({ id: "a", documentId: "../x", status: "sent" }), JSON.stringify({ id: "a", documentId: "simdoc_1" })]) {
      expect(verify(signedDelivery(Buffer.from(raw), CREDS.webhookKey, new Date())), raw).toEqual({ ok: false, reason: "malformed" });
    }
  });

  it("says nothing about the signature for a status it does not know", async () => {
    const raw = Buffer.from(JSON.stringify({ id: "a", documentId: "simdoc_1", status: "levitating" }));
    expect(verify(signedDelivery(raw, CREDS.webhookKey, new Date()))).toMatchObject({ ok: true, events: [{ fact: null }] });
  });
});
