// What a staff message may carry. The same seven file types as a support request (PDF, PNG, JPG, WebP, text, CSV, Word), at most five files of 10 MB each. The server repeats
// every check and also reads the file's own first bytes; this is what lets the composer tell the person before they upload. Pure.

import { ATTACHMENT_ACCEPT, ATTACHMENT_TYPE_SUMMARY } from "@/lib/support/lifecycle";
import { mimeForFilename, safeFilename } from "@/lib/support/content";
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "@/lib/staff-messages/limits";

export { ATTACHMENT_ACCEPT, ATTACHMENT_TYPE_SUMMARY, mimeForFilename, safeFilename };

/** Why a file can't be attached, or null when it can. */
export function attachmentProblem(file: { name: string; size: number }): string | null {
  if (!mimeForFilename(file.name)) return `Choose a ${ATTACHMENT_TYPE_SUMMARY} file.`;
  if (!Number.isFinite(file.size) || file.size <= 0) return "That file is empty.";
  if (file.size > MAX_ATTACHMENT_BYTES) return `Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`;
  return null;
}

export type AttachmentIdsResult = { ok: true; ids: string[] } | { ok: false; message: string };

/**
 * The Content-Disposition of a download: always an attachment, never shown in the page. The plain name keeps only printable ASCII with quotes and backslashes turned into
 * underscores (so a name can neither end the quoted string nor start a new header line), and the real name rides along percent-encoded for browsers that read it.
 */
export function contentDispositionAttachment(filename: string): string {
  const printable = Array.from(filename, (ch) => {
    const code = ch.codePointAt(0) as number;
    if (code === 34 || code === 92 || code === 59) return "_";
    return code >= 32 && code <= 126 ? ch : code < 32 || code === 127 ? "" : "_";
  }).join("").trim();
  const fallback = printable || "download";
  const visible = Array.from(filename).filter((ch) => {
    const code = ch.codePointAt(0) as number;
    return code >= 32 && code !== 127;
  }).join("");
  const encoded = encodeURIComponent(visible).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded || "download"}`;
}

/** The files to attach to a message: each once, and no more than five. */
export function attachmentIds(raw: unknown): AttachmentIdsResult {
  if (raw === undefined || raw === null) return { ok: true, ids: [] };
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) return { ok: false, message: "Those attachments are not valid." };
  const ids = [...new Set(raw as string[])];
  if (ids.length > MAX_ATTACHMENTS) return { ok: false, message: `You can attach up to ${MAX_ATTACHMENTS} files to a message.` };
  return { ok: true, ids };
}
