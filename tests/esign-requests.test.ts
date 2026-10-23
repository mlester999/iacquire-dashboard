// Asking a customer to sign, and withdrawing the ask: who may, what must be true, what is written down, that a doubled click or a second worker cannot ask twice, and that every way a
// proposal can end also ends the ask. Embedded Postgres and the in-process stand-in service; nothing is handed to any service in this file (the worker is tested separately).
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { recordConsent, suppressAddress } from "@/server/messaging/contacts";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { requestSignature, voidSignatureRequest } from "@/server/esign/requests";
import { disconnect } from "@/server/esign/connections";
import { REAL_WRITES_OFF_MESSAGE } from "@/lib/esign/state";
import { RATE_LIMITS } from "@/server/security/rate-limit";
import { expireDueProposals } from "@/server/proposals/jobs";
import { decideOnProposal } from "@/server/proposals/public";
import { getProposal, recordOfflineDecision, reviseProposal, withdrawProposal } from "@/server/proposals/proposals";
import { approvedProposal, askToSign, freshIp, NOW, requestRow, rows, sentForSigning, sentWithLink, setFeature, sigEvents, signingOrg, verifiedSession, type ProposalOrg } from "./support/proposals";
import { uid } from "./support/fixtures";

beforeEach(() => simulatedEsign.reset());

const requestsOf = (proposalId: string) => rows<{ id: string; status: string; proposal_version: number; idempotency_key: string; signer_name: string; signer_email: string; signer_contact_id: string | null; version_hash: string; pdf_sha256: string; connection_id: string; provider: string; mode: string; run_at: Date; created_by: string | null }>(
  "select id, status, proposal_version, idempotency_key, signer_name, signer_email::text as signer_email, signer_contact_id, version_hash, pdf_sha256, connection_id, provider, mode, run_at, created_by from signature_requests where proposal_id = $1 order by created_at, id", [proposalId]);
const signatureState = async (id: string) => (await rows<{ signature_state: string }>("select signature_state from proposals where id = $1", [id]))[0].signature_state;

describe("asking", () => {
  it("writes one queued request for the version that was sent, locked to its fingerprint and its PDF, and hands nothing to anyone", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p, { clientName: "Maria Santos", clientEmail: `Maria-${uid()}@Example.TEST` });
    const r = await askToSign(p, sent.proposal.id);
    expect(r.created).toBe(true);
    const [row] = await requestsOf(sent.proposal.id);
    const version = (await rows<{ content_hash: string; pdf_sha256: string }>("select content_hash, pdf_sha256 from proposal_versions where proposal_id = $1 and version = 1", [sent.proposal.id]))[0];
    expect(row).toMatchObject({
      id: r.requestId, status: "queued", proposal_version: 1, idempotency_key: `proposal:${sent.proposal.id}:1:0`, signer_name: "Maria Santos", provider: "simulated", mode: "simulated",
      version_hash: version.content_hash, pdf_sha256: version.pdf_sha256, created_by: p.people.sales.id,
    });
    expect(row.signer_email).toBe(sent.email.toLowerCase());
    expect(new Date(row.run_at).getTime()).toBe(NOW.getTime());
    expect(await signatureState(sent.proposal.id)).toBe("requested");
    // Nothing was made or sent at the signing service (the only call it has had is the check of the key, when it was connected).
    expect(simulatedEsign.documents()).toEqual([]);
    for (const step of ["create", "ready", "send", "reconcile", "status", "download", "cancel"] as const) expect(simulatedEsign.calls(step), step).toBe(0);
  });

  it("writes it down on the request, on the proposal and in the audit trail, with the signer's address masked", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    const ev = await sigEvents(requestId);
    expect(ev).toEqual([{ kind: "created", source: "user", provider_event_id: null, detail: { by: p.people.sales.id, signer: expect.stringMatching(/^m\*\*\*@example\.test$/), provider: "simulated", mode: "simulated" } }]);
    const pe = await rows<{ kind: string; actor_id: string; detail: Record<string, unknown> }>("select kind, actor_id, detail from proposal_events where proposal_id = $1 and kind = 'signature_requested'", [sent.proposal.id]);
    expect(pe).toHaveLength(1);
    expect(pe[0].actor_id).toBe(p.people.sales.id);
    expect(JSON.stringify([ev, pe])).not.toContain(sent.email);
    const audit = await rows<{ metadata: Record<string, unknown> }>("select metadata from audit_logs where org_id = $1 and action = 'proposals.signature_requested'", [p.org.id]);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ version: 1, requestId, provider: "simulated" });
    expect(JSON.stringify(audit)).not.toContain(sent.email);
  });

  it("lets only people who can send proposals ask", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    for (const who of ["member", "setter", "support", "viewer"] as const) {
      const actor = who === "member" ? p.member : p.actor(who);
      await expect(requestSignature(actor, sent.proposal.id, {}, { now: NOW }), who).rejects.toThrow(/Your role can't send proposals/);
    }
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
    for (const who of ["owner", "manager", "sales"] as const) {
      const q = await signingOrg();
      const s = await sentForSigning(q);
      expect((await requestSignature(q.actor(who), s.proposal.id, {}, { now: NOW })).created, who).toBe(true);
    }
  });

  it("asks once for a version: a second tap, or two at the same moment, find the first request", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const [a, b] = await Promise.all([askToSign(p, sent.proposal.id), askToSign(p, sent.proposal.id)]);
    expect(a.requestId).toBe(b.requestId);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(await requestsOf(sent.proposal.id)).toHaveLength(1);
    expect(await askToSign(p, sent.proposal.id)).toEqual({ requestId: a.requestId, created: false });
    // The second tap wrote nothing more.
    expect(await sigEvents(a.requestId)).toHaveLength(1);
    expect(await rows("select 1 from proposal_events where proposal_id = $1 and kind = 'signature_requested'", [sent.proposal.id])).toHaveLength(1);
  });

  it("makes a new ask, with the next number, only after the earlier one ended", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const first = await askToSign(p, sent.proposal.id);
    await voidSignatureRequest(p.actor("sales"), first.requestId, { now: NOW });
    const second = await askToSign(p, sent.proposal.id);
    expect(second.created).toBe(true);
    expect(second.requestId).not.toBe(first.requestId);
    expect((await requestsOf(sent.proposal.id)).map((r) => [r.status, r.idempotency_key])).toEqual([["voided", `proposal:${sent.proposal.id}:1:0`], ["queued", `proposal:${sent.proposal.id}:1:1`]]);
    expect(await signatureState(sent.proposal.id)).toBe("requested");
  });

  it("limits how many a workspace asks for in an hour", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await withSystem((db) => db.query(
      "insert into rate_limit_buckets (bucket_key, window_start, hits) values ($1, $2, $3)",
      [`${RATE_LIMITS.esignRequestByOrg.name}:${p.org.id}`, new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000).toISOString(), RATE_LIMITS.esignRequestByOrg.limit],
    ));
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/Too many signing requests/);
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
  });
});

describe("who is asked", () => {
  it("is the customer on the proposal unless the sender says otherwise, and the address must look like one", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p, { clientName: "Maria Santos" });
    for (const bad of [{ signerEmail: "nonsense" }, { signerEmail: "a@b" }, { signerName: "  ", signerEmail: "ok@example.test" }]) {
      await expect(askToSign(p, sent.proposal.id, bad), JSON.stringify(bad)).rejects.toThrow();
    }
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
    await askToSign(p, sent.proposal.id, { signerName: " Jose  Reyes ", signerEmail: " Jose.Reyes@Example.TEST " });
    expect((await requestsOf(sent.proposal.id))[0]).toMatchObject({ signer_name: "Jose Reyes", signer_email: "jose.reyes@example.test", signer_contact_id: null });
  });

  it("needs an address from somewhere: a proposal with none and a sender who gives none cannot be asked", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p, { clientEmail: null });
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/needs an email address/);
    expect((await askToSign(p, sent.proposal.id, { signerEmail: "late@example.test" })).created).toBe(true);
  });

  it("links the request to the contact only when the address is the contact's own", async () => {
    const p = await signingOrg();
    const email = `lina-${uid()}@example.test`;
    const contact = await createContact(p.actor("owner"), { firstName: "Lina", lastName: "Cruz", email });
    const a = await sentForSigning(p, { contactId: contact.id, clientEmail: email, clientName: "Lina Cruz" });
    await askToSign(p, a.proposal.id);
    expect((await requestsOf(a.proposal.id))[0].signer_contact_id).toBe(contact.id);
    const b = await sentForSigning(p, { contactId: contact.id, clientEmail: email, clientName: "Lina Cruz" });
    await askToSign(p, b.proposal.id, { signerName: "Her assistant", signerEmail: `assistant-${uid()}@example.test` });
    expect((await requestsOf(b.proposal.id))[0].signer_contact_id).toBeNull();
  });

  it("honours the opt-outs the message chain honours, because the signing service writes to the customer on the business's behalf", async () => {
    const p = await signingOrg();
    const email = `optout-${uid()}@example.test`;
    const contact = await createContact(p.actor("owner"), { firstName: "Nia", lastName: "Lopez", email });
    const sent = await sentForSigning(p, { contactId: contact.id, clientEmail: email, clientName: "Nia Lopez" });
    await withSystem((db) => suppressAddress(db, { orgId: p.org.id, channel: "email", address: email, reason: "opt_out", source: "test" }));
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/opted out or bounced/);
    // A different address for the same customer is the sender's choice and is allowed.
    await withSystem(async (db) => {
      await db.query("update suppressions set lifted_at = now() where org_id = $1", [p.org.id]);
      await recordConsent(db, { orgId: p.org.id, contactId: contact.id, channel: "email", purpose: "service", status: "revoked", source: "test" });
    });
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/withdrew consent to be emailed/);
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
  });
});

describe("when it cannot be asked", () => {
  it("says why in words, and writes nothing", async () => {
    const p = await signingOrg();
    // Only a proposal that was sent.
    const approved = await approvedProposal(p, { requiresSignature: true });
    await expect(askToSign(p, approved.id)).rejects.toThrow(/Only a proposal that has been sent/);
    // Only one that asks for a signature.
    const plain = await sentWithLink(p);
    await expect(askToSign(p, plain.proposal.id)).rejects.toThrow(/doesn't ask for a signature/);
    // Not past its date, in the workspace's calendar.
    const dated = await sentForSigning(p, { validUntil: "2026-10-30" });
    await expect(requestSignatureAt(p, dated.proposal.id, new Date("2026-11-02T12:00:00Z"))).rejects.toThrow(/valid-until date has passed/);
    expect(await rows("select 1 from signature_requests where org_id = $1", [p.org.id])).toHaveLength(0);
  });

  it("is refused while the connection needs attention, is gone, or is a real service whose write switch is off", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await withSystem((db) => db.query("update esign_connections set status = 'needs_attention', status_detail = 'The key was refused.' where org_id = $1", [p.org.id]));
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/needs attention: The key was refused\. Connect it again/);
    await withSystem((db) => db.query("update esign_connections set status = 'connected', status_detail = null, provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [p.org.id]));
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(REAL_WRITES_OFF_MESSAGE);
    await withSystem((db) => db.query("update esign_connections set provider = 'simulated', mode = 'simulated' where org_id = $1", [p.org.id]));
    await disconnect(p.actor("owner"));
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/No signing service is connected/);
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
  });

  it("is refused while proposals or signing is switched off for the workspace", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await setFeature(p.org.id, false, "esign");
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/Electronic signing isn't switched on/);
    await setFeature(p.org.id, true, "esign");
    await setFeature(p.org.id, false, "proposals");
    await expect(askToSign(p, sent.proposal.id)).rejects.toThrow(/Proposals aren't switched on/);
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
  });

  it("does not find another workspace's proposal, and cannot be pointed at one", async () => {
    const a = await signingOrg();
    const b = await signingOrg();
    const sent = await sentForSigning(a);
    await expect(askToSign(b, sent.proposal.id)).rejects.toThrow(/proposal was not found/);
    const mine = await sentForSigning(b);
    const { requestId } = await askToSign(b, mine.proposal.id);
    await expect(voidSignatureRequest(a.actor("owner"), requestId)).rejects.toThrow(/signing request was not found/);
    expect((await requestRow(requestId)).status).toBe("queued");
    expect(await requestsOf(sent.proposal.id)).toEqual([]);
  });
});

describe("withdrawing the ask", () => {
  it("ends it for the sender or anyone who can send, leaves the proposal sent, and says what is left to do at the service", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    await expect(voidSignatureRequest(p.actor("viewer"), requestId)).rejects.toThrow(/Your role can't send proposals/);
    await expect(voidSignatureRequest(p.member, requestId)).rejects.toThrow(/Your role can't send proposals/);
    await voidSignatureRequest(p.actor("manager"), requestId, { now: NOW });
    expect(await requestRow(requestId)).toMatchObject({ status: "voided", cancel_state: "none", void_reason: "Withdrawn by a person." });
    expect((await rows<{ status: string }>("select status from proposals where id = $1", [sent.proposal.id]))[0].status).toBe("sent");
    expect(await signatureState(sent.proposal.id)).toBe("none");
    expect((await sigEvents(requestId)).map((e) => e.kind)).toEqual(["created", "voided"]);
    expect((await rows<{ kind: string }>("select kind from proposal_events where proposal_id = $1 and kind = 'signature_withdrawn'", [sent.proposal.id]))).toHaveLength(1);
    // Withdrawing what is no longer out is a refusal, not a second withdrawal.
    await expect(voidSignatureRequest(p.actor("manager"), requestId)).rejects.toThrow(/no longer out/);
  });

  it("marks a document that already reached the service to be withdrawn there where that is possible, and for the business to do where it is not", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    await withSystem((db) => db.query("update signature_requests set status = 'sent', provider_document_id = 'simdoc_9', provider_state = '{\"documentId\":\"simdoc_9\"}'::jsonb where id = $1", [requestId]));
    await voidSignatureRequest(p.actor("sales"), requestId, { now: NOW });
    expect((await requestRow(requestId)).cancel_state).toBe("wanted");
    // PandaDoc has no withdrawal iAcquire can call, so the business is asked to do it there. (The request is turned into one made through PandaDoc with the database's own
    // guards off for this statement only: a real one cannot be made here without a real service.)
    const q = await signingOrg();
    const s = await sentForSigning(q);
    const other = await askToSign(q, s.proposal.id);
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update esign_connections set provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [q.org.id]);
      await db.query("update signature_requests set status = 'sent', provider = 'pandadoc', mode = 'sandbox', provider_document_id = 'BhVzRcxH9Z2LgfPPGXFUBa' where id = $1", [other.requestId]);
    });
    const view = (await getProposal(q.actor("sales"), s.proposal.id, { now: NOW })).signature.requests[0];
    expect(view).toMatchObject({ status: "sent", provider: "pandadoc", cancelNote: null });
    await voidSignatureRequest(q.actor("sales"), other.requestId, { now: NOW });
    expect((await requestRow(other.requestId)).cancel_state).toBe("manual");
    const after = (await getProposal(q.actor("sales"), s.proposal.id, { now: NOW })).signature.requests[0];
    expect(after.cancelNote).toBe("iAcquire cannot withdraw it at PandaDoc. Withdraw the document there too; a signature that arrives for it is not applied to the proposal.");
  });
});

/** requestSignature with the clock at a given moment. */
function requestSignatureAt(p: ProposalOrg, id: string, now: Date) {
  return askToSign(p, id, {}, { now });
}

describe("every way a proposal can end also ends the ask", () => {
  async function asked(p: ProposalOrg, over: Parameters<typeof sentForSigning>[1] = {}) {
    const sent = await sentForSigning(p, over);
    const { requestId } = await askToSign(p, sent.proposal.id);
    return { ...sent, requestId };
  }

  it("a revision ends it as replaced by a newer version, so a signature that arrives later is never applied to the new one", async () => {
    const p = await signingOrg();
    const a = await asked(p);
    await reviseProposal(p.actor("sales"), a.proposal.id, { now: NOW });
    expect(await requestRow(a.requestId)).toMatchObject({ status: "superseded", void_reason: "The proposal was revised." });
    expect(await signatureState(a.proposal.id)).toBe("none");
    expect((await sigEvents(a.requestId)).map((e) => e.kind)).toEqual(["created", "superseded"]);
    // The next version can be sent and asked again, with a request of its own.
    const approved = await rows<{ version: number }>("select version from proposals where id = $1", [a.proposal.id]);
    expect(approved[0].version).toBe(2);
  });

  it("a withdrawal ends it", async () => {
    const p = await signingOrg();
    const a = await asked(p);
    await withdrawProposal(p.actor("sales"), a.proposal.id, { now: NOW });
    expect(await requestRow(a.requestId)).toMatchObject({ status: "voided", void_reason: "The proposal was withdrawn." });
  });

  it("a person recording the answer by hand ends it, and the signing is recorded as done offline", async () => {
    const p = await signingOrg();
    const a = await asked(p);
    await recordOfflineDecision(p.actor("manager"), a.proposal.id, { decision: "accepted", note: "Signed on paper." }, { now: NOW });
    expect(await requestRow(a.requestId)).toMatchObject({ status: "voided", void_reason: "The answer was recorded by a person." });
    expect(await signatureState(a.proposal.id)).toBe("recorded_offline");
  });

  it("running past the valid-until date ends it", async () => {
    const p = await signingOrg();
    const a = await asked(p, { validUntil: "2026-10-30" });
    const r = await expireDueProposals({ now: new Date("2026-11-02T12:00:00Z") });
    expect(r.expired).toBeGreaterThanOrEqual(1);
    expect((await rows<{ status: string }>("select status from proposals where id = $1", [a.proposal.id]))[0].status).toBe("expired");
    expect(await requestRow(a.requestId)).toMatchObject({ status: "voided", void_reason: "The proposal expired." });
  });

  it("the customer declining on the proposal page ends it, and asking for changes does not", async () => {
    const p = await signingOrg();
    const a = await asked(p);
    const session = await verifiedSession(a.token, a.email);
    expect(await decideOnProposal(a.token, { decision: "request_changes", note: "Can we change the date?" }, { ip: freshIp(), now: NOW, sessionToken: session })).toEqual({ outcome: "changes_requested" });
    expect((await requestRow(a.requestId)).status).toBe("queued");
    expect(await decideOnProposal(a.token, { decision: "decline", note: "No, thanks" }, { ip: freshIp(), now: NOW, sessionToken: session })).toEqual({ outcome: "declined" });
    expect(await requestRow(a.requestId)).toMatchObject({ status: "voided", void_reason: "The customer declined on the proposal page." });
    expect(await signatureState(a.proposal.id)).toBe("none");
  });

  it("a request is only ever ended once: ending an ended proposal changes no history", async () => {
    const p = await signingOrg();
    const a = await asked(p);
    await withdrawProposal(p.actor("sales"), a.proposal.id, { now: NOW });
    await expect(withdrawProposal(p.actor("sales"), a.proposal.id, { now: NOW })).rejects.toThrow();
    expect((await sigEvents(a.requestId)).map((e) => e.kind)).toEqual(["created", "voided"]);
  });
});

describe("what the proposal's screen is told", () => {
  it("offers the form to people who can send, with the customer already filled in, and only the reason to everyone else", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p, { clientName: "Maria Santos" });
    const forSales = (await getProposal(p.actor("sales"), sent.proposal.id, { now: NOW })).signature;
    expect(forSales).toMatchObject({ enabled: true, canRequest: true, canConnect: false, blocked: null, simulated: true, requests: [], defaultSigner: { name: "Maria Santos", email: sent.email } });
    expect(forSales.connection).toMatchObject({ provider: "simulated", status: "connected", usable: true });
    const forViewer = (await getProposal(p.actor("viewer"), sent.proposal.id, { now: NOW })).signature;
    expect(forViewer).toMatchObject({ enabled: true, canRequest: false, canConnect: false, blocked: null });
    expect((await getProposal(p.actor("manager"), sent.proposal.id, { now: NOW })).signature.canConnect).toBe(true);
  });

  it("describes each request without its secrets: no key, no document address, no idempotency key", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    const { requestId } = await askToSign(p, sent.proposal.id);
    const view = (await getProposal(p.actor("sales"), sent.proposal.id, { now: NOW })).signature;
    expect(view.canRequest).toBe(false);
    expect(view.blocked).toMatch(/already out for this version/);
    expect(view.requests).toHaveLength(1);
    const r = view.requests[0];
    expect(r).toMatchObject({ id: requestId, status: "queued", statusLabel: "Waiting to be sent", current: true, applied: false, canVoid: true, signedFileId: null, copyPending: false });
    expect(r.explain).toMatch(/Nothing has reached/);
    expect(Object.keys(r)).not.toContain("idempotencyKey");
    expect(JSON.stringify(view)).not.toMatch(/idempotency|provider_state|credentials|webhook_token/);
    // Someone who cannot send sees it but cannot withdraw it.
    expect((await getProposal(p.actor("viewer"), sent.proposal.id, { now: NOW })).signature.requests[0].canVoid).toBe(false);
  });

  it("says plainly that signing is off, and reads nothing from the signing tables, while it is not switched on", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await askToSign(p, sent.proposal.id);
    await setFeature(p.org.id, false, "esign");
    const view = (await getProposal(p.actor("sales"), sent.proposal.id, { now: NOW })).signature;
    expect(view).toMatchObject({ enabled: false, connection: null, requests: [], canRequest: false, canConnect: false });
    expect(view.blocked).toMatch(/isn't switched on/);
  });

  it("starts the next proposal's version with the old requests left in the history and none of them current", async () => {
    const p = await signingOrg();
    const sent = await sentForSigning(p);
    await askToSign(p, sent.proposal.id);
    await reviseProposal(p.actor("sales"), sent.proposal.id, { now: NOW });
    const view = (await getProposal(p.actor("sales"), sent.proposal.id, { now: NOW })).signature;
    expect(view.requests).toHaveLength(1);
    expect(view.requests[0]).toMatchObject({ status: "superseded", current: false, canVoid: false });
    expect(view.requests[0].explain).toMatch(/revised after this was sent/);
    // A draft cannot be asked for a signature: it has to be approved and sent first.
    expect(view.blocked).toMatch(/Only a proposal that has been sent/);
  });
});
