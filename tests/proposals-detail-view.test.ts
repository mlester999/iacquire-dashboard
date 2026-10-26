// What a proposal's detail tells the screens, on embedded Postgres: the preview the customer will see, what the person looking may do, what an AI draft left out, and the stored PDF of
// a sent version. The screens only show these; the server decides (and checks again on every action).
import { describe, expect, it } from "vitest";
import { createContact } from "@/server/crm/contacts";
import { draftProposalWithAi } from "@/server/proposals/ai";
import { createProposal, decideProposal, getProposal, sendProposal, submitForApproval, updateProposal } from "@/server/proposals/proposals";
import { readPrivateFile } from "@/server/storage/private";
import { createUser, uid } from "./support/fixtures";
import { draftBy, enableAi, proposalOrg, rows, stubModel } from "./support/proposals";

const NOW = new Date("2026-10-23T12:00:00Z");

describe("the preview", () => {
  it("is the working copy with placeholders filled in until a version is saved, and the saved version, exactly, after", async () => {
    const p = await proposalOrg();
    const contact = await createContact(p.actor("owner"), { firstName: "Maria", lastName: "Santos", email: `maria-${uid()}@example.test` });
    const draft = await createProposal(p.actor("sales"), {
      contactId: contact.id, title: "Website proposal", doc: { sections: [{ heading: "Hello", body: "Dear {{client.first_name}}, thank you." }], lines: [{ catalogItemId: p.item.id, quantityMilli: 1000 }] },
    }, { now: NOW });
    // The stored document keeps the placeholder; the preview shows what the customer will read.
    expect(draft.doc.sections[0].body).toBe("Dear {{client.first_name}}, thank you.");
    expect(draft.preview).toMatchObject({ frozen: false, version: 1, contentHash: null });
    expect(draft.preview?.snapshot.sections[0].body).toBe("Dear Maria, thank you.");
    expect(draft.preview?.snapshot.groups.one_time.total).toBe(168_000);
    expect(draft.versions).toEqual([]);

    const pending = await submitForApproval(p.actor("sales"), draft.id, { now: NOW });
    expect(pending.preview?.frozen).toBe(false); // still editable, so still the working copy
    expect(pending.versions).toHaveLength(1);
    const approved = await decideProposal(p.actor("manager"), pending.id, { decision: "approve", version: 1 }, { now: NOW });
    const sent = await sendProposal(p.actor("sales"), approved.id, {}, { now: NOW });
    expect(sent.preview).toMatchObject({ frozen: true, version: 1, contentHash: sent.versions[0].contentHash });
    expect(sent.preview?.snapshot.sections[0].body).toBe("Dear Maria, thank you.");
    // After a send the figures cannot drift: a later price book change leaves the saved version as it was.
    const { updateCatalogItem } = await import("@/server/proposals/catalog");
    await updateCatalogItem(p.actor("owner"), p.item.id, { unitPriceMinor: 999_999 }, 1);
    expect((await getProposal(p.actor("sales"), sent.id)).preview?.snapshot.groups.one_time.total).toBe(168_000);
  });

  it("is absent when the figures cannot be worked out, and the problems say why", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    // A fixed discount larger than the line cannot be saved through the service, so it is put there directly to see how the detail copes.
    const { withSystem } = await import("@/server/db");
    await withSystem((db) => db.query(`update proposals set doc = jsonb_set(doc, '{lines,0,discount}', '{"kind":"fixed","minor":99999999}'::jsonb) where id = $1`, [draft.id]));
    const broken = await getProposal(p.actor("owner"), draft.id);
    expect(broken.preview).toBeNull();
    expect(broken.problems.some((x) => x.code === "figures" && x.level === "blocking")).toBe(true);
  });
});

describe("what the viewer may do", () => {
  it("works out, per person, who can edit and who counts as the author", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "member"); // written by the team member
    const as = async (actor: Parameters<typeof getProposal>[0]) => (await getProposal(actor, draft.id)).viewer;
    expect(await as(p.member)).toMatchObject({ canEdit: true, isAuthor: true });
    expect(await as(p.actor("owner"))).toMatchObject({ canEdit: true, isAuthor: false });
    expect(await as(p.actor("manager"))).toMatchObject({ canEdit: true, isAuthor: false });
    expect(await as(p.actor("sales"))).toMatchObject({ canEdit: false, isAuthor: false }); // can write proposals, but not this one
    expect(await as(p.actor("viewer"))).toMatchObject({ canEdit: false, isAuthor: false });
    // Whoever sends a version for approval counts as its author for the second-person rule.
    await submitForApproval(p.actor("owner"), draft.id, { now: NOW });
    expect(await as(p.actor("owner"))).toMatchObject({ canEdit: true, isAuthor: true });
    expect(await as(p.actor("manager"))).toMatchObject({ isAuthor: false });
    expect((await getProposal(p.member, draft.id)).createdById).toBe(p.member.userId);
  });

  it("carries the person's own id", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    expect((await getProposal(p.actor("sales"), draft.id)).viewer.userId).toBe(p.people.sales.id);
  });
});

describe("an AI draft's record", () => {
  it("carries what the checks left out, only for an AI draft", async () => {
    const p = await proposalOrg();
    await enableAi(p);
    const m = stubModel(JSON.stringify({
      intro: "Hello there.", scopeSummary: "We build it. It costs $49 only today.", items: [{ catalogItemId: p.item.id, quantity: 1 }, { catalogItemId: "00000000-0000-4000-8000-000000000099", quantity: 1 }],
      assumptions: [], nextSteps: [],
    }));
    const out = await draftProposalWithAi(p.actor("sales"), {}, { ...m.deps, now: NOW });
    const detail = await getProposal(p.actor("sales"), out.proposal.id);
    expect(detail.ai).toMatchObject({ droppedCount: 1, rejectedItems: 1, dropped: [{ field: "scope", reason: "number", detail: "49" }] });
    expect(detail.ai?.dropped[0].text).toBe("It costs $49 only today.");
    expect((await getProposal(p.actor("sales"), (await draftBy(p, "sales")).id)).ai).toBeNull();
  });

  it("is not readable by another workspace", async () => {
    const a = await proposalOrg();
    const b = await proposalOrg();
    await enableAi(a);
    const out = await draftProposalWithAi(a.actor("sales"), {}, { ...stubModel(JSON.stringify({ intro: "Hi.", items: [{ catalogItemId: a.item.id, quantity: 1 }] })).deps, now: NOW });
    await expect(getProposal(b.actor("owner"), out.proposal.id)).rejects.toMatchObject({ code: "not_found" });
    expect(await rows("select 1 from proposal_ai_runs where org_id = $1", [b.org.id])).toHaveLength(0);
  });
});

describe("the stored PDF of a sent version", () => {
  it("is offered by id, and only people who can see proposals in that workspace can read it", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const draft = await draftBy(p, "sales");
    expect(draft.versions).toEqual([]);
    const sent = await sendProposal(p.actor("sales"), draft.id, {}, { now: NOW });
    const v = sent.versions[0];
    expect(v.hasPdf).toBe(true);
    expect(v.pdfFileId).toMatch(/^[0-9a-f-]{36}$/);
    const file = (await rows<{ storage_key: string; bucket: string; org_id: string; mime_type: string }>("select storage_key, bucket, org_id, mime_type from private_files where id = $1", [v.pdfFileId]))[0];
    expect(file).toMatchObject({ bucket: "proposal-documents", org_id: p.org.id, mime_type: "application/pdf" });
    const read = (userId: string, orgId: string) => readPrivateFile({ userId, orgId, bucket: "proposal-documents", path: file.storage_key });
    const bytes = await read(p.people.viewer.id, p.org.id);
    expect(bytes.bytes.subarray(0, 4).toString()).toBe("%PDF");
    await expect(read(p.people.setter.id, p.org.id)).rejects.toThrow();
    await expect(read(other.people.owner.id, p.org.id)).rejects.toThrow();
    const stranger = await createUser();
    await expect(read(stranger.id, p.org.id)).rejects.toThrow();
  });

  it("is not offered for a version that has not been sent", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "owner");
    const pending = await submitForApproval(p.actor("owner"), draft.id, { now: NOW });
    expect(pending.versions[0]).toMatchObject({ hasPdf: false, pdfFileId: null });
    const edited = await updateProposal(p.actor("owner"), pending.id, { title: "Changed" }, pending.version, { now: NOW });
    expect(edited.versions.every((x) => x.pdfFileId === null)).toBe(true);
  });
});
