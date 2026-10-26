import { NextResponse } from "next/server";
import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { sameSiteRequest } from "@/server/security/same-site";
import { AppError } from "@/server/errors";
import { stageAttachment } from "@/server/staff-messages/attachments";
import { errorResponse, NO_STORE } from "@/server/staff-messages/http";
import { MAX_ATTACHMENT_BYTES } from "@/lib/staff-messages/limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Saves a file the person chose for a message, before the message is sent. It belongs to them alone until then. The conversation comes from the request but is only used after
 * the service has checked, from the database, that the person is in it; the file is never readable by a browser except through the download route's membership check. A file
 * nobody sends is removed after a day.
 */
export async function POST(req: Request) {
  try {
    if (!sameSiteRequest(req)) throw new AppError("forbidden", "Cross-site requests are not allowed.");
    const user = await requireAgencyOrThrow();
    // Refuse a body that is plainly too large before reading any of it (the service checks the file itself as well).
    if (Number(req.headers.get("content-length") ?? 0) > MAX_ATTACHMENT_BYTES + 65_536) throw new AppError("invalid_input", `Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new AppError("invalid_input", "Choose a file to attach.");
    if (file.size > MAX_ATTACHMENT_BYTES) throw new AppError("invalid_input", `Files can be up to ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB.`);
    const conversationId = form.get("conversationId");
    const saved = await stageAttachment({ id: user.id, platformRole: user.platformRole }, typeof conversationId === "string" ? conversationId : null, { name: file.name, bytes: Buffer.from(await file.arrayBuffer()) });
    return NextResponse.json(saved, { headers: NO_STORE });
  } catch (error) {
    return errorResponse(error);
  }
}
