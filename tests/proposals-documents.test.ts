// The PDF of a frozen version on embedded Postgres and the local private file store: it is made once when the proposal is sent, kept with the hash of its bytes, and read back
// only for the version its link is for. A PDF that cannot be made never undoes a send.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { env } from "@/server/env";
import { readAuthorizedPrivateFile } from "@/server/storage/private";
import { extractPdf } from "@/server/knowledge/extract";
import { builtInRenderer, ensureVersionPdf, pdfFilename, readVersionPdf } from "@/server/proposals/documents";
import { sendProposal } from "@/server/proposals/proposals";
import { approvedProposal, draftBy, NOW, proposalOrg, rows, sentWithLink } from "./support/proposals";

const sha = (b: Buffer) => crypto.createHash("sha256").update(b).digest("hex");
const versionRow = async (proposalId: string, version = 1) => (await rows<{ pdf_file_id: string | null; pdf_sha256: string | null; pdf_bytes: number | null; content_hash: string }>("select pdf_file_id, pdf_sha256, pdf_bytes, content_hash from proposal_versions where proposal_id = $1 and version = $2", [proposalId, version]))[0];
const storedPath = (orgId: string, storageKey: string) => path.resolve(process.cwd(), env().UPLOAD_DIR, "proposal-documents", storageKey);

describe("sending a proposal stores its PDF", () => {
  it("saves the file in the private proposal-documents bucket and records the hash of its bytes, once, on the version", async () => {
    const p = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const v = await versionRow(proposal.id);
    expect(v.pdf_file_id).toBeTruthy();
    expect(proposal.versions[0].hasPdf).toBe(true);
    const file = await readAuthorizedPrivateFile(v.pdf_file_id as string);
    expect(file).toMatchObject({ org_id: p.org.id, bucket: "proposal-documents", filename: pdfFilename("P-0001", 1), mime_type: "application/pdf" });
    expect(file.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(sha(file.bytes)).toBe(v.pdf_sha256);
    expect(file.bytes.length).toBe(v.pdf_bytes);
    const meta = (await rows<{ visibility: string; status: string; storage_key: string }>("select visibility, status, storage_key from private_files where id = $1", [v.pdf_file_id]))[0];
    expect(meta).toMatchObject({ visibility: "client", status: "ready" });
    expect(meta.storage_key.startsWith(`${p.org.id}/`)).toBe(true);
    // What is in it is the frozen version: the number, the customer, the figures.
    const read = extractPdf(file.bytes);
    expect(read.ok && read.text).toContain("Proposal P-0001");
    expect(read.ok && read.text).toContain("Maria Santos");
    expect(read.ok && read.text).toContain("USD 1,680.00");
  });

  it("is the same bytes as making it again from the stored snapshot: the hash is a fact about that version", async () => {
    const p = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const v = await versionRow(proposal.id);
    const row = (await rows<{ snapshot: never; content_hash: string; created_at: Date }>("select snapshot, content_hash, created_at from proposal_versions where proposal_id = $1", [proposal.id]))[0];
    const again = await builtInRenderer.render({ snapshot: row.snapshot, version: 1, contentHash: row.content_hash, createdAt: new Date(row.created_at) });
    expect(sha(again)).toBe(v.pdf_sha256);
  });

  it("is made once: asking again changes nothing and stores no second file", async () => {
    const p = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const before = await versionRow(proposal.id);
    const again = await ensureVersionPdf(p.org.id, proposal.id, 1, p.people.sales.id);
    expect(again).toMatchObject({ fileId: before.pdf_file_id, sha256: before.pdf_sha256, created: false });
    expect((await rows("select 1 from private_files where org_id = $1 and bucket = 'proposal-documents'", [p.org.id])).length).toBe(1);
  });

  it("ends with one stored file when two callers make it at the same moment, and the surplus copy is removed", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p, {}, { now: NOW });
    expect((await versionRow(approved.id)).pdf_file_id).toBeNull();
    const [a, b] = await Promise.all([ensureVersionPdf(p.org.id, approved.id, 1, p.people.sales.id), ensureVersionPdf(p.org.id, approved.id, 1, p.people.sales.id)]);
    expect(a.fileId).toBe(b.fileId);
    expect(a.sha256).toBe(b.sha256);
    expect([a.created, b.created].filter(Boolean)).toHaveLength(1);
    const files = await rows<{ id: string; status: string; storage_key: string }>("select id, status, storage_key from private_files where org_id = $1 and bucket = 'proposal-documents' order by status", [p.org.id]);
    expect(files.filter((f) => f.status === "ready")).toHaveLength(1);
    expect(files.filter((f) => f.status === "ready")[0].id).toBe(a.fileId);
    for (const f of files.filter((x) => x.status === "deleted")) expect(fs.existsSync(storedPath(p.org.id, f.storage_key))).toBe(false);
    expect((await versionRow(approved.id)).pdf_file_id).toBe(a.fileId);
  });

  it("is saved on the permission of the person who sent it: someone who cannot write proposals cannot store one", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p, {}, { now: NOW });
    await expect(ensureVersionPdf(p.org.id, approved.id, 1, p.people.viewer.id)).rejects.toThrow(/don't have access/);
    expect((await versionRow(approved.id)).pdf_file_id).toBeNull();
  });
});

describe("a PDF that cannot be made", () => {
  it("never undoes the send: the proposal is sent, the link works, the history says what happened, and the customer's copy is made from the version", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p, {}, { now: NOW });
    const sent = await sendProposal(p.actor("sales"), approved.id, {}, { now: NOW, renderer: { render: async () => { throw new Error("the writer broke"); } } });
    expect(sent.status).toBe("sent");
    expect(sent.versions[0].hasPdf).toBe(false);
    expect(sent.share?.active).toBe(true);
    const failed = await rows<{ detail: { message: string }; actor_kind: string }>("select detail, actor_kind from proposal_events where proposal_id = $1 and kind = 'pdf_failed'", [approved.id]);
    expect(failed).toHaveLength(1);
    expect(failed[0].actor_kind).toBe("system");
    expect(failed[0].detail.message).toMatch(/writer broke/);
    // The page can still give the customer the document: set again from the frozen version, and said to be so.
    const pdf = await readVersionPdf(p.org.id, approved.id, 1);
    expect(pdf).toMatchObject({ stored: false, tampered: false, filename: "Proposal-P-0001-v1.pdf" });
    expect(pdf?.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    // Later, once the writer works, the stored copy is made and is the same bytes.
    const made = await ensureVersionPdf(p.org.id, approved.id, 1, p.people.sales.id);
    expect(made.created).toBe(true);
    expect(sha(pdf!.bytes)).toBe(made.sha256);
  });

  it("refuses a file that is not a PDF", async () => {
    const p = await proposalOrg();
    const approved = await approvedProposal(p, {}, { now: NOW });
    await expect(ensureVersionPdf(p.org.id, approved.id, 1, p.people.sales.id, { renderer: { render: async () => Buffer.from("not a pdf at all") } })).rejects.toThrow(/could not be made/);
    expect((await versionRow(approved.id)).pdf_file_id).toBeNull();
  });
});

describe("reading the PDF back", () => {
  it("serves the stored file while it still matches the recorded hash", async () => {
    const p = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const v = await versionRow(proposal.id);
    const pdf = await readVersionPdf(p.org.id, proposal.id, 1);
    expect(pdf).toMatchObject({ stored: true, tampered: false });
    expect(sha(pdf!.bytes)).toBe(v.pdf_sha256);
  });

  it("notices a stored file that was changed, says so, and serves the version set again instead", async () => {
    const p = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const v = await versionRow(proposal.id);
    const key = (await rows<{ storage_key: string }>("select storage_key from private_files where id = $1", [v.pdf_file_id]))[0].storage_key;
    fs.writeFileSync(storedPath(p.org.id, key), Buffer.from("%PDF-1.4\nsomeone replaced this file\n%%EOF\n"));
    const pdf = await readVersionPdf(p.org.id, proposal.id, 1);
    expect(pdf).toMatchObject({ stored: false, tampered: true });
    // The fresh copy is the version, byte for byte as it was first made.
    expect(sha(pdf!.bytes)).toBe(v.pdf_sha256);
  });

  it("falls back to the version when the stored file is gone, and finds nothing for another workspace", async () => {
    const p = await proposalOrg();
    const other = await proposalOrg();
    const { proposal } = await sentWithLink(p);
    const v = await versionRow(proposal.id);
    const key = (await rows<{ storage_key: string }>("select storage_key from private_files where id = $1", [v.pdf_file_id]))[0].storage_key;
    fs.rmSync(storedPath(p.org.id, key));
    expect(await readVersionPdf(p.org.id, proposal.id, 1)).toMatchObject({ stored: false, tampered: false });
    // Another workspace's id never finds this proposal's version, however it is asked.
    expect(await readVersionPdf(other.org.id, proposal.id, 1)).toBeNull();
    expect(await readVersionPdf(p.org.id, proposal.id, 9)).toBeNull();
    await expect(ensureVersionPdf(other.org.id, proposal.id, 1, other.people.sales.id)).rejects.toThrow(/not found/);
  });

  it("a draft that was never frozen has no PDF to read", async () => {
    const p = await proposalOrg();
    const draft = await draftBy(p, "sales");
    expect(await readVersionPdf(p.org.id, draft.id, 1)).toBeNull();
  });
});
