// Handing a request to the signing service, durably: the lease, the steps saved as they are taken, the intent written before anything that could make a document, the lost answer
// that is checked and never sent again on a guess, a worker that dies, and every reason a request waits. Embedded Postgres and the in-process stand-in service (and, once, the
// PandaDoc adapter on a replaced HTTP layer). The clock is passed in; nothing here waits.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { pdfPageCount } from "@/lib/pdf/info";
import { SIGNATURE_BOX } from "@/lib/proposals/pdf";
import { loadRequest } from "@/server/esign/core";
import { createPandaDocProvider } from "@/server/esign/providers/pandadoc";
import { simulatedEsign, simulatedProvider } from "@/server/esign/providers/simulated";
import { EsignProviderError, type CreateInput, type EsignProvider } from "@/server/esign/providers/types";
import { LEASE_SECONDS, processDueRequests, RECONCILE_GRACE_MS, recoverExpiredLeases, runClaimedRequest, type WorkerDeps } from "@/server/esign/worker";
import { readVersionPdf } from "@/server/proposals/documents";
import { askToSign, connectionKeys, NOW, requestRow, rows, sentForSigning, setFeature, sigEvents, signingOrg, type ProposalOrg } from "./support/proposals";

beforeEach(() => simulatedEsign.reset());

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
/** One pass of the worker for one workspace, at a chosen moment. */
const pass = (p: ProposalOrg, seconds = 0, deps: WorkerDeps = {}) => processDueRequests({ orgId: p.org.id, now: () => at(seconds), jitter: () => 0, ...deps });

async function queued(p: ProposalOrg, over: Parameters<typeof sentForSigning>[1] = {}) {
  const sent = await sentForSigning(p, over);
  const { requestId } = await askToSign(p, sent.proposal.id);
  return { ...sent, requestId };
}
const fail = (kind: ConstructorParameters<typeof EsignProviderError>[0], message: string, opts: ConstructorParameters<typeof EsignProviderError>[2] = {}) => new EsignProviderError(kind, message, opts);
const statusOf = async (id: string) => (await requestRow(id)).status;

describe("handing a request over", () => {
  it("takes the steps in order and ends with the signer asked, one document at the service, built from the stored PDF", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    const r = await pass(p);
    expect(r).toMatchObject({ claimed: 1, sent: 1, failed: 0, requeued: 0, unknown: 0 });
    const row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "sent", provider_document_id: "simdoc_1", last_error: null, last_error_kind: null });
    // The marker that says "a step may have made something" is gone once there is a definite answer.
    expect(row.provider_state).toEqual({ documentId: "simdoc_1", ready: true, sent: true });
    expect((await rows<{ sent_at: Date | null; lease_until: Date | null; claimed_by: string | null }>("select sent_at, lease_until, claimed_by from signature_requests where id = $1", [q.requestId]))[0]).toEqual({ sent_at: NOW, lease_until: null, claimed_by: null });
    expect((await sigEvents(q.requestId)).map((e) => [e.kind, e.source])).toEqual([["created", "user"], ["sent", "system"]]);
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect([simulatedEsign.calls("create"), simulatedEsign.calls("ready"), simulatedEsign.calls("send")]).toEqual([1, 1, 1]);
    const doc = simulatedEsign.documents()[0];
    const sha = (await rows<{ pdf_sha256: string }>("select pdf_sha256 from signature_requests where id = $1", [q.requestId]))[0].pdf_sha256;
    expect(createHash("sha256").update(doc.pdf).digest("hex")).toBe(sha);
    expect(doc).toMatchObject({ signerName: "Maria Santos", signerEmail: q.email.toLowerCase(), status: "sent", idempotencyKey: `proposal:${q.proposal.id}:1:0` });
    expect(doc.name).toMatch(/^Proposal P-0001 \(version 1\) ref [0-9a-f]{8}$/);
    expect((await rows<{ signature_state: string }>("select signature_state from proposals where id = $1", [q.proposal.id]))[0].signature_state).toBe("requested");
  });

  it("gives the service only fixed words and our own signature area: no price, no discount, nothing the business typed in a free field", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    let seen: CreateInput | null = null;
    const spy: EsignProvider = { ...simulatedProvider, createRequest: async (c, input, s) => { seen ??= input; return simulatedProvider.createRequest(c, input, s); } };
    await pass(p, 0, { provider: () => spy });
    expect(seen).not.toBeNull();
    const input = seen as unknown as CreateInput;
    const stored = (await readVersionPdf(p.org.id, q.proposal.id, 1))!;
    const pages = pdfPageCount(stored.bytes)!;
    expect(input.pdf.equals(stored.bytes)).toBe(true);
    expect(input.placement).toEqual({ page: pages, x: SIGNATURE_BOX.x, yTop: SIGNATURE_BOX.yTop, width: SIGNATURE_BOX.width, height: SIGNATURE_BOX.height });
    expect(input.emailSubject).toBe(`${p.org.name} asks you to sign proposal P-0001`);
    expect(input.emailMessage).toContain("proposal P-0001 (version 1)");
    expect(`${input.emailSubject} ${input.emailMessage}`).not.toMatch(/[$€£]|USD|1,680|discount|%|total/i);
    expect(input.signer).toEqual({ name: "Maria Santos", email: q.email.toLowerCase() });
    expect(input.pdfFilename).toBe("Proposal-P-0001-v1.pdf");
  });

  it("does nothing the second time: a request that was handed over is never handed over again, by the same worker or another", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await pass(p);
    expect(await pass(p, 5)).toMatchObject({ claimed: 0 });
    expect(await pass(p, 3600)).toMatchObject({ claimed: 0 });
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect(await statusOf(q.requestId)).toBe("sent");
  });

  it("makes one document when several workers run at the same moment", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    const results = await Promise.all([1, 2, 3, 4].map((n) => pass(p, 0, { workerId: `w${n}` })));
    expect(results.reduce((n, r) => n + r.claimed, 0)).toBe(1);
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect(simulatedEsign.calls("create")).toBe(1);
    expect(simulatedEsign.calls("send")).toBe(1);
    expect(await statusOf(q.requestId)).toBe("sent");
  });

  it("waits while the service is still making the document, and carries on from where it was without making another", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.holdReady(2);
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, requeued: 1, sent: 0 });
    expect(await requestRow(q.requestId)).toMatchObject({ status: "queued", provider_document_id: "simdoc_1", attempt: 0 });
    expect(new Date((await requestRow(q.requestId)).run_at).getTime()).toBe(at(2).getTime());
    // Not due yet a second before.
    expect(await pass(p, 1)).toMatchObject({ claimed: 0 });
    expect(await pass(p, 2)).toMatchObject({ claimed: 1, requeued: 1 });
    expect(await pass(p, 4)).toMatchObject({ claimed: 1, sent: 1 });
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect(simulatedEsign.calls("create")).toBe(1);
    expect(simulatedEsign.calls("send")).toBe(1);
    expect(await statusOf(q.requestId)).toBe("sent");
    // Waiting for the service to be ready is not an attempt used.
    expect((await requestRow(q.requestId)).attempt).toBe(1);
  });
});

describe("when the service says no or has a problem", () => {
  it("tries a temporary problem again later with a growing wait, uses an attempt each time, and makes nothing in between", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.failNext("create", fail("transient", "PandaDoc had a temporary problem. It will try again."));
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, requeued: 1 });
    let row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "queued", attempt: 1, last_error_kind: "transient", provider_document_id: null });
    expect(row.provider_state).toEqual({});
    expect(new Date(row.run_at).getTime()).toBe(at(60).getTime());
    expect(await pass(p, 59)).toMatchObject({ claimed: 0 });
    simulatedEsign.failNext("create", fail("transient", "again"));
    expect(await pass(p, 60)).toMatchObject({ claimed: 1, requeued: 1 });
    row = await requestRow(q.requestId);
    expect(row.attempt).toBe(2);
    expect(new Date(row.run_at).getTime()).toBe(at(60 + 120).getTime());
    expect(simulatedEsign.documents()).toHaveLength(0);
    expect(await pass(p, 180)).toMatchObject({ claimed: 1, sent: 1 });
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect((await sigEvents(q.requestId)).filter((e) => e.kind === "retry_scheduled")).toHaveLength(2);
  });

  it("gives up after the attempts it is allowed, says so plainly to the people who can act, and lets the sender ask again", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    let t = 0;
    for (let n = 1; n <= 5; n += 1) {
      simulatedEsign.failNext("create", fail("transient", "PandaDoc had a temporary problem. It will try again."));
      await pass(p, t);
      t += 60 * 2 ** n;
    }
    const row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "failed", attempt: 5, last_error_kind: "transient" });
    expect(simulatedEsign.documents()).toHaveLength(0);
    const notes = await rows<{ kind: string; title: string; user_id: string }>("select kind, title, user_id from notifications where org_id = $1 and kind = 'signature_failed'", [p.org.id]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].title).toBe("A signing request for P-0001 could not be sent");
    expect(new Set(notes.map((n) => n.user_id))).toEqual(new Set([p.people.owner.id, p.people.manager.id, (p.coOwner as { userId: string }).userId, p.people.sales.id]));
    expect((await rows<{ signature_state: string }>("select signature_state from proposals where id = $1", [q.proposal.id]))[0].signature_state).toBe("failed");
    expect((await sigEvents(q.requestId)).map((e) => e.kind)).toContain("failed");
    // The proposal is still sent; asking again makes a request of its own, with the next number.
    const again = await askToSign(p, q.proposal.id, {}, { now: at(t) });
    expect(again.created).toBe(true);
    expect((await rows<{ idempotency_key: string }>("select idempotency_key from signature_requests where id = $1", [again.requestId]))[0].idempotency_key).toBe(`proposal:${q.proposal.id}:1:1`);
    const events = await rows<{ type: string; payload: Record<string, unknown> }>("select type, payload from crm_events where org_id = $1 and type = 'signature.failed'", [p.org.id]);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toMatchObject({ reason: "failed", requestId: q.requestId });
  });

  it("waits as long as the service asked to when it says to slow down", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.failNext("create", fail("rate_limited", "PandaDoc is limiting how often requests can be made. It will try again later.", { retryAfterSec: 1800 }));
    await pass(p, 0);
    const row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "queued", last_error_kind: "rate_limited" });
    expect(new Date(row.run_at).getTime()).toBe(at(1800).getTime());
    expect(await pass(p, 1799)).toMatchObject({ claimed: 0 });
    expect(await pass(p, 1800)).toMatchObject({ claimed: 1, sent: 1 });
  });

  it("stops at once when the service refuses the key, marks the connection as needing attention, and leaves other requests waiting rather than failing them", async () => {
    const p = await signingOrg();
    const a = await queued(p);
    const b = await queued(p);
    simulatedEsign.failNext("create", fail("auth", "The signing service no longer accepts this key. Connect it again.", { needsAttention: true }));
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, failed: 1 });
    expect(await statusOf(a.requestId)).toBe("failed");
    expect((await rows<{ status: string; status_detail: string }>("select status, status_detail from esign_connections where org_id = $1", [p.org.id]))[0]).toMatchObject({ status: "needs_attention", status_detail: expect.stringMatching(/no longer accepts/) });
    // The second request is not touched while the connection waits to be connected again.
    expect(await pass(p, 10)).toMatchObject({ claimed: 0 });
    expect(await statusOf(b.requestId)).toBe("queued");
    expect(simulatedEsign.documents()).toHaveLength(0);
    expect((await rows("select 1 from notifications where org_id = $1 and title = 'Your signing service needs to be connected again'", [p.org.id])).length).toBeGreaterThan(0);
  });

  it("treats a definite refusal of the content as final: no retry, no document, the connection untouched", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.failNext("create", fail("invalid_content", "PandaDoc refused this request (HTTP 400)."));
    expect(await pass(p, 0)).toMatchObject({ failed: 1, requeued: 0 });
    expect(await requestRow(q.requestId)).toMatchObject({ status: "failed", last_error: "PandaDoc refused this request (HTTP 400).", last_error_kind: "invalid_content" });
    expect((await rows<{ status: string }>("select status from esign_connections where org_id = $1", [p.org.id]))[0].status).toBe("connected");
  });

  it("holds a request without using an attempt when a switch is off, and tries again in a few minutes", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.failNext("create", fail("blocked", "Sending signing requests to PandaDoc is switched off in this environment, so nothing was sent."));
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, requeued: 1 });
    const row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "queued", attempt: 0, last_error_kind: "blocked" });
    expect(new Date(row.run_at).getTime()).toBe(at(300).getTime());
  });
});

describe("an answer that never came", () => {
  it("is an unknown outcome, never a failure: the document may exist, so it is looked for and never made again", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.loseResponseNext("create");
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, unknown: 1 });
    let row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "unknown", last_error_kind: "unknown_outcome" });
    // The note that a step may have made something is still on it.
    expect(row.provider_state).toMatchObject({ step: "create" });
    expect(row.provider_state.sendingAt).toBeTruthy();
    expect(simulatedEsign.documents()).toHaveLength(1);
    // It is checked, not made again: the service has a document with the request's reference in its name, so sending carries on with that one.
    expect(await pass(p, 61)).toMatchObject({ claimed: 0, reconciled: 1 });
    row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "queued", provider_document_id: "simdoc_1" });
    expect(row.provider_state).toEqual({ documentId: "simdoc_1" });
    expect(await pass(p, 62)).toMatchObject({ claimed: 1, sent: 1 });
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect(simulatedEsign.calls("create")).toBe(1);
    expect(simulatedEsign.calls("send")).toBe(1);
    expect((await sigEvents(q.requestId)).map((e) => e.kind)).toEqual(["created", "outcome_unknown", "reconciled_resumed", "sent"]);
  });

  it("learns that a send whose answer was lost did reach the signer, and says so without sending it again", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.loseResponseNext("send");
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, unknown: 1 });
    expect(simulatedEsign.documents()[0].status).toBe("sent");
    expect(await statusOf(q.requestId)).toBe("unknown");
    expect(await pass(p, 61)).toMatchObject({ reconciled: 1 });
    expect(await requestRow(q.requestId)).toMatchObject({ status: "sent", provider_document_id: "simdoc_1" });
    expect(simulatedEsign.calls("send")).toBe(1);
    expect((await sigEvents(q.requestId)).map((e) => e.kind)).toEqual(["created", "outcome_unknown", "reconciled_found", "sent"]);
  });

  it("does not believe 'not found' straight away: an answer can be slow, so it waits out a grace period, and then says nothing reached the signer", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    // The service goes quiet BEFORE it did anything, which is what a request that never arrived looks like.
    simulatedEsign.failNext("create", fail("unknown_outcome", "PandaDoc did not confirm whether this was sent."));
    await pass(p, 0);
    expect(await statusOf(q.requestId)).toBe("unknown");
    await pass(p, 61);
    expect(await statusOf(q.requestId)).toBe("unknown");
    expect((await requestRow(q.requestId)).last_error).toMatch(/Not found yet/);
    const late = Math.ceil(RECONCILE_GRACE_MS / 1000) + 400;
    await pass(p, late);
    const row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "failed", last_error: "The signing service confirmed it does not have this document, so nothing was sent to the signer. You can ask again." });
    expect(simulatedEsign.documents()).toHaveLength(0);
    expect((await sigEvents(q.requestId)).map((e) => e.kind)).toContain("reconciled_not_found");
    expect((await askToSign(p, q.proposal.id, {}, { now: at(late) })).created).toBe(true);
  });

  it("will not guess when two documents fit, and sends the person to look in their signing account instead", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.loseResponseNext("create");
    await pass(p, 0);
    const keys = await connectionKeys(p.org.id);
    const original = simulatedEsign.documents()[0];
    // A second document with the same reference exists at the service (somebody made it by hand).
    await simulatedProvider.createRequest(keys.creds, { requestId: q.requestId, idempotencyKey: original.idempotencyKey, name: original.name, signer: { name: "x", email: "x@example.test" }, pdf: original.pdf, pdfFilename: "x.pdf", placement: { page: 1, x: 0, yTop: 0, width: 1, height: 1 }, emailSubject: "s", emailMessage: "m" }, {});
    expect(simulatedEsign.documents()).toHaveLength(2);
    await pass(p, 61);
    const row = await requestRow(q.requestId);
    expect(row.status).toBe("failed");
    expect(row.last_error).toMatch(/could not tell whether the signing service sent this\. Look in your signing account/);
    expect(simulatedEsign.calls("send")).toBe(0);
  });

  it("keeps checking, and gives up with a note only after a day, when the service cannot be asked at all", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.loseResponseNext("create");
    await pass(p, 0);
    simulatedEsign.failNext("reconcile", fail("transient", "down"));
    await pass(p, 61);
    expect(await statusOf(q.requestId)).toBe("unknown");
    expect((await requestRow(q.requestId)).last_error).toBe("down");
    simulatedEsign.failNext("reconcile", fail("transient", "down"));
    await pass(p, 61 + 1800 + 5);
    expect(await statusOf(q.requestId)).toBe("unknown");
    simulatedEsign.failNext("reconcile", fail("transient", "down"));
    await pass(p, 25 * 3600);
    expect(await statusOf(q.requestId)).toBe("failed");
    expect((await requestRow(q.requestId)).last_error).toMatch(/Look in your signing account/);
  });

  it("does not look for a lost answer while the connection needs attention, and does not give up on it either (before a day)", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    simulatedEsign.loseResponseNext("create");
    await pass(p, 0);
    await withSystem((db) => db.query("update esign_connections set status = 'needs_attention' where org_id = $1", [p.org.id]));
    await pass(p, 61);
    expect(await statusOf(q.requestId)).toBe("unknown");
    expect((await requestRow(q.requestId)).last_error).toMatch(/not connected, so the request could not be checked yet/);
    expect(simulatedEsign.calls("reconcile")).toBe(0);
  });
});

describe("a worker that stops", () => {
  const strand = (id: string, state: Record<string, unknown>, attempt = 1, secondsAgo = 60) =>
    withSystem((db) => db.query(
      "update signature_requests set status = 'sending', claimed_by = 'dead-worker', attempt = $2, lease_until = $3::timestamptz, provider_state = $4::jsonb where id = $1",
      [id, attempt, at(-secondsAgo).toISOString(), JSON.stringify(state)],
    ));

  it("is replaced: a request it dropped before it made anything starts again, and one it dropped while making something is checked", async () => {
    const p = await signingOrg();
    const a = await queued(p);
    const b = await queued(p);
    await strand(a.requestId, {});
    await strand(b.requestId, { sendingAt: at(-70).toISOString(), step: "create" });
    expect(await withSystem((db) => recoverExpiredLeases(db, at(0), p.org.id))).toBe(2);
    expect(await requestRow(a.requestId)).toMatchObject({ status: "queued" });
    expect(await requestRow(b.requestId)).toMatchObject({ status: "unknown", last_error_kind: "unknown_outcome" });
    expect((await sigEvents(a.requestId)).map((e) => e.kind)).toContain("worker_lost_resumed");
    expect((await sigEvents(b.requestId)).map((e) => e.kind)).toContain("worker_lost_while_sending");
    // The checked one is not sent: no document was made by any of this.
    expect(simulatedEsign.documents()).toHaveLength(0);
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, sent: 1 });
    expect(simulatedEsign.documents()).toHaveLength(1);
  });

  it("is given up on, plainly, when it keeps dying before it sends anything", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await strand(q.requestId, {}, 5);
    await withSystem((db) => recoverExpiredLeases(db, at(0), p.org.id));
    expect(await requestRow(q.requestId)).toMatchObject({ status: "failed", last_error: "Signing kept stopping unexpectedly before anything was sent, so this was not sent. Try again." });
  });

  it("leaves a worker alone for as long as its lease runs, and does not take over a request that is not its to take", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await withSystem((db) => db.query("update signature_requests set status = 'sending', claimed_by = 'busy-worker', lease_until = $2::timestamptz where id = $1", [q.requestId, at(LEASE_SECONDS).toISOString()]));
    expect(await withSystem((db) => recoverExpiredLeases(db, at(10), p.org.id))).toBe(0);
    expect(await pass(p, 10)).toMatchObject({ claimed: 0, recovered: 0 });
    expect(await statusOf(q.requestId)).toBe("sending");
    // Another worker holding the request means this one stops before it does anything.
    const row = (await withSystem((db) => loadRequest(db, p.org.id, q.requestId)))!;
    expect(await runClaimedRequest(row, { workerId: "someone-else", now: () => at(10) })).toBe("lost");
    expect(simulatedEsign.documents()).toHaveLength(0);
    expect(simulatedEsign.calls("create")).toBe(0);
  });

  it("treats a crash it did not foresee as an unknown outcome when something may have been made, and says nothing about the crash", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    const boom: EsignProvider = { ...simulatedProvider, createRequest: async () => { throw new Error("secret detail: sk_live_abc connection reset"); } };
    await pass(p, 0, { provider: () => boom });
    const row = await requestRow(q.requestId);
    expect(row.status).toBe("unknown");
    expect(row.last_error).toBe("The simulated signing service did not confirm whether this was sent. It is being checked and will not be sent again until that is known.");
    expect(JSON.stringify(await sigEvents(q.requestId))).not.toContain("sk_live_abc");
    expect(row.last_error).not.toContain("sk_live_abc");
  });
});

describe("a proposal that moved on", () => {
  it("is not handed over when the version was replaced after the request was claimed: the request ends as replaced and nothing is made", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    // The revision landed between the claim and the first step (the proposal's own revise also ends the request; this is the race it leaves).
    await withSystem((db) => db.query("update proposals set version = version + 1, status = 'draft', approved_version = null, approved_by = null, approved_at = null where id = $1", [q.proposal.id]));
    await pass(p, 0);
    expect(await requestRow(q.requestId)).toMatchObject({ status: "superseded", void_reason: "The proposal was revised." });
    expect(simulatedEsign.documents()).toHaveLength(0);
  });

  it("ends as withdrawn when the proposal was closed under it", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await withSystem((db) => db.query("update proposals set status = 'withdrawn', closed_at = now() where id = $1", [q.proposal.id]));
    await pass(p, 0);
    expect(await requestRow(q.requestId)).toMatchObject({ status: "voided", void_reason: "The proposal was closed." });
    expect(simulatedEsign.documents()).toHaveLength(0);
  });

  it("refuses to send a document that is not the one the request was made for", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update signature_requests set pdf_sha256 = $2 where id = $1", [q.requestId, "0".repeat(64)]);
    });
    await pass(p, 0);
    const row = await requestRow(q.requestId);
    expect(row).toMatchObject({ status: "failed", last_error_kind: "invalid_content" });
    expect(row.last_error).toMatch(/no longer matches the one this request was made for, so nothing was sent/);
    expect(simulatedEsign.documents()).toHaveLength(0);
  });
});

describe("when work is held back", () => {
  it("does nothing for a workspace iAcquire or the owner has paused, suspended or archived, and carries on when it is back", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    for (const scope of ["agency", "outbound"]) {
      await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, $2, true, null, null, now()) on conflict (org_id, scope) do update set active = true", [p.org.id, scope]));
      expect(await pass(p, 0), scope).toMatchObject({ claimed: 0 });
      await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [p.org.id]));
    }
    for (const status of ["suspended", "archived"]) {
      await withSystem((db) => db.query("update organizations set status = $2 where id = $1", [p.org.id, status]));
      expect(await pass(p, 0), status).toMatchObject({ claimed: 0 });
    }
    expect(simulatedEsign.documents()).toHaveLength(0);
    expect(await statusOf(q.requestId)).toBe("queued");
    await withSystem((db) => db.query("update organizations set status = 'active' where id = $1", [p.org.id]));
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, sent: 1 });
  });

  it("does nothing for a workspace whose signing or proposals a Super Admin switched off", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await setFeature(p.org.id, false, "esign");
    expect(await pass(p, 0)).toMatchObject({ claimed: 0 });
    await setFeature(p.org.id, true, "esign");
    await setFeature(p.org.id, false, "proposals");
    expect(await pass(p, 0)).toMatchObject({ claimed: 0 });
    await setFeature(p.org.id, true, "proposals");
    expect(await statusOf(q.requestId)).toBe("queued");
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, sent: 1 });
  });

  it("leaves a request alone while its connection needs attention, and hands it over once it is connected again", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await withSystem((db) => db.query("update esign_connections set status = 'needs_attention' where org_id = $1", [p.org.id]));
    expect(await pass(p, 0)).toMatchObject({ claimed: 0 });
    await withSystem((db) => db.query("update esign_connections set status = 'connected' where org_id = $1", [p.org.id]));
    expect(await pass(p, 0)).toMatchObject({ claimed: 1, sent: 1 });
    expect(await statusOf(q.requestId)).toBe("sent");
  });

  it("works on one workspace at a time when asked to, and never on another's requests", async () => {
    const a = await signingOrg();
    const b = await signingOrg();
    const qa = await queued(a);
    const qb = await queued(b);
    expect(await pass(a, 0)).toMatchObject({ claimed: 1 });
    expect(await statusOf(qa.requestId)).toBe("sent");
    expect(await statusOf(qb.requestId)).toBe("queued");
    expect(simulatedEsign.documents()).toHaveLength(1);
    expect(simulatedEsign.documents()[0].signerEmail).toBe(qa.email.toLowerCase());
  });

  it("does not take a request that is not due yet", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await withSystem((db) => db.query("update signature_requests set run_at = $2::timestamptz where id = $1", [q.requestId, at(100).toISOString()]));
    expect(await pass(p, 99)).toMatchObject({ claimed: 0 });
    expect(await pass(p, 100)).toMatchObject({ claimed: 1 });
  });
});

describe("a real service", () => {
  /** The workspace's connection and the request, turned into ones made through PandaDoc (a real one cannot be made here without a real service). */
  async function asPandaDoc(p: ProposalOrg, requestId: string) {
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update esign_connections set provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [p.org.id]);
      await db.query("update signature_requests set provider = 'pandadoc', mode = 'sandbox' where id = $1", [requestId]);
    });
  }
  const DOC = "BhVzRcxH9Z2LgfPPGXFUBa";
  function fakePandaDoc() {
    const calls: Array<{ method: string; path: string }> = [];
    const provider = createPandaDocProvider({
      writesEnabled: () => true,
      http: async (req) => {
        calls.push({ method: req.method, path: req.path });
        if (req.method === "POST" && req.path === "/public/v1/documents") return { status: 201, json: { id: DOC, status: "document.uploaded" }, bytes: Buffer.alloc(0), retryAfter: null };
        if (req.method === "GET") return { status: 200, json: { id: DOC, status: "document.draft" }, bytes: Buffer.alloc(0), retryAfter: null };
        return { status: 200, json: { id: DOC, status: "document.sent" }, bytes: Buffer.alloc(0), retryAfter: null };
      },
    });
    return { provider, calls };
  }

  it("is left untouched while the write switch is off, and handed over through the adapter once it is on", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await asPandaDoc(p, q.requestId);
    const f = fakePandaDoc();
    expect(await pass(p, 0, { liveEnabled: () => false, provider: () => f.provider })).toMatchObject({ claimed: 0 });
    expect(f.calls).toEqual([]);
    expect(await statusOf(q.requestId)).toBe("queued");
    expect(await pass(p, 0, { liveEnabled: () => true, provider: () => f.provider })).toMatchObject({ claimed: 1, sent: 1 });
    expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /public/v1/documents", `GET /public/v1/documents/${DOC}`, `POST /public/v1/documents/${DOC}/send`]);
    expect(await requestRow(q.requestId)).toMatchObject({ status: "sent", provider_document_id: DOC });
  });

  it("when the adapter itself refuses because its own switch is off, holds the request instead of failing it", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    await asPandaDoc(p, q.requestId);
    const off = createPandaDocProvider({ writesEnabled: () => false, http: async () => { throw new Error("must not be called"); } });
    expect(await pass(p, 0, { liveEnabled: () => true, provider: () => off })).toMatchObject({ claimed: 1, requeued: 1, failed: 0 });
    expect(await requestRow(q.requestId)).toMatchObject({ status: "queued", attempt: 0, last_error_kind: "blocked" });
  });

  it("is never written to for the stand-in's request, whatever the switch says", async () => {
    const p = await signingOrg();
    const q = await queued(p);
    expect(await pass(p, 0, { liveEnabled: () => false })).toMatchObject({ claimed: 1, sent: 1 });
    expect(await statusOf(q.requestId)).toBe("sent");
  });
});
