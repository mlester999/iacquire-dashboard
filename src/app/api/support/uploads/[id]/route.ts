import { NextResponse } from "next/server";
import { assertSameOrigin, requireUserOrThrow } from "@/server/auth/session";
import { discardStagedFile } from "@/server/support/attachments";
import { toPublicError } from "@/server/errors";

export const dynamic = "force-dynamic";

/** Takes back a file the person chose but has not sent. Only its uploader can, and only while it is unsent. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await assertSameOrigin();
    const user = await requireUserOrThrow();
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ error: "Attachment not found." }, { status: 404 });
    await discardStagedFile(user.id, id);
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const e = toPublicError(error);
    return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
  }
}
