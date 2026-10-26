// The work around a request that is not the first ask: reading the service when no notice came (a safety net), fetching the signed copy, withdrawing what was withdrawn, checking
// each key, and the whole pass the scheduler runs. Embedded Postgres and the in-process stand-in service; the clock is passed in.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { readAuthorizedPrivateFile } from "@/server/storage/private";
import { voidSignatureRequest } from "@/server/esign/requests";
import { disconnect } from "@/server/esign/connections";
import { cancelWithdrawn, checkConnections, fetchSignedCopies, HEALTH_EVERY_MS, MAX_CANCEL_ATTEMPTS, MAX_COPY_ATTEMPTS, POLL_EVERY_MS, pollOutRequests, runEsignSync } from "@/server/esign/maintenance";
import { simulatedEsign, simulatedProvider } from "@/server/esign/providers/simulated";
import { EsignProviderError, type EsignProvider } from "@/server/esign/providers/types";
import type { WorkerDeps } from "@/server/esign/worker";
import { getProposal } from "@/server/proposals/proposals";
import { connectionKeys, handedOver, NOW, requestRow, rows, setFeature, sigEvents, signerActs, signingOrg, type ProposalOrg } from "./support/proposals";

beforeEach(() => simulatedEsign.reset());

const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const run = (p: ProposalOrg, seconds: number, deps: WorkerDeps = {}) => ({ deps: { now: () => at(seconds), jitter: () => 0, ...deps }, orgId: p.org.id, deadline: Date.now() + 20_000 });
const proposalStatus = async (id: string) => (await rows<{ status: string }>("select status from proposals where id = $1", [id]))[0].status;
const fail = (kind: ConstructorParameters<typeof EsignProviderError>[0], message: string, opts: ConstructorParameters<typeof EsignProviderError>[2] = {}) => new EsignProviderError(kind, message, opts);

describe("reading the service when no notice came", () => {
  it("applies a signature it finds exactly as a notice of it would be applied, and says it read it itself", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "complete");
    // Never read before, so it is read now; after that, about every fifteen minutes.
    expect(await pollOutRequests(run(p, 0))).toBe(1);
    expect(await proposalStatus(h.proposal.id)).toBe("accepted");
    const ev = (await sigEvents(h.requestId)).filter((e) => e.source === "provider_poll");
    expect(ev.map((e) => e.kind)).toEqual(["completed"]);
    expect(ev[0].provider_event_id).toBeNull();
    const [d] = await rows<{ method: string; signature_request_id: string }>("select method, signature_request_id from proposal_decisions where proposal_id = $1", [h.proposal.id]);
    expect(d).toEqual({ method: "provider_signature", signature_request_id: h.requestId });
  });

  it("moves a request forward on what it reads, ignores a status it does not understand, and leaves nothing behind when nothing changed", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    expect(await pollOutRequests(run(p, 0))).toBe(0);
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).toEqual(["created", "sent"]);
    simulatedEsign.signerAction(h.documentId, "view");
    expect(await pollOutRequests(run(p, POLL_EVERY_MS / 1000 + 1))).toBe(1);
    expect((await requestRow(h.requestId)).status).toBe("viewed");
  });

  it("reads each request about every fifteen minutes and not oftener, however often it runs", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await pollOutRequests(run(p, 0));
    expect(simulatedEsign.calls("status")).toBe(1);
    await pollOutRequests(run(p, 60));
    await pollOutRequests(run(p, POLL_EVERY_MS / 1000 - 1));
    expect(simulatedEsign.calls("status")).toBe(1);
    await pollOutRequests(run(p, POLL_EVERY_MS / 1000));
    expect(simulatedEsign.calls("status")).toBe(2);
    expect(h.requestId).toBeTruthy();
  });

  it("reads only requests that are out, and only for a workspace that may have signing work done right now", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, 'agency', true, null, null, now())", [p.org.id]));
    expect(await pollOutRequests(run(p, 0))).toBe(0);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [p.org.id]));
    await setFeature(p.org.id, false, "esign");
    expect(await pollOutRequests(run(p, 0))).toBe(0);
    await setFeature(p.org.id, true, "esign");
    expect(simulatedEsign.calls("status")).toBe(0);
    await voidSignatureRequest(p.actor("sales"), h.requestId, { now: NOW });
    expect(await pollOutRequests(run(p, 0))).toBe(0);
    expect(simulatedEsign.calls("status")).toBe(0);
  });

  it("leaves the request as it was when the service cannot be asked, and marks the connection when it refuses the key", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    simulatedEsign.signerAction(h.documentId, "complete");
    simulatedEsign.failNext("status", fail("transient", "down"));
    expect(await pollOutRequests(run(p, 0))).toBe(0);
    expect((await requestRow(h.requestId)).status).toBe("sent");
    expect((await connectionStatus(p))).toBe("connected");
    simulatedEsign.failNext("status", fail("auth", "The signing service no longer accepts this key. Connect it again.", { needsAttention: true }));
    await pollOutRequests(run(p, POLL_EVERY_MS / 1000 + 1));
    expect((await requestRow(h.requestId)).status).toBe("sent");
    expect(await connectionStatus(p)).toBe("needs_attention");
  });
});

const connectionStatus = async (p: ProposalOrg) => (await rows<{ status: string }>("select status from esign_connections where org_id = $1", [p.org.id]))[0].status;

describe("the signed copy", () => {
  async function signed(p: ProposalOrg, over: Parameters<typeof handedOver>[1] = {}) {
    const h = await handedOver(p, over);
    await signerActs(p, h.requestId, "complete");
    return h;
  }

  it("is stored with its certificate in the private proposal documents, with hashes that match the bytes, readable by the people who can see proposals and nobody else", async () => {
    const p = await signingOrg();
    const h = await signed(p);
    expect(await fetchSignedCopies(run(p, 0))).toBe(1);
    const req = await requestRow(h.requestId);
    expect(req.signed_file_id).toBeTruthy();
    expect(req.certificate_file_id).toBeTruthy();
    const full = (await rows<{ signed_sha256: string; certificate_sha256: string }>("select signed_sha256, certificate_sha256 from signature_requests where id = $1", [h.requestId]))[0];
    const files = await rows<{ id: string; bucket: string; filename: string; mime_type: string; status: string; visibility: string; uploaded_by: string; storage_key: string }>(
      "select id, bucket, filename, mime_type, status, visibility, uploaded_by, storage_key from private_files where id = any($1::uuid[]) order by filename", [[req.signed_file_id, req.certificate_file_id]]);
    expect(files.map((f) => [f.bucket, f.filename, f.mime_type, f.status, f.visibility])).toEqual([
      ["proposal-documents", "Certificate-P-0001-v1.pdf", "application/pdf", "ready", "client"], ["proposal-documents", "Signed-P-0001-v1.pdf", "application/pdf", "ready", "client"],
    ]);
    for (const f of files) expect(f.storage_key.startsWith(`${p.org.id}/`)).toBe(true);
    // Stored on the permission of someone at the business who may write proposals: the person who asked.
    expect(new Set(files.map((f) => f.uploaded_by))).toEqual(new Set([p.people.sales.id]));
    const signedBytes = (await readAuthorizedPrivateFile(req.signed_file_id as string)).bytes;
    const certBytes = (await readAuthorizedPrivateFile(req.certificate_file_id as string)).bytes;
    expect(signedBytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(createHash("sha256").update(signedBytes).digest("hex")).toBe(full.signed_sha256);
    expect(createHash("sha256").update(certBytes).digest("hex")).toBe(full.certificate_sha256);
    // The stand-in says in the file itself that it is not a real signature.
    expect(signedBytes.toString("latin1")).toContain("SIMULATED SIGNATURE: not a real signature");
    expect(certBytes.toString("latin1")).toContain("Simulated certificate of completion");
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).toContain("copy_stored");
    // Who can read it: everyone who may see proposals in this workspace; nobody in another.
    const other = await signingOrg();
    const mayRead = (who: string, orgId: string, userId: string) => withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true)", [userId]);
      return { who, ok: (await db.query<{ ok: boolean }>("select app.file_permission($1, 'proposal-documents', false, 'client') as ok", [orgId])).rows[0].ok };
    });
    expect(await Promise.all([
      mayRead("owner", p.org.id, p.people.owner.id), mayRead("sales", p.org.id, p.people.sales.id), mayRead("viewer", p.org.id, p.people.viewer.id), mayRead("setter", p.org.id, p.people.setter.id),
      mayRead("stranger", p.org.id, other.people.owner.id),
    ])).toEqual([{ who: "owner", ok: true }, { who: "sales", ok: true }, { who: "viewer", ok: true }, { who: "setter", ok: false }, { who: "stranger", ok: false }]);
    // The screen is told where to find it.
    const view = (await getProposal(p.actor("viewer"), h.proposal.id, { now: NOW })).signature.requests[0];
    expect(view).toMatchObject({ signedFileId: req.signed_file_id, certificateFileId: req.certificate_file_id, copyPending: false, copyGaveUp: false });
  });

  it("fetches it only once, however many workers look at the same moment, and removes the surplus copy a loser made", async () => {
    const p = await signingOrg();
    const h = await signed(p);
    const totals = await Promise.all([fetchSignedCopies(run(p, 0)), fetchSignedCopies(run(p, 0)), fetchSignedCopies(run(p, 0))]);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await fetchSignedCopies(run(p, 10))).toBe(0);
    const ready = await rows("select 1 from private_files where org_id = $1 and bucket = 'proposal-documents' and filename like 'Signed-%' and status = 'ready'", [p.org.id]);
    expect(ready).toHaveLength(1);
    expect((await requestRow(h.requestId)).signed_file_id).toBeTruthy();
  });

  it("is fetched even when the signature was set aside, because the business holds a document it may want", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { reviseProposal } = await import("@/server/proposals/proposals");
    await reviseProposal(p.actor("sales"), h.proposal.id, { now: NOW });
    await signerActs(p, h.requestId, "complete");
    expect((await requestRow(h.requestId)).not_applied_reason).toBe("superseded");
    expect(await fetchSignedCopies(run(p, 0))).toBe(1);
  });

  it("is tried again on a growing wait when the service cannot hand it over yet, and the wait is not skipped", async () => {
    const p = await signingOrg();
    const h = await signed(p);
    simulatedEsign.failNext("download", fail("transient", "down"));
    expect(await fetchSignedCopies(run(p, 0))).toBe(0);
    let row = await requestRow(h.requestId);
    expect(row).toMatchObject({ copy_attempts: 1, signed_file_id: null, copy_gave_up_at: null });
    const next = (await rows<{ copy_next_at: Date }>("select copy_next_at from signature_requests where id = $1", [h.requestId]))[0].copy_next_at;
    expect(new Date(next).getTime()).toBe(at(60).getTime());
    expect(await fetchSignedCopies(run(p, 59))).toBe(0);
    expect(simulatedEsign.calls("download")).toBe(1);
    expect(await fetchSignedCopies(run(p, 60))).toBe(1);
    row = await requestRow(h.requestId);
    expect(row.signed_file_id).toBeTruthy();
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).toEqual(expect.arrayContaining(["copy_failed", "copy_stored"]));
  });

  it("is given up on after a number of tries, with one plain notice to the people who can act, and the screen says to download it from the service", async () => {
    const p = await signingOrg();
    const h = await signed(p);
    let t = 0;
    for (let n = 1; n <= MAX_COPY_ATTEMPTS; n += 1) {
      simulatedEsign.failNext("download", fail("transient", "down"));
      await fetchSignedCopies(run(p, t));
      t += 3600 * 2;
    }
    const row = await requestRow(h.requestId);
    expect(row).toMatchObject({ copy_attempts: MAX_COPY_ATTEMPTS, signed_file_id: null });
    expect(row.copy_gave_up_at).not.toBeNull();
    const notes = await rows<{ title: string; body: string; user_id: string }>("select title, body, user_id from notifications where org_id = $1 and dedupe_key = $2", [p.org.id, `signature-copy:${h.requestId}`]);
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0].title).toBe("The signed copy of P-0001 could not be fetched");
    expect(notes[0].body).toBe("The signature is recorded, but iAcquire could not fetch the signed copy. Download it from your signing service.");
    // It stops trying.
    expect(await fetchSignedCopies(run(p, t + 86_400))).toBe(0);
    expect(simulatedEsign.calls("download")).toBe(MAX_COPY_ATTEMPTS);
    const view = (await getProposal(p.actor("viewer"), h.proposal.id, { now: NOW })).signature.requests[0];
    expect(view).toMatchObject({ copyPending: false, copyGaveUp: true, signedFileId: null });
  });

  it("is not stored when what comes back is not a PDF, and nothing is saved from it", async () => {
    const p = await signingOrg();
    const h = await signed(p);
    const junk: EsignProvider = { ...simulatedProvider, downloadSigned: async () => ({ signedPdf: Buffer.from("<html>please log in</html>"), certificate: null }) };
    expect(await fetchSignedCopies(run(p, 0, { provider: () => junk }))).toBe(0);
    expect(await requestRow(h.requestId)).toMatchObject({ copy_attempts: 1, signed_file_id: null, last_error: "The signing service did not return a PDF." });
    expect(await rows("select 1 from private_files where org_id = $1 and filename like 'Signed-%'", [p.org.id])).toHaveLength(0);
    // A certificate that is not a PDF is left out; the signed copy is still kept.
    const noCert: EsignProvider = { ...simulatedProvider, downloadSigned: async (c, id) => ({ ...(await simulatedProvider.downloadSigned(c, id)), certificate: Buffer.from("nope") }) };
    expect(await fetchSignedCopies(run(p, 3600, { provider: () => noCert }))).toBe(1);
    expect(await requestRow(h.requestId)).toMatchObject({ certificate_file_id: null });
    expect((await requestRow(h.requestId)).signed_file_id).toBeTruthy();
  });

  it("says it can never be fetched once the connection has been disconnected, instead of promising a retry", async () => {
    const p = await signingOrg();
    const h = await signed(p);
    await disconnect(p.actor("owner"));
    const row = await requestRow(h.requestId);
    expect(row.copy_gave_up_at).not.toBeNull();
    expect((await sigEvents(h.requestId)).filter((e) => e.kind === "copy_gave_up")).toEqual([{ kind: "copy_gave_up", source: "system", provider_event_id: null, detail: { why: "disconnected" } }]);
    expect(await fetchSignedCopies(run(p, 0))).toBe(0);
    const view = (await getProposal(p.actor("viewer"), h.proposal.id, { now: NOW })).signature.requests[0];
    expect(view).toMatchObject({ copyPending: false, copyGaveUp: true });
  });

  it("is not fetched for a workspace that is paused, and is fetched when it is back", async () => {
    const p = await signingOrg();
    await signed(p);
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, 'outbound', true, null, null, now())", [p.org.id]));
    expect(await fetchSignedCopies(run(p, 0))).toBe(0);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [p.org.id]));
    expect(await fetchSignedCopies(run(p, 0))).toBe(1);
  });
});

describe("withdrawing at the service what a person withdrew", () => {
  it("tells the service to withdraw it where it allows that, and records that it did", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await voidSignatureRequest(p.actor("sales"), h.requestId, { now: NOW });
    expect((await requestRow(h.requestId)).cancel_state).toBe("wanted");
    expect(await cancelWithdrawn(run(p, 0))).toBe(1);
    expect(await requestRow(h.requestId)).toMatchObject({ cancel_state: "done" });
    expect(simulatedEsign.documents()[0].status).toBe("voided");
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).toContain("cancel_done");
    expect(await cancelWithdrawn(run(p, 10))).toBe(0);
    expect(simulatedEsign.calls("cancel")).toBe(1);
  });

  it("tries a few times when it cannot, then asks the business to do it, and says so", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await voidSignatureRequest(p.actor("sales"), h.requestId, { now: NOW });
    for (let n = 1; n <= MAX_CANCEL_ATTEMPTS; n += 1) {
      simulatedEsign.failNext("cancel", fail("transient", "down"));
      await cancelWithdrawn(run(p, n));
      expect((await requestRow(h.requestId)).cancel_state).toBe(n < MAX_CANCEL_ATTEMPTS ? "wanted" : "manual");
    }
    expect((await sigEvents(h.requestId)).map((e) => e.kind).filter((k) => k.startsWith("cancel_"))).toEqual(["cancel_failed", "cancel_failed", "cancel_failed", "cancel_failed", "cancel_manual"]);
    const view = (await getProposal(p.actor("viewer"), h.proposal.id, { now: NOW })).signature.requests[0];
    expect(view.cancelNote).toContain("iAcquire cannot withdraw it at the simulated signing service");
    expect(await cancelWithdrawn(run(p, 100))).toBe(0);
  });

  it("does not write to a real service while the write switch is off, and does not touch a stopped workspace", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await voidSignatureRequest(p.actor("sales"), h.requestId, { now: NOW });
    await withSystem((db) => db.query("insert into automation_pauses (org_id, scope, active, reason, set_by, set_at) values ($1, 'agency', true, null, null, now())", [p.org.id]));
    expect(await cancelWithdrawn(run(p, 0))).toBe(0);
    await withSystem((db) => db.query("update automation_pauses set active = false where org_id = $1", [p.org.id]));
    // Turned into a request through a real service (done with the guards off, for this statement only), it is left alone with the switch off.
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update esign_connections set provider = 'pandadoc', mode = 'sandbox' where org_id = $1", [p.org.id]);
      await db.query("update signature_requests set provider = 'pandadoc', mode = 'sandbox' where id = $1", [h.requestId]);
    });
    expect(await cancelWithdrawn(run(p, 0, { liveEnabled: () => false }))).toBe(0);
    expect(simulatedEsign.calls("cancel")).toBe(0);
    expect((await requestRow(h.requestId)).cancel_state).toBe("wanted");
  });
});

describe("checking each key", () => {
  const dueNow = (p: ProposalOrg) => withSystem((db) => db.query("update esign_connections set last_checked_at = null where org_id = $1", [p.org.id]));

  it("checks a key about every six hours, records that it works, and leaves a key that was checked recently alone", async () => {
    const p = await signingOrg();
    await dueNow(p);
    expect(await checkConnections(run(p, 0))).toBe(1);
    const c = (await rows<{ status: string; last_checked_at: Date; last_success_at: Date; account_label: string }>("select status, last_checked_at, last_success_at, account_label from esign_connections where org_id = $1", [p.org.id]))[0];
    expect(c).toMatchObject({ status: "connected", account_label: "Simulated signing service" });
    expect(new Date(c.last_checked_at).getTime()).toBe(NOW.getTime());
    expect(await checkConnections(run(p, 3600))).toBe(0);
    expect(await checkConnections(run(p, HEALTH_EVERY_MS / 1000 - 1))).toBe(0);
    expect(await checkConnections(run(p, HEALTH_EVERY_MS / 1000 + 1))).toBe(1);
  });

  it("marks a key the service refuses as needing attention and tells the people who can fix it, once a day", async () => {
    const p = await signingOrg();
    const { creds } = await connectionKeys(p.org.id);
    simulatedEsign.revoke(creds.apiKey);
    await dueNow(p);
    await checkConnections(run(p, 0));
    expect(await connectionStatus(p)).toBe("needs_attention");
    await withSystem((db) => db.query("update esign_connections set status = 'connected' where org_id = $1", [p.org.id]));
    await dueNow(p);
    await checkConnections(run(p, 100));
    const keys = await rows<{ dedupe_key: string }>("select distinct dedupe_key from notifications where org_id = $1 and title = 'Your signing service needs to be connected again'", [p.org.id]);
    expect(keys.length).toBe(1);
  });

  it("changes nothing when the service cannot be asked, and notes only that it tried", async () => {
    const p = await signingOrg();
    await dueNow(p);
    simulatedEsign.failNext("health", fail("transient", "down"));
    expect(await checkConnections(run(p, 0))).toBe(0);
    const c = (await rows<{ status: string; last_checked_at: Date }>("select status, last_checked_at from esign_connections where org_id = $1", [p.org.id]))[0];
    expect(c.status).toBe("connected");
    expect(new Date(c.last_checked_at).getTime()).toBe(NOW.getTime());
  });

  it("flags a key that can no longer be opened, and skips a connection that has ended or a workspace that is switched off", async () => {
    const p = await signingOrg();
    await withSystem((db) => db.query("update esign_connections set credentials = 'garbage', last_checked_at = null where org_id = $1", [p.org.id]));
    expect(await checkConnections(run(p, 0))).toBe(1);
    expect(await connectionStatus(p)).toBe("needs_attention");
    const q = await signingOrg();
    await setFeature(q.org.id, false, "esign");
    await dueNow(q);
    expect(await checkConnections(run(q, 0))).toBe(0);
    await setFeature(q.org.id, true, "esign");
    await disconnect(q.actor("owner"));
    expect(await checkConnections(run(q, 0))).toBe(0);
  });
});

describe("one pass of the scheduler's job", () => {
  it("hands over, reads, fetches, withdraws and checks, in that order, in one run, and counts what it did", async () => {
    const p = await signingOrg();
    const { sentForSigning, askToSign } = await import("./support/proposals");
    const s = await sentForSigning(p);
    const { requestId } = await askToSign(p, s.proposal.id);
    const first = await runEsignSync({ orgId: p.org.id, now: () => at(0), jitter: () => 0 });
    expect(first).toMatchObject({ claimed: 1, recovered: 0, reconciled: 0, polled: 0, copies: 0, cancelled: 0 });
    expect((await requestRow(requestId)).status).toBe("sent");
    // The signer signs; no notice comes. A quarter of an hour later the job reads the service and fetches the signed copy in the same pass.
    simulatedEsign.signerAction((await requestRow(requestId)).provider_document_id as string, "complete");
    const second = await runEsignSync({ orgId: p.org.id, now: () => at(POLL_EVERY_MS / 1000 + 5), jitter: () => 0 });
    expect(second).toMatchObject({ claimed: 0, polled: 1, copies: 1 });
    expect(await proposalStatus(s.proposal.id)).toBe("accepted");
    expect((await requestRow(requestId)).signed_file_id).toBeTruthy();
    // Run again and again: nothing more happens.
    const third = await runEsignSync({ orgId: p.org.id, now: () => at(2 * POLL_EVERY_MS / 1000), jitter: () => 0 });
    expect(third).toMatchObject({ claimed: 0, polled: 0, copies: 0, cancelled: 0 });
    expect(await rows("select 1 from proposal_decisions where proposal_id = $1", [s.proposal.id])).toHaveLength(1);
  });
});
