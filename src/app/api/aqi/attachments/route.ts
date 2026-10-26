import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { readBoundedFormData } from "@/server/security/bounded-body";
import { resolveAqiViewer } from "@/server/aqi/access";
import { getPublishedAqiConfig } from "@/server/aqi/service";
import { uploadAqiAttachment } from "@/server/aqi/attachments";
import { classifyAqiError, logAqiError } from "@/server/aqi/errors";
import { AppError } from "@/server/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 120;
export const runtime = "nodejs";

export async function POST(request: Request) {
  const requestId = crypto.randomUUID();
  let superAdmin = false;
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    superAdmin = viewer.user.platformRole === "agency_super_admin";
    if (!viewer.org) throw new AppError("forbidden", "Attachments are available inside a client workspace.");
    // Read with a ceiling as it arrives: this route had no length check at all, so a chunked request was held whole in memory before the 50 MB rule was applied below.
    const form = await readBoundedFormData(request, 50 * 1024 * 1024 + 1_000_000);
    if (!form) return NextResponse.json({ error: "This file is too large. Please choose a smaller file." }, { status: 413 });
    const file = form.get("file");
    const conversationId = String(form.get("conversationId") ?? "").trim() || null;
    if (!(file instanceof File)) return NextResponse.json({ error: "Choose a file to attach." }, { status: 400 });
    if (file.size > 50 * 1024 * 1024) return NextResponse.json({ error: "This file is too large. Please choose a smaller file." }, { status: 413 });
    const config = await getPublishedAqiConfig();
    const result = await uploadAqiAttachment(viewer, {
      name: file.name,
      mime: file.type || undefined,
      bytes: Buffer.from(await file.arrayBuffer()),
      conversationId,
    }, config.config.attachments);
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    const error = classifyAqiError(err, { requestId, superAdmin, reason: "attachment_upload" });
    const safe = err instanceof AppError && ["invalid_input", "forbidden", "not_found", "rate_limited"].includes(err.code) ? err.message : error.message;
    logAqiError(err, { requestId, superAdmin, reason: "attachment_upload" });
    return NextResponse.json({ error: safe, code: error.code, ...(error.diagnostic ? { diagnostic: error.diagnostic } : {}) }, { status: 400 });
  }
}
