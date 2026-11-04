import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withSystem, withUser, type Queryable } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { notifyAgency, notifyOrgRoles } from "@/server/notifications";
import { detectRiskFlags, sanitizeClientText } from "@/server/workforce/compiler";
import { uploadPrivateFile, readPrivateFile, removePrivateFile } from "@/server/storage/private";
import { extractDocumentText } from "@/server/knowledge/extract";
import { writeKnowledgeTextTx } from "@/server/knowledge/write";
import type { OrgContext } from "@/server/tenancy/context";
import { KNOWLEDGE_SECTIONS, type KnowledgeSection } from "@/lib/knowledge-sections";

// The sections themselves live in a pure module so screens, readiness and employee snapshots count the same nine.
export { KNOWLEDGE_SECTIONS, type KnowledgeSection };

export interface KnowledgeRow {
  section: KnowledgeSection;
  content: string;
  version: number;
  updated_at: Date;
  applied_at: Date | null;
  /** "pending_agency_review" while an edit waits for the agency; `content` is then still the approved text and `pending_content` is the waiting edit. */
  review_status: "approved" | "pending_agency_review";
  pending_content: string | null;
  updated_by_name: string | null;
}

export interface KnowledgeRevisionRow {
  id: string;
  version: number;
  content: string;
  review_status: "approved" | "held" | "rejected" | "superseded";
  risk_flags: string[];
  source: "client" | "onboarding" | "agency" | "restore" | "baseline";
  restored_from_version: number | null;
  created_at: Date;
  actor_name: string | null;
}

export interface DocumentRow {
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  status: string;
  created_at: Date;
  applied_at: Date | null;
  has_text: boolean;
  risk_flags: string[];
  agent_instance_id: string | null;
  processing_detail: string | null;
  extraction_method: string | null;
  processed_at: Date | null;
  uploaded_by_name: string | null;
}

export async function getKnowledge(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<KnowledgeRow>(
      // A waiting edit reads as "in review" for every screen that asks, while content stays the approved text employees use.
      `select k.section, k.content, k.version, k.updated_at, k.applied_at,
              case when k.pending_content is not null then 'pending_agency_review' else k.review_status end as review_status,
              k.pending_content, u.full_name as updated_by_name
       from company_knowledge k left join users u on u.id = k.updated_by where k.org_id = $1`,
      [ctx.org.orgId],
    );
    const { rows: docs } = await db.query<DocumentRow>(
      `select d.id, d.filename, d.mime_type, d.size_bytes, d.status, d.created_at, d.applied_at,
              (d.extracted_text is not null) as has_text, d.risk_flags, d.agent_instance_id,
              d.processing_detail, d.extraction_method, d.processed_at, u.full_name as uploaded_by_name
       from knowledge_documents d left join users u on u.id = d.uploaded_by
       where d.org_id = $1 and d.status <> 'deleted' order by d.created_at desc`,
      [ctx.org.orgId],
    );
    return { sections: rows, documents: docs };
  });
}

export async function saveKnowledgeSection(ctx: OrgContext, section: string, content: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can edit company knowledge.");
  if (!KNOWLEDGE_SECTIONS.some((s) => s.key === section)) throw new AppError("invalid_input", "Unknown knowledge section.");
  return writeKnowledgeText(ctx, section, sanitizeClientText(content, 12000), "client", null);
}

/**
 * The one place knowledge text is written for a person. A clean text replaces the approved text; a flagged one waits in pending_content and the approved text
 * stays exactly as it was, so employees never lose what the agency already cleared. Either way a revision row records the version.
 */
async function writeKnowledgeText(ctx: OrgContext, section: string, text: string, source: "client" | "restore", restoredFromVersion: number | null) {
  const written = await withUser(ctx.user.id, (db) =>
    writeKnowledgeTextTx(db, { orgId: ctx.org.orgId, section, text, userId: ctx.user.id, source, restoredFromVersion }),
  );
  const { held, flags } = written;
  await withSystem(async (db) => {
    // A newer edit replaces one that was still waiting: its row says so instead of staying "held" forever.
    const { rowCount } = await db.query(
      "update company_knowledge_revisions set review_status = 'superseded', decided_at = now() where org_id = $1 and section = $2 and review_status = 'held' and version < $3",
      [ctx.org.orgId, section, written.version],
    );
    await recordAudit(
      {
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        action: source === "restore" ? "knowledge.section_restored" : "knowledge.section_saved",
        targetType: "knowledge_section",
        targetId: section,
        result: "success",
        metadata: { held, flags, revision: written.version, fromVersion: written.fromVersion, supersededPending: written.hadPending || (rowCount ?? 0) > 0, restoredFromVersion },
      },
      db,
    );
    if (held) {
      await notifyAgency(db, ctx.org.orgId, {
        kind: "knowledge_update_ready",
        severity: "warning",
        title: `${ctx.org.name}: knowledge update needs review`,
        body: `Section "${section}" was held because it may conflict with AI safety policy. The previous approved text is still in use.`,
        link: `/admin/clients/${ctx.org.orgId}?tab=reviews`,
      });
    }
  });
  return { held, flags, version: written.version };
}

/** A section's saved versions, newest first (at most 50), for the History drawer. */
export async function listKnowledgeRevisions(ctx: OrgContext, section: string): Promise<KnowledgeRevisionRow[]> {
  if (!ctx.can("knowledge.view")) throw new AppError("forbidden", "You can't view company knowledge.");
  if (!KNOWLEDGE_SECTIONS.some((s) => s.key === section)) throw new AppError("invalid_input", "Unknown knowledge section.");
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<KnowledgeRevisionRow>(
      `select r.id, r.version, r.content, r.review_status, r.risk_flags, r.source, r.restored_from_version, r.created_at, u.full_name as actor_name
       from company_knowledge_revisions r left join users u on u.id = r.actor_user_id
       where r.org_id = $1 and r.section = $2 order by r.version desc limit 50`,
      [ctx.org.orgId, section],
    );
    return rows;
  });
}

/**
 * Puts an earlier version's text back as a new version. It is scanned again like any other edit, so restoring text that was flagged is held, never applied
 * directly. The older revision itself is never changed.
 */
export async function restoreKnowledgeRevision(ctx: OrgContext, section: string, revisionId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can edit company knowledge.");
  if (!KNOWLEDGE_SECTIONS.some((s) => s.key === section)) throw new AppError("invalid_input", "Unknown knowledge section.");
  const revision = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ version: number; content: string }>(
      "select version, content from company_knowledge_revisions where id = $1 and org_id = $2 and section = $3",
      [revisionId, ctx.org.orgId, section],
    );
    return rows[0];
  });
  if (!revision) throw new AppError("not_found", "That version no longer exists.");
  return writeKnowledgeText(ctx, section, sanitizeClientText(revision.content, 12000), "restore", revision.version);
}

/**
 * The agency's decision on a waiting section edit. Approve promotes the waiting text to the approved text; reject drops it and the approved text stays.
 * A row held by the older code (review_status = 'pending_agency_review', the held text in `content`) is still decided here: approving releases it, rejecting
 * empties it, because that code kept no earlier text. Runs in the caller's transaction; the caller has already checked the agency permission for this client.
 */
export async function decideHeldKnowledge(db: Queryable, input: { orgId: string; section: string; approve: boolean; agencyUserId: string }) {
  const { orgId, section, approve, agencyUserId } = input;
  const { rows } = await db.query<{ pending_content: string | null; review_status: string }>(
    "select pending_content, review_status from company_knowledge where org_id = $1 and section = $2 for update",
    [orgId, section],
  );
  const row = rows[0];
  const legacyHeld = row?.review_status === "pending_agency_review";
  if (!row || (row.pending_content === null && !legacyHeld)) throw new AppError("conflict", "Already reviewed.");
  let revision: number | null = null;
  if (row.pending_content !== null) {
    const { rows: held } = await db.query<{ version: number }>(
      "select version from company_knowledge_revisions where org_id = $1 and section = $2 and review_status = 'held' order by version desc limit 1",
      [orgId, section],
    );
    revision = held[0]?.version ?? null;
    if (approve) {
      await db.query(
        `update company_knowledge set content = pending_content, risk_flags = '{}', review_status = 'approved', applied_at = now(),
           version = coalesce($3::int, version), pending_content = null, pending_flags = '{}' where org_id = $1 and section = $2`,
        [orgId, section, revision],
      );
    } else {
      await db.query("update company_knowledge set pending_content = null, pending_flags = '{}' where org_id = $1 and section = $2", [orgId, section]);
    }
    await db.query(
      "update company_knowledge_revisions set review_status = $3, decided_by = $4, decided_at = now() where org_id = $1 and section = $2 and review_status = 'held' and version = $5",
      [orgId, section, approve ? "approved" : "rejected", agencyUserId, revision],
    );
  }
  if (legacyHeld) {
    // Still holding text the older code put in `content`: released by an approval, emptied by a rejection.
    await db.query(
      approve
        ? "update company_knowledge set review_status = 'approved', risk_flags = '{}', applied_at = now() where org_id = $1 and section = $2"
        : "update company_knowledge set review_status = 'approved', risk_flags = '{}', content = '', applied_at = null where org_id = $1 and section = $2",
      [orgId, section],
    );
  }
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "knowledge_update_ready",
    severity: approve ? "success" : "warning",
    title: approve ? "Knowledge update approved and applied" : "A knowledge update wasn't applied",
    body: approve ? "Your AI Growth Partner and any retained profiles use it from their next message." : "It conflicted with AI safety rules. Your previously approved text is unchanged. Edit the section or contact support.",
    link: "/knowledge",
  });
  await recordAudit(
    { orgId, actorUserId: agencyUserId, actorKind: "agency", action: approve ? "knowledge.review_approved" : "knowledge.review_rejected", targetType: "knowledge_section", targetId: section, result: "success", metadata: { revision } },
    db,
  );
  return { approved: approve };
}

// ---------------------------------------------------------------------------
// Documents — private storage, validated by extension and content signature
// ---------------------------------------------------------------------------

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED: Record<string, { mime: string; text: boolean; magic?: number[] }> = {
  pdf: { mime: "application/pdf", text: false, magic: [0x25, 0x50, 0x44, 0x46] },
  docx: { mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", text: false, magic: [0x50, 0x4b, 0x03, 0x04] },
  txt: { mime: "text/plain", text: true },
  md: { mime: "text/markdown", text: true },
  csv: { mime: "text/csv", text: true },
};

export const ACCEPTED_UPLOADS = Object.keys(ALLOWED).map((e) => `.${e}`).join(",");

function storageRoot() {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), env().UPLOAD_DIR);
}

function looksLikeText(buf: Buffer) {
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) return false;
  const decoded = sample.toString("utf8");
  return !decoded.includes("�") || decoded.replace(/�/g, "").length / decoded.length > 0.98;
}

export async function uploadKnowledgeDocument(
  ctx: OrgContext,
  file: { name: string; bytes: Buffer },
  options: { agentInstanceId?: string | null } = {},
) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can upload documents.");
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Upload limit reached. Try again later.");
  const agentInstanceId = options.agentInstanceId ?? null;
  if (agentInstanceId) {
    const { rows } = await withSystem((db) =>
      db.query("select 1 from agent_instances where id = $1 and org_id = $2", [agentInstanceId, ctx.org.orgId]),
    );
    if (!rows[0]) throw new AppError("not_found", "AI employee not found.");
  }
  const filename = path.basename(file.name).replace(/[^\w.\- ()]+/g, "_").slice(0, 200) || "document";
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const kind = ALLOWED[ext];
  if (!kind) throw new AppError("invalid_input", "Upload a PDF, Word (.docx), text, Markdown or CSV file.");
  if (file.bytes.length === 0) throw new AppError("invalid_input", "That file is empty.");
  if (file.bytes.length > MAX_BYTES) throw new AppError("invalid_input", "Files can be up to 10 MB.");
  if (kind.magic && !kind.magic.every((b, i) => file.bytes[i] === b)) throw new AppError("invalid_input", "The file contents don't match its type.");
  if (kind.text && !looksLikeText(file.bytes)) throw new AppError("invalid_input", "That doesn't look like a plain text file.");

  const sha256 = crypto.createHash("sha256").update(file.bytes).digest("hex");
  const id = crypto.randomUUID();
  const storageKey = `${ctx.org.orgId}/${id}`;

  const { rows: dupe } = await withSystem((db) =>
    db.query("select 1 from knowledge_documents where org_id = $1 and sha256 = $2 and status <> 'deleted'", [ctx.org.orgId, sha256]),
  );
  if (dupe.length) throw new AppError("conflict", "That document is already in your Knowledge Center.");

  const stored = await uploadPrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "company-documents", path: storageKey,
    bytes: file.bytes, contentType: kind.mime, filename, visibility: "client" });
  try {
    await withSystem(async (db) => {
      await db.query("delete from knowledge_documents where org_id = $1 and sha256 = $2 and status = 'deleted'", [ctx.org.orgId, sha256]);
      await db.query(
        `insert into knowledge_documents (id, org_id, agent_instance_id, filename, mime_type, size_bytes, sha256, storage_key, status,
           extracted_text, risk_flags, uploaded_by, applied_at, processing_detail)
         values ($1, $2, $3, $4, $5, $6, $7, $8, 'processing', null, '{}', $9, null, 'Reading the document…')`,
        [id, ctx.org.orgId, agentInstanceId, filename, kind.mime, file.bytes.length, sha256, storageKey, ctx.user.id],
      );
      await recordAudit(
        {
          orgId: ctx.org.orgId,
          actorUserId: ctx.user.id,
          actorKind: "user",
          action: "knowledge.document_uploaded",
          targetType: "knowledge_document",
          targetId: id,
          result: "success",
          metadata: { ext, size: file.bytes.length, agentInstanceId },
        },
        db,
      );
    });
  } catch (err) {
    await removePrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: stored.bucket, path: stored.storageKey }).catch(() => undefined);
    throw err;
  }

  const processed = await processKnowledgeDocument(id, ctx.org.orgId, ext, file.bytes, ctx.user.id);
  return { id, filename, agentInstanceId, ...processed };
}

interface ProcessedKnowledgeDocument {
  status: "ready" | "failed" | "unsupported";
  processingDetail: string | null;
  held: boolean;
  hasText: boolean;
  extractionMethod: string | null;
}

/**
 * Bounded extraction/update step. The row exists before this runs, so a crash leaves a visible "processing"
 * row instead of losing the upload. Extraction never turns document text into trusted instructions.
 */
async function processKnowledgeDocument(
  documentId: string,
  orgId: string,
  ext: string,
  bytes: Buffer,
  actorUserId: string,
): Promise<ProcessedKnowledgeDocument> {
  let status: ProcessedKnowledgeDocument["status"];
  let detail: string | null = null;
  let text: string | null = null;
  // The extraction of a flagged document waits here, out of every prompt, so a reviewer can read what is held and approval has something to release.
  let heldText: string | null = null;
  let flags: string[] = [];
  let method: string | null = null;
  let appliedAt: Date | null = null;
  try {
    const extraction = extractDocumentText(ext, bytes);
    method = extraction.method;
    if (extraction.ok) {
      // Scan the whole sanitized extraction, not just a prefix, so an instruction buried deep in a large
      // document is still held for review.
      flags = detectRiskFlags(extraction.text);
      status = "ready";
      if (flags.length) {
        detail = "Held for iAcquire review because the document may contain instructions that conflict with AI safety policy.";
        heldText = extraction.text;
      } else {
        text = extraction.text;
        appliedAt = new Date();
      }
    } else {
      status = extraction.code === "encrypted" || extraction.code === "scanned" || extraction.code === "unsupported" ? "unsupported" : "failed";
      detail = extraction.detail;
    }
  } catch {
    status = "failed";
    method = ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : "plain_text";
    detail = "The document could not be processed. Upload a text version or try again.";
  }
  const safeDetail = detail ? detail.slice(0, 500) : null;
  await withSystem(async (db) => {
    await db.query(
      `update knowledge_documents
       set status = $2, extracted_text = $3, risk_flags = $4, applied_at = $5, extraction_method = $6,
           processing_detail = $7, processed_at = now(), held_text = $9
       where id = $1 and org_id = $8`,
      [documentId, status, text, flags, appliedAt, method, safeDetail, orgId, heldText],
    );
    await recordAudit(
      {
        orgId,
        actorUserId,
        actorKind: "user",
        action: "knowledge.document_processed",
        targetType: "knowledge_document",
        targetId: documentId,
        result: status === "ready" ? "success" : "failure",
        metadata: { status, method, held: flags.length > 0 },
      },
      db,
    );
    // The client is told it is held; the agency is told too, so a held document is not waiting for someone to happen to open that client's Reviews tab.
    if (flags.length > 0 && status === "ready") {
      const { rows: org } = await db.query<{ name: string }>("select name from organizations where id = $1", [orgId]);
      await notifyAgency(db, orgId, {
        kind: "knowledge_update_ready",
        severity: "warning",
        title: `${org[0]?.name ?? "A client"}: a knowledge document needs review`,
        body: "A document was held because it may conflict with AI safety policy. It is not used until the agency approves it.",
        link: `/admin/clients/${orgId}?tab=reviews`,
      });
    }
  });
  return { status, processingDetail: safeDetail, held: flags.length > 0, hasText: Boolean(text), extractionMethod: method };
}

/**
 * The agency's decision on a flagged document. Approve releases the held text to the prompt (for everyone when the document is shared, for its one employee when it is
 * assigned) and clears the quarantine; reject clears the quarantine and marks the document as not approved, so it is never used. A document held before this release
 * kept no text to release: it can only be rejected, and the client is asked to upload it again. Runs in the caller's transaction after the agency permission check.
 */
export async function decideHeldDocument(db: Queryable, input: { orgId: string; documentId: string; approve: boolean; agencyUserId: string }) {
  const { orgId, documentId, approve, agencyUserId } = input;
  const { rows } = await db.query<{ filename: string; held_text: string | null; risk_flags: string[]; agent_instance_id: string | null }>(
    `select filename, held_text, risk_flags, agent_instance_id from knowledge_documents
     where id = $1 and org_id = $2 and status = 'ready' and extracted_text is null and applied_at is null and cardinality(risk_flags) > 0 for update`,
    [documentId, orgId],
  );
  const doc = rows[0];
  if (!doc) throw new AppError("not_found", "That document is not waiting for review.");
  if (approve && doc.held_text === null) {
    throw new AppError("conflict", "This document was held before its text was kept for review. Reject it and ask the client to upload it again.");
  }
  if (approve) {
    await db.query(
      "update knowledge_documents set extracted_text = held_text, held_text = null, applied_at = now(), risk_flags = '{}', processing_detail = null where id = $1 and org_id = $2",
      [documentId, orgId],
    );
  } else {
    await db.query(
      "update knowledge_documents set held_text = null, status = 'rejected', processing_detail = 'Not approved for your AI team after iAcquire review.' where id = $1 and org_id = $2",
      [documentId, orgId],
    );
  }
  await notifyOrgRoles(db, orgId, ["owner", "admin"], {
    kind: "knowledge_update_ready",
    severity: approve ? "success" : "warning",
    title: approve ? "A document was approved for your AI team" : "A document wasn't approved",
    body: approve ? `${doc.filename} is now used by your AI team.` : `${doc.filename} conflicted with AI safety rules and won't be used. Upload a revised version or contact support.`,
    link: "/knowledge",
  });
  await recordAudit(
    {
      orgId,
      actorUserId: agencyUserId,
      actorKind: "agency",
      agentInstanceId: doc.agent_instance_id ?? undefined,
      action: approve ? "knowledge.document_review_approved" : "knowledge.document_review_rejected",
      targetType: "knowledge_document",
      targetId: documentId,
      result: "success",
      metadata: { flags: doc.risk_flags, scope: doc.agent_instance_id ? "assigned" : "shared" },
    },
    db,
  );
  return { approved: approve };
}

async function readStoredDocumentBytes(ctx: OrgContext, storageKey: string): Promise<Buffer> {
  const input = { userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "company-documents" as const, path: storageKey };
  try {
    return (await readPrivateFile(input)).bytes;
  } catch (error) {
    // Old synthetic local documents retain their layout. Hosted files require explicit import.
    if (env().AUTH_PROVIDER !== "local" || !(error instanceof AppError) || error.code !== "not_found") throw error;
    const filePath = path.resolve(storageRoot(), storageKey);
    if (!filePath.startsWith(storageRoot() + path.sep)) throw new AppError("not_found", "Document not found.");
    return fs.readFile(filePath);
  }
}

export async function readKnowledgeDocument(ctx: OrgContext, documentId: string) {
  if (!ctx.can("knowledge.view")) throw new AppError("forbidden", "You can't view company documents.");
  const doc = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ filename: string; mime_type: string; storage_key: string }>(
      "select filename, mime_type, storage_key from knowledge_documents where id = $1 and org_id = $2 and status <> 'deleted'",
      [documentId, ctx.org.orgId],
    );
    return rows[0];
  });
  if (!doc) throw new AppError("not_found", "Document not found.");
  return { ...doc, bytes: await readStoredDocumentBytes(ctx, doc.storage_key) };
}

/**
 * Re-runs bounded extraction on an already stored document. Only documents that aren't already usable are
 * accepted, so a routine click cannot silently replace released text with a different extraction.
 */
export async function reprocessKnowledgeDocument(ctx: OrgContext, documentId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can process documents.");
  const limit = await consumeRateLimit(RATE_LIMITS.knowledgeReprocessByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Processing limit reached. Try again later.");
  const doc = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ filename: string; storage_key: string; status: string }>(
      "select filename, storage_key, status from knowledge_documents where id = $1 and org_id = $2 and status <> 'deleted'",
      [documentId, ctx.org.orgId],
    );
    return rows[0];
  });
  if (!doc) throw new AppError("not_found", "Document not found.");
  if (doc.status === "ready") throw new AppError("conflict", "This document has already been processed.");
  const ext = doc.filename.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED[ext]) throw new AppError("invalid_input", "This file type can't be processed.");
  const bytes = await readStoredDocumentBytes(ctx, doc.storage_key);
  await withSystem((db) =>
    db.query(
      "update knowledge_documents set status = 'processing', processing_detail = 'Reading the document again…' where id = $1 and org_id = $2",
      [documentId, ctx.org.orgId],
    ),
  );
  const processed = await processKnowledgeDocument(documentId, ctx.org.orgId, ext, bytes, ctx.user.id);
  await withSystem((db) =>
    recordAudit(
      {
        orgId: ctx.org.orgId,
        actorUserId: ctx.user.id,
        actorKind: "user",
        action: "knowledge.document_reprocessed",
        targetType: "knowledge_document",
        targetId: documentId,
        result: processed.status === "ready" ? "success" : "failure",
        metadata: { status: processed.status, method: processed.extractionMethod },
      },
      db,
    ),
  );
  return processed;
}

export async function deleteKnowledgeDocument(ctx: OrgContext, documentId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can remove documents.");
  const storageKey = await withSystem(async (db) => {
    const { rows } = await db.query<{ storage_key: string }>(
      "update knowledge_documents set status = 'deleted', extracted_text = null, held_text = null where id = $1 and org_id = $2 and status <> 'deleted' returning storage_key",
      [documentId, ctx.org.orgId],
    );
    if (rows[0]) {
      await recordAudit({ orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "knowledge.document_deleted", targetType: "knowledge_document", targetId: documentId, result: "success" }, db);
    }
    return rows[0]?.storage_key;
  });
  if (!storageKey) throw new AppError("not_found", "Document not found.");
  try {
    await removePrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "company-documents", path: storageKey });
  } catch (error) {
    if (env().AUTH_PROVIDER !== "local" || !(error instanceof AppError) || error.code !== "not_found") throw error;
    const filePath = path.resolve(storageRoot(), storageKey);
    if (!filePath.startsWith(storageRoot() + path.sep)) throw new AppError("not_found", "Document not found.");
    await fs.rm(filePath, { force: true });
  }
}
