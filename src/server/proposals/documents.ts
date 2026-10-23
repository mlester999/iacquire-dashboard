import "server-only";
import crypto from "node:crypto";
import { withSystem } from "@/server/db";
import { AppError } from "@/server/errors";
import { readAuthorizedPrivateFile, removeStoredObjectTrusted, uploadPrivateFile } from "@/server/storage/private";
import { renderProposalPdfBytes, type ProposalPdfInput } from "@/lib/proposals/pdf";
import type { ProposalSnapshot } from "@/lib/proposals/snapshot";

// The PDF of a frozen proposal version. It is set from the version's snapshot only (never from the working copy), stored once in the private proposal-documents bucket, and its
// sha256 is kept on the version row (write-once). Rendering goes through a seam so the writer can be replaced without touching anything that calls it.

export interface ProposalPdfRenderer {
  render(input: ProposalPdfInput): Promise<Buffer>;
}

/** The writer in src/lib/pdf: no dependency, deterministic. */
export const builtInRenderer: ProposalPdfRenderer = { render: async (input) => renderProposalPdfBytes(input) };

export interface PdfDeps {
  renderer?: ProposalPdfRenderer;
}

export const pdfFilename = (number: string, version: number): string => `Proposal-${number}-v${version}.pdf`.replace(/[^A-Za-z0-9_.()-]/g, "-");

interface VersionPdfRow {
  id: string;
  proposal_id: string;
  version: number;
  number: string;
  snapshot: ProposalSnapshot;
  content_hash: string;
  created_at: Date;
  pdf_file_id: string | null;
  pdf_sha256: string | null;
  pdf_bytes: number | null;
}

async function loadRow(orgId: string, proposalId: string, version: number): Promise<VersionPdfRow | null> {
  const { rows } = await withSystem((db) => db.query<VersionPdfRow>(
    `select v.id, v.proposal_id, v.version, p.number, v.snapshot, v.content_hash, v.created_at, v.pdf_file_id, v.pdf_sha256, v.pdf_bytes
     from proposal_versions v join proposals p on p.id = v.proposal_id and p.org_id = v.org_id where v.proposal_id = $1 and v.org_id = $2 and v.version = $3`,
    [proposalId, orgId, version],
  ));
  return rows[0] ?? null;
}

async function render(row: VersionPdfRow, deps: PdfDeps): Promise<Buffer> {
  const bytes = await (deps.renderer ?? builtInRenderer).render({ snapshot: row.snapshot, version: row.version, contentHash: row.content_hash, createdAt: new Date(row.created_at) });
  if (bytes.length < 8 || bytes.subarray(0, 5).toString("latin1") !== "%PDF-") throw new AppError("internal", "The PDF could not be made.");
  return bytes;
}

export interface StoredPdf {
  fileId: string;
  sha256: string;
  bytes: number;
  /** True when this call made and stored it; false when it was already there. */
  created: boolean;
}

/**
 * Makes and stores the PDF of a version unless it already exists. `userId` is the person on whose permission the file is saved (the one who sent the proposal). Two callers at
 * once end with one stored file: the one that loses the race removes its own copy. Throws when it cannot be done; the caller decides what that means (sending never waits on it).
 */
export async function ensureVersionPdf(orgId: string, proposalId: string, version: number, userId: string, deps: PdfDeps = {}): Promise<StoredPdf> {
  const row = await loadRow(orgId, proposalId, version);
  if (!row) throw new AppError("not_found", "That version was not found.");
  if (row.pdf_file_id && row.pdf_sha256 && row.pdf_bytes) return { fileId: row.pdf_file_id, sha256: row.pdf_sha256, bytes: row.pdf_bytes, created: false };
  const bytes = await render(row, deps);
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const filename = pdfFilename(row.number, row.version);
  const saved = await uploadPrivateFile({ userId, orgId, bucket: "proposal-documents", path: `${orgId}/${crypto.randomUUID()}/${filename}`, bytes, contentType: "application/pdf", filename, visibility: "client" });
  const claimed = await withSystem((db) => db.query<{ id: string }>(
    "update proposal_versions set pdf_file_id = $4, pdf_sha256 = $5, pdf_bytes = $6 where id = $1 and org_id = $2 and proposal_id = $3 and pdf_file_id is null returning id",
    [row.id, orgId, proposalId, saved.id, sha256, bytes.length],
  ));
  if (claimed.rows[0]) return { fileId: saved.id, sha256, bytes: bytes.length, created: true };
  // Another caller stored it first: this copy is surplus.
  await withSystem((db) => db.query("update private_files set status = 'deleted' where id = $1 and org_id = $2", [saved.id, orgId]));
  await removeStoredObjectTrusted({ orgId, bucket: "proposal-documents", storageKey: saved.storageKey }).catch(() => undefined);
  const winner = await loadRow(orgId, proposalId, version);
  if (!winner?.pdf_file_id || !winner.pdf_sha256 || !winner.pdf_bytes) throw new AppError("internal", "The PDF could not be stored.");
  return { fileId: winner.pdf_file_id, sha256: winner.pdf_sha256, bytes: winner.pdf_bytes, created: false };
}

export interface VersionPdf {
  bytes: Buffer;
  filename: string;
  /** The stored copy, checked against the hash recorded when it was stored; false when it is a fresh rendering of the same version. */
  stored: boolean;
  /** The stored copy's bytes did not match the recorded hash, so a fresh rendering is served instead. */
  tampered: boolean;
}

/**
 * The PDF of a version for a caller that is ALREADY authorized (a customer's link, or a team member's permission): the stored file when it is there and still matches the hash
 * recorded with it, otherwise the same version set again from its snapshot. The file must belong to this workspace and this version; a file id is never taken from a request.
 */
export async function readVersionPdf(orgId: string, proposalId: string, version: number, deps: PdfDeps = {}): Promise<VersionPdf | null> {
  const row = await loadRow(orgId, proposalId, version);
  if (!row) return null;
  const filename = pdfFilename(row.number, row.version);
  if (row.pdf_file_id && row.pdf_sha256) {
    const ok = await withSystem((db) => db.query("select 1 from private_files where id = $1 and org_id = $2 and bucket = 'proposal-documents' and status = 'ready'", [row.pdf_file_id, orgId]));
    if (ok.rows[0]) {
      try {
        const file = await readAuthorizedPrivateFile(row.pdf_file_id);
        if (file.org_id === orgId && crypto.createHash("sha256").update(file.bytes).digest("hex") === row.pdf_sha256) return { bytes: file.bytes, filename, stored: true, tampered: false };
        return { bytes: await render(row, deps), filename, stored: false, tampered: true };
      } catch {
        // Storage is unreachable or the file is gone: the version can still be set again from its snapshot.
      }
    }
  }
  return { bytes: await render(row, deps), filename, stored: false, tampered: false };
}
