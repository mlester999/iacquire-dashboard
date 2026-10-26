// What the signing service's word does to a request and to the proposal. A signature becomes an acceptance only when the proposal is still sent on the very version the signer was
// asked to sign, nobody answered it, it is in date and the saved version is what was sent; every other signature is kept as the service's fact and set aside with its reason, never
// applied to a newer version and never reopening a closed proposal. Embedded Postgres, the stand-in service, and the notice route's own handler.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ failNotify: false }));
vi.mock("@/server/notifications", async (original) => {
  const real = await original<typeof import("@/server/notifications")>();
  const guard = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => (...a: A) => (hooks.failNotify ? Promise.reject(new Error("the notification table is down")) : fn(...a));
  return { ...real, notifyOrgRoles: guard(real.notifyOrgRoles), notifyUser: guard(real.notifyUser) };
});

import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { loadPublicProposal } from "@/server/proposals/public";
import { saveProposalSettings } from "@/server/proposals/settings";
import { getProposal, reviseProposal, withdrawProposal } from "@/server/proposals/proposals";
import { simulatedEsign } from "@/server/esign/providers/simulated";
import { NOT_APPLIED_TEXT } from "@/lib/esign/state";
import { uid } from "./support/fixtures";
import { freshIp, handedOver, NOW, requestRow, rows, sigEvents, signerActs, signingOrg, type ProposalOrg } from "./support/proposals";

beforeEach(() => {
  simulatedEsign.reset();
  hooks.failNotify = false;
});
afterEach(() => vi.restoreAllMocks());

const proposalRow = async (id: string) => (await rows<{ status: string; signature_state: string; version: number; closed_at: Date | null }>("select status, signature_state, version, closed_at from proposals where id = $1", [id]))[0];
const decisions = (id: string) => rows<{ decision: string; method: string; decided_name: string | null; decided_email: string | null; signature_request_id: string | null; content_hash: string; acknowledgement_version: number | null; ip_hash: string | null; decided_at: Date; recorded_by: string | null }>(
  "select decision, method, decided_name, decided_email::text as decided_email, signature_request_id, content_hash, acknowledgement_version, ip_hash, decided_at, recorded_by from proposal_decisions where proposal_id = $1 order by decided_at, id", [id]);
const crmEvents = (orgId: string, type: string) => rows<{ payload: Record<string, unknown>; dedupe_key: string | null }>("select payload, dedupe_key from crm_events where org_id = $1 and type = $2", [orgId, type]);
const notes = (orgId: string, kind: string) => rows<{ user_id: string; title: string; body: string; severity: string; link: string }>("select user_id, title, body, severity, link from notifications where org_id = $1 and kind = $2 order by title, user_id", [orgId, kind]);

async function withDeal(p: ProposalOrg) {
  const email = `maria-${uid()}@example.test`;
  const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email });
  const deal = await createOpportunity(p.actor("owner"), { name: "Clinic website", contactId: contact.id, value: 1500, currency: "USD", ownerId: p.people.manager.id });
  return { contactId: contact.id, dealId: deal.id, email };
}

describe("a signature that is applied", () => {
  it("records the service's word as the customer's acceptance, bound to the version that was signed, and labels it as a signature from a service", async () => {
    const p = await signingOrg();
    const h = await handedOver(p, { clientName: "Maria Santos" });
    const version = (await rows<{ content_hash: string }>("select content_hash from proposal_versions where proposal_id = $1 and version = 1", [h.proposal.id]))[0].content_hash;
    expect((await signerActs(p, h.requestId, "complete")).status).toBe(200);
    expect(await proposalRow(h.proposal.id)).toMatchObject({ status: "accepted", signature_state: "completed", version: 1 });
    expect((await proposalRow(h.proposal.id)).closed_at).not.toBeNull();
    const [d] = await decisions(h.proposal.id);
    expect(d).toEqual({
      decision: "accepted", method: "provider_signature", decided_name: "Maria Santos", decided_email: h.email.toLowerCase(), signature_request_id: h.requestId, content_hash: version,
      acknowledgement_version: null, ip_hash: null, decided_at: NOW, recorded_by: null,
    });
    const req = (await rows<{ status: string; completed_at: Date; applied_at: Date; not_applied_reason: string | null; finished_at: Date; copy_next_at: Date }>("select status, completed_at, applied_at, not_applied_reason, finished_at, copy_next_at from signature_requests where id = $1", [h.requestId]))[0];
    expect(req).toMatchObject({ status: "completed", completed_at: NOW, applied_at: NOW, not_applied_reason: null, finished_at: NOW, copy_next_at: NOW });
    expect((await sigEvents(h.requestId)).map((e) => [e.kind, e.source])).toEqual([["created", "user"], ["sent", "system"], ["completed", "provider_webhook"], ["signature_applied", "system"]]);
    const pe = await rows<{ kind: string; actor_kind: string; actor_id: string | null; detail: Record<string, unknown> }>("select kind, actor_kind, actor_id, detail from proposal_events where proposal_id = $1 and kind = 'accepted'", [h.proposal.id]);
    expect(pe).toEqual([{ kind: "accepted", actor_kind: "provider", actor_id: null, detail: { method: "provider_signature", requestId: h.requestId, provider: "simulated", signer: expect.stringMatching(/^m\*\*\*@example\.test$/) } }]);
    const audit = await rows<{ actor_kind: string; metadata: Record<string, unknown> }>("select actor_kind, metadata from audit_logs where org_id = $1 and action = 'proposals.signature_applied'", [p.org.id]);
    expect(audit).toEqual([{ actor_kind: "system", metadata: { version: 1, requestId: h.requestId, provider: "simulated", mode: "simulated" } }]);
    // A simulated signature is stored with its mode, so nothing downstream can mistake it for a real one.
    expect((await rows<{ mode: string }>("select mode from signature_requests where id = $1", [h.requestId]))[0].mode).toBe("simulated");
  });

  it("leaves the customer's own link readable, showing their answer as a signature through a signing service", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "complete");
    expect((await rows("select 1 from proposal_share_links where proposal_id = $1 and revoked_at is null", [h.proposal.id])).length).toBe(1);
    const view = await loadPublicProposal(h.token, { ip: freshIp(), now: NOW });
    expect(view.state).toBe("answered");
    expect(view.answer).toMatchObject({ decision: "accepted", method: "provider_signature" });
  });

  it("does what an acceptance does for the rest of the business: the timeline, both triggers, one notice to the people concerned, a task, and the deal only if the owner said so", async () => {
    const p = await signingOrg();
    const { contactId, dealId } = await withDeal(p);
    await saveProposalSettings(p.actor("owner"), { dealOnAccept: "won_stage" }, 0);
    const h = await handedOver(p, { contactId, opportunityId: dealId });
    await signerActs(p, h.requestId, "complete");
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("won");
    const accepted = await crmEvents(p.org.id, "proposal.accepted");
    const signed = await crmEvents(p.org.id, "signature.completed");
    expect(accepted).toHaveLength(1);
    expect(signed).toEqual([{ payload: { proposalId: h.proposal.id, number: "P-0001", version: 1, requestId: h.requestId, currency: "USD", opportunityId: dealId }, dedupe_key: `signature.completed:${h.proposal.id}:1` }]);
    // Ids and amounts only: no name, address or wording.
    expect(JSON.stringify([accepted, signed])).not.toMatch(/Maria|example\.test|Payment is due/);
    const timeline = await rows<{ kind: string; summary: string }>("select kind, summary from crm_activities where org_id = $1 and kind = 'proposal.accepted'", [p.org.id]);
    expect(timeline).toEqual([{ kind: "proposal.accepted", summary: "Proposal P-0001 signed through the simulated signing service" }]);
    // The people who own the proposal and the deal are told once, in words that say a signing service reported it.
    const n = await notes(p.org.id, "signature_completed");
    expect(n.map((x) => x.user_id).sort()).toEqual([p.people.manager.id, (p.member as { userId: string }).userId].sort());
    expect(n[0]).toMatchObject({ title: "P-0001 was signed", severity: "info", link: `/proposals/${h.proposal.id}` });
    expect(await notes(p.org.id, "proposal_accepted")).toEqual([]);
    expect((await rows<{ title: string }>("select title from tasks where org_id = $1", [p.org.id])).map((t) => t.title)).toEqual(["Confirm next steps for P-0001"]);
  });

  it("leaves the deal alone unless the owner turned it on, and a failed side effect never undoes the signature", async () => {
    const p = await signingOrg();
    const { contactId, dealId } = await withDeal(p);
    const h = await handedOver(p, { contactId, opportunityId: dealId });
    hooks.failNotify = true;
    await signerActs(p, h.requestId, "complete");
    expect((await proposalRow(h.proposal.id)).status).toBe("accepted");
    expect((await decisions(h.proposal.id))).toHaveLength(1);
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("open");
    const failed = await rows<{ detail: Record<string, unknown> }>("select detail from proposal_events where proposal_id = $1 and kind = 'effect_failed'", [h.proposal.id]);
    // Each effect that needed a notification failed on its own and was written down (the task tells its assignee too); the others ran.
    expect(failed.map((f) => f.detail.effect)).toEqual(["notify", "task"]);
    expect(await notes(p.org.id, "signature_completed")).toEqual([]);
    expect(await crmEvents(p.org.id, "signature.completed")).toHaveLength(1);
  });

  it("applies one signature only, however it is repeated: the same notice, a different notice of the same fact, or several at once", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const answers = await Promise.all([1, 2, 3, 4].map((n) => signerActs(p, h.requestId, "complete", { eventId: `complete-${n}` })));
    expect(answers.every((a) => a.status === 200)).toBe(true);
    expect(await decisions(h.proposal.id)).toHaveLength(1);
    expect(await crmEvents(p.org.id, "signature.completed")).toHaveLength(1);
    expect(await notes(p.org.id, "signature_completed")).toHaveLength(1);
    expect(await rows("select 1 from tasks where org_id = $1", [p.org.id])).toHaveLength(1);
    await signerActs(p, h.requestId, "complete", { eventId: "complete-later" });
    expect(await decisions(h.proposal.id)).toHaveLength(1);
    expect((await sigEvents(h.requestId)).filter((e) => e.kind === "signature_applied")).toHaveLength(1);
  });

  it("has a sentence for every reason a signature can be set aside (each is shown below)", () => {
    expect(Object.keys(NOT_APPLIED_TEXT).sort()).toEqual(["already_answered", "expired", "integrity", "proposal_closed", "superseded", "voided"]);
  });
});

describe("a signature that is set aside", () => {
  /** What must be true whatever the reason: the fact is kept, the proposal is untouched, nobody is told it is accepted, and the people who can act are told what happened. */
  async function expectSetAside(p: ProposalOrg, h: { proposal: { id: string }; requestId: string }, reason: keyof typeof NOT_APPLIED_TEXT, proposalAfter: { status: string; version?: number }) {
    const req = await requestRow(h.requestId);
    expect(req).toMatchObject({ status: "completed", applied_at: null, not_applied_reason: reason });
    expect(await decisions(h.proposal.id)).toEqual([]);
    expect(await proposalRow(h.proposal.id)).toMatchObject(proposalAfter);
    expect(await crmEvents(p.org.id, "signature.completed")).toEqual([]);
    expect(await crmEvents(p.org.id, "proposal.accepted")).toEqual([]);
    expect(await notes(p.org.id, "proposal_accepted")).toEqual([]);
    const n = await notes(p.org.id, "signature_completed");
    expect(n.length).toBeGreaterThan(0);
    expect(n[0]).toMatchObject({ title: "P-0001 was signed, but the signature was not applied", severity: "warning", body: NOT_APPLIED_TEXT[reason].slice(0, 300), link: `/proposals/${h.proposal.id}?tab=signature` });
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).toEqual(expect.arrayContaining(["completed", "signature_not_applied"]));
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).not.toContain("signature_applied");
    const pe = await rows<{ detail: Record<string, unknown> }>("select detail from proposal_events where proposal_id = $1 and kind = 'signature_not_applied'", [h.proposal.id]);
    expect(pe).toEqual([{ detail: { requestId: h.requestId, reason } }]);
    // The signed copy is still fetched: the business holds a document it may want.
    expect((await rows<{ copy_next_at: Date | null }>("select copy_next_at from signature_requests where id = $1", [h.requestId]))[0].copy_next_at).not.toBeNull();
    // And it stays set aside however many times it is delivered.
    await signerActs(p, h.requestId, "complete", { eventId: "again" });
    expect(await decisions(h.proposal.id)).toEqual([]);
    expect(await notes(p.org.id, "signature_completed")).toHaveLength(n.length);
  }

  it("superseded: the proposal was revised after the signer was asked, so a signature on the old version is never applied to the new one", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await reviseProposal(p.actor("sales"), h.proposal.id, { now: NOW });
    expect(await requestRow(h.requestId)).toMatchObject({ status: "superseded" });
    expect((await signerActs(p, h.requestId, "complete")).status).toBe(200);
    await expectSetAside(p, h, "superseded", { status: "draft", version: 2 });
    expect((await proposalRow(h.proposal.id)).signature_state).toBe("none");
  });

  it("voided: the ask was withdrawn, so a signature that arrives anyway is kept but not applied", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await withdrawProposal(p.actor("sales"), h.proposal.id, { now: NOW });
    await signerActs(p, h.requestId, "complete");
    await expectSetAside(p, h, "voided", { status: "withdrawn" });
  });

  it("voided: the same when a person withdrew only the request and the proposal is still out", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    const { voidSignatureRequest } = await import("@/server/esign/requests");
    await voidSignatureRequest(p.actor("sales"), h.requestId, { now: NOW });
    await signerActs(p, h.requestId, "complete");
    await expectSetAside(p, h, "voided", { status: "sent" });
  });

  it("expired: the proposal's last day, in the workspace's own calendar, has passed", async () => {
    const p = await signingOrg();
    const h = await handedOver(p, { validUntil: "2026-10-30" });
    await signerActs(p, h.requestId, "complete", { now: new Date("2026-11-02T08:00:00Z") });
    await expectSetAside(p, h, "expired", { status: "sent" });
  });

  it("applies on the last day itself, in the workspace's own time", async () => {
    const p = await signingOrg({ timezone: "Pacific/Auckland" });
    const h = await handedOver(p, { validUntil: "2026-10-30" });
    // Late on the 30th in Auckland is still before midnight there; it is the 30th, 22:00 local, 09:00 UTC.
    await signerActs(p, h.requestId, "complete", { now: new Date("2026-10-30T09:00:00Z") });
    expect(await proposalRow(h.proposal.id)).toMatchObject({ status: "accepted" });
  });

  it("proposal_closed: the proposal was taken back under the request without ending it", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await withSystem((db) => db.query("update proposals set status = 'withdrawn', closed_at = now() where id = $1", [h.proposal.id]));
    await signerActs(p, h.requestId, "complete");
    await expectSetAside(p, h, "proposal_closed", { status: "withdrawn" });
  });

  it("already_answered: somebody else's answer is already recorded for this version", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await withSystem((db) => db.query(
      "insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, recorded_by) select org_id, proposal_id, version, content_hash, 'declined', 'recorded_by_staff', $2 from proposal_versions where proposal_id = $1 and version = 1",
      [h.proposal.id, p.people.owner.id],
    ));
    await signerActs(p, h.requestId, "complete");
    const req = await requestRow(h.requestId);
    expect(req).toMatchObject({ status: "completed", applied_at: null, not_applied_reason: "already_answered" });
    // The one answer there is stays the one that was there.
    expect((await decisions(h.proposal.id)).map((d) => [d.decision, d.method])).toEqual([["declined", "recorded_by_staff"]]);
    expect((await proposalRow(h.proposal.id)).status).toBe("sent");
  });

  it("integrity: the saved version no longer matches what the signer was sent, so nothing is accepted on top of it", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await withSystem(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update proposal_versions set snapshot = jsonb_set(snapshot, '{title}', '\"Something else\"') where proposal_id = $1 and version = 1", [h.proposal.id]);
    });
    await signerActs(p, h.requestId, "complete");
    await expectSetAside(p, h, "integrity", { status: "sent" });
  });

  it("keeps a signature whose request had already ended at the service's side (failed or ran out) from being accepted either", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "expire");
    expect(await requestRow(h.requestId)).toMatchObject({ status: "expired" });
    await signerActs(p, h.requestId, "complete", { eventId: "after-expiry" });
    // An ended request that later reports a signature is recorded and not applied.
    expect(await requestRow(h.requestId)).toMatchObject({ status: "completed", not_applied_reason: "voided", applied_at: null });
    expect(await decisions(h.proposal.id)).toEqual([]);
    expect((await proposalRow(h.proposal.id)).status).toBe("sent");
  });

  it("tells the people concerned even when the notice cannot be written, without losing the fact", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await reviseProposal(p.actor("sales"), h.proposal.id, { now: NOW });
    hooks.failNotify = true;
    await signerActs(p, h.requestId, "complete");
    expect(await requestRow(h.requestId)).toMatchObject({ status: "completed", not_applied_reason: "superseded" });
    expect((await sigEvents(h.requestId)).map((e) => e.kind)).toContain("effect_failed");
    expect(await notes(p.org.id, "signature_completed")).toEqual([]);
  });
});

describe("the service says it did not end in a signature", () => {
  it("a decline leaves the proposal sent, says so once to the team, starts the failure trigger, and lets the sender ask again", async () => {
    const p = await signingOrg();
    const { contactId } = await withDeal(p);
    const h = await handedOver(p, { contactId });
    await signerActs(p, h.requestId, "decline");
    expect(await requestRow(h.requestId)).toMatchObject({ status: "declined" });
    expect(await proposalRow(h.proposal.id)).toMatchObject({ status: "sent", signature_state: "failed" });
    const n = await notes(p.org.id, "signature_failed");
    expect(n.length).toBeGreaterThan(0);
    expect(n[0].title).toBe("The signer declined P-0001");
    expect(n[0].body).toContain("declined to sign. The proposal is still open");
    const ev = await crmEvents(p.org.id, "signature.failed");
    expect(ev).toEqual([{ payload: { proposalId: h.proposal.id, number: "P-0001", version: 1, requestId: h.requestId, reason: "declined", opportunityId: null }, dedupe_key: `signature.failed:${h.requestId}` }]);
    expect((await rows<{ kind: string }>("select kind from proposal_events where proposal_id = $1 and kind = 'signature_declined'", [h.proposal.id]))).toHaveLength(1);
    expect((await rows<{ summary: string }>("select summary from crm_activities where org_id = $1 and kind = 'proposal.signature_failed'", [p.org.id]))[0].summary).toBe("Maria Santos declined to sign proposal P-0001");
    // A decline at the signing service is not the customer's answer on the proposal: nothing is recorded as declined.
    expect(await decisions(h.proposal.id)).toEqual([]);
    const { requestSignature } = await import("@/server/esign/requests");
    const again = await requestSignature(p.actor("sales"), h.proposal.id, {}, { now: NOW });
    expect(again.created).toBe(true);
  });

  it("an expiry at the service is the same: the proposal is still open and can be asked again", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "expire");
    expect(await requestRow(h.requestId)).toMatchObject({ status: "expired" });
    expect(await proposalRow(h.proposal.id)).toMatchObject({ status: "sent", signature_state: "failed" });
    expect((await notes(p.org.id, "signature_failed"))[0].title).toBe("The signing request for P-0001 ran out");
    expect((await crmEvents(p.org.id, "signature.failed"))[0].payload).toMatchObject({ reason: "expired" });
  });

  it("someone withdrawing the document at the service ends the request without telling the team it failed, and without asking the service to do what it just did", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "void");
    expect(await requestRow(h.requestId)).toMatchObject({ status: "voided", cancel_state: "done", void_reason: "The document was withdrawn at the signing service." });
    expect(await proposalRow(h.proposal.id)).toMatchObject({ status: "sent", signature_state: "none" });
    expect(await notes(p.org.id, "signature_failed")).toEqual([]);
  });

  it("is a conflict, kept apart, when the service reports a signature for a request it said was declined", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "decline");
    await signerActs(p, h.requestId, "complete", { eventId: "contradiction" });
    expect(await requestRow(h.requestId)).toMatchObject({ status: "declined" });
    expect(await decisions(h.proposal.id)).toEqual([]);
    expect((await sigEvents(h.requestId)).find((e) => e.provider_event_id === "sim:contradiction")).toMatchObject({ kind: "delivery_ignored", detail: { fact: "completed", why: "conflict", status: "declined" } });
  });
});

describe("what the screens are told afterwards", () => {
  it("shows an applied signature as applied, and a set-aside one with the reason, and neither with a document that is not stored yet", async () => {
    const p = await signingOrg();
    const h = await handedOver(p);
    await signerActs(p, h.requestId, "complete");
    const view = (await getProposal(p.actor("viewer"), h.proposal.id, { now: NOW })).signature.requests[0];
    expect(view).toMatchObject({ status: "completed", applied: true, notAppliedReason: null, copyPending: true, copyGaveUp: false, signedFileId: null, canVoid: false });
    expect(view.explain).toBe("Simulated: this was signed by the stand-in service. It is not a real signature and nothing here is legally binding.");
    const q = await signingOrg();
    const g = await handedOver(q);
    await reviseProposal(q.actor("sales"), g.proposal.id, { now: NOW });
    await signerActs(q, g.requestId, "complete");
    const set = (await getProposal(q.actor("viewer"), g.proposal.id, { now: NOW })).signature.requests[0];
    expect(set).toMatchObject({ status: "completed", applied: false, notAppliedReason: "superseded", notAppliedText: NOT_APPLIED_TEXT.superseded, current: false });
  });
});
