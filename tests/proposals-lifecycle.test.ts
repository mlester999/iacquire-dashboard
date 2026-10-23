// A proposal from approval to the customer's answer on embedded Postgres: an approval is of one version, AI work never goes out unreviewed, a send reaches the CRM once and
// never undoes itself, and the database refuses the states the product must never be in.
import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { createContact } from "@/server/crm/contacts";
import { createOpportunity } from "@/server/crm/opportunities";
import { createTag } from "@/server/crm/tags";
import {
  createProposal, decideProposal, duplicateProposal, getProposal, insertProposalDraft, listProposals, recordOfflineDecision, reviseProposal, sendProposal, submitForApproval, updateProposal, withdrawProposal,
} from "@/server/proposals/proposals";
import { saveProposalSettings } from "@/server/proposals/settings";
import { memberActor } from "@/server/crm/actor";
import { approvedProposal, draftBy, lineOf, proposalOrg, rows, type ProposalOrg } from "./support/proposals";
import { addMember, createUser, ctxFor, uid } from "./support/fixtures";

const NOW = new Date("2026-10-23T12:00:00Z");
const deps = { now: NOW };

const events = (id: string) => rows<{ kind: string; actor_kind: string; version: number | null; detail: Record<string, unknown> }>("select kind, actor_kind, version, detail from proposal_events where proposal_id = $1 order by id", [id]);
const kinds = async (id: string) => (await events(id)).map((e) => e.kind);
const stageId = async (orgId: string, name: string) => (await rows<{ id: string }>("select id from crm_pipeline_stages where org_id = $1 and name = $2", [orgId, name]))[0].id;
const notified = (orgId: string, kind: string) => rows<{ user_id: string }>("select user_id from notifications where org_id = $1 and kind = $2", [orgId, kind]);

async function contactAndDeal(p: ProposalOrg, ownerId?: string) {
  const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
  const deal = await createOpportunity(p.actor("owner"), { name: "Clinic website", contactId: contact.id, value: 1500, currency: "USD", ownerId });
  return { contactId: contact.id, dealId: deal.id };
}

describe("an approval is of one version", () => {
  it("freezes the version when it is submitted, tells the owner and managers, and binds the approval to it", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member");
    const pending = await submitForApproval(p.member, draft.id, deps);
    expect(pending).toMatchObject({ status: "pending_approval", version: 1, approvedVersion: null });
    expect(pending.versions).toHaveLength(1);
    expect(pending.versions[0]).toMatchObject({ version: 1, hasPdf: false, supersededAt: null, sentAt: null });
    expect(pending.versions[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(new Set((await notified(p.org.id, "proposal_approval_requested")).map((n) => n.user_id))).toEqual(new Set([p.people.owner.id, p.people.manager.id, p.coOwner.userId as string]));
    const frozen = (await rows<{ snapshot: { number: string; client: { name: string }; groups: { one_time: { total: number } } } }>("select snapshot from proposal_versions where proposal_id = $1", [draft.id]))[0].snapshot;
    expect(frozen).toMatchObject({ number: "P-0001", client: { name: "Maria Santos" }, groups: { one_time: { total: 168_000 } } });
    const approved = await decideProposal(p.actor("manager"), pending.id, { decision: "approve", version: 1, note: "Looks right." });
    expect(approved).toMatchObject({ status: "approved", approvedVersion: 1, decisionNote: "Looks right.", approvedByName: "Manager Person" });
    const n = await notified(p.org.id, "proposal_approval_decided");
    expect(n.map((x) => x.user_id)).toEqual([p.member.userId]);
    expect(await kinds(draft.id)).toEqual(["created", "submitted", "approved"]);
  });

  it("refuses a decision on a version the reviewer did not see, and one on a proposal not waiting", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member");
    const v1 = await submitForApproval(p.member, draft.id, deps);
    await expect(decideProposal(p.actor("manager"), draft.id, { decision: "approve", version: 1 })).resolves.toMatchObject({ status: "approved" });
    await expect(decideProposal(p.actor("manager"), draft.id, { decision: "approve", version: 1 })).rejects.toThrow(/not waiting for approval/);
    const edited = await updateProposal(p.member, draft.id, { title: "Changed after approval" }, v1.version);
    const v2 = await submitForApproval(p.member, edited.id, deps);
    expect(v2.version).toBe(2);
    await expect(decideProposal(p.actor("manager"), draft.id, { decision: "approve", version: 1 })).rejects.toThrow(/changed while you were reviewing/);
    expect((await decideProposal(p.actor("manager"), draft.id, { decision: "approve", version: 2 })).approvedVersion).toBe(2);
  });

  it("makes a reviewer say what to change, and a rejection is final", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member");
    const pending = await submitForApproval(p.member, draft.id, deps);
    await expect(decideProposal(p.actor("manager"), draft.id, { decision: "request_changes", version: 1 })).rejects.toThrow(/Say what should change/);
    const rejected = await decideProposal(p.actor("manager"), draft.id, { decision: "reject", version: pending.version, note: "Not this quarter." });
    expect(rejected).toMatchObject({ status: "rejected", decisionNote: "Not this quarter." });
    expect(rejected.closedAt).not.toBeNull();
    await expect(updateProposal(p.member, draft.id, { title: "x" }, 1)).rejects.toThrow(/rejected/);
    await expect(reviseProposal(p.actor("owner"), draft.id)).rejects.toThrow(/can't be revised/);
    await expect(sendProposal(p.actor("owner"), draft.id)).rejects.toThrow(/can't be sent/);
    // Copying it starts again, from a draft.
    expect((await duplicateProposal(p.member, draft.id)).status).toBe("draft");
  });

  it("lets the owner approve their own work unless the workspace asked for two people", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const own = await draftBy(p, "owner");
    const pending = await submitForApproval(owner, own.id, deps);
    expect((await decideProposal(owner, pending.id, { decision: "approve", version: 1 })).status).toBe("approved");
    await saveProposalSettings(owner, { twoPerson: true }, 0);
    const second = await draftBy(p, "owner");
    const pendingSecond = await submitForApproval(owner, second.id, deps);
    await expect(decideProposal(owner, second.id, { decision: "approve", version: 1 })).rejects.toThrow(/second person/);
    expect((await decideProposal(p.coOwner, second.id, { decision: "approve", version: pendingSecond.version })).status).toBe("approved");
  });

  it("counts the person who sent a version for approval as its author too", async () => {
    const p = await proposalOrg();
    await saveProposalSettings(p.actor("owner"), { twoPerson: true }, 0);
    const draft = await draftBy(p, "member");
    // A manager may send someone else's draft for review; having done so, they cannot also be the one who approves it.
    await submitForApproval(p.actor("manager"), draft.id, deps);
    await expect(decideProposal(p.actor("manager"), draft.id, { decision: "approve", version: 1 })).rejects.toThrow(/second person/);
    expect((await decideProposal(p.actor("owner"), draft.id, { decision: "approve", version: 1 })).status).toBe("approved");
  });

  it("stops a submission that could not be sent, and says why in words", async () => {
    const p = await proposalOrg();
    const sales = p.actor("sales");
    const empty = await createProposal(sales, { title: "Empty", clientName: "Maria" });
    await expect(submitForApproval(sales, empty.id, deps)).rejects.toThrow(/at least one priced line/);
    const noName = await createProposal(sales, { title: "Nameless", doc: { lines: [lineOf(p.item)] } });
    await expect(submitForApproval(sales, noName.id, deps)).rejects.toThrow(/who the proposal is for/);
    const stale = await createProposal(sales, { title: "Stale", clientName: "Maria", validUntil: "2026-10-01", doc: { lines: [lineOf(p.item)] } });
    await expect(submitForApproval(sales, stale.id, deps)).rejects.toThrow(/already passed/);
    const token = await createProposal(sales, { title: "Token", clientName: "Maria", doc: { lines: [lineOf(p.item)], terms: "Prepared for {{client.company}} {{oops}}" } });
    await expect(submitForApproval(sales, token.id, deps)).rejects.toThrow(/customer's company/);
    const emoji = await createProposal(sales, { title: "Launch 🚀", clientName: "Maria", doc: { lines: [lineOf(p.item)] } });
    await expect(submitForApproval(sales, emoji.id, deps)).rejects.toThrow(/PDF can't show/);
    // Nothing was frozen for any of them.
    expect((await rows("select 1 from proposal_versions where org_id = $1", [p.org.id])).length).toBe(0);
    // The last day still counts.
    const lastDay = await createProposal(sales, { title: "Last day", clientName: "Maria", validUntil: "2026-10-23", doc: { lines: [lineOf(p.item)] } });
    expect((await submitForApproval(sales, lastDay.id, deps)).status).toBe("pending_approval");
  });

  it("freezes a version once: submitting again without a change reuses it, and the stored text never changes", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member");
    await submitForApproval(p.member, draft.id, deps);
    await decideProposal(p.actor("manager"), draft.id, { decision: "request_changes", version: 1, note: "Fine, but check the terms." });
    const again = await submitForApproval(p.member, draft.id, deps);
    expect(again.versions).toHaveLength(1);
    expect(again.status).toBe("pending_approval");
    await expect(withSystem((db) => db.query("update proposal_versions set snapshot = '{}'::jsonb where proposal_id = $1", [draft.id]))).rejects.toThrow(/cannot be changed once saved/);
    await expect(withSystem((db) => db.query("update proposal_versions set content_hash = repeat('0', 64) where proposal_id = $1", [draft.id]))).rejects.toThrow(/cannot be changed once saved/);
  });
});

describe("what never goes out without a person", () => {
  it("keeps an AI draft from being sent, whatever the settings and whoever asks, until a person approves it", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const row = await withSystem((db) => insertProposalDraft(db, owner, { title: "AI proposal", clientName: "Maria", doc: { lines: [lineOf(p.item)] } }, "ai", null));
    expect(row.origin).toBe("ai");
    const evs = await events(row.id);
    expect(evs[0]).toMatchObject({ kind: "ai_drafted", actor_kind: "ai" });
    await saveProposalSettings(owner, { approvalMode: "ai_and_discounts", discountNeedsApproval: false, twoPerson: false, approvalOverMinor: null }, 0);
    await expect(sendProposal(owner, row.id, {}, deps)).rejects.toThrow(/AI draft always needs a person's approval/);
    await expect(sendProposal(p.actor("manager"), row.id, {}, deps)).rejects.toThrow(/AI draft always needs/);
    const pending = await submitForApproval(owner, row.id, deps);
    expect(pending.origin).toBe("ai");
    expect(pending.approval.reasons).toContain("ai_draft");
    const approved = await decideProposal(owner, row.id, { decision: "approve", version: pending.version });
    expect(approved.approvedByName).toBe("Owner Person");
    const sent = await sendProposal(owner, row.id, {}, deps);
    expect(sent.status).toBe("sent");
    // Editing it takes the approval away, and it still cannot be sent on the owner's say-so alone.
    const revised = await reviseProposal(owner, row.id);
    expect(revised).toMatchObject({ status: "draft", origin: "ai", approvedVersion: null });
    await expect(sendProposal(owner, row.id, {}, deps)).rejects.toThrow(/AI draft always needs/);
  });

  it("keeps a copy of an AI draft an AI draft", async () => {
    const p = await proposalOrg();
    const row = await withSystem((db) => insertProposalDraft(db, p.actor("owner"), { title: "AI proposal", clientName: "Maria", doc: { lines: [lineOf(p.item)] } }, "ai", null));
    const copy = await duplicateProposal(p.actor("sales"), row.id);
    expect(copy.origin).toBe("ai");
    await expect(sendProposal(p.actor("sales"), copy.id, {}, deps)).rejects.toThrow(/AI draft always needs/);
  });

  it("is enforced by the database too: an AI proposal cannot be approved or sent without a person named", async () => {
    const p = await proposalOrg();
    const row = await withSystem((db) => insertProposalDraft(db, p.actor("owner"), { title: "AI proposal", clientName: "Maria", doc: { lines: [lineOf(p.item)] } }, "ai", null));
    await expect(withSystem((db) => db.query("update proposals set status = 'approved', approved_version = version, approved_at = now() where id = $1", [row.id]))).rejects.toThrow(/violates check constraint/);
    await expect(withSystem((db) => db.query("update proposals set status = 'sent', approved_version = version, approved_at = now(), sent_version = version, sent_at = now(), sent_by = $2 where id = $1", [row.id, p.people.owner.id]))).rejects.toThrow(/violates check constraint/);
  });

  it("needs a second look for a discount, a large total, or when the workspace reviews everything", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const manager = p.actor("manager");
    const discounted = await createProposal(manager, { title: "Discounted", clientName: "Maria", doc: { lines: [lineOf(p.item, 1000, { discount: { kind: "percent", bps: 1000 } })] } });
    await expect(sendProposal(manager, discounted.id, {}, deps)).rejects.toThrow(/discount or sets a price below/);
    await saveProposalSettings(owner, { discountNeedsApproval: false }, 0);
    const sent = await sendProposal(manager, discounted.id, {}, deps);
    expect(sent.status).toBe("sent");
    expect(await kinds(discounted.id)).toContain("self_approved");
    const big = await draftBy(p, "sales");
    await saveProposalSettings(owner, { approvalOverMinor: 100_000 }, 1);
    await expect(sendProposal(p.actor("sales"), big.id, {}, deps)).rejects.toThrow(/above the amount/);
    await saveProposalSettings(owner, { approvalOverMinor: 168_000 }, 2);
    expect((await sendProposal(p.actor("sales"), big.id, {}, deps)).status).toBe("sent");
    const reviewed = await draftBy(p, "sales");
    await saveProposalSettings(owner, { approvalMode: "all" }, 3);
    await expect(sendProposal(p.actor("sales"), reviewed.id, {}, deps)).rejects.toThrow(/every proposal approved/);
  });

  it("is approved by the author's own act of sending when nothing requires a second look, and says so in the history", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    const sent = await sendProposal(p.actor("sales"), draft.id, {}, deps);
    expect(sent).toMatchObject({ status: "sent", sentVersion: 1, approvedVersion: 1, approvedByName: "Sales Person", sentByName: "Sales Person" });
    expect(await kinds(draft.id)).toEqual(["created", "self_approved", "sent", "link_created"]);
    const audit = await rows<{ action: string; metadata: { self?: boolean } }>("select action, metadata from audit_logs where org_id = $1 and target_id = $2 order by created_at", [p.org.id, draft.id]);
    expect(audit.find((a) => a.action === "proposals.approved")?.metadata.self).toBe(true);
  });

  it("does not let someone send a draft that is not theirs unless they can approve it, nor one its author could not send", async () => {
    const p = await proposalOrg();
    const owners = await draftBy(p, "owner");
    await expect(sendProposal(p.actor("sales"), owners.id, {}, deps)).rejects.toThrow(/Only the person who wrote/);
    expect((await sendProposal(p.actor("manager"), owners.id, {}, deps)).status).toBe("sent");
    const members = await draftBy(p, "member");
    await expect(sendProposal(p.actor("sales"), members.id, {}, deps)).rejects.toThrow(/can write proposals but not send them/);
    await expect(sendProposal(p.actor("manager"), members.id, {}, deps)).rejects.toThrow(/can write proposals but not send them/);
  });
});

describe("sending", () => {
  it("marks an approved version as sent: the frozen version, who sent it, and the history", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p);
    const sent = await sendProposal(p.actor("sales"), approved.id, { version: approved.version }, deps);
    expect(sent).toMatchObject({ status: "sent", sentVersion: 1, sentByName: "Sales Person", closedAt: null });
    expect(sent.sentAt).not.toBeNull();
    expect(sent.versions[0].sentAt).not.toBeNull();
    expect(await kinds(approved.id)).toEqual(["created", "submitted", "approved", "sent", "link_created"]);
    // Sending twice records nothing new.
    await expect(sendProposal(p.actor("sales"), approved.id, {}, deps)).rejects.toThrow(/can't be sent/);
    expect(await kinds(approved.id)).toHaveLength(5);
    await expect(sendProposal(p.actor("sales"), approved.id, { version: 7 }, deps)).rejects.toThrow(/changed/);
  });

  it("refuses to send what was changed around the approval, even though the version number did not move", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p);
    await withSystem((db) => db.query("update proposals set doc = jsonb_set(doc, '{terms}', '\"Pay me double\"') where id = $1", [approved.id]));
    await expect(sendProposal(p.actor("sales"), approved.id, {}, deps)).rejects.toThrow(/changed without a new version/);
    expect((await getProposal(p.actor("owner"), approved.id, deps)).status).toBe("approved");
  });

  it("refuses to send a saved version that no longer matches its record", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p);
    // The trigger forbids this; switching it off models someone with direct access to the database.
    await withSystem(async (db) => {
      await db.query("alter table proposal_versions disable trigger proposal_versions_frozen");
      await db.query("update proposal_versions set snapshot = jsonb_set(snapshot, '{terms}', '\"Edited in the database\"') where proposal_id = $1", [approved.id]);
      await db.query("alter table proposal_versions enable trigger proposal_versions_frozen");
    });
    await expect(sendProposal(p.actor("sales"), approved.id, {}, deps)).rejects.toThrow(/does not match its record/);
  });

  it("checks again at the send: a date that has passed since the approval stops it", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p, { validUntil: "2026-11-01" }, deps);
    await expect(sendProposal(p.actor("sales"), approved.id, {}, { now: new Date("2026-11-02T12:00:00Z") })).rejects.toThrow(/already passed/);
    expect((await sendProposal(p.actor("sales"), approved.id, {}, { now: new Date("2026-11-01T23:00:00Z") })).status).toBe("sent");
  });

  it("lets a proposal that needs a signature be approved, but not sent while no signing service exists; the signing can be recorded as done offline", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member", { requiresSignature: true });
    const pending = await submitForApproval(p.member, draft.id, deps);
    expect(pending.problems.find((x) => x.code === "signature_unavailable")).toMatchObject({ level: "blocking", stopsAt: "send" });
    const approved = await decideProposal(p.actor("manager"), draft.id, { decision: "approve", version: 1 });
    expect(approved.status).toBe("approved");
    await expect(sendProposal(p.actor("sales"), draft.id, {}, deps)).rejects.toThrow(/no signing service is connected/);
    const accepted = await recordOfflineDecision(p.actor("manager"), draft.id, { decision: "accepted", note: "Signed the printed copy in the office." });
    expect(accepted).toMatchObject({ status: "accepted", signatureState: "recorded_offline" });
    expect(await kinds(draft.id)).toContain("delivered_offline");
  });
});

describe("what a send and an answer do to the CRM", () => {
  it("writes the timeline and one automation event, with ids and totals but no names or addresses, and touches nothing else", async () => {
    const p = await proposalOrg();
    const { contactId, dealId } = await contactAndDeal(p);
    const draft = await draftBy(p, "sales", { opportunityId: dealId });
    expect(draft.contactId).toBe(contactId);
    const before = await rows<{ stage_ref: string }>("select stage_ref from crm_opportunities where id = $1", [dealId]);
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    const activity = await rows<{ kind: string; summary: string; contact_id: string; opportunity_id: string; ref_type: string; ref_id: string }>("select kind, summary, contact_id, opportunity_id, ref_type, ref_id from crm_activities where kind = 'proposal.sent' and org_id = $1", [p.org.id]);
    expect(activity).toEqual([{ kind: "proposal.sent", summary: "Proposal P-0001 sent", contact_id: contactId, opportunity_id: dealId, ref_type: "proposal", ref_id: draft.id }]);
    const ev = await rows<{ type: string; contact_id: string; payload: Record<string, unknown>; dedupe_key: string }>("select type, contact_id, payload, dedupe_key from crm_events where org_id = $1 and type = 'proposal.sent'", [p.org.id]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ contact_id: contactId, dedupe_key: `proposal.sent:${draft.id}:1` });
    expect(ev[0].payload).toMatchObject({ proposalId: draft.id, number: "P-0001", version: 1, currency: "USD", oneTimeTotalMinor: 168_000, opportunityId: dealId });
    expect(JSON.stringify(ev[0].payload)).not.toMatch(/Maria|Santos|example\.test/);
    // Off by default: no tag, and the deal stays where it was.
    expect(await rows("select 1 from crm_contact_tags where contact_id = $1", [contactId])).toHaveLength(0);
    expect(await rows("select stage_ref from crm_opportunities where id = $1", [dealId])).toEqual(before);
  });

  it("adds the chosen tag and moves the deal forward when the owner turned those on, and never backwards or out of a closed deal", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const tag = await createTag(owner, { name: "proposal-sent" });
    const { contactId, dealId } = await contactAndDeal(p);
    const proposalSentStage = await stageId(p.org.id, "Proposal Sent");
    await saveProposalSettings(owner, { tagOnSendId: tag.id, stageOnSendId: proposalSentStage }, 0);
    await sendProposal(p.actor("sales"), (await draftBy(p, "sales", { opportunityId: dealId })).id, {}, deps);
    expect((await rows<{ tag_id: string }>("select tag_id from crm_contact_tags where contact_id = $1", [contactId])).map((t) => t.tag_id)).toEqual([tag.id]);
    expect((await rows<{ stage_ref: string }>("select stage_ref from crm_opportunities where id = $1", [dealId]))[0].stage_ref).toBe(proposalSentStage);
    expect((await rows("select 1 from crm_opportunity_history where opportunity_id = $1", [dealId])).length).toBe(2);
    // A deal that is further along stays where it is, and says why.
    const far = await contactAndDeal(p);
    const negotiation = await stageId(p.org.id, "Negotiation");
    await withSystem((db) => db.query("update crm_opportunities set stage_ref = $2, stage_name = 'Negotiation' where id = $1", [far.dealId, negotiation]));
    const farDraft = await draftBy(p, "sales", { opportunityId: far.dealId });
    await sendProposal(p.actor("sales"), farDraft.id, {}, deps);
    expect((await rows<{ stage_ref: string }>("select stage_ref from crm_opportunities where id = $1", [far.dealId]))[0].stage_ref).toBe(negotiation);
    expect((await events(farDraft.id)).find((e) => e.kind === "effect_skipped")?.detail).toMatchObject({ effect: "stage_on_send", reason: "The deal is already further along than that stage." });
    // A closed deal is left alone.
    const closed = await contactAndDeal(p);
    await withSystem((db) => db.query("update crm_opportunities set status = 'won', closed_at = now() where id = $1", [closed.dealId]));
    const closedDraft = await draftBy(p, "sales", { opportunityId: closed.dealId });
    await sendProposal(p.actor("sales"), closedDraft.id, {}, deps);
    expect((await events(closedDraft.id)).find((e) => e.kind === "effect_skipped")?.detail).toMatchObject({ reason: "The deal is already closed." });
  });

  it("moves the deal to Won when a proposal is accepted only if the owner chose that, and makes a task for the owner of the proposal", async () => {
    const p = await proposalOrg();
    const owner = p.actor("owner");
    const { contactId, dealId } = await contactAndDeal(p, p.people.manager.id);
    const draft = await draftBy(p, "sales", { opportunityId: dealId });
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    const accepted = await recordOfflineDecision(owner, draft.id, { decision: "accepted" });
    expect(accepted.status).toBe("accepted");
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [dealId]))[0].status).toBe("open");
    const tasks = await rows<{ title: string; assigned_user_id: string; contact_id: string; opportunity_id: string }>("select title, assigned_user_id, contact_id, opportunity_id from tasks where org_id = $1", [p.org.id]);
    expect(tasks).toEqual([{ title: "Confirm next steps for P-0001", assigned_user_id: p.people.sales.id, contact_id: contactId, opportunity_id: dealId }]);
    // The person who owns the proposal and the person who owns the deal.
    expect((await notified(p.org.id, "proposal_accepted")).map((n) => n.user_id).sort()).toEqual([p.people.sales.id, p.people.manager.id].sort());
    await saveProposalSettings(owner, { dealOnAccept: "won_stage" }, 0);
    const second = await contactAndDeal(p);
    const draft2 = await draftBy(p, "sales", { opportunityId: second.dealId });
    await sendProposal(p.actor("sales"), draft2.id, {}, deps);
    await recordOfflineDecision(owner, draft2.id, { decision: "accepted" });
    expect((await rows<{ status: string }>("select status from crm_opportunities where id = $1", [second.dealId]))[0].status).toBe("won");
  });

  it("writes a failed effect on the history and still records the answer", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    // The person who owns the proposal has left the team, so a task cannot be assigned to them.
    const outsider = await createUser();
    await withSystem((db) => db.query("update proposals set owner_user_id = $2 where id = $1", [draft.id, outsider.id]));
    const accepted = await recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted" });
    expect(accepted.status).toBe("accepted");
    const failed = (await events(draft.id)).filter((e) => e.kind === "effect_failed");
    expect(failed.map((e) => e.detail.effect)).toEqual(["task"]);
    expect(String(failed[0].detail.message)).toMatch(/teammate/);
    expect((await rows("select 1 from proposal_decisions where proposal_id = $1", [draft.id])).length).toBe(1);
  });

  it("tells the people concerned when a customer's answer is recorded, once", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    await recordOfflineDecision(p.actor("manager"), draft.id, { decision: "declined", note: "Went with someone else." });
    const n = await rows<{ user_id: string; title: string; dedupe_key: string }>("select user_id, title, dedupe_key from notifications where org_id = $1 and kind = 'proposal_declined'", [p.org.id]);
    expect(n).toEqual([{ user_id: p.people.sales.id, title: "Decline recorded for P-0001", dedupe_key: `proposal-declined:${draft.id}:1` }]);
  });
});

describe("withdrawing, revising and copying", () => {
  it("withdraws a sent proposal: the customer's link is closed, the timeline says so, and it can be revised", async () => {
    const p = await proposalOrg();
    const { dealId } = await contactAndDeal(p);
    const draft = await draftBy(p, "sales", { opportunityId: dealId });
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    // The send made the customer's link.
    expect((await rows("select 1 from proposal_share_links where proposal_id = $1 and revoked_at is null", [draft.id])).length).toBe(1);
    await expect(withdrawProposal(p.actor("viewer"), draft.id)).rejects.toThrow(/Only the person who wrote/);
    const withdrawn = await withdrawProposal(p.actor("sales"), draft.id);
    expect(withdrawn).toMatchObject({ status: "withdrawn" });
    expect(withdrawn.closedAt).not.toBeNull();
    expect((await rows<{ revoked_at: Date | null }>("select revoked_at from proposal_share_links where proposal_id = $1", [draft.id]))[0].revoked_at).not.toBeNull();
    expect((await rows("select 1 from crm_activities where kind = 'proposal.withdrawn' and org_id = $1", [p.org.id])).length).toBe(1);
    await expect(withdrawProposal(p.actor("sales"), draft.id)).rejects.toThrow(/can't be withdrawn/);
    await expect(recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted" })).rejects.toThrow(/approved or sent/);
    const revised = await reviseProposal(p.actor("sales"), draft.id);
    expect(revised).toMatchObject({ status: "draft", version: 2, approvedVersion: null, closedAt: null });
  });

  it("withdraws a draft too, without telling the CRM anything", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    expect((await withdrawProposal(p.actor("sales"), draft.id)).status).toBe("withdrawn");
    expect((await rows("select 1 from crm_activities where org_id = $1", [p.org.id])).length).toBe(0);
  });

  it("revises a sent proposal into the next version: same wording, no approval, the old version superseded, the link closed", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    expect((await rows("select 1 from proposal_share_links where proposal_id = $1 and revoked_at is null", [draft.id])).length).toBe(1);
    const revised = await reviseProposal(p.actor("sales"), draft.id);
    expect(revised).toMatchObject({ status: "draft", version: 2, approvedVersion: null, sentVersion: 1 });
    expect(revised.doc.lines).toEqual(draft.doc.lines);
    const versions = await rows<{ version: number; superseded_at: Date | null; sent_at: Date | null }>("select version, superseded_at, sent_at from proposal_versions where proposal_id = $1", [draft.id]);
    expect(versions).toHaveLength(1);
    expect(versions[0].superseded_at).not.toBeNull();
    expect(versions[0].sent_at).not.toBeNull();
    expect((await rows<{ revoked_at: Date | null }>("select revoked_at from proposal_share_links where proposal_id = $1", [draft.id]))[0].revoked_at).not.toBeNull();
    // The new version goes through approval or its own send like any other.
    const second = await sendProposal(p.actor("sales"), draft.id, {}, deps);
    expect(second).toMatchObject({ status: "sent", sentVersion: 2, version: 2 });
    expect(second.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(await kinds(draft.id)).toEqual(["created", "self_approved", "sent", "link_created", "revised", "self_approved", "sent", "link_created"]);
  });

  it("revises a declined or expired proposal, and never an accepted one or a draft", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await expect(reviseProposal(p.actor("sales"), draft.id)).rejects.toThrow(/can't be revised/);
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    await recordOfflineDecision(p.actor("owner"), draft.id, { decision: "declined" });
    expect((await reviseProposal(p.actor("sales"), draft.id)).status).toBe("draft");
    const second = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), second.id, {}, deps);
    await recordOfflineDecision(p.actor("owner"), second.id, { decision: "accepted" });
    await expect(reviseProposal(p.actor("owner"), second.id)).rejects.toThrow(/accepted proposal can't be revised/);
    await expect(withdrawProposal(p.actor("owner"), second.id)).rejects.toThrow(/can't be withdrawn/);
    await expect(updateProposal(p.actor("owner"), second.id, { title: "x" }, 1)).rejects.toThrow(/accepted proposal can't be changed/);
    // An amendment is a new proposal.
    const amendment = await duplicateProposal(p.actor("sales"), second.id);
    expect(amendment).toMatchObject({ status: "draft", version: 1, number: "P-0003" });
  });

  it("copies the wording and the lines into a new draft with its own number, and drops a valid-until date that has passed", async () => {
    const p = await proposalOrg();
    const src = await draftBy(p, "owner", { validUntil: "2026-10-01" });
    const copy = await duplicateProposal(p.actor("sales"), src.id, deps);
    expect(copy).toMatchObject({ number: "P-0002", status: "draft", version: 1, title: src.title, clientName: src.clientName, validUntil: null, ownerId: p.people.sales.id });
    expect(copy.doc.lines).toEqual(src.doc.lines);
    expect(await kinds(copy.id)).toEqual(["created", "duplicated"]);
    const future = await draftBy(p, "owner", { validUntil: "2026-12-31" });
    expect((await duplicateProposal(p.actor("sales"), future.id, deps)).validUntil).toBe("2026-12-31");
    await expect(duplicateProposal(p.actor("viewer"), src.id)).rejects.toThrow(/can't write proposals/);
  });
});

describe("an answer recorded by a person", () => {
  it("is recorded as the person's word, bound to the version's hash, and never as a signature", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales", { clientEmail: "maria@example.test" });
    const sent = await sendProposal(p.actor("sales"), draft.id, {}, deps);
    const hash = sent.versions[0].contentHash;
    const done = await recordOfflineDecision(p.actor("manager"), draft.id, { decision: "accepted", note: "She said yes on the phone.", decidedName: "Maria S." });
    expect(done).toMatchObject({ status: "accepted", signatureState: "none" });
    expect(done.closedAt).not.toBeNull();
    expect(done.decisions).toEqual([expect.objectContaining({ decision: "accepted", method: "recorded_by_staff", decidedName: "Maria S.", decidedEmail: "maria@example.test", note: "She said yes on the phone.", contentHash: hash, recordedByName: "Manager Person", acknowledgementVersion: null })]);
    expect((await events(draft.id)).at(-1)).toMatchObject({ kind: "accepted", actor_kind: "user", detail: { method: "recorded_by_staff", hasScan: false } });
    await expect(recordOfflineDecision(p.actor("manager"), draft.id, { decision: "declined" })).rejects.toThrow(/approved or sent/);
    const audit = await rows("select 1 from audit_logs where org_id = $1 and action = 'proposals.decision_recorded'", [p.org.id]);
    expect(audit).toHaveLength(1);
  });

  it("is for the owner and managers only, for a version the person saw, and once", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    for (const who of ["sales", "viewer"] as const) await expect(recordOfflineDecision(p.actor(who), draft.id, { decision: "accepted" })).rejects.toThrow(/owner or a manager/);
    await expect(recordOfflineDecision(p.member, draft.id, { decision: "accepted" })).rejects.toThrow(/owner or a manager/);
    await expect(recordOfflineDecision(p.actor("owner"), draft.id, { decision: "maybe" as never })).rejects.toThrow(/accepted or declined/);
    await expect(recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted", version: 9 })).rejects.toThrow(/changed/);
    await recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted" });
    await expect(recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted" })).rejects.toThrow(/approved or sent/);
    // The database allows one accepted or declined answer per version, whatever the code does.
    await expect(withSystem((db) => db.query(
      "insert into proposal_decisions (org_id, proposal_id, version, content_hash, decision, method, recorded_by) values ($1, $2, 1, repeat('a', 64), 'declined', 'recorded_by_staff', $3)", [p.org.id, draft.id, p.people.owner.id],
    ))).rejects.toThrow(/duplicate key/);
  });

  it("takes a stored scan from this workspace's proposal documents and nothing else", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const file = (org: string, bucket = "proposal-documents") => withSystem(async (db) => (await db.query<{ id: string }>(
      "insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, $2, $3, 'scan.pdf', 'application/pdf', 100, 'ready') returning id", [org, bucket, `${org}/${uid()}/scan.pdf`],
    )).rows[0].id);
    const draft = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    await expect(recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted", attestationFileId: await file(other.org.id) })).rejects.toThrow(/not found among this workspace's proposal documents/);
    await expect(recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted", attestationFileId: await file(p.org.id, "social-media") })).rejects.toThrow(/not found among/);
    const mine = await file(p.org.id);
    const done = await recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted", attestationFileId: mine });
    expect(done.decisions[0]).toBeDefined();
    expect((await rows<{ attestation_file_id: string }>("select attestation_file_id from proposal_decisions where proposal_id = $1", [draft.id]))[0].attestation_file_id).toBe(mine);
    expect((await events(draft.id)).at(-1)?.detail).toMatchObject({ hasScan: true });
    // Removing the stored file clears the reference and leaves the decision as it was.
    await withSystem((db) => db.query("delete from private_files where id = $1", [mine]));
    expect((await rows<{ attestation_file_id: string | null; decision: string }>("select attestation_file_id, decision from proposal_decisions where proposal_id = $1", [draft.id]))[0]).toEqual({ attestation_file_id: null, decision: "accepted" });
  });

  it("is append-only: a recorded answer and the history cannot be changed or removed", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    await sendProposal(p.actor("sales"), draft.id, {}, deps);
    await recordOfflineDecision(p.actor("owner"), draft.id, { decision: "accepted" });
    await expect(withSystem((db) => db.query("update proposal_decisions set decision = 'declined' where proposal_id = $1", [draft.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("update proposal_decisions set note = 'edited' where proposal_id = $1", [draft.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from proposal_decisions where proposal_id = $1", [draft.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("update proposal_events set kind = 'nothing' where proposal_id = $1", [draft.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from proposal_events where proposal_id = $1", [draft.id]))).rejects.toThrow(/append-only/);
    await expect(withSystem((db) => db.query("delete from proposals where id = $1", [draft.id]))).rejects.toThrow(/append-only/);
  });
});

describe("what the database refuses", () => {
  it("never holds an approved or sent state for a version that is not the current one", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p);
    await expect(withSystem((db) => db.query("update proposals set version = version + 1 where id = $1", [approved.id]))).rejects.toThrow(/violates check constraint/);
    await expect(withSystem((db) => db.query("update proposals set status = 'sent' where id = $1", [approved.id]))).rejects.toThrow(/violates check constraint/);
    await expect(withSystem((db) => db.query("update proposals set status = 'accepted', closed_at = now() where id = $1", [approved.id]))).rejects.toThrow(/violates check constraint/);
    await expect(withSystem((db) => db.query("update proposals set approved_version = 3 where id = $1", [approved.id]))).rejects.toThrow(/violates check constraint/);
    await expect(withSystem((db) => db.query("update proposals set status = 'withdrawn' where id = $1", [approved.id]))).rejects.toThrow(/violates check constraint/);
  });

  it("freezes the delivery facts of a version once set, and lets the stored PDF go but not be swapped", async () => {
    const p = await proposalOrg();
    const sent = await sendProposal(p.actor("sales"), (await draftBy(p, "sales")).id, {}, deps);
    // Sending stored the version's PDF (see tests/proposals-documents.test.ts); that file and its hash are what the version now carries.
    const stored = (await rows<{ pdf_file_id: string; pdf_sha256: string }>("select pdf_file_id, pdf_sha256 from proposal_versions where proposal_id = $1", [sent.id]))[0];
    expect(stored.pdf_file_id).toBeTruthy();
    const fileA = stored.pdf_file_id;
    const fileB = await withSystem(async (db) => (await db.query<{ id: string }>("insert into private_files (org_id, bucket, storage_key, filename, mime_type, size_bytes, status) values ($1, 'proposal-documents', $2, 'b.pdf', 'application/pdf', 10, 'ready') returning id", [p.org.id, `${p.org.id}/b/b.pdf`])).rows[0].id);
    await expect(withSystem((db) => db.query("update proposal_versions set pdf_file_id = $2 where proposal_id = $1", [sent.id, fileB]))).rejects.toThrow(/cannot be changed once set/);
    await expect(withSystem((db) => db.query("update proposal_versions set pdf_sha256 = repeat('2', 64) where proposal_id = $1", [sent.id]))).rejects.toThrow(/cannot be changed once set/);
    await expect(withSystem((db) => db.query("update proposal_versions set sent_at = now() + interval '1 day' where proposal_id = $1", [sent.id]))).rejects.toThrow(/cannot be changed once set/);
    await withSystem((db) => db.query("delete from private_files where id = $1", [fileA]));
    expect((await rows<{ pdf_file_id: string | null; pdf_sha256: string }>("select pdf_file_id, pdf_sha256 from proposal_versions where proposal_id = $1", [sent.id]))[0]).toEqual({ pdf_file_id: null, pdf_sha256: stored.pdf_sha256 });
  });

  it("refuses a link, a template or an AI run that names another workspace's row", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const mine = await draftBy(a, "owner");
    const theirs = await contactAndDeal(b);
    await expect(withSystem((db) => db.query("update proposals set contact_id = $2 where id = $1", [mine.id, theirs.contactId]))).rejects.toThrow(/foreign key/);
    await expect(withSystem((db) => db.query("update proposals set opportunity_id = $2 where id = $1", [mine.id, theirs.dealId]))).rejects.toThrow(/foreign key/);
    const theirTag = await createTag(b.actor("owner"), { name: "Their tag" });
    await saveProposalSettings(a.actor("owner"), { approvalMode: "all" }, 0);
    await expect(withSystem((db) => db.query("update proposal_settings set tag_on_send_id = $2 where org_id = $1", [a.org.id, theirTag.id]))).rejects.toThrow(/foreign key/);
    await expect(withSystem((db) => db.query("insert into proposal_catalog_items (org_id, name, unit_price_minor, currency, tax_rate_id) values ($1, 'x', 1, 'USD', $2)", [a.org.id, b.tax.id]))).rejects.toThrow(/foreign key/);
  });
});

describe("one workspace never sees or changes another's proposals", () => {
  it("reads, lists and changes only its own, and treats another workspace's id as not found", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const mine = await draftBy(a, "owner");
    await draftBy(b, "owner");
    expect((await listProposals(a.actor("owner"))).map((x) => x.id)).toEqual([mine.id]);
    expect((await listProposals(b.actor("owner"))).map((x) => x.id)).not.toContain(mine.id);
    const attempts: Array<[string, Promise<unknown>]> = [
      ["get", getProposal(b.actor("owner"), mine.id)],
      ["update", updateProposal(b.actor("owner"), mine.id, { title: "Hijacked" }, 1)],
      ["submit", submitForApproval(b.actor("owner"), mine.id, deps)],
      ["decide", decideProposal(b.actor("owner"), mine.id, { decision: "approve", version: 1 })],
      ["send", sendProposal(b.actor("owner"), mine.id, {}, deps)],
      ["withdraw", withdrawProposal(b.actor("owner"), mine.id)],
      ["revise", reviseProposal(b.actor("owner"), mine.id)],
      ["duplicate", duplicateProposal(b.actor("owner"), mine.id)],
      ["record", recordOfflineDecision(b.actor("owner"), mine.id, { decision: "accepted" })],
    ];
    for (const [what, promise] of attempts) await expect(promise, what).rejects.toThrow(/not found/);
    expect((await getProposal(a.actor("owner"), mine.id)).title).toBe("Website proposal");
    expect(await kinds(mine.id)).toEqual(["created"]);
  });

  it("is read under row-level security for a member: nothing from another workspace, whatever the query", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    await draftBy(a, "owner");
    const mine = await draftBy(b, "owner");
    const seen = await withSystem(async (db) => {
      await db.query("select set_config('app.user_id', $1, true)", [b.people.viewer.id]);
      await db.query("set local role iaq_app_user");
      const proposals = (await db.query<{ id: string; org_id: string }>("select id, org_id from proposals")).rows;
      const catalog = (await db.query<{ org_id: string }>("select org_id from proposal_catalog_items")).rows;
      const events = (await db.query<{ org_id: string }>("select org_id from proposal_events")).rows;
      await db.query("reset role");
      return { proposals, catalog, events };
    });
    expect(seen.proposals.map((x) => x.id)).toEqual([mine.id]);
    expect(new Set([...seen.proposals, ...seen.catalog, ...seen.events].map((x) => x.org_id))).toEqual(new Set([b.org.id]));
  });

  it("gives a person who works in two workspaces only the proposals of the one they act in", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    const person = await createUser({ name: "Works In Both" });
    await addMember(a.org.id, person.id, "sales_rep");
    await addMember(b.org.id, person.id, "sales_rep");
    const both = memberActor(ctxFor(person, a.org, "sales_rep"));
    const asB = memberActor(ctxFor(person, b.org, "sales_rep"));
    await draftBy(a, "owner");
    await draftBy(b, "owner");
    expect(await listProposals(both)).toHaveLength(1);
    expect(await listProposals(asB)).toHaveLength(1);
    expect((await listProposals(both))[0].id).not.toBe((await listProposals(asB))[0].id);
  });
});
