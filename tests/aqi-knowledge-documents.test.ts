import { describe, expect, it } from "vitest";
import { withSystem } from "@/server/db";
import { agencyUser, createUser } from "./support/fixtures";
import {
  createAqiKnowledgeEntryFromDocument,
  listAqiKnowledgeDocuments,
  listAqiKnowledgeReview,
  reviewAqiKnowledgeEntry,
  uploadAqiKnowledgeDocument,
} from "@/server/aqi/knowledge-documents";
import { previewAqiRetrieval } from "@/server/aqi/service";
import { makeDocx, makeEncryptedPdf, makeMalformedDocx, makePdf } from "./support/document-fixtures";

const superAdmin = () => createUser({ platformRole: "agency_super_admin" }).then((user) => agencyUser(user, "agency_super_admin"));

function textBytes(text: string) {
  return Buffer.from(text, "utf8");
}

describe("AQi platform knowledge document ingestion", () => {
  it("extracts a text document into a private draft without publishing anything", async () => {
    const admin = await superAdmin();
    const marker = `zqx${Math.random().toString(16).slice(2, 8)}`;
    const text = `Contact guide ${marker}\n\nOpen Contacts, then choose New contact.`;
    const result = await uploadAqiKnowledgeDocument(admin, { filename: "contact-guide.txt", mimeType: "text/plain", bytes: textBytes(text) });
    expect(result.document.extractionStatus).toBe("ready");
    expect(result.document.status).toBe("draft");
    expect(result.document.extractedChars).toBeGreaterThan(10);
    expect(result.extractedPreview).toContain("Open Contacts");
    expect(result.document.riskFlags).toEqual([]);

    const documents = await listAqiKnowledgeDocuments();
    expect(documents.some((document) => document.id === result.document.id)).toBe(true);
    const published = await withSystem(async (db) => (await db.query<{ n: number }>(
      "select count(*)::int as n from aqi_knowledge_entries where source_document_id = $1 and status = 'published'",
      [result.document.id],
    )).rows[0].n);
    expect(published).toBe(0);

    const entry = await createAqiKnowledgeEntryFromDocument(admin, {
      documentId: result.document.id,
      title: `Contact guide ${marker}`,
      category: "CRM",
      routePrefix: "/crm/contacts",
    });
    const created = await withSystem(async (db) => (await db.query<{ title: string; status: string; source_kind: string; body: string; route_prefix: string }>(
      "select title, status, source_kind, body, route_prefix from aqi_knowledge_entries where id = $1",
      [entry.id],
    )).rows[0]);
    expect(created.status).toBe("draft");
    expect(created.source_kind).toBe("document");
    expect(created.route_prefix).toBe("/crm/contacts");
    expect(created.body).toContain("Open Contacts");

    await reviewAqiKnowledgeEntry(admin, entry.id, { action: "publish" });
    const publishedRow = await withSystem(async (db) => (await db.query<{ status: string; title: string; body: string; route_prefix: string | null }>(
      "select status, title, body, route_prefix from aqi_knowledge_entries where id = $1",
      [entry.id],
    )).rows[0]);
    expect(publishedRow.status).toBe("published");
    expect(publishedRow.title).toContain(marker);
    const retrieval = await previewAqiRetrieval(admin, marker, "/crm/contacts");
    expect(retrieval.entries.map((row) => row.id)).toContain(entry.id);
  });

  it("reuses the existing PDF and DOCX extraction pipeline", async () => {
    const admin = await superAdmin();
    const pdf = await uploadAqiKnowledgeDocument(admin, { filename: "pdf-guide.pdf", mimeType: "application/pdf", bytes: makePdf("PDF platform guide: use the CRM calendar.") });
    expect(pdf.document.extractionStatus).toBe("ready");
    expect(pdf.document.extractionMethod).toBe("pdf");
    expect(pdf.document.extractionDetail).toBeNull();

    const docx = await uploadAqiKnowledgeDocument(admin, {
      filename: "docx-guide.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: makeDocx("DOCX platform guide: review a lead before importing it."),
    });
    expect(docx.document.extractionStatus).toBe("ready");
    expect(docx.document.extractionMethod).toBe("docx");
  });

  it("rejects unsafe, mismatched and duplicate uploads", async () => {
    const admin = await superAdmin();
    await expect(uploadAqiKnowledgeDocument(admin, { filename: "payload.exe", mimeType: "application/octet-stream", bytes: Buffer.from("MZ") })).rejects.toThrow(/PDF, DOCX/i);
    await expect(uploadAqiKnowledgeDocument(admin, { filename: "fake.pdf", mimeType: "application/pdf", bytes: textBytes("not a pdf") })).rejects.toThrow(/do not match/i);
    await expect(uploadAqiKnowledgeDocument(admin, { filename: "too.txt", mimeType: "text/plain", bytes: Buffer.alloc(10 * 1024 * 1024 + 1, 65) })).rejects.toThrow(/10 MB/i);
    const encrypted = await uploadAqiKnowledgeDocument(admin, { filename: "encrypted.pdf", mimeType: "application/pdf", bytes: makeEncryptedPdf() });
    expect(encrypted.document.extractionStatus).toBe("unsupported");
    expect(encrypted.document.extractedChars).toBe(0);
    const malformed = await uploadAqiKnowledgeDocument(admin, {
      filename: "malformed.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      bytes: makeMalformedDocx(),
    });
    expect(["failed", "unsupported"]).toContain(malformed.document.extractionStatus);

    const duplicateBytes = textBytes(`Duplicate document ${Math.random().toString(16).slice(2)}`);
    await uploadAqiKnowledgeDocument(admin, { filename: "one.txt", mimeType: "text/plain", bytes: duplicateBytes });
    await expect(uploadAqiKnowledgeDocument(admin, { filename: "two.txt", mimeType: "text/plain", bytes: duplicateBytes })).rejects.toThrow(/already in the knowledge library/i);
  });

  it("requires a Super Admin and refuses to link a document twice", async () => {
    const orgOwner = await createUser();
    const owner = agencyUser(orgOwner, "agency_manager");
    await expect(uploadAqiKnowledgeDocument(owner, { filename: "x.txt", mimeType: "text/plain", bytes: textBytes("hello") })).rejects.toThrow(/Super Admin/i);
    await expect(listAqiKnowledgeDocuments()).resolves.toBeTruthy();

    const admin = await superAdmin();
    const uploaded = await uploadAqiKnowledgeDocument(admin, { filename: "link-once.txt", mimeType: "text/plain", bytes: textBytes(`Link once ${Math.random().toString(16).slice(2)}`) });
    await createAqiKnowledgeEntryFromDocument(admin, { documentId: uploaded.document.id, title: `Linked ${Math.random().toString(16).slice(2)}`, category: "Platform overview" });
    await expect(createAqiKnowledgeEntryFromDocument(admin, { documentId: uploaded.document.id, title: "Second link", category: "Platform overview" })).rejects.toThrow(/already linked/i);
  });

  it("tracks real review dates and flags stale published knowledge", async () => {
    const admin = await superAdmin();
    const uploaded = await uploadAqiKnowledgeDocument(admin, { filename: "review.txt", mimeType: "text/plain", bytes: textBytes(`Review guide ${Math.random().toString(16).slice(2)}`) });
    const entry = await createAqiKnowledgeEntryFromDocument(admin, { documentId: uploaded.document.id, title: `Review entry ${Math.random().toString(16).slice(2)}`, category: "Platform overview" });
    await reviewAqiKnowledgeEntry(admin, entry.id, { action: "publish", freshnessDays: 30, note: "Checked against the current UI." });
    let rows = await listAqiKnowledgeReview();
    const published = rows.find((row) => row.id === entry.id)!;
    expect(published.freshness).toBe("up_to_date");
    expect(published.lastReviewedAt).not.toBeNull();
    expect(published.nextReviewAt).not.toBeNull();
    expect(published.reviewNote).toBe("Checked against the current UI.");

    const staleTitle = `Stale ${Math.random().toString(16).slice(2)}`;
    await withSystem((db) => db.query(
      `insert into aqi_knowledge_entries (title, category, body, status, source, freshness_days, updated_at, published_at)
       values ($1, 'Platform overview', 'Old published guidance.', 'published', 'Legacy source', 30, now() - interval '200 days', now() - interval '200 days')`,
      [staleTitle],
    ));
    rows = await listAqiKnowledgeReview();
    const stale = rows.find((row) => row.title === staleTitle)!;
    expect(stale.freshness).toBe("needs_attention");
    expect(stale.daysOverdue).toBeGreaterThan(30);
  });
});
