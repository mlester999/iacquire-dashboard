import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { recordAudit } from "@/server/audit";
import { extractDocumentText } from "@/server/knowledge/extract";
import { detectRiskFlags, sanitizeClientText } from "@/server/workforce/compiler";
import { putPlatformKnowledgeFile, readPlatformKnowledgeFile, removePlatformKnowledgeFile, validPrivateFileSignature } from "@/server/storage/private";
import { getPublishedAqiConfig } from "@/server/aqi/service";
import type { SessionUser } from "@/server/auth/service";

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_TEXT = 200_000;
const ENTRY_BODY = 12_000;

const FORMATS: Record<string, { mime: string; extract: "pdf" | "docx" | "txt" }> = {
  pdf: { mime: "application/pdf", extract: "pdf" },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", extract: "docx" },
  txt: { mime: "text/plain", extract: "txt" },
  md: { mime: "text/markdown", extract: "txt" },
  csv: { mime: "text/csv", extract: "txt" },
};

export interface AqiKnowledgeDocumentView {
  id: string;
  knowledgeEntryId: string | null;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  extractionStatus: "processing" | "ready" | "failed" | "unsupported";
  extractionMethod: string | null;
  extractionDetail: string | null;
  extractedChars: number | null;
  riskFlags: string[];
  status: "draft" | "linked" | "archived" | "deleted";
  uploadedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DocumentRow {
  id: string;
  knowledge_entry_id: string | null;
  filename: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_bucket: string;
  storage_path: string;
  extraction_status: AqiKnowledgeDocumentView["extractionStatus"];
  extraction_method: string | null;
  extraction_detail: string | null;
  extracted_text: string | null;
  extracted_chars: number | null;
  risk_flags: string[];
  uploaded_by: string | null;
  status: AqiKnowledgeDocumentView["status"];
  created_at: Date;
  updated_at: Date;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function view(row: DocumentRow): AqiKnowledgeDocumentView {
  return {
    id: row.id,
    knowledgeEntryId: row.knowledge_entry_id,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    extractionStatus: row.extraction_status,
    extractionMethod: row.extraction_method,
    extractionDetail: row.extraction_detail,
    extractedChars: row.extracted_chars,
    riskFlags: row.risk_flags ?? [],
    status: row.status,
    uploadedBy: row.uploaded_by,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function requireSuperAdmin(admin: SessionUser): void {
  if (admin.platformRole !== "agency_super_admin") throw new AppError("forbidden", "Only a Super Admin can manage platform knowledge documents.");
}

function extensionOf(filename: string): string | null {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename.trim());
  return match ? match[1].toLowerCase() : null;
}

export interface AqiKnowledgeUploadInput {
  filename: string;
  mimeType: string;
  bytes: Buffer;
}

export interface AqiKnowledgeUploadResult {
  document: AqiKnowledgeDocumentView;
  extractedPreview: string | null;
}

/**
 * Secure, explicit ingestion. The bytes are validated against their real signature, extracted with
 * the existing bounded PDF/DOCX/TXT extractor, and stored as a DRAFT. Nothing is published and no
 * knowledge entry is created until a Super Admin reviews the extraction.
 */
export async function uploadAqiKnowledgeDocument(admin: SessionUser, input: AqiKnowledgeUploadInput): Promise<AqiKnowledgeUploadResult> {
  requireSuperAdmin(admin);
  const filename = input.filename.trim().replace(/[\\/]/g, "/").split("/").pop()?.slice(0, 200) ?? "";
  if (!filename) throw new AppError("invalid_input", "Choose a document with a filename.");
  const ext = extensionOf(filename);
  if (!ext || !Object.hasOwn(FORMATS, ext)) throw new AppError("invalid_input", "Upload a PDF, DOCX, TXT, Markdown or CSV document.");
  const format = FORMATS[ext];
  if (input.bytes.length === 0) throw new AppError("invalid_input", "The document is empty.");
  if (input.bytes.length > MAX_BYTES) throw new AppError("invalid_input", "Platform knowledge documents can be up to 10 MB.");
  if (input.mimeType && input.mimeType !== format.mime && !(format.extract === "txt" && input.mimeType.startsWith("text/"))) {
    throw new AppError("invalid_input", "The file type does not match its extension.");
  }
  if (!validPrivateFileSignature(input.bytes, format.mime)) throw new AppError("invalid_input", "The file contents do not match its type.");

  const sha256 = crypto.createHash("sha256").update(input.bytes).digest("hex");
  const duplicate = await withSystem(async (db) => (await db.query<{ id: string; filename: string; status: string }>(
    "select id, filename, status from aqi_knowledge_documents where sha256 = $1 and status <> 'deleted'",
    [sha256],
  )).rows[0]);
  if (duplicate) throw new AppError("invalid_input", `This document is already in the knowledge library (${duplicate.filename}).`);

  const stored = await putPlatformKnowledgeFile({ userId: admin.id, filename, contentType: format.mime, bytes: input.bytes });
  const extraction = extractDocumentText(format.extract, input.bytes);
  const text = extraction.ok ? sanitizeClientText(extraction.text, MAX_TEXT) : "";
  const flags = extraction.ok && text ? detectRiskFlags(text) : [];
  const status: AqiKnowledgeDocumentView["extractionStatus"] = extraction.ok ? (text ? "ready" : "failed") : extraction.code === "encrypted" || extraction.code === "scanned" || extraction.code === "unsupported" ? "unsupported" : "failed";
  const detail = extraction.ok ? (text ? null : "The document contained no usable text.") : extraction.detail.slice(0, 500);

  try {
    const row = await withSystem(async (db) => (await db.query<DocumentRow>(
      `insert into aqi_knowledge_documents
         (filename, mime_type, size_bytes, sha256, storage_path, extraction_status, extraction_method, extraction_detail,
          extracted_text, extracted_chars, risk_flags, uploaded_by, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'draft')
       returning *`,
      [filename, format.mime, input.bytes.length, sha256, stored.storagePath, status, extraction.method, detail, text || null, text.length, flags, admin.id],
    )).rows[0]);
    await recordAudit({
      actorUserId: admin.id,
      actorKind: "agency",
      action: "aqi.knowledge_document_uploaded",
      targetType: "aqi_knowledge_document",
      targetId: row.id,
      result: "success",
      metadata: { filename, bytes: input.bytes.length, extractionStatus: status, riskFlags: flags.length },
    });
    return {
      document: view(row),
      extractedPreview: text ? text.slice(0, 1200) : null,
    };
  } catch (err) {
    await removePlatformKnowledgeFile(stored.storagePath).catch(() => undefined);
    throw err;
  }
}

export async function listAqiKnowledgeDocuments(): Promise<AqiKnowledgeDocumentView[]> {
  return withSystem(async (db) => (await db.query<DocumentRow>(
    "select * from aqi_knowledge_documents where status <> 'deleted' order by created_at desc limit 100",
  )).rows.map(view));
}

export interface AqiKnowledgeEntryFromDocumentInput {
  documentId: string;
  title: string;
  category: string;
  body?: string | null;
  routePrefix?: string | null;
  roles?: string[];
}

export async function createAqiKnowledgeEntryFromDocument(admin: SessionUser, input: AqiKnowledgeEntryFromDocumentInput): Promise<{ id: string }> {
  requireSuperAdmin(admin);
  const title = input.title.trim().slice(0, 160);
  const category = input.category.trim().slice(0, 60);
  if (!title || !category) throw new AppError("invalid_input", "Give the knowledge entry a title and category.");
  const route = input.routePrefix?.trim() || null;
  if (route && !/^\/[a-z0-9/_-]*$/.test(route)) throw new AppError("invalid_input", "Use an internal route such as /crm/contacts.");
  return withSystem(async (db) => {
    const document = (await db.query<DocumentRow>(
      "select * from aqi_knowledge_documents where id = $1 and status <> 'deleted'",
      [input.documentId],
    )).rows[0];
    if (!document) throw new AppError("not_found", "Document not found.");
    if (document.extraction_status !== "ready" || !document.extracted_text) {
      throw new AppError("invalid_input", "This document has no readable text. Save the entry manually if you have verified content.");
    }
    if (document.knowledge_entry_id) throw new AppError("invalid_input", "This document is already linked to a knowledge entry.");
    const body = sanitizeClientText(input.body?.trim() || document.extracted_text, ENTRY_BODY);
    if (!body) throw new AppError("invalid_input", "The knowledge body is empty.");
    const entry = (await db.query<{ id: string }>(
      `insert into aqi_knowledge_entries
         (title, category, body, route_prefix, roles, status, source, version, source_kind, source_document_id, created_by, updated_by)
       values ($1, $2, $3, $4, $5, 'draft', $6, 1, 'document', $7, $8, $8)
       returning id`,
      [title, category, body, route, input.roles ?? [], `Uploaded document: ${document.filename}`.slice(0, 200), document.id, admin.id],
    )).rows[0];
    await db.query("update aqi_knowledge_documents set knowledge_entry_id = $2, status = 'linked', updated_at = now() where id = $1", [document.id, entry.id]);
    await recordAudit({
      actorUserId: admin.id,
      actorKind: "agency",
      action: "aqi.knowledge_document_linked",
      targetType: "aqi_knowledge",
      targetId: entry.id,
      result: "success",
      metadata: { documentId: document.id, filename: document.filename, bodyChars: body.length },
    }, db);
    return { id: entry.id };
  });
}

export async function archiveAqiKnowledgeDocument(admin: SessionUser, documentId: string): Promise<void> {
  requireSuperAdmin(admin);
  await withSystem(async (db) => {
    const result = await db.query("update aqi_knowledge_documents set status = 'archived', updated_at = now() where id = $1 and status <> 'deleted'", [documentId]);
    if (!result.rowCount) throw new AppError("not_found", "Document not found.");
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: "aqi.knowledge_document_archived", targetType: "aqi_knowledge_document", targetId: documentId, result: "success" }, db);
  });
}

export async function readAqiKnowledgeDocument(admin: SessionUser, documentId: string): Promise<{ filename: string; mimeType: string; bytes: Buffer }> {
  requireSuperAdmin(admin);
  const document = await withSystem(async (db) => (await db.query<DocumentRow>(
    "select * from aqi_knowledge_documents where id = $1 and status <> 'deleted'",
    [documentId],
  )).rows[0]);
  if (!document) throw new AppError("not_found", "Document not found.");
  return { filename: document.filename, mimeType: document.mime_type, bytes: await readPlatformKnowledgeFile(document.storage_path) };
}

export type AqiKnowledgeFreshness = "up_to_date" | "review_due" | "needs_attention" | "archived";

export interface AqiKnowledgeReviewRow {
  id: string;
  title: string;
  category: string;
  status: string;
  source: string;
  sourceKind: "manual" | "document";
  sourceDocumentId: string | null;
  sourceFilename: string | null;
  routePrefix: string | null;
  roles: string[];
  freshnessDays: number | null;
  lastReviewedAt: string | null;
  nextReviewAt: string | null;
  reviewDueAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  updatedAt: string;
  updatedBy: string | null;
  freshness: AqiKnowledgeFreshness;
  daysOverdue: number;
}

interface ReviewQueryRow {
  id: string;
  title: string;
  category: string;
  status: string;
  source: string;
  source_kind: "manual" | "document";
  source_document_id: string | null;
  source_filename: string | null;
  route_prefix: string | null;
  roles: string[];
  freshness_days: number | null;
  last_reviewed_at: Date | null;
  next_review_at: Date | null;
  reviewed_by: string | null;
  review_note: string | null;
  updated_at: Date;
  updated_by_name: string | null;
}

export async function listAqiKnowledgeReview(): Promise<AqiKnowledgeReviewRow[]> {
  const config = await getPublishedAqiConfig();
  const now = Date.now();
  const rows = await withSystem(async (db) => (await db.query<ReviewQueryRow>(
    `select k.id, k.title, k.category, k.status, k.source, k.source_kind, k.source_document_id, d.filename as source_filename,
            k.route_prefix, k.roles, k.freshness_days, k.last_reviewed_at, k.next_review_at, k.reviewed_by, k.review_note,
            k.updated_at, u.full_name as updated_by_name
       from aqi_knowledge_entries k
       left join aqi_knowledge_documents d on d.id = k.source_document_id
       left join users u on u.id = k.updated_by
      order by k.category, k.title`,
  )).rows);
  return rows.map((row) => {
    const days = row.freshness_days ?? config.config.knowledgeFreshnessDays;
    const base = row.last_reviewed_at ?? row.updated_at;
    const dueAt = row.next_review_at ?? new Date(new Date(base).getTime() + days * 24 * 60 * 60 * 1000);
    const overdueMs = now - dueAt.getTime();
    const freshness: AqiKnowledgeFreshness = row.status === "archived" ? "archived" : overdueMs > 0 ? (overdueMs > 30 * 24 * 60 * 60 * 1000 ? "needs_attention" : "review_due") : "up_to_date";
    return {
      id: row.id,
      title: row.title,
      category: row.category,
      status: row.status,
      source: row.source,
      sourceKind: row.source_kind,
      sourceDocumentId: row.source_document_id,
      sourceFilename: row.source_filename,
      routePrefix: row.route_prefix,
      roles: row.roles,
      freshnessDays: row.freshness_days,
      lastReviewedAt: row.last_reviewed_at ? iso(row.last_reviewed_at) : null,
      nextReviewAt: row.next_review_at ? iso(row.next_review_at) : null,
      reviewDueAt: dueAt.toISOString(),
      reviewedBy: row.reviewed_by,
      reviewNote: row.review_note,
      updatedAt: iso(row.updated_at),
      updatedBy: row.updated_by_name,
      freshness,
      daysOverdue: Math.max(0, Math.floor(overdueMs / (24 * 60 * 60 * 1000))),
    };
  });
}

export async function reviewAqiKnowledgeEntry(
  admin: SessionUser,
  entryId: string,
  input: { action: "review" | "publish" | "archive"; note?: string | null; freshnessDays?: number | null },
): Promise<void> {
  requireSuperAdmin(admin);
  const config = await getPublishedAqiConfig();
  const note = input.note?.trim().slice(0, 500) || null;
  const days = input.freshnessDays ?? config.config.knowledgeFreshnessDays;
  if (!Number.isInteger(days) || days < 7 || days > 3650) throw new AppError("invalid_input", "Choose a review interval between 7 and 3,650 days.");
  await withSystem(async (db) => {
    const entry = (await db.query<{ id: string; title: string; status: string }>(
      "select id, title, status from aqi_knowledge_entries where id = $1",
      [entryId],
    )).rows[0];
    if (!entry) throw new AppError("not_found", "Knowledge entry not found.");
    if (input.action === "review") {
      await db.query(
        `update aqi_knowledge_entries set last_reviewed_at = now(), next_review_at = now() + make_interval(days => $2),
           reviewed_by = $3, review_note = $4, freshness_days = $2, updated_by = $3, updated_at = now()
         where id = $1`,
        [entryId, days, admin.id, note],
      );
    } else if (input.action === "publish") {
      await db.query(
        `update aqi_knowledge_entries set status = 'published', published_at = coalesce(published_at, now()),
           last_reviewed_at = now(), next_review_at = now() + make_interval(days => $2), reviewed_by = $3, review_note = $4,
           freshness_days = $2, version = version + 1, updated_by = $3, updated_at = now()
         where id = $1`,
        [entryId, days, admin.id, note],
      );
    } else {
      await db.query("update aqi_knowledge_entries set status = 'archived', review_note = $2, updated_by = $3, updated_at = now() where id = $1", [entryId, note, admin.id]);
    }
    await recordAudit({ actorUserId: admin.id, actorKind: "agency", action: `aqi.knowledge_${input.action}`, targetType: "aqi_knowledge", targetId: entryId, result: "success", metadata: { title: entry.title, freshnessDays: days } }, db);
  });
}

/** Validated AI knowledge upload formats, exposed for the management UI. */
export const AQI_KNOWLEDGE_FORMATS = Object.entries(FORMATS).map(([extension, value]) => ({ extension, mime: value.mime }));
