import "server-only";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withSystem, withUser } from "@/server/db";
import { AppError } from "@/server/errors";
import { env } from "@/server/env";
import { recordAudit } from "@/server/audit";
import { consumeRateLimit, RATE_LIMITS } from "@/server/security/rate-limit";
import { notifyAgency } from "@/server/notifications";
import { detectRiskFlags, sanitizeClientText } from "@/server/workforce/compiler";
import { uploadPrivateFile, readPrivateFile, removePrivateFile } from "@/server/storage/private";
import type { OrgContext } from "@/server/tenancy/context";

export const KNOWLEDGE_SECTIONS = [
  { key: "business_description", label: "Business description", hint: "What you do, who you serve and what makes you different." },
  { key: "products_services", label: "Products and services", hint: "What you sell, with short descriptions." },
  { key: "faq", label: "Frequently asked questions", hint: "Common customer questions and your preferred answers." },
  { key: "approved_pricing", label: "Approved prices", hint: "Only prices your AI team may quote. Leave empty to never quote prices." },
  { key: "business_hours", label: "Business hours", hint: "Opening hours, holidays and response times." },
  { key: "policies", label: "Policies", hint: "Refunds, cancellations, guarantees and terms customers ask about." },
  { key: "customer_service", label: "Customer service procedures", hint: "How you handle complaints, follow-ups and special requests." },
  { key: "brand_voice", label: "Brand voice", hint: "Words you love, words you avoid, and how you sound." },
  { key: "escalation", label: "Escalation instructions", hint: "When and how a human should take over." },
] as const;
export type KnowledgeSection = (typeof KNOWLEDGE_SECTIONS)[number]["key"];

export interface KnowledgeRow {
  section: KnowledgeSection;
  content: string;
  version: number;
  updated_at: Date;
  applied_at: Date | null;
  review_status: "approved" | "pending_agency_review";
  updated_by_name: string | null;
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
  uploaded_by_name: string | null;
}

export async function getKnowledge(ctx: OrgContext) {
  return withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<KnowledgeRow>(
      `select k.section, k.content, k.version, k.updated_at, k.applied_at, k.review_status, u.full_name as updated_by_name
       from company_knowledge k left join users u on u.id = k.updated_by where k.org_id = $1`,
      [ctx.org.orgId],
    );
    const { rows: docs } = await db.query<DocumentRow>(
      `select d.id, d.filename, d.mime_type, d.size_bytes, d.status, d.created_at, d.applied_at,
              (d.extracted_text is not null) as has_text, u.full_name as uploaded_by_name
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
  const text = sanitizeClientText(content, 12000);
  const flags = detectRiskFlags(text);
  const held = flags.length > 0;
  await withUser(ctx.user.id, (db) =>
    db.query(
      `insert into company_knowledge (org_id, section, content, updated_by, risk_flags, review_status, applied_at)
       values ($1, $2, $3, $4, $5, $6, case when $6 = 'approved' then now() end)
       on conflict (org_id, section) do update set content = excluded.content, version = company_knowledge.version + 1,
         updated_by = excluded.updated_by, updated_at = now(), risk_flags = excluded.risk_flags,
         review_status = excluded.review_status, applied_at = excluded.applied_at`,
      [ctx.org.orgId, section, text, ctx.user.id, flags, held ? "pending_agency_review" : "approved"],
    ),
  );
  await withSystem(async (db) => {
    await recordAudit(
      { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "knowledge.section_saved", targetType: "knowledge_section", targetId: section, result: "success", metadata: { held, flags } },
      db,
    );
    if (held) {
      await notifyAgency(db, ctx.org.orgId, {
        kind: "knowledge_update_ready",
        severity: "warning",
        title: `${ctx.org.name}: knowledge update needs review`,
        body: `Section "${section}" was held because it may conflict with AI safety policy.`,
        link: `/admin/clients/${ctx.org.orgId}`,
      });
    }
  });
  return { held, flags };
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

export async function uploadKnowledgeDocument(ctx: OrgContext, file: { name: string; bytes: Buffer }) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can upload documents.");
  const limit = await consumeRateLimit(RATE_LIMITS.uploadByUser, ctx.user.id);
  if (!limit.allowed) throw new AppError("rate_limited", "Upload limit reached. Try again later.");
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
  const extracted = kind.text ? sanitizeClientText(file.bytes.toString("utf8"), 200000) : null;
  const flags = extracted ? detectRiskFlags(extracted.slice(0, 20000)) : [];

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
        `insert into knowledge_documents (id, org_id, filename, mime_type, size_bytes, sha256, storage_key, status, extracted_text, uploaded_by, applied_at)
         values ($1, $2, $3, $4, $5, $6, $7, 'ready', $8, $9, case when $10 then now() end)`,
        [id, ctx.org.orgId, filename, kind.mime, file.bytes.length, sha256, storageKey, flags.length ? null : extracted, ctx.user.id, Boolean(extracted) && !flags.length],
      );
      await recordAudit(
        { orgId: ctx.org.orgId, actorUserId: ctx.user.id, actorKind: "user", action: "knowledge.document_uploaded", targetType: "knowledge_document", targetId: id, result: "success", metadata: { ext, size: file.bytes.length, held: flags.length > 0 } },
        db,
      );
    });
  } catch (err) {
    await removePrivateFile({ userId: ctx.user.id, orgId: ctx.org.orgId, bucket: stored.bucket, path: stored.storageKey }).catch(() => undefined);
    throw err;
  }
  return { id, filename, held: flags.length > 0 };
}

export async function readKnowledgeDocument(ctx: OrgContext, documentId: string) {
  if (!ctx.can("knowledge.view")) throw new AppError("forbidden", "You can't view company documents.");
  const doc = await withUser(ctx.user.id, async (db) => {
    const { rows } = await db.query<{ filename: string; mime_type: string; storage_key: string }>(
      "select filename, mime_type, storage_key from knowledge_documents where id = $1 and org_id = $2 and status = 'ready'",
      [documentId, ctx.org.orgId],
    );
    return rows[0];
  });
  if (!doc) throw new AppError("not_found", "Document not found.");
  const input = { userId: ctx.user.id, orgId: ctx.org.orgId, bucket: "company-documents" as const, path: doc.storage_key };
  try {
    return { ...doc, bytes: (await readPrivateFile(input)).bytes };
  } catch (error) {
    // Old synthetic local documents retain their layout. Hosted files require explicit import.
    if (env().AUTH_PROVIDER !== "local" || !(error instanceof AppError) || error.code !== "not_found") throw error;
    const filePath = path.resolve(storageRoot(), doc.storage_key);
    if (!filePath.startsWith(storageRoot() + path.sep)) throw new AppError("not_found", "Document not found.");
    return { ...doc, bytes: await fs.readFile(filePath) };
  }
}

export async function deleteKnowledgeDocument(ctx: OrgContext, documentId: string) {
  if (!ctx.can("knowledge.edit")) throw new AppError("forbidden", "Only owners and admins can remove documents.");
  const storageKey = await withSystem(async (db) => {
    const { rows } = await db.query<{ storage_key: string }>(
      "update knowledge_documents set status = 'deleted', extracted_text = null where id = $1 and org_id = $2 and status <> 'deleted' returning storage_key",
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
