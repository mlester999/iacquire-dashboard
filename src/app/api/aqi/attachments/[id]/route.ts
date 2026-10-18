import { NextResponse } from "next/server";
import { assertSameOrigin } from "@/server/auth/session";
import { resolveAqiViewer } from "@/server/aqi/access";
import { deleteAqiAttachment, readAqiAttachment } from "@/server/aqi/attachments";
import { classifyAqiError } from "@/server/aqi/errors";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function safeName(name: string): string {
  return name.replace(/["\\\r\n]/g, "_").slice(0, 200) || "attachment";
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = crypto.randomUUID();
  try {
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    const file = await readAqiAttachment(viewer, id);
    const range = request.headers.get("range");
    const common = {
      "Content-Type": file.mimeType,
      "Content-Disposition": `inline; filename="${safeName(file.filename)}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
      "Content-Security-Policy": "default-src 'none'; sandbox",
      "Accept-Ranges": "bytes",
    };
    if (range && file.mimeType.startsWith("video/")) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (match) {
        const start = match[1] ? Number(match[1]) : 0;
        const end = match[2] ? Number(match[2]) : file.bytes.length - 1;
        if (Number.isFinite(start) && Number.isFinite(end) && start <= end && start < file.bytes.length) {
          const last = Math.min(end, file.bytes.length - 1);
          return new NextResponse(new Uint8Array(file.bytes.subarray(start, last + 1)), {
            status: 206,
            headers: { ...common, "Content-Range": `bytes ${start}-${last}/${file.bytes.length}`, "Content-Length": String(last - start + 1) },
          });
        }
      }
    }
    return new NextResponse(new Uint8Array(file.bytes), { headers: common });
  } catch (err) {
    const error = classifyAqiError(err, { requestId, superAdmin: false, reason: "attachment_read" });
    return NextResponse.json({ error: error.code === "response_failed" ? "Attachment not found." : error.message }, { status: error.code === "response_failed" ? 404 : 400 });
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const viewer = await resolveAqiViewer();
    const { id } = await params;
    await deleteAqiAttachment(viewer, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const error = classifyAqiError(err, { requestId: crypto.randomUUID(), superAdmin: false, reason: "attachment_delete" });
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
}
