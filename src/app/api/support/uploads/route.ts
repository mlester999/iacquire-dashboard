import { NextResponse } from "next/server";
import { assertSameOrigin, requireUserOrThrow } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { requireOrgContextOrThrow } from "@/server/tenancy/context";
import { loadTicketForAgency } from "@/server/support/access";
import { stageSupportFile } from "@/server/support/attachments";
import { loadSupportSettings } from "@/server/support/settings";
import { AppError, toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/**
 * Saves a file the person has chosen but not yet sent. The workspace is never taken from the request: a client's comes from their
 * session, and the team's comes from the request they are working on (which they must be allowed to reach).
 */
export async function POST(req: Request) {
  try {
    await assertSameOrigin();
    const user = await requireUserOrThrow();
    const settings = await loadSupportSettings();
    const limit = settings.maxAttachmentMb * 1024 * 1024;
    const form = await readBoundedFormData(req, limit + 65536);
    if (!form) throw new AppError("invalid_input", `Files can be up to ${settings.maxAttachmentMb} MB.`);
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("invalid_input", "Choose a file to attach.");
    if (file.size > limit) throw new AppError("invalid_input", `Files can be up to ${settings.maxAttachmentMb} MB.`);
    const ticketId = form.get("ticketId");
    let orgId: string;
    let internal = false;
    if (typeof ticketId === "string" && ticketId && user.platformRole !== "none") {
      const t = await loadTicketForAgency(user, ticketId, "agency.support.manage");
      orgId = t.org_id;
      internal = form.get("internal") === "true";
    } else {
      const ctx = await requireOrgContextOrThrow("support.use");
      orgId = ctx.org.orgId;
    }
    const saved = await stageSupportFile(user.id, orgId, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) }, { internal });
    return NextResponse.json({ id: saved.id, filename: saved.filename, mimeType: saved.mime_type, sizeBytes: saved.size_bytes, visibility: saved.visibility }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
}
