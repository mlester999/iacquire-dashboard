import { requireAgencyOrThrow } from "@/server/tenancy/context";
import { downloadAttachment } from "@/server/staff-messages/attachments";
import { errorResponse } from "@/server/staff-messages/http";
import { contentDispositionAttachment } from "@/lib/staff-messages/attachments";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * A file that was sent in a conversation, for a member of that conversation. The membership check comes first (a file in a conversation the person is not in is "not found",
 * in the same words as an id that never existed), then the authorized read. The answer is always a download, never shown in a page, and nothing about it may be cached or
 * guessed from its content.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireAgencyOrThrow();
    const { id } = await params;
    const file = await downloadAttachment({ id: user.id, platformRole: user.platformRole }, id);
    return new Response(new Uint8Array(file.bytes), {
      headers: {
        "Content-Type": file.mimeType,
        "Content-Length": String(file.bytes.length),
        "Content-Disposition": contentDispositionAttachment(file.filename),
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "sandbox; default-src 'none'",
        "Cache-Control": "private, no-store",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
